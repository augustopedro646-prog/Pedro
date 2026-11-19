const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { exigirAuth, exigirAba, exigirPapel } = require('../auth');
const { sensivel, pinBloqueado, registrarFalhaPin, limparFalhaPin } = require('../rateLimit');

const router = express.Router();
router.use(exigirAuth, exigirAba('ponto'));

const FUSO = 'America/Fortaleza';

// ---------- aparelhos autorizados ----------
// Enquanto nenhum aparelho está autorizado, qualquer um bate ponto (transição).
// Depois do primeiro, só aparelhos autorizados — o navegador manda o token no
// cabeçalho X-Ponto-Aparelho; o servidor só conhece o hash.
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

async function estadoAparelho(req) {
  const total = (await pool.query('SELECT count(*)::int AS n FROM ponto_aparelhos WHERE revogado_em IS NULL')).rows[0].n;
  const token = req.headers['x-ponto-aparelho'];
  let autorizado = false;
  if (token && /^[a-f0-9]{32,128}$/.test(String(token))) {
    autorizado = (await pool.query(
      'SELECT 1 FROM ponto_aparelhos WHERE token_hash = $1 AND revogado_em IS NULL', [hashToken(token)]
    )).rowCount > 0;
  }
  return { exigeAutorizacao: total > 0, autorizado, totalAparelhos: total };
}

async function exigirAparelho(req, res, next) {
  try {
    const e = await estadoAparelho(req);
    if (e.exigeAutorizacao && !e.autorizado) {
      return res.status(403).json({ erro: 'Este aparelho não está autorizado a bater ponto. Peça ao administrador para autorizar este computador.', aparelhoNaoAutorizado: true });
    }
    next();
  } catch (err) {
    next(err);
  }
}

router.get('/dispositivo', async (req, res, next) => {
  try {
    const e = await estadoAparelho(req);
    res.json({ exigeAutorizacao: e.exigeAutorizacao, autorizado: e.autorizado });
  } catch (err) {
    next(err);
  }
});

