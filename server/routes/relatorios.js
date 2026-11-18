const express = require('express');
const { pool } = require('../db');
const { exigirAuth, exigirAba } = require('../auth');
const { serieMensal, infoPlanilha, ANO_INICIAL, CLUBE_FINANCEIRO } = require('../mensalidades');
const { sobreporPagamentos } = require('../statusSocio');

const router = express.Router();
router.use(exigirAuth, exigirAba('relatorios'));

// RELATÓRIOS SÓ DA ATPN: dados de sócios do CEPE ficam apenas na aba Sócios.
// Mensalidades: só de 2026 em diante (ver server/mensalidades.js) e o valor do
// mês junta planilha + pagamentos registrados na ATPN.
const ANO_INICIAL_MENSALIDADES = ANO_INICIAL;
const CLUBE = CLUBE_FINANCEIRO;

// Retrato atual do quadro de sócios ATPN (o que a planilha + a recepção dizem hoje).
router.get('/socios', async (req, res, next) => {
  try {
    const [porStatus, porCategoria, especiais, datas, motivos] = await Promise.all([
      pool.query('SELECT clube, status, count(*)::int AS n FROM socios WHERE clube = $1 GROUP BY clube, status', [CLUBE]),
      pool.query(
        `SELECT clube, COALESCE(categoria, 'nao_identificada') AS categoria, count(*)::int AS n
         FROM socios WHERE clube = $1 AND status <> 'desligado' GROUP BY 1, 2`, [CLUBE]
      ),
      pool.query(
        `SELECT lower(situacao_especial) AS situacao, count(*)::int AS n
         FROM socios WHERE clube = $1 AND status <> 'desligado' AND situacao_especial IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, [CLUBE]
      ),
      pool.query(`SELECT to_char(max(planilha_atualizada_em), 'YYYY-MM-DD') AS d FROM socios`),
      pool.query(
        `SELECT CASE
                  WHEN motivo_desligamento ~* 'falta de pagamento' THEN 'Falta de pagamento'
                  WHEN motivo_desligamento ~* 'mudan' THEN 'Mudança'
                  WHEN motivo_desligamento ~* 'pouco uso' THEN 'Pouco uso'
                  WHEN motivo_desligamento ~* 'n[aã]o utilizar' THEN 'Não utilizar'
                  WHEN motivo_desligamento ~* 'n[aã]o identificado' THEN 'Motivo não identificado'
                  ELSE 'Outros / sem motivo'
                END AS motivo, count(*)::int AS n
         FROM socios WHERE clube = $1 AND status = 'desligado' GROUP BY 1 ORDER BY 2 DESC`, [CLUBE]
      ),
    ]);
    res.json({
      atualizadoEm: datas.rows[0].d,
      porStatus: porStatus.rows,
      porCategoria: porCategoria.rows,
      situacoesEspeciais: especiais.rows,
      motivosDesligamento: motivos.rows,
    });
  } catch (err) {
    next(err);
  }
});

// Série mensal (2026+) por clube. valor numérico > 0 = pagou; 0 = não pagou;
// sem número + texto (sem margem, INSS, abonado, ausente...) = situação
// especial, não conta como atraso nem como pagamento.
router.get('/mensalidades', async (req, res, next) => {
  try {
    const [serie, planilha] = await Promise.all([serieMensal(), infoPlanilha()]);
    res.json({ serie, planilhaAtualizadaEm: planilha.atualizadoEm });
  } catch (err) {
    next(err);
  }
});

// Meses seguidos sem pagar, contando de trás pra frente (mesma regra da importação).
function mesesEmAberto(mensalidades) {
  let n = 0;
  for (let i = mensalidades.length - 1; i >= 0; i--) {
    if (mensalidades[i].valor === 0) n++;
    else break;
  }
  return n;
}

async function listarInadimplentes({ status }) {
  const params = [CLUBE];
  const cond = [`s.clube = $1`, `s.status IN ('ate_2_meses', '3_a_5_meses', '6_meses_ou_mais')`];
  if (status) { params.push(status); cond.push(`s.status = $${params.length}`); }
  const { rows: socios } = await pool.query(
    `SELECT s.id, s.nome, s.matricula, s.clube, s.categoria, s.status, s.telefone
     FROM socios s WHERE ${cond.join(' AND ')} ORDER BY s.nome`,
    params
  );
  if (!socios.length) return [];
  const { rows: mens } = await pool.query(
    `SELECT socio_id, ano, mes, valor FROM socios_mensalidades
     WHERE socio_id = ANY($1) AND ano >= $2 ORDER BY socio_id, ano, mes`,
    [socios.map((s) => s.id), ANO_INICIAL_MENSALIDADES]
  );
  // pagamentos registrados na ATPN valem por cima da planilha
  const { rows: pags } = await pool.query(
    `SELECT socio_id, ano, mes, sum(valor) AS valor FROM mensalidade_pagamentos
     WHERE socio_id = ANY($1) AND cancelado_em IS NULL GROUP BY socio_id, ano, mes`,
    [socios.map((s) => s.id)]
  );
  const porSocio = new Map();
  for (const m of mens) {
    if (!porSocio.has(m.socio_id)) porSocio.set(m.socio_id, []);
    porSocio.get(m.socio_id).push({ ano: m.ano, mes: m.mes, valor: m.valor === null ? null : Number(m.valor), observacao: null });
  }
  const pagsPorSocio = new Map();
  for (const p of pags) {
    if (!pagsPorSocio.has(p.socio_id)) pagsPorSocio.set(p.socio_id, new Map());
    pagsPorSocio.get(p.socio_id).set(p.ano * 12 + p.mes, Number(p.valor));
  }
  return socios.map((s) => {
    const h = sobreporPagamentos(porSocio.get(s.id) || [], pagsPorSocio.get(s.id) || new Map());
    const ultimoPago = [...h].reverse().find((m) => m.valor > 0);
    return {
      id: s.id, nome: s.nome, matricula: s.matricula, clube: s.clube, categoria: s.categoria, status: s.status,
      telefone: s.telefone, mesesEmAberto: mesesEmAberto(h),
      ultimoPagamento: ultimoPago ? `${String(ultimoPago.mes).padStart(2, '0')}/${ultimoPago.ano}` : null,
      ultimoValor: ultimoPago ? ultimoPago.valor : null,
    };
  }).sort((a, b) => b.mesesEmAberto - a.mesesEmAberto || a.nome.localeCompare(b.nome));
}

const STATUS_ATRASO = ['ate_2_meses', '3_a_5_meses', '6_meses_ou_mais'];

router.get('/inadimplentes', async (req, res, next) => {
  const status = STATUS_ATRASO.includes(req.query.status) ? req.query.status : null;
  try {
    const lista = await listarInadimplentes({ status });
    res.json({ total: lista.length, socios: lista.slice(0, 500) });
  } catch (err) {
    next(err);
  }
});

// CSV — neutraliza células que o Excel interpretaria como fórmula (= + - @),
// o texto vem de planilha digitada por pessoas.
const celulaCsv = (v) => {
  let t = v == null ? '' : String(v).replace(/\r?\n/g, ' ');
  if (/^[=+\-@\t]/.test(t)) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
};

router.get('/inadimplentes.csv', async (req, res, next) => {
  const status = STATUS_ATRASO.includes(req.query.status) ? req.query.status : null;
  try {
    const lista = await listarInadimplentes({ status });
    const rotuloStatus = { ate_2_meses: 'Até 2 meses', '3_a_5_meses': '3 a 5 meses', '6_meses_ou_mais': '6 meses ou mais' };
    const linhas = [['Nome', 'Matrícula', 'Categoria', 'Situação', 'Meses em aberto', 'Último pagamento', 'Último valor', 'Telefone']];
    for (const s of lista) {
      linhas.push([s.nome, s.matricula, s.categoria, rotuloStatus[s.status],
        s.mesesEmAberto, s.ultimoPagamento, s.ultimoValor != null ? String(s.ultimoValor).replace('.', ',') : '', s.telefone]);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="inadimplentes-atpn.csv"');
    res.send('﻿' + linhas.map((l) => l.map(celulaCsv).join(';')).join('\r\n'));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
