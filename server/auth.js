const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const SEGREDO = process.env.JWT_SECRET;
if (!SEGREDO) {
  throw new Error('JWT_SECRET não definido (ver .env.example)');
}

const VALIDADE = '12h';

function emitirToken({ pessoaId, nome, cargoId, cargoNome, administrador, unidadeId }) {
  return jwt.sign(
    { pessoaId, nome, cargoId, cargoNome, administrador, unidadeId },
    SEGREDO,
    { expiresIn: VALIDADE }
  );
}

// Confere o papel sempre no servidor — o token só carrega o que a pessoa
// *tinha* na hora do login, nunca é a fonte de verdade sozinho pra ação
// sensível nova, mas evita ida ao banco em toda rota simples.
function requireAuth(req, res, next) {
  const cabecalho = req.headers.authorization || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
  if (!token) return res.status(401).json({ erro: 'Não autenticado' });

  try {
    req.usuario = jwt.verify(token, SEGREDO);
    next();
  } catch {
    res.status(401).json({ erro: 'Sessão inválida ou expirada' });
  }
}

function requireCargo(...cargosPermitidos) {
  return (req, res, next) => {
    if (req.usuario.administrador || cargosPermitidos.includes(req.usuario.cargoNome)) {
      return next();
    }
    res.status(403).json({ erro: 'Sem permissão pra esse cargo' });
  };
}

// Confere a permissão configurável (Configurações > Permissões) da aba
// pro cargo da pessoa logada. Administrador é sempre irrestrito.
function requireAba(aba) {
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
function requireUnidade(req, res, next) {
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

module.exports = { emitirToken, requireAuth, requireCargo, requireAba, requireUnidade };
