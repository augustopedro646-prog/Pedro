const express = require('express');
const { pool } = require('../db');
const { exigirAuth, exigirAba, exigirPapel } = require('../auth');

// Mensagens do robô de WhatsApp pros sócios (aba Sócios): lembrete de mensalidade em aberto. A mensagem sai pelo robô
// (POST /prospectar), que cuida do ritmo humano e do limite diário do número e NÃO pausa a conversa — se o sócio
// responder, é o robô quem atende, sabendo o que foi enviado. Cada envio fica em `socios_contatos`.
const router = express.Router();
router.use(exigirAuth, exigirAba('socios'));

const BOT_URL = process.env.BOT_URL || 'http://127.0.0.1:3003';
const FAIXAS = ['ate_2_meses', '3_a_5_meses', '6_meses_ou_mais'];
const DIAS_ENTRE_MENSAGENS = 7;
const MAX_LOTE = 25;

const MODELOS_PADRAO = {
  ate_2_meses: 'Olá, {nome}! Aqui é da ATPN 🙂 Passando pra lembrar, com carinho, que sua mensalidade está em aberto ({meses}). Se já pagou, pode desconsiderar. Qualquer dúvida, é só responder por aqui.',
  '3_a_5_meses': 'Olá, {nome}! Aqui é da ATPN. Sentimos sua falta! Notamos que sua mensalidade está em aberto há {meses}. Quer regularizar? É só responder por aqui que a gente te ajuda.',
  '6_meses_ou_mais': 'Olá, {nome}! Aqui é da ATPN. Faz um tempo que não temos você por aqui e sua mensalidade está em aberto há {meses}. Queremos você de volta! Se quiser retomar, responda por aqui e nossa equipe te ajuda a regularizar.',
};

async function carregarModelos() {
  const { rows } = await pool.query(`SELECT valor FROM bot_config WHERE chave = 'msg-socios-modelos'`);
  let salvos = {};
  try { salvos = rows[0] ? JSON.parse(rows[0].valor) : {}; } catch (e) { salvos = {}; }
  const out = {};
  FAIXAS.forEach((f) => { out[f] = typeof salvos[f] === 'string' && salvos[f].trim() ? salvos[f] : MODELOS_PADRAO[f]; });
  return out;
}

const primeiroNome = (nome) => {
  const p = String(nome || '').trim().split(/\s+/)[0] || '';
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : 'sócio(a)';
};
const textoMeses = (n) => (n === 1 ? '1 mês' : `${n} meses`);

function montarTexto(modelo, socio) {
  const n = Number(socio.mesesEmAberto) || 0;
  return modelo.replace(/\{nome\}/g, primeiroNome(socio.nome)).replace(/\{meses\}/g, n > 0 ? textoMeses(n) : 'alguns meses');
}

// telefone do cadastro -> DDD+número (10 a 13 dígitos) ou null
function telefoneValido(...candidatos) {
  for (const c of candidatos) {
    const d = String(c || '').replace(/\D/g, '');
    if (/^\d{10,11}$/.test(d) || /^55\d{10,11}$/.test(d)) return d;
  }
  return null;
}

