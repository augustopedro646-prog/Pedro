const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { assinarToken, exigirAuth } = require('../auth');
const { sensivel, pinBloqueado, registrarFalhaPin, limparFalhaPin } = require('../rateLimit');
const { ABAS } = require('../abas');

const router = express.Router();

// Lista de cargos pro primeiro dropdown da tela de login. Pública (é
// antes de logar), não expõe nada além do nome.
router.get('/cargos', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, nome FROM cargos ORDER BY nome');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Pessoas de um cargo, pro segundo dropdown. Só abre quando a pessoa toca
// no campo (comportamento é do front-end) — aqui só filtra por cargo.
router.get('/pessoas', async (req, res, next) => {
  const cargoId = Number(req.query.cargoId);
  if (!cargoId) return res.status(400).json({ erro: 'cargoId obrigatório' });
  try {
    const { rows } = await pool.query(
      'SELECT id, nome FROM pessoas WHERE cargo_id = $1 AND ativo = true ORDER BY nome',
      [cargoId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/login', sensivel, async (req, res, next) => {
  const { pessoaId, pin } = req.body;
  if (!pessoaId || !pin) return res.status(400).json({ erro: 'pessoaId e pin obrigatórios' });

  const chaveFalha = `login:${String(pessoaId).slice(0, 80)}`;
  if (pinBloqueado(chaveFalha)) {
    return res.status(429).json({ erro: 'Muitas tentativas erradas — aguarde 15 minutos ou chame um administrador.' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.nome, p.pin_hash, p.ativo, c.id AS cargo_id, c.nome AS cargo_nome, c.administrador
       FROM pessoas p JOIN cargos c ON c.id = p.cargo_id
       WHERE p.id = $1`,
      [pessoaId]
    );
    const pessoa = rows[0];
    if (!pessoa || !pessoa.ativo) { registrarFalhaPin(chaveFalha); return res.status(401).json({ erro: 'PIN incorreto' }); }

    const ok = await bcrypt.compare(String(pin), pessoa.pin_hash);
    if (!ok) { registrarFalhaPin(chaveFalha); return res.status(401).json({ erro: 'PIN incorreto' }); }
    limparFalhaPin(chaveFalha);

    res.json(finalizarLogin(pessoa));
  } catch (err) {
    next(err);
  }
});

function finalizarLogin(pessoa) {
  const token = assinarToken({
    pessoaId: pessoa.id,
    nome: pessoa.nome,
    cargoId: pessoa.cargo_id,
    cargoNome: pessoa.cargo_nome,
    administrador: pessoa.administrador,
  });
  return {
    token,
    usuario: {
      nome: pessoa.nome,
      cargoNome: pessoa.cargo_nome,
      administrador: pessoa.administrador,
    },
  };
}

router.get('/me', exigirAuth, (req, res) => {
  res.json(req.usuario);
});

// Abas que a pessoa logada enxerga no menu lateral, na ordem fixa de config
// (nunca na ordem em que o cargo foi salvo).
router.get('/me/abas', exigirAuth, async (req, res, next) => {
  if (req.usuario.administrador) return res.json(ABAS);
  try {
    const { rows } = await pool.query(
      'SELECT aba FROM permissoes WHERE cargo_id = $1 AND permitido = true',
      [req.usuario.cargoId]
    );
    const liberadas = new Set(rows.map((r) => r.aba));
    res.json(ABAS.filter((a) => liberadas.has(a.id)));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
