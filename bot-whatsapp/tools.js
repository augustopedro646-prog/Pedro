// Ferramentas do atendente. Tudo que é da loja (vitrine, preço, estoque, criar pedido) passa pela
// API pública do site — as MESMAS regras do site valem aqui (preço calculado no servidor, peça
// reservada, telefone vira cadastro). Só o que é "da conversa" e consulta do próprio cliente lê o
// banco direto (pedidos/cashback DESTE telefone, nunca de outro).
const { LOJA_ID, API_BASE, pool, telefoneLocal } = require('./config');

async function api(caminho, opcoes = {}) {
  const r = await fetch(`${API_BASE}/lojas/${LOJA_ID}${caminho}`, {
    method: opcoes.method || 'GET', headers: { 'Content-Type': 'application/json' },
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined, signal: AbortSignal.timeout(15000),
  });
  const dados = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, dados };
}

function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
const brl = (v) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');

const definicoes = [
  {
    name: 'buscar_produtos',
    description: 'Busca peças na vitrine da loja (só o que está à venda e com estoque). Devolve cada produto com id, categoria, descrição, se tem foto, e as variações (id, tamanho, cor, preço e quantas peças há — até 10). Use SEMPRE antes de falar de preço, tamanho, cor ou disponibilidade. Sem termo, lista a vitrine inteira.',
    input_schema: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'palavras da busca (ex.: "vestido", "conjunto menino", "body rosa"). Opcional.' },
        tamanho: { type: 'string', description: 'filtrar por tamanho (ex.: "4", "M", "RN"). Opcional.' },
      },
    },
  },
  {
    name: 'enviar_foto_produto',
    description: 'Manda pro cliente, nesta conversa do WhatsApp, as fotos de um produto (até 3). Use quando o cliente quiser ver a peça, ou quando ajudar a decidir. Só funciona pra produto que tenha foto (campo temFoto em buscar_produtos).',
    input_schema: { type: 'object', properties: { produtoId: { type: 'string' } }, required: ['produtoId'] },
  },
  {
    name: 'info_loja',
    description: 'Endereço da loja, se faz entrega e a taxa, se aceita retirada, link do site pra ver a vitrine e fazer pedido sozinho, e avisos da loja.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'criar_pedido',
    description: 'Fecha o pedido de verdade: reserva as peças no estoque e ele aparece na tela da loja. Só use DEPOIS de o cliente confirmar explicitamente: as peças (variacaoId de buscar_produtos, com quantidade), retirada ou entrega (endereço completo com rua, número e bairro), forma de pagamento (paga na entrega/retirada) e o nome. Nunca calcule o total por conta própria — o sistema devolve o total certo.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'nome do cliente' },
        telefone: { type: 'string', description: 'só preencha se o sistema pedir (quando não der pra saber o número pelo WhatsApp)' },
        tipo: { type: 'string', enum: ['retirada', 'entrega'] },
        endereco: { type: 'string', description: 'obrigatório se entrega: rua, número, bairro e referência' },
        pagamento: { type: 'string', enum: ['Pix', 'Dinheiro', 'Débito', 'Crédito'] },
        trocoPara: { type: 'number', description: 'só se Dinheiro e o cliente precisar de troco: o valor da nota que vai usar' },
        observacao: { type: 'string', description: 'ex.: é presente, pode embalar' },
        itens: {
          type: 'array',
          items: { type: 'object', properties: { variacaoId: { type: 'string' }, qtd: { type: 'integer' } }, required: ['variacaoId', 'qtd'] },
        },
      },
      required: ['nome', 'tipo', 'pagamento', 'itens'],
    },
  },
  {
    name: 'meus_pedidos',
    description: 'Mostra os últimos pedidos deste cliente (pelo número do WhatsApp dele) com o status de cada um. Use quando perguntarem "cadê meu pedido", "já está pronto?" etc.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'meu_cashback',
    description: 'Saldo de cashback e de vale-troca deste cliente (pelo número do WhatsApp dele). O cashback é usado como desconto numa compra na loja.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'chamar_atendente',
    description: 'Passa a conversa pra alguém da equipe: use quando o cliente pedir pra falar com uma pessoa, quiser trocar/devolver peça, reclamar, negociar preço/desconto, cancelar ou mudar um pedido, ou quando você não conseguir ajudar. Depois disso você para de responder essa conversa até a equipe devolver.',
    input_schema: { type: 'object', properties: { motivo: { type: 'string', description: 'resumo curto do que o cliente precisa' } }, required: ['motivo'] },
  },
];

