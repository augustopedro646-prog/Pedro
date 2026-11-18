const { pool } = require('./db');

// Mensalidades — financeiro SÓ DA ATPN. O quadro do CEPE aparece apenas na aba
// Sócios; relatório, fluxo de caixa e início usam só sócios CEPE-ATPN.
//
// Valor do mês de um sócio (efetivo):
//   - planilha com valor > 0  -> o da planilha;
//   - senão, soma dos pagamentos registrados na ATPN (baixa direta);
//   - senão, o que a planilha tiver (0 = não pagou; vazio com texto = situação especial).
// Assim o mesmo pagamento nunca conta duas vezes (planilha depois atualizada
// com o que a recepção já tinha registrado) e a reimportação da planilha não
// faz sumir o que foi registrado aqui.
//
// Só de 2026 em diante e só da aba ATIVO GERAL (quadro completo): os meses de
// 2024/2025 existem apenas pra quem já saiu e dariam um total falso.
const ANO_INICIAL = 2026;
const CLUBE_FINANCEIRO = 'cepe_atpn';

const chaveMes = (ano, mes) => `${ano}-${String(mes).padStart(2, '0')}`;

const EFETIVO_SQL = `
  WITH pag AS (
    SELECT p.socio_id, p.ano, p.mes, sum(p.valor) AS valor
    FROM mensalidade_pagamentos p JOIN socios s ON s.id = p.socio_id
    WHERE p.cancelado_em IS NULL AND s.clube = '${CLUBE_FINANCEIRO}' AND s.origem_planilha = 'ativo_geral'
    GROUP BY 1, 2, 3
  ), base AS (
    SELECT m.socio_id, m.ano, m.mes, m.valor, m.observacao
    FROM socios_mensalidades m JOIN socios s ON s.id = m.socio_id
    WHERE s.clube = '${CLUBE_FINANCEIRO}' AND s.origem_planilha = 'ativo_geral' AND m.ano >= ${ANO_INICIAL}
  ), efetivo AS (
    SELECT COALESCE(b.socio_id, p.socio_id) AS socio_id, COALESCE(b.ano, p.ano) AS ano, COALESCE(b.mes, p.mes) AS mes,
           CASE WHEN b.valor > 0 THEN b.valor ELSE COALESCE(p.valor, b.valor) END AS valor
    FROM base b FULL JOIN pag p ON p.socio_id = b.socio_id AND p.ano = b.ano AND p.mes = b.mes
    WHERE COALESCE(b.ano, p.ano) >= ${ANO_INICIAL}
  )`;

// Mapa 'AAAA-MM' -> valor arrecadado, pros meses entre as datas (inclusive).
async function arrecadacaoPorMes(inicio, fim) {
  const { rows } = await pool.query(
    `${EFETIVO_SQL}
     SELECT ano, mes, COALESCE(sum(valor) FILTER (WHERE valor > 0), 0)::float8 AS total
     FROM efetivo
     WHERE make_date(ano, mes, 1) BETWEEN date_trunc('month', $1::date) AND $2::date
     GROUP BY ano, mes`,
    [inicio, fim]
  );
  return new Map(rows.map((r) => [chaveMes(r.ano, r.mes), r.total]));
}

// Série mensal ATPN: arrecadado, pagantes (valor > 0), não pagaram (0) e
// situações especiais (sem número, só texto: sem margem, INSS, abonado...).
async function serieMensal() {
  const { rows } = await pool.query(
    `${EFETIVO_SQL}
     SELECT ano, mes,
            COALESCE(sum(valor) FILTER (WHERE valor > 0), 0)::float8 AS arrecadado,
            count(*) FILTER (WHERE valor > 0)::int AS pagantes,
            count(*) FILTER (WHERE valor = 0)::int AS "naoPagaram",
            count(*) FILTER (WHERE valor IS NULL)::int AS especiais
     FROM efetivo GROUP BY ano, mes ORDER BY ano, mes`
  );
  return rows;
}

// Data da planilha e qual é o primeiro mês PARCIAL (o mês dela: a planilha é um
// retrato, então esse mês e os seguintes ainda não fecharam).
async function infoPlanilha() {
  const { rows } = await pool.query(`SELECT to_char(max(planilha_atualizada_em), 'YYYY-MM-DD') AS d FROM socios`);
  const d = rows[0].d;
  return { atualizadoEm: d, primeiroMesParcial: d ? d.slice(0, 7) : null };
}

module.exports = { arrecadacaoPorMes, serieMensal, infoPlanilha, chaveMes, ANO_INICIAL, CLUBE_FINANCEIRO, EFETIVO_SQL };
