const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { assinarToken, exigirAuth } = require('../auth');
const { sensivel } = require('../rateLimit');

const router = express.Router();

// Lista pública pro dropdown da tela de login (nome só, nunca o PIN).
router.get('/professores', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, nome FROM professores WHERE ativo = true ORDER BY nome'
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/login', sensivel, async (req, res, next) => {
  const { professorId, pin } = req.body || {};
  if (!professorId || !pin) return res.status(400).json({ erro: 'professorId e pin obrigatórios' });

  try {
    const { rows } = await pool.query(
      'SELECT id, nome, pin_hash, tipo, ativo FROM professores WHERE id = $1',
      [professorId]
    );
    const pessoa = rows[0];
    if (!pessoa || !pessoa.ativo) return res.status(401).json({ erro: 'PIN incorreto' });

    const ok = await bcrypt.compare(String(pin), pessoa.pin_hash);
    if (!ok) return res.status(401).json({ erro: 'PIN incorreto' });

    const token = assinarToken({ id: pessoa.id, nome: pessoa.nome, tipo: pessoa.tipo });
    res.json({ token, usuario: { id: pessoa.id, nome: pessoa.nome, tipo: pessoa.tipo } });
  } catch (err) {
    next(err);
  }
});

router.get('/me', exigirAuth, (req, res) => {
  res.json(req.usuario);
});

module.exports = router;
