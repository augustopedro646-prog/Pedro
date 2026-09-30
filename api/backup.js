// Backup automático do banco da loja (pg_dump). Roda sozinho de hora em hora dentro do próprio
// servidor (que já é um serviço sempre ligado) — sem tarefa agendada do Windows pra configurar.
// Também dá pra rodar na mão: `node backup.js`.
//
// - Pasta local: ../backups (ao lado de api/). Guarda todos das últimas 48h e 1 por dia até 30 dias.
// - Cópia fora do computador: BACKUP_COPIA no .env (ex.: uma pasta do OneDrive/Google Drive, que
//   sobe pra nuvem sozinha, ou um pendrive/HD externo). Recebe 1 arquivo por dia, guarda 30 dias.
// - Cada backup é conferido com pg_restore --list logo depois (arquivo corrompido = erro, não "ok").
// - O resultado fica em backups/ultimo-backup.json e aparece no painel.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
if (require.main === module) require('dotenv').config({ path: path.join(__dirname, '.env') });

const PASTA = process.env.BACKUP_PASTA || path.join(__dirname, '..', 'backups');
const ARQ_STATUS = path.join(PASTA, 'ultimo-backup.json');
const PREFIXO = 'loja_gutto_';
const TZ = process.env.TZ_LOJA || 'America/Fortaleza';

// pg_dump precisa ser da mesma versão do servidor ou mais nova: no Windows pega a maior instalada.
function acharBinario(nome) {
  if (process.env.PG_BIN) return path.join(process.env.PG_BIN, nome + (process.platform === 'win32' ? '.exe' : ''));
  if (process.platform === 'win32') {
    const base = 'C:\\Program Files\\PostgreSQL';
    try {
      const versoes = fs.readdirSync(base).filter((v) => /^\d+(\.\d+)?$/.test(v)).sort((a, b) => parseFloat(b) - parseFloat(a));
      for (const v of versoes) {
        const exe = path.join(base, v, 'bin', nome + '.exe');
        if (fs.existsSync(exe)) return exe;
      }
    } catch {}
    return nome + '.exe';
  }
  return nome;
}

function conexao() {
  const url = new URL(process.env.DATABASE_URL);
  return {
    args: ['-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username)],
    banco: decodeURIComponent(url.pathname.replace(/^\//, '')),
    env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) }, // senha por variável, nunca na linha de comando
  };
}

function rodar(bin, args, env) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim().split('\n').slice(-2).join(' ')));
      else resolve(stdout.toString());
    });
  });
}

function carimbo(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { dia: `${p.year}-${p.month}-${p.day}`, completo: `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.second}` };
}

// Todos das últimas 48h; antes disso, o mais novo de cada dia; nada com mais de 30 dias.
function limparAntigos(pasta, agora) {
  const arquivos = fs.readdirSync(pasta).filter((f) => f.startsWith(PREFIXO) && f.endsWith('.dump'))
    .map((f) => ({ f, t: fs.statSync(path.join(pasta, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  const diasVistos = new Set();
  for (const { f, t } of arquivos) {
    const idade = agora - t;
    const dia = f.slice(PREFIXO.length, PREFIXO.length + 10);
    let manter = idade < 48 * 3600e3;
    if (!manter && idade < 30 * 864e5 && !diasVistos.has(dia)) manter = true;
    diasVistos.add(dia);
    if (!manter) { try { fs.unlinkSync(path.join(pasta, f)); } catch {} }
  }
}

function lerStatus() {
  try { return JSON.parse(fs.readFileSync(ARQ_STATUS, 'utf8')); } catch { return null; }
}
function salvarStatus(s) {
  try { fs.writeFileSync(ARQ_STATUS, JSON.stringify(s, null, 2)); } catch (e) { console.error('Backup: não consegui gravar o status:', e.message); }
}

let rodando = null;
function fazerBackup(motivo) {
  if (rodando) return rodando; // um de cada vez
  rodando = (async () => {
    const agora = new Date();
    const status = { quando: agora.toISOString(), motivo: motivo || 'automatico', ok: false };
    try {
      fs.mkdirSync(PASTA, { recursive: true });
      const { args, banco, env } = conexao();
      // Nunca sobrescreve um backup existente (ex.: o de segurança feito antes de restaurar outro).
      let nome = PREFIXO + carimbo(agora).completo + '.dump';
      for (let n = 2; fs.existsSync(path.join(PASTA, nome)); n++) nome = PREFIXO + carimbo(agora).completo + '_' + n + '.dump';
      const arquivo = path.join(PASTA, nome);
      await rodar(acharBinario('pg_dump'), [...args, '-Fc', '-f', arquivo, banco], env);
      const lista = await rodar(acharBinario('pg_restore'), ['--list', arquivo], env);
      if (!/TABLE DATA public vendas/.test(lista)) throw new Error('backup gerado mas incompleto (não achei os dados de vendas nele)');
      status.arquivo = nome;
      status.tamanhoBytes = fs.statSync(arquivo).size;
      status.ok = true;
      limparAntigos(PASTA, agora.getTime());

      const copia = process.env.BACKUP_COPIA;
      if (copia) {
        try {
          fs.mkdirSync(copia, { recursive: true });
          fs.copyFileSync(arquivo, path.join(copia, PREFIXO + carimbo(agora).dia + '.dump'));
          limparAntigos(copia, agora.getTime());
          status.copia = { ok: true, pasta: copia };
        } catch (e) {
          status.copia = { ok: false, pasta: copia, erro: e.message };
        }
      }
    } catch (e) {
      status.erro = e.message;
      console.error('Backup falhou:', e.message);
    }
    const anterior = lerStatus();
    status.ultimoOk = status.ok ? status.quando : anterior && (anterior.ultimoOk || (anterior.ok ? anterior.quando : null)) || null;
    salvarStatus(status);
    return status;
  })().finally(() => { rodando = null; });
  return rodando;
}

function listarBackups() {
  try {
    return fs.readdirSync(PASTA).filter((f) => f.startsWith(PREFIXO) && f.endsWith('.dump'))
      .map((f) => { const st = fs.statSync(path.join(PASTA, f)); return { arquivo: f, tamanhoBytes: st.size, criadoEm: st.mtime.toISOString() }; })
      .sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1));
  } catch { return []; }
}

// Primeiro backup 2 min depois de ligar (não atrasa a subida), depois de hora em hora.
function agendar() {
  if (process.env.BACKUP_DESLIGADO === '1') return;
  setTimeout(() => { fazerBackup('automatico'); setInterval(() => fazerBackup('automatico'), 60 * 60 * 1000); }, 2 * 60 * 1000).unref();
}

module.exports = { fazerBackup, agendar, lerStatus, listarBackups, PASTA, acharBinario, conexao, rodar };

if (require.main === module) {
  fazerBackup('manual').then((s) => {
    if (s.ok) console.log('Backup criado: ' + path.join(PASTA, s.arquivo) + (s.copia ? (s.copia.ok ? '\nCópia em: ' + s.copia.pasta : '\nCópia FALHOU: ' + s.copia.erro) : ''));
    else { console.error('Backup falhou: ' + s.erro); process.exit(1); }
  });
}
