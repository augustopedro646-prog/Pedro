const crypto = require('crypto');

// Token assinado à mão (HMAC), sem lib de auth e sem sessão guardada no
// servidor — mesmo padrão usado nos outros sistemas da casa. Recusa subir
// sem o segredo.
const AUTH_SECRET = process.env.AUTH_SECRET;
if (!AUTH_SECRET) {
  throw new Error('AUTH_SECRET não definido (ver .env.example)');
}

const VALIDADE_MS = 12 * 60 * 60 * 1000;

function assinarToken(payload) {
  const corpo = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + VALIDADE_MS })).toString('base64url');
  const assinatura = crypto.createHmac('sha256', AUTH_SECRET).update(corpo).digest('base64url');
  return `${corpo}.${assinatura}`;
}

function verificarToken(token) {
  if (!token || !token.includes('.')) return null;
  const [corpo, assinatura] = token.split('.');
  if (!corpo || !assinatura) return null;
  const esperada = crypto.createHmac('sha256', AUTH_SECRET).update(corpo).digest('base64url');
  if (assinatura.length !== esperada.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(assinatura), Buffer.from(esperada))) return null;
  try {
    const payload = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
    return (!payload.exp || payload.exp < Date.now()) ? null : payload;
  } catch {
    return null;
  }
}

function exigirAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '') || null;
  const payload = verificarToken(token);
  if (!payload) return res.status(401).json({ erro: 'Login necessário ou sessão expirada' });
  req.usuario = payload;
  next();
}

// Só diretoria passa — professor nunca edita cadastro (turma, modalidade,
// aluno), só enxerga e faz chamada do que é dele.
function exigirDiretoria(req, res, next) {
  if (req.usuario.tipo !== 'diretoria') {
    return res.status(403).json({ erro: 'Só a diretoria pode fazer isso' });
  }
  next();
}

module.exports = { assinarToken, exigirAuth, exigirDiretoria };
