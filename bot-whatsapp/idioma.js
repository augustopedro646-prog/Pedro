// Idioma da conversa (português / espanhol / inglês) — 16/10/2026.
// O próprio Claude responde no idioma do cliente (regra no SYSTEM_PROMPT). Este módulo cuida do resto:
//  - detecta o idioma do texto que o cliente mandou (heurística simples, sem custo de API);
//  - guarda por conversa (bot_conversas.idioma) pra usar nas mensagens FIXAS do robô, que não passam pelo Claude
//    (confirmação do pedido, "saiu pra entrega", cashback na entrega, avisos de áudio/foto, erro técnico, lembrete do chamado);
//  - tabela dessas mensagens fixas nas 3 línguas (MSG / msg()).
// Na dúvida (texto curto tipo "ok", "👍", número de endereço) NÃO troca o idioma salvo.
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', (err) => console.error('Erro inesperado no pool do Postgres (idioma):', err));
const LOJA_ID = process.env.LOJA_ID || '1';
const IDIOMAS = ['pt', 'es', 'en'];

let colunaOk = null;
function garantirColuna() {
  if (!colunaOk) {
    colunaOk = pool.query('ALTER TABLE bot_conversas ADD COLUMN IF NOT EXISTS idioma TEXT')
      .catch((e) => { colunaOk = null; console.error('Falha ao criar bot_conversas.idioma:', e.message); });
  }
  return colunaOk;
}

// palavras que quase só aparecem num dos três idiomas (sem acento, minúsculas)
const PALAVRAS = {
  pt: ['oi', 'ola', 'voce', 'voces', 'nao', 'obrigado', 'obrigada', 'quero', 'queria', 'gostaria', 'pra', 'pro', 'tem', 'tenho', 'sim',
    'bom', 'boa', 'dia', 'tarde', 'noite', 'cardapio', 'entrega', 'entregam', 'quanto', 'custa', 'fica', 'ate', 'vcs', 'vc', 'blz',
    'beleza', 'tudo', 'bem', 'ainda', 'aberto', 'aberta', 'hoje', 'agora', 'onde', 'endereco', 'fazer', 'ta', 'com',
    'uma', 'um', 'muito', 'mais', 'tambem', 'nao', 'meu', 'minha', 'qual', 'quais', 'posso', 'pode', 'preco', 'troco', 'cartao'],
  es: ['hola', 'quiero', 'quisiera', 'gracias', 'buenos', 'buenas', 'usted', 'ustedes', 'cuanto', 'cuesta', 'tienen', 'tiene', 
    'necesito', 'donde', 'estan', 'abierto', 'hoy', 'ahora', 'hacer', 'el', 'los', 'las', 'del', 'y', 'muy',
    'tambien', 'puedo', 'puede', 'comida', 'precio', 'direccion', 'tarjeta', 'efectivo', 'cambio', 'mi', 'una', 'un',
    'con', 'llevar', 'domicilio', 'envio', 'cuando', 'cual', 'si', 'senor', 'amigo', 'bueno', 'pues'],
  en: ['hi', 'hello', 'hey', 'thanks', 'thank', 'please', 'want', 'would', 'like', 'the', 'is', 'are', 'does', 'you', 'your',
    'can', 'could', 'how', 'much', 'open', 'what', 'where', 'order', 'deliver', 'i', 'im', 'my', 'we', 'good',
    'morning', 'afternoon', 'evening', 'food', 'price', 'address', 'card', 'cash', 'change', 'have', 'there', 'today', 'now', 
    'and', 'with', 'of', 'to', 'for', 'yes', 'pickup', 'take', 'away', 'english', 'speak']
};
// palavras ambíguas entre pt/es pesam menos; marcas fortes pesam mais
const FORTES = {
  pt: ['voce', 'voces', 'nao', 'obrigado', 'obrigada', 'cardapio', 'pra', 'pro', 'vcs', 'vc', 'oi', 'tambem', 'endereco', 'gostaria'],
  es: ['hola', 'gracias', 'quiero', 'quisiera', 'usted', 'ustedes', 'cuanto', 'cuesta', 'tienen', 'necesito', 'muy', 'los', 'las', 'efectivo', 'senor', 'pues'],
  en: ['hi', 'hello', 'hey', 'thanks', 'thank', 'please', 'the', 'would', 'want', 'you', 'your', 'what', 'how', 'english', 'speak', 'im']
};
const ROTULO = { pt: 'português', es: 'espanhol', en: 'inglês' };

