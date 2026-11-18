const express = require('express');
const { jabaPool, JABA_LOJA_ID, integracaoConfigurada } = require('../jabaDb');
const { exigirAuth, exigirAba, exigirPapel } = require('../auth');

const router = express.Router();
router.use(exigirAuth, exigirAba('calendario'));

// Lê/escreve direto em `agenda_eventos` do banco do PDV Jabá, escopado pelo
// loja_id da ATPN — nunca mexe em linha de outra loja. Mesmo formato de
// campos que o próprio PDV Jabá usa (ver api/server.js de lá, rota
// /api/lojas/:lojaId/agenda), pra um evento criado aqui aparecer certinho
// no calendário consolidado do admin do Jabá também.

router.get('/', async (req, res, next) => {
  if (!integracaoConfigurada()) return res.json({ configurado: false, eventos: [] });
  const { inicio, fim } = req.query;
  if (!inicio || !fim) return res.status(400).json({ erro: 'inicio e fim obrigatórios' });
  try {
    const { rows } = await jabaPool.query(
      `SELECT id, tipo, to_char(data, 'YYYY-MM-DD') AS data, hora_inicio AS "horaInicio", hora_fim AS "horaFim",
              titulo, usuario_nome AS "usuarioNome", observacao
       FROM agenda_eventos WHERE loja_id = $1 AND data BETWEEN $2 AND $3
       ORDER BY data, hora_inicio NULLS LAST`,
      [JABA_LOJA_ID, inicio, fim]
    );
    res.json({ configurado: true, eventos: rows });
  } catch (err) {
    next(err);
  }
});

// Criar/editar/remover — só Administrador (mesma regra do PDV Jabá pro
// calendário dele: todo mundo vê, só admin mexe).
router.post('/', exigirPapel(), async (req, res, next) => {
  if (!integracaoConfigurada()) return res.status(409).json({ erro: 'Integração com o PDV Jabá ainda não configurada' });
  const { id, tipo, data, horaInicio, horaFim, titulo, observacao } = req.body || {};
  if (!id || (tipo !== 'evento' && tipo !== 'escala') || !data || !String(titulo || '').trim()) {
    return res.status(400).json({ erro: 'Campos "id", "tipo" ("evento"/"escala"), "data" e "titulo" são obrigatórios' });
  }
  try {
    await jabaPool.query(
      `INSERT INTO agenda_eventos (id, loja_id, tipo, data, hora_inicio, hora_fim, titulo, usuario_id, usuario_nome, observacao, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
      [id, JABA_LOJA_ID, tipo, data, horaInicio || null, horaFim || null, titulo.trim(),
       String(req.usuario.pessoaId), req.usuario.nome, observacao || null, req.usuario.nome]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', exigirPapel(), async (req, res, next) => {
  if (!integracaoConfigurada()) return res.status(409).json({ erro: 'Integração com o PDV Jabá ainda não configurada' });
  const { data, horaInicio, horaFim, titulo, observacao } = req.body || {};
  if (!data || !String(titulo || '').trim()) return res.status(400).json({ erro: '"data" e "titulo" são obrigatórios' });
  try {
    const { rowCount } = await jabaPool.query(
      `UPDATE agenda_eventos SET data = $1, hora_inicio = $2, hora_fim = $3, titulo = $4, observacao = $5
       WHERE id = $6 AND loja_id = $7`,
      [data, horaInicio || null, horaFim || null, titulo.trim(), observacao || null, req.params.id, JABA_LOJA_ID]
    );
    if (!rowCount) return res.status(404).json({ erro: 'Evento não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', exigirPapel(), async (req, res, next) => {
  if (!integracaoConfigurada()) return res.status(409).json({ erro: 'Integração com o PDV Jabá ainda não configurada' });
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

module.exports = router;
