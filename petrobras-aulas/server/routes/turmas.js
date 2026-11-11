const express = require('express');
const { pool } = require('../db');
const { exigirAuth, exigirDiretoria } = require('../auth');

const router = express.Router();
router.use(exigirAuth);

const DIAS_VALIDOS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];

function validarTurma(body) {
  const { sigla, modalidadeId, horaInicio, horaFim, vagas, dias } = body || {};
  if (!String(sigla || '').trim()) return 'sigla obrigatória';
  if (!modalidadeId) return 'modalidadeId obrigatório';
  if (!/^\d{2}:\d{2}$/.test(horaInicio || '') || !/^\d{2}:\d{2}$/.test(horaFim || '')) {
    return 'horaInicio e horaFim precisam ser "HH:MM"';
  }
  if (horaFim <= horaInicio) return 'horaFim precisa ser depois de horaInicio';
  if (!Number.isInteger(vagas) || vagas < 0) return 'vagas precisa ser um número inteiro >= 0';
  if (!Array.isArray(dias) || dias.some((d) => !DIAS_VALIDOS.includes(d))) {
    return `dias precisa ser uma lista com: ${DIAS_VALIDOS.join(', ')}`;
  }
  return null;
}

// Diretoria vê todas (com filtro opcional por professor/modalidade);
// professor só enxerga as turmas que são dele — nunca confiar em
// professorId que o cliente mande solto na query.
router.get('/', async (req, res, next) => {
  const params = [];
  let where = '1=1';
  if (req.usuario.tipo === 'diretoria') {
    if (req.query.professorId) {
      params.push(Number(req.query.professorId));
      where += ` AND t.professor_id = $${params.length}`;
    }
    if (req.query.modalidadeId) {
      params.push(Number(req.query.modalidadeId));
      where += ` AND t.modalidade_id = $${params.length}`;
    }
  } else {
    params.push(req.usuario.id);
    where += ` AND t.professor_id = $${params.length}`;
  }
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.sigla, t.modalidade_id AS "modalidadeId",
              m.nome AS "modalidadeNome", m.nivel AS "modalidadeNivel",
              t.professor_id AS "professorId", p.nome AS "professorNome",
              t.dias, to_char(t.hora_inicio, 'HH24:MI') AS "horaInicio",
              to_char(t.hora_fim, 'HH24:MI') AS "horaFim",
              t.vagas, t.cor, t.ativo,
              (SELECT count(*) FROM aluno_turmas at2 WHERE at2.turma_id = t.id AND at2.ate IS NULL) AS "vagasOcupadas"
       FROM turmas t
       JOIN modalidades m ON m.id = t.modalidade_id
       LEFT JOIN professores p ON p.id = t.professor_id
       WHERE ${where}
       ORDER BY t.sigla`,
      params
    );
    res.json(rows.map((r) => ({ ...r, vagasRestantes: r.vagas - Number(r.vagasOcupadas) })));
  } catch (err) {
    next(err);
  }
});

// Alunos atualmente matriculados numa turma — professor só da própria.
router.get('/:id/alunos', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    if (req.usuario.tipo !== 'diretoria') {
      const { rows: dono } = await pool.query('SELECT professor_id FROM turmas WHERE id = $1', [id]);
      if (!dono[0] || dono[0].professor_id !== req.usuario.id) {
        return res.status(403).json({ erro: 'Essa turma não é sua' });
      }
    }
    const { rows } = await pool.query(
      `SELECT a.id, a.nome, a.matricula, a.situacao, to_char(at2.desde, 'YYYY-MM-DD') AS desde
       FROM aluno_turmas at2
       JOIN alunos a ON a.id = at2.aluno_id
       WHERE at2.turma_id = $1 AND at2.ate IS NULL
       ORDER BY a.nome`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', exigirDiretoria, async (req, res, next) => {
  const erro = validarTurma(req.body);
  if (erro) return res.status(400).json({ erro });
  const { sigla, modalidadeId, professorId, dias, horaInicio, horaFim, vagas, cor } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO turmas (sigla, modalidade_id, professor_id, dias, hora_inicio, hora_fim, vagas, cor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [sigla.trim(), modalidadeId, professorId || null, dias, horaInicio, horaFim, vagas, cor || null]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'Já existe uma turma com essa sigla' });
    next(err);
  }
});

router.put('/:id', exigirDiretoria, async (req, res, next) => {
  const id = Number(req.params.id);
  const erro = validarTurma(req.body);
  if (erro) return res.status(400).json({ erro });
  const { sigla, modalidadeId, professorId, dias, horaInicio, horaFim, vagas, cor, ativo } = req.body;
  try {
    const { rowCount } = await pool.query(
      `UPDATE turmas SET sigla = $1, modalidade_id = $2, professor_id = $3, dias = $4,
              hora_inicio = $5, hora_fim = $6, vagas = $7, cor = $8, ativo = $9
       WHERE id = $10`,
      [sigla.trim(), modalidadeId, professorId || null, dias, horaInicio, horaFim, vagas, cor || null, ativo !== false, id]
    );
    if (!rowCount) return res.status(404).json({ erro: 'Turma não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'Já existe uma turma com essa sigla' });
    next(err);
  }
});

module.exports = router;
