// O bot usa o MESMO .env da API (api/.env): banco, chave do Claude e o segredo compartilhado
// ficam num lugar só. Um bot-whatsapp/.env opcional pode sobrescrever algo (ex.: PORT).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', 'api', '.env') });

const { Pool } = require('pg');

const LOJA_ID = Number(process.env.LOJA_ID || 1);
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:' + (process.env.PORT_API || 3000) + '/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', (err) => console.error('Erro inesperado no pool do Postgres (bot):', err.message));

// Número do WhatsApp (ex.: 5584999991234, às vezes sem o 9 do celular) → como a loja guarda
// telefone de cliente (DDD + número, 11 dígitos pra celular). Contatos "@lid" não têm número de
// telefone de verdade: aí devolve null e o bot pede o telefone quando precisar.
function telefoneLocal(numeroWhatsapp) {
  let d = String(numeroWhatsapp || '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 10 && /^[6-9]/.test(d.slice(2))) d = d.slice(0, 2) + '9' + d.slice(2);
  return d.length === 10 || d.length === 11 ? d : null;
}

module.exports = { LOJA_ID, API_BASE, pool, telefoneLocal };
