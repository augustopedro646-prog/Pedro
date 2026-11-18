const { pool } = require('./db');

// Fase 1 das mensalidades: a ATPN ESPELHA a planilha dos sócios (a associação
// continua atualizando a planilha e reimportando). A arrecadação do mês vira
// receita automática no fluxo de caixa, separada dos lançamentos manuais.
//
// Só de 2026 em diante e só da aba ATIVO GERAL (quadro completo): os meses de
// 2024/2025 existem apenas pra quem já saiu e dariam uma receita falsa.
const ANO_INICIAL = 2026;

const chaveMes = (ano, mes) => `${ano}-${String(mes).padStart(2, '0')}`;

// Mapa 'AAAA-MM' -> valor arrecadado, pros meses entre as datas (inclusive).
async function arrecadacaoPorMes(inicio, fim) {
  const { rows } = await pool.query(
    `SELECT m.ano, m.mes, COALESCE(sum(m.valor) FILTER (WHERE m.valor > 0), 0)::float8 AS total
     FROM socios_mensalidades m JOIN socios s ON s.id = m.socio_id
     WHERE s.origem_planilha = 'ativo_geral' AND m.ano >= $1
       AND make_date(m.ano, m.mes, 1) BETWEEN date_trunc('month', $2::date) AND $3::date
     GROUP BY m.ano, m.mes`,
    [ANO_INICIAL, inicio, fim]
  );
  return new Map(rows.map((r) => [chaveMes(r.ano, r.mes), r.total]));
}

// Data da planilha e qual é o primeiro mês PARCIAL (o mês dela: a planilha é um
// retrato, então esse mês e os seguintes ainda não fecharam).
async function infoPlanilha() {
  const { rows } = await pool.query(`SELECT to_char(max(planilha_atualizada_em), 'YYYY-MM-DD') AS d FROM socios`);
  const d = rows[0].d;
  return { atualizadoEm: d, primeiroMesParcial: d ? d.slice(0, 7) : null };
}

module.exports = { arrecadacaoPorMes, infoPlanilha, chaveMes, ANO_INICIAL };
