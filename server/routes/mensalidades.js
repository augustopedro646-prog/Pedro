const express = require('express');
const { pool } = require('../db');
const { exigirAuth, exigirAba, exigirPapel } = require('../auth');
const { ANO_INICIAL, CLUBE_FINANCEIRO } = require('../mensalidades');
const { recalcularStatusSocio, sobreporPagamentos } = require('../statusSocio');

// Baixa direta de mensalidade (recepção). SÓ sócios ATPN ativos — o CEPE
// cobra por conta própria e só aparece na aba Sócios.
const router = express.Router();
router.use(exigirAuth, exigirAba('mensalidades'));

const FORMAS = ['Dinheiro', 'Pix', 'Cartão de débito', 'Cartão de crédito', 'Boleto', 'Transferência'];
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

class ErroMens extends Error {
  constructor(status, mensagem, extra) { super(mensagem); this.status = status; this.extra = extra || {}; }
}

const dataLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Sócio ATPN que ainda pode pagar (ativo na planilha). Desligado não recebe baixa.
async function carregarSocioAtpn(db, id) {
  const { rows } = await db.query(
    `SELECT id, nome, matricula, categoria, status, telefone, origem_planilha
     FROM socios WHERE id = $1 AND clube = $2`, [id, CLUBE_FINANCEIRO]
  );
  const s = rows[0];
  if (!s) throw new ErroMens(404, 'Sócio ATPN não encontrado');
  if (s.origem_planilha !== 'ativo_geral' || s.status === 'desligado') throw new ErroMens(409, 'Esse sócio está desligado — não dá pra registrar mensalidade');
  return s;
}

