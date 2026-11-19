const express = require('express');
const bcrypt = require('bcryptjs');
const { limparFalhaPin } = require('../rateLimit');
const { pool, registrarHistorico } = require('../db');
const { exigirAuth, exigirPapel } = require('../auth');
const { ABAS } = require('../abas');
const { ErroEquipe, atualizarPessoa, podarHistorico } = require('../equipe');
const { lerAssociacao, salvarAssociacao, ErroConfig, igual } = require('../associacao');

const router = express.Router();

// Retrato ordenado da matriz de permissões (pra comparar e pra histórico).
async function snapshotPermissoes(client) {
  const { rows } = await client.query('SELECT cargo_id AS "cargoId", aba, permitido FROM permissoes ORDER BY cargo_id, aba');
  return rows;
}

router.use(exigirAuth, exigirPapel()); // só Administrador passa (exigirPapel sem lista = só bypass admin)

// Matriz aba x cargo pra tela de Configurações > Permissões. Administrador
// não aparece: é sempre irrestrito.
router.get('/permissoes', async (req, res, next) => {
  try {
    const cargos = (await pool.query('SELECT id, nome FROM cargos WHERE administrador = false ORDER BY nome')).rows;
    const permitidas = (await pool.query('SELECT cargo_id, aba, permitido FROM permissoes')).rows;
    const mapa = new Map(permitidas.map((p) => [`${p.cargo_id}:${p.aba}`, p.permitido]));

    const matriz = cargos.map((cargo) => ({
      cargoId: cargo.id,
      cargoNome: cargo.nome,
      abas: ABAS.map((aba) => ({
        aba: aba.id,
        nome: aba.nome,
        permitido: mapa.get(`${cargo.id}:${aba.id}`) ?? false,
      })),
    }));

    res.json({ abas: ABAS, matriz });
  } catch (err) {
    next(err);
  }
});

// Body: [{ cargoId, aba, permitido }, ...] — upsert em lote.
router.put('/permissoes', async (req, res, next) => {
  const itens = Array.isArray(req.body.itens) ? req.body.itens : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const antes = await snapshotPermissoes(client);
    for (const { cargoId, aba, permitido } of itens) {
      await client.query(
        `INSERT INTO permissoes (cargo_id, aba, permitido) VALUES ($1, $2, $3)
         ON CONFLICT (cargo_id, aba) DO UPDATE SET permitido = EXCLUDED.permitido`,
        [cargoId, aba, !!permitido]
      );
    }
    // só vira "versão" se a matriz realmente mudou
    if (!igual(antes, await snapshotPermissoes(client))) {
      await registrarHistorico(client, { tabela: 'permissoes', registroId: 0, dadoAnterior: JSON.stringify(antes), alteradoPor: req.usuario.pessoaId });
      await podarHistorico(client, 'permissoes', 0);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.get('/cargos', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, nome, administrador FROM cargos ORDER BY nome');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/cargos', async (req, res, next) => {
  const nome = String(req.body.nome || '').trim();
  if (!nome) return res.status(400).json({ erro: 'nome obrigatório' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO cargos (nome) VALUES ($1) RETURNING id, nome, administrador',
      [nome]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'Cargo já existe' });
    next(err);
  }
});

// ---------- Dados da associação e horário (versionados) ----------
router.get('/associacao', async (req, res, next) => {
  try {
    res.json(await lerAssociacao(pool));
  } catch (err) {
    next(err);
  }
});

router.put('/associacao', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await salvarAssociacao(client, req.usuario, req.body);
    await client.query('COMMIT');
    res.json(await lerAssociacao(pool));
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ErroConfig) return res.status(400).json({ erro: err.message });
    next(err);
  } finally {
    client.release();
  }
});

// ---------- Equipe (pessoas, cargo, PIN) — só Administrador ----------
const PIN_RE = /^\d{4}$/;

router.get('/equipe', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.nome, p.ativo, p.cargo_id AS "cargoId", c.nome AS "cargoNome", c.administrador,
              (SELECT e.hora_inicio || COALESCE('–' || e.hora_fim, '') FROM escalas e WHERE e.pessoa_id = p.id AND e.reserva_id IS NULL AND e.data = (now() AT TIME ZONE 'America/Fortaleza')::date) AS "escalaHoje",
              (SELECT count(*)::int FROM escalas e WHERE e.pessoa_id = p.id AND e.data >= date_trunc('month', (now() AT TIME ZONE 'America/Fortaleza')::date) AND e.data < date_trunc('month', (now() AT TIME ZONE 'America/Fortaleza')::date) + interval '1 month') AS "escalasMes",
              (SELECT pt.tipo || ' ' || to_char(pt.registrado_em AT TIME ZONE 'America/Fortaleza', 'HH24:MI') FROM pontos pt WHERE pt.pessoa_id = p.id AND (pt.registrado_em AT TIME ZONE 'America/Fortaleza')::date = (now() AT TIME ZONE 'America/Fortaleza')::date ORDER BY pt.registrado_em DESC LIMIT 1) AS "pontoHoje"
       FROM pessoas p JOIN cargos c ON c.id = p.cargo_id
       ORDER BY p.ativo DESC, p.nome`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/equipe', async (req, res, next) => {
  const nome = String(req.body.nome || '').trim();
  const cargoId = Number(req.body.cargoId);
  const pin = String(req.body.pin || '');
  if (!nome || nome.length > 80) return res.status(400).json({ erro: 'Nome obrigatório (até 80 letras)' });
  if (!Number.isInteger(cargoId)) return res.status(400).json({ erro: 'Cargo obrigatório' });
  if (!PIN_RE.test(pin)) return res.status(400).json({ erro: 'O PIN precisa ter exatamente 4 números' });
  try {
    const cargo = await pool.query('SELECT 1 FROM cargos WHERE id = $1', [cargoId]);
    if (!cargo.rowCount) return res.status(400).json({ erro: 'Cargo não existe' });
    const pinHash = await bcrypt.hash(pin, 10);
    const { rows } = await pool.query(
      'INSERT INTO pessoas (nome, cargo_id, pin_hash) VALUES ($1, $2, $3) RETURNING id',
      [nome, cargoId, pinHash]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    next(err);
  }
});

// Nome, cargo e ativo/inativo (desativar em vez de apagar: o histórico de
// ponto e de tarefas continua apontando pra pessoa).
router.put('/equipe/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  const { nome, cargoId, ativo } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await atualizarPessoa(client, req.usuario, id, { nome, cargoId, ativo });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ErroEquipe) return res.status(err.status).json({ erro: err.message });
    next(err);
  } finally {
    client.release();
  }
});

// Trocar o PIN (também desbloqueia quem errou 5 vezes).
router.put('/equipe/:id/pin', async (req, res, next) => {
  const id = Number(req.params.id);
  const pin = String(req.body.pin || '');
  if (!PIN_RE.test(pin)) return res.status(400).json({ erro: 'O PIN precisa ter exatamente 4 números' });
  try {
    const pinHash = await bcrypt.hash(pin, 10);
    const { rowCount } = await pool.query('UPDATE pessoas SET pin_hash = $1 WHERE id = $2', [pinHash, id]);
    if (!rowCount) return res.status(404).json({ erro: 'Pessoa não encontrada' });
    limparFalhaPin(`login:${id}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
