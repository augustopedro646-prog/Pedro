// Conflito de espaço: a ATPN divide o local com o restaurante, então antes de
// confirmar uma reserva a gente olha o que já está marcado no MESMO DIA.
//
// Regra (aviso, nunca bloqueio — quem decide é o Administrador):
//  - os dois têm horário e se sobrepõem        -> "sobrepoe"  (conflito forte)
//  - algum dos dois NÃO tem horário no dia     -> "mesmo_dia" (pode conflitar,
//    muita reserva do PDV vem sem horário, então não dá pra afirmar)
//  - os dois têm horário e não se tocam        -> sem conflito
// Fim ausente = 4 horas depois do início (duração típica de evento).
const DURACAO_PADRAO_MIN = 240;

// Aceita "17:00", "17:00:00", "17h", "17h30", "9:5" (lixo vira null).
function paraMinutos(texto) {
  if (texto == null) return null;
  const m = String(texto).trim().toLowerCase().match(/^(\d{1,2})\s*(?:[:h]\s*(\d{1,2})?)?\s*(?::\d{2})?\s*h?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function intervalo(horaInicio, horaFim) {
  const ini = paraMinutos(horaInicio);
  if (ini == null) return null;
  let fim = paraMinutos(horaFim);
  if (fim == null || fim <= ini) fim = ini + DURACAO_PADRAO_MIN;
  return [ini, fim];
}

// candidato: { horaInicio, horaFim }; existentes: [{ id, titulo, horaInicio, horaFim, origem }]
// (todos já filtrados pro mesmo dia). Devolve só os que conflitam, com o motivo.
function detectarConflitos(candidato, existentes) {
  const a = intervalo(candidato.horaInicio, candidato.horaFim);
  const resultado = [];
  for (const e of existentes) {
    const b = intervalo(e.horaInicio, e.horaFim);
    if (!a || !b) {
      resultado.push({ ...e, motivo: 'mesmo_dia' });
    } else if (a[0] < b[1] && b[0] < a[1]) {
      resultado.push({ ...e, motivo: 'sobrepoe' });
    }
  }
  return resultado;
}

module.exports = { detectarConflitos, paraMinutos, intervalo };
