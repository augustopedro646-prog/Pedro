// Mensagens pros clientes pelo WhatsApp (aniversário da criança, cashback parado e novidade no
// tamanho que a criança usa). Aqui só se GERA a sugestão de mensagem e se guarda numa fila de
// revisão (tabela mensagens_clientes); quem envia é o serviço bot-whatsapp (campanhas.js), pelo
// mesmo número do atendente, devagar e com limite por dia — WhatsApp não oficial bloqueia número
// que dispara muita mensagem de uma vez.
const { uid } = require('./db');

const RODAPE_SAIR = 'Se não quiser mais receber esses avisos, é só responder SAIR.';

const PADRAO = {
  automatico: false, // true = mensagem gerada já vai pra fila de envio, sem revisão no painel
  limiteDia: 30, // máximo de mensagens dessas por dia (as do atendente e dos pedidos não contam)
  horaInicio: 9, horaFim: 20, // só envia nesse horário (hora da loja)
  aniversario: {
    ativo: true,
    texto: 'Oi, {cliente}! Hoje {crianca} completa {idade} 🎉 Toda a equipe da {loja} deseja um dia muito feliz, cheio de brincadeira e bolo! 🎂💛',
  },
  cashback: {
    ativo: true, minimo: 10, diasSemComprar: 30, intervaloDias: 30,
    texto: 'Oi, {cliente}! Passando pra lembrar que você tem {valor} de cashback na {loja} 💛 Dá pra usar como desconto na próxima compra, na loja ou pelo site. {link}',
  },
  novidade: {
    ativo: true, diasNovidade: 7, mesesHistorico: 6, intervaloDias: 7,
    texto: 'Oi, {cliente}! Chegou novidade na {loja} no tamanho {tamanho} 😍 {produtos}. Quer que a gente separe ou mande fotos? É só responder aqui!',
  },
};
const TIPOS = ['aniversario', 'cashback', 'novidade'];

function inteiro(v, padrao, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : padrao;
}
function textoModelo(v, padrao) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 1000) : padrao;
}

// Config salva (parcial) + padrão → config completa e validada.
function mesclarConfig(salva) {
  const s = salva && typeof salva === 'object' ? salva : {};
  const a = s.aniversario || {}, c = s.cashback || {}, n = s.novidade || {};
  const cfg = {
    automatico: s.automatico === true,
    limiteDia: inteiro(s.limiteDia, PADRAO.limiteDia, 1, 200),
    horaInicio: inteiro(s.horaInicio, PADRAO.horaInicio, 0, 23),
    horaFim: inteiro(s.horaFim, PADRAO.horaFim, 1, 24),
    aniversario: { ativo: a.ativo !== false, texto: textoModelo(a.texto, PADRAO.aniversario.texto) },
    cashback: {
      ativo: c.ativo !== false,
      minimo: Number.isFinite(Number(c.minimo)) && Number(c.minimo) >= 0 && Number(c.minimo) <= 10000 ? Number(c.minimo) : PADRAO.cashback.minimo,
      diasSemComprar: inteiro(c.diasSemComprar, PADRAO.cashback.diasSemComprar, 1, 365),
      intervaloDias: inteiro(c.intervaloDias, PADRAO.cashback.intervaloDias, 1, 365),
      texto: textoModelo(c.texto, PADRAO.cashback.texto),
    },
    novidade: {
      ativo: n.ativo !== false,
      diasNovidade: inteiro(n.diasNovidade, PADRAO.novidade.diasNovidade, 1, 60),
      mesesHistorico: inteiro(n.mesesHistorico, PADRAO.novidade.mesesHistorico, 1, 24),
      intervaloDias: inteiro(n.intervaloDias, PADRAO.novidade.intervaloDias, 1, 90),
      texto: textoModelo(n.texto, PADRAO.novidade.texto),
    },
  };
  if (cfg.horaFim <= cfg.horaInicio) { cfg.horaInicio = PADRAO.horaInicio; cfg.horaFim = PADRAO.horaFim; }
  return cfg;
}

async function lerConfig(db, lojaId) {
  const { rows } = await db.query('SELECT nome, mensagens_config FROM lojas WHERE id = $1', [lojaId]);
  return { loja: rows.length ? rows[0].nome : 'loja', cfg: mesclarConfig(rows.length ? rows[0].mensagens_config : {}) };
}

