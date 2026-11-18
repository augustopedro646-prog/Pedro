const { Pool } = require('pg');

// Segunda conexão — só pro calendário compartilhado com o PDV Jabá. Decisão
// com o Pedro: reservas/eventos são a MESMA agenda nos dois sistemas, não
// uma cópia sincronizada. O PDV Jabá já guarda isso em `agenda_eventos`
// (tabela multi-loja desde o início, pensada pra crescer pra outras lojas) e
// já consolida todas as lojas numa visão só pro admin (`/api/consolidado/agenda`,
// sem filtro de loja_id) — então basta a ATPN virar mais uma "loja" ali que
// aparece sozinho do lado do Jabá, sem precisar mexer no código dele.
//
// Opcional de propósito: sem JABA_DATABASE_URL (dev local, ou antes de rodar
// o scripts/configurar-integracao-jaba.js no PC de produção), a aba
// Calendário funciona em modo "integração não configurada" em vez de
// derrubar o resto do sistema.
const jabaPool = process.env.JABA_DATABASE_URL
  ? new Pool({ connectionString: process.env.JABA_DATABASE_URL })
  : null;

const JABA_LOJA_ID = process.env.JABA_LOJA_ID ? Number(process.env.JABA_LOJA_ID) : null;

function integracaoConfigurada() {
  return Boolean(jabaPool && JABA_LOJA_ID);
}

module.exports = { jabaPool, JABA_LOJA_ID, integracaoConfigurada };
