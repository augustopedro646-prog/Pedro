const express = require('express');
const { pool } = require('../db');
const { exigirAuth } = require('../auth');
const tarefas = require('./tarefas');

// Bolinhas de contagem do menu lateral (como no PDV): só pendências de verdade,
// e só das abas que a pessoa pode ver. Falha aqui nunca derruba a tela: o
// cliente trata erro como "sem bolinha".
const router = express.Router();
router.use(exigirAuth);

const dataLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

router.get('/', async (req, res, next) => {
  try {
    const u = req.usuario;
    let abas;
    if (u.administrador) abas = new Set(['eventos', 'tarefas']);
    else abas = new Set((await pool.query('SELECT aba FROM permissoes WHERE cargo_id = $1 AND permitido', [u.cargoId])).rows.map((r) => r.aba));
    const out = {};

    if (abas.has('eventos')) {
      // pedidos ainda sem resposta (novo/negociando) com data de hoje em diante
      out.eventos = (await pool.query(
        `SELECT count(*)::int AS n FROM reservas WHERE status IN ('novo', 'negociando') AND data >= (now() AT TIME ZONE 'America/Fortaleza')::date`
      )).rows[0].n;
    }

    if (abas.has('tarefas')) {
      const hoje = dataLocal(new Date());
      const params = [];
      let where = 't.ativo = true';
      if (!u.administrador) { params.push(u.cargoId); where += ` AND t.cargo_id = $1`; }
      const { rows } = await pool.query(
        `SELECT t.id, t.frequencia, t.dias_semana, t.intervalo_dias, t.criado_em FROM tarefas t WHERE ${where}`, params
      );
      const doDia = rows.filter((t) => tarefas.aplicaNaData(t, new Date(`${hoje}T00:00:00`)));
      let feitas = 0;
      if (doDia.length) {
        feitas = (await pool.query('SELECT count(*)::int AS n FROM tarefas_concluidas WHERE tarefa_id = ANY($1) AND data = $2', [doDia.map((t) => t.id), hoje])).rows[0].n;
      }
      out.tarefas = Math.max(0, doDia.length - feitas);
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
