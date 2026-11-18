const express = require('express');
const { pool } = require('../db');
const { exigirAuth, exigirAba } = require('../auth');

const router = express.Router();
router.use(exigirAuth, exigirAba('fluxo_caixa'));

const FORMAS_PAGAMENTO = ['Dinheiro', 'Cartão de crédito', 'Cartão de débito', 'Pix', 'Boleto', 'Transferência'];

function intervaloMesAtual() {
  const hoje = new Date();
  const inicio = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  const fim = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);
  return { inicio: inicio.toISOString().slice(0, 10), fim: fim.toISOString().slice(0, 10) };
}

// Despesas e receitas têm o mesmo formato de lançamento manual (só muda a
// tabela) — "receita" ainda não tem fonte estruturada porque depende do
// modelo de Sócio/mensalidade, a confirmar com o Pedro depois da visita.
function criarRotasLancamento(tabela) {
  const sub = express.Router();

  sub.get('/', async (req, res, next) => {
    const padrao = intervaloMesAtual();
    const inicio = req.query.inicio || padrao.inicio;
    const fim = req.query.fim || padrao.fim;
    try {
      const { rows } = await pool.query(
        `SELECT id, to_char(data, 'YYYY-MM-DD') AS data, descricao, categoria,
                forma_pagamento AS "formaPagamento", valor, criado_por AS "criadoPor",
                criado_em AS "criadoEm"
         FROM ${tabela} WHERE data BETWEEN $1 AND $2
         ORDER BY data DESC, criado_em DESC`,
        [inicio, fim]
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  sub.post('/', async (req, res, next) => {
    const { data, descricao, categoria, valor, formaPagamento } = req.body || {};
    if (!data || !String(descricao || '').trim() || !Number.isFinite(valor) || valor <= 0) {
      return res.status(400).json({ erro: 'Campos "data", "descricao" e "valor" (maior que zero) são obrigatórios' });
    }
    if (formaPagamento && !FORMAS_PAGAMENTO.includes(formaPagamento)) {
      return res.status(400).json({ erro: 'Forma de pagamento inválida' });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO ${tabela} (data, descricao, categoria, forma_pagamento, valor, criado_por)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [data, descricao.trim(), categoria || null, formaPagamento || null, valor, req.usuario.pessoaId]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      next(err);
    }
  });

  sub.put('/:id', async (req, res, next) => {
    const id = Number(req.params.id);
    const { data, descricao, categoria, valor, formaPagamento } = req.body || {};
    if (!data || !String(descricao || '').trim() || !Number.isFinite(valor) || valor <= 0) {
      return res.status(400).json({ erro: 'Campos "data", "descricao" e "valor" (maior que zero) são obrigatórios' });
    }
    if (formaPagamento && !FORMAS_PAGAMENTO.includes(formaPagamento)) {
      return res.status(400).json({ erro: 'Forma de pagamento inválida' });
    }
    try {
      const { rowCount } = await pool.query(
        `UPDATE ${tabela} SET data = $1, descricao = $2, categoria = $3, forma_pagamento = $4, valor = $5
         WHERE id = $6`,
        [data, descricao.trim(), categoria || null, formaPagamento || null, valor, id]
      );
      if (!rowCount) return res.status(404).json({ erro: 'Lançamento não encontrado' });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  sub.delete('/:id', async (req, res, next) => {
    const id = Number(req.params.id);
    try {
      const { rowCount } = await pool.query(`DELETE FROM ${tabela} WHERE id = $1`, [id]);
      if (!rowCount) return res.status(404).json({ erro: 'Lançamento não encontrado' });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return sub;
}

router.use('/despesas', criarRotasLancamento('despesas'));
router.use('/receitas', criarRotasLancamento('receitas'));

// Totais, detalhamento por categoria e tendência dos últimos meses, pra
// alimentar os cartões e gráficos da tela — tudo calculado no banco (soma
// de milhares de lançamentos no navegador seria lento e duplicaria a regra).
async function totalPorCategoria(tabela, inicio, fim) {
  const { rows } = await pool.query(
    `SELECT COALESCE(categoria, 'Sem categoria') AS categoria, SUM(valor) AS total
     FROM ${tabela} WHERE data BETWEEN $1 AND $2
     GROUP BY categoria ORDER BY total DESC`,
    [inicio, fim]
  );
  return rows.map((r) => ({ categoria: r.categoria, total: Number(r.total) }));
}

async function tendenciaMensal(fimRef, nMeses) {
  const fimDate = new Date(fimRef);
  const anoFim = fimDate.getFullYear();
  const mesFim = fimDate.getMonth();
  const inicioTendencia = new Date(anoFim, mesFim - (nMeses - 1), 1).toISOString().slice(0, 10);
  const fimTendencia = new Date(anoFim, mesFim + 1, 0).toISOString().slice(0, 10);

  const porMes = (tabela) => pool.query(
    `SELECT to_char(data, 'YYYY-MM') AS mes, SUM(valor) AS total
     FROM ${tabela} WHERE data BETWEEN $1 AND $2
     GROUP BY mes`,
    [inicioTendencia, fimTendencia]
  );
  const [despesas, receitas] = await Promise.all([porMes('despesas'), porMes('receitas')]);
  const mapaDespesas = new Map(despesas.rows.map((r) => [r.mes, Number(r.total)]));
  const mapaReceitas = new Map(receitas.rows.map((r) => [r.mes, Number(r.total)]));

  const lista = [];
  for (let i = nMeses - 1; i >= 0; i--) {
    const d = new Date(anoFim, mesFim - i, 1);
    const chave = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    lista.push({ mes: chave, despesas: mapaDespesas.get(chave) || 0, receitas: mapaReceitas.get(chave) || 0 });
  }
  return lista;
}

router.get('/resumo', async (req, res, next) => {
  const padrao = intervaloMesAtual();
  const inicio = req.query.inicio || padrao.inicio;
  const fim = req.query.fim || padrao.fim;
  const meses = Math.min(Math.max(Number(req.query.meses) || 6, 2), 12);
  try {
    const [categoriasDespesas, categoriasReceitas, tendencia] = await Promise.all([
      totalPorCategoria('despesas', inicio, fim),
      totalPorCategoria('receitas', inicio, fim),
      tendenciaMensal(fim, meses),
    ]);
    const totalDespesas = categoriasDespesas.reduce((soma, c) => soma + c.total, 0);
    const totalReceitas = categoriasReceitas.reduce((soma, c) => soma + c.total, 0);
    res.json({ totalDespesas, totalReceitas, categoriasDespesas, categoriasReceitas, tendencia });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
