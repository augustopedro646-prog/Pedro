const express = require('express');
const { pool } = require('../db');
const { exigirAuth, exigirAba } = require('../auth');

const router = express.Router();
router.use(exigirAuth, exigirAba('reveillon'));

const COLUNAS = `r.id, r.mesa_numero AS "mesa", r.nome, r.telefone, r.socio_id AS "socioId", s.nome AS "socioNome",
  r.pessoas, r.valor_total::float8 AS "valorTotal", r.valor_pago::float8 AS "valorPago", r.status, r.observacao,
  r.atualizado_em AS "atualizadoEm"`;
const DE = 'FROM reveillon_reservas r LEFT JOIN socios s ON s.id = r.socio_id';

class Erro extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function validar(b) {
  b = b || {};
  const texto = (v, max, rotulo, obrig) => {
    const t = String(v ?? '').trim();
    if (obrig && !t) throw new Erro(400, `${rotulo} é obrigatório`);
    if (t.length > max) throw new Erro(400, `${rotulo} muito longo (máximo ${max})`);
    return t || null;
  };
  const num = (v, rotulo, min) => {
    const n = Number(String(v ?? 0).replace(',', '.'));
    if (!Number.isFinite(n) || n < min || n > 1000000) throw new Erro(400, `${rotulo} inválido`);
    return Math.round(n * 100) / 100;
  };
  const mesa = Number(b.mesa);
  if (!Number.isInteger(mesa) || mesa < 1 || mesa > 999) throw new Erro(400, 'Mesa inválida');
  const pessoas = Number(b.pessoas ?? 1);
  if (!Number.isInteger(pessoas) || pessoas < 1 || pessoas > 99) throw new Erro(400, 'Número de pessoas inválido');
  const valorTotal = num(b.valorTotal, 'Valor total', 0);
  const valorPago = num(b.valorPago, 'Valor pago', 0);
  if (valorPago > valorTotal) throw new Erro(400, 'O valor pago não pode passar do valor total');
  const status = ['reservada', 'confirmada'].includes(b.status) ? b.status : 'reservada';
  const socioId = b.socioId ? Number(b.socioId) : null;
  if (socioId !== null && !Number.isInteger(socioId)) throw new Erro(400, 'Sócio inválido');
  return {
    mesa, pessoas, valorTotal, valorPago, status, socioId,
    nome: texto(b.nome, 80, 'Nome', true), telefone: texto(b.telefone, 30, 'Telefone'), observacao: texto(b.observacao, 500, 'Observação'),
  };
}

const tratar = (res, next, err) => {
  if (err instanceof Erro) return res.status(err.status).json({ erro: err.message });
  if (err.code === '23505') return res.status(409).json({ erro: 'Essa mesa já tem uma reserva ativa' });
  return next(err);
};

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.status <> 'cancelada' ORDER BY r.mesa_numero`);
    const soma = (f) => rows.reduce((a, r) => a + f(r), 0);
    res.json({
      reservas: rows,
      resumo: {
        mesasReservadas: rows.length,
        confirmadas: rows.filter((r) => r.status === 'confirmada').length,
        pessoas: soma((r) => r.pessoas),
        valorTotal: Math.round(soma((r) => r.valorTotal) * 100) / 100,
        valorPago: Math.round(soma((r) => r.valorPago) * 100) / 100,
      },
    });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const v = validar(req.body);
    const { rows } = await pool.query(
      `INSERT INTO reveillon_reservas (mesa_numero, nome, telefone, socio_id, pessoas, valor_total, valor_pago, status, observacao, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [v.mesa, v.nome, v.telefone, v.socioId, v.pessoas, v.valorTotal, v.valorPago, v.status, v.observacao, req.usuario.pessoaId]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) { tratar(res, next, err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const v = validar(req.body);
    const { rowCount } = await pool.query(
      `UPDATE reveillon_reservas SET mesa_numero=$1, nome=$2, telefone=$3, socio_id=$4, pessoas=$5, valor_total=$6, valor_pago=$7,
         status=$8, observacao=$9, atualizado_em=now() WHERE id=$10 AND status <> 'cancelada'`,
      [v.mesa, v.nome, v.telefone, v.socioId, v.pessoas, v.valorTotal, v.valorPago, v.status, v.observacao, id]
    );
    if (!rowCount) return res.status(404).json({ erro: 'Reserva não encontrada' });
    res.json({ ok: true });
  } catch (err) { tratar(res, next, err); }
});

// Cancelar não apaga: a linha fica (status cancelada) e a mesa volta a ficar livre.
router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE reveillon_reservas SET status='cancelada', atualizado_em=now() WHERE id=$1 AND status <> 'cancelada'`, [Number(req.params.id)]
    );
    if (!rowCount) return res.status(404).json({ erro: 'Reserva não encontrada' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
