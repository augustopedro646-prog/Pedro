// Cria o primeiro acesso de Diretoria. Uso: node scripts/seed-diretoria.js "Nome" 1234
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../server/db');

async function main() {
  const [nome, pin] = process.argv.slice(2);
  if (!nome || !/^\d{4}$/.test(pin || '')) {
    console.error('Uso: node scripts/seed-diretoria.js "Nome" 1234');
    process.exit(1);
  }

  const pinHash = await bcrypt.hash(pin, 10);
  await pool.query(
    "INSERT INTO professores (nome, pin_hash, tipo) VALUES ($1, $2, 'diretoria')",
    [nome, pinHash]
  );
  console.log(`Acesso de Diretoria "${nome}" criado.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
