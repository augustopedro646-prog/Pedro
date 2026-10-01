// Segurança pra quando a loja estiver na internet (Cloudflare Tunnel, mesmo desenho do Jabá).
//
// Quem chega pelo túnel traz o cabeçalho CF-Connecting-IP (o IP real do visitante); quem usa o
// sistema no computador ou na rede da loja, não. Com isso:
// - Pela internet, por padrão, só o SITE da loja responde (vitrine, pedido, acompanhar pedido,
//   fotos). O painel (PIN da equipe, vendas, caixa, relatórios) fica só na rede da loja.
//   PAINEL_REMOTO=1 no .env libera o painel de fora também (ex.: ver relatórios de casa).
// - Os limites de tentativa contam por visitante (IP real), não pelo túnel — senão um único
//   abusado bloquearia todos os clientes do site de uma vez.
// - PIN errado demais trava aquele usuário por 15 minutos, contado à parte pra internet e pra
//   loja: alguém de fora errando PIN não impede a equipe de entrar no balcão.

const DE_FORA_PERMITIDO = [
  /^\/$/, /^\/loja\/?$/, /^\/loja-gutto\.html$/, /^\/favicon\.ico$/, /^\/icone-(192|512)\.png$/,
  /^\/api\/health$/,
  /^\/api\/lojas\/\d+\/loja\//,
  /^\/api\/lojas\/\d+\/fotos\/[^/]+$/,
];

function ehLoopback(endereco) {
  return /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/.test(String(endereco || ''));
}
function veioDaInternet(req) {
  return !!req.headers['cf-connecting-ip'];
}
// IP real: o do Cloudflare só vale se a conexão veio do próprio computador (o cloudflared).
function ipReal(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf && ehLoopback(req.socket.remoteAddress)) return String(cf).slice(0, 64);
  return req.socket.remoteAddress || 'desconhecido';
}

function painelRemotoLiberado() { return process.env.PAINEL_REMOTO === '1'; }

// Middleware: barra o painel pra quem vem da internet (a não ser com PAINEL_REMOTO=1).
function filtroInternet(req, res, next) {
  if (!veioDaInternet(req)) return next();
  // Na internet, o endereço principal abre o site da loja (o painel tem o link direto).
  if (req.path === '/' || /^\/loja\/?$/.test(req.path)) return res.redirect('/loja-gutto.html');
  if (painelRemotoLiberado() || DE_FORA_PERMITIDO.some((r) => r.test(req.path))) return next();
  if (req.path.startsWith('/api/')) return res.status(404).json({ erro: 'Não encontrado' });
  res.status(404).type('text').send('Página não encontrada. A loja está em /loja');
}

// Cabeçalhos básicos (o HTTPS/HSTS fica por conta do Cloudflare).
function cabecalhos(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
}

// Trava por usuário depois de PIN errado demais.
const MAX_FALHAS = 6, JANELA_MS = 15 * 60 * 1000;
const falhas = new Map(); // `${origem}:${usuarioId}` → { n, desde }
function chavePin(req, usuarioId) { return (veioDaInternet(req) ? 'internet' : 'loja') + ':' + usuarioId; }
function pinTravado(req, usuarioId) {
  const f = falhas.get(chavePin(req, usuarioId));
  if (!f) return 0;
  if (Date.now() - f.desde > JANELA_MS) { falhas.delete(chavePin(req, usuarioId)); return 0; }
  return f.n >= MAX_FALHAS ? Math.ceil((f.desde + JANELA_MS - Date.now()) / 60000) : 0;
}
function registrarPin(req, usuarioId, acertou) {
  const k = chavePin(req, usuarioId);
  if (acertou) { falhas.delete(k); return; }
  const f = falhas.get(k);
  if (!f || Date.now() - f.desde > JANELA_MS) falhas.set(k, { n: 1, desde: Date.now() });
  else f.n += 1;
}

module.exports = { filtroInternet, cabecalhos, ipReal, veioDaInternet, pinTravado, registrarPin, MAX_FALHAS };
