// Serviço do atendente de WhatsApp. Escuta só em 127.0.0.1 (nunca exposto na internet): o painel
// fala com ele através da API principal (rotas /api/lojas/:id/bot/..., só Administrador), que
// repassa com o segredo compartilhado BOT_WEBHOOK_SECRET do api/.env.
const { LOJA_ID, pool, telefoneLocal } = require('./config');
const express = require('express');
const crypto = require('crypto');
const conexao = require('./conexao');
const campanhas = require('./campanhas');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Falta ANTHROPIC_API_KEY no api/.env — o atendente usa a IA do Claude pra responder.');
  process.exit(1);
}
if (!process.env.BOT_WEBHOOK_SECRET) {
  console.error('Falta BOT_WEBHOOK_SECRET no api/.env — rode "npm run setup" na pasta api pra gerar.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '100kb' }));
app.get('/health', (req, res) => res.json({ ok: true }));

function exigirSegredo(req, res, next) {
  const a = Buffer.from(String(req.headers['x-bot-secret'] || ''));
  const b = Buffer.from(process.env.BOT_WEBHOOK_SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ erro: 'segredo inválido' });
  next();
}
app.use(exigirSegredo);

// Aviso automático de status pro cliente (pedido do site ou do próprio WhatsApp).
const AVISOS = {
  recebido: (p) => `Oi, ${p.nome}! Recebemos seu pedido #${p.numero} na Loja Gutto 🛍️ Já vamos separar as peças e te avisamos por aqui a cada etapa.`,
  separando: (p) => `Estamos separando as peças do seu pedido #${p.numero} 👗`,
  pronto: (p) => p.tipo === 'retirada'
    ? `Seu pedido #${p.numero} está pronto! Pode vir buscar na loja${p.endereco ? ' (' + p.endereco + ')' : ''} 😊`
    : `Seu pedido #${p.numero} está pronto e já vai sair pra entrega!`,
  saiu_entrega: (p) => `Seu pedido #${p.numero} saiu para entrega 🛵 Já já chega aí!`,
  entregue: (p) => `Pedido #${p.numero} concluído! Obrigado por comprar na Loja Gutto 💛 O cashback dessa compra já está no seu cadastro pra próxima.`,
  cancelado: (p) => `Seu pedido #${p.numero} foi cancelado. Se tiver qualquer dúvida, é só responder aqui.`,
};
app.post('/webhook/pedido-status', async (req, res) => {
  res.json({ ok: true }); // responde na hora — o envio segue em segundo plano
  const { pedidoId, status } = req.body || {};
  if (!AVISOS[status]) return;
  try {
    const { rows } = await pool.query(
      `SELECT p.numero, p.telefone, p.tipo, p.cliente_nome, p.origem, l.endereco FROM pedidos_online p JOIN lojas l ON l.id = p.loja_id
       WHERE p.id = $1 AND p.loja_id = $2`, [pedidoId, LOJA_ID]);
    if (!rows.length) return;
    const p = rows[0];
    if (status === 'recebido' && p.origem === 'whatsapp') return; // o robô já confirmou na conversa
    const texto = AVISOS[status]({ numero: p.numero, nome: p.cliente_nome.split(' ')[0], tipo: p.tipo, endereco: p.endereco });
    await conexao.enviarTexto({ telefoneLocal: p.telefone }, texto, 'sistema');
  } catch (e) { console.error('Falha no aviso de status:', e.message); }
});

// Mensagens pros clientes aprovadas no painel: a API cutuca aqui pra começar a enviar na hora
// (sem isso, o robô confere a fila sozinho a cada 5 minutos).
app.post('/mensagens/processar', (req, res) => { res.json({ ok: true }); campanhas.processar(); });

// Só nos testes automáticos (modo simulado): finge que um cliente mandou uma mensagem.
if (process.env.BOT_SEM_WHATSAPP === '1' && process.env.BOT_SIMULAR_ENVIO === '1') {
  app.post('/teste/recebida', async (req, res) => { await conexao.mensagemRecebida(req.body.telefone, req.body.texto, null); res.json({ ok: true }); });
}

app.get('/status', (req, res) => res.json(conexao.getStatus()));
app.post('/desconectar', async (req, res) => { await conexao.desconectar(); res.json({ ok: true }); });

// Resposta da equipe pelo painel: pausa o robô nessa conversa (humano assumiu).
app.post('/enviar', async (req, res) => {
  const { telefone, texto } = req.body || {};
  if (typeof telefone !== 'string' || !/^\d{5,20}$/.test(telefone) || typeof texto !== 'string' || !texto.trim() || texto.length > 2000) {
    return res.status(400).json({ erro: 'telefone e texto (até 2000 caracteres) são obrigatórios' });
  }
  await pool.query(
    `INSERT INTO bot_conversas (loja_id, telefone, pausado, pausado_em, precisa_humano) VALUES ($1, $2, true, now(), false)
     ON CONFLICT (loja_id, telefone) DO UPDATE SET pausado = true, pausado_em = now(), precisa_humano = false`, [LOJA_ID, telefone]);
  const r = await conexao.enviarTexto(telefone, texto.trim(), 'equipe');
  if (!r.ok) return res.status(502).json({ erro: r.erro || 'falha ao enviar' });
  res.json({ ok: true });
});

app.post('/reativar', async (req, res) => {
  const { telefone } = req.body || {};
  if (typeof telefone !== 'string') return res.status(400).json({ erro: 'telefone obrigatório' });
  await pool.query('UPDATE bot_conversas SET pausado = false, precisa_humano = false WHERE loja_id = $1 AND telefone = $2', [LOJA_ID, telefone]);
  res.json({ ok: true });
});

// Nome mostrado no inbox: cadastro de cliente (pelo telefone) > nome dado no pedido > perfil do WhatsApp.
async function nomesDosClientes(conversas) {
  const locais = conversas.map((c) => telefoneLocal(c.telefone)).filter(Boolean);
  if (!locais.length) return {};
  const { rows } = await pool.query('SELECT telefone, nome FROM clientes WHERE loja_id = $1 AND telefone = ANY($2)', [LOJA_ID, locais]);
  return Object.fromEntries(rows.map((r) => [r.telefone, r.nome]));
}
function textoDe(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
}

app.get('/conversas', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT telefone, mensagens, precisa_humano, pausado, ultima_falha_envio, atualizado_em, nome_perfil, cliente_nome, motivo_humano, nao_lidas
     FROM bot_conversas WHERE loja_id = $1 AND jsonb_array_length(mensagens) > 0 ORDER BY atualizado_em DESC LIMIT 200`, [LOJA_ID]);
  const cadastro = await nomesDosClientes(rows);
  res.json(rows.map((r) => {
    const ultima = [...r.mensagens].reverse().find((m) => textoDe(m));
    return {
      telefone: r.telefone, telefoneLocal: telefoneLocal(r.telefone),
      nome: cadastro[telefoneLocal(r.telefone)] || r.cliente_nome || r.nome_perfil || null,
      ultimaMensagem: ultima ? { texto: textoDe(ultima).slice(0, 140), doCliente: ultima.role === 'user' } : null,
      precisaHumano: r.precisa_humano, motivo: r.motivo_humano, pausado: r.pausado, ultimaFalhaEnvio: r.ultima_falha_envio,
      naoLidas: r.nao_lidas, atualizadoEm: r.atualizado_em,
    };
  }));
});

app.get('/conversas/:telefone', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE bot_conversas SET nao_lidas = 0 WHERE loja_id = $1 AND telefone = $2
     RETURNING mensagens, precisa_humano, pausado, ultima_falha_envio, motivo_humano`, [LOJA_ID, req.params.telefone]);
  if (!rows.length) return res.json({ mensagens: [], precisaHumano: false, pausado: false });
  const r = rows[0];
  res.json({
    mensagens: r.mensagens.map((m) => ({ doCliente: m.role === 'user', texto: textoDe(m), remetente: m.remetente || (m.role === 'user' ? 'cliente' : 'robo') })).filter((m) => m.texto),
    precisaHumano: r.precisa_humano, motivo: r.motivo_humano, pausado: r.pausado, ultimaFalhaEnvio: r.ultima_falha_envio,
  });
});

const PORT = Number(process.env.BOT_PORT || 3101);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Atendente de WhatsApp da Loja Gutto (loja ${LOJA_ID}) em http://127.0.0.1:${PORT}`);
  if (process.env.BOT_SEM_WHATSAPP !== '1') conexao.iniciar().catch((e) => console.error('Falha ao iniciar o WhatsApp:', e));
  campanhas.iniciar();
});
