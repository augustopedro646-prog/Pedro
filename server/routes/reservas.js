const express = require('express');
const { pool } = require('../db');
const { jabaPool, JABA_LOJA_ID, integracaoConfigurada, temEscopo } = require('../jabaDb');
const { exigirAuth, exigirAba, exigirPapel } = require('../auth');
const { detectarConflitos } = require('../conflitos');
const { buscarEventos } = require('./calendario');

const router = express.Router();
router.use(exigirAuth, exigirAba('eventos'));

const STATUS = ['novo', 'negociando', 'confirmado', 'recusado', 'concluido'];
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const prefixoAgenda = 'atpn-res-';

class ErroReserva extends Error {
  constructor(status, mensagem, extra) { super(mensagem); this.status = status; this.extra = extra; }
}

const COLUNAS = `id, titulo, solicitante, telefone, to_char(data, 'YYYY-MM-DD') AS data, hora_inicio AS "horaInicio",
  hora_fim AS "horaFim", num_convidados AS "numConvidados", observacao, obs_equipe AS "obsEquipe", status, agenda_id AS "agendaId",
  atualizado_em AS "atualizadoEm"`;

function validar(corpo) {
  const b = corpo || {};
  const texto = (v, max, rotulo, obrigatorio) => {
    const t = String(v ?? '').trim();
    if (obrigatorio && !t) throw new ErroReserva(400, `${rotulo} é obrigatório`);
    if (t.length > max) throw new ErroReserva(400, `${rotulo} muito longo (máximo ${max} caracteres)`);
    return t || null;
  };
  const data = String(b.data || '');
  if (!DATA_RE.test(data) || Number.isNaN(new Date(`${data}T12:00:00`).getTime())) throw new ErroReserva(400, 'Data inválida');
  const hora = (v, rotulo) => {
    const t = String(v ?? '').trim();
    if (!t) return null;
    if (!HORA_RE.test(t)) throw new ErroReserva(400, `${rotulo}: use o formato HH:MM`);
    return t;
  };
  const horaInicio = hora(b.horaInicio, 'Hora de início');
  const horaFim = hora(b.horaFim, 'Hora de fim');
  if (horaFim && !horaInicio) throw new ErroReserva(400, 'Informe a hora de início antes da hora de fim');
  let numConvidados = null;
  if (b.numConvidados !== undefined && b.numConvidados !== null && String(b.numConvidados).trim() !== '') {
    numConvidados = Number(b.numConvidados);
    if (!Number.isInteger(numConvidados) || numConvidados < 1 || numConvidados > 100000) throw new ErroReserva(400, 'Número de convidados inválido');
  }
  return {
    titulo: texto(b.titulo, 120, 'Título', true),
    solicitante: texto(b.solicitante, 100, 'Solicitante'),
    telefone: texto(b.telefone, 30, 'Telefone'),
    data, horaInicio, horaFim, numConvidados,
    observacao: texto(b.observacao, 500, 'Observação'),
  };
}

// O que já está marcado no mesmo dia no restaurante/ATPN (fora a própria reserva).
async function conflitosDoDia({ data, horaInicio, horaFim }, agendaIdIgnorado) {
  if (!integracaoConfigurada()) return { configurado: false, conflitos: [] };
  const eventos = await buscarEventos(data, data, { paraConflito: true });
  const existentes = eventos.filter((e) => e.id !== agendaIdIgnorado);
  const lista = detectarConflitos({ horaInicio, horaFim }, existentes).map((e) => ({
    titulo: e.titulo, horaInicio: e.horaInicio, horaFim: e.horaFim, origem: e.origem, motivo: e.motivo,
  }));
  return { configurado: true, conflitos: lista };
}

function observacaoDaAgenda(r) {
  return [r.num_convidados ? `${r.num_convidados} pessoas` : null, r.solicitante ? `Solicitante: ${r.solicitante}` : null, r.observacao]
    .filter(Boolean).join(' · ') || null;
}

async function gravarNaAgenda(r, usuario) {
  if (!integracaoConfigurada()) throw new ErroReserva(409, 'Integração com o PDV Jabá não configurada — não dá pra confirmar (a reserva precisa entrar na agenda compartilhada)');
  const id = `${prefixoAgenda}${r.id}`;
  // reserva da ATPN entra na agenda como 'atpn' (se mudarem pra 'ambos' no calendário, o upsert não desfaz)
  const comEscopo = await temEscopo();
  await jabaPool.query(
    `INSERT INTO agenda_eventos (id, loja_id, tipo, data, hora_inicio, hora_fim, titulo, usuario_id, usuario_nome, observacao, criado_por${comEscopo ? ', escopo' : ''})
     VALUES ($1, $2, 'evento', $3, $4, $5, $6, $7, $8, $9, $10${comEscopo ? ", 'atpn'" : ''})
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, hora_inicio = EXCLUDED.hora_inicio, hora_fim = EXCLUDED.hora_fim,
       titulo = EXCLUDED.titulo, observacao = EXCLUDED.observacao
     WHERE agenda_eventos.loja_id = EXCLUDED.loja_id`,
    [id, JABA_LOJA_ID, r.data, r.hora_inicio, r.hora_fim, r.titulo, String(usuario.pessoaId), usuario.nome, observacaoDaAgenda(r), usuario.nome]
  );
  return id;
}

