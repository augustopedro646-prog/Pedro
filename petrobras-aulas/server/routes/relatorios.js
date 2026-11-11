const express = require('express');
const { pool } = require('../db');
const { exigirAuth } = require('../auth');

const router = express.Router();
router.use(exigirAuth);

// Valor fixo por hora citado na reunião. Fica aqui, não no banco, porque
// ainda não foi dito se isso muda por professor/modalidade — centralizado
// num lugar só pra ser fácil de achar quando precisar virar configurável.
const VALOR_HORA = 35;

function mesAtualYYYYMM() {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
}

// Soma as horas dadas no mês (uma chamada registrada = uma aula dada,
// duração = hora_fim - hora_inicio da turma) e já multiplica pelo valor
// fixo da hora. Professor só vê o próprio relatório; diretoria vê todo
// mundo ou filtra por professorId.
router.get('/horas', async (req, res, next) => {
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : mesAtualYYYYMM();
  const professorId = req.usuario.tipo === 'diretoria'
    ? (req.query.professorId ? Number(req.query.professorId) : null)
    : req.usuario.id;

  try {
    const params = [`${mes}-01`];
    let where = `date_trunc('month', c.data) = $1::date`;
    if (professorId) {
      params.push(professorId);
      where += ` AND c.professor_id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT c.professor_id AS "professorId", p.nome AS "professorNome",
              SUM(EXTRACT(EPOCH FROM (t.hora_fim - t.hora_inicio)) / 3600.0) AS horas,
              count(*) AS "aulasDadas"
       FROM chamadas c
       JOIN turmas t ON t.id = c.turma_id
       LEFT JOIN professores p ON p.id = c.professor_id
       WHERE ${where}
       GROUP BY c.professor_id, p.nome
       ORDER BY p.nome`,
      params
    );
    res.json({
      mes,
      valorHora: VALOR_HORA,
      professores: rows.map((r) => ({
        professorId: r.professorId,
        professorNome: r.professorNome,
        aulasDadas: Number(r.aulasDadas),
        horas: Number(r.horas),
        valor: Number(r.horas) * VALOR_HORA,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
