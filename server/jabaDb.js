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

// Escopo do evento ('jaba' | 'atpn' | 'ambos' | 'externo'): coluna `escopo` em
// agenda_eventos e encomendas_evento, criada pelo lado do PDV Jabá. A ATPN só
// mostra 'atpn' e 'ambos' (e o que ela mesma criou). Enquanto a coluna não
// existir, a ATPN mostra SÓ o que ela mesma criou (nada do Jabá vaza). A
// checagem é reaproveitada por 60 s pra pegar a coluna assim que ela aparecer.
let escopoCache = { em: 0, valor: false };
async function temEscopo() {
  if (!jabaPool) return false;
  if (Date.now() - escopoCache.em < 60000) return escopoCache.valor;
  try {
    const { rows } = await jabaPool.query(
      `SELECT count(DISTINCT table_name)::int AS n FROM information_schema.columns
       WHERE column_name = 'escopo' AND table_name IN ('agenda_eventos', 'encomendas_evento')`
    );
    escopoCache = { em: Date.now(), valor: rows[0].n === 2 };
  } catch (e) {
    escopoCache = { em: Date.now(), valor: false };
  }
  return escopoCache.valor;
}

module.exports = { jabaPool, JABA_LOJA_ID, integracaoConfigurada, temEscopo };
