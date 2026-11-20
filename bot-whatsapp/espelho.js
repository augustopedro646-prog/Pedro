// Espelho das conversas do WhatsApp (estilo WhatsApp Web): guarda TODAS as conversas individuais do número conectado —
// as que o robô atende, as que o dono responde pelo celular e as de contatos que nunca falaram com o robô — pra aba
// WhatsApp do painel mostrar tudo, mesmo o que chegou com o PDV fechado. Alimentado pelos eventos do Baileys
// (messaging-history.set no momento de conectar o aparelho, messages.upsert ao vivo, chats/contacts pra nomes) e pelas
// mensagens que o próprio robô/painel envia. Grupos, status e canais ficam de fora.
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', (err) => console.error('Erro inesperado no pool do Postgres (espelho):', err));
const LOJA_ID = process.env.LOJA_ID || '1';

let tabelasProntas = null;
function garantirTabelas() {
  if (!tabelasProntas) {
    tabelasProntas = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS wa_chats (
        loja_id INTEGER NOT NULL, telefone TEXT NOT NULL, jid TEXT, nome TEXT, telefone_real TEXT,
        ultimo_ts BIGINT, ultimo_texto TEXT, ultimo_de_mim BOOLEAN NOT NULL DEFAULT false,
        PRIMARY KEY (loja_id, telefone))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS wa_mensagens (
        loja_id INTEGER NOT NULL, id TEXT NOT NULL, telefone TEXT NOT NULL, de_mim BOOLEAN NOT NULL DEFAULT false,
        remetente TEXT, texto TEXT NOT NULL, ts BIGINT NOT NULL, PRIMARY KEY (loja_id, id))`);
      await pool.query('CREATE INDEX IF NOT EXISTS wa_mensagens_chat_idx ON wa_mensagens (loja_id, telefone, ts)');
    })().catch((e) => { tabelasProntas = null; throw e; });
  }
  return tabelasProntas;
}

function chaveDoJid(jid) { return String(jid || '').split('@')[0].split(':')[0]; }
function jidIndividual(jid) { return /@(s\.whatsapp\.net|lid)$/.test(String(jid || '')); }
function telefoneRealDeJid(jid, alt) {
  const pega = (j) => {
    if (!String(j || '').endsWith('@s.whatsapp.net')) return '';
    let d = chaveDoJid(j).replace(/\D/g, '');
    if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
    return d;
  };
  return pega(jid) || pega(alt);
}
function tsEmMs(t) {
  if (t == null) return Date.now();
  const n = typeof t === 'object' ? Number(t.toString()) : Number(t);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1e12 ? n * 1000 : n; // Baileys manda segundos
}

// texto legível de qualquer tipo de mensagem (mídia vira um rótulo; reação/protocolo/etc. não entram)
function textoDaMensagem(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) { // desembrulha mensagem temporária / visualização única / documento com legenda / editada
    const inner = (m.ephemeralMessage && m.ephemeralMessage.message) || (m.viewOnceMessage && m.viewOnceMessage.message)
      || (m.viewOnceMessageV2 && m.viewOnceMessageV2.message) || (m.documentWithCaptionMessage && m.documentWithCaptionMessage.message)
      || (m.editedMessage && m.editedMessage.message);
    if (!inner) break;
    m = inner;
  }
  if (!m) return '';
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage && m.extendedTextMessage.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return '📷 Foto' + (m.imageMessage.caption ? ' — ' + m.imageMessage.caption : '');
  if (m.videoMessage) return '🎥 Vídeo' + (m.videoMessage.caption ? ' — ' + m.videoMessage.caption : '');
  if (m.audioMessage) return '🎤 Áudio';
  if (m.documentMessage) return '📄 ' + (m.documentMessage.fileName || 'Documento');
  if (m.stickerMessage) return 'Figurinha';
  if (m.locationMessage || m.liveLocationMessage) return '📍 Localização';
  if (m.contactMessage || m.contactsArrayMessage) return '👤 Contato';
  return '';
}

async function salvarMensagemCom(client, msg, opts = {}) {
  const key = msg && msg.key;
  if (!key || !key.id || !jidIndividual(key.remoteJid)) return false;
  const texto = textoDaMensagem(msg.message);
  if (!texto) return false;
  const telefone = chaveDoJid(key.remoteJid);
  if (!telefone) return false;
  const deMim = !!key.fromMe;
  const ts = tsEmMs(msg.messageTimestamp);
  const remetente = deMim ? (opts.remetente || 'equipe') : null;
  const nome = !deMim && msg.pushName ? String(msg.pushName).trim().slice(0, 120) || null : null;
  const real = telefoneRealDeJid(key.remoteJid, key.remoteJidAlt || key.senderPn);
  await client.query(
    `INSERT INTO wa_mensagens (loja_id, id, telefone, de_mim, remetente, texto, ts) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (loja_id, id) DO ${opts.forcarRemetente ? 'UPDATE SET remetente = EXCLUDED.remetente' : 'NOTHING'}`,
    [LOJA_ID, key.id, telefone, deMim, remetente, texto.slice(0, 4000), ts]
  );
  await client.query(
    `INSERT INTO wa_chats (loja_id, telefone, jid, nome, telefone_real, ultimo_ts, ultimo_texto, ultimo_de_mim)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (loja_id, telefone) DO UPDATE SET
       jid = COALESCE(EXCLUDED.jid, wa_chats.jid),
       nome = COALESCE(EXCLUDED.nome, wa_chats.nome),
       telefone_real = COALESCE(NULLIF(EXCLUDED.telefone_real, ''), wa_chats.telefone_real),
       ultimo_texto = CASE WHEN wa_chats.ultimo_ts IS NULL OR EXCLUDED.ultimo_ts >= wa_chats.ultimo_ts THEN EXCLUDED.ultimo_texto ELSE wa_chats.ultimo_texto END,
       ultimo_de_mim = CASE WHEN wa_chats.ultimo_ts IS NULL OR EXCLUDED.ultimo_ts >= wa_chats.ultimo_ts THEN EXCLUDED.ultimo_de_mim ELSE wa_chats.ultimo_de_mim END,
       ultimo_ts = GREATEST(COALESCE(wa_chats.ultimo_ts, 0), EXCLUDED.ultimo_ts)`,
    [LOJA_ID, telefone, key.remoteJid, nome, real || null, ts, texto.slice(0, 300), deMim]
  );
  return true;
}

async function salvarMensagem(msg, opts) {
  await garantirTabelas();
  const client = await pool.connect();
  try { return await salvarMensagemCom(client, msg, opts); } finally { client.release(); }
}

async function salvarNome(jid, nome) {
  const n = nome && String(nome).trim().slice(0, 120);
  if (!n || !jidIndividual(jid)) return;
  await garantirTabelas();
  await pool.query(
    `INSERT INTO wa_chats (loja_id, telefone, jid, nome, telefone_real) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (loja_id, telefone) DO UPDATE SET nome = EXCLUDED.nome, jid = COALESCE(wa_chats.jid, EXCLUDED.jid)`,
    [LOJA_ID, chaveDoJid(jid), jid, n, telefoneRealDeJid(jid) || null]
  );
}

// histórico que o WhatsApp entrega ao conectar o aparelho (chats, contatos e mensagens antigas)
async function salvarHistorico({ chats, contacts, messages }) {
  await garantirTabelas();
  let nMsgs = 0, nNomes = 0;
  for (const c of contacts || []) { try { await salvarNome(c.id, c.name || c.notify || c.verifiedName); nNomes++; } catch (e) { /* um contato ruim não derruba o resto */ } }
  for (const c of chats || []) { try { await salvarNome(c.id, c.name || c.displayName); } catch (e) { /* idem */ } }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let i = 0;
    for (const m of messages || []) {
      try { if (await salvarMensagemCom(client, m, { remetente: 'equipe' })) nMsgs++; } catch (e) { /* idem */ }
      if (++i % 500 === 0) { await client.query('COMMIT'); await client.query('BEGIN'); }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  console.log(`Espelho: histórico recebido — ${nMsgs} mensagens, ${nNomes} contatos.`);
}

async function listarChats(limite = 400) {
  await garantirTabelas();
  const { rows } = await pool.query(
    `SELECT telefone, jid, nome, telefone_real, ultimo_ts, ultimo_texto, ultimo_de_mim FROM wa_chats
     WHERE loja_id = $1 AND ultimo_ts IS NOT NULL ORDER BY ultimo_ts DESC LIMIT $2`, [LOJA_ID, limite]);
  return rows.map((r) => ({ telefone: r.telefone, jid: r.jid, nome: r.nome, telefoneReal: r.telefone_real, ts: Number(r.ultimo_ts), texto: r.ultimo_texto, deMim: r.ultimo_de_mim }));
}

async function mensagensDoChat(telefone, limite = 400) {
  await garantirTabelas();
  const { rows } = await pool.query(
    `SELECT de_mim, remetente, texto, ts FROM wa_mensagens WHERE loja_id = $1 AND telefone = $2 ORDER BY ts DESC LIMIT $3`,
    [LOJA_ID, telefone, limite]);
  return rows.reverse().map((r) => (r.de_mim
    ? { role: 'assistant', content: r.texto, ts: Number(r.ts), remetente: r.remetente || 'equipe' }
    : { role: 'user', content: r.texto, ts: Number(r.ts) }));
}

async function jidDoChat(telefone) {
  await garantirTabelas();
  const { rows } = await pool.query('SELECT jid FROM wa_chats WHERE loja_id = $1 AND telefone = $2', [LOJA_ID, telefone]);
  return rows.length ? rows[0].jid : null;
}

module.exports = { garantirTabelas, salvarMensagem, salvarNome, salvarHistorico, listarChats, mensagensDoChat, jidDoChat };
