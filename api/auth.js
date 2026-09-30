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

// Devolve o conteúdo do token (Authorization: Bearer <token>) ou null se ausente/inválido.
function lerToken(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, SECRET);
  } catch (e) {
    return null;
  }
}

module.exports = { hashPin, verificarPin, gerarToken, lerToken };
