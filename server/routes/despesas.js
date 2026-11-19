const express = require('express');
const { pool } = require('../db');
const { lerDocumento, leituraConfigurada, CATEGORIAS_SUGERIDAS } = require('../leituraNota');

// Despesas do fluxo de caixa: compras, boletos, contas e pagamentos. Montado em
// /api/financeiro/despesas (a autenticação e a aba fluxo_caixa já vêm do pai).
//
// "pago = false" é conta a pagar: `data` é o VENCIMENTO. Ao pagar, `data`
// passa a ser o dia do pagamento (é com essa data que entra no resultado do
// mês). Só despesa paga entra em "Despesas do mês"; a pagar aparece à parte.
const router = express.Router();

const FORMAS_PAGAMENTO = ['Dinheiro', 'Cartão de crédito', 'Cartão de débito', 'Pix', 'Boleto', 'Transferência'];
const TIPOS = ['compra', 'boleto', 'conta', 'pagamento', 'outro'];
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ANEXOS = 6;
const MAX_BYTES = 8 * 1024 * 1024;

class ErroDespesa extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

const dataLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dataValida = (s) => DATA_RE.test(String(s || '')) && !Number.isNaN(new Date(`${s}T12:00:00`).getTime());

function validar(b) {
  const x = b || {};
  const texto = (v, max, rotulo, obrigatorio) => {
    const t = String(v ?? '').trim();
    if (obrigatorio && !t) throw new ErroDespesa(400, `${rotulo} é obrigatório`);
    if (t.length > max) throw new ErroDespesa(400, `${rotulo} muito longo (máximo ${max} caracteres)`);
    return t || null;
  };
  if (!dataValida(x.data)) throw new ErroDespesa(400, 'Data inválida');
  const valor = Number(x.valor);
  if (!Number.isFinite(valor) || valor <= 0 || valor > 10000000) throw new ErroDespesa(400, 'Valor inválido (maior que zero)');
  if (x.formaPagamento && !FORMAS_PAGAMENTO.includes(x.formaPagamento)) throw new ErroDespesa(400, 'Forma de pagamento inválida');
  const tipo = x.tipo || 'compra';
  if (!TIPOS.includes(tipo)) throw new ErroDespesa(400, 'Tipo inválido');
  const pago = x.pago === undefined ? true : !!x.pago;
  return {
    data: x.data,
    descricao: texto(x.descricao, 200, 'Descrição', true),
    categoria: texto(x.categoria, 60, 'Categoria'),
    fornecedor: texto(x.fornecedor, 120, 'Fornecedor'),
    observacao: texto(x.observacao, 500, 'Observação'),
    formaPagamento: x.formaPagamento || null,
    valor: Math.round(valor * 100) / 100,
    tipo, pago,
  };
}

const COLUNAS = `d.id, to_char(d.data, 'YYYY-MM-DD') AS data, d.descricao, d.categoria, d.fornecedor, d.observacao,
  d.forma_pagamento AS "formaPagamento", d.valor, d.tipo, d.pago, to_char(d.pago_em, 'YYYY-MM-DD') AS "pagoEm",
  (SELECT count(*)::int FROM despesas_anexos a WHERE a.despesa_id = d.id) AS anexos`;

function intervaloMesAtual() {
  const h = new Date();
  return { inicio: dataLocal(new Date(h.getFullYear(), h.getMonth(), 1)), fim: dataLocal(new Date(h.getFullYear(), h.getMonth() + 1, 0)) };
}

// ---- leitura da foto (IA, opcional) ----
// Devolve só um RASCUNHO pra pré-preencher o formulário; nada é gravado aqui.
router.get('/ler-nota/status', (req, res) => res.json({ configurada: leituraConfigurada() }));

router.post('/ler-nota', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], limit: MAX_BYTES }), async (req, res) => {
  if (!leituraConfigurada()) return res.status(503).json({ erro: 'Leitura automática não configurada (falta ANTHROPIC_API_KEY no servidor). Dá pra cadastrar digitando e anexar a foto.', semChave: true });
  const mime = req.headers['content-type']?.split(';')[0];
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ erro: 'Envie a imagem ou PDF no corpo da requisição' });
  if (!conteudoConfere(req.body, mime)) return res.status(400).json({ erro: 'O arquivo não parece ser do tipo informado' });
  try {
    res.json({ rascunho: await lerDocumento(req.body, mime), categorias: CATEGORIAS_SUGERIDAS });
  } catch (err) {
    console.error('Falha ao ler documento:', err.message);
    res.status(502).json({ erro: 'Não deu pra ler agora. Tente de novo ou preencha digitando.' });
  }
});