async function catalogo() {
  const r = await api('/loja/catalogo');
  if (!r.ok) throw new Error('catálogo indisponível (HTTP ' + r.status + ')');
  return r.dados;
}

const execucoes = {
  async buscar_produtos({ termo, tamanho }) {
    const { produtos } = await catalogo();
    const palavras = normalizar(termo).split(' ').filter((p) => p.length > 1);
    let lista = produtos.filter((p) => {
      const texto = normalizar([p.nome, p.categoria, p.descricao, ...p.variacoes.map((v) => v.cor)].join(' '));
      return palavras.every((w) => texto.includes(w) || texto.includes(w.replace(/s$/, '')));
    });
    if (tamanho) lista = lista.filter((p) => p.variacoes.some((v) => normalizar(v.tamanho) === normalizar(tamanho) && v.disponivel > 0));
    if (!lista.length) return { encontrados: 0, dica: 'Nada com esse filtro. Ofereça o que existe (busque sem termo) ou chame um atendente se o cliente procura algo específico.' };
    return {
      encontrados: lista.length,
      produtos: lista.slice(0, 25).map((p) => ({
        id: p.id, nome: p.nome, categoria: p.categoria, descricao: p.descricao || undefined, temFoto: p.fotos.length > 0,
        variacoes: p.variacoes.filter((v) => v.disponivel > 0).map((v) => ({ variacaoId: v.id, tamanho: v.tamanho, cor: v.cor, preco: v.preco, disponivel: v.disponivel,
          ...(v.precoCheio ? { emPromocao: v.promocao, precoSemPromocao: v.precoCheio, promocaoAte: v.promocaoAte } : {}) })),
      })),
    };
  },

  async enviar_foto_produto({ produtoId }, ctx) {
    const { produtos } = await catalogo();
    const p = produtos.find((x) => x.id === produtoId);
    if (!p) return { erro: 'Produto não encontrado na vitrine.' };
    if (!p.fotos.length) return { erro: 'Esse produto ainda não tem foto cadastrada — descreva a peça ou mande o link do site.' };
    let enviadas = 0;
    for (const [i, fotoId] of p.fotos.slice(0, 3).entries()) {
      const r = await fetch(`${API_BASE}/lojas/${LOJA_ID}/fotos/${fotoId}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const imagem = Buffer.from(await r.arrayBuffer());
      const ok = await ctx.enviarImagem(imagem, i === 0 ? p.nome : '');
      if (ok) enviadas++;
    }
    return enviadas ? { ok: true, enviadas } : { erro: 'Não consegui mandar a foto agora.' };
  },

  async info_loja() {
    const { config } = await catalogo();
    return {
      loja: 'Loja Gutto', endereco: config.endereco || null, recebendoPedidos: config.ativo,
      retiradaNaLoja: config.aceitaRetirada, entrega: config.aceitaEntrega, taxaEntrega: config.aceitaEntrega ? config.taxaEntrega : null,
      siteParaVerVitrineEPedir: process.env.SITE_URL || null, aviso: config.mensagem || null,
    };
  },

  async criar_pedido(input, ctx) {
    const telefone = ctx.telefoneLocal || telefoneLocal(input.telefone);
    if (!telefone) return { erro: 'Não consegui identificar o número deste WhatsApp. Pergunte o telefone com DDD do cliente e chame de novo preenchendo o campo telefone.' };
    const r = await api('/loja/pedidos', { method: 'POST', body: {
      origem: 'whatsapp', nome: input.nome, telefone, tipo: input.tipo, endereco: input.tipo === 'entrega' ? input.endereco : null, pagamento: input.pagamento,
      trocoPara: input.pagamento === 'Dinheiro' ? input.trocoPara : null, observacao: input.observacao || null,
      itens: (input.itens || []).map((i) => ({ variacaoId: i.variacaoId, qtd: i.qtd })),
    } });
    if (!r.ok) return { erro: r.dados.erro || 'Não deu pra fechar o pedido agora.', detalhe: r.dados.codigo === 'estoque_insuficiente' ? 'confira de novo com buscar_produtos e ajuste a quantidade' : undefined };
    await pool.query('UPDATE bot_conversas SET cliente_nome = $1 WHERE loja_id = $2 AND telefone = $3', [input.nome, LOJA_ID, ctx.telefone]).catch(() => {});
    return { ok: true, numeroPedido: r.dados.numero, total: brl(r.dados.total),
      linkAcompanhar: process.env.SITE_URL ? process.env.SITE_URL.replace(/\/+$/, '') + '/loja-gutto.html#pedido=' + r.dados.token : null,
      proximoPasso: 'As peças já estão separadas no nome do cliente. A loja avisa por aqui a cada etapa.' };
  },

  async meus_pedidos(_, ctx) {
    if (!ctx.telefoneLocal) return { erro: 'Não dá pra saber o número deste WhatsApp — peça o número do pedido e chame um atendente.' };
    const { rows } = await pool.query(
      `SELECT numero, status, tipo, total, criado_em, pago_online, pag_status, envio_servico, rastreio FROM pedidos_online WHERE loja_id = $1 AND telefone = $2 ORDER BY criado_em DESC LIMIT 5`,
      [LOJA_ID, ctx.telefoneLocal]);
    const nomes = { aguardando_pagamento: 'esperando o pagamento pelo site (o link do pedido tem o Pix/cartão; se não pagar no prazo, cancela sozinho)', recebido: 'recebido, vai ser separado',
      separando: 'separando as peças', pronto: 'pronto', saiu_entrega: 'saiu para entrega', entregue: 'concluído', cancelado: 'cancelado' };
    const tipos = { entrega: 'entrega da loja', retirada: 'retirada na loja', envio: 'envio pelos Correios' };
    return rows.length ? { pedidos: rows.map((p) => ({ numero: p.numero, status: p.tipo === 'envio' && p.status === 'saiu_entrega' ? 'enviado pelos Correios' : nomes[p.status], tipo: tipos[p.tipo] || p.tipo, total: brl(p.total),
      ...(p.pago_online ? { pagamento: p.pag_status === 'pago' ? 'pago pelo site' : p.pag_status === 'estornado' ? 'pago pelo site e devolvido' : 'pagamento pelo site pendente' } : {}),
      ...(p.envio_servico ? { envio: p.envio_servico } : {}), ...(p.rastreio ? { rastreio: p.rastreio, acompanharEm: 'https://www.melhorrastreio.com.br/rastreio/' + p.rastreio } : {}),
      feitoEm: new Date(p.criado_em).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }) })) }
      : { pedidos: [], dica: 'Nenhum pedido com este número de WhatsApp.' };
  },

  async meu_cashback(_, ctx) {
    if (!ctx.telefoneLocal) return { erro: 'Não dá pra saber o número deste WhatsApp.' };
    const { rows } = await pool.query(
      `SELECT c.nome,
              COALESCE((SELECT SUM(valor) FROM cliente_creditos cc WHERE cc.cliente_id = c.id AND cc.tipo = 'cashback'), 0) AS cashback,
              COALESCE((SELECT SUM(valor) FROM cliente_creditos cc WHERE cc.cliente_id = c.id AND cc.tipo = 'vale_troca'), 0) AS vale_troca
       FROM clientes c WHERE c.loja_id = $1 AND c.telefone = $2`, [LOJA_ID, ctx.telefoneLocal]);
    if (!rows.length) return { cadastrado: false, dica: 'Ainda não tem cadastro — ganha cashback a partir da primeira compra.' };
    return { cadastrado: true, cashback: brl(rows[0].cashback), valeTroca: brl(rows[0].vale_troca) };
  },

  async chamar_atendente({ motivo }, ctx) {
    await pool.query(
      `INSERT INTO bot_conversas (loja_id, telefone, precisa_humano, pausado, pausado_em, motivo_humano)
       VALUES ($1, $2, true, true, now(), $3)
       ON CONFLICT (loja_id, telefone) DO UPDATE SET precisa_humano = true, pausado = true, pausado_em = now(), motivo_humano = $3`,
      [LOJA_ID, ctx.telefone, String(motivo || '').slice(0, 300)]);
    return { ok: true, dica: 'Avise o cliente que alguém da equipe vai responder em breve por aqui.' };
  },
};

module.exports = { definicoes, execucoes };
