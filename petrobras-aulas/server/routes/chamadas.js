const express = require('express');
const { pool } = require('../db');
const { exigirAuth } = require('../auth');

const router = express.Router();
router.use(exigirAuth);

async function confereDonoDaTurma(req, res, turmaId) {
  if (req.usuario.tipo === 'diretoria') return true;
  const { rows } = await pool.query('SELECT professor_id FROM turmas WHERE id = $1', [turmaId]);
  if (!rows[0] || rows[0].professor_id !== req.usuario.id) {
    res.status(403).json({ erro: 'Essa turma não é sua' });
    return false;
  }
  return true;
}

// Carrega a chamada de uma turma numa data: lista todo mundo matriculado
// (vínculo ativo) com a presença já marcada, se a chamada daquele dia já
// existir — senão volta presente=true por padrão (chute mais comum,
// o professor desmarca quem faltou em vez de marcar todo mundo).
router.get('/', async (req, res, next) => {
  const turmaId = Number(req.query.turmaId);
  const data = req.query.data;
  if (!turmaId || !data) return res.status(400).json({ erro: 'turmaId e data obrigatórios' });
  try {
    if (!(await confereDonoDaTurma(req, res, turmaId))) return;

    const { rows: chamadaRows } = await pool.query(
      'SELECT id FROM chamadas WHERE turma_id = $1 AND data = $2',
      [turmaId, data]
    );
    const chamadaId = chamadaRows[0]?.id || null;

    const { rows: alunos } = await pool.query(
      `SELECT a.id, a.nome, a.matricula,
              COALESCE(cp.presente, true) AS presente
       FROM aluno_turmas at2
       JOIN alunos a ON a.id = at2.aluno_id
       LEFT JOIN chamada_presencas cp ON cp.chamada_id = $1 AND cp.aluno_id = a.id
       WHERE at2.turma_id = $2 AND at2.ate IS NULL
       ORDER BY a.nome`,
      [chamadaId, turmaId]
    );
    res.json({ chamadaId, alunos });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const { turmaId, data, presencas } = req.body || {};
  if (!turmaId || !data || !Array.isArray(presencas)) {
    return res.status(400).json({ erro: 'turmaId, data e presencas são obrigatórios' });
  }
  try {
    if (!(await confereDonoDaTurma(req, res, turmaId))) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO chamadas (turma_id, data, professor_id) VALUES ($1, $2, $3)
         ON CONFLICT (turma_id, data) DO UPDATE SET turma_id = EXCLUDED.turma_id
         RETURNING id`,
        [turmaId, data, req.usuario.tipo === 'diretoria' ? (req.body.professorId || null) : req.usuario.id]
      );
      const chamadaId = rows[0].id;

      for (const { alunoId, presente } of presencas) {
        await client.query(
          `INSERT INTO chamada_presencas (chamada_id, aluno_id, presente) VALUES ($1, $2, $3)
           ON CONFLICT (chamada_id, aluno_id) DO UPDATE SET presente = EXCLUDED.presente`,
          [chamadaId, alunoId, !!presente]
        );
      }
      await client.query('COMMIT');
      res.status(201).json({ ok: true, chamadaId });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
