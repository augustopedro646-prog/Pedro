// Passo único de configuração, pra rodar no PC do Jabá (onde os dois
// sistemas vão rodar juntos): garante a loja "ATPN" na tabela `lojas` do
// banco do PDV Jabá, pra essa ATPN poder usar a tabela `agenda_eventos`
// compartilhada (mesma agenda/calendário nos dois sistemas — decisão com
// o Pedro). Idempotente: rodar de novo não duplica a loja.
//
// Uso: JABA_DATABASE_URL="postgresql://postgres:<senha>@localhost:5432/pdv_jaba" node scripts/configurar-integracao-jaba.js
// (a senha do Postgres já está em "Sistema clode/api/.env", do PDV Jabá)
const { Pool } = require('pg');

async function main() {
  const url = process.env.JABA_DATABASE_URL || process.argv[2];
  if (!url) {
    console.error('Uso: JABA_DATABASE_URL="postgresql://postgres:<senha>@localhost:5432/pdv_jaba" node scripts/configurar-integracao-jaba.js');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  try {
    const existente = await pool.query("SELECT id FROM lojas WHERE nome = 'ATPN'");
    let lojaId;
    if (existente.rows[0]) {
      lojaId = existente.rows[0].id;
      console.log(`Loja "ATPN" já existia no PDV Jabá (id ${lojaId}).`);
    } else {
      const { rows } = await pool.query("INSERT INTO lojas (nome) VALUES ('ATPN') RETURNING id");
      lojaId = rows[0].id;
      console.log(`Loja "ATPN" criada no PDV Jabá (id ${lojaId}).`);
    }
    console.log('\nAdicione no .env deste projeto (o da ATPN, não o do Jabá):');
    console.log(`  JABA_DATABASE_URL=${url}`);
    console.log(`  JABA_LOJA_ID=${lojaId}`);
    console.log('\nDepois de salvar o .env, reinicie o servidor da ATPN pra aba Calendário passar a funcionar.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
