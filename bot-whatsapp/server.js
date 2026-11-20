require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const conexao = require('./conexao');
const espelho = require('./espelho');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY não definido em bot-whatsapp/.env — cole a chave da Anthropic (console.anthropic.com) no .env antes de subir o bot.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', (err) => console.error('Erro inesperado no pool do Postgres (server):', err));

const LOJA_ID = process.env.LOJA_ID || '1';

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

// segredo compartilhado com a API principal (mesmo BOT_WEBHOOK_SECRET de sempre) — este serviço
// só escuta em 127.0.0.1 (nunca exposto pra internet), então isso é uma segunda camada, não a
// única proteção. Mesmo padrão de exigirSegredoImpressora em server/routes/whatsapp.js.
function exigirSegredoBot(req, res, next) {
  // a API principal manda o segredo do aviso de status como X-Bot-Webhook-Secret e o das demais rotas como X-Bot-Secret — aceita os dois
  // (antes só o segundo era aceito, então TODO aviso de status levava 401 e nunca chegava ao cliente)
  const recebido = req.headers['x-bot-secret'] || req.headers['x-bot-webhook-secret'] || '';
  const esperado = process.env.BOT_WEBHOOK_SECRET || '';
  const bufA = Buffer.from(recebido);
  const bufB = Buffer.from(esperado);
  const valido = !!esperado && bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
  if (!valido) return res.status(401).json({ erro: 'segredo inválido' });
  next();
}

app.get('/status', exigirSegredoBot, (req, res) => {
  res.json(conexao.getStatus());
});

app.post('/pausa', exigirSegredoBot, (req, res) => {
  conexao.definirPausaGeral(!!(req.body && req.body.ativa));
  res.json({ ok: true, pausaGeral: !!(req.body && req.body.ativa) });
});

app.post('/desconectar', exigirSegredoBot, async (req, res) => {
  await conexao.desconectar();
  res.json({ ok: true });
});

app.post('/enviar', exigirSegredoBot, async (req, res) => {
  const { telefone, texto } = req.body || {};
  if (!telefone || !texto) return res.status(400).json({ erro: 'telefone e texto são obrigatórios' });
  // número "de verdade" (DDD+número, com ou sem 55 — 10 a 13 dígitos) que ainda não tem conversa: resolve o JID certo no próprio
  // WhatsApp (o 9 extra do Brasil às vezes não existe) em vez de mandar pra um JID inventado. ID de conversa (LID) tem 14+ dígitos
  // e segue o caminho de sempre abaixo.
  let jidConhecido = null;
  try { jidConhecido = await espelho.jidDoChat(String(telefone)); } catch (e) { /* sem espelho: segue o caminho normal */ }
  if (jidConhecido) {
    await pool.query(
      `INSERT INTO bot_conversas (loja_id, telefone, pausado, pausado_em)
       VALUES ($1, $2, true, now())
       ON CONFLICT (loja_id, telefone) DO UPDATE SET pausado = true, pausado_em = now()`,
      [LOJA_ID, String(telefone)]
    );
    const r0 = await conexao.enviarMensagem(jidConhecido, texto, { remetente: 'equipe' });
    if (!r0.ok) return res.status(502).json({ erro: r0.erro || 'falha ao enviar' });
    return res.json({ ok: true });
  }
  if (/^\d{10,13}$/.test(String(telefone))) {
    const r = await conexao.enviarParaNumero(String(telefone), texto, { remetente: 'equipe' });
    if (!r.ok) return res.status(502).json({ erro: r.erro || 'falha ao enviar' });
    return res.json({ ok: true });
  }
  // INSERT...ON CONFLICT porque a equipe pode mandar a primeira mensagem pra um número que ainda
  // nunca escreveu pro bot (a linha em bot_conversas ainda não existe) — UPDATE simples não criaria
  await pool.query(
    `INSERT INTO bot_conversas (loja_id, telefone, pausado, pausado_em)
     VALUES ($1, $2, true, now())
     ON CONFLICT (loja_id, telefone) DO UPDATE SET pausado = true, pausado_em = now()`,
    [LOJA_ID, telefone]
  );
  const resultado = await conexao.enviarMensagem(telefone, texto, { remetente: 'equipe' });
  if (!resultado.ok) return res.status(502).json({ erro: resultado.erro || 'falha ao enviar' });
  res.json({ ok: true });
});

app.post('/reativar-bot', exigirSegredoBot, async (req, res) => {
  const { telefone } = req.body || {};
  if (!telefone) return res.status(400).json({ erro: 'telefone é obrigatório' });
  await pool.query(
    `UPDATE bot_conversas SET pausado = false, precisa_humano = false WHERE loja_id = $1 AND telefone = $2`,
    [LOJA_ID, telefone]
  );
  // devolver pro robô encerra o chamado aberto desse cliente (senão o lembrete de "sem resposta" dispararia à toa)
  await pool.query(
    `UPDATE bot_chamados SET status = 'respondido', respondido_em = now() WHERE loja_id = $1 AND telefone = $2 AND status = 'aberto'`,
    [LOJA_ID, telefone]
  ).catch(() => {});
  res.json({ ok: true });
});

