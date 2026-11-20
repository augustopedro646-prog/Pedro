const express = require('express');
const { pool } = require('../db');
const { exigirAuth, exigirPapel } = require('../auth');

// Painel do robô de WhatsApp (bot-whatsapp/, porta 3003, só localhost). O navegador nunca fala com o robô
// direto: este proxy confere o login (só Administrador) e manda o segredo compartilhado. Mesmo padrão do PDV Jabá.
const router = express.Router();
router.use(exigirAuth, exigirPapel());

const BOT_URL = process.env.BOT_URL || 'http://127.0.0.1:3003';

async function proxy(req, res, caminho, metodo = 'GET') {
  try {
    const r = await fetch(`${BOT_URL}${caminho}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': process.env.BOT_WEBHOOK_SECRET || '' },
      body: metodo === 'GET' ? undefined : JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(15000),
    });
    const dados = await r.json().catch(() => ({}));
    res.status(r.status).json(dados);
  } catch (err) {
    res.status(503).json({ erro: 'O robô do WhatsApp não está rodando (ou não respondeu).' });
  }
}

router.get('/status', (req, res) => proxy(req, res, '/status'));
router.post('/pausa', (req, res) => proxy(req, res, '/pausa', 'POST'));
router.post('/desconectar', (req, res) => proxy(req, res, '/desconectar', 'POST'));
router.post('/enviar', (req, res) => proxy(req, res, '/enviar', 'POST'));
router.post('/reativar', (req, res) => proxy(req, res, '/reativar-bot', 'POST'));
router.get('/conversas', (req, res) => proxy(req, res, '/conversas'));
router.get('/conversas/:telefone', (req, res) => proxy(req, res, `/conversas/${encodeURIComponent(req.params.telefone)}`));

// Instruções livres da diretoria (Bloco B) — o robô lê direto do banco a cada mensagem, vale na hora.
router.get('/instrucoes', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT valor FROM bot_config WHERE chave = 'bot-instrucoes'`);
    res.json({ texto: rows[0] ? rows[0].valor : '' });
  } catch (err) { next(err); }
});
router.put('/instrucoes', async (req, res, next) => {
  const texto = String((req.body || {}).texto ?? '');
  if (texto.length > 20000) return res.status(400).json({ erro: 'Texto muito longo (máximo 20.000 caracteres)' });
  try {
    await pool.query(
      `INSERT INTO bot_config (chave, valor, atualizado_em) VALUES ('bot-instrucoes', $1, now())
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`, [texto]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
