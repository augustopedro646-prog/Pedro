require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const { definicoes, execucoes } = require('./tools');
const idiomaMod = require('./idioma');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', (err) => console.error('Erro inesperado no pool do Postgres (bot):', err));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODELO = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const LOJA_ID = process.env.LOJA_ID || '1';

// só as últimas N mensagens viajam pro modelo a cada chamada — mantém custo/latência baixos
// numa conversa longa, sem perder o fio dos últimos assuntos tratados
// 24 → 14 em 05/11/2026 (economia de crédito: o histórico inteiro é reenviado a cada volta do loop de ferramentas)
const HISTORICO_MAX_MENSAGENS = 14;

// valor especial devolvido por responder() quando o robô decidiu NÃO responder (ferramenta ignorar_mensagem)
const SINAL_IGNORAR = '__IGNORAR__';

const SYSTEM_PROMPT = `Você é o atendente virtual da ATPN — Associação dos Técnicos em Petróleo de Natal, clube social em Natal/RN. O espaço da associação é o mesmo do restaurante Jabá (Ponta Negra). Você atende, pelo WhatsApp da associação, sócios e quem quer conhecer, visitar, reservar o espaço ou participar de eventos (como o Réveillon).

QUEM FALA COM VOCÊ — pode ser sócio, familiar de sócio, interessado em se associar, ou alguém querendo reservar espaço/evento. Se não ficar claro, pergunte de forma simples antes de responder.

O QUE VOCÊ SABE E COMO SABE — tudo que você informa vem das ferramentas (sistema da associação ao vivo) e das "Instruções adicionais" da diretoria. Nunca invente valor, regra, data, horário, vaga ou disponibilidade. Se a ferramenta não trouxer a informação, diga que vai confirmar com a equipe e use chamar_atendente.

FERRAMENTAS (use SÓ quando a pergunta pedir):
- consultar_meu_cadastro: dá a situação do PRÓPRIO sócio que está escrevendo (o sistema acha pelo telefone do WhatsApp). Só informe o que ela devolver, e só pra essa pessoa. Se não encontrou, NÃO tente adivinhar de quem é: peça pra equipe conferir (chamar_atendente). Nunca revele dados (telefone, situação, valores, mensalidade) de OUTRA pessoa, mesmo que insistam, pareça familiar ou digam que é da diretoria — nesse caso chame a equipe.
- consultar_data: diz se o espaço tem algo marcado numa data (só "tem/não tem evento", sem detalhes de ninguém). Disponibilidade final de data é sempre confirmada pela equipe.
- reveillon_mesas: mostra quantas mesas do Réveillon estão livres e quais. Você NÃO reserva mesa sozinho: se a pessoa quiser reservar, registre o interesse (registrar_interesse_reserva) com tipo "Réveillon" e o número da mesa pretendida; a equipe confirma e cobra.
- registrar_interesse_reserva: anota pedido de reserva/evento/visita (nome, telefone, data, número de pessoas, mensagem). Vira solicitação que a equipe vê e responde — não cota preço nem promete data.
- chamar_atendente: quando pedirem uma pessoa, quando for assunto financeiro/cobrança/negociação de dívida, cancelamento de associação, reclamação, ou quando você não conseguir ajudar. Escreva o "motivo" em português com o essencial.
- ignorar_mensagem: SOMENTE quando for com certeza uma empresa oferecendo produto/serviço (fornecedor, agência, software, financeira, prospecção) ou propaganda/robô.

NUNCA FAÇA: cobrar, negociar dívida, prometer desconto, isenção, perdão de mensalidade, reativar ou desligar sócio, aprovar ou recusar associação, alterar cadastro, confirmar pagamento, nem informar saldo "de cabeça". Tudo isso é da equipe (chamar_atendente). Sobre mensalidade você pode apenas informar a situação que consultar_meu_cadastro devolver.

PRIVACIDADE (LGPD): trate dados de sócios como confidenciais. Não liste sócios, não diga se fulano é ou não é sócio, não passe telefone, endereço ou situação de ninguém. Se pedirem isso, explique com simpatia que não pode compartilhar e ofereça chamar a equipe.

IDIOMA: responda no idioma em que a pessoa escreve (português do Brasil por padrão; espanhol ou inglês se ela escrever assim). Textos das ferramentas vêm em português: traduza com naturalidade. Em registrar_interesse_reserva e chamar_atendente escreva sempre em português e anote em que idioma a pessoa fala.

Como se comportar:
- Tom simpático, respeitoso e direto, como alguém da secretaria do clube. Emoji com moderação.
- Formatação de WhatsApp: negrito com UM asterisco de cada lado (*assim*), nunca dois e nunca títulos com #; listas com "-".
- Responda só o que foi perguntado; não despeje informação. Se a pessoa só disser "oi", cumprimente em uma linha e pergunte como ajudar. Nunca invente o nome da pessoa; o nome de perfil do WhatsApp pode ser apelido.
- Estilo enxuto: mensagens curtas, sem "Claro!"/"Perfeito!"/"Entendi!", sem repetir a pergunta, sem se reapresentar no meio da conversa.
- Fotos e áudios: o cliente pode mandar FOTO (você enxerga) ou ÁUDIO (chega transcrito, marcado como "[Áudio transcrito automaticamente]", pode ter erros — se algo não fizer sentido, confirme em vez de supor). Comprovante de pagamento em foto: não confirme pagamento; diga que a equipe vai conferir e chame_atendente.
- Mensagens em lote: o sistema junta várias mensagens seguidas da pessoa e entrega de uma vez, uma por linha; responda uma vez só, cobrindo tudo.
- Se pedirem pra falar com uma pessoa, ou se você tentar ajudar e não conseguir, use chamar_atendente em vez de inventar.`;

