const express = require('express');
const { pool } = require('../db');
const { exigirAuth, exigirAba, exigirPapel } = require('../auth');

// Escala da equipe da ATPN (aba Calendário). Todo mundo com a aba vê; só o
// Administrador escala, edita e remove (mesma regra do PDV Jabá).
const router = express.Router();
router.use(exigirAuth, exigirAba('calendario'));

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_DIAS = 62; // escalar mais que ~2 meses de uma vez quase sempre é engano

class ErroEscala extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

const dataValida = (s) => DATA_RE.test(String(s || '')) && !Number.isNaN(new Date(`${s}T12:00:00`).getTime());

function validarHoras(b) {
  const norm = (v, rotulo) => {
    const t = String(v ?? '').trim();
    if (!t) return null;
    if (!HORA_RE.test(t)) throw new ErroEscala(400, `${rotulo}: use o formato HH:MM`);
    return t;
  };
  const horaInicio = norm(b.horaInicio, 'Hora de início');
  const horaFim = norm(b.horaFim, 'Hora de fim');
  if (horaFim && !horaInicio) throw new ErroEscala(400, 'Informe a hora de início antes da hora de fim');
  if (horaInicio && horaFim && horaFim < horaInicio) throw new ErroEscala(400, 'A hora fim precisa ser depois da hora início');
  const observacao = String(b.observacao ?? '').trim();
  if (observacao.length > 300) throw new ErroEscala(400, 'Observação muito longa (máximo 300 caracteres)');
  return { horaInicio, horaFim, observacao: observacao || null };
}

const COLUNAS = `e.id, e.pessoa_id AS "pessoaId", p.nome AS "pessoaNome", c.nome AS "cargoNome", to_char(e.data, 'YYYY-MM-DD') AS data,
  e.hora_inicio AS "horaInicio", e.hora_fim AS "horaFim", e.observacao, e.reserva_id AS "reservaId", r.titulo AS "reservaTitulo"`;

