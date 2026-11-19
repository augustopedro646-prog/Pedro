const express = require('express');
const { pool } = require('../db');
const { exigirAuth, exigirAba } = require('../auth');
const { serieMensal, infoPlanilha, ANO_INICIAL, CLUBE_FINANCEIRO } = require('../mensalidades');
const { sobreporPagamentos, contarEmAberto } = require('../statusSocio');

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
    const [porStatus, porCategoria, especiais, datas, motivos, deps] = await Promise.all([
      pool.query(`SELECT clube, status, count(*)::int AS n FROM socios WHERE clube = $1 AND origem_planilha = 'ativo_geral' GROUP BY clube, status`, [CLUBE]),
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
      pool.query(
        `SELECT (SELECT count(*)::int FROM dependentes d JOIN socios s ON s.id = d.socio_id WHERE s.clube = $1 AND s.status <> 'desligado') AS dependentes,
                (SELECT count(*)::int FROM socios WHERE clube = $1 AND status <> 'desligado' AND origem_planilha = 'ativo_geral' AND possivel_duplicado) AS duplicados,
                (SELECT count(*)::int FROM socios WHERE clube = $1 AND origem_planilha = 'ativo_geral') AS quadro,
                (SELECT count(*)::int FROM socios WHERE clube = $1 AND origem_planilha = 'desligados') AS saiu`, [CLUBE]
      ),
    ]);
    res.json({
      atualizadoEm: datas.rows[0].d,
      porStatus: porStatus.rows,
      porCategoria: porCategoria.rows,
      situacoesEspeciais: especiais.rows,
      motivosDesligamento: motivos.rows,
      dependentes: deps.rows[0].dependentes,
      possiveisDuplicados: deps.rows[0].duplicados,
      quadro: deps.rows[0].quadro,
      saiu: deps.rows[0].saiu,
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

// Meses em atraso = células pintadas de vermelho na planilha (inclusive "Sem margem"),
// menos os que a recepção já recebeu na aba Mensalidades.
const mesesEmAberto = (mensalidades) => contarEmAberto(mensalidades);

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
    `SELECT socio_id, ano, mes, valor, em_aberto FROM socios_mensalidades
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
    porSocio.get(m.socio_id).push({ ano: m.ano, mes: m.mes, valor: m.valor === null ? null : Number(m.valor), observacao: null, emAberto: m.em_aberto });
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

// Cobrança: por faixa de atraso (a mesma da legenda da planilha), quantos sócios, quantos
// meses somam e quanto isso vale. O valor de cada mês é o último valor pago pelo próprio
// sócio; sem histórico em 2026, usa a mensalidade média de quem pagou (marcado como estimado).
router.get('/cobranca', async (req, res, next) => {
  try {
    const lista = await listarInadimplentes({ status: null });
    const { rows: [base] } = await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'em_dia')::int AS em_dia FROM socios WHERE clube = $1 AND origem_planilha = 'ativo_geral'`, [CLUBE]
    );
    const pagos = lista.filter((s) => s.ultimoValor > 0).map((s) => s.ultimoValor);
    const { rows: [media] } = await pool.query(
      `SELECT COALESCE(avg(valor) FILTER (WHERE valor > 0), 0)::float8 AS v FROM socios_mensalidades m JOIN socios s ON s.id = m.socio_id
       WHERE s.clube = $1 AND s.origem_planilha = 'ativo_geral' AND m.ano >= $2`, [CLUBE, ANO_INICIAL_MENSALIDADES]
    );
    const mensalidadeMedia = pagos.length ? pagos.reduce((a, b) => a + b, 0) / pagos.length : media.v;
    const faixas = {};
    for (const f of STATUS_ATRASO) faixas[f] = { socios: 0, meses: 0, valorEmAberto: 0, mensalidadeMensal: 0, estimados: 0 };
    for (const s of lista) {
      const f = faixas[s.status];
      if (!f) continue;
      const estimado = !(s.ultimoValor > 0);
      const mensal = estimado ? mensalidadeMedia : s.ultimoValor;
      f.socios++; f.meses += s.mesesEmAberto; f.valorEmAberto += mensal * s.mesesEmAberto;
      f.mensalidadeMensal += mensal; if (estimado) f.estimados++;
    }
    for (const f of Object.values(faixas)) {
      f.valorEmAberto = Math.round(f.valorEmAberto * 100) / 100;
      f.mensalidadeMensal = Math.round(f.mensalidadeMensal * 100) / 100;
    }
    res.json({ emDia: base.em_dia, mensalidadeMedia: Math.round(mensalidadeMedia * 100) / 100, faixas });
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
