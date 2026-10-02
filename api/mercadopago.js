// Pagamento pelo site via Mercado Pago.
// - Pix: o QR Code e o "copia e cola" aparecem na própria página do pedido (API de pagamentos).
// - Cartão: o cliente vai pra página do Mercado Pago (Checkout Pro) e volta pro acompanhamento do
//   pedido. Os dados do cartão nunca passam pelo sistema da loja.
//
// Precisa no api/.env (painel do Mercado Pago → Suas integrações → Credenciais):
//   MERCADOPAGO_ACCESS_TOKEN=APP_USR-...   (credencial de produção; as de teste começam com TEST-)
//   MERCADOPAGO_WEBHOOK_SECRET=...         (opcional: "assinatura secreta" das notificações)
// E SITE_URL (o domínio) pra o Mercado Pago avisar na hora que o pagamento caiu. Sem domínio,
// o sistema pergunta pro Mercado Pago de tempos em tempos (funciona igual, só demora um pouco mais).
//
// Regra de ouro: aviso que chega (webhook, volta do checkout) nunca é confiado — o sistema sempre
// consulta o pagamento direto no Mercado Pago antes de marcar o pedido como pago.
const crypto = require('crypto');

class ErroPagamento extends Error {
  constructor(msg, status) { super(msg); this.status = status || 502; }
}

function token() { return process.env.MERCADOPAGO_ACCESS_TOKEN || ''; }
function configurado() { return !!token(); }
function modoTeste() { return token().startsWith('TEST-'); }
function baseUrl() { return (process.env.MERCADOPAGO_URL || 'https://api.mercadopago.com').replace(/\/$/, ''); }

async function chamar(metodo, caminho, corpo, idempotencia) {
  if (!configurado()) throw new ErroPagamento('Pagamento pelo site não configurado (falta MERCADOPAGO_ACCESS_TOKEN)', 503);
  let r;
  try {
    r = await fetch(baseUrl() + caminho, {
      method: metodo,
      headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json', ...(idempotencia ? { 'X-Idempotency-Key': idempotencia } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new ErroPagamento('Não consegui falar com o Mercado Pago (' + e.message + ')');
  }
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    const causa = (dados.cause && dados.cause[0] && dados.cause[0].description) || dados.message || ('HTTP ' + r.status);
    throw new ErroPagamento('Mercado Pago recusou: ' + causa, r.status === 401 ? 503 : 502);
  }
  return dados;
}

// Data no formato que o Mercado Pago aceita (com fuso): 2026-10-02T15:30:00.000-03:00
function dataMP(d) {
  const off = -3 * 60; // horário de Brasília (o MP só quer um fuso válido; o instante é o mesmo)
  const local = new Date(d.getTime() + off * 60000);
  return local.toISOString().replace('Z', '-03:00');
}

async function criarPix({ referencia, valor, descricao, email, nome, expiraEm, notificacaoUrl, tentativa }) {
  const p = await chamar('POST', '/v1/payments', {
    transaction_amount: Number(valor.toFixed(2)), description: descricao.slice(0, 250), payment_method_id: 'pix',
    payer: { email, first_name: nome.split(' ')[0] }, external_reference: referencia,
    date_of_expiration: dataMP(expiraEm), ...(notificacaoUrl ? { notification_url: notificacaoUrl } : {}),
  }, referencia + '-pix-' + (tentativa || 1));
  const t = (p.point_of_interaction && p.point_of_interaction.transaction_data) || {};
  if (!t.qr_code) throw new ErroPagamento('O Mercado Pago não devolveu o QR Code do Pix');
  return { id: String(p.id), status: p.status, copiaCola: t.qr_code, qrBase64: t.qr_code_base64 || null };
}

// Checkout Pro só com cartão (o Pix é feito na nossa página, com QR).
async function criarCheckoutCartao({ referencia, itens, frete, email, nome, voltarUrl, notificacaoUrl, maxParcelas, expiraEm }) {
  const items = itens.map((i) => ({ id: i.id, title: i.titulo.slice(0, 250), quantity: i.qtd, unit_price: Number(i.preco.toFixed(2)), currency_id: 'BRL' }));
  if (frete > 0) items.push({ id: 'frete', title: 'Frete / entrega', quantity: 1, unit_price: Number(frete.toFixed(2)), currency_id: 'BRL' });
  const https = /^https:\/\//.test(voltarUrl);
  const pref = await chamar('POST', '/checkout/preferences', {
    items, payer: { email, name: nome }, external_reference: referencia, statement_descriptor: 'LOJA GUTTO',
    back_urls: { success: voltarUrl, failure: voltarUrl, pending: voltarUrl }, ...(https ? { auto_return: 'approved' } : {}),
    ...(notificacaoUrl ? { notification_url: notificacaoUrl } : {}),
    payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }, { id: 'bank_transfer' }], installments: maxParcelas || 1 },
    expires: true, expiration_date_from: dataMP(new Date(Date.now() - 60000)), expiration_date_to: dataMP(expiraEm),
  }, referencia + '-cartao');
  const url = modoTeste() ? (pref.sandbox_init_point || pref.init_point) : pref.init_point;
  if (!url) throw new ErroPagamento('O Mercado Pago não devolveu o link do pagamento');
  return { id: pref.id, url };
}

function resumir(p) {
  return {
    id: String(p.id), status: p.status, detalhe: p.status_detail, referencia: p.external_reference, valor: Number(p.transaction_amount),
    tipo: p.payment_type_id, parcelas: p.installments || 1, aprovadoEm: p.date_approved || null,
  };
}
async function consultar(id) { return resumir(await chamar('GET', '/v1/payments/' + encodeURIComponent(id))); }
async function buscarPorReferencia(referencia) {
  const r = await chamar('GET', '/v1/payments/search?sort=date_created&criteria=desc&external_reference=' + encodeURIComponent(referencia));
  return (r.results || []).map(resumir);
}
async function estornar(id) { return chamar('POST', '/v1/payments/' + encodeURIComponent(id) + '/refunds', {}, 'estorno-' + id); }
async function cancelar(id) { return chamar('PUT', '/v1/payments/' + encodeURIComponent(id), { status: 'cancelled' }); }

// Forma de pagamento no caixa a partir do que o cliente usou no Mercado Pago.
function formaDoPagamento(tipo) {
  if (tipo === 'credit_card') return 'Crédito';
  if (tipo === 'debit_card' || tipo === 'prepaid_card') return 'Débito';
  return 'Pix'; // pix (bank_transfer) e saldo da conta Mercado Pago
}

// Assinatura das notificações (x-signature: "ts=...,v1=..."). Sem segredo configurado, aceita —
// de qualquer forma o pagamento é sempre conferido direto no Mercado Pago.
function assinaturaValida(req, dataId) {
  const segredo = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  if (!segredo) return true;
  const partes = Object.fromEntries(String(req.headers['x-signature'] || '').split(',').map((s) => s.trim().split('=')));
  if (!partes.ts || !partes.v1) return false;
  const id = /^[a-z0-9]+$/i.test(String(dataId)) ? String(dataId).toLowerCase() : String(dataId);
  const manifesto = `id:${id};request-id:${req.headers['x-request-id'] || ''};ts:${partes.ts};`;
  const esperado = crypto.createHmac('sha256', segredo).update(manifesto).digest('hex');
  const a = Buffer.from(esperado), b = Buffer.from(String(partes.v1));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { ErroPagamento, configurado, modoTeste, criarPix, criarCheckoutCartao, consultar, buscarPorReferencia, estornar, cancelar, formaDoPagamento, assinaturaValida };
