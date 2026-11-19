const { registrarHistorico } = require('./db');
const { podarHistorico } = require('./equipe');

const CHAVE = 'associacao';
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const NOMES_DIA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

class ErroConfig extends Error {}

// jsonb não guarda a ordem das chaves, então comparar JSON.stringify direto
// acusaria "mudou" sempre. Compara com as chaves ordenadas.
function estavel(v) {
  if (Array.isArray(v)) return `[${v.map(estavel).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${estavel(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const igual = (a, b) => estavel(a) === estavel(b);

function horarioPadrao() {
  // tudo fechado até o administrador preencher — melhor que inventar horário
  return { dias: Array.from({ length: 7 }, () => ({ fechado: true, turnos: [] })) };
}

function padrao() {
  return { nome: 'ATPN — Associação dos Técnicos em Petróleo de Natal', telefone: '', whatsapp: '', email: '', instagram: '', endereco: '', horario: horarioPadrao() };
}

// Valida e normaliza o que veio da tela: só os campos conhecidos, tamanhos
// limitados, horários HH:MM e no máximo 2 turnos por dia (abre < fecha).
function validar(entrada) {
  const e = entrada || {};
  const texto = (v, max, rotulo) => {
    const t = String(v ?? '').trim();
    if (t.length > max) throw new ErroConfig(`${rotulo} muito longo (máximo ${max} caracteres)`);
    return t;
  };
  const nome = texto(e.nome, 120, 'Nome');
  if (!nome) throw new ErroConfig('Nome da associação é obrigatório');
  const whatsapp = texto(e.whatsapp, 20, 'WhatsApp').replace(/\D/g, '');
  const instagram = texto(e.instagram, 200, 'Instagram');
  if (instagram && !/^https?:\/\//i.test(instagram)) throw new ErroConfig('Instagram: use o link completo (começando com https://)');

  const diasEntrada = Array.isArray(e.horario?.dias) ? e.horario.dias : [];
  if (diasEntrada.length !== 7) throw new ErroConfig('O horário precisa ter os 7 dias da semana');
  const dias = diasEntrada.map((d, i) => {
    if (d.fechado) return { fechado: true, turnos: [] };
    const turnos = (Array.isArray(d.turnos) ? d.turnos : [])
      .filter((t) => t && (t.abre || t.fecha))
      .slice(0, 2);
    if (!turnos.length) throw new ErroConfig(`${NOMES_DIA[i]} está aberto mas sem horário (marque fechado ou preencha)`);
    for (const t of turnos) {
      if (!HORA_RE.test(t.abre || '') || !HORA_RE.test(t.fecha || '')) throw new ErroConfig('Horários no formato HH:MM, com abre e fecha preenchidos');
    }
    return { fechado: false, turnos: turnos.map((t) => ({ abre: t.abre, fecha: t.fecha })) };
  });

  return {
    nome,
    telefone: texto(e.telefone, 30, 'Telefone'),
    whatsapp,
    email: texto(e.email, 120, 'E-mail'),
    instagram,
    endereco: texto(e.endereco, 250, 'Endereço'),
    horario: { dias },
  };
}

async function lerAssociacao(db) {
  const { rows } = await db.query(
    `SELECT valor, atualizado_em AS "atualizadoEm" FROM configuracoes WHERE chave = $1`, [CHAVE]
  );
  return { valor: { ...padrao(), ...(rows[0]?.valor || {}) }, atualizadoEm: rows[0]?.atualizadoEm || null, configurado: !!rows[0] };
}

// Dentro de uma transação aberta pelo chamador. A versão ANTERIOR vai pro
// histórico (só se mudou de verdade) e o histórico fica nas últimas 50.
async function salvarAssociacao(client, usuario, entrada, { origemRestauracao = false } = {}) {
  const novo = origemRestauracao ? entrada : validar(entrada);
  const atual = (await client.query(`SELECT id, valor FROM configuracoes WHERE chave = $1 FOR UPDATE`, [CHAVE])).rows[0];
  if (!atual) {
    await client.query(
      `INSERT INTO configuracoes (chave, valor, atualizado_por) VALUES ($1, $2, $3)`,
      [CHAVE, JSON.stringify(novo), usuario.pessoaId]
    );
    return;
  }
  if (!igual(atual.valor, novo)) {
    await registrarHistorico(client, { tabela: 'configuracoes', registroId: atual.id, dadoAnterior: JSON.stringify(atual.valor), alteradoPor: usuario.pessoaId });
    await podarHistorico(client, 'configuracoes', atual.id);
  }
  await client.query(
    `UPDATE configuracoes SET valor = $1, atualizado_por = $2, atualizado_em = now() WHERE id = $3`,
    [JSON.stringify(novo), usuario.pessoaId, atual.id]
  );
}

module.exports = { lerAssociacao, salvarAssociacao, validar, ErroConfig, CHAVE, igual };
