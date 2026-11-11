const express = require('express');
const { pool } = require('../db');
const { exigirAuth, exigirDiretoria } = require('../auth');

const router = express.Router();
// Cadastro/situação de aluno é coisa de diretoria — professor só vê os
// alunos da própria turma (rota /api/turmas/:id/alunos cobre isso).
router.use(exigirAuth, exigirDiretoria);

router.get('/', async (req, res, next) => {
  const busca = String(req.query.busca || '').trim();
  const params = [];
  let where = '1=1';
  if (busca) {
    params.push(`%${busca}%`);
    where += ` AND (nome ILIKE $${params.length} OR matricula ILIKE $${params.length})`;
  }
  if (req.query.situacao) {
    params.push(req.query.situacao);
    where += ` AND situacao = $${params.length}`;
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, nome, matricula, situacao FROM alunos WHERE ${where} ORDER BY nome LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Turmas em que o aluno está matriculado agora (histórico de troca não
// aparece aqui, só o vínculo vigente — "ate IS NULL").
router.get('/:id/turmas', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.sigla, m.nome AS "modalidadeNome", m.nivel AS "modalidadeNivel", to_char(at2.desde, 'YYYY-MM-DD') AS desde
       FROM aluno_turmas at2
       JOIN turmas t ON t.id = at2.turma_id
       JOIN modalidades m ON m.id = t.modalidade_id
       WHERE at2.aluno_id = $1 AND at2.ate IS NULL
       ORDER BY t.sigla`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const nome = String(req.body.nome || '').trim();
  const matricula = req.body.matricula ? String(req.body.matricula).trim() : null;
  if (!nome) return res.status(400).json({ erro: 'nome obrigatório' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO alunos (nome, matricula) VALUES ($1, $2) RETURNING id',
      [nome, matricula]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'Já existe aluno com essa matrícula' });
    next(err);
  }
});

const SITUACOES_VALIDAS = ['ativo', 'inadimplente', 'suspenso'];
router.put('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  const nome = String(req.body.nome || '').trim();
  const matricula = req.body.matricula ? String(req.body.matricula).trim() : null;
  const situacao = req.body.situacao;
  if (!nome) return res.status(400).json({ erro: 'nome obrigatório' });
  if (!SITUACOES_VALIDAS.includes(situacao)) return res.status(400).json({ erro: 'situação inválida' });
  try {
    const { rowCount } = await pool.query(
      'UPDATE alunos SET nome = $1, matricula = $2, situacao = $3 WHERE id = $4',
      [nome, matricula, situacao, id]
    );
    if (!rowCount) return res.status(404).json({ erro: 'Aluno não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'Já existe aluno com essa matrícula' });
    next(err);
  }
});

// Matricula numa turma nova; se "sairDaTurmaId" vier junto, fecha o
// vínculo antigo (troca) — senão só adiciona (aluno pode fazer mais de
// uma modalidade ao mesmo tempo). Confere vaga antes de inserir: nunca
// confiar que o cliente já conferiu "vagasRestantes" sozinho.
router.post('/:id/matricular', async (req, res, next) => {
  const alunoId = Number(req.params.id);
  const turmaId = Number(req.body.turmaId);
  const sairDaTurmaId = req.body.sairDaTurmaId ? Number(req.body.sairDaTurmaId) : null;
  if (!turmaId) return res.status(400).json({ erro: 'turmaId obrigatório' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: turmaRows } = await client.query(
      `SELECT t.vagas, (SELECT count(*) FROM aluno_turmas WHERE turma_id = t.id AND ate IS NULL) AS ocupadas
       FROM turmas t WHERE t.id = $1 FOR UPDATE`,
      [turmaId]
    );
    if (!turmaRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Turma não encontrada' });
    }
    if (Number(turmaRows[0].ocupadas) >= turmaRows[0].vagas) {
      await client.query('ROLLBACK');
      return res.status(409).json({ erro: 'Turma sem vaga' });
    }

    if (sairDaTurmaId) {
      await client.query(
        'UPDATE aluno_turmas SET ate = CURRENT_DATE WHERE aluno_id = $1 AND turma_id = $2 AND ate IS NULL',
        [alunoId, sairDaTurmaId]
      );
    }

    await client.query(
      'INSERT INTO aluno_turmas (aluno_id, turma_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [alunoId, turmaId]
    );

    await client.query('COMMIT');
    res.status(201).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Sai de uma turma sem entrar em outra (fim de matrícula naquela modalidade).
router.post('/:id/turmas/:turmaId/sair', async (req, res, next) => {
  const alunoId = Number(req.params.id);
  const turmaId = Number(req.params.turmaId);
  try {
    const { rowCount } = await pool.query(
      'UPDATE aluno_turmas SET ate = CURRENT_DATE WHERE aluno_id = $1 AND turma_id = $2 AND ate IS NULL',
      [alunoId, turmaId]
    );
    if (!rowCount) return res.status(404).json({ erro: 'Aluno não está matriculado nessa turma' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