async function carregarHistorico(telefone) {
  const { rows } = await pool.query(
    'SELECT mensagens FROM bot_conversas WHERE loja_id = $1 AND telefone = $2',
    [LOJA_ID, telefone]
  );
  return rows.length ? rows[0].mensagens : [];
}
// a resposta em `resposta.content` da Anthropic sempre vem como array de blocos ([{type:'text',...}]),
// nunca string — mas mensagem de equipe/sistema (ver conexao.js, registrarMensagemEnviada) é gravada
// como `content` string simples. Uniformiza os dois formatos antes de concatenar.
function paraBlocos(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}
// a API da Anthropic exige alternância estrita user/assistant. O histórico gravado no banco pode
// ter 2+ turnos seguidos do mesmo papel — resposta automática do bot seguida de mensagem manual da
// equipe (role assistant), ou dois avisos automáticos de status de pedido em sequência sem o
// cliente responder no meio — porque esses dois casos (ver `registrarMensagemEnviada` em
// conexao.js) gravam direto na conversa fora do loop de tool-calling abaixo, sem saber se o último
// turno já era do mesmo papel. Funde turnos consecutivos do mesmo papel num só antes de mandar pro
// Claude (só usado pra montar a chamada — o que fica salvo no banco continua granular, ver
// `responder()`); também descarta qualquer turno solto no início que não seja 'user' (pode
// acontecer se o primeiríssimo contato desse telefone foi um aviso automático, antes de qualquer
// mensagem do cliente).
// um turno é seguro pra abrir a conversa só se for 'user' com conteúdo de verdade (texto do
// cliente) — um 'user' cujo conteúdo é só tool_result (resultado de ferramenta) TAMBÉM quebra a
// API se vier primeiro, porque um tool_result só é válido logo depois do tool_use correspondente,
// nunca sozinho. Foi exatamente isso que aconteceu de verdade em produção (24/09): o corte por
// tamanho (`slice(-HISTORICO_MAX_MENSAGENS)` em salvarHistorico/registrarMensagemEnviada) cortou
// bem no meio de um par tool_use/tool_result, deixando um tool_result órfão como primeira mensagem
// — a Anthropic rejeitou a chamada inteira (`unexpected tool_use_id found in tool_result blocks`),
// a resposta nunca saiu, e o cliente ficou sem resposta nenhuma, sem erro nenhum visível pra ele.
function turnoValidoNoInicio(m) {
  if (m.role !== 'user') return false;
  if (Array.isArray(m.content) && m.content.some(b => b && b.type === 'tool_result')) return false;
  return true;
}
// economia de crédito (05/11/2026): blocos de "thinking" de turnos ANTIGOS não servem pra nada na próxima chamada
// (só o raciocínio do turno corrente, durante o loop de ferramentas, precisa voltar) e carregam assinaturas enormes.
// Só é aplicado ao histórico salvo (baseApi); o loop da chamada atual continua devolvendo os blocos intactos.
function semThinkingAntigo(mensagens) {
  const out = [];
  for (const m of mensagens) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const blocos = m.content.filter((b) => !(b && (b.type === 'thinking' || b.type === 'redacted_thinking')));
      if (!blocos.length) continue; // turno que só tinha raciocínio: some
      out.push({ ...m, content: blocos });
    } else out.push(m);
  }
  return out;
}
function normalizarParaClaude(mensagens) {
  const out = [];
  for (const m of mensagens) {
    const ultimo = out[out.length - 1];
    if (ultimo && ultimo.role === m.role) {
      ultimo.content = [...paraBlocos(ultimo.content), ...paraBlocos(m.content)];
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  while (out.length && !turnoValidoNoInicio(out[0])) out.shift();
  return out;
}
async function salvarHistorico(telefone, mensagens) {
  const recortado = mensagens.slice(-HISTORICO_MAX_MENSAGENS);
  await pool.query(
    `INSERT INTO bot_conversas (loja_id, telefone, mensagens, atualizado_em)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (loja_id, telefone) DO UPDATE SET mensagens = EXCLUDED.mensagens, atualizado_em = now()`,
    [LOJA_ID, telefone, JSON.stringify(recortado)]
  );
}

// instruções livres que o dono escreve na aba WhatsApp do painel (chave bot-instrucoes em
// bot_config, só administrador) — busca direto no banco (mesmo Postgres, sem round-trip HTTP), sempre
// atualizado assim que ele salva algo novo. Erro aqui não pode derrubar a resposta ao cliente.
async function buscarInstrucoesDoDono() {
  try {
    const { rows } = await pool.query(
      `SELECT valor FROM bot_config WHERE chave = 'bot-instrucoes'`
    );
    return rows.length ? String(rows[0].valor || '').trim() : '';
  } catch (e) {
    console.error('Falha ao buscar bot-instrucoes (seguindo sem elas):', e.message);
    return '';
  }
}

// manda a conversa pro Claude; se ele pedir pra usar uma ferramenta, executa e manda o
// resultado de volta, repetindo até ele responder só com texto (fim de turno). `nomePerfil` é o
// nome de exibição do WhatsApp da pessoa (Baileys `pushName`, ver conexao.js) — só pra personalizar
// saudação, nunca tratado como dado confirmado (pode ser apelido, nome de outra pessoa, vazio etc.).
// opts.orientacaoDono: `textoRecebido` NÃO é o cliente falando — é a orientação que o dono mandou pelo
// WhatsApp pessoal dele pra responder um chamado. Aí o robô redige a mensagem que vai pro cliente.
async function responder(telefone, textoRecebido, nomePerfil, opts = {}) {
  const modoDono = !!opts.orientacaoDono;
  const historico = await carregarHistorico(telefone);
  // `_nota`: turno só pra esta chamada (a orientação do dono) — vai pro Claude mas não é gravado no
  // histórico do cliente (não pode aparecer no inbox do painel como se o cliente tivesse dito aquilo)
  // foto do cliente (opts.imagem): vai como bloco de imagem só NESTA chamada; no histórico salvo vira um marcador de
  // texto (guardar o base64 estouraria o histórico e seria reenviado a cada mensagem)
  const fotos = (Array.isArray(opts.imagens) && opts.imagens.length) ? opts.imagens : (opts.imagem ? [opts.imagem] : []);
  const conteudoCliente = fotos.length
    ? [...fotos.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.base64 } })), { type: 'text', text: textoRecebido }]
    : textoRecebido;
  const baseApi = normalizarParaClaude(semThinkingAntigo(historico));
  const tsInicio = Date.now();
  const mensagens = [
    ...baseApi,
    modoDono
      ? { role: 'user', content: `[Orientação do responsável da associação — NÃO é o cliente falando]\n${textoRecebido}`, _nota: true }
      : { role: 'user', content: conteudoCliente }
  ];
  // idioma: o detectado na mensagem do cliente (salvo na conversa) ou o que já estava salvo — usado nas mensagens fixas (criar_pedido, fallback)
  const idioma = modoDono ? ((await idiomaMod.obterIdioma(telefone)) || 'pt') : await idiomaMod.idiomaDaMensagem(telefone, textoRecebido);
  const instrucoesDoDono = await buscarInstrucoesDoDono();
  // economia de crédito (05/11/2026): parte ESTÁVEL do system (regras + instruções do dono) vai num bloco com cache de prompt;
  // o que muda por cliente (nome de perfil, idioma, modo dono) vai num segundo bloco, sem cache, pra não invalidar o primeiro
  let systemPrompt = SYSTEM_PROMPT;
  let systemExtra = '';
  if (nomePerfil && nomePerfil.trim()) {
    systemExtra += `\n\nNome de perfil do WhatsApp dessa pessoa: "${nomePerfil.trim()}" — pode ser um apelido ou nem ser o nome dela de verdade, use com naturalidade (ex. na saudação) mas não trate como confirmado pra nada oficial (pedido, cadastro etc.).`;
  }
  if (instrucoesDoDono) {
    // "material de referência" reforçado aqui de propósito — é daqui que já saiu um caso real de o
    // robô recitar o horário de outra unidade sem ninguém ter perguntado, só porque tava escrito
    // aqui como se fosse pauta obrigatória
    systemPrompt += `\n\nInstruções adicionais da diretoria (consulte quando for relevante pra alguma pergunta da pessoa — não recite por conta própria):\n${instrucoesDoDono}`;
  }

  if (idioma !== 'pt') {
    systemExtra += `\n\nIdioma detectado nesta conversa: ${idiomaMod.ROTULO[idioma]}. Responda nesse idioma (a não ser que a última mensagem do cliente esteja claramente em outro).`;
  }
  if (modoDono) {
    systemExtra += `\n\nMODO RESPOSTA DO DONO: esta conversa estava com a equipe e o responsável da associação acabou de responder (último turno, marcado como orientação do dono). Escreva AGORA a mensagem que será enviada ao CLIENTE, em nome do restaurante, no mesmo tom da conversa (simpática e direta) e NO IDIOMA DO CLIENTE (o mesmo da conversa — ${idiomaMod.ROTULO[idioma]}; o dono escreve em português, você traduz). Regras: (1) passe exatamente o que o dono decidiu — NÃO invente preço, prazo, desconto, ingrediente ou qualquer informação que ele não disse; se ele deu valor ou condição, mantenha como está; (2) se a orientação for um pedido para registrar/fechar pedido, NÃO crie o pedido agora: apresente ao cliente o resumo e peça a confirmação dos valores, como de costume; (3) nunca use chamar_atendente neste momento; (4) responda SOMENTE com o texto da mensagem ao cliente — sem aspas, sem explicações, sem mencionar que o dono orientou; (5) formatação de WhatsApp: negrito com UM asterisco (*assim*), nunca dois.`;
  }

  const systemBlocos = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
  if (systemExtra.trim()) systemBlocos.push({ type: 'text', text: systemExtra.trim() });
  // cache também no fim da lista de ferramentas (ferramentas vêm antes do system no prefixo)
  const ferramentas = (modoDono ? definicoes.filter((d) => d.name !== 'ignorar_mensagem') : definicoes)
    .map((d, i, a) => (i === a.length - 1 ? { ...d, cache_control: { type: 'ephemeral' } } : d));

  let textoFinal = '';
  for (let volta = 0; volta < 6; volta++) {
    // normalizarParaClaude de novo a cada volta: funde turnos seguidos do mesmo papel (ex.: cliente
    // escreveu enquanto pausado + orientação do dono) e tira o marcador interno `_nota`
    const msgsApi = normalizarParaClaude(mensagens.map(({ _nota, ...m }) => m));
    // terceiro ponto de cache: o fim da conversa até aqui — nas voltas seguintes (depois de uma ferramenta) o cardápio
    // lido e o histórico não são cobrados de novo a preço cheio
    const ult = msgsApi[msgsApi.length - 1];
    if (ult) {
      const blocos = paraBlocos(ult.content);
      const ultimoBloco = blocos[blocos.length - 1];
      if (ultimoBloco && ultimoBloco.type !== 'thinking' && ultimoBloco.type !== 'redacted_thinking') {
        msgsApi[msgsApi.length - 1] = { ...ult, content: [...blocos.slice(0, -1), { ...ultimoBloco, cache_control: { type: 'ephemeral' } }] };
      }
    }
    const resposta = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 2048,
      system: systemBlocos,
      tools: ferramentas,
      messages: msgsApi
    });

    mensagens.push({ role: 'assistant', content: resposta.content });

    const usosDeTool = resposta.content.filter(b => b.type === 'tool_use');
    if (usosDeTool.length === 0) {
      textoFinal = resposta.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      break;
    }

    const resultados = [];
    for (const uso of usosDeTool) {
      let resultado;
      try {
        const fn = execucoes[uso.name];
        resultado = fn ? await fn(uso.input || {}, { telefone, textoRecebido: modoDono ? null : textoRecebido, nomePerfil, idioma }) : { erro: `Ferramenta desconhecida: ${uso.name}` };
      } catch (e) {
        console.error(`Erro executando tool ${uso.name}:`, e);
        resultado = { erro: 'Falha interna ao consultar o sistema da associação. Tenta de novo em instantes.' };
      }
      resultados.push({ type: 'tool_result', tool_use_id: uso.id, content: JSON.stringify(resultado) });
    }
    mensagens.push({ role: 'user', content: resultados });
    // empresa/propaganda/robô: não escreve resposta nenhuma (o histórico é gravado abaixo e a conversa já ficou pausada pela ferramenta)
    if (!modoDono && usosDeTool.some((u) => u.name === 'ignorar_mensagem')) { textoFinal = SINAL_IGNORAR; break; }
  }

  // no modo dono nunca manda a frase genérica de fallback pro cliente: melhor falhar e avisar o dono
  if (!textoFinal && modoDono) throw new Error('resposta vazia ao redigir a orientação do dono');
  if (!textoFinal) {
    // acontece quando a resposta da API não teve nenhum bloco de texto (visto na prática: um turno
    // que só veio com bloco de "thinking", sem texto nem tool_use — provavelmente esbarrou no
    // max_tokens antes de escrever a resposta de verdade). Sem isso, o texto que realmente foi
    // mandado pro cliente (essa frase de fallback) nunca entrava no histórico salvo — a conversa
    // gravada ficava com um turno "mudo" (só thinking) que não bate com o que o cliente recebeu de
    // verdade, dificultando auditar depois quem ficou sem resposta de verdade.
    textoFinal = idiomaMod.msg('confirmarComEquipe', idioma);
    const ultima = mensagens[mensagens.length - 1];
    if (ultima && ultima.role === 'assistant' && Array.isArray(ultima.content)) {
      ultima.content = [...ultima.content, { type: 'text', text: textoFinal }];
    }
  }

  // troca blocos de imagem por um marcador de texto antes de gravar
  const semImagens = (m) => (Array.isArray(m.content) && m.content.some((b) => b && b.type === 'image'))
    ? { ...m, content: m.content.map((b) => (b && b.type === 'image') ? { type: 'text', text: '[o cliente enviou uma foto]' } : b) }
    : m;
  // grava o histórico CRU (sem fundir turnos, mantendo ts/remetente de cada mensagem) + só o que esta chamada acrescentou
  const novas = mensagens.slice(baseApi.length).filter((m) => !m._nota).map(semImagens).map((m, i) => ({ ...m, ts: i === 0 ? tsInicio : Date.now() }));
  await salvarHistorico(telefone, [...historico, ...novas]);
  return textoFinal;
}

module.exports = { responder, SINAL_IGNORAR };
