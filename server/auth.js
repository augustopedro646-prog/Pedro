const crypto = require('crypto');
const { pool } = require('./db');

// Token assinado à mão (HMAC), sem lib de auth e sem sessão guardada no
// servidor — mesmo padrão do PDV Jabá. Recusa subir sem o segredo.
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

// Confere o papel sempre no servidor — o token só carrega o que a pessoa
// *tinha* na hora do login, nunca é a fonte de verdade sozinho pra ação
// sensível nova.
function exigirAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '') || null;
  const payload = verificarToken(token);
  if (!payload) return res.status(401).json({ erro: 'Login necessário ou sessão expirada' });
  req.usuario = payload;
  next();
}

function exigirPapel(...cargosPermitidos) {
  return (req, res, next) => {
    if (req.usuario.administrador || cargosPermitidos.includes(req.usuario.cargoNome)) {
      return next();
    }
    res.status(403).json({ erro: 'Sem permissão pra esse cargo' });
  };
}

// Confere a permissão configurável (Configurações > Permissões) da aba
// pro cargo da pessoa logada. Administrador é sempre irrestrito.
function exigirAba(aba) {
  return async (req, res, next) => {
    if (req.usuario.administrador) return next();
    try {
      const { rows } = await pool.query(
        'SELECT permitido FROM permissoes WHERE cargo_id = $1 AND aba = $2',
        [req.usuario.cargoId, aba]
      );
      if (rows[0]?.permitido) return next();
      res.status(403).json({ erro: 'Sem permissão pra essa aba' });
    } catch (err) {
      next(err);
    }
  };
}

// Toda rota que lê/escreve dado de uma unidade específica passa por aqui
// pra garantir que a pessoa realmente tem acesso àquela unidade — nunca
// confiar no unidade_id que o cliente manda solto.
function exigirUnidade(req, res, next) {
  const unidadeId = Number(req.params.unidadeId || req.body.unidadeId || req.query.unidadeId);
  if (req.usuario.administrador) {
    req.unidadeId = unidadeId || req.usuario.unidadeId;
    return next();
  }
  if (!unidadeId || unidadeId !== req.usuario.unidadeId) {
    return res.status(403).json({ erro: 'Sem acesso a essa unidade' });
  }
  req.unidadeId = unidadeId;
  next();
}

module.exports = { assinarToken, exigirAuth, exigirPapel, exigirAba, exigirUnidade };