function primeiroNome(nome) { return String(nome || '').trim().split(/\s+/)[0] || ''; }
function reais(v) { return 'R$ ' + Number(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
function listaHumana(itens) { return itens.length <= 1 ? itens.join('') : itens.slice(0, -1).join(', ') + ' e ' + itens[itens.length - 1]; }

// Troca {campo} pelos valores; campo sem valor some (sem deixar espaço duplo) e o rodapé do SAIR
// vai sempre no fim.
function montarTexto(modelo, valores) {
  const corpo = modelo.replace(/\{(\w+)\}/g, (m, k) => (valores[k] !== undefined && valores[k] !== null ? String(valores[k]) : ''))
    .replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1').trim();
  return corpo + '\n\n' + RODAPE_SAIR;
}

function hojeNaLoja(tz) { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); }
function anoBissexto(a) { return (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0; }

async function inserir(db, lojaId, cfg, m) {
  const { rowCount } = await db.query(
    `INSERT INTO mensagens_clientes (id, loja_id, cliente_id, tipo, chave, telefone, texto, detalhe, status, aprovada_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (loja_id, chave) DO NOTHING`,
    [uid(), lojaId, m.clienteId, m.tipo, m.chave, m.telefone, m.texto, JSON.stringify(m.detalhe || {}),
      cfg.automatico ? 'na_fila' : 'pendente', cfg.automatico ? new Date() : null]);
  return rowCount;
}

// Quantas desse tipo já foram sugeridas hoje (pra não encher a fila de uma vez — ex.: no primeiro
// dia, todo cliente com cashback se qualificaria).
async function sugeridasHoje(db, lojaId, tipo, tz) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM mensagens_clientes WHERE loja_id = $1 AND tipo = $2 AND (criado_em AT TIME ZONE $3)::date = $4::date`,
    [lojaId, tipo, tz, hojeNaLoja(tz)]);
  return rows[0].n;
}

async function gerarAniversarios(db, lojaId, cfg, base) {
  const hoje = base.hoje;
  const [ano, mes, dia] = hoje.split('-').map(Number);
  const diasMes = [hoje.slice(5)];
  if (mes === 2 && dia === 28 && !anoBissexto(ano)) diasMes.push('02-29'); // quem nasceu em 29/02 comemora dia 28
  const { rows } = await db.query(
    `SELECT f.id, f.nome, EXTRACT(YEAR FROM f.nascimento)::int AS ano, c.id AS cliente_id, c.nome AS cliente_nome, c.telefone
     FROM cliente_filhos f JOIN clientes c ON c.id = f.cliente_id
     WHERE f.loja_id = $1 AND f.nascimento IS NOT NULL AND to_char(f.nascimento, 'MM-DD') = ANY($2)
       AND c.telefone IS NOT NULL AND c.aceita_mensagens`, [lojaId, diasMes]);
  let n = 0;
  for (const f of rows) {
    const idade = ano - f.ano;
    if (idade < 1) continue;
    n += await inserir(db, lojaId, cfg, {
      clienteId: f.cliente_id, tipo: 'aniversario', chave: `aniv:${f.id}:${ano}`, telefone: f.telefone,
      texto: montarTexto(cfg.aniversario.texto, { ...base.valores, cliente: primeiroNome(f.cliente_nome), crianca: f.nome.trim(), idade: idade + (idade === 1 ? ' aninho' : ' aninhos') }),
      detalhe: { crianca: f.nome, idade, data: hoje },
    });
  }
  return n;
}

async function gerarCashback(db, lojaId, cfg, base) {
  const vagas = cfg.limiteDia - await sugeridasHoje(db, lojaId, 'cashback', base.tz);
  if (vagas <= 0) return 0;
  const k = cfg.cashback;
  const { rows } = await db.query(
    `SELECT c.id, c.nome, c.telefone, s.saldo::float AS saldo, u.ultima
     FROM clientes c
     CROSS JOIN LATERAL (SELECT COALESCE(SUM(valor), 0) AS saldo FROM cliente_creditos cc WHERE cc.cliente_id = c.id AND cc.tipo = 'cashback') s
     CROSS JOIN LATERAL (SELECT max(criado_em) AS ultima FROM vendas v WHERE v.cliente_id = c.id AND NOT v.cancelada) u
     WHERE c.loja_id = $1 AND c.telefone IS NOT NULL AND c.aceita_mensagens AND s.saldo >= GREATEST($2::numeric, 0.01)
       AND (u.ultima IS NULL OR u.ultima < now() - $3 * interval '1 day')
       AND NOT EXISTS (SELECT 1 FROM mensagens_clientes m WHERE m.cliente_id = c.id AND m.tipo = 'cashback' AND m.criado_em > now() - $4 * interval '1 day')
     ORDER BY s.saldo DESC LIMIT $5`,
    [lojaId, k.minimo, k.diasSemComprar, k.intervaloDias, vagas]);
  let n = 0;
  for (const c of rows) {
    n += await inserir(db, lojaId, cfg, {
      clienteId: c.id, tipo: 'cashback', chave: `cash:${c.id}:${base.hoje}`, telefone: c.telefone,
      texto: montarTexto(k.texto, { ...base.valores, cliente: primeiroNome(c.nome), valor: reais(c.saldo) }),
      detalhe: { valor: c.saldo, ultimaCompra: c.ultima },
    });
  }
  return n;
}

const norm = (t) => String(t || '').trim().toLowerCase();

async function gerarNovidades(db, lojaId, cfg, base) {
  const vagas = cfg.limiteDia - await sugeridasHoje(db, lojaId, 'novidade', base.tz);
  if (vagas <= 0) return 0;
  const k = cfg.novidade;
  // Novidade = produto novo, ou cor/tamanho novo de um produto, com estoque.
  const { rows: novas } = await db.query(
    `SELECT p.id, p.nome, v.tamanho FROM produtos p JOIN produto_variacoes v ON v.produto_id = p.id
     WHERE p.loja_id = $1 AND p.ativo AND v.ativo AND v.estoque > 0 AND GREATEST(p.criado_em, v.criado_em) > now() - $2 * interval '1 day'
     ORDER BY p.criado_em DESC`, [lojaId, k.diasNovidade]);
  if (!novas.length) return 0;
  const porTamanho = new Map(); // tamanho normalizado → [{ id, nome, tamanho }]
  for (const r of novas) {
    if (!porTamanho.has(norm(r.tamanho))) porTamanho.set(norm(r.tamanho), []);
    porTamanho.get(norm(r.tamanho)).push(r);
  }
  // Tamanho que a criança usa = o cadastrado no filho + o que a cliente comprou nos últimos meses.
  const { rows: clientes } = await db.query(
    `SELECT c.id, c.nome, c.telefone, array_agg(DISTINCT t.tamanho) AS tamanhos, max(t.quando) AS recente
     FROM clientes c JOIN (
       SELECT v.cliente_id, vi.tamanho, v.criado_em AS quando FROM vendas v JOIN vendas_itens vi ON vi.venda_id = v.id
       WHERE v.loja_id = $1 AND NOT v.cancelada AND v.cliente_id IS NOT NULL AND v.criado_em > now() - $2 * interval '1 month'
       UNION ALL
       SELECT f.cliente_id, f.tamanho, f.criado_em FROM cliente_filhos f WHERE f.loja_id = $1 AND COALESCE(f.tamanho, '') <> ''
     ) t ON t.cliente_id = c.id
     WHERE c.loja_id = $1 AND c.telefone IS NOT NULL AND c.aceita_mensagens
       AND NOT EXISTS (SELECT 1 FROM mensagens_clientes m WHERE m.cliente_id = c.id AND m.tipo = 'novidade' AND m.criado_em > now() - $3 * interval '1 day')
     GROUP BY c.id ORDER BY max(t.quando) DESC`, [lojaId, k.mesesHistorico, k.intervaloDias]);
  if (!clientes.length) return 0;
  const idsNovos = [...new Set(novas.map((r) => r.id))];
  const ids = clientes.map((c) => c.id);
  // Não anunciar o que a cliente já comprou nem o que já foi avisado antes.
  const { rows: jaTem } = await db.query(
    `SELECT DISTINCT v.cliente_id, pv.produto_id FROM vendas v JOIN vendas_itens vi ON vi.venda_id = v.id JOIN produto_variacoes pv ON pv.id = vi.variacao_id
     WHERE v.cliente_id = ANY($1) AND NOT v.cancelada AND pv.produto_id = ANY($2)
     UNION
     SELECT m.cliente_id, x.produto_id FROM mensagens_clientes m CROSS JOIN LATERAL jsonb_array_elements_text(m.detalhe->'produtoIds') AS x(produto_id)
     WHERE m.cliente_id = ANY($1) AND m.tipo = 'novidade' AND m.status <> 'descartada'`, [ids, idsNovos]);
  const excluir = new Set(jaTem.map((r) => r.cliente_id + '|' + r.produto_id));
  let n = 0;
  for (const c of clientes) {
    if (n >= vagas) break;
    const produtos = new Map(), tamanhos = new Map();
    for (const t of c.tamanhos) {
      for (const r of porTamanho.get(norm(t)) || []) {
        if (excluir.has(c.id + '|' + r.id)) continue;
        produtos.set(r.id, r.nome);
        tamanhos.set(norm(r.tamanho), r.tamanho);
      }
    }
    if (!produtos.size) continue;
    const nomes = [...new Set(produtos.values())];
    const mostrados = nomes.slice(0, 3);
    const resto = nomes.length - mostrados.length;
    const listaProdutos = resto > 0 ? mostrados.join(', ') + ' e mais ' + resto + (resto === 1 ? ' peça' : ' peças') : listaHumana(mostrados);
    n += await inserir(db, lojaId, cfg, {
      clienteId: c.id, tipo: 'novidade', chave: `nov:${c.id}:${base.hoje}`, telefone: c.telefone,
      texto: montarTexto(k.texto, { ...base.valores, cliente: primeiroNome(c.nome), tamanho: listaHumana([...tamanhos.values()]), produtos: listaProdutos }),
      detalhe: { produtoIds: [...produtos.keys()], produtos: nomes, tamanhos: [...tamanhos.values()] },
    });
  }
  return n;
}

// Passa a fila a limpo e sugere as mensagens do dia. Pode rodar quantas vezes quiser: a chave
// única e os intervalos impedem repetir.
async function gerar(db, lojaId, tz, siteUrl) {
  const { loja, cfg } = await lerConfig(db, lojaId);
  const hoje = hojeNaLoja(tz);
  // Parabéns atrasado não se manda: aniversário que passou sem sair vira "vencida". Sugestão
  // esquecida na revisão (ou parada na fila, com o WhatsApp desligado) por mais de 7 dias também.
  await db.query(
    `UPDATE mensagens_clientes SET status = 'vencida'
     WHERE loja_id = $1 AND ((status IN ('pendente', 'na_fila', 'erro') AND tipo = 'aniversario' AND (detalhe->>'data') < $2)
       OR (status IN ('pendente', 'erro') AND criado_em < now() - interval '7 days')
       OR (status = 'na_fila' AND aprovada_em < now() - interval '7 days'))`, [lojaId, hoje]);
  const base = { hoje, tz, valores: { loja, link: siteUrl ? siteUrl.replace(/\/+$/, '') + '/loja' : '' } };
  const criadas = {};
  for (const tipo of TIPOS) {
    if (!cfg[tipo].ativo) { criadas[tipo] = 0; continue; }
    criadas[tipo] = await (tipo === 'aniversario' ? gerarAniversarios : tipo === 'cashback' ? gerarCashback : gerarNovidades)(db, lojaId, cfg, base);
  }
  return { criadas, automatico: cfg.automatico };
}

async function resumo(db, lojaId, tz) {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'pendente')::int AS pendentes,
            count(*) FILTER (WHERE status IN ('na_fila', 'enviando'))::int AS na_fila,
            count(*) FILTER (WHERE status = 'enviada' AND (enviada_em AT TIME ZONE $2)::date = $3::date)::int AS enviadas_hoje,
            count(*) FILTER (WHERE status = 'erro')::int AS erros
     FROM mensagens_clientes WHERE loja_id = $1`, [lojaId, tz, hojeNaLoja(tz)]);
  return rows[0];
}

module.exports = { PADRAO, TIPOS, RODAPE_SAIR, mesclarConfig, lerConfig, montarTexto, gerar, resumo };
