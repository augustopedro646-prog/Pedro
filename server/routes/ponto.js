const express = require('express');
const { pool } = require('../db');
const { exigirAuth, exigirAba, exigirPapel } = require('../auth');

const router = express.Router();
router.use(exigirAuth, exigirAba('ponto'));

// Bate o próprio ponto — tipo alterna com o último registro da pessoa
// nessa unidade (não depende de "que dia é hoje" pro fuso do servidor).
router.post('/', async (req, res, next) => {
  try {
    const { rows: ultimo } = await pool.query(
      'SELECT tipo FROM pontos WHERE unidade_id = $1 AND pessoa_id = $2 ORDER BY registrado_em DESC LIMIT 1',
      [req.usuario.unidadeId, req.usuario.pessoaId]
    );
    const tipo = ultimo[0]?.tipo === 'entrada' ? 'saida' : 'entrada';
    const { rows } = await pool.query(
      `INSERT INTO pontos (unidade_id, pessoa_id, tipo) VALUES ($1, $2, $3)
       RETURNING id, tipo, registrado_em AS "registradoEm"`,
      [req.usuario.unidadeId, req.usuario.pessoaId, tipo]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Lista pontos da unidade. Administrador vê qualquer pessoa (ou filtra por
// pessoaId); os demais só o próprio histórico, mesmo que peçam outro id.
router.get('/', async (req, res, next) => {
  const trintaDiasAtras = () => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  };
  const inicio = req.query.inicio || trintaDiasAtras();
  const fim = req.query.fim || new Date().toISOString().slice(0, 10);
  const pessoaId = req.usuario.administrador
    ? (req.query.pessoaId ? Number(req.query.pessoaId) : null)
    : req.usuario.pessoaId;

  try {
    const params = [req.usuario.unidadeId, inicio, fim];
    let where = 'p.unidade_id = $1 AND p.registrado_em::date BETWEEN $2 AND $3';
    if (pessoaId) {
      params.push(pessoaId);
      where += ` AND p.pessoa_id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT p.id, p.pessoa_id AS "pessoaId", pe.nome AS "pessoaNome", p.tipo,
              p.registrado_em AS "registradoEm", p.corrigido_por AS "corrigidoPor"
       FROM pontos p JOIN pessoas pe ON pe.id = p.pessoa_id
       WHERE ${where} ORDER BY p.registrado_em ASC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Corrige um ponto — só Administrador (exigirPapel sem lista = só bypass admin).
router.put('/:id', exigirPapel(), async (req, res, next) => {
  const id = Number(req.params.id);
  const { tipo, registradoEm } = req.body || {};
  if (tipo !== 'entrada' && tipo !== 'saida') {
    return res.status(400).json({ erro: 'tipo precisa ser "entrada" ou "saida"' });
  }
  if (!registradoEm) return res.status(400).json({ erro: 'registradoEm obrigatório' });
  try {
    const { rows } = await pool.query(
      `UPDATE pontos SET tipo = $1, registrado_em = $2, corrigido_por = $3, corrigido_em = now()
       WHERE id = $4 AND unidade_id = $5 RETURNING id`,
      [tipo, registradoEm, req.usuario.pessoaId, id, req.usuario.unidadeId]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Ponto não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', exigirPapel(), async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM pontos WHERE id = $1 AND unidade_id = $2',
      [id, req.usuario.unidadeId]
    );
    if (!rowCount) return res.status(404).json({ erro: 'Ponto não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
