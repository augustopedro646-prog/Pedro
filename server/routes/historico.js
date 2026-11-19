const express = require('express');
const { pool, registrarHistorico } = require('../db');
const { exigirAuth, exigirPapel } = require('../auth');
const { ABAS } = require('../abas');
const { ErroEquipe, atualizarPessoa, podarHistorico } = require('../equipe');
const { salvarAssociacao } = require('../associacao');

const router = express.Router();
router.use(exigirAuth, exigirPapel()); // só Administrador

// tipo da tela -> tabela guardada no histórico
const TIPOS = { associacao: 'configuracoes', permissoes: 'permissoes', pessoas: 'pessoas' };

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

async function resumir(tabela, dado, cargosPorId, pessoaNome) {
  if (tabela === 'configuracoes') {
    const abertos = (dado.horario?.dias || []).map((d, i) => (d.fechado ? null : DIAS[i])).filter(Boolean);
    return `${dado.nome || '—'} · ${dado.endereco || 'sem endereço'} · abre: ${abertos.length ? abertos.join(', ') : 'nenhum dia'}`;
  }
  if (tabela === 'permissoes') {
    const porCargo = new Map();
    (dado || []).forEach((p) => { if (p.permitido) porCargo.set(p.cargoId, (porCargo.get(p.cargoId) || 0) + 1); });
    const partes = [...porCargo.entries()].map(([id, n]) => `${cargosPorId.get(id) || '#' + id}: ${n} aba${n === 1 ? '' : 's'}`);
    return partes.length ? partes.join(' · ') : 'nenhum cargo com aba liberada';
  }
  return `Pessoa "${pessoaNome}" (nome de hoje) — antes: nome "${dado.nome}", cargo ${cargosPorId.get(dado.cargoId) || '#' + dado.cargoId}, ${dado.ativo ? 'ativo' : 'desativado'}`;
}

router.get('/', async (req, res, next) => {
  const tabela = TIPOS[req.query.tipo];
  if (!tabela) return res.status(400).json({ erro: 'tipo inválido' });
  try {
    const [{ rows }, cargos] = await Promise.all([
      pool.query(
        `SELECT h.id, h.registro_id AS "registroId", h.dado_anterior AS "dado", h.alterado_em AS "alteradoEm",
                a.nome AS "alteradoPor", p.nome AS "pessoaNome"
         FROM app_dados_historico h
         LEFT JOIN pessoas a ON a.id = h.alterado_por
         LEFT JOIN pessoas p ON p.id = h.registro_id AND h.tabela = 'pessoas'
         WHERE h.tabela = $1 ORDER BY h.alterado_em DESC, h.id DESC LIMIT 50`,
        [tabela]
      ),
      pool.query('SELECT id, nome FROM cargos'),
    ]);
    const cargosPorId = new Map(cargos.rows.map((c) => [c.id, c.nome]));
    const versoes = [];
    for (const r of rows) {
      versoes.push({
        id: r.id, alteradoEm: r.alteradoEm, alteradoPor: r.alteradoPor || '—',
        resumo: await resumir(tabela, r.dado, cargosPorId, r.pessoaNome || `Pessoa #${r.registroId}`),
      });
    }
    res.json(versoes);
  } catch (err) {
    next(err);
  }
});

// Restaurar = voltar pro estado ANTERIOR daquela alteração. O estado atual
// também vai pro histórico, então dá pra desfazer a restauração.
router.post('/:id/restaurar', async (req, res, next) => {
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const h = (await client.query('SELECT id, tabela, registro_id, dado_anterior FROM app_dados_historico WHERE id = $1', [id])).rows[0];
    if (!h || !Object.values(TIPOS).includes(h.tabela)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Versão não encontrada' });
    }

    if (h.tabela === 'configuracoes') {
      await salvarAssociacao(client, req.usuario, h.dado_anterior, { origemRestauracao: true });
    } else if (h.tabela === 'pessoas') {
      await atualizarPessoa(client, req.usuario, h.registro_id, h.dado_anterior);
    } else {
      const atuais = (await client.query('SELECT cargo_id AS "cargoId", aba, permitido FROM permissoes ORDER BY cargo_id, aba')).rows;
      await registrarHistorico(client, { tabela: 'permissoes', registroId: 0, dadoAnterior: JSON.stringify(atuais), alteradoPor: req.usuario.pessoaId });
      await podarHistorico(client, 'permissoes', 0);
      const cargosValidos = new Set((await client.query('SELECT id FROM cargos')).rows.map((c) => c.id));
      const abasValidas = new Set(ABAS.map((a) => a.id));
      await client.query('DELETE FROM permissoes');
      for (const p of h.dado_anterior) {
        if (cargosValidos.has(p.cargoId) && abasValidas.has(p.aba)) {
          await client.query('INSERT INTO permissoes (cargo_id, aba, permitido) VALUES ($1, $2, $3)', [p.cargoId, p.aba, !!p.permitido]);
        }
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ErroEquipe) return res.status(err.status).json({ erro: err.message });
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
