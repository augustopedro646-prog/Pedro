const express = require('express');
const { jabaPool, JABA_LOJA_ID, integracaoConfigurada, temEscopo } = require('../jabaDb');
const { pool } = require('../db');
const { exigirAuth, exigirAba, exigirPapel } = require('../auth');

const router = express.Router();
router.use(exigirAuth);

// Quem tem a aba Calendário OU a aba Eventos pode ler a agenda (as duas telas
// mostram os mesmos eventos); alterar continua exigindo a aba Calendário.
async function exigirCalendarioOuEventos(req, res, next) {
  if (req.usuario.administrador) return next();
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM permissoes WHERE cargo_id = $1 AND aba IN ('calendario', 'eventos') AND permitido LIMIT 1`,
      [req.usuario.cargoId]
    );
    if (rows[0]) return next();
    res.status(403).json({ erro: 'Sem permissão pra essa aba' });
  } catch (err) {
    next(err);
  }
}

// Lê/escreve direto em `agenda_eventos` do banco do PDV Jabá, escopado pelo
// loja_id da ATPN — nunca mexe em linha de outra loja. Mesmo formato de
// campos que o próprio PDV Jabá usa (ver api/server.js de lá, rota
// /api/lojas/:lojaId/agenda), pra um evento criado aqui aparecer certinho
// no calendário consolidado do admin do Jabá também.

router.get('/', exigirCalendarioOuEventos, async (req, res, next) => {
  if (!integracaoConfigurada()) return res.json({ configurado: false, eventos: [] });
  const { inicio, fim } = req.query;
  if (!inicio || !fim) return res.status(400).json({ erro: 'inicio e fim obrigatórios' });
  try {
    res.json({ configurado: true, eventos: await buscarEventos(inicio, fim) });
  } catch (err) {
    next(err);
  }
});

// Só LEITURA do que é do PDV Jabá: eventos (nunca escalas/equipe, que a
// ATPN tem as suas) das outras lojas + reservas/encomendas de evento, no
// mesmo critério do calendário consolidado do PDV. "proprio" = criado
// pela ATPN (só esses podem ser removidos aqui). Também usada pelo Início.
async function buscarEventos(inicio, fim, { paraConflito = false } = {}) {
  {
    // Escopo (coluna criada pelo PDV Jabá): a agenda da ATPN só mostra 'atpn' e
    // 'ambos' + o que a própria ATPN criou. Pra checar conflito de espaço (mesmo
    // salão), vale tudo que ocupa o salão: só 'externo' (fora do espaço) fica de fora.
    // Sem a coluna ainda: mostra só o que é da ATPN (nada do Jabá vaza).
    const comEscopo = await temEscopo();
    const filtroAgenda = comEscopo
      ? (paraConflito ? "AND (a.loja_id = $1 OR a.escopo <> 'externo')" : "AND (a.loja_id = $1 OR a.escopo IN ('atpn', 'ambos'))")
      : (paraConflito ? '' : 'AND a.loja_id = $1');
    const filtroEnc = comEscopo
      ? (paraConflito ? "AND e.escopo <> 'externo'" : "AND e.escopo IN ('atpn', 'ambos')")
      : (paraConflito ? '' : 'AND false');
    const colEscopo = comEscopo ? 'a.escopo' : "'atpn'::text";
    const colEscopoEnc = comEscopo ? 'e.escopo' : "'jaba'::text";
    const { rows } = await jabaPool.query(
      `SELECT * FROM (
         SELECT a.id, 'evento'::text AS tipo, to_char(a.data, 'YYYY-MM-DD') AS data, a.hora_inicio AS "horaInicio", a.hora_fim AS "horaFim",
                a.titulo, a.usuario_nome AS "usuarioNome", a.observacao,
                (a.loja_id = $1) AS proprio, l.nome AS origem, ${colEscopo} AS escopo
         FROM agenda_eventos a LEFT JOIN lojas l ON l.id = a.loja_id
         WHERE a.tipo = 'evento' AND a.evento_id IS NULL AND a.data BETWEEN $2 AND $3 ${filtroAgenda}
         UNION ALL
         SELECT 'enc-' || e.id AS id, 'evento'::text AS tipo, to_char(e.data_evento, 'YYYY-MM-DD') AS data,
                e.horario AS "horaInicio", NULL::text AS "horaFim",
                (CASE e.categoria WHEN 'reserva' THEN '🍽 ' ELSE '🎉 ' END) || e.nome
                  || (CASE WHEN e.status IN ('novo','negociando') THEN ' (a confirmar)' ELSE '' END) AS titulo,
                NULL::text AS "usuarioNome",
                concat_ws(' · ', CASE WHEN e.num_convidados IS NOT NULL THEN e.num_convidados || ' pessoas' END, e.servico) AS observacao,
                false AS proprio, l.nome AS origem, ${colEscopoEnc} AS escopo
         FROM encomendas_evento e LEFT JOIN lojas l ON l.id = e.loja_id
         WHERE e.data_evento BETWEEN $2 AND $3 AND e.status <> 'recusado'
           AND e.tipo_desejado IS DISTINCT FROM 'Evento do calendário' ${filtroEnc}
       ) t ORDER BY data, "horaInicio" NULLS LAST`,
      [JABA_LOJA_ID, inicio, fim]
    );
    return rows;
  }
}

// Criar/editar/remover — só Administrador (mesma regra do PDV Jabá pro
// calendário dele: todo mundo vê, só admin mexe).
router.post('/', exigirAba('calendario'), exigirPapel(), async (req, res, next) => {
  if (!integracaoConfigurada()) return res.status(409).json({ erro: 'Integração com o PDV Jabá ainda não configurada' });
  const { id, tipo, data, horaInicio, horaFim, titulo, observacao } = req.body || {};
  const escopo = req.body?.escopo === 'ambos' ? 'ambos' : 'atpn';
  if (!id || tipo !== 'evento' || !data || !String(titulo || '').trim()) {
    return res.status(400).json({ erro: 'Campos "id", "tipo" ("evento"), "data" e "titulo" são obrigatórios' });
  }
  try {
    const comEscopo = await temEscopo();
    await jabaPool.query(
      `INSERT INTO agenda_eventos (id, loja_id, tipo, data, hora_inicio, hora_fim, titulo, usuario_id, usuario_nome, observacao, criado_por${comEscopo ? ', escopo' : ''})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11${comEscopo ? ', $12' : ''}) ON CONFLICT (id) DO NOTHING`,
      [id, JABA_LOJA_ID, tipo, data, horaInicio || null, horaFim || null, titulo.trim(),
       String(req.usuario.pessoaId), req.usuario.nome, observacao || null, req.usuario.nome, ...(comEscopo ? [escopo] : [])]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', exigirAba('calendario'), exigirPapel(), async (req, res, next) => {
  if (!integracaoConfigurada()) return res.status(409).json({ erro: 'Integração com o PDV Jabá ainda não configurada' });
  if (String(req.params.id).startsWith('atpn-res-')) return res.status(409).json({ erro: 'Esse evento vem de uma reserva — edite na aba Eventos' });
  const { data, horaInicio, horaFim, titulo, observacao } = req.body || {};
  const escopo = req.body?.escopo === 'ambos' ? 'ambos' : req.body?.escopo === 'atpn' ? 'atpn' : null;
  if (!data || !String(titulo || '').trim()) return res.status(400).json({ erro: '"data" e "titulo" são obrigatórios' });
  try {
    const mudaEscopo = escopo && (await temEscopo());
    const { rowCount } = await jabaPool.query(
      `UPDATE agenda_eventos SET data = $1, hora_inicio = $2, hora_fim = $3, titulo = $4, observacao = $5${mudaEscopo ? ', escopo = $8' : ''}
       WHERE id = $6 AND loja_id = $7`,
      [data, horaInicio || null, horaFim || null, titulo.trim(), observacao || null, req.params.id, JABA_LOJA_ID, ...(mudaEscopo ? [escopo] : [])]
    );
    if (!rowCount) return res.status(404).json({ erro: 'Evento não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', exigirAba('calendario'), exigirPapel(), async (req, res, next) => {
  if (!integracaoConfigurada()) return res.status(409).json({ erro: 'Integração com o PDV Jabá ainda não configurada' });
  if (String(req.params.id).startsWith('atpn-res-')) return res.status(409).json({ erro: 'Esse evento vem de uma reserva — remova ou mude o status dela na aba Eventos' });
  try {
    const { rowCount } = await jabaPool.query(
      'DELETE FROM agenda_eventos WHERE id = $1 AND loja_id = $2',
      [req.params.id, JABA_LOJA_ID]
    );
    if (!rowCount) return res.status(404).json({ erro: 'Evento não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.buscarEventos = buscarEventos;
module.exports = router;
