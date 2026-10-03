// Cérebro do atendente: manda a conversa pro Claude com as ferramentas da loja e repete enquanto
// ele pedir ferramenta. Mesmo desenho do bot do Jabá, com duas diferenças de propósito:
// - o histórico salvo entre mensagens do WhatsApp guarda só texto/ferramentas, SEM os blocos de
//   raciocínio ("thinking"): eles ficam presos à conversa exata em que nasceram e o histórico aqui
//   é recortado e as instruções do dono mudam — reenviar esses blocos depois daria erro. Dentro de
//   uma mesma resposta (o laço de ferramentas) tudo volta exatamente como veio, como a API pede;
// - recusa por política cai sozinha em outro modelo (fallbacks "default") e, se ainda assim não
//   der, a conversa vai pra equipe em vez de o cliente ficar sem resposta.
const Anthropic = require('@anthropic-ai/sdk');
const { LOJA_ID, pool } = require('./config');
const { definicoes, execucoes } = require('./tools');

const MODELO = process.env.BOT_MODELO || process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const ESFORCO = process.env.BOT_ESFORCO || 'medium';
const HISTORICO_MAX = 30;
const MAX_VOLTAS = 8;

let cliente = null;
function anthropic() {
  if (!cliente) cliente = new Anthropic({ timeout: 2 * 60 * 1000 });
  return cliente;
}

const SISTEMA = `Você é o atendente virtual da Loja Gutto, loja de roupas infantis, atendendo clientes pelo WhatsApp.

Como atender:
- Português do Brasil, simpático, curto e direto, como uma vendedora atenciosa da loja. Emoji com moderação. Mensagens curtas (é WhatsApp): no máximo uns 5 itens por lista; se houver mais, pergunte o que a pessoa procura (idade/tamanho, menino/menina, ocasião).
- Responda só o que perguntaram. Se a pessoa só cumprimentou, cumprimente de volta e pergunte como pode ajudar.
- NUNCA invente produto, preço, tamanho, cor ou estoque: confira sempre com buscar_produtos. Se não tiver, diga que no momento não tem e ofereça algo parecido que exista.
- Ajude a escolher o tamanho perguntando a idade/tamanho que a criança usa; não prometa caimento.
- Quando o cliente quiser ver a peça, use enviar_foto_produto (se temFoto for true).
- Fechar pedido: junte as peças, retirada na loja ou entrega (endereço com rua, número e bairro), forma de pagamento (Pix, cartão de crédito, débito ou dinheiro, pago na entrega/retirada; se dinheiro, pergunte se precisa de troco e pra quanto) e o nome. Aí chame calcular_pedido e mande numa mensagem só o resumo que ela devolver (peças com preço, taxa, total e troco). Só chame criar_pedido depois do "sim" do cliente. Nunca faça conta de cabeça — os valores vêm das ferramentas.
- Depois de criar o pedido, informe o número e o total e diga que a loja avisa por aqui a cada etapa.
- Status de pedido: use meus_pedidos. Cashback/vale-troca: use meu_cashback.
- Você não dá desconto, não cancela nem altera pedido, não faz troca/devolução: nesses casos, ou se pedirem uma pessoa, ou se você não souber resolver, use chamar_atendente e avise que alguém da equipe responde em breve.
- Se o sistema estiver fora do ar, peça desculpas e chame um atendente.`;

async function carregarConversa(telefone) {
  const { rows } = await pool.query('SELECT mensagens FROM bot_conversas WHERE loja_id = $1 AND telefone = $2', [LOJA_ID, telefone]);
  return rows.length ? rows[0].mensagens : [];
}

async function instrucoesDoDono() {
  try {
    const { rows } = await pool.query('SELECT bot_instrucoes FROM lojas WHERE id = $1', [LOJA_ID]);
    return rows.length ? String(rows[0].bot_instrucoes || '').trim() : '';
  } catch (e) {
    console.error('Falha ao ler as instruções do dono (seguindo sem elas):', e.message);
    return '';
  }
}

function paraBlocos(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return Array.isArray(content) ? content : [];
}
// Só o que pode atravessar de uma mensagem do WhatsApp pra outra (ver topo do arquivo).
const BLOCOS_GUARDADOS = ['text', 'tool_use', 'tool_result'];
function limparParaGuardar(mensagens) {
  return mensagens.map((m) => {
    const content = Array.isArray(m.content)
      ? m.content.filter((b) => b && BLOCOS_GUARDADOS.includes(b.type)).map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : b))
      : m.content;
    return { ...m, content };
  }).filter((m) => (typeof m.content === 'string' ? m.content : m.content.length));
}

