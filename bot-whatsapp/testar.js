// Conversa com o atendente pelo terminal, sem WhatsApp (usa a IA de verdade e a API da loja).
//   node testar.js "tem vestido tamanho 4?"   → uma mensagem
//   node testar.js                            → modo conversa (Ctrl+C sai)
const readline = require('readline');
const { pool } = require('./config');
const { responder } = require('./cerebro');

const ID_TESTE = '5500000000000'; // não é telefone real
const ctx = { telefone: ID_TESTE, telefoneLocal: null, nomePerfil: 'Teste', enviarImagem: async (img, legenda) => { console.log(`[foto enviada: ${legenda || 'sem legenda'}, ${img.length} bytes]`); return true; } };

async function main() {
  await pool.query('DELETE FROM bot_conversas WHERE telefone = $1', [ID_TESTE]);
  const unica = process.argv.slice(2).join(' ').trim();
  if (unica) { console.log('\nAtendente: ' + await responder(unica, ctx) + '\n'); process.exit(0); }
  console.log('Modo conversa — escreva como se fosse o cliente. Ctrl+C pra sair.\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'Você: ' });
  rl.prompt();
  rl.on('line', async (linha) => {
    if (linha.trim()) console.log('Atendente: ' + await responder(linha.trim(), ctx) + '\n');
    rl.prompt();
  });
}
main().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
