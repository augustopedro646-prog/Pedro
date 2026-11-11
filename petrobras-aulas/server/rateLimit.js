const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// ipKeyGenerator normaliza IPv6 corretamente — sem ele, cada visitante
// IPv6 (que varia por requisição) furava o limite ou travava geral.
const keyGenerator = (req) => ipKeyGenerator(req.ip);

const geral = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
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

module.exports = { geral, sensivel };
