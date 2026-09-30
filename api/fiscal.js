// NFC-e via Focus NFe (Fase 5). Mesmo desenho do PDV Jabá (api/fiscal.js de lá): a loja não fala
// com a SEFAZ direto (assinatura de XML, schemas, contingência) — a Focus NFe faz isso.
//
// Precisa, no api/.env (valores do painel da Focus NFe, na empresa da Loja Gutto):
//   FOCUS_NFE_AMBIENTE=homologacao        (ou producao — só depois de autorizar notas de teste)
//   FOCUS_NFE_CNPJ_EMITENTE=00000000000000
//   FOCUS_NFE_TOKEN_HOMOLOGACAO=...        (token da EMPRESA, não o da conta: o da conta dá 401
//   FOCUS_NFE_TOKEN_PRODUCAO=...            na emissão — aprendido no Jabá)
// E na tela (Equipe → Configurações da loja → Nota fiscal): CFOP e CSOSN confirmados pela
// contadora, e o NCM de cada produto. Sem isso não emite: nota errada é pior que nota nenhuma.
//
// Uma nota por venda (notas_fiscais.venda_id único). A referência na Focus é estável por tentativa:
// se a resposta se perdeu (rede caiu no meio), antes de reenviar consulta a mesma referência pra
// nunca emitir duas notas da mesma venda. Rejeitada pela SEFAZ → nova tentativa com referência nova.
const { pool, uid } = require('./db');

function ambiente() { return process.env.FOCUS_NFE_AMBIENTE === 'producao' ? 'producao' : 'homologacao'; }
function baseUrl() {
  if (process.env.FOCUS_NFE_URL) return process.env.FOCUS_NFE_URL.replace(/\/$/, ''); // testes
  return ambiente() === 'producao' ? 'https://api.focusnfe.com.br' : 'https://homologacao.focusnfe.com.br';
}
function token() {
  return ambiente() === 'producao' ? process.env.FOCUS_NFE_TOKEN_PRODUCAO : process.env.FOCUS_NFE_TOKEN_HOMOLOGACAO;
}
function cnpjEmitente() { return String(process.env.FOCUS_NFE_CNPJ_EMITENTE || '').replace(/\D/g, ''); }

// O que falta no servidor pra emitir (mostrado no painel, sem revelar valores).
function faltandoNoServidor() {
  const f = [];
  if (cnpjEmitente().length !== 14) f.push('FOCUS_NFE_CNPJ_EMITENTE');
  if (!token()) f.push('FOCUS_NFE_TOKEN_' + ambiente().toUpperCase());
  return f;
}

// Tabela oficial tPag (NFC-e 4.00). Cashback e vale-troca são crédito da própria loja (05).
// Confirmar com a contadora antes de produção.
const FORMA_SEFAZ = { 'Dinheiro': '01', 'Crédito': '03', 'Débito': '04', 'Pix': '17', 'Cashback': '05', 'Vale-troca': '05' };
const FORMAS_CARTAO = ['03', '04', '17']; // pedem "tipo de integração": 2 = maquininha não ligada ao sistema

const HOMOLOG_ITEM = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
const HOMOLOG_NOME = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';

class ErroFiscal extends Error {
  constructor(mensagem, status) { super(mensagem); this.status = status || 422; }
}

function digitoGtin(corpo) {
  let s = 0;
  for (let i = 0; i < corpo.length; i++) s += Number(corpo[corpo.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (s % 10)) % 10;
}
// GTIN de verdade (do fabricante) vai na nota; código interno da loja (começa com 2, "circulação
// restrita") ou inválido vai como "SEM GTIN" — a SEFAZ confere o GTIN no cadastro nacional.
function gtinParaNota(codigo) {
  const c = String(codigo || '');
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(c) || c.startsWith('2')) return 'SEM GTIN';
  return digitoGtin(c.slice(0, -1)) === Number(c.slice(-1)) ? c : 'SEM GTIN';
}

function dataEmissaoAgora() {
  // -03:00 fixo (sem horário de verão desde 2019); a SEFAZ recusa horário muito no passado, então
  // vale o momento da emissão, não o da venda.
  const d = new Date(Date.now() - 3 * 3600e3);
  return d.toISOString().slice(0, 19) + '-03:00';
}

function cpfValido(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const n of [9, 10]) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(cpf[i]) * (n + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(cpf[n])) return false;
  }
  return true;
}

