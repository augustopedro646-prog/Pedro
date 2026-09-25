const express = require('express');
const { pool, registrarHistorico } = require('../db');
const { exigirAuth, exigirPapel } = require('../auth');
const { ABAS } = require('../abas');

const router = express.Router();

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
    for (const { cargoId, aba, permitido } of itens) {
      await client.query(
        `INSERT INTO permissoes (cargo_id, aba, permitido) VALUES ($1, $2, $3)
         ON CONFLICT (cargo_id, aba) DO UPDATE SET permitido = EXCLUDED.permitido`,
        [cargoId, aba, !!permitido]
      );
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

router.get('/unidades', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, nome, cnpj, contato FROM unidades ORDER BY nome');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/unidades', async (req, res, next) => {
  const { nome, cnpj, contato } = req.body;
  if (!nome) return res.status(400).json({ erro: 'nome obrigatório' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO unidades (nome, cnpj, contato) VALUES ($1, $2, $3) RETURNING id, nome, cnpj, contato',
      [nome, cnpj || null, contato || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'Unidade já existe' });
    next(err);
  }
});

router.put('/unidades/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  const { nome, cnpj, contato } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const atual = (await client.query('SELECT * FROM unidades WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!atual) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Unidade não encontrada' });
    }
    await registrarHistorico(client, {
      tabela: 'unidades',
      registroId: id,
      dadoAnterior: atual,
      alteradoPor: req.usuario.pessoaId,
    });
    const { rows } = await client.query(
      'UPDATE unidades SET nome = $1, cnpj = $2, contato = $3 WHERE id = $4 RETURNING id, nome, cnpj, contato',
      [nome ?? atual.nome, cnpj ?? atual.cnpj, contato ?? atual.contato, id]
    );
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
