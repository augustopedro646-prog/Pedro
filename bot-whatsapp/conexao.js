// Conexão com o WhatsApp tipo "WhatsApp Web" (Baileys, pareado por QR Code) — mesma do Jabá, que
// já roda em produção. Não é a API oficial da Meta: existe risco de o número ser bloqueado se
// parecer robô, por isso o ritmo humano no envio e o aquecimento de número novo abaixo.
// A sessão fica salva na pasta ./auth (como uma aba do WhatsApp Web sempre logada).
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const { LOJA_ID, pool, telefoneLocal } = require('./config');
const { responder, RecusaDaIA } = require('./cerebro');
const sair = require('./sair');

const PASTA_AUTH = path.join(__dirname, 'auth');
const ARQ_AQUECIMENTO = path.join(__dirname, 'aquecimento-estado.json');
const HISTORICO_MAX = 30;
// Baileys pede um logger no formato pino — um objeto silencioso basta.
const logger = { level: 'silent', child: () => logger, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

let sock = null;
let iniciando = false;
let tentativas = 0;
let estado = { estado: 'desconectado', qrDataUrl: null, numero: null };

/* ---------- Aquecimento de número novo (só aviso no painel, nunca bloqueia resposta) ---------- */
function lerAquecimento() { try { return JSON.parse(fs.readFileSync(ARQ_AQUECIMENTO, 'utf8')); } catch { return null; } }
function salvarAquecimento(d) { try { fs.writeFileSync(ARQ_AQUECIMENTO, JSON.stringify(d)); } catch (e) { console.error('aquecimento:', e.message); } }
function garantirAquecimento() {
  let a = lerAquecimento();
  if (!a) { a = { primeiraConexaoEm: Date.now(), envios: {} }; salvarAquecimento(a); }
  return a;
}
const hoje = () => new Date().toISOString().slice(0, 10);
function contarEnvio() {
  const a = garantirAquecimento();
  a.envios[hoje()] = (a.envios[hoje()] || 0) + 1;
  const limite = Date.now() - 21 * 864e5;
  Object.keys(a.envios).forEach((d) => { if (new Date(d + 'T00:00:00Z').getTime() < limite) delete a.envios[d]; });
  salvarAquecimento(a);
}
function statusAquecimento() {
  const a = garantirAquecimento();
  const dia = Math.floor((Date.now() - a.primeiraConexaoEm) / 864e5) + 1;
  const limiteHoje = dia <= 2 ? 50 : dia <= 4 ? 100 : dia <= 7 ? 150 : dia <= 14 ? 250 : null;
  return { diaAtual: dia, limiteHoje, enviadasHoje: a.envios[hoje()] || 0, aquecido: limiteHoje === null };
}

/* ---------- Envio com ritmo humano, um de cada vez ---------- */
let fila = Promise.resolve();
function naFila(fn) { const p = fila.then(fn, fn); fila = p.catch(() => {}); return p; }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const entre = (a, b) => a + Math.random() * (b - a);
async function digitando(jid, tamanho) {
  try { await sock.sendPresenceUpdate('composing', jid); } catch {}
  await espera(Math.min(4500, Math.max(900, tamanho * entre(28, 45))));
  try { await sock.sendPresenceUpdate('paused', jid); } catch {}
}

// id do WhatsApp (parte antes do @) → jid completo que o próprio WhatsApp usou ("@s.whatsapp.net"
// ou o endereçamento novo "@lid"). Responder um "@lid" montando "@s.whatsapp.net" some sem erro.
const jidPorId = new Map();
const idDoJid = (jid) => String(jid || '').split('@')[0].split(':')[0];

// `soSeExistir`: devolve null quando o WhatsApp responde que o número não tem conta (mandar
// mensagem pra número inexistente em série é sinal de robô).
async function jidParaTelefone(telefoneLocalCliente, soSeExistir) {
  const numero = '55' + telefoneLocalCliente;
  for (const [id, jid] of jidPorId) if (telefoneLocal(id) === telefoneLocalCliente) return jid;
  try {
    const [r] = await sock.onWhatsApp(numero);
    if (r && r.exists) return r.jid;
    if (soSeExistir) return null;
  } catch {}
  return numero + '@s.whatsapp.net';
}

async function anotarFalha(id, msg) {
  await pool.query(
    `INSERT INTO bot_conversas (loja_id, telefone, ultima_falha_envio) VALUES ($1, $2, $3)
     ON CONFLICT (loja_id, telefone) DO UPDATE SET ultima_falha_envio = $3`, [LOJA_ID, id, msg]).catch(() => {});
}
async function acrescentar(id, mensagem, extra = {}) {
  const { rows } = await pool.query('SELECT mensagens FROM bot_conversas WHERE loja_id = $1 AND telefone = $2', [LOJA_ID, id]);
  const mensagens = [...(rows.length ? rows[0].mensagens : []), mensagem].slice(-HISTORICO_MAX);
  await pool.query(
    `INSERT INTO bot_conversas (loja_id, telefone, mensagens, atualizado_em, nao_lidas) VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (loja_id, telefone) DO UPDATE SET mensagens = EXCLUDED.mensagens, atualizado_em = now(), nao_lidas = bot_conversas.nao_lidas + $4`,
    [LOJA_ID, id, JSON.stringify(mensagens), extra.naoLida ? 1 : 0]);
}

// `destino`: id do WhatsApp de uma conversa existente, ou { telefoneLocal } pra falar com um
// cliente que talvez nunca tenha escrito (aviso de status de pedido feito no site).
// `remetente` ('equipe' | 'sistema' | 'campanha'): grava no histórico — a resposta do robô já é
// gravada pelo cérebro. Com destino.soSeExistir, não envia pra número sem WhatsApp.
async function enviarTexto(destino, texto, remetente) {
  if (SIMULADO) return enviarSimulado(destino, texto, remetente);
  if (!sock || estado.estado !== 'conectado') {
    if (typeof destino === 'string') await anotarFalha(destino, 'WhatsApp desconectado na hora do envio');
    return { ok: false, erro: 'WhatsApp desconectado' };
  }
  return naFila(async () => {
    const jid = typeof destino === 'string' ? (jidPorId.get(destino) || destino + '@s.whatsapp.net') : await jidParaTelefone(destino.telefoneLocal, destino.soSeExistir);
    if (!jid) return { ok: false, erro: 'Esse número não tem WhatsApp' };
    const id = idDoJid(jid);
    try {
      await espera(entre(400, 1200));
      await digitando(jid, texto.length);
      await sock.sendMessage(jid, { text: texto });
      contarEnvio();
      if (remetente) await acrescentar(id, { role: 'assistant', content: texto, remetente });
      await pool.query('UPDATE bot_conversas SET ultima_falha_envio = NULL WHERE loja_id = $1 AND telefone = $2', [LOJA_ID, id]).catch(() => {});
      return { ok: true, id };
    } catch (e) {
      console.error('Falha ao enviar WhatsApp pra ' + id + ':', e.message);
      await anotarFalha(id, e.message);
      return { ok: false, erro: e.message };
    }
  });
}

async function enviarImagem(id, imagem, legenda) {
  if (!sock || estado.estado !== 'conectado') return false;
  return naFila(async () => {
    const jid = jidPorId.get(id) || id + '@s.whatsapp.net';
    try {
      await espera(entre(500, 1400));
      await sock.sendMessage(jid, { image: imagem, caption: legenda || undefined });
      contarEnvio();
      return true;
    } catch (e) { console.error('Falha ao enviar foto:', e.message); return false; }
  });
}

async function conversaPausada(id) {
  const { rows } = await pool.query('SELECT pausado FROM bot_conversas WHERE loja_id = $1 AND telefone = $2', [LOJA_ID, id]);
  return rows.length ? rows[0].pausado : false;
}
async function chamarEquipe(id, motivo) {
  await pool.query(
    `INSERT INTO bot_conversas (loja_id, telefone, precisa_humano, pausado, pausado_em, motivo_humano) VALUES ($1, $2, true, true, now(), $3)
     ON CONFLICT (loja_id, telefone) DO UPDATE SET precisa_humano = true, pausado = true, pausado_em = now(), motivo_humano = $3`, [LOJA_ID, id, motivo]).catch(() => {});
}

async function mensagemRecebida(id, texto, nomePerfil) {
  await pool.query(
    `INSERT INTO bot_conversas (loja_id, telefone, nome_perfil) VALUES ($1, $2, $3)
     ON CONFLICT (loja_id, telefone) DO UPDATE SET nome_perfil = COALESCE($3, bot_conversas.nome_perfil)`,
    [LOJA_ID, id, nomePerfil || null]).catch(() => {});
  if (sair.pediuPraSair(texto)) {
    await acrescentar(id, { role: 'user', content: texto });
    const achou = await sair.descadastrar(telefoneLocal(id)).catch(() => 0);
    if (!achou) await chamarEquipe(id, 'Pediu pra não receber mais avisos — desmarque "aceita mensagens" no cadastro dela');
    await enviarTexto(id, 'Pronto! Você não vai mais receber nossos avisos e novidades por aqui. Se precisar de qualquer coisa, é só chamar 💛', 'sistema');
    return;
  }
  if (await conversaPausada(id)) {
    // Humano assumiu: o robô não responde, só guarda a mensagem pro inbox do painel.
    await acrescentar(id, { role: 'user', content: texto }, { naoLida: true });
    return;
  }
  let resposta;
  try {
    resposta = await responder(texto, {
      telefone: id, telefoneLocal: telefoneLocal(id), nomePerfil,
      enviarImagem: (imagem, legenda) => enviarImagem(id, imagem, legenda),
    });
    await pool.query('UPDATE bot_conversas SET nao_lidas = nao_lidas + 1 WHERE loja_id = $1 AND telefone = $2', [LOJA_ID, id]).catch(() => {});
  } catch (e) {
    // Nunca deixar o cliente no vácuo: avisa, guarda a mensagem e chama a equipe.
    console.error('Resposta automática falhou pra ' + id + ':', e.message);
    await acrescentar(id, { role: 'user', content: texto }, { naoLida: true });
    await chamarEquipe(id, e instanceof RecusaDaIA ? 'O robô não soube responder essa mensagem' : 'Erro no robô: ' + e.message);
    resposta = 'Desculpa, tive um probleminha agora. Já chamei alguém da equipe pra te responder por aqui! 🙏';
    await enviarTexto(id, resposta, 'sistema');
    return;
  }
  await enviarTexto(id, resposta);
}

// Só pra teste automático (BOT_SIMULAR_ENVIO=1 junto com BOT_SEM_WHATSAPP=1): finge que está
// conectado e grava as mensagens "enviadas" no histórico sem falar com o WhatsApp.
const SIMULADO = process.env.BOT_SEM_WHATSAPP === '1' && process.env.BOT_SIMULAR_ENVIO === '1';
if (SIMULADO) estado = { estado: 'conectado', qrDataUrl: null, numero: '5500000000000' };
async function enviarSimulado(destino, texto, remetente) {
  const id = typeof destino === 'string' ? destino : '55' + destino.telefoneLocal;
  if (/falhar-envio/.test(texto)) return { ok: false, erro: 'falha simulada' };
  if (remetente) await acrescentar(id, { role: 'assistant', content: texto, remetente });
  return { ok: true, id };
}

function getStatus() {
  return { ...estado, aquecimento: estado.estado === 'conectado' ? statusAquecimento() : null };
}

async function desconectar() {
  if (sock) { try { await sock.logout(); } catch {} }
  estado = { estado: 'desconectado', qrDataUrl: null, numero: null };
}

async function iniciar() {
  if (iniciando) return;
  iniciando = true;
  if (estado.estado !== 'conectado' && !estado.qrDataUrl) estado = { estado: estado.estado === 'reconectando' ? 'reconectando' : 'conectando', qrDataUrl: null, numero: null };
  try {
    const { state, saveCreds } = await useMultiFileAuthState(PASTA_AUTH);
    sock = makeWASocket({ auth: state, logger, printQRInTerminal: false, markOnlineOnConnect: false });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) estado = { estado: 'aguardando_qr', qrDataUrl: await QRCode.toDataURL(qr), numero: null };
      if (connection === 'open') {
        tentativas = 0;
        estado = { estado: 'conectado', qrDataUrl: null, numero: sock.user && sock.user.id ? idDoJid(sock.user.id) : null };
        garantirAquecimento();
        console.log('WhatsApp conectado como ' + estado.numero);
      }
      if (connection === 'close') {
        const codigo = lastDisconnect && lastDisconnect.error instanceof Boom ? lastDisconnect.error.output.statusCode : undefined;
        iniciando = false;
        if (codigo === DisconnectReason.loggedOut || codigo === DisconnectReason.badSession) {
          // Saiu no celular (ou sessão corrompida): apaga a sessão e o aquecimento — QR novo pode ser outro número.
          try { fs.rmSync(PASTA_AUTH, { recursive: true, force: true }); } catch {}
          try { fs.rmSync(ARQ_AQUECIMENTO, { force: true }); } catch {}
          estado = { estado: 'desconectado', qrDataUrl: null, numero: null };
          setTimeout(iniciar, 1000); // já gera um QR novo pra conectar de novo pelo painel
          return;
        }
        if (codigo === DisconnectReason.connectionReplaced) { estado = { estado: 'substituida', qrDataUrl: null, numero: null }; return; }
        if (codigo === DisconnectReason.restartRequired) { iniciar(); return; }
        tentativas++;
        const ms = Math.min(30000, 2000 * Math.pow(2, tentativas - 1));
        estado = { estado: 'reconectando', qrDataUrl: null, numero: null };
        console.log(`WhatsApp caiu (código ${codigo}) — tentando de novo em ${ms / 1000}s`);
        setTimeout(iniciar, ms);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid || '';
        if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
        const id = idDoJid(jid);
        jidPorId.set(id, jid);
        const texto = msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text)
          || (msg.message.imageMessage && msg.message.imageMessage.caption) || '';
        if (!texto.trim()) {
          enviarTexto(id, 'Recebi sua mensagem, mas por enquanto só consigo ler texto 😊 Pode escrever o que precisa?', 'sistema').catch(() => {});
          continue;
        }
        mensagemRecebida(id, texto.trim(), msg.pushName).catch((e) => console.error('Erro na mensagem de ' + id + ':', e));
      }
    });
  } finally {
    iniciando = false;
  }
}

module.exports = { iniciar, enviarTexto, getStatus, desconectar, mensagemRecebida };
