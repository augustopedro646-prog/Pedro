// Restaura um backup do banco. ⚠ Substitui TODOS os dados atuais pelos do backup.
// Uso (com o serviço da API parado — PowerShell como Administrador: Stop-Service LojaGuttoAPI):
//   node restaurar.js                      → lista os backups disponíveis
//   node restaurar.js loja_gutto_AAAA-MM-DD_HH-mm.dump
// Antes de restaurar, guarda um backup do estado atual (dá pra desfazer).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const readline = require('readline');
const { fazerBackup, listarBackups, PASTA, acharBinario, conexao, rodar } = require('./backup');

async function apiLigada() {
  try { const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health', { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
}
function perguntar(texto) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(texto, (resp) => { rl.close(); r(resp.trim()); }));
}

(async () => {
  const nome = process.argv[2];
  if (!nome) {
    const lista = listarBackups();
    if (!lista.length) { console.log('Nenhum backup em ' + PASTA); return; }
    console.log('Backups em ' + PASTA + ' (mais novo primeiro):');
    lista.slice(0, 30).forEach((b) => console.log('  ' + b.arquivo + '  (' + Math.round(b.tamanhoBytes / 1024) + ' KB)'));
    console.log('\nPra restaurar: node restaurar.js NOME_DO_ARQUIVO');
    return;
  }
  const arquivo = path.isAbsolute(nome) ? nome : path.join(PASTA, nome);
  if (!fs.existsSync(arquivo)) { console.error('Não achei ' + arquivo); process.exit(1); }
  if (await apiLigada() && !process.argv.includes('--forcar')) {
    console.error('O servidor da loja está ligado. Pare antes (PowerShell como Administrador: Stop-Service LojaGuttoAPI) e rode de novo.');
    process.exit(1);
  }
  const { args, banco, env } = conexao();
  await rodar(acharBinario('pg_restore'), ['--list', arquivo], env); // confere se o arquivo lê
  console.log('\n⚠ Isso vai APAGAR os dados atuais do banco "' + banco + '" e colocar os do backup:\n  ' + arquivo + '\n');
  if (!process.argv.includes('--sim') && (await perguntar('Pra confirmar, digite RESTAURAR: ')) !== 'RESTAURAR') { console.log('Cancelado.'); return; }
  console.log('Guardando um backup do estado atual antes...');
  const antes = await fazerBackup('antes-de-restaurar');
  if (!antes.ok) { console.error('Não consegui fazer o backup de segurança (' + antes.erro + ') — nada foi alterado.'); process.exit(1); }
  console.log('  ok: ' + antes.arquivo);
  // Transação única: se qualquer parte falhar, o banco fica exatamente como estava.
  await rodar(acharBinario('pg_restore'), [...args, '--clean', '--if-exists', '--no-owner', '--single-transaction', '-d', banco, arquivo], env);
  console.log('\nRestaurado. Ligue o servidor de novo (Start-Service LojaGuttoAPI).');
  console.log('Se precisar desfazer: node restaurar.js ' + antes.arquivo);
})().catch((e) => { console.error('Falhou (o banco não foi alterado): ' + e.message); process.exit(1); });