// Busca por nome, matrícula, telefone ou CPF (só dígitos). Mínimo 2 caracteres.
router.get('/buscar', async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const digitos = q.replace(/\D/g, '');
    const params = [CLUBE_FINANCEIRO, `%${q}%`];
    let extra = '';
    if (digitos.length >= 4) {
      params.push(`%${digitos}%`);
      extra = ` OR regexp_replace(coalesce(s.telefone, ''), '\\D', '', 'g') LIKE $3 OR regexp_replace(coalesce(s.cpf, ''), '\\D', '', 'g') LIKE $3 OR s.matricula LIKE $3`;
    }
    const { rows } = await pool.query(
      `SELECT s.id, s.nome, s.matricula, s.categoria, s.status, s.telefone
       FROM socios s
       WHERE s.clube = $1 AND s.origem_planilha = 'ativo_geral' AND s.status <> 'desligado'
         AND (s.nome ILIKE $2 OR s.matricula ILIKE $2${extra})
       ORDER BY s.nome LIMIT 20`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Ficha de cobrança de um sócio: meses de 2026 (planilha + registrados) e pagamentos.
router.get('/socio/:id', async (req, res, next) => {
  try {
    const socio = await carregarSocioAtpn(pool, Number(req.params.id));
    const [mens, pags] = await Promise.all([
      pool.query('SELECT ano, mes, valor, observacao, em_aberto FROM socios_mensalidades WHERE socio_id = $1 AND ano >= $2 ORDER BY ano, mes', [socio.id, ANO_INICIAL]),
      pool.query(
        `SELECT p.id, p.ano, p.mes, p.valor, p.forma_pagamento AS "forma", to_char(p.data_pagamento, 'YYYY-MM-DD') AS "dataPagamento",
                p.observacao, p.criado_em AS "criadoEm", r.nome AS "registradoPor",
                p.cancelado_em AS "canceladoEm", p.motivo_cancelamento AS "motivoCancelamento"
         FROM mensalidade_pagamentos p LEFT JOIN pessoas r ON r.id = p.registrado_por
         WHERE p.socio_id = $1 ORDER BY p.data_pagamento DESC, p.id DESC`, [socio.id]
      ),
    ]);
    const planilha = new Map(mens.rows.map((m) => [m.ano * 12 + m.mes, { valor: m.valor === null ? null : Number(m.valor), observacao: m.observacao, emAberto: m.em_aberto }]));
    const pagos = new Map();
    pags.rows.filter((p) => !p.canceladoEm).forEach((p) => pagos.set(p.ano * 12 + p.mes, (pagos.get(p.ano * 12 + p.mes) || 0) + Number(p.valor)));

    const hoje = new Date();
    const fimMeses = hoje.getFullYear() * 12 + hoje.getMonth() + 2; // mês atual + 1 (adiantado)
    const meses = [];
    for (let k = ANO_INICIAL * 12 + 1; k <= fimMeses; k++) {
      const ano = Math.floor((k - 1) / 12);
      const mes = k - ano * 12;
      const pl = planilha.get(k);
      const reg = pagos.get(k) || 0;
      let situacao;
      let valor = null;
      if (pl && pl.valor > 0) { situacao = 'pago_planilha'; valor = pl.valor; }
      else if (reg > 0) { situacao = 'pago_atpn'; valor = reg; }
      else if (pl && (pl.emAberto || pl.valor === 0)) situacao = 'aberto'; // vermelho na planilha (inclui "Sem margem")
      else if (pl && pl.valor === null) situacao = 'especial';
      else situacao = 'sem_lancamento';
      meses.push({ ano, mes, situacao, valor, observacao: pl ? pl.observacao : null });
    }
    const ultimoPago = [...meses].reverse().find((m) => m.valor > 0);
    res.json({
      socio, meses, pagamentos: pags.rows, formas: FORMAS,
      valorSugerido: ultimoPago ? ultimoPago.valor : null,
    });
  } catch (err) {
    if (err instanceof ErroMens) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

function validarPagamento(b) {
  const x = b || {};
  const socioId = Number(x.socioId);
  const ano = Number(x.ano);
  const mes = Number(x.mes);
  if (!Number.isInteger(socioId)) throw new ErroMens(400, 'Sócio obrigatório');
  if (!Number.isInteger(ano) || !Number.isInteger(mes) || mes < 1 || mes > 12) throw new ErroMens(400, 'Mês de referência inválido');
  const hoje = new Date();
  const limite = hoje.getFullYear() * 12 + hoje.getMonth() + 1 + 2; // até 2 meses adiantado
  if (ano * 12 + mes < ANO_INICIAL * 12 + 1) throw new ErroMens(400, `Só dá pra registrar a partir de janeiro de ${ANO_INICIAL}`);
  if (ano * 12 + mes > limite) throw new ErroMens(400, 'Mês de referência muito adiantado (máximo 2 meses à frente)');
  const valor = Number(x.valor);
  if (!Number.isFinite(valor) || valor <= 0 || valor > 100000) throw new ErroMens(400, 'Valor inválido (maior que zero)');
  if (!FORMAS.includes(x.forma)) throw new ErroMens(400, 'Forma de pagamento inválida');
  const dataPag = String(x.dataPagamento || dataLocal(hoje));
  if (!DATA_RE.test(dataPag) || Number.isNaN(new Date(`${dataPag}T12:00:00`).getTime())) throw new ErroMens(400, 'Data do pagamento inválida');
  if (dataPag > dataLocal(hoje)) throw new ErroMens(400, 'A data do pagamento não pode ser no futuro');
  if (dataPag < `${ANO_INICIAL}-01-01`) throw new ErroMens(400, `Data do pagamento anterior a ${ANO_INICIAL}`);
  const observacao = String(x.observacao || '').trim();
  if (observacao.length > 300) throw new ErroMens(400, 'Observação muito longa (máximo 300 caracteres)');
  return { socioId, ano, mes, valor: Math.round(valor * 100) / 100, forma: x.forma, dataPagamento: dataPag, observacao: observacao || null };
}

router.post('/pagamentos', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const v = validarPagamento(req.body);
    await client.query('BEGIN');
    const socio = await carregarSocioAtpn(client, v.socioId);
    await client.query('SELECT id FROM socios WHERE id = $1 FOR UPDATE', [socio.id]); // serializa duas baixas do mesmo sócio

    const pl = (await client.query('SELECT valor FROM socios_mensalidades WHERE socio_id = $1 AND ano = $2 AND mes = $3', [socio.id, v.ano, v.mes])).rows[0];
    if (pl && Number(pl.valor) > 0) {
      throw new ErroMens(409, `A planilha já tem ${String(v.mes).padStart(2, '0')}/${v.ano} como pago (R$ ${Number(pl.valor).toFixed(2).replace('.', ',')}). Não registro de novo pra não contar o mesmo dinheiro duas vezes.`);
    }
    const ja = (await client.query(
      'SELECT coalesce(sum(valor), 0) AS t FROM mensalidade_pagamentos WHERE socio_id = $1 AND ano = $2 AND mes = $3 AND cancelado_em IS NULL', [socio.id, v.ano, v.mes]
    )).rows[0];
    if (Number(ja.t) > 0 && !req.body.confirmarParcial) {
      throw new ErroMens(409, `Esse mês já tem R$ ${Number(ja.t).toFixed(2).replace('.', ',')} registrado. Registrar outro pagamento soma ao mês (pagamento parcelado)?`, { precisaConfirmar: true });
    }

    const { rows } = await client.query(
      `INSERT INTO mensalidade_pagamentos (socio_id, ano, mes, valor, forma_pagamento, data_pagamento, observacao, registrado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [socio.id, v.ano, v.mes, v.valor, v.forma, v.dataPagamento, v.observacao, req.usuario.pessoaId]
    );
    const status = await recalcularStatusSocio(client, socio.id);
    await client.query('COMMIT');
    res.status(201).json({ id: rows[0].id, status: status ? status.status : socio.status });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ErroMens) return res.status(err.status).json({ erro: err.message, ...err.extra });
    next(err);
  } finally {
    client.release();
  }
});

// Estorno (só Administrador): nada é apagado, o pagamento fica marcado como cancelado.
router.post('/pagamentos/:id/estornar', exigirPapel(), async (req, res, next) => {
  const id = Number(req.params.id);
  const motivo = String(req.body?.motivo || '').trim();
  if (motivo.length < 3 || motivo.length > 300) return res.status(400).json({ erro: 'Informe o motivo do estorno (3 a 300 caracteres)' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = (await client.query('SELECT id, socio_id, cancelado_em FROM mensalidade_pagamentos WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!p) throw new ErroMens(404, 'Pagamento não encontrado');
    if (p.cancelado_em) throw new ErroMens(409, 'Esse pagamento já foi estornado');
    await client.query(
      'UPDATE mensalidade_pagamentos SET cancelado_em = now(), cancelado_por = $1, motivo_cancelamento = $2 WHERE id = $3',
      [req.usuario.pessoaId, motivo, id]
    );
    await recalcularStatusSocio(client, p.socio_id);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ErroMens) return res.status(err.status).json({ erro: err.message });
    next(err);
  } finally {
    client.release();
  }
});

// Dados do comprovante de um pagamento (impresso pela tela). Não é documento
// fiscal — o que a associação precisa emitir ainda depende da contadora.
router.get('/comprovante/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.ano, p.mes, p.valor::float8 AS valor, p.forma_pagamento AS forma,
              to_char(p.data_pagamento, 'YYYY-MM-DD') AS "dataPagamento", p.observacao, p.criado_em AS "criadoEm",
              p.cancelado_em AS "canceladoEm", s.nome AS "socioNome", s.matricula, r.nome AS "registradoPor"
       FROM mensalidade_pagamentos p JOIN socios s ON s.id = p.socio_id LEFT JOIN pessoas r ON r.id = p.registrado_por
       WHERE p.id = $1 AND s.clube = $2`,
      [Number(req.params.id), CLUBE_FINANCEIRO]
    );
    if (!rows[0]) return res.status(404).json({ erro: 'Pagamento não encontrado' });
    const cfg = (await pool.query(`SELECT valor FROM configuracoes WHERE chave = 'associacao'`)).rows[0];
    const v = cfg ? cfg.valor : {};
    res.json({
      ...rows[0],
      associacao: { nome: v.nome || 'ATPN — Associação dos Técnicos em Petróleo de Natal', telefone: v.telefone || '', endereco: v.endereco || '' },
    });
  } catch (err) {
    next(err);
  }
});

// Recebimentos de um dia (padrão hoje): lista + total por forma de pagamento.
router.get('/hoje', async (req, res, next) => {
  const data = DATA_RE.test(String(req.query.data || '')) ? req.query.data : dataLocal(new Date());
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.socio_id AS "socioId", s.nome AS "socioNome", p.ano, p.mes, p.valor::float8 AS valor, p.forma_pagamento AS forma,
              p.observacao, r.nome AS "registradoPor", p.criado_em AS "criadoEm",
              p.cancelado_em AS "canceladoEm", p.motivo_cancelamento AS "motivoCancelamento"
       FROM mensalidade_pagamentos p JOIN socios s ON s.id = p.socio_id LEFT JOIN pessoas r ON r.id = p.registrado_por
       WHERE p.data_pagamento = $1 ORDER BY p.criado_em DESC`, [data]
    );
    const validos = rows.filter((r) => !r.canceladoEm);
    const porForma = {};
    validos.forEach((r) => { porForma[r.forma] = (porForma[r.forma] || 0) + r.valor; });
    res.json({ data, pagamentos: rows, total: validos.reduce((s, r) => s + r.valor, 0), porForma });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