async function removerDaAgenda(agendaId) {
  if (!agendaId || !integracaoConfigurada()) return;
  // só apaga linha DA ATPN — nunca mexe em evento de outra loja
  await jabaPool.query('DELETE FROM agenda_eventos WHERE id = $1 AND loja_id = $2', [agendaId, JABA_LOJA_ID]);
}

const admin = [exigirPapel()];

router.get('/', async (req, res, next) => {
  const filtro = req.query.filtro || 'abertas';
  const mapa = { abertas: ['novo', 'negociando'], confirmadas: ['confirmado'], encerradas: ['recusado', 'concluido'], todas: STATUS };
  if (!mapa[filtro]) return res.status(400).json({ erro: 'filtro inválido' });
  try {
    const { rows } = await pool.query(
      `SELECT ${COLUNAS} FROM reservas WHERE status = ANY($1)
       ORDER BY ${filtro === 'encerradas' ? 'data DESC' : 'data ASC'}, hora_inicio NULLS LAST, id LIMIT 300`,
      [mapa[filtro]]
    );
    // equipe escalada em cada reserva (vem da escala do calendário)
    if (rows.length) {
      const eq = await pool.query(
        `SELECT e.reserva_id AS "reservaId", p.id AS "pessoaId", p.nome FROM escalas e JOIN pessoas p ON p.id = e.pessoa_id
         WHERE e.reserva_id = ANY($1) ORDER BY p.nome`, [rows.map((r) => r.id)]
      );
      const porReserva = new Map();
      eq.rows.forEach((x) => { if (!porReserva.has(x.reservaId)) porReserva.set(x.reservaId, []); porReserva.get(x.reservaId).push({ pessoaId: x.pessoaId, nome: x.nome }); });
      rows.forEach((r) => { r.equipe = porReserva.get(r.id) || []; });
    }
    // conflitos só importam enquanto a reserva ainda está em aberto
    let integracao = integracaoConfigurada();
    const porData = new Map();
    for (const r of rows) {
      if (req.query.semConflitos) break; // o calendário só precisa da lista, sem consultar o PDV de cada data
      if (!['novo', 'negociando'].includes(r.status)) continue;
      try {
        const c = await conflitosDoDia(r, r.agendaId);
        r.conflitos = c.conflitos;
        integracao = c.configurado;
      } catch (err) {
        // falha de leitura NÃO vira "sem conflito": a tela mostra que não deu pra checar
        console.error('Reservas: falha ao checar conflitos', err.message);
        r.conflitos = null;
      }
      porData.set(r.data, true);
    }
    res.json({ configurado: integracao, reservas: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/conflitos', async (req, res, next) => {
  const { data, horaInicio, horaFim, ignorarId } = req.query;
  if (!DATA_RE.test(String(data || ''))) return res.status(400).json({ erro: 'data inválida' });
  try {
    let agendaIgnorada = null;
    if (ignorarId) {
      const r = await pool.query('SELECT agenda_id FROM reservas WHERE id = $1', [Number(ignorarId)]);
      agendaIgnorada = r.rows[0]?.agenda_id || null;
    }
    res.json(await conflitosDoDia({ data, horaInicio: horaInicio || null, horaFim: horaFim || null }, agendaIgnorada));
  } catch (err) {
    next(err);
  }
});

router.post('/', ...admin, async (req, res, next) => {
  try {
    const v = validar(req.body);
    const { rows } = await pool.query(
      `INSERT INTO reservas (titulo, solicitante, telefone, data, hora_inicio, hora_fim, num_convidados, observacao, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUNAS}`,
      [v.titulo, v.solicitante, v.telefone, v.data, v.horaInicio, v.horaFim, v.numConvidados, v.observacao, req.usuario.pessoaId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err instanceof ErroReserva) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

// data sempre como texto AAAA-MM-DD (o pg devolve DATE como objeto Date, e o
// fuso do servidor já enganou muita conta de dia)
const COLUNAS_CRUAS = `id, titulo, solicitante, telefone, to_char(data, 'YYYY-MM-DD') AS data, hora_inicio, hora_fim,
  num_convidados, observacao, status, agenda_id`;

async function buscarReserva(id) {
  const { rows } = await pool.query(`SELECT ${COLUNAS_CRUAS} FROM reservas WHERE id = $1`, [id]);
  return rows[0] || null;
}

router.put('/:id', ...admin, async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const v = validar(req.body);
    const atual = await buscarReserva(id);
    if (!atual) return res.status(404).json({ erro: 'Reserva não encontrada' });

    // reserva já confirmada que mudou de dia/horário: checa conflito de novo
    const mudouAgenda = atual.status === 'confirmado'
      && (v.data !== atual.data || v.horaInicio !== atual.hora_inicio || v.horaFim !== atual.hora_fim);
    if (mudouAgenda && !req.body.forcar) {
      const c = await conflitosDoDia(v, atual.agenda_id);
      if (c.conflitos.length) return res.status(409).json({ erro: 'Conflito de espaço nessa data/horário', conflitos: c.conflitos });
    }

    const { rows } = await pool.query(
      `UPDATE reservas SET titulo = $1, solicitante = $2, telefone = $3, data = $4, hora_inicio = $5, hora_fim = $6,
              num_convidados = $7, observacao = $8, atualizado_em = now()
       WHERE id = $9 RETURNING ${COLUNAS_CRUAS}`,
      [v.titulo, v.solicitante, v.telefone, v.data, v.horaInicio, v.horaFim, v.numConvidados, v.observacao, id]
    );
    if (rows[0].status === 'confirmado' || rows[0].status === 'concluido') {
      if (rows[0].agenda_id) await gravarNaAgenda(rows[0], req.usuario);
    }
    // a equipe escalada acompanha o dia/horário/título da reserva
    await pool.query(
      `UPDATE escalas SET data = $1, hora_inicio = $2, hora_fim = $3, observacao = $4 WHERE reserva_id = $5`,
      [v.data, v.horaInicio, v.horaFim, `Evento: ${v.titulo}`.slice(0, 300), id]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ErroReserva) return res.status(err.status).json({ erro: err.message, conflitos: err.extra });
    next(err);
  }
});

// Observação interna da equipe (ex.: "orçamento enviado, sinal pago").
router.put('/:id/obs-equipe', ...admin, async (req, res, next) => {
  const texto = String(req.body?.obsEquipe ?? '').trim();
  if (texto.length > 500) return res.status(400).json({ erro: 'Observação muito longa (máximo 500 caracteres)' });
  try {
    const { rowCount } = await pool.query('UPDATE reservas SET obs_equipe = $1, atualizado_em = now() WHERE id = $2', [texto || null, Number(req.params.id)]);
    if (!rowCount) return res.status(404).json({ erro: 'Reserva não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const TRANSICOES = {
  novo: ['negociando', 'confirmado', 'recusado'],
  negociando: ['novo', 'confirmado', 'recusado'],
  confirmado: ['negociando', 'recusado', 'concluido'],
  recusado: ['novo', 'negociando'],
  concluido: ['confirmado'],
};

router.post('/:id/status', ...admin, async (req, res, next) => {
  const id = Number(req.params.id);
  const novo = req.body?.status;
  if (!STATUS.includes(novo)) return res.status(400).json({ erro: 'status inválido' });
  try {
    const r = await buscarReserva(id);
    if (!r) return res.status(404).json({ erro: 'Reserva não encontrada' });
    if (r.status === novo) return res.json({ ok: true });
    if (!TRANSICOES[r.status].includes(novo)) throw new ErroReserva(409, `Não dá pra ir de "${r.status}" para "${novo}"`);

    let agendaId = r.agenda_id;
    if (novo === 'confirmado') {
      if (!req.body.forcar) {
        const c = await conflitosDoDia({ data: r.data, horaInicio: r.hora_inicio, horaFim: r.hora_fim }, r.agenda_id);
        if (c.conflitos.length) throw new ErroReserva(409, 'Conflito de espaço nessa data/horário', c.conflitos);
      }
      agendaId = await gravarNaAgenda(r, req.usuario);
    } else if (novo !== 'concluido') {
      // saiu de "confirmado": some da agenda compartilhada (concluído continua lá, o evento aconteceu)
      await removerDaAgenda(r.agenda_id);
      agendaId = null;
    }
    await pool.query('UPDATE reservas SET status = $1, agenda_id = $2, atualizado_em = now() WHERE id = $3', [novo, agendaId, id]);
    // reserva recusada não acontece: sai da escala da equipe
    if (novo === 'recusado') await pool.query('DELETE FROM escalas WHERE reserva_id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ErroReserva) return res.status(err.status).json({ erro: err.message, conflitos: err.extra });
    next(err);
  }
});

router.delete('/:id', ...admin, async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const r = await buscarReserva(id);
    if (!r) return res.status(404).json({ erro: 'Reserva não encontrada' });
    await removerDaAgenda(r.agenda_id);
    await pool.query('DELETE FROM reservas WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
