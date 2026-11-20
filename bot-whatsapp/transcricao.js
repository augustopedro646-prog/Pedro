// Transcrição de áudio (voz → texto) pro robô ler áudios de clientes. A Anthropic NÃO aceita áudio, então usa um
// serviço de transcrição compatível com a API da OpenAI (`/audio/transcriptions`): serve a própria OpenAI
// (modelo whisper-1) ou a Groq (https://api.groq.com/openai/v1, modelo whisper-large-v3-turbo, tem faixa grátis).
// Configuração em bot-whatsapp/.env:
//   STT_API_KEY=...            (sem isso o robô continua pedindo pra o cliente escrever)
//   STT_BASE_URL=https://api.openai.com/v1      (padrão)
//   STT_MODEL=whisper-1                         (padrão)
// ATENÇÃO de privacidade: o áudio do cliente é enviado a esse serviço de terceiros só pra ser transcrito.
require('dotenv').config();

function transcricaoConfigurada() {
  return !!process.env.STT_API_KEY;
}

// idioma: 'pt' | 'es' | 'en' quando já se sabe o idioma da conversa; sem ele, o serviço detecta sozinho (turista que manda áudio de cara)
async function transcrever(buffer, mimetype, idioma) {
  if (!transcricaoConfigurada()) return null;
  const base = (process.env.STT_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const modelo = process.env.STT_MODEL || 'whisper-1';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: (mimetype || 'audio/ogg').split(';')[0] }), 'audio.ogg');
  form.append('model', modelo);
  if (['pt', 'es', 'en'].includes(idioma)) form.append('language', idioma);
  form.append('response_format', 'json');
  const r = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STT_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(45000)
  });
  if (!r.ok) throw new Error(`transcrição falhou (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return String(j.text || '').trim();
}

module.exports = { transcrever, transcricaoConfigurada };
