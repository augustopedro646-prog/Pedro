const express = require('express');
const { pool } = require('../db');
const { exigirAuth, exigirDiretoria } = require('../auth');

const router = express.Router();
router.use(exigirAuth);

// Todo mundo autenticado pode ver a lista (precisa pra montar o formulário
// de turma e pros filtros de chamada) — só diretoria cria/edita.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, nome, nivel FROM modalidades ORDER BY nome, nivel');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', exigirDiretoria, async (req, res, next) => {
  const nome = String(req.body.nome || '').trim();
  const nivel = req.body.nivel ? String(req.body.nivel).trim() : null;
  if (!nome) return res.status(400).json({ erro: 'nome obrigatório' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO modalidades (nome, nivel) VALUES ($1, $2) RETURNING id, nome, nivel',
      [nome, nivel]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'Modalidade já existe com esse nível' });
    next(err);
  }
});

module.exports = router;
