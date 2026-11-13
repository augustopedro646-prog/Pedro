// Impressão direta, sem a janela do Windows: o painel manda o documento (cupom, etiquetas...) pra
// cá e o servidor da loja imprime na impressora escolhida em Configurações → Impressoras.
//   1. o Edge (que já vem no Windows) transforma o HTML em PDF, no tamanho exato da página
//      (rolo do cupom ou linha de etiquetas), pela linha de comando, sem abrir janela;
//   2. o SumatraPDF (vem junto do pacote pdf-to-printer) manda o PDF pra impressora, sem janela.
// Um trabalho por vez (fila), pra cupom e etiqueta não se misturarem.
//
// Testes fora do Windows: IMPRESSAO_SIMULADA_DIR=<pasta> grava o PDF lá em vez de imprimir e
// IMPRESSAO_SIMULADA_IMPRESSORAS="Epson,Elgin" é a lista de impressoras; NAVEGADOR_PDF=<caminho>
// aponta o Chrome/Edge (no Windows ele é achado sozinho).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

class ErroImpressao extends Error {
  constructor(msg, status) { super(msg); this.status = status || 502; }
}

const windows = process.platform === 'win32';
function simulada() { return !windows && !!process.env.IMPRESSAO_SIMULADA_DIR; }
function disponivel() { return windows || simulada(); }

function caminhoNavegador() {
  const candidatos = [process.env.NAVEGADOR_PDF,
    windows && path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    windows && path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    windows && path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    windows && path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
  ].filter(Boolean);
  const achado = candidatos.find((c) => { try { return fs.statSync(c).isFile(); } catch (e) { return false; } });
  if (!achado) throw new ErroImpressao('Não achei o Edge neste computador pra preparar a impressão', 503);
  return achado;
}

function rodar(arquivo, args, tempoMs) {
  return new Promise((resolve, reject) => {
    execFile(arquivo, args, { timeout: tempoMs, windowsHide: true }, (erro, stdout, stderr) => (erro ? reject(Object.assign(erro, { stderr })) : resolve(stdout)));
  });
}

// O documento vem do painel: nada de fora entra no PDF (sem rede, sem arquivos, sem scripts).
const BLOQUEIO = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:">';
function blindar(html) {
  const s = String(html);
  const i = s.search(/<head[^>]*>/i);
  if (i < 0) return '<!doctype html><html><head><meta charset="utf-8">' + BLOQUEIO + '</head><body>' + s + '</body></html>';
  const fim = s.indexOf('>', i) + 1;
  return s.slice(0, fim) + BLOQUEIO + s.slice(fim);
}

async function gerarPdf(html, pasta) {
  const entrada = path.join(pasta, 'documento.html'), saida = path.join(pasta, 'documento.pdf');
  fs.writeFileSync(entrada, blindar(html), 'utf8');
  const args = ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--user-data-dir=' + path.join(pasta, 'perfil'), '--no-pdf-header-footer', '--print-to-pdf-no-header',
    '--print-to-pdf=' + saida, 'file:///' + entrada.replace(/\\/g, '/').replace(/^\/+/, '')];
  if (!windows && process.getuid && process.getuid() === 0) args.unshift('--no-sandbox');
  try { await rodar(caminhoNavegador(), args, 45000); } catch (e) {
    if (e instanceof ErroImpressao) throw e;
    // Às vezes o navegador grava o PDF e demora a fechar: com o arquivo pronto, segue.
    const pronto = fs.existsSync(saida) && fs.statSync(saida).size > 0;
    if (!pronto) throw new ErroImpressao('Não consegui preparar a impressão (' + (e.killed ? 'demorou demais' : e.message.split('\n')[0]) + ')');
  }
  if (!fs.existsSync(saida) || !fs.statSync(saida).size) throw new ErroImpressao('Não consegui preparar a impressão (PDF vazio)');
  return saida;
}

async function listarImpressoras() {
  if (simulada()) return (process.env.IMPRESSAO_SIMULADA_IMPRESSORAS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!windows) throw new ErroImpressao('Impressão direta só funciona no computador da loja (Windows)', 503);
  const { getPrinters } = require('pdf-to-printer');
  return (await getPrinters()).map((p) => p.name);
}

let fila = Promise.resolve();
let contador = 0;
// opcoes: { orientacao: 'retrato' | 'paisagem' | '' (automática) }
function imprimir(html, impressora, opcoes = {}) {
  if (!disponivel()) return Promise.reject(new ErroImpressao('Impressão direta só funciona no computador da loja (Windows)', 503));
  if (!impressora) return Promise.reject(new ErroImpressao('Escolha a impressora em Configurações → Impressoras', 400));
  const trabalho = fila.then(async () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'gutto-impressao-'));
    try {
      const pdf = await gerarPdf(html, pasta);
      if (simulada()) {
        contador += 1;
        const destino = path.join(process.env.IMPRESSAO_SIMULADA_DIR, String(contador).padStart(3, '0') + '-' + impressora.replace(/[^\w.-]+/g, '_') + '.pdf');
        fs.copyFileSync(pdf, destino);
        return { impressora, arquivo: destino };
      }
      const { print } = require('pdf-to-printer');
      const orientacao = opcoes.orientacao === 'retrato' ? 'portrait' : opcoes.orientacao === 'paisagem' ? 'landscape' : undefined;
      try {
        await print(pdf, { printer: impressora, scale: 'noscale', ...(orientacao ? { orientation: orientacao } : {}) });
      } catch (e) {
        throw new ErroImpressao('A impressora "' + impressora + '" não aceitou (' + String(e.message || e).split('\n')[0] + ')');
      }
      return { impressora };
    } finally {
      fs.rm(pasta, { recursive: true, force: true }, () => {});
    }
  });
  fila = trabalho.catch(() => {});
  return trabalho;
}

module.exports = { ErroImpressao, disponivel, listarImpressoras, imprimir, blindar };