// Confere o conteúdo real do arquivo (não só o que o cliente diz que é).
function conteudoConfere(buf, mime) {
  if (mime === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/png') return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
  if (mime === 'application/pdf') return buf.slice(0, 5).toString('ascii') === '%PDF-';
  return false;
}

// ---- contas a pagar ----
router.get('/a-pagar', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${COLUNAS} FROM despesas d WHERE d.pago = false ORDER BY d.data ASC, d.id ASC LIMIT 300`
    );
    const hoje = dataLocal(new Date());
    res.json({
      hoje,
      itens: rows.map((r) => ({ ...r, valor: Number(r.valor), vencida: r.data < hoje })),
      totalAPagar: rows.reduce((s, r) => s + Number(r.valor), 0),
      totalVencido: rows.filter((r) => r.data < hoje).reduce((s, r) => s + Number(r.valor), 0),
    });
  } catch (err) {
    next(err);
  }
});

// ---- lançamentos do mês (pagas) ----
router.get('/', async (req, res, next) => {
  const padrao = intervaloMesAtual();
  const inicio = dataValida(req.query.inicio) ? req.query.inicio : padrao.inicio;
  const fim = dataValida(req.query.fim) ? req.query.fim : padrao.fim;
  try {
    const { rows } = await pool.query(
      `SELECT ${COLUNAS} FROM despesas d WHERE d.pago = true AND d.data BETWEEN $1 AND $2
       ORDER BY d.data DESC, d.criado_em DESC`,
      [inicio, fim]
    );
    res.json(rows.map((r) => ({ ...r, valor: Number(r.valor) })));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const v = validar(req.body);
    const { rows } = await pool.query(
      `INSERT INTO despesas (data, descricao, categoria, forma_pagamento, valor, criado_por, fornecedor, tipo, pago, pago_em, observacao)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [v.data, v.descricao, v.categoria, v.formaPagamento, v.valor, req.usuario.pessoaId, v.fornecedor, v.tipo, v.pago, v.pago ? v.data : null, v.observacao]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err instanceof ErroDespesa) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const v = validar(req.body);
    const { rowCount } = await pool.query(
      `UPDATE despesas SET data = $1, descricao = $2, categoria = $3, forma_pagamento = $4, valor = $5,
              fornecedor = $6, tipo = $7, pago = $8, pago_em = $9, observacao = $10
       WHERE id = $11`,
      [v.data, v.descricao, v.categoria, v.formaPagamento, v.valor, v.fornecedor, v.tipo, v.pago, v.pago ? v.data : null, v.observacao, id]
    );
    if (!rowCount) return res.status(404).json({ erro: 'Lançamento não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ErroDespesa) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

// Marcar uma conta a pagar como paga: a data passa a ser a do pagamento.
router.post('/:id/pagar', async (req, res, next) => {
  const id = Number(req.params.id);
  const dataPag = req.body?.data || dataLocal(new Date());
  const forma = req.body?.formaPagamento || null;
  if (!dataValida(dataPag)) return res.status(400).json({ erro: 'Data do pagamento inválida' });
  if (dataPag > dataLocal(new Date())) return res.status(400).json({ erro: 'A data do pagamento não pode ser no futuro' });
  if (forma && !FORMAS_PAGAMENTO.includes(forma)) return res.status(400).json({ erro: 'Forma de pagamento inválida' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE despesas SET pago = true, pago_em = $1, data = $1, forma_pagamento = COALESCE($2, forma_pagamento)
       WHERE id = $3 AND pago = false`,
      [dataPag, forma, id]
    );
    if (!rowCount) return res.status(404).json({ erro: 'Conta a pagar não encontrada (ou já paga)' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const { rowCount } = await pool.query('DELETE FROM despesas WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ erro: 'Lançamento não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- anexos (foto/PDF da nota, cupom ou boleto) ----
router.get('/:id/anexos', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, mime, tamanho, criado_em AS "criadoEm" FROM despesas_anexos WHERE despesa_id = $1 ORDER BY id', [Number(req.params.id)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/anexos', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], limit: MAX_BYTES }), async (req, res, next) => {
  const id = Number(req.params.id);
  const mime = req.headers['content-type']?.split(';')[0];
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ErroDespesa(400, 'Envie a imagem (JPG, PNG, WEBP) ou PDF no corpo da requisição');
    if (!conteudoConfere(req.body, mime)) throw new ErroDespesa(400, 'O arquivo não parece ser do tipo informado');
    const d = await pool.query('SELECT 1 FROM despesas WHERE id = $1', [id]);
    if (!d.rowCount) throw new ErroDespesa(404, 'Lançamento não encontrado');
    const qtd = await pool.query('SELECT count(*)::int AS n FROM despesas_anexos WHERE despesa_id = $1', [id]);
    if (qtd.rows[0].n >= MAX_ANEXOS) throw new ErroDespesa(409, `Máximo de ${MAX_ANEXOS} anexos por lançamento`);
    const { rows } = await pool.query(
      'INSERT INTO despesas_anexos (despesa_id, mime, tamanho, conteudo, criado_por) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [id, mime, req.body.length, req.body, req.usuario.pessoaId]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err instanceof ErroDespesa) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

router.get('/anexo/:anexoId', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT mime, conteudo FROM despesas_anexos WHERE id = $1', [Number(req.params.anexoId)]);
    if (!rows[0]) return res.status(404).json({ erro: 'Anexo não encontrado' });
    res.setHeader('Content-Type', rows[0].mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // arquivo enviado por usuário: nunca roda script/estilo (defesa extra)
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(rows[0].conteudo);
  } catch (err) {
    next(err);
  }
});

router.delete('/anexo/:anexoId', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM despesas_anexos WHERE id = $1', [Number(req.params.anexoId)]);
    if (!rowCount) return res.status(404).json({ erro: 'Anexo não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
