const express = require('express');
const { pool } = require('../db');
const { exigirAuth, exigirDiretoria } = require('../auth');

const router = express.Router();
// Lançar aula dada é coisa de diretoria — professor só enxerga (relatório
// de horas já cobre isso pra ele, não precisa listar aqui).
router.use(exigirAuth, exigirDiretoria);

// Lista os lançamentos de uma turma num mês — pra tela mostrar quais dias
// já foram marcados e evitar lançar duas vezes o mesmo dia.
router.get('/', async (req, res, next) => {
  const turmaId = Number(req.query.turmaId);
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : null;
  if (!turmaId) return res.status(400).json({ erro: 'turmaId obrigatório' });
  try {
    const params = [turmaId];
    let where = 'turma_id = $1';
    if (mes) {
      params.push(`${mes}-01`);
      where += ` AND date_trunc('month', data) = $${params.length}::date`;
    }
    const { rows } = await pool.query(
      `SELECT id, to_char(data, 'YYYY-MM-DD') AS data FROM aulas_registradas WHERE ${where} ORDER BY data DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Registra que a turma deu aula numa data — professor_id vem da turma
// (quem leciona ela na hora do lançamento), não é escolhido solto.
router.post('/', async (req, res, next) => {
  const turmaId = Number(req.body.turmaId);
  const data = req.body.data;
  if (!turmaId || !data) return res.status(400).json({ erro: 'turmaId e data são obrigatórios' });
  try {
    const { rows: turmaRows } = await pool.query('SELECT professor_id FROM turmas WHERE id = $1', [turmaId]);
    if (!turmaRows[0]) return res.status(404).json({ erro: 'Turma não encontrada' });

    const { rows } = await pool.query(
      `INSERT INTO aulas_registradas (turma_id, data, professor_id, registrado_por)
       VALUES ($1, $2, $3, $4) ON CONFLICT (turma_id, data) DO NOTHING RETURNING id`,
      [turmaId, data, turmaRows[0].professor_id, req.usuario.id]
    );
    if (!rows[0]) return res.status(409).json({ erro: 'Essa turma já tem aula lançada nessa data' });
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const { rowCount } = await pool.query('DELETE FROM aulas_registradas WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ erro: 'Lançamento não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
