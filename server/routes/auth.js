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

// Unidades que a pessoa acessa — administrador vê todas, os demais só as
// que o cargo liga via pessoa_unidades. Usado no login, em /me (pra saber
// se mostra "Trocar de unidade") e na própria troca.
async function unidadesAcessiveis(pessoaId, administrador) {
  if (administrador) return (await pool.query('SELECT id, nome FROM unidades ORDER BY nome')).rows;
  const { rows } = await pool.query(
    `SELECT u.id, u.nome FROM unidades u
     JOIN pessoa_unidades pu ON pu.unidade_id = u.id
     WHERE pu.pessoa_id = $1 ORDER BY u.nome`,
    [pessoaId]
  );
  return rows;
}

router.post('/login', sensivel, async (req, res, next) => {
  const { pessoaId, pin, unidadeId } = req.body;
  if (!pessoaId || !pin) return res.status(400).json({ erro: 'pessoaId e pin obrigatórios' });

  // Bloqueio vale pra pessoa, não por unidade/IP — ver comentário em rateLimit.js.
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

    const unidades = await unidadesAcessiveis(pessoaId, pessoa.administrador);

    if (!unidadeId) {
      if (unidades.length === 1) {
        return res.json(await finalizarLogin(pessoa, unidades[0].id, unidades));
      }
      // Mais de uma unidade (ou zero): pede pra escolher antes de emitir token.
      return res.json({ precisaUnidade: true, unidades });
    }

    const unidadeValida = unidades.some((u) => u.id === Number(unidadeId));
    if (!unidadeValida) return res.status(403).json({ erro: 'Sem acesso a essa unidade' });

    res.json(await finalizarLogin(pessoa, Number(unidadeId), unidades));
  } catch (err) {
    next(err);
  }
});

// `unidades`, quando já calculada por quem chamou (login, troca de unidade),
// evita repetir a consulta — passar null força buscar de novo (usado em /me).
async function finalizarLogin(pessoa, unidadeId, unidades = null) {
  const token = assinarToken({
    pessoaId: pessoa.id,
    nome: pessoa.nome,
    cargoId: pessoa.cargo_id,
    cargoNome: pessoa.cargo_nome,
    administrador: pessoa.administrador,
    unidadeId,
  });
  return {
    token,
    usuario: {
      nome: pessoa.nome,
      cargoNome: pessoa.cargo_nome,
      administrador: pessoa.administrador,
      unidadeId,
      // Lista completa (não só a atual) pra sidebar oferecer "Trocar de
      // unidade" quando a pessoa acessa mais de uma.
      unidades: unidades || (await unidadesAcessiveis(pessoa.id, pessoa.administrador)),
    },
  };
}

router.get('/me', exigirAuth, async (req, res, next) => {
  try {
    const unidades = await unidadesAcessiveis(req.usuario.pessoaId, req.usuario.administrador);
    res.json({ ...req.usuario, unidades });
  } catch (err) {
    next(err);
  }
});

// Reemite o token pra outra unidade sem pedir PIN de novo (a pessoa já
// está autenticada) — confere de novo no servidor que ela realmente
// acessa aquela unidade antes de trocar.
router.post('/trocar-unidade', exigirAuth, async (req, res, next) => {
  const unidadeId = Number(req.body.unidadeId);
  if (!unidadeId) return res.status(400).json({ erro: 'unidadeId obrigatório' });
  try {
    const unidades = await unidadesAcessiveis(req.usuario.pessoaId, req.usuario.administrador);
    if (!unidades.some((u) => u.id === unidadeId)) return res.status(403).json({ erro: 'Sem acesso a essa unidade' });

    const { rows } = await pool.query(
      `SELECT p.id, p.nome, c.id AS cargo_id, c.nome AS cargo_nome, c.administrador
       FROM pessoas p JOIN cargos c ON c.id = p.cargo_id
       WHERE p.id = $1 AND p.ativo = true`,
      [req.usuario.pessoaId]
    );
    if (!rows[0]) return res.status(401).json({ erro: 'Conta inválida' });

    res.json(await finalizarLogin(rows[0], unidadeId, unidades));
  } catch (err) {
    next(err);
  }
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
