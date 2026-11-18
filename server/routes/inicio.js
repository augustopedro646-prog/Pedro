const express = require('express');
const { pool } = require('../db');
const { integracaoConfigurada } = require('../jabaDb');
const { exigirAuth, exigirAba } = require('../auth');
const { arrecadacaoPorMes, infoPlanilha } = require('../mensalidades');
const calendario = require('./calendario');
const tarefas = require('./tarefas');

const router = express.Router();
router.use(exigirAuth, exigirAba('inicio'));

const dataLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Cada bloco só vem se a pessoa tem a aba correspondente (Administrador tem
// todas): o Início nunca mostra um número que a pessoa não veria na aba.
async function abasPermitidas(usuario) {
  if (usuario.administrador) return new Set(['socios', 'tarefas', 'fluxo_caixa', 'calendario', 'eventos', 'ponto']);
  const { rows } = await pool.query('SELECT aba FROM permissoes WHERE cargo_id = $1 AND permitido', [usuario.cargoId]);
  return new Set(rows.map((r) => r.aba));
}

async function blocoSocios() {
  const { rows } = await pool.query(
    `SELECT clube, status, count(*)::int AS n,
            to_char(max(planilha_atualizada_em), 'YYYY-MM-DD') AS atualizado
     FROM socios GROUP BY clube, status`
  );
  const vazio = () => ({ total: 0, emDia: 0, atrasados: 0, seisOuMais: 0, desligados: 0 });
  const grupos = { todos: vazio(), cepe_atpn: vazio(), cepe: vazio() };
  let atualizado = null;
  for (const r of rows) {
    if (r.atualizado && (!atualizado || r.atualizado > atualizado)) atualizado = r.atualizado;
    for (const g of [grupos.todos, grupos[r.clube]]) {
      if (!g) continue;
      g.total += r.n;
      if (r.status === 'em_dia') g.emDia += r.n;
      else if (r.status === 'desligado') g.desligados += r.n;
      else g.atrasados += r.n;
      if (r.status === '6_meses_ou_mais') g.seisOuMais += r.n;
    }
  }
  return { grupos, atualizadoEm: atualizado };
}

async function blocoTarefas(usuario) {
  const hoje = new Date();
  const dataStr = dataLocal(hoje);
  const params = [];
  let where = 't.ativo = true';
  if (!usuario.administrador) {
    params.push(usuario.cargoId);
    where += ` AND t.cargo_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT t.id, t.titulo, t.etapa, t.frequencia, t.dias_semana, t.intervalo_dias, t.criado_em, c.nome AS "cargoNome"
     FROM tarefas t JOIN cargos c ON c.id = t.cargo_id WHERE ${where} ORDER BY t.titulo`,
    params
  );
  const doDia = rows.filter((t) => tarefas.aplicaNaData(t, new Date(`${dataStr}T00:00:00`)));
  let feitas = new Set();
  if (doDia.length) {
    const r = await pool.query('SELECT tarefa_id FROM tarefas_concluidas WHERE tarefa_id = ANY($1) AND data = $2', [doDia.map((t) => t.id), dataStr]);
    feitas = new Set(r.rows.map((x) => x.tarefa_id));
  }
  const pendentes = doDia.filter((t) => !feitas.has(t.id));
  return {
    total: doDia.length,
    concluidas: doDia.length - pendentes.length,
    pendentes: pendentes.slice(0, 6).map((t) => ({ id: t.id, titulo: t.titulo, etapa: t.etapa, cargoNome: t.cargoNome })),
    pendentesTotal: pendentes.length,
  };
}

async function blocoCaixa() {
  const hoje = new Date();
  const inicio = dataLocal(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
  const fim = dataLocal(new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0));
  const soma = async (tabela) => Number((await pool.query(`SELECT COALESCE(SUM(valor), 0) AS t FROM ${tabela} WHERE data BETWEEN $1 AND $2`, [inicio, fim])).rows[0].t);
  const [lancadas, despesas, porMes, planilha] = await Promise.all([
    soma('receitas'), soma('despesas'), arrecadacaoPorMes(inicio, fim), infoPlanilha(),
  ]);
  const chave = inicio.slice(0, 7);
  const mensalidades = porMes.get(chave) || 0;
  const receitas = lancadas + mensalidades;
  return {
    receitas, despesas, saldo: receitas - despesas, mensalidades,
    mensalidadesParcial: !!planilha.primeiroMesParcial && chave >= planilha.primeiroMesParcial,
  };
}

async function blocoEventos() {
  if (!integracaoConfigurada()) return { configurado: false, eventos: [] };
  const hoje = new Date();
  const fim = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + 7);
  try {
    const eventos = await calendario.buscarEventos(dataLocal(hoje), dataLocal(fim));
    return { configurado: true, eventos: eventos.slice(0, 8) };
  } catch (err) {
    console.error('Início: falha ao ler eventos do PDV Jabá', err.message);
    return { configurado: true, erro: true, eventos: [] };
  }
}

async function blocoPonto(usuario) {
  const { rows: meu } = await pool.query(
    `SELECT tipo, registrado_em AS "registradoEm" FROM pontos WHERE pessoa_id = $1 ORDER BY registrado_em DESC LIMIT 1`,
    [usuario.pessoaId]
  );
  const bloco = { meuUltimo: meu[0] || null, presentes: null };
  if (usuario.administrador) {
    const { rows } = await pool.query(
      `SELECT pe.nome, u.registrado_em AS "desde"
       FROM (SELECT DISTINCT ON (pessoa_id) pessoa_id, tipo, registrado_em FROM pontos ORDER BY pessoa_id, registrado_em DESC) u
       JOIN pessoas pe ON pe.id = u.pessoa_id
       WHERE u.tipo = 'entrada' AND pe.ativo AND u.registrado_em::date = current_date
       ORDER BY pe.nome`
    );
    bloco.presentes = rows;
  }
  return bloco;
}

router.get('/', async (req, res, next) => {
  try {
    const abas = await abasPermitidas(req.usuario);
    const quer = (...ids) => ids.some((id) => abas.has(id));
    const [socios, tarefasBloco, caixa, eventos, ponto] = await Promise.all([
      abas.has('socios') ? blocoSocios() : null,
      abas.has('tarefas') ? blocoTarefas(req.usuario) : null,
      abas.has('fluxo_caixa') ? blocoCaixa() : null,
      quer('calendario', 'eventos') ? blocoEventos() : null,
      abas.has('ponto') ? blocoPonto(req.usuario) : null,
    ]);
    res.json({ socios, tarefas: tarefasBloco, caixa, eventos, ponto });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
