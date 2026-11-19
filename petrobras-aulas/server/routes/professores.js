const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { exigirAuth, exigirDiretoria } = require('../auth');

const router = express.Router();
// Cadastro de quem acessa o sistema é coisa de diretoria. A lista pública
// pro dropdown de login mora em /api/auth/professores (só id+nome).
router.use(exigirAuth, exigirDiretoria);

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, nome, tipo, empresa, ativo FROM professores ORDER BY nome'
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const nome = String(req.body.nome || '').trim();
  const tipo = req.body.tipo;
  const empresa = req.body.empresa ? String(req.body.empresa).trim() : null;
  const pin = String(req.body.pin || '');
  if (!nome) return res.status(400).json({ erro: 'nome obrigatório' });
  if (!['professor', 'diretoria'].includes(tipo)) return res.status(400).json({ erro: 'tipo precisa ser "professor" ou "diretoria"' });
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ erro: 'pin precisa ter 4 dígitos' });
  try {
    const pinHash = await bcrypt.hash(pin, 10);
    const { rows } = await pool.query(
      'INSERT INTO professores (nome, pin_hash, tipo, empresa) VALUES ($1, $2, $3, $4) RETURNING id',
      [nome, pinHash, tipo, empresa]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    next(err);
  }
});

// Edita cadastro; PIN só muda se vier preenchido (não obriga redigitar
// toda vez que só quer trocar o nome/empresa/ativo).
router.put('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  const nome = String(req.body.nome || '').trim();
  const tipo = req.body.tipo;
  const empresa = req.body.empresa ? String(req.body.empresa).trim() : null;
  const ativo = req.body.ativo !== false;
  const pin = req.body.pin ? String(req.body.pin) : null;
  if (!nome) return res.status(400).json({ erro: 'nome obrigatório' });
  if (!['professor', 'diretoria'].includes(tipo)) return res.status(400).json({ erro: 'tipo precisa ser "professor" ou "diretoria"' });
  if (pin && !/^\d{4}$/.test(pin)) return res.status(400).json({ erro: 'pin precisa ter 4 dígitos' });
  try {
    if (pin) {
      const pinHash = await bcrypt.hash(pin, 10);
      await pool.query(
        'UPDATE professores SET nome = $1, tipo = $2, empresa = $3, ativo = $4, pin_hash = $5 WHERE id = $6',
        [nome, tipo, empresa, ativo, pinHash, id]
      );
    } else {
      await pool.query(
        'UPDATE professores SET nome = $1, tipo = $2, empresa = $3, ativo = $4 WHERE id = $5',
        [nome, tipo, empresa, ativo, id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
