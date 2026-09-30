require('dotenv').config();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET === 'troque-por-uma-chave-aleatoria-longa') {
  throw new Error('Defina JWT_SECRET no .env com uma chave aleatória de verdade antes de subir a API.');
}

function hashPin(pin) {
  return bcrypt.hashSync(pin, 10);
}

function verificarPin(pin, hash) {
  return bcrypt.compareSync(pin, hash);
}

function gerarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, lojaId: usuario.loja_id, papel: usuario.papel, nome: usuario.nome },
    SECRET,
    { expiresIn: '12h' }
  );
}

// Exige um token válido (Authorization: Bearer <token>) — o Jabá confiava na
// rede local isolada pra não precisar disso; a Gutto é exposta na internet
// (hospedagem em nuvem), então cada rota de escrita passa por aqui.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ erro: 'Token ausente' });
  try {
    req.usuario = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ erro: 'Token inválido ou expirado' });
  }
}

function requirePapel(...papeis) {
  return (req, res, next) => {
    if (!req.usuario || !papeis.includes(req.usuario.papel)) {
      return res.status(403).json({ erro: 'Sem permissão pra essa ação' });
    }
    next();
  };
}

module.exports = { hashPin, verificarPin, gerarToken, requireAuth, requirePapel };