function semAcento(t) { return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

function detectarIdioma(texto) {
  const bruto = String(texto || '').replace(/\[[^\]]*\]/g, ' ');
  if (!/[a-zA-ZÀ-ÿ]/.test(bruto)) return null;
  const pts = { pt: 0, es: 0, en: 0 };
  if (/[¿¡ñÑ]/.test(bruto)) pts.es += 3;
  if (/[ãõçÃÕÇ]/.test(bruto)) pts.pt += 3;
  const tokens = semAcento(bruto).replace(/'/g, '').split(/[^a-z]+/).filter(Boolean);
  for (const tk of tokens) {
    for (const l of IDIOMAS) {
      if (PALAVRAS[l].includes(tk)) pts[l] += FORTES[l].includes(tk) ? 2 : 1;
    }
  }
  const ordem = IDIOMAS.slice().sort((a, b) => pts[b] - pts[a]);
  const [primeiro, segundo] = ordem;
  if (pts[primeiro] < 2) return null;            // pouca evidência ("ok", "sim", número...)
  if (pts[primeiro] - pts[segundo] < 2) return null; // empate técnico — mantém o que já estava
  return primeiro;
}

// telefone = chave da conversa (dígitos do JID). Também aceita o telefone "de pedido" (sem 55), procurando em telefone_real.
async function obterIdioma(telefone) {
  try {
    await garantirColuna();
    const dig = String(telefone || '').replace(/\D/g, '');
    if (!dig) return null;
    const variantes = [dig, dig.startsWith('55') ? dig.slice(2) : '55' + dig];
    const { rows } = await pool.query(
      `SELECT idioma FROM bot_conversas WHERE loja_id = $1 AND idioma IS NOT NULL
         AND (telefone = ANY($2) OR telefone_real = ANY($2)) ORDER BY atualizado_em DESC NULLS LAST LIMIT 1`,
      [LOJA_ID, variantes]
    );
    return rows.length && IDIOMAS.includes(rows[0].idioma) ? rows[0].idioma : null;
  } catch (e) { console.error('Falha ao ler idioma da conversa:', e.message); return null; }
}
async function salvarIdioma(telefone, idioma) {
  if (!IDIOMAS.includes(idioma)) return;
  try {
    await garantirColuna();
    await pool.query(
      `INSERT INTO bot_conversas (loja_id, telefone, idioma) VALUES ($1, $2, $3)
       ON CONFLICT (loja_id, telefone) DO UPDATE SET idioma = EXCLUDED.idioma`,
      [LOJA_ID, telefone, idioma]
    );
  } catch (e) { console.error('Falha ao salvar idioma da conversa:', e.message); }
}
// idioma desta mensagem: o detectado no texto (e salva) ou, se não der pra saber, o que já estava salvo
async function idiomaDaMensagem(telefone, texto) {
  const det = detectarIdioma(texto);
  if (det) { await salvarIdioma(telefone, det); return det; }
  return (await obterIdioma(telefone)) || 'pt';
}

// ---------- mensagens fixas ----------
const MSG = {
  falhaTecnica: {
    pt: 'Desculpa, tive um probleminha técnico bem agora. Pode mandar sua mensagem de novo? Se for urgente, já chamei alguém da equipe pra te ajudar.',
    es: 'Disculpa, tuve un pequeño problema técnico. ¿Puedes enviar tu mensaje de nuevo? Si es urgente, ya llamé a alguien del equipo para ayudarte.',
    en: 'Sorry, I just had a small technical problem. Could you send your message again? If it’s urgent, I’ve already asked someone from our team to help you.'
  },
  confirmarComEquipe: {
    pt: 'Deixa eu confirmar isso com a equipe e já te retorno por aqui.',
    es: 'Déjame confirmarlo con el equipo y te respondo por aquí enseguida.',
    en: 'Let me check that with our team and I’ll get back to you here shortly.'
  },
  lembreteChamado: {
    pt: 'Oi! Já avisei a equipe sobre o seu atendimento e logo alguém te responde por aqui, tá? Obrigado por esperar 🙏',
    es: '¡Hola! Ya avisé al equipo sobre tu atención y pronto alguien te responde por aquí. ¡Gracias por esperar! 🙏',
    en: 'Hi! I’ve already let our team know and someone will reply to you here soon. Thanks for waiting! 🙏'
  },
  midiaNaoSuportada: {
    pt: 'Recebi sua mensagem, mas por aqui só consigo ler texto, fotos e áudios — pode escrever o que precisa?',
    es: 'Recibí tu mensaje, pero por aquí solo puedo leer texto, fotos y audios. ¿Puedes escribir lo que necesitas?',
    en: 'I got your message, but here I can only read text, photos and voice messages — could you type what you need?'
  },
  imagemFormato: {
    pt: 'Recebi sua imagem, mas não consegui abrir esse formato — pode mandar como foto normal ou escrever?',
    es: 'Recibí tu imagen, pero no pude abrir ese formato. ¿Puedes enviarla como foto normal o escribir?',
    en: 'I got your image, but I couldn’t open that format — could you send it as a regular photo or type instead?'
  },
  imagemGrande: {
    pt: 'Essa foto ficou grande demais pra eu abrir — pode mandar uma menor ou escrever o que precisa?',
    es: 'Esa foto es demasiado grande para abrirla. ¿Puedes enviar una más pequeña o escribir lo que necesitas?',
    en: 'That photo is too large for me to open — could you send a smaller one or type what you need?'
  },
  audioIndisponivel: {
    pt: 'No momento não consigo escutar o áudio, teria como escrever?',
    es: 'En este momento no puedo escuchar audios, ¿podrías escribirlo?',
    en: 'I can’t listen to voice messages right now — could you type it instead?'
  },
  audioLongo: {
    pt: 'Seu áudio ficou longo demais pra eu ouvir — pode mandar um mais curto ou escrever?',
    es: 'Tu audio es demasiado largo para escucharlo. ¿Puedes enviar uno más corto o escribir?',
    en: 'Your voice message is too long for me — could you send a shorter one or type instead?'
  },
  audioIncompreensivel: {
    pt: 'Não consegui entender seu áudio — pode repetir ou escrever?',
    es: 'No pude entender tu audio. ¿Puedes repetirlo o escribir?',
    en: 'I couldn’t understand your voice message — could you repeat it or type instead?'
  },
  mensagemIlegivel: {
    pt: 'Não consegui abrir sua mensagem agora — pode escrever o que precisa?',
    es: 'No pude abrir tu mensaje ahora. ¿Puedes escribir lo que necesitas?',
    en: 'I couldn’t open your message just now — could you type what you need?'
  }
};
// avisos que a conexão monta antes de saber o idioma (extrairMidia) chegam com o texto em português — troca pelo equivalente
function traduzirAviso(textoPt, idioma) {
  if (!idioma || idioma === 'pt') return textoPt;
  for (const k of Object.keys(MSG)) if (MSG[k].pt === textoPt) return MSG[k][idioma] || textoPt;
  return textoPt;
}
function msg(chave, idioma) { const m = MSG[chave]; return m ? (m[idioma] || m.pt) : ''; }

module.exports = { IDIOMAS, ROTULO, detectarIdioma, obterIdioma, salvarIdioma, idiomaDaMensagem, msg, traduzirAviso };