async function configFiscal(db, lojaId) {
  const { rows } = await db.query('SELECT fiscal_cfop, fiscal_csosn, fiscal_origem, nfce_automatica FROM lojas WHERE id = $1', [lojaId]);
  const l = rows[0] || {};
  return { cfop: l.fiscal_cfop || '', csosn: l.fiscal_csosn || '', origem: l.fiscal_origem || '0', automatica: !!l.nfce_automatica };
}

// Monta o JSON do POST /v2/nfce. Lança ErroFiscal com a lista do que falta, sem chamar a Focus.
async function montarPayload(db, lojaId, vendaId, cpf) {
  const { rows: vs } = await db.query(
    `SELECT v.*, po.tipo AS pedido_tipo FROM vendas v LEFT JOIN pedidos_online po ON po.id = v.pedido_online_id
     WHERE v.id = $1 AND v.loja_id = $2`, [vendaId, lojaId]);
  const venda = vs[0];
  if (!venda) throw new ErroFiscal('venda não encontrada', 404);
  if (venda.cancelada) throw new ErroFiscal('Venda cancelada não tem nota', 409);
  const cfg = await configFiscal(db, lojaId);
  const falta = faltandoNoServidor();
  if (falta.length) throw new ErroFiscal('Nota fiscal ainda não configurada no servidor (falta ' + falta.join(', ') + ' no api\\.env)', 409);
  if (!/^\d{4}$/.test(cfg.cfop) || !/^\d{3}$/.test(cfg.csosn)) throw new ErroFiscal('Preencha CFOP e CSOSN (confirmados pela contadora) em Equipe → Configurações da loja → Nota fiscal', 409);

  const { rows: itens } = await db.query(
    `SELECT vi.*, p.ncm, pv.sku, pv.codigo_barras FROM vendas_itens vi
     JOIN produto_variacoes pv ON pv.id = vi.variacao_id JOIN produtos p ON p.id = pv.produto_id
     WHERE vi.venda_id = $1 ORDER BY vi.criado_em, vi.id`, [vendaId]);
  const semNcm = [...new Set(itens.filter((it) => !/^\d{8}$/.test(it.ncm || '')).map((it) => it.produto_nome))];
  if (semNcm.length) throw new ErroFiscal('Produto sem NCM (8 números): ' + semNcm.join(', ') + '. Preencha no Estoque (editar produto) e emita de novo.');

  const homolog = ambiente() === 'homologacao';
  let totalNota = 0;
  const items = itens.map((it, i) => {
    const qtd = Number(it.qtd), unit = Number(it.preco_unit), bruto = Math.round(unit * qtd * 100) / 100, desc = Number(it.desconto_item);
    totalNota += bruto - desc;
    const gtin = gtinParaNota(it.codigo_barras);
    const descricao = (it.produto_nome + ' ' + it.tamanho + (it.cor ? ' ' + it.cor : '')).slice(0, 120);
    return {
      numero_item: String(i + 1),
      codigo_produto: (it.sku || it.codigo_barras || it.variacao_id).slice(0, 60),
      descricao: homolog && i === 0 ? HOMOLOG_ITEM : descricao,
      codigo_ncm: it.ncm,
      cfop: cfg.cfop,
      codigo_barras_comercial: gtin,
      codigo_barras_tributavel: gtin,
      unidade_comercial: 'UN',
      unidade_tributavel: 'UN',
      quantidade_comercial: qtd,
      quantidade_tributavel: qtd,
      valor_unitario_comercial: unit,
      valor_unitario_tributavel: unit,
      valor_bruto: bruto,
      ...(desc > 0 ? { valor_desconto: desc } : {}),
      icms_origem: cfg.origem,
      icms_situacao_tributaria: cfg.csosn, // Simples Nacional → CSOSN
    };
  });
  totalNota = Math.round(totalNota * 100) / 100;
  if (totalNota <= 0) throw new ErroFiscal('Venda com total zero não tem nota', 409);

  // Pagamentos: somam o total da nota. A taxa de entrega (pedido online) não entra na NFC-e, então
  // os pagamentos são reduzidos na proporção; o último absorve o arredondamento.
  const { rows: pags } = await db.query('SELECT forma, valor FROM venda_pagamentos WHERE venda_id = $1 ORDER BY valor DESC', [vendaId]);
  const somaPag = pags.reduce((s, p) => s + Number(p.valor), 0);
  if (!pags.length || somaPag <= 0) throw new ErroFiscal('Venda sem pagamento registrado', 409);
  const desconhecida = pags.find((p) => !FORMA_SEFAZ[p.forma]);
  if (desconhecida) throw new ErroFiscal('Forma de pagamento sem código da SEFAZ: ' + desconhecida.forma);
  let resto = totalNota;
  const formas_pagamento = pags.map((p, i) => {
    const valor = i === pags.length - 1 ? Math.round(resto * 100) / 100 : Math.round(Number(p.valor) / somaPag * totalNota * 100) / 100;
    resto -= valor;
    const codigo = FORMA_SEFAZ[p.forma];
    return { forma_pagamento: codigo, valor_pagamento: valor, ...(FORMAS_CARTAO.includes(codigo) ? { tipo_integracao: '2' } : {}) };
  });

  const payload = {
    cnpj_emitente: cnpjEmitente(),
    data_emissao: dataEmissaoAgora(),
    natureza_operacao: 'VENDA AO CONSUMIDOR',
    // NFC-e só aceita presencial (1) ou entrega em domicílio (4).
    presenca_comprador: venda.pedido_tipo === 'entrega' ? '4' : '1',
    modalidade_frete: '9',
    local_destino: '1',
    consumidor_final: '1',
    items,
    formas_pagamento,
  };
  if (cpf) {
    payload.cpf_destinatario = cpf;
    if (homolog) payload.nome_destinatario = HOMOLOG_NOME;
  }
  return { payload, totalNota };
}

