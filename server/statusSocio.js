// Status de um sócio ATIVO a partir do histórico mensal. Usado pela importação
// da planilha E pela baixa direta (quando a recepção registra ou estorna um
// pagamento, o status do sócio é recalculado na hora).
//
// Olha o mês mais recente preenchido. Texto "DESLIGADO..." vira desligado;
// outro texto (ABONADO, ISENTO, Sem margem, INSS, AUSENTE...) é uma situação
// especial, não atraso; valor numérico conta quantos meses seguidos (voltando)
// vieram exatamente 0 e aplica o mesmo corte que a planilha usa no resumo
// (até 2 / 3 a 5 / 6 ou mais).

// A planilha é digitada à mão: "DESLIGADO", "DESLIGAMENTO - ...", e também
// erros como "desligaod", "desigado", "desliagdo". Tudo que começa com
// "desl"/"desig" é desligamento; sem isso essas pessoas ficavam como ativas.
function ehDesligamento(texto) {
  return /^(desl|desig)/i.test(String(texto || '').trim());
}

function calcularStatusAtivo(mensalidades) {
  if (!mensalidades.length) return { status: 'em_dia', situacaoEspecial: null, motivo: null };
  const ultimo = mensalidades[mensalidades.length - 1];
  const obsUltimo = (ultimo.observacao || '').trim();
  if (ehDesligamento(obsUltimo)) return { status: 'desligado', situacaoEspecial: null, motivo: obsUltimo };
  if (obsUltimo && ultimo.valor == null) return { status: 'em_dia', situacaoEspecial: obsUltimo, motivo: null };

  let mesesSemPagamento = 0;
  for (let i = mensalidades.length - 1; i >= 0; i--) {
    if (mensalidades[i].valor === 0) mesesSemPagamento++;
    else break;
  }
  if (mesesSemPagamento === 0) return { status: 'em_dia', situacaoEspecial: null, motivo: null };
  if (mesesSemPagamento <= 2) return { status: 'ate_2_meses', situacaoEspecial: null, motivo: null };
  if (mesesSemPagamento <= 5) return { status: '3_a_5_meses', situacaoEspecial: null, motivo: null };
  return { status: '6_meses_ou_mais', situacaoEspecial: null, motivo: null };
}

// Junta o histórico da planilha com os pagamentos registrados na ATPN: mês com
// pagamento registrado e sem valor > 0 na planilha passa a contar como pago.
function sobreporPagamentos(mensalidades, pagamentosPorMes) {
  const porMes = new Map(mensalidades.map((m) => [m.ano * 12 + m.mes, { ...m }]));
  for (const [chave, valor] of pagamentosPorMes) {
    const atual = porMes.get(chave);
    if (atual && atual.valor > 0) continue; // a planilha já tem o valor
    const ano = Math.floor((chave - 1) / 12);
    const mes = chave - ano * 12;
    porMes.set(chave, { ano, mes, valor, observacao: null });
  }
  return [...porMes.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

// Recalcula e grava o status de UM sócio ATPN ativo, considerando os pagamentos
// registrados. Não mexe em quem a planilha já marcou como desligado.
async function recalcularStatusSocio(db, socioId) {
  const s = (await db.query('SELECT id, clube, origem_planilha, status FROM socios WHERE id = $1', [socioId])).rows[0];
  if (!s || s.clube !== 'cepe_atpn' || s.origem_planilha !== 'ativo_geral' || s.status === 'desligado') return null;
  const mens = (await db.query(
    'SELECT ano, mes, valor, observacao FROM socios_mensalidades WHERE socio_id = $1 ORDER BY ano, mes', [socioId]
  )).rows.map((m) => ({ ano: m.ano, mes: m.mes, valor: m.valor === null ? null : Number(m.valor), observacao: m.observacao }));
  const pag = (await db.query(
    `SELECT ano, mes, sum(valor) AS valor FROM mensalidade_pagamentos
     WHERE socio_id = $1 AND cancelado_em IS NULL GROUP BY ano, mes`, [socioId]
  )).rows;
  const mapa = new Map(pag.map((p) => [p.ano * 12 + p.mes, Number(p.valor)]));
  const novo = calcularStatusAtivo(sobreporPagamentos(mens, mapa));
  if (novo.status === 'desligado') return null; // desligamento vem só da planilha
  await db.query('UPDATE socios SET status = $1, situacao_especial = $2 WHERE id = $3', [novo.status, novo.situacaoEspecial, socioId]);
  return novo;
}

module.exports = { ehDesligamento, calcularStatusAtivo, sobreporPagamentos, recalcularStatusSocio };