app.get('/conversas', exigirSegredoBot, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT telefone, nome, telefone_real, mensagens, precisa_humano, pausado, ultima_falha_envio, atualizado_em
     FROM bot_conversas WHERE loja_id = $1 ORDER BY atualizado_em DESC LIMIT 200`,
    [LOJA_ID]
  );
  const porTelefone = new Map(rows.map(r => [r.telefone, {
    telefone: r.telefone,
    nome: r.nome,
    telefoneReal: r.telefone_real,
    ultimaMensagem: r.mensagens.length ? r.mensagens[r.mensagens.length - 1] : null,
    precisaHumano: r.precisa_humano,
    pausado: r.pausado,
    ultimaFalhaEnvio: r.ultima_falha_envio,
    atualizadoEm: r.atualizado_em
  }]));
  // espelho: TODAS as conversas individuais do número (inclusive contatos que nunca falaram com o robô e conversas respondidas pelo celular)
  try {
    for (const c of await espelho.listarChats(400)) {
      const iso = new Date(c.ts).toISOString();
      const ult = { role: c.deMim ? 'assistant' : 'user', content: c.texto || '', ts: c.ts };
      const ex = porTelefone.get(c.telefone);
      if (!ex) {
        porTelefone.set(c.telefone, { telefone: c.telefone, nome: c.nome, telefoneReal: c.telefoneReal, ultimaMensagem: ult, precisaHumano: false, pausado: false, ultimaFalhaEnvio: null, atualizadoEm: iso });
      } else {
        if (!ex.nome && c.nome) ex.nome = c.nome;
        if (!ex.telefoneReal && c.telefoneReal) ex.telefoneReal = c.telefoneReal;
        if (c.ts > new Date(ex.atualizadoEm).getTime()) { ex.ultimaMensagem = ult; ex.atualizadoEm = iso; }
      }
    }
  } catch (e) { console.error('Falha ao ler o espelho de conversas:', e.message); }
  res.json([...porTelefone.values()].sort((a, b) => new Date(b.atualizadoEm) - new Date(a.atualizadoEm)).slice(0, 400));
});

app.get('/conversas/:telefone', exigirSegredoBot, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT nome, telefone_real, mensagens, precisa_humano, pausado, ultima_falha_envio
     FROM bot_conversas WHERE loja_id = $1 AND telefone = $2`,
    [LOJA_ID, req.params.telefone]
  );
  let espelhoMsgs = [];
  try { espelhoMsgs = await espelho.mensagensDoChat(req.params.telefone, 400); } catch (e) { console.error('Falha ao ler o espelho da conversa:', e.message); }
  const r = rows[0] || null;
  // o que o espelho já tem vale a partir da 1ª mensagem dele; o histórico do robô só completa o que veio ANTES disso (sem duplicar)
  let mensagens = r ? r.mensagens : [];
  if (espelhoMsgs.length) {
    const primeiro = espelhoMsgs[0].ts;
    mensagens = mensagens.filter(m => !m.ts || m.ts < primeiro).concat(espelhoMsgs);
  }
  if (!r) {
    let nome = null, telefoneReal = null;
    try { const c = (await espelho.listarChats(400)).find(x => x.telefone === req.params.telefone); if (c) { nome = c.nome; telefoneReal = c.telefoneReal; } } catch (e) { /* segue sem nome */ }
    return res.json({ nome, telefoneReal, mensagens, precisaHumano: false, pausado: false, ultimaFalhaEnvio: null });
  }
  res.json({ nome: r.nome, telefoneReal: r.telefone_real, mensagens, precisaHumano: r.precisa_humano, pausado: r.pausado, ultimaFalhaEnvio: r.ultima_falha_envio });
});

const PORT = process.env.PORT || 3003;
// só localhost — este serviço nunca precisa ser alcançável de fora da própria máquina (Baileys é
// uma conexão de SAÍDA pro WhatsApp, não recebe webhook de ninguém). O painel alcança isso através
// do proxy autenticado em api/server.js (/api/whatsapp/...), nunca direto.
// parada limpa: deixa o Baileys fechar e gravar as chaves antes do processo morrer (NSSM manda Ctrl+C)
let saindo = false;
for (const sinal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sinal, async () => {
    if (saindo) return;
    saindo = true;
    console.log(`Recebi ${sinal} — encerrando o WhatsApp com calma...`);
    await conexao.encerrar().catch(() => {});
    process.exit(0);
  });
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Bot da ATPN rodando em http://127.0.0.1:${PORT}`);
  conexao.iniciar().catch((e) => console.error('Falha ao iniciar conexão WhatsApp:', e));
});
