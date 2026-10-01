// Envio das mensagens pros clientes que o painel aprovou (aniversário, cashback, novidade).
// Uma de cada vez, com intervalo de gente (não de robô), só no horário configurado e até o
// limite por dia — disparo em massa é o que mais faz o WhatsApp bloquear número não oficial.
// A fila mora no banco (mensagens_clientes, status 'na_fila'): se o robô ou o WhatsApp cair,
// nada se perde — continua de onde parou quando voltar.
const { LOJA_ID, pool } = require('./config');
const conexao = require('./conexao');

const TZ = process.env.TZ_LOJA || 'America/Fortaleza';
// Intervalo entre uma mensagem e outra (ms). Os testes encurtam pelo .env.
const INTERVALO_MIN = Number(process.env.CAMPANHA_INTERVALO_MIN_MS || 40000);
const INTERVALO_MAX = Number(process.env.CAMPANHA_INTERVALO_MAX_MS || 90000);

let rodando = false;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function horaNaLoja() { return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date())); }
function hojeNaLoja() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); }

async function lerConfig() {
  const { rows } = await pool.query('SELECT mensagens_config FROM lojas WHERE id = $1', [LOJA_ID]);
  const c = (rows.length && rows[0].mensagens_config) || {};
  const n = (v, p) => (Number.isInteger(Number(v)) && v !== null && v !== '' ? Number(v) : p);
  return { limiteDia: n(c.limiteDia, 30), horaInicio: n(c.horaInicio, 9), horaFim: n(c.horaFim, 20) };
}

async function enviadasHoje() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM mensagens_clientes
     WHERE loja_id = $1 AND status = 'enviada' AND NOT enviada_manual AND (enviada_em AT TIME ZONE $2)::date = $3::date`, [LOJA_ID, TZ, hojeNaLoja()]);
  return rows[0].n;
}

// Pode enviar agora? Devolve o motivo quando não.
async function podeEnviar(cfg) {
  const st = conexao.getStatus();
  if (st.estado !== 'conectado') return 'WhatsApp não conectado';
  const h = horaNaLoja();
  if (h < cfg.horaInicio || h >= cfg.horaFim) return 'fora do horário de envio';
  if (await enviadasHoje() >= cfg.limiteDia) return 'limite do dia atingido';
  // Número novo em aquecimento: deixa folga pro atendimento normal.
  const aq = st.aquecimento;
  if (aq && aq.limiteHoje && aq.enviadasHoje >= Math.floor(aq.limiteHoje * 0.6)) return 'número em aquecimento — limite de hoje';
  return null;
}

async function pegarProxima() {
  const { rows } = await pool.query(
    `UPDATE mensagens_clientes SET status = 'enviando' WHERE id = (
       SELECT m.id FROM mensagens_clientes m WHERE m.loja_id = $1 AND m.status = 'na_fila'
       ORDER BY (m.tipo = 'aniversario') DESC, m.aprovada_em, m.criado_em LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, cliente_id, telefone, texto`, [LOJA_ID]);
  return rows[0] || null;
}

async function processar() {
  if (rodando) return;
  rodando = true;
  try {
    for (;;) {
      const cfg = await lerConfig();
      if (await podeEnviar(cfg)) return;
      const m = await pegarProxima();
      if (!m) return;
      // Pediu pra sair depois de aprovada? Não manda.
      const { rows } = await pool.query('SELECT aceita_mensagens FROM clientes WHERE id = $1', [m.cliente_id]);
      if (!rows.length || !rows[0].aceita_mensagens) {
        await pool.query("UPDATE mensagens_clientes SET status = 'descartada' WHERE id = $1", [m.id]);
        continue;
      }
      const r = await conexao.enviarTexto({ telefoneLocal: m.telefone, soSeExistir: true }, m.texto, 'campanha');
      if (r.ok) await pool.query("UPDATE mensagens_clientes SET status = 'enviada', enviada_em = now(), erro = NULL WHERE id = $1", [m.id]);
      else if (r.erro === 'WhatsApp desconectado') { await pool.query("UPDATE mensagens_clientes SET status = 'na_fila' WHERE id = $1", [m.id]); return; }
      else await pool.query("UPDATE mensagens_clientes SET status = 'erro', erro = $2 WHERE id = $1", [m.id, String(r.erro || 'falha ao enviar').slice(0, 300)]);
      await espera(INTERVALO_MIN + Math.random() * Math.max(0, INTERVALO_MAX - INTERVALO_MIN));
    }
  } catch (e) {
    console.error('Envio de mensagens pros clientes:', e.message);
  } finally {
    rodando = false;
  }
}

function iniciar() {
  // Robô reiniciou no meio de um envio: o que ficou "enviando" volta pra fila.
  pool.query("UPDATE mensagens_clientes SET status = 'na_fila' WHERE loja_id = $1 AND status = 'enviando'", [LOJA_ID])
    .catch((e) => console.error('Fila de mensagens:', e.message));
  setInterval(() => processar(), 5 * 60 * 1000).unref();
}

module.exports = { processar, iniciar };