// A API exige user/assistant alternados e que a conversa comece com uma mensagem do cliente —
// mensagens da equipe/avisos automáticos entram como assistant fora do laço, então dois seguidos
// do mesmo papel são fundidos aqui. Um tool_result só vale logo após o tool_use dele: se o recorte
// do histórico deixou um solto no começo, ele sai (foi um bug real no bot do Jabá).
function montarParaClaude(mensagens) {
  const out = [];
  for (const m of mensagens) {
    const ultimo = out[out.length - 1];
    if (ultimo && ultimo.role === m.role) { ultimo.content = [...paraBlocos(ultimo.content), ...paraBlocos(m.content)]; continue; }
    out.push({ role: m.role, content: paraBlocos(m.content) });
  }
  const abreBem = (m) => m.role === 'user' && !m.content.some((b) => b.type === 'tool_result');
  while (out.length && !abreBem(out[0])) out.shift();
  // Um tool_use sem o tool_result seguinte (resposta interrompida) quebraria a chamada: corta dali.
  for (let i = 0; i < out.length; i++) {
    const usos = out[i].role === 'assistant' ? out[i].content.filter((b) => b.type === 'tool_use') : [];
    if (usos.length && !(out[i + 1] && out[i + 1].content.some((b) => b.type === 'tool_result'))) {
      out[i].content = out[i].content.filter((b) => b.type !== 'tool_use');
      if (!out[i].content.length) out.splice(i, 1);
    }
  }
  return out;
}

async function salvarConversa(telefone, mensagens) {
  const guardar = limparParaGuardar(mensagens).slice(-HISTORICO_MAX);
  await pool.query(
    `INSERT INTO bot_conversas (loja_id, telefone, mensagens, atualizado_em) VALUES ($1, $2, $3, now())
     ON CONFLICT (loja_id, telefone) DO UPDATE SET mensagens = EXCLUDED.mensagens, atualizado_em = now()`,
    [LOJA_ID, telefone, JSON.stringify(guardar)]);
}

class RecusaDaIA extends Error {}

// `ctx`: { telefone (id do WhatsApp), telefoneLocal (DDD+número ou null), nomePerfil, enviarImagem }.
async function responder(texto, ctx) {
  const historico = await carregarConversa(ctx.telefone);
  const mensagens = montarParaClaude([...historico, { role: 'user', content: texto }]);
  let system = SISTEMA;
  const instrucoes = await instrucoesDoDono();
  if (instrucoes) system += `\n\nInstruções do dono da loja (consulte quando for relevante; não recite por conta própria):\n${instrucoes}`;
  if (ctx.nomePerfil) system += `\n\nNome no perfil do WhatsApp desta pessoa: "${String(ctx.nomePerfil).slice(0, 60)}" (pode ser apelido — use na saudação, mas confirme o nome antes de fechar pedido).`;
  if (!ctx.telefoneLocal) system += '\n\nNão foi possível identificar o número de telefone deste contato: se for fechar pedido, pergunte o telefone com DDD.';

  let textoFinal = '';
  for (let volta = 0; volta < MAX_VOLTAS; volta++) {
    const resposta = await anthropic().beta.messages.create({
      model: MODELO,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      output_config: { effort: ESFORCO },
      system,
      tools: definicoes,
      messages: mensagens,
    });
    if (resposta.stop_reason === 'refusal') throw new RecusaDaIA('a IA recusou responder');
    mensagens.push({ role: 'assistant', content: resposta.content });

    const usos = resposta.content.filter((b) => b.type === 'tool_use');
    if (!usos.length || resposta.stop_reason === 'max_tokens') {
      textoFinal = resposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      break;
    }
    const resultados = [];
    for (const uso of usos) {
      let resultado;
      try {
        const fn = Object.prototype.hasOwnProperty.call(execucoes, uso.name) ? execucoes[uso.name] : null;
        resultado = fn ? await fn(uso.input || {}, ctx) : { erro: 'Ferramenta desconhecida: ' + uso.name };
      } catch (e) {
        console.error(`Erro na ferramenta ${uso.name}:`, e.message);
        resultado = { erro: 'Falha ao consultar o sistema da loja agora.' };
      }
      resultados.push({ type: 'tool_result', tool_use_id: uso.id, content: JSON.stringify(resultado), ...(resultado && resultado.erro ? { is_error: true } : {}) });
    }
    mensagens.push({ role: 'user', content: resultados });
  }
  if (!textoFinal) textoFinal = 'Deixa eu confirmar isso com a equipe e já te respondo por aqui.';
  // A resposta final vai no histórico como texto simples (é o que o cliente leu).
  const ultima = mensagens[mensagens.length - 1];
  if (ultima.role === 'assistant') mensagens[mensagens.length - 1] = { role: 'assistant', content: textoFinal };
  await salvarConversa(ctx.telefone, mensagens);
  return textoFinal;
}

module.exports = { responder, RecusaDaIA, montarParaClaude, limparParaGuardar };
