const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_PATH = path.join(__dirname, '.env');
const PLACEHOLDER_SENHA = 'COLOQUE_A_SENHA_DO_POSTGRES_AQUI';

// Primeira vez: cria o .env sozinho (com uma chave JWT aleatória) e para, pedindo
// só a senha do Postgres — é o único dado que depende da instalação de quem roda.
function garantirEnv() {
  if (fs.existsSync(ENV_PATH)) return true;
  const conteudo = [
    'PORT=3000',
    'DATABASE_URL=postgresql://postgres:' + PLACEHOLDER_SENHA + '@localhost:5432/loja_gutto',
    'JWT_SECRET=' + crypto.randomBytes(32).toString('hex'),
    'LOJA_ID=1',
    '# Leitura de nota por PDF/foto (IA do Claude). Sem isso, o XML da nota continua funcionando.',
    '# ANTHROPIC_API_KEY=',
    '',
  ].join('\n');
  fs.writeFileSync(ENV_PATH, conteudo);
  console.log('Criei o arquivo .env em:\n  ' + ENV_PATH);
  console.log('\nAbra esse arquivo no Bloco de Notas e troque');
  console.log('  ' + PLACEHOLDER_SENHA);
  console.log('pela senha que você definiu ao instalar o PostgreSQL. Salve e rode de novo:');
  console.log('  npm run setup\n');
  return false;
}

async function criarBancoSeNaoExistir(databaseUrl) {
  const { Client } = require('pg');
  const url = new URL(databaseUrl);
  const nomeBanco = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!/^[a-z0-9_]+$/i.test(nomeBanco)) throw new Error('Nome de banco inválido no DATABASE_URL: ' + nomeBanco);
  url.pathname = '/postgres';
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [nomeBanco]);
    if (!rowCount) {
      await admin.query('CREATE DATABASE "' + nomeBanco + '"');
      console.log('Banco "' + nomeBanco + '" criado.');
    } else {
      console.log('Banco "' + nomeBanco + '" já existia.');
    }
  } finally {
    await admin.end();
  }
}

async function main() {
  if (!garantirEnv()) return;
  require('dotenv').config({ path: ENV_PATH });

  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes(PLACEHOLDER_SENHA)) {
    console.error('O .env ainda está com a senha de exemplo. Abra ' + ENV_PATH + ' e coloque a senha do PostgreSQL.');
    process.exit(1);
  }

  try {
    await criarBancoSeNaoExistir(process.env.DATABASE_URL);
  } catch (e) {
    if (e.code === '28P01') {
      console.error('Senha do PostgreSQL recusada. Confira a senha no arquivo .env.');
    } else if (e.code === 'ECONNREFUSED') {
      console.error('Não achei o PostgreSQL rodando na porta 5432. Ele está instalado e ligado?');
    } else {
      console.error('Não consegui preparar o banco:', e.message);
    }
    process.exit(1);
  }

  const { pool, uid } = require('./db');
  const { hashPin } = require('./auth');

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

  // Variações cadastradas antes do código de barras automático ganham um código agora.
  const { gerarCodigoBarras } = require('./codigos');
  const { rows: semCodigo } = await pool.query('SELECT id FROM produto_variacoes WHERE codigo_barras IS NULL');
  for (const v of semCodigo) {
    await pool.query('UPDATE produto_variacoes SET codigo_barras = $1 WHERE id = $2', [await gerarCodigoBarras(pool), v.id]);
  }
  if (semCodigo.length) console.log(semCodigo.length + ' variação(ões) ganharam código de barras.');

  console.log('\nTudo pronto. Agora rode:  npm start');
  console.log('E abra no navegador:      http://localhost:3000');
  await pool.end();
}

main().catch((e) => {
  console.error('Falha no setup:', e.message || e);
  process.exit(1);
});
