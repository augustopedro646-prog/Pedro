const express = require('express');
const { pool } = require('../db');
const { exigirAuth, exigirAba, exigirPapel } = require('../auth');

const router = express.Router();
router.use(exigirAuth, exigirAba('tarefas'));

const ETAPAS = ['abertura', 'durante_dia', 'fechamento'];
const FREQUENCIAS = ['diaria', 'dias_semana', 'intervalo'];

function validarTarefa(body) {
  const { titulo, cargoId, etapa, frequencia, diasSemana, intervaloDias } = body || {};
  if (!String(titulo || '').trim()) return 'titulo obrigatório';
  if (!Number.isInteger(cargoId)) return 'cargoId obrigatório';
  if (!ETAPAS.includes(etapa)) return 'etapa inválida';
  if (!FREQUENCIAS.includes(frequencia)) return 'frequencia inválida';
  if (frequencia === 'dias_semana' && (!Array.isArray(diasSemana) || !diasSemana.length || diasSemana.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) {
    return 'diasSemana precisa ser uma lista de números de 0 (domingo) a 6 (sábado)';
  }
  if (frequencia === 'intervalo' && !(Number.isInteger(intervaloDias) && intervaloDias > 0)) {
    return 'intervaloDias precisa ser um número inteiro maior que zero';
  }
  return null;
}

// A tarefa se aplica a essa data? 'intervalo' conta a partir do dia em que
// foi criada (dia 0 já conta, por isso a tarefa já aparece assim que criada).
function aplicaNaData(tarefa, data) {
  if (tarefa.frequencia === 'diaria') return true;
  if (tarefa.frequencia === 'dias_semana') return (tarefa.dias_semana || []).includes(data.getDay());
  if (tarefa.frequencia === 'intervalo') {
    const criada = new Date(tarefa.criado_em);
    const diffDias = Math.floor((Date.UTC(data.getFullYear(), data.getMonth(), data.getDate()) -
      Date.UTC(criada.getFullYear(), criada.getMonth(), criada.getDate())) / 86400000);
    return diffDias >= 0 && diffDias % tarefa.intervalo_dias === 0;
  }
  return false;
}

// Lista as tarefas que se aplicam a uma data (hoje por padrão), já com o
// status de concluída naquele dia. Administrador vê de todos os cargos;
// os demais só do próprio cargo (mesma regra de "quem vê" do PDV Jabá).
router.get('/', async (req, res, next) => {
  const dataStr = req.query.data || new Date().toISOString().slice(0, 10);
  const data = new Date(`${dataStr}T00:00:00`);
  if (Number.isNaN(data.getTime())) return res.status(400).json({ erro: 'data inválida' });

  try {
    const params = [];
    let where = 'ativo = true';
    if (!req.usuario.administrador) {
      params.push(req.usuario.cargoId);
      where += ` AND cargo_id = $${params.length}`;
    }
    const { rows: tarefas } = await pool.query(
      `SELECT t.id, t.titulo, t.descricao, t.etapa, t.frequencia, t.dias_semana, t.intervalo_dias,
              t.criado_em, c.nome AS "cargoNome"
       FROM tarefas t JOIN cargos c ON c.id = t.cargo_id
       WHERE ${where} ORDER BY t.titulo`,
      params
    );

    const aplicaveis = tarefas.filter((t) => aplicaNaData(t, data));
    const ids = aplicaveis.map((t) => t.id);
    let concluidasPorId = new Map();
    if (ids.length) {
      const { rows: concluidas } = await pool.query(
        `SELECT tc.tarefa_id AS "tarefaId", p.nome AS "concluidoPor", tc.concluido_em AS "concluidoEm"
         FROM tarefas_concluidas tc JOIN pessoas p ON p.id = tc.concluido_por
         WHERE tc.tarefa_id = ANY($1) AND tc.data = $2`,
        [ids, dataStr]
      );
      concluidasPorId = new Map(concluidas.map((c) => [c.tarefaId, c]));
    }

    res.json(aplicaveis.map((t) => ({
      id: t.id,
      titulo: t.titulo,
      descricao: t.descricao,
      etapa: t.etapa,
      cargoNome: t.cargoNome,
      concluida: concluidasPorId.has(t.id),
      concluidoPor: concluidasPorId.get(t.id)?.concluidoPor || null,
    })));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/concluir', async (req, res, next) => {
  const id = Number(req.params.id);
  const dataStr = req.body?.data || new Date().toISOString().slice(0, 10);
  try {
    const { rows } = await pool.query('SELECT cargo_id AS "cargoId" FROM tarefas WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (!req.usuario.administrador && rows[0].cargoId !== req.usuario.cargoId) {
      return res.status(403).json({ erro: 'Essa tarefa não é do seu cargo' });
    }
    await pool.query(
      `INSERT INTO tarefas_concluidas (tarefa_id, data, concluido_por) VALUES ($1, $2, $3)
       ON CONFLICT (tarefa_id, data) DO UPDATE SET concluido_por = EXCLUDED.concluido_por, concluido_em = now()`,
      [id, dataStr, req.usuario.pessoaId]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/concluir', async (req, res, next) => {
  const id = Number(req.params.id);
  const dataStr = req.query.data || new Date().toISOString().slice(0, 10);
  try {
    const { rows } = await pool.query('SELECT cargo_id AS "cargoId" FROM tarefas WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (!req.usuario.administrador && rows[0].cargoId !== req.usuario.cargoId) {
      return res.status(403).json({ erro: 'Essa tarefa não é do seu cargo' });
    }
    await pool.query('DELETE FROM tarefas_concluidas WHERE tarefa_id = $1 AND data = $2', [id, dataStr]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Cadastro de tarefas — só Administrador (exigirPapel sem lista = só bypass admin).
router.get('/cadastro', exigirPapel(), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.titulo, t.descricao, t.cargo_id AS "cargoId", c.nome AS "cargoNome",
              t.etapa, t.frequencia, t.dias_semana AS "diasSemana", t.intervalo_dias AS "intervaloDias", t.ativo
       FROM tarefas t JOIN cargos c ON c.id = t.cargo_id
       ORDER BY t.ativo DESC, t.titulo`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', exigirPapel(), async (req, res, next) => {
  const erro = validarTarefa(req.body);
  if (erro) return res.status(400).json({ erro });
  const { titulo, descricao, cargoId, etapa, frequencia, diasSemana, intervaloDias } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO tarefas (titulo, descricao, cargo_id, etapa, frequencia, dias_semana, intervalo_dias)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [titulo.trim(), descricao || null, cargoId, etapa, frequencia,
       frequencia === 'dias_semana' ? diasSemana : null,
       frequencia === 'intervalo' ? intervaloDias : null]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', exigirPapel(), async (req, res, next) => {
  const id = Number(req.params.id);
  const erro = validarTarefa(req.body);
  if (erro) return res.status(400).json({ erro });
  const { titulo, descricao, cargoId, etapa, frequencia, diasSemana, intervaloDias, ativo } = req.body;
  try {
    const { rowCount } = await pool.query(
      `UPDATE tarefas SET titulo = $1, descricao = $2, cargo_id = $3, etapa = $4, frequencia = $5,
              dias_semana = $6, intervalo_dias = $7, ativo = $8
       WHERE id = $9`,
      [titulo.trim(), descricao || null, cargoId, etapa, frequencia,
       frequencia === 'dias_semana' ? diasSemana : null,
       frequencia === 'intervalo' ? intervaloDias : null,
       ativo !== false, id]
    );
    if (!rowCount) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', exigirPapel(), async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const { rowCount } = await pool.query('DELETE FROM tarefas WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.aplicaNaData = aplicaNaData; // usada pelo Início
module.exports = router;
