const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TITULO = 'Loja Gutto';
const PAGINA = '/painel-gutto.html';
const MAX_TENTATIVAS = 15;

// servidor.txt diz onde está o sistema. Sem ele, usa localhost:3000 (o PC da loja, onde a API roda).
// Aceita "192.168.0.10:3000" (outro PC na mesma rede) ou uma URL completa como
// "https://loja.seudominio.com.br" (acesso pela internet, depois do domínio configurado).
// Procura em vários lugares porque o .exe portátil roda a partir de uma pasta temporária —
// a pasta Documentos é a mais confiável (mesma lição aprendida no Jaba PDV).
function candidatosPastaConfig() {
  const pastas = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) pastas.push(process.env.PORTABLE_EXECUTABLE_DIR);
  pastas.push(path.dirname(process.execPath));
  try { pastas.push(app.getPath('documents')); } catch (e) { /* segue sem essa opção */ }
  pastas.push(path.join(os.homedir(), 'Documents'));
  pastas.push(path.join(os.homedir(), 'Documentos'));
  return pastas;
}

let diagnostico = '';
function lerServidor() {
  const pastas = candidatosPastaConfig();
  for (const dir of pastas) {
    try {
      const arquivo = path.join(dir, 'servidor.txt');
      if (!fs.existsSync(arquivo)) continue;
      const conteudo = fs.readFileSync(arquivo, 'utf8').trim();
      if (conteudo) {
        diagnostico = 'servidor.txt encontrado em: ' + dir;
        return conteudo;
      }
    } catch (e) { /* tenta a próxima pasta */ }
  }
  diagnostico = 'servidor.txt não encontrado (usando localhost:3000). Procurei em:\n' + pastas.map(p => '  - ' + p).join('\n');
  return 'localhost:3000';
}

const SERVIDOR = lerServidor();
const TEM_ESQUEMA = /^https?:\/\//i.test(SERVIDOR);
const ORIGEM = TEM_ESQUEMA ? SERVIDOR.replace(/\/+$/, '') : 'http://' + SERVIDOR;
const APP_URL = ORIGEM + PAGINA;

function mensagemErro() {
  let dica;
  if (/^(localhost|127\.0\.0\.1)/i.test(SERVIDOR)) {
    dica = 'O servidor da Loja Gutto não está ligado neste computador.\n' +
      'Confira o serviço "LojaGuttoAPI" (PowerShell: Get-Service LojaGuttoAPI) ou reinicie o computador.';
  } else if (TEM_ESQUEMA) {
    dica = 'Confira se este computador está com internet e se o computador da loja está ligado.';
  } else {
    dica = 'Confira se este computador está na mesma rede da loja e se o computador principal está ligado.';
  }
  return 'O servidor (' + ORIGEM + ') não respondeu.\n\n' + dica + '\n\n---\n' + diagnostico;
}

let janela = null;

function criarJanela() {
  janela = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: TITULO,
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#FFF8F0',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  janela.once('ready-to-show', () => { janela.maximize(); janela.show(); });

  // A página tem o próprio <title>; a janela e a barra de tarefas ficam sempre "Loja Gutto".
  janela.on('page-title-updated', (e) => { e.preventDefault(); janela.setTitle(TITULO); });

  // Link pra fora do sistema abre no navegador, nunca numa janela solta sem controle.
  janela.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  janela.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGEM)) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });

  // O computador pode ter acabado de ligar e o servidor ainda estar subindo: tenta por ~15s.
  function tentarCarregar(restantes) {
    janela.loadURL(APP_URL).catch(() => {
      if (janela.isDestroyed()) return;
      if (restantes > 0) setTimeout(() => tentarCarregar(restantes - 1), 1000);
      else {
        dialog.showErrorBox('Loja Gutto — não foi possível conectar', mensagemErro());
        app.quit();
      }
    });
  }
  tentarCarregar(MAX_TENTATIVAS);
}

// Só uma janela aberta: clicar no atalho de novo traz a que já está aberta pra frente.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!janela) return;
    if (janela.isMinimized()) janela.restore();
    janela.focus();
  });
  app.whenReady().then(criarJanela);
  app.on('window-all-closed', () => app.quit());
}
