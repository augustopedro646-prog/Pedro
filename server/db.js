const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function registrarHistorico(client, { tabela, registroId, dadoAnterior, alteradoPor }) {
  await client.query(
    `INSERT INTO app_dados_historico (tabela, registro_id, dado_anterior, alterado_por)
     VALUES ($1, $2, $3, $4)`,
    [tabela, registroId, dadoAnterior, alteradoPor ?? null]
  );
}

module.exports = { pool, registrarHistorico };