async function botFetch(caminho, metodo = 'GET', corpo) {
  const r = await fetch(`${BOT_URL}${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': process.env.BOT_WEBHOOK_SECRET || '' },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(90000),
  });
  const dados = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, dados };
}

async function statusDoBot() {
  try {
    const r = await botFetch('/status');
    if (!r.ok) return { conectado: false, motivo: 'O robô respondeu com erro.' };
    const e = r.dados.estado;
    if (e !== 'conectado') return { conectado: false, motivo: 'O WhatsApp do robô não está conectado (veja a aba WhatsApp).' };
    if (r.dados.pausaGeral) return { conectado: true, pausaGeral: true, motivo: 'O robô está em pausa geral.' };
    return { conectado: true, saude: r.dados.aquecimento || null };
  } catch (err) {
    return { conectado: false, motivo: 'O robô do WhatsApp não está rodando.' };
  }
}

async function buscarSocio(id) {
  const { rows } = await pool.query(
    `SELECT id, nome, status, telefone, telefone_secundario AS "telefoneSecundario", meses_em_aberto AS "mesesEmAberto"
     FROM socios WHERE id = $1`, [id]
  );
  return rows[0] || null;
}

async function contatoRecente(socioId) {
  const { rows } = await pool.query(
    `SELECT enviado_em FROM socios_contatos WHERE socio_id = $1 AND ok AND enviado_em > now() - ($2 || ' days')::interval
     ORDER BY enviado_em DESC LIMIT 1`, [socioId, String(DIAS_ENTRE_MENSAGENS)]
  );
  return rows[0] ? rows[0].enviado_em : null;
}

// envia 1 mensagem e registra; devolve { ok, erro? }
async function enviarUma(socio, texto, pessoaId) {
  const tel = telefoneValido(socio.telefone, socio.telefoneSecundario);
  if (!tel) return { ok: false, erro: 'Sem telefone válido no cadastro' };
  let resultado;
  try {
    const r = await botFetch('/prospectar', 'POST', { telefone: tel, texto });
    resultado = r.ok ? { ok: true } : { ok: false, erro: r.dados.erro || 'falha ao enviar' };
  } catch (err) {
    resultado = { ok: false, erro: 'O robô do WhatsApp não respondeu' };
  }
  await pool.query(
    `INSERT INTO socios_contatos (socio_id, tipo, faixa, telefone, texto, enviado_por, ok, erro) VALUES ($1, 'cobranca', $2, $3, $4, $5, $6, $7)`,
    [socio.id, socio.status, tel, texto, pessoaId, resultado.ok, resultado.erro || null]
  );
  return resultado;
}

router.get('/preparo', async (req, res, next) => {
  try {
    res.json({ modelos: await carregarModelos(), bot: await statusDoBot(), diasEntreMensagens: DIAS_ENTRE_MENSAGENS, maxLote: MAX_LOTE });
  } catch (err) { next(err); }
});

router.put('/modelos', exigirPapel(), async (req, res, next) => {
  try {
    const atuais = await carregarModelos();
    const novos = { ...atuais };
    FAIXAS.forEach((f) => {
      const t = req.body && req.body[f];
      if (typeof t === 'string' && t.trim()) {
        if (t.length > 1000) throw Object.assign(new Error('Texto muito longo (máximo 1000 caracteres)'), { status: 400 });
        novos[f] = t.trim();
      }
    });
    await pool.query(
      `INSERT INTO bot_config (chave, valor, atualizado_em) VALUES ('msg-socios-modelos', $1, now())
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`, [JSON.stringify(novos)]
    );
    res.json({ modelos: novos });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ erro: err.message });
    next(err);
  }
});

// uma mensagem pra um sócio (o texto já vem revisado pela pessoa na tela)
router.post('/enviar/:id', async (req, res, next) => {
  try {
    const socio = await buscarSocio(Number(req.params.id));
    if (!socio) return res.status(404).json({ erro: 'Sócio não encontrado' });
    if (!FAIXAS.includes(socio.status)) return res.status(409).json({ erro: 'Só dá pra mandar lembrete de mensalidade pra sócio com mensalidade em aberto.' });
    const texto = String((req.body && req.body.texto) || '').trim();
    if (!texto) return res.status(400).json({ erro: 'Escreva a mensagem' });
    if (texto.length > 1000) return res.status(400).json({ erro: 'Mensagem muito longa (máximo 1000 caracteres)' });
    const recente = await contatoRecente(socio.id);
    if (recente && !(req.body && req.body.forcar)) {
      return res.status(409).json({ erro: `Esse sócio já recebeu mensagem nos últimos ${DIAS_ENTRE_MENSAGENS} dias.`, jaEnviado: true, enviadoEm: recente });
    }
    const r = await enviarUma(socio, texto, req.usuario.pessoaId);
    if (!r.ok) return res.status(502).json({ erro: r.erro });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// vários de uma vez (só Administrador): roda em segundo plano, um por vez, pela fila do robô (ritmo humano)
let lote = { rodando: false, total: 0, feitos: 0, falhas: 0, iniciadoEm: null };
router.post('/lote', exigirPapel(), async (req, res, next) => {
  try {
    if (lote.rodando) return res.status(409).json({ erro: 'Já tem um envio em lote em andamento.' });
    const ids = [...new Set(((req.body && req.body.ids) || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) return res.status(400).json({ erro: 'Nenhum sócio escolhido' });
    if (ids.length > MAX_LOTE) return res.status(400).json({ erro: `No máximo ${MAX_LOTE} por vez (o número do WhatsApp precisa ser aquecido aos poucos).` });
    const bot = await statusDoBot();
    if (!bot.conectado) return res.status(503).json({ erro: bot.motivo });
    const modelos = await carregarModelos();
    const fila = [];
    const ignorados = [];
    for (const id of ids) {
      const s = await buscarSocio(id);
      if (!s) { ignorados.push({ id, motivo: 'não encontrado' }); continue; }
      if (!FAIXAS.includes(s.status)) { ignorados.push({ id, nome: s.nome, motivo: 'não está com mensalidade em aberto' }); continue; }
      if (!telefoneValido(s.telefone, s.telefoneSecundario)) { ignorados.push({ id, nome: s.nome, motivo: 'sem telefone válido' }); continue; }
      if (await contatoRecente(id)) { ignorados.push({ id, nome: s.nome, motivo: `já recebeu mensagem nos últimos ${DIAS_ENTRE_MENSAGENS} dias` }); continue; }
      fila.push(s);
    }
    if (!fila.length) return res.json({ aceitos: 0, ignorados });
    lote = { rodando: true, total: fila.length, feitos: 0, falhas: 0, iniciadoEm: new Date().toISOString() };
    const pessoaId = req.usuario.pessoaId;
    (async () => {
      for (const s of fila) {
        const r = await enviarUma(s, montarTexto(modelos[s.status], s), pessoaId);
        if (r.ok) lote.feitos += 1; else lote.falhas += 1;
        if (!r.ok && /limite de segurança|desconectado/.test(r.erro || '')) break; // não adianta insistir
      }
      lote.rodando = false;
    })().catch((e) => { console.error('Lote de mensagens falhou:', e.message); lote.rodando = false; });
    res.json({ aceitos: fila.length, ignorados });
  } catch (err) { next(err); }
});

// números do funil (últimos 30 dias) + andamento do lote
router.get('/resumo', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `WITH ult AS (
         SELECT DISTINCT ON (c.socio_id) c.socio_id, c.enviado_em, c.telefone
         FROM socios_contatos c WHERE c.ok AND c.enviado_em > now() - interval '30 days'
         ORDER BY c.socio_id, c.enviado_em DESC
       )
       SELECT count(*)::int AS enviadas,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM bot_conversas b, jsonb_array_elements(b.mensagens) m
                WHERE right(b.telefone, 8) = right(ult.telefone, 8) AND m->>'role' = 'user'
                  AND (m->>'ts')::bigint > extract(epoch FROM ult.enviado_em) * 1000))::int AS responderam,
              count(*) FILTER (WHERE s.status = 'em_dia')::int AS "voltaramAPagar"
       FROM ult JOIN socios s ON s.id = ult.socio_id`
    );
    res.json({ ...rows[0], lote });
  } catch (err) { next(err); }
});

router.modelosPadrao = MODELOS_PADRAO;
module.exports = router;