// Escala de um período (do mês na tela do calendário).
router.get('/', async (req, res, next) => {
  const { inicio, fim } = req.query;
  if (!dataValida(inicio) || !dataValida(fim)) return res.status(400).json({ erro: 'inicio e fim obrigatórios (AAAA-MM-DD)' });
  try {
    const { rows } = await pool.query(
      `SELECT ${COLUNAS} FROM escalas e
       JOIN pessoas p ON p.id = e.pessoa_id JOIN cargos c ON c.id = p.cargo_id
       LEFT JOIN reservas r ON r.id = e.reserva_id
       WHERE e.data BETWEEN $1 AND $2
       ORDER BY e.data, e.hora_inicio NULLS LAST, p.nome`,
      [inicio, fim]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Quem pode ser escalado: pessoas ativas da Equipe.
router.get('/pessoas', exigirPapel(), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.nome, c.nome AS "cargoNome" FROM pessoas p JOIN cargos c ON c.id = p.cargo_id
       WHERE p.ativo ORDER BY p.nome`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Escalar uma pessoa em vários dias de uma vez (o mini-calendário do modal).
// Pula os dias em que ela já está na escala normal e devolve quais pulou.
router.post('/lote', exigirPapel(), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const pessoaId = Number(b.pessoaId);
    if (!Number.isInteger(pessoaId)) throw new ErroEscala(400, 'Escolha o funcionário');
    const datas = [...new Set((Array.isArray(b.datas) ? b.datas : []).map(String))].sort();
    if (!datas.length) throw new ErroEscala(400, 'Marque pelo menos um dia');
    if (datas.length > MAX_DIAS) throw new ErroEscala(400, `Muitos dias de uma vez (máximo ${MAX_DIAS})`);
    if (datas.some((d) => !dataValida(d))) throw new ErroEscala(400, 'Há uma data inválida na seleção');
    const h = validarHoras(b);

    await client.query('BEGIN');
    const pessoa = (await client.query('SELECT id, ativo FROM pessoas WHERE id = $1', [pessoaId])).rows[0];
    if (!pessoa || !pessoa.ativo) throw new ErroEscala(400, 'Pessoa não encontrada ou desativada');
    const criadas = [];
    const puladas = [];
    for (const data of datas) {
      const r = await client.query(
        `INSERT INTO escalas (pessoa_id, data, hora_inicio, hora_fim, observacao, criado_por)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (pessoa_id, data) WHERE reserva_id IS NULL DO NOTHING RETURNING id`,
        [pessoaId, data, h.horaInicio, h.horaFim, h.observacao, req.usuario.pessoaId]
      );
      (r.rowCount ? criadas : puladas).push(data);
    }
    await client.query('COMMIT');
    res.status(201).json({ criadas, puladas });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ErroEscala) return res.status(err.status).json({ erro: err.message });
    next(err);
  } finally {
    client.release();
  }
});

// Mudar horário/observação de UMA escala (o ✎ do dia).
router.put('/:id', exigirPapel(), async (req, res, next) => {
  try {
    const h = validarHoras(req.body || {});
    const { rowCount } = await pool.query(
      'UPDATE escalas SET hora_inicio = $1, hora_fim = $2, observacao = $3 WHERE id = $4',
      [h.horaInicio, h.horaFim, h.observacao, Number(req.params.id)]
    );
    if (!rowCount) return res.status(404).json({ erro: 'Escala não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ErroEscala) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

router.delete('/:id', exigirPapel(), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM escalas WHERE id = $1', [Number(req.params.id)]);
    if (!rowCount) return res.status(404).json({ erro: 'Escala não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Equipe de uma reserva/evento: troca a lista inteira (quem sai, sai; quem
// entra, entra no dia e hora da reserva). Cada pessoa aparece no calendário.
router.put('/reserva/:reservaId', exigirPapel(), async (req, res, next) => {
  const reservaId = Number(req.params.reservaId);
  const client = await pool.connect();
  try {
    const ids = [...new Set((Array.isArray(req.body?.pessoaIds) ? req.body.pessoaIds : []).map(Number))];
    if (ids.some((i) => !Number.isInteger(i))) throw new ErroEscala(400, 'Lista de pessoas inválida');
    await client.query('BEGIN');
    const r = (await client.query(
      `SELECT id, titulo, to_char(data, 'YYYY-MM-DD') AS data, hora_inicio, hora_fim, status FROM reservas WHERE id = $1 FOR UPDATE`, [reservaId]
    )).rows[0];
    if (!r) throw new ErroEscala(404, 'Reserva não encontrada');
    if (ids.length && r.status === 'recusado') throw new ErroEscala(409, 'Essa reserva foi recusada — reabra antes de escalar equipe');
    if (ids.length) {
      const ok = await client.query('SELECT id FROM pessoas WHERE id = ANY($1) AND ativo', [ids]);
      if (ok.rowCount !== ids.length) throw new ErroEscala(400, 'Há pessoa desativada ou inexistente na lista');
    }
    await client.query('DELETE FROM escalas WHERE reserva_id = $1 AND NOT (pessoa_id = ANY($2))', [reservaId, ids]);
    for (const pessoaId of ids) {
      await client.query(
        `INSERT INTO escalas (pessoa_id, data, hora_inicio, hora_fim, observacao, reserva_id, criado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pessoa_id, reserva_id) WHERE reserva_id IS NOT NULL
         DO UPDATE SET data = EXCLUDED.data, hora_inicio = EXCLUDED.hora_inicio, hora_fim = EXCLUDED.hora_fim, observacao = EXCLUDED.observacao`,
        [pessoaId, r.data, r.hora_inicio, r.hora_fim, `Evento: ${r.titulo}`.slice(0, 300), reservaId, req.usuario.pessoaId]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ErroEscala) return res.status(err.status).json({ erro: err.message });
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
