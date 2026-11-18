const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// ipKeyGenerator normaliza IPv6 corretamente — sem ele, cada visitante
// IPv6 (que varia por requisição) furava o limite ou travava geral.
const keyGenerator = (req) => ipKeyGenerator(req.ip);

// Freio por pessoa (mesmo padrão do PDV Jabá): o PIN tem só 4 dígitos
// (10 mil combinações) e o limite "sensivel" abaixo é por IP, então um
// ataque com vários IPs ainda conseguiria tentar todas em pouco tempo.
// Aqui 5 PINs errados seguidos pra uma mesma pessoa bloqueiam ela por
// 15 minutos, direto no login, mesmo trocando de IP.
const FALHAS_PIN_MAX = 5;
const FALHAS_PIN_JANELA_MS = 15 * 60 * 1000;
const falhasPin = new Map(); // chave -> { n, ate }

function pinBloqueado(chave) {
  const f = falhasPin.get(chave);
  if (!f) return false;
  if (Date.now() > f.ate) { falhasPin.delete(chave); return false; }
  return f.n >= FALHAS_PIN_MAX;
}

function registrarFalhaPin(chave) {
  const f = falhasPin.get(chave);
  if (!f || Date.now() > f.ate) falhasPin.set(chave, { n: 1, ate: Date.now() + FALHAS_PIN_JANELA_MS });
  else f.n += 1;
}

function limparFalhaPin(chave) {
  falhasPin.delete(chave);
}

setInterval(() => {
  const agora = Date.now();
  for (const [chave, f] of falhasPin) if (agora > f.ate) falhasPin.delete(chave);
}, 10 * 60 * 1000).unref();

const geral = rateLimit({
  windowMs: 15 * 60 * 1000,
  // 300 era pouco: cada tela faz várias chamadas e a recepção/diretoria usam o
  // sistema atrás do mesmo IP. Login e PIN continuam no limite apertado abaixo.
  limit: 1500,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
});

// Mais apertado pra rotas sensíveis (login, tentativa de PIN).
const sensivel = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  message: { erro: 'Muitas tentativas, aguarde um pouco' },
});

module.exports = { geral, sensivel, pinBloqueado, registrarFalhaPin, limparFalhaPin };
