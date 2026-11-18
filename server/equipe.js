const { registrarHistorico } = require('./db');

class ErroEquipe extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

// Garante que sempre sobra pelo menos um Administrador ativo depois da mudança.
async function sobraAdministrador(client, pessoaIdExcluida) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM pessoas p JOIN cargos c ON c.id = p.cargo_id
     WHERE c.administrador AND p.ativo AND p.id <> $1`,
    [pessoaIdExcluida]
  );
  return rows[0].n > 0;
}

// Muda nome/cargo/ativo de uma pessoa DENTRO de uma transação já aberta (o
// chamador faz BEGIN/COMMIT). Guarda o estado anterior no histórico (nunca o
// PIN) e aplica as travas: sempre sobra um Administrador ativo e ninguém
// desativa/rebaixa a si mesmo. Vale pro PUT de Equipe e pra restauração.
async function atualizarPessoa(client, usuarioLogado, id, { nome, cargoId, ativo }) {
  const atual = (await client.query(
    `SELECT p.id, p.nome, p.ativo, p.cargo_id, c.administrador
     FROM pessoas p JOIN cargos c ON c.id = p.cargo_id WHERE p.id = $1 FOR UPDATE`, [id]
  )).rows[0];
  if (!atual) throw new ErroEquipe(404, 'Pessoa não encontrada');

  const novoNome = nome !== undefined ? String(nome).trim() : atual.nome;
  if (!novoNome || novoNome.length > 80) throw new ErroEquipe(400, 'Nome inválido');
  const novoCargo = cargoId !== undefined ? Number(cargoId) : atual.cargo_id;
  const novoAtivo = ativo !== undefined ? !!ativo : atual.ativo;

  const cargo = (await client.query('SELECT administrador FROM cargos WHERE id = $1', [novoCargo])).rows[0];
  if (!cargo) throw new ErroEquipe(400, 'Cargo não existe');

  const perdeAdmin = atual.administrador && atual.ativo && (!cargo.administrador || !novoAtivo);
  if (perdeAdmin && !(await sobraAdministrador(client, id))) {
    throw new ErroEquipe(409, 'Precisa sobrar pelo menos um Administrador ativo');
  }
  if (id === usuarioLogado.pessoaId && (!novoAtivo || !cargo.administrador)) {
    throw new ErroEquipe(409, 'Você não pode desativar nem rebaixar a si mesmo');
  }

  const mudou = novoNome !== atual.nome || novoCargo !== atual.cargo_id || novoAtivo !== atual.ativo;
  if (mudou) {
    await registrarHistorico(client, {
      tabela: 'pessoas', registroId: id,
      dadoAnterior: { nome: atual.nome, cargoId: atual.cargo_id, ativo: atual.ativo },
      alteradoPor: usuarioLogado.pessoaId,
    });
    await podarHistorico(client, 'pessoas', id);
  }
  await client.query('UPDATE pessoas SET nome = $1, cargo_id = $2, ativo = $3 WHERE id = $4', [novoNome, novoCargo, novoAtivo, id]);
}

// Mantém só as 50 versões mais recentes de cada registro (mesma regra do PDV).
async function podarHistorico(client, tabela, registroId) {
  await client.query(
    `DELETE FROM app_dados_historico WHERE id IN (
       SELECT id FROM app_dados_historico WHERE tabela = $1 AND registro_id = $2
       ORDER BY alterado_em DESC, id DESC OFFSET 50)`,
    [tabela, registroId]
  );
}

module.exports = { ErroEquipe, atualizarPessoa, podarHistorico };
