// Cria o primeiro Administrador. Uso: node scripts/seed-admin.js "Nome" 1234
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../server/db');

async function main() {
  const [nome, pin] = process.argv.slice(2);
  if (!nome || !/^\d{4}$/.test(pin || '')) {
    console.error('Uso: node scripts/seed-admin.js "Nome" 1234');
    process.exit(1);
  }

  const { rows } = await pool.query("SELECT id FROM cargos WHERE nome = 'Administrador'");
  if (!rows[0]) {
    console.error('Cargo "Administrador" não existe — rode db:seed antes.');
    process.exit(1);
  }

  const pinHash = await bcrypt.hash(pin, 10);
  await pool.query(
    'INSERT INTO pessoas (nome, cargo_id, pin_hash) VALUES ($1, $2, $3)',
    [nome, rows[0].id, pinHash]
  );
  console.log(`Administrador "${nome}" criado.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
