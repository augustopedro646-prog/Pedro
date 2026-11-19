const express = require('express');
const { pool } = require('../db');
const { exigirAuth, exigirAba } = require('../auth');

const router = express.Router();
router.use(exigirAuth, exigirAba('socios'));

const STATUS_VALIDOS = ['em_dia', 'ate_2_meses', '3_a_5_meses', '6_meses_ou_mais', 'desligado'];
const CLUBES_VALIDOS = ['cepe', 'cepe_atpn'];

// Busca por nome (a aba abre com o campo de busca em foco — é o uso
// principal, recepção procurando quem chegou na portaria) + filtros por
// clube/status. Lista enxuta (sem histórico mensal, isso só no detalhe).
router.get('/', async (req, res, next) => {
  const busca = String(req.query.q || '').trim();
  const clube = CLUBES_VALIDOS.includes(req.query.clube) ? req.query.clube : null;
  const status = STATUS_VALIDOS.includes(req.query.status) ? req.query.status : null;
  const limite = Math.min(Math.max(Number(req.query.limite) || 50, 1), 200);

  const params = [];
  const condicoes = [];
  if (busca) {
    params.push(`%${busca}%`);
    condicoes.push(`nome ILIKE $${params.length}`);
  }
  if (clube) {
    params.push(clube);
    condicoes.push(`clube = $${params.length}`);
  }
  if (status) {
    params.push(status);
    condicoes.push(`status = $${params.length}`);
  }
  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  try {
    const total = await pool.query(`SELECT count(*) FROM socios ${where}`, params);
    params.push(limite);
    const { rows } = await pool.query(
      `SELECT id, matricula, nome, clube, categoria, status, situacao_especial AS "situacaoEspecial",
              telefone, to_char(planilha_atualizada_em, 'YYYY-MM-DD') AS "planilhaAtualizadaEm",
              meses_em_aberto AS "mesesEmAberto", possivel_duplicado AS "possivelDuplicado",
              (SELECT count(*)::int FROM dependentes d WHERE d.socio_id = socios.id) AS "qtdDependentes"
       FROM socios ${where}
       ORDER BY (clube = 'cepe_atpn') DESC, (status = 'desligado'), nome LIMIT $${params.length}`,
      params
    );
    res.json({ total: Number(total.rows[0].count), socios: rows });
  } catch (err) {
    next(err);
  }
});

// Totais por clube/status, pros cartões/filtros da tela (contagem de
// verdade, não estimada a partir da lista limitada acima).
router.get('/resumo', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT clube, status, count(*) FROM socios GROUP BY clube, status');
    res.json(rows.map((r) => ({ clube: r.clube, status: r.status, total: Number(r.count) })));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const { rows } = await pool.query(
      `SELECT id, matricula, matricula_secundaria AS "matriculaSecundaria", nome, cpf, clube, categoria,
              categoria_original AS "categoriaOriginal", dia_vencimento AS "diaVencimento", telefone,
              telefone_secundario AS "telefoneSecundario", status, situacao_especial AS "situacaoEspecial",
              motivo_desligamento AS "motivoDesligamento", origem_planilha AS "origemPlanilha",
              to_char(planilha_atualizada_em, 'YYYY-MM-DD') AS "planilhaAtualizadaEm",
              meses_em_aberto AS "mesesEmAberto", nome_nota AS "nomeNota", possivel_duplicado AS "possivelDuplicado"
       FROM socios WHERE id = $1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ erro: 'Sócio não encontrado' });

    const { rows: mensalidades } = await pool.query(
      `SELECT ano, mes, valor, observacao, em_aberto AS "emAberto" FROM socios_mensalidades WHERE socio_id = $1 ORDER BY ano, mes`,
      [id]
    );
    const { rows: dependentes } = await pool.query('SELECT id, nome FROM dependentes WHERE socio_id = $1 ORDER BY nome', [id]);
    res.json({ ...rows[0], mensalidades, dependentes });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
