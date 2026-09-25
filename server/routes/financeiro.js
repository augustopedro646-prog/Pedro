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
         FROM ${tabela} WHERE unidade_id = $1 AND data BETWEEN $2 AND $3
         ORDER BY data DESC, criado_em DESC`,
        [req.usuario.unidadeId, inicio, fim]
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
        `INSERT INTO ${tabela} (unidade_id, data, descricao, categoria, forma_pagamento, valor, criado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [req.usuario.unidadeId, data, descricao.trim(), categoria || null, formaPagamento || null, valor, req.usuario.pessoaId]
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
         WHERE id = $6 AND unidade_id = $7`,
        [data, descricao.trim(), categoria || null, formaPagamento || null, valor, id, req.usuario.unidadeId]
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
      const { rowCount } = await pool.query(
        `DELETE FROM ${tabela} WHERE id = $1 AND unidade_id = $2`,
        [id, req.usuario.unidadeId]
      );
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

module.exports = router;
