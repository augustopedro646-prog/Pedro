const express = require('express');
const { pool } = require('../db');
const { exigirAuth, exigirAba, exigirPapel } = require('../auth');
const { CLUBE_FINANCEIRO } = require('../mensalidades');

// Presença de sócios na tela Início: busca o sócio e registra "veio hoje". Só
// sócios ATPN ativos (o quadro do CEPE fica na aba Sócios). O dia é o de Natal.
const router = express.Router();
router.use(exigirAuth, exigirAba('inicio'));

const HOJE = `(now() AT TIME ZONE 'America/Fortaleza')::date`;

// Busca por nome, matrícula, telefone ou CPF (mínimo 2 caracteres).
router.get('/buscar', async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const digitos = q.replace(/\D/g, '');
    const params = [CLUBE_FINANCEIRO, `%${q}%`];
    let extra = '';
    if (digitos.length >= 4) {
      params.push(`%${digitos}%`);
      extra = ` OR regexp_replace(coalesce(s.telefone, ''), '\\D', '', 'g') LIKE $3 OR regexp_replace(coalesce(s.cpf, ''), '\\D', '', 'g') LIKE $3 OR s.matricula LIKE $3`;
    }
    const { rows } = await pool.query(
      `SELECT s.id, s.nome, s.matricula, s.categoria, s.status, s.telefone,
              EXISTS (SELECT 1 FROM presencas p WHERE p.socio_id = s.id AND p.data = ${HOJE}) AS "presenteHoje",
              (SELECT count(*)::int FROM presencas p WHERE p.socio_id = s.id AND p.data >= date_trunc('month', ${HOJE})::date) AS "visitasMes"
       FROM socios s
       WHERE s.clube = $1 AND s.origem_planilha = 'ativo_geral' AND s.status <> 'desligado'
         AND (s.nome ILIKE $2 OR s.matricula ILIKE $2${extra})
       ORDER BY s.nome LIMIT 15`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Registra a presença de hoje. Repetir não duplica.
router.post('/', async (req, res, next) => {
  const socioId = Number(req.body?.socioId);
  if (!Number.isInteger(socioId)) return res.status(400).json({ erro: 'Escolha o sócio' });
  try {
    const s = (await pool.query(
      `SELECT id, nome, status FROM socios WHERE id = $1 AND clube = $2 AND origem_planilha = 'ativo_geral'`, [socioId, CLUBE_FINANCEIRO]
    )).rows[0];
    if (!s) return res.status(404).json({ erro: 'Sócio ATPN não encontrado' });
    if (s.status === 'desligado') return res.status(409).json({ erro: 'Esse sócio está desligado' });
    const r = await pool.query(
      `INSERT INTO presencas (socio_id, data, registrado_por) VALUES ($1, ${HOJE}, $2) ON CONFLICT (socio_id, data) DO NOTHING RETURNING id`,
      [socioId, req.usuario.pessoaId]
    );
    res.status(r.rowCount ? 201 : 200).json({ ok: true, jaRegistrado: !r.rowCount, nome: s.nome });
  } catch (err) {
    next(err);
  }
});

// Desfazer um registro (engano de recepção) — só Administrador.
router.delete('/:id', exigirPapel(), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM presencas WHERE id = $1', [Number(req.params.id)]);
    if (!rowCount) return res.status(404).json({ erro: 'Registro não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Quem frequentou: dia, semana (a partir de segunda) e mês. "pessoas" = sócios
// diferentes; "visitas" = presenças somadas (a mesma pessoa em 3 dias = 1 pessoa, 3 visitas).
router.get('/resumo', async (req, res, next) => {
  try {
    const periodo = async (desde) => (await pool.query(
      `SELECT count(DISTINCT p.socio_id)::int AS pessoas, count(*)::int AS visitas
       FROM presencas p JOIN socios s ON s.id = p.socio_id
       WHERE s.clube = $1 AND p.data >= ${desde} AND p.data <= ${HOJE}`, [CLUBE_FINANCEIRO]
    )).rows[0];
    const [dia, semana, mes, hoje, datas] = await Promise.all([
      periodo(HOJE),
      periodo(`date_trunc('week', ${HOJE})::date`),
      periodo(`date_trunc('month', ${HOJE})::date`),
      pool.query(
        `SELECT p.id, s.id AS "socioId", s.nome, s.categoria, to_char(p.criado_em AT TIME ZONE 'America/Fortaleza', 'HH24:MI') AS hora
         FROM presencas p JOIN socios s ON s.id = p.socio_id
         WHERE s.clube = $1 AND p.data = ${HOJE} ORDER BY p.criado_em DESC LIMIT 50`, [CLUBE_FINANCEIRO]
      ),
      pool.query(`SELECT to_char(${HOJE}, 'YYYY-MM-DD') AS hoje, to_char(date_trunc('week', ${HOJE}), 'YYYY-MM-DD') AS semana, to_char(date_trunc('month', ${HOJE}), 'YYYY-MM-DD') AS mes`),
    ]);
    res.json({ dia, semana, mes, hoje: hoje.rows, datas: datas.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