async function chamarFocus(metodo, caminho, corpo) {
  const resp = await fetch(baseUrl() + caminho, {
    method: metodo,
    headers: { Authorization: 'Basic ' + Buffer.from(token() + ':').toString('base64'), 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const texto = await resp.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : {}; } catch { json = { mensagem: texto.slice(0, 300) }; }
  return { http: resp.status, json };
}

function urlCompleta(caminho) {
  if (!caminho) return null;
  return /^https?:\/\//.test(caminho) ? caminho : baseUrl() + caminho;
}

// Grava a resposta da Focus (emissão ou consulta) na linha da nota.
async function gravarResposta(notaId, r) {
  const j = r.json || {};
  let status;
  if (j.status === 'autorizado') status = 'autorizada';
  else if (j.status === 'cancelado') status = 'cancelada';
  else if (j.status === 'erro_autorizacao' || j.status === 'denegado') status = 'rejeitada';
  else if (j.status === 'processando_autorizacao') status = 'pendente';
  else status = 'erro'; // 4xx da Focus (dado inválido, token errado): não chegou a virar nota
  const mensagem = j.mensagem_sefaz || j.mensagem || (Array.isArray(j.erros) ? j.erros.map((e) => e.mensagem).join('; ') : null) || (status === 'erro' ? 'Erro ' + r.http + ' na Focus NFe' : null);
  const { rows } = await pool.query(
    `UPDATE notas_fiscais SET status = $1, status_sefaz = $2, mensagem_sefaz = $3,
       chave_acesso = COALESCE($4, chave_acesso), numero = COALESCE($5, numero), serie = COALESCE($6, serie),
       url_danfe = COALESCE($7, url_danfe), url_consulta = COALESCE($8, url_consulta), resposta_bruta = $9, atualizado_em = now()
     WHERE id = $10 RETURNING *`,
    [status, j.status_sefaz || null, mensagem, j.chave_nfe || null, j.numero != null ? String(j.numero) : null, j.serie != null ? String(j.serie) : null,
      urlCompleta(j.caminho_danfe), j.url_consulta_nf || j.qrcode_url || null, JSON.stringify(j), notaId]);
  return rows[0];
}

// Emite a NFC-e da venda (ou devolve a que já existe). `cpf`: só dígitos, opcional.
async function emitir(lojaId, vendaId, cpf) {
  if (cpf && !cpfValido(cpf)) throw new ErroFiscal('CPF inválido', 400);
  const { rows: ja } = await pool.query("SELECT * FROM notas_fiscais WHERE venda_id = $1 AND loja_id = $2 AND status = 'autorizada'", [vendaId, lojaId]);
  if (ja.length) return ja[0];
  const { payload } = await montarPayload(pool, lojaId, vendaId, cpf);

  // Reserva a emissão (um clique duplo ou dois computadores não emitem duas vezes).
  let nota;
  const novo = await pool.query(
    `INSERT INTO notas_fiscais (id, loja_id, venda_id, ref, ambiente, status, cpf) VALUES ($1,$2,$3,$4,$5,'pendente',$6)
     ON CONFLICT (venda_id) DO NOTHING RETURNING *`,
    [uid(), lojaId, vendaId, 'gutto-' + vendaId, ambiente(), cpf || null]);
  if (novo.rows.length) nota = novo.rows[0];
  else {
    // Rejeitada/erro: nunca virou nota → tenta de novo com referência nova. Pendente antigo:
    // a resposta se perdeu → mesma referência, e pergunta à Focus antes de reenviar.
    const { rows } = await pool.query(
      `UPDATE notas_fiscais n SET status = 'pendente', atualizado_em = now(), tentativas = n.tentativas + 1, cpf = $2,
         ref = CASE WHEN n.status IN ('rejeitada', 'erro') THEN 'gutto-' || n.venda_id || '-' || (n.tentativas + 1) ELSE n.ref END,
         ambiente = CASE WHEN n.status IN ('rejeitada', 'erro') THEN $3 ELSE n.ambiente END
       FROM (SELECT id, status AS status_antes FROM notas_fiscais WHERE venda_id = $1 FOR UPDATE) a
       WHERE n.id = a.id AND (n.status IN ('rejeitada', 'erro') OR (n.status = 'pendente' AND n.atualizado_em < now() - interval '90 seconds'))
       RETURNING n.*, a.status_antes`,
      [vendaId, cpf || null, ambiente()]);
    if (!rows.length) {
      const { rows: atual } = await pool.query('SELECT * FROM notas_fiscais WHERE venda_id = $1', [vendaId]);
      const a = atual[0];
      if (a.status === 'autorizada') return a;
      if (a.status === 'cancelada') throw new ErroFiscal('A NFC-e dessa venda foi cancelada', 409);
      throw new ErroFiscal('A nota dessa venda está sendo emitida agora — aguarde uns segundos', 409);
    }
    nota = rows[0];
    if (nota.status_antes === 'pendente') {
      try {
        const c = await chamarFocus('GET', '/v2/nfce/' + encodeURIComponent(nota.ref));
        if (c.http === 200 && ['autorizado', 'processando_autorizacao', 'cancelado'].includes(c.json.status)) return gravarResposta(nota.id, c);
      } catch { /* sem resposta: reenvia a mesma referência (a Focus não emite duas vezes a mesma ref) */ }
    }
  }

  let r;
  try {
    r = await chamarFocus('POST', '/v2/nfce?ref=' + encodeURIComponent(nota.ref), payload);
  } catch (e) {
    // Não sabemos se chegou: fica pendente (a próxima tentativa consulta antes de reenviar).
    await pool.query("UPDATE notas_fiscais SET mensagem_sefaz = $1, atualizado_em = now() - interval '1 hour' WHERE id = $2",
      ['Sem resposta da Focus NFe (' + e.message + ') — tente de novo', nota.id]);
    throw new ErroFiscal('Sem resposta da Focus NFe (internet?). A venda está salva; tente emitir de novo.', 502);
  }
  return gravarResposta(nota.id, r);
}

// Cancela na SEFAZ (prazo curto — na maioria dos estados 30 minutos depois da autorização).
async function cancelar(lojaId, vendaId, justificativa) {
  const { rows } = await pool.query("SELECT * FROM notas_fiscais WHERE venda_id = $1 AND loja_id = $2", [vendaId, lojaId]);
  const nota = rows[0];
  if (!nota || nota.status !== 'autorizada') return null;
  let just = String(justificativa || '').trim();
  if (just.length < 15) just = ('Venda cancelada: ' + just).trim();
  const r = await chamarFocus('DELETE', '/v2/nfce/' + encodeURIComponent(nota.ref), { justificativa: just.slice(0, 255) });
  if (r.json && r.json.status === 'cancelado') return gravarResposta(nota.id, r);
  const msg = (r.json && (r.json.mensagem_sefaz || r.json.mensagem)) || 'Erro ' + r.http;
  await pool.query('UPDATE notas_fiscais SET mensagem_sefaz = $1, atualizado_em = now() WHERE id = $2', ['Cancelamento recusado: ' + msg, nota.id]);
  return { ...nota, erroCancelamento: msg };
}

module.exports = { emitir, cancelar, montarPayload, configFiscal, faltandoNoServidor, ambiente, cpfValido, gtinParaNota, ErroFiscal };
