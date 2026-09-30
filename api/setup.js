require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool, uid } = require('./db');
const { hashPin } = require('./auth');

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Schema aplicado.');

  const { rows: lojasExistentes } = await pool.query('SELECT id FROM lojas LIMIT 1');
  let lojaId;
  if (lojasExistentes.length) {
    lojaId = lojasExistentes[0].id;
    console.log('Loja já existia (id ' + lojaId + ') — não recriei.');
  } else {
    const { rows } = await pool.query('INSERT INTO lojas (nome) VALUES ($1) RETURNING id', ['Gutto']);
    lojaId = rows[0].id;
    console.log('Loja "Gutto" criada (id ' + lojaId + ').');
  }

  // Seed idempotente: só cria se ainda não existir ninguém com esse nome na loja.
  const seedUsuarios = [
    { nome: 'Pedro', papel: 'administrador', pin: '1103' },
    { nome: 'Lorena', papel: 'administrador', pin: '1007' },
  ];
  for (const u of seedUsuarios) {
    const { rows } = await pool.query(
      'SELECT id FROM usuarios WHERE loja_id = $1 AND nome = $2',
      [lojaId, u.nome]
    );
    if (rows.length) {
      console.log('Usuário "' + u.nome + '" já existia — não recriei.');
      continue;
    }
    await pool.query(
      'INSERT INTO usuarios (id, loja_id, nome, papel, pin_hash) VALUES ($1, $2, $3, $4, $5)',
      [uid(), lojaId, u.nome, u.papel, hashPin(u.pin)]
    );
    console.log('Usuário "' + u.nome + '" criado (papel: ' + u.papel + ').');
  }

  console.log('\nSetup concluído. LOJA_ID=' + lojaId);
  await pool.end();
}

main().catch((e) => {
  console.error('Falha no setup:', e);
  process.exit(1);
});