router.get('/dispositivos', exigirPapel(), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.nome, a.criado_em AS "criadoEm", p.nome AS "criadoPor"
       FROM ponto_aparelhos a LEFT JOIN pessoas p ON p.id = a.criado_por
       WHERE a.revogado_em IS NULL ORDER BY a.criado_em`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Autoriza o aparelho de quem está chamando (o token é gerado no navegador).
router.post('/dispositivos', exigirPapel(), async (req, res, next) => {
  const nome = String(req.body?.nome || '').trim();
  const token = String(req.body?.token || '');
  if (!nome || nome.length > 60) return res.status(400).json({ erro: 'Dê um nome para o aparelho (até 60 letras)' });
  if (!/^[a-f0-9]{32,128}$/.test(token)) return res.status(400).json({ erro: 'Token do aparelho inválido' });
  try {
    await pool.query(
      `INSERT INTO ponto_aparelhos (nome, token_hash, criado_por) VALUES ($1, $2, $3)
       ON CONFLICT (token_hash) DO UPDATE SET nome = EXCLUDED.nome, revogado_em = NULL`,
      [nome, hashToken(token), req.usuario.pessoaId]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/dispositivos/:id', exigirPapel(), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('UPDATE ponto_aparelhos SET revogado_em = now() WHERE id = $1 AND revogado_em IS NULL', [Number(req.params.id)]);
    if (!rowCount) return res.status(404).json({ erro: 'Aparelho não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- bater ponto ----------
// O tipo alterna com o último registro da pessoa (não depende de "que dia é hoje").
async function registrarPonto(pessoaId, { origem, operadorId }) {
  const { rows: ultimo } = await pool.query(
    'SELECT tipo FROM pontos WHERE pessoa_id = $1 ORDER BY registrado_em DESC LIMIT 1', [pessoaId]
  );
  const tipo = ultimo[0]?.tipo === 'entrada' ? 'saida' : 'entrada';
  const { rows } = await pool.query(
    `INSERT INTO pontos (pessoa_id, tipo, origem, registrado_por) VALUES ($1, $2, $3, $4)
     RETURNING id, tipo, registrado_em AS "registradoEm"`,
    [pessoaId, tipo, origem, operadorId]
  );
  return rows[0];
}

// Bate o PRÓPRIO ponto.
router.post('/', exigirAparelho, async (req, res, next) => {
  try {
    res.status(201).json(await registrarPonto(req.usuario.pessoaId, { origem: 'proprio', operadorId: req.usuario.pessoaId }));
  } catch (err) {
    next(err);
  }
});

// Modo quiosque: alguém no computador do ponto escolhe a pessoa e ela digita o
// PIN dela. 5 PINs errados bloqueiam aquela pessoa por 15 minutos (mesma regra do login).
router.post('/registrar-com-pin', sensivel, exigirAparelho, async (req, res, next) => {
  const pessoaId = Number(req.body?.pessoaId);
  const pin = String(req.body?.pin || '');
  if (!Number.isInteger(pessoaId) || !/^\d{4}$/.test(pin)) return res.status(400).json({ erro: 'Escolha a pessoa e digite o PIN de 4 números' });
  const chave = `ponto:${pessoaId}`;
  if (pinBloqueado(chave)) return res.status(429).json({ erro: 'PIN errado várias vezes — aguarde 15 minutos ou chame um administrador.' });
  try {
    const { rows } = await pool.query('SELECT id, nome, pin_hash, ativo FROM pessoas WHERE id = $1', [pessoaId]);
    const p = rows[0];
    const ok = p && p.ativo && await bcrypt.compare(pin, p.pin_hash);
    if (!ok) { registrarFalhaPin(chave); return res.status(401).json({ erro: 'PIN incorreto' }); }
    limparFalhaPin(chave);
    const reg = await registrarPonto(p.id, { origem: 'quiosque', operadorId: req.usuario.pessoaId });
    res.status(201).json({ ...reg, pessoaNome: p.nome });
  } catch (err) {
    next(err);
  }
});

// Quem aparece na lista do quiosque.
router.get('/pessoas', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.nome, c.nome AS "cargoNome" FROM pessoas p JOIN cargos c ON c.id = p.cargo_id
       WHERE p.ativo ORDER BY c.nome, p.nome`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Último registro de uma pessoa ("Fulano está trabalhando desde 08:02").
router.get('/status', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT tipo, registrado_em AS "registradoEm" FROM pontos WHERE pessoa_id = $1 ORDER BY registrado_em DESC LIMIT 1`,
      [Number(req.query.pessoaId)]
    );
    res.json({ ultimo: rows[0] || null });
  } catch (err) {
    next(err);
  }
});

// "Equipe hoje": o último registro de cada pessoa que bateu ponto hoje.
router.get('/hoje', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (p.pessoa_id) p.id, p.pessoa_id AS "pessoaId", pe.nome AS "pessoaNome", p.tipo,
                p.registrado_em AS "registradoEm", p.corrigido_por AS "corrigidoPor", p.origem
         FROM pontos p JOIN pessoas pe ON pe.id = p.pessoa_id
         WHERE (p.registrado_em AT TIME ZONE '${FUSO}')::date = (now() AT TIME ZONE '${FUSO}')::date
         ORDER BY p.pessoa_id, p.registrado_em DESC
       ) t ORDER BY "pessoaNome"`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Lista pontos. Administrador vê qualquer pessoa (ou filtra por pessoaId);
// os demais só o próprio histórico, mesmo que peçam outro id.
router.get('/', async (req, res, next) => {
  const hoje = () => new Date().toISOString().slice(0, 10);
  const trintaDiasAtras = () => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  };
  const inicio = req.query.inicio || trintaDiasAtras();
  const fim = req.query.fim || hoje();
  const pessoaId = req.usuario.administrador
    ? (req.query.pessoaId ? Number(req.query.pessoaId) : null)
    : req.usuario.pessoaId;

  try {
    const params = [inicio, fim];
    let where = `(p.registrado_em AT TIME ZONE '${FUSO}')::date BETWEEN $1 AND $2`;
    if (pessoaId) {
      params.push(pessoaId);
      where += ` AND p.pessoa_id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT p.id, p.pessoa_id AS "pessoaId", pe.nome AS "pessoaNome", p.tipo,
              p.registrado_em AS "registradoEm", p.corrigido_por AS "corrigidoPor", p.origem
       FROM pontos p JOIN pessoas pe ON pe.id = p.pessoa_id
       WHERE ${where} ORDER BY p.registrado_em ASC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Corrige um ponto — só Administrador (exigirPapel sem lista = só bypass admin).
router.put('/:id', exigirPapel(), async (req, res, next) => {
  const id = Number(req.params.id);
  const { tipo, registradoEm } = req.body || {};
  if (tipo !== 'entrada' && tipo !== 'saida') {
    return res.status(400).json({ erro: 'tipo precisa ser "entrada" ou "saida"' });
  }
  const quando = new Date(registradoEm);
  if (!registradoEm || Number.isNaN(quando.getTime())) return res.status(400).json({ erro: 'registradoEm inválido' });
  if (quando.getTime() > Date.now() + 5 * 60 * 1000) return res.status(400).json({ erro: 'O horário não pode estar no futuro' });
  try {
    const { rows } = await pool.query(
      `UPDATE pontos SET tipo = $1, registrado_em = $2, corrigido_por = $3, corrigido_em = now()
       WHERE id = $4 RETURNING id`,
      [tipo, quando.toISOString(), req.usuario.pessoaId, id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Ponto não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', exigirPapel(), async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const { rowCount } = await pool.query('DELETE FROM pontos WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ erro: 'Ponto não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
