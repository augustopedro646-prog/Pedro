require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { pool, uid } = require('./db');
const { verificarPin, gerarToken, hashPin, lerToken } = require('./auth');
const { gerarCodigoBarras } = require('./codigos');
const notas = require('./notas');
const backup = require('./backup');
const relatorios = require('./relatorios');
const fiscal = require('./fiscal');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

// Leitura de nota por PDF/foto usa a IA do Claude (mesma ideia do Jabá). Sem chave no .env,
// o XML continua funcionando normalmente — só PDF/foto ficam indisponíveis.
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ timeout: 5 * 60 * 1000 }) : null;

// Fuso da loja (Parnamirim/RN, UTC-3 sem horário de verão). "Hoje" e "mês" são sempre
// calculados nesse fuso no banco — com UTC, uma venda às 22h cairia no dia seguinte.
const TZ = process.env.TZ_LOJA || 'America/Fortaleza';

const app = express();
app.use(cors());
// Só a leitura de nota recebe arquivo grande (fotos/PDF em base64); o resto fica no limite pequeno.
const jsonPadrao = express.json({ limit: '1mb' });
app.use((req, res, next) => (req.path.endsWith('/compras/ler-nota') || /\/produtos\/[^/]+\/fotos$/.test(req.path) ? next() : jsonPadrao(req, res, next)));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/painel-gutto.html'));
app.get('/loja', (req, res) => res.redirect('/loja-gutto.html'));

// Limite geral generoso; login e PIN de ponto têm limite apertado à parte (força bruta).
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 600 }));
const pinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { erro: 'Muitas tentativas — aguarde alguns minutos.' } });

app.get('/api/health', (req, res) => res.json({ ok: true }));

/* ---------- Infraestrutura: erros, transação, validação ---------- */

class ErroApi extends Error {
  constructor(status, mensagem, extra) {
    super(mensagem);
    this.status = status;
    this.extra = extra;
  }
}
function falha(status, mensagem, extra) { throw new ErroApi(status, mensagem, extra); }

// Express 4 não captura erro de função async — sem isso, uma exceção vira promessa
// rejeitada solta e a requisição fica pendurada.
const rota = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function transacao(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Aritmética de dinheiro em float acumula erro (39.9*3 = 119.69999999999999).
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

function numero(valor, campo, { min = 0, minExclusivo = false, max = 1e9, inteiro = false } = {}) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n > max || (minExclusivo ? n <= min : n < min) || (inteiro && !Number.isInteger(n))) {
    falha(400, campo + ' inválido');
  }
  return n;
}
function texto(valor, campo, { obrigatorio = true, max = 200 } = {}) {
  if (valor == null || valor === '') {
    if (obrigatorio) falha(400, campo + ' é obrigatório');
    return null;
  }
  if (typeof valor !== 'string' || valor.length > max) falha(400, campo + ' inválido');
  const t = valor.trim();
  if (!t && obrigatorio) falha(400, campo + ' é obrigatório');
  return t || null;
}
function soDigitos(valor) {
  if (valor == null) return null;
  const d = String(valor).replace(/\D/g, '');
  return d || null;
}
function dataISO(valor, campo) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor) || isNaN(Date.parse(valor))) falha(400, campo + ' inválida');
  return valor;
}

app.param('lojaId', (req, res, next, valor) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ erro: 'lojaId inválido' });
  req.lojaId = n;
  next();
});

// Confere token, loja do token = loja da URL, e relê papel/ativo do banco a cada
// chamada (desativar alguém ou trocar o papel vale na hora, sem esperar o token vencer).
function auth(...papeis) {
  return rota(async (req, res, next) => {
    const token = lerToken(req);
    if (!token) falha(401, 'Faça login de novo');
    if (token.lojaId !== req.lojaId) falha(403, 'Sem acesso a essa loja');
    const { rows } = await pool.query('SELECT id, nome, papel, ativo FROM usuarios WHERE id = $1 AND loja_id = $2', [token.id, req.lojaId]);
    const u = rows[0];
    if (!u || !u.ativo) falha(401, 'Usuário desativado — faça login de novo');
    if (papeis.length && !papeis.includes(u.papel)) falha(403, 'Sem permissão pra essa ação');
    req.usuario = u;
    next();
  });
}
const qualquer = auth();
const admin = auth('administrador');

const PAPEIS = ['administrador', 'caixa'];
const FORMAS_PAGAMENTO = ['Dinheiro', 'Débito', 'Crédito', 'Pix', 'Cashback', 'Vale-troca'];
const FORMAS_CREDITO = { 'Cashback': 'cashback', 'Vale-troca': 'vale_troca' };

async function saldosCliente(db, clienteId) {
  const { rows } = await db.query(
    'SELECT tipo, COALESCE(SUM(valor), 0) AS saldo FROM cliente_creditos WHERE cliente_id = $1 GROUP BY tipo',
    [clienteId]
  );
  const s = { cashback: 0, vale_troca: 0 };
  rows.forEach((r) => { s[r.tipo] = Number(r.saldo); });
  return s;
}

/* ---------- Autenticação e usuários ---------- */

// Lista pública pra montar a tela de login (papel → pessoa) — nunca devolve pin_hash.
app.get('/api/lojas/:lojaId/usuarios', rota(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, nome, papel FROM usuarios WHERE loja_id = $1 AND ativo = true ORDER BY nome',
    [req.lojaId]
  );
  res.json(rows);
}));

app.post('/api/lojas/:lojaId/login', pinLimiter, rota(async (req, res) => {
  const { usuarioId, pin } = req.body || {};
  if (typeof usuarioId !== 'string' || typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    falha(400, 'usuarioId e pin (4 dígitos) são obrigatórios');
  }
  const { rows } = await pool.query('SELECT * FROM usuarios WHERE id = $1 AND loja_id = $2 AND ativo = true', [usuarioId, req.lojaId]);
  const usuario = rows[0];
  if (!usuario || !verificarPin(pin, usuario.pin_hash)) falha(401, 'PIN incorreto');
  res.json({ token: gerarToken(usuario), usuario: { id: usuario.id, nome: usuario.nome, papel: usuario.papel } });
}));

app.get('/api/lojas/:lojaId/equipe', admin, rota(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, nome, papel, ativo, criado_em, meta_mensal::float AS meta_mensal FROM usuarios WHERE loja_id = $1 ORDER BY ativo DESC, nome',
    [req.lojaId]
  );
  res.json(rows);
}));

app.post('/api/lojas/:lojaId/equipe', admin, rota(async (req, res) => {
  const nome = texto((req.body || {}).nome, 'nome', { max: 60 });
  const papel = (req.body || {}).papel;
  const pin = (req.body || {}).pin;
  if (!PAPEIS.includes(papel)) falha(400, 'papel inválido');
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) falha(400, 'PIN deve ter 4 dígitos');
  const meta = (req.body || {}).metaMensal;
  const id = uid();
  await pool.query(
    'INSERT INTO usuarios (id, loja_id, nome, papel, pin_hash, meta_mensal) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, req.lojaId, nome, papel, hashPin(pin), meta != null && meta !== '' ? numero(meta, 'meta do mês', { max: 1e7 }) : 0]
  );
  res.status(201).json({ id });
}));

app.put('/api/lojas/:lojaId/equipe/:id', admin, rota(async (req, res) => {
  const body = req.body || {};
  const nome = body.nome != null ? texto(body.nome, 'nome', { max: 60 }) : null;
  if (body.papel != null && !PAPEIS.includes(body.papel)) falha(400, 'papel inválido');
  if (body.pin != null && body.pin !== '' && !/^\d{4}$/.test(body.pin)) falha(400, 'PIN deve ter 4 dígitos');
  const ativo = typeof body.ativo === 'boolean' ? body.ativo : null;
  const meta = body.metaMensal != null && body.metaMensal !== '' ? numero(body.metaMensal, 'meta do mês', { max: 1e7 }) : null;

  await transacao(async (c) => {
    const { rows } = await c.query('SELECT id, papel, ativo FROM usuarios WHERE id = $1 AND loja_id = $2 FOR UPDATE', [req.params.id, req.lojaId]);
    if (!rows.length) falha(404, 'usuário não encontrado');
    const atual = rows[0];
    const novoPapel = body.papel || atual.papel;
    const novoAtivo = ativo == null ? atual.ativo : ativo;
    // Nunca deixa a loja sem nenhum Administrador ativo (ninguém mais conseguiria gerenciar).
    if (atual.papel === 'administrador' && atual.ativo && (novoPapel !== 'administrador' || !novoAtivo)) {
      const { rows: outros } = await c.query(
        "SELECT count(*)::int AS n FROM usuarios WHERE loja_id = $1 AND papel = 'administrador' AND ativo AND id <> $2",
        [req.lojaId, req.params.id]
      );
      if (!outros[0].n) falha(400, 'A loja precisa de pelo menos um Administrador ativo');
    }
    await c.query(
      `UPDATE usuarios SET nome = COALESCE($1, nome), papel = $2, ativo = $3,
         pin_hash = COALESCE($4, pin_hash), meta_mensal = COALESCE($6, meta_mensal)
       WHERE id = $5`,
      [nome, novoPapel, novoAtivo, body.pin ? hashPin(body.pin) : null, req.params.id, meta]
    );
  });
  res.json({ ok: true });
}));

/* ---------- Configuração da loja ---------- */

app.get('/api/lojas/:lojaId/config', qualquer, rota(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM lojas WHERE id = $1', [req.lojaId]);
  if (!rows.length) falha(404, 'loja não encontrada');
  const l = rows[0];
  res.json({ nome: l.nome, cashbackPct: Number(l.cashback_pct), descontoLivrePct: Number(l.desconto_livre_pct), comissaoPct: Number(l.comissao_pct), leituraIA: !!anthropic,
    cupomRodape: l.cupom_rodape || '',
    fiscal: { cfop: l.fiscal_cfop || '', csosn: l.fiscal_csosn || '', origem: l.fiscal_origem || '0', automatica: !!l.nfce_automatica,
      ambiente: fiscal.ambiente(), faltandoNoServidor: fiscal.faltandoNoServidor(),
      pronto: !fiscal.faltandoNoServidor().length && /^\d{4}$/.test(l.fiscal_cfop || '') && /^\d{3}$/.test(l.fiscal_csosn || '') },
    site: { ativo: l.site_ativo, aceitaEntrega: l.aceita_entrega, aceitaRetirada: l.aceita_retirada, taxaEntrega: Number(l.taxa_entrega),
      whatsapp: l.whatsapp || '', endereco: l.endereco || '', mensagem: l.mensagem_site || '' } });
}));

app.put('/api/lojas/:lojaId/config', admin, rota(async (req, res) => {
  const body = req.body || {};
  const cashback = body.cashbackPct != null ? numero(body.cashbackPct, 'cashbackPct', { max: 50 }) : null;
  const desconto = body.descontoLivrePct != null ? numero(body.descontoLivrePct, 'descontoLivrePct', { max: 100 }) : null;
  await pool.query(
    'UPDATE lojas SET cashback_pct = COALESCE($1, cashback_pct), desconto_livre_pct = COALESCE($2, desconto_livre_pct) WHERE id = $3',
    [cashback, desconto, req.lojaId]
  );
  if (body.comissaoPct != null) {
    await pool.query('UPDATE lojas SET comissao_pct = $1 WHERE id = $2', [numero(body.comissaoPct, 'comissão', { max: 50 }), req.lojaId]);
  }
  const fis = body.fiscal;
  if (fis && typeof fis === 'object') {
    const cfop = fis.cfop != null ? String(fis.cfop).replace(/\D/g, '') : null;
    const csosn = fis.csosn != null ? String(fis.csosn).replace(/\D/g, '') : null;
    if (cfop && !/^5\d{3}$/.test(cfop)) falha(400, 'CFOP de venda no estado tem 4 números e começa com 5 (ex.: 5102)');
    if (csosn && !['101', '102', '103', '201', '202', '203', '300', '400', '500', '900'].includes(csosn)) falha(400, 'CSOSN inválido (ex.: 102)');
    if (fis.origem != null && !/^[0-8]$/.test(String(fis.origem))) falha(400, 'Origem da mercadoria inválida (0 a 8)');
    await pool.query(
      `UPDATE lojas SET fiscal_cfop = COALESCE($1, fiscal_cfop), fiscal_csosn = COALESCE($2, fiscal_csosn),
         fiscal_origem = COALESCE($3, fiscal_origem), nfce_automatica = COALESCE($4, nfce_automatica) WHERE id = $5`,
      [cfop === '' ? null : cfop, csosn === '' ? null : csosn, fis.origem != null ? String(fis.origem) : null,
        typeof fis.automatica === 'boolean' ? fis.automatica : null, req.lojaId]);
  }
  if (body.cupomRodape != null) {
    await pool.query('UPDATE lojas SET cupom_rodape = $1 WHERE id = $2', [texto(body.cupomRodape, 'rodapé do cupom', { obrigatorio: false, max: 300 }) || '', req.lojaId]);
  }
  const site = body.site;
  if (site && typeof site === 'object') {
    const bool = (v) => (typeof v === 'boolean' ? v : null);
    const whatsapp = site.whatsapp != null ? (soDigitos(site.whatsapp) || '') : null;
    if (whatsapp && (whatsapp.length < 10 || whatsapp.length > 13)) falha(400, 'WhatsApp da loja: use DDD + número (ex.: 84999998888)');
    await pool.query(
      `UPDATE lojas SET site_ativo = COALESCE($1, site_ativo), aceita_entrega = COALESCE($2, aceita_entrega), aceita_retirada = COALESCE($3, aceita_retirada),
         taxa_entrega = COALESCE($4, taxa_entrega), whatsapp = COALESCE($5, whatsapp), endereco = COALESCE($6, endereco), mensagem_site = COALESCE($7, mensagem_site)
       WHERE id = $8`,
      [bool(site.ativo), bool(site.aceitaEntrega), bool(site.aceitaRetirada),
        site.taxaEntrega != null ? numero(site.taxaEntrega, 'taxa de entrega', { max: 1000 }) : null, whatsapp,
        site.endereco != null ? (texto(site.endereco, 'endereço', { obrigatorio: false, max: 200 }) || '') : null,
        site.mensagem != null ? (texto(site.mensagem, 'mensagem do site', { obrigatorio: false, max: 300 }) || '') : null, req.lojaId]
    );
  }
  res.json({ ok: true });
}));

/* ---------- Grades de tamanho ---------- */

app.get('/api/lojas/:lojaId/grades-tamanho', qualquer, rota(async (req, res) => {
  const { rows } = await pool.query('SELECT id, nome, tamanhos FROM grades_tamanho WHERE loja_id = $1 ORDER BY nome', [req.lojaId]);
  res.json(rows);
}));

function validarTamanhos(tamanhos) {
  if (!Array.isArray(tamanhos) || !tamanhos.length || tamanhos.length > 30 ||
      !tamanhos.every((t) => typeof t === 'string' && t.trim() && t.length <= 10)) {
    falha(400, 'tamanhos deve ser uma lista de textos curtos, não vazia');
  }
  const limpos = tamanhos.map((t) => t.trim());
  if (new Set(limpos).size !== limpos.length) falha(400, 'tamanho repetido na grade');
  return limpos;
}

app.post('/api/lojas/:lojaId/grades-tamanho', admin, rota(async (req, res) => {
  const nome = texto((req.body || {}).nome, 'nome da grade', { max: 60 });
  const tamanhos = validarTamanhos((req.body || {}).tamanhos);
  const id = uid();
  await pool.query('INSERT INTO grades_tamanho (id, loja_id, nome, tamanhos) VALUES ($1,$2,$3,$4)', [id, req.lojaId, nome, tamanhos]);
  res.status(201).json({ id, nome, tamanhos });
}));

// Reordenar/renomear/acrescentar tamanhos. Não deixa remover um tamanho que já tem
// variação cadastrada em algum produto dessa grade.
app.put('/api/lojas/:lojaId/grades-tamanho/:id', admin, rota(async (req, res) => {
  const nome = texto((req.body || {}).nome, 'nome da grade', { max: 60 });
  const tamanhos = validarTamanhos((req.body || {}).tamanhos);
  await transacao(async (c) => {
    const { rowCount } = await c.query('SELECT 1 FROM grades_tamanho WHERE id = $1 AND loja_id = $2 FOR UPDATE', [req.params.id, req.lojaId]);
    if (!rowCount) falha(404, 'grade não encontrada');
    const { rows: usados } = await c.query(
      `SELECT DISTINCT v.tamanho FROM produto_variacoes v JOIN produtos p ON p.id = v.produto_id
       WHERE p.grade_tamanho_id = $1`,
      [req.params.id]
    );
    const faltando = usados.map((r) => r.tamanho).filter((t) => !tamanhos.includes(t));
    if (faltando.length) falha(409, 'Tamanho(s) em uso por produtos não podem sair da grade: ' + faltando.join(', '));
    await c.query('UPDATE grades_tamanho SET nome = $1, tamanhos = $2 WHERE id = $3', [nome, tamanhos, req.params.id]);
  });
  res.json({ ok: true });
}));

/* ---------- Produtos e variações ---------- */

app.get('/api/lojas/:lojaId/produtos', qualquer, rota(async (req, res) => {
  const { rows: produtos } = await pool.query(
    `SELECT p.id, p.nome, p.categoria, p.descricao, p.ncm, p.foto_url, p.ativo, p.publicado,
            g.id AS grade_id, g.nome AS grade_nome, g.tamanhos AS grade_tamanhos
     FROM produtos p LEFT JOIN grades_tamanho g ON g.id = p.grade_tamanho_id
     WHERE p.loja_id = $1 ORDER BY p.nome`,
    [req.lojaId]
  );
  if (!produtos.length) return res.json([]);
  const { rows: variacoes } = await pool.query(
    `SELECT id, produto_id, tamanho, cor, sku, codigo_barras, preco_venda, custo_unitario,
            estoque, estoque_minimo, ativo
     FROM produto_variacoes WHERE loja_id = $1 ORDER BY tamanho, cor`,
    [req.lojaId]
  );
  const porProduto = {};
  variacoes.forEach((v) => { (porProduto[v.produto_id] = porProduto[v.produto_id] || []).push(v); });
  const fotosPorProduto = await fotosDosProdutos(req.lojaId);
  res.json(produtos.map((p) => ({
    ...p,
    grade: p.grade_id ? { id: p.grade_id, nome: p.grade_nome, tamanhos: p.grade_tamanhos } : null,
    variacoes: porProduto[p.id] || [],
    fotos: fotosPorProduto[p.id] || [],
  })));
}));

app.post('/api/lojas/:lojaId/produtos', admin, rota(async (req, res) => {
  const body = req.body || {};
  const nome = texto(body.nome, 'nome do produto');
  const id = uid();
  await pool.query(
    `INSERT INTO produtos (id, loja_id, nome, categoria, descricao, grade_tamanho_id, ncm) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, req.lojaId, nome, texto(body.categoria, 'categoria', { obrigatorio: false, max: 60 }),
      texto(body.descricao, 'descricao', { obrigatorio: false, max: 500 }), body.gradeTamanhoId || null,
      soDigitos(body.ncm)]
  );
  res.status(201).json({ id });
}));

app.put('/api/lojas/:lojaId/produtos/:id', admin, rota(async (req, res) => {
  const body = req.body || {};
  const { rowCount } = await pool.query(
    `UPDATE produtos SET nome = COALESCE($1, nome), categoria = COALESCE($2, categoria),
       descricao = COALESCE($3, descricao), ncm = COALESCE($4, ncm), ativo = COALESCE($5, ativo), publicado = COALESCE($8, publicado)
     WHERE id = $6 AND loja_id = $7`,
    [body.nome != null ? texto(body.nome, 'nome do produto') : null,
      texto(body.categoria, 'categoria', { obrigatorio: false, max: 60 }),
      body.descricao != null ? (texto(body.descricao, 'descricao', { obrigatorio: false, max: 1000 }) || '') : null,
      soDigitos(body.ncm), typeof body.ativo === 'boolean' ? body.ativo : null, req.params.id, req.lojaId,
      typeof body.publicado === 'boolean' ? body.publicado : null]
  );
  if (!rowCount) falha(404, 'produto não encontrado');
  res.json({ ok: true });
}));

app.post('/api/lojas/:lojaId/produtos/:id/variacoes', admin, rota(async (req, res) => {
  const body = req.body || {};
  const tamanho = texto(body.tamanho, 'tamanho', { max: 10 });
  const cor = texto(body.cor, 'cor', { obrigatorio: false, max: 40 }) || '';
  const preco = numero(body.precoVenda, 'precoVenda');
  const custo = body.custoUnitario != null && body.custoUnitario !== '' ? numero(body.custoUnitario, 'custoUnitario') : 0;
  const minimo = body.estoqueMinimo != null && body.estoqueMinimo !== '' ? numero(body.estoqueMinimo, 'estoqueMinimo') : 0;
  const inicial = body.estoqueInicial != null && body.estoqueInicial !== '' ? numero(body.estoqueInicial, 'estoqueInicial') : 0;
  const codigoInformado = soDigitos(body.codigoBarras);

  try {
    const variacaoId = await transacao(async (c) => {
      const produto = await c.query('SELECT id FROM produtos WHERE id = $1 AND loja_id = $2', [req.params.id, req.lojaId]);
      if (!produto.rowCount) falha(404, 'produto não encontrado');
      const id = uid();
      const codigo = codigoInformado || await gerarCodigoBarras(c);
      await c.query(
        `INSERT INTO produto_variacoes
           (id, loja_id, produto_id, tamanho, cor, sku, codigo_barras, preco_venda, custo_unitario, estoque, estoque_minimo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, req.lojaId, req.params.id, tamanho, cor, texto(body.sku, 'sku', { obrigatorio: false, max: 40 }), codigo, preco, custo, inicial, minimo]
      );
      if (inicial > 0) {
        await c.query(
          `INSERT INTO movimentos_estoque_produto
             (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, criado_por)
           VALUES ($1,$2,$3,'entrada',$4,$5,$6,'cadastro',$7)`,
          [uid(), req.lojaId, id, inicial, custo, round2(inicial * custo), req.usuario.id]
        );
      }
      return id;
    });
    res.status(201).json({ id: variacaoId });
  } catch (e) {
    if (e.code === '23505') falha(409, 'Já existe essa combinação de tamanho/cor, ou esse código de barras já está em uso');
    throw e;
  }
}));

app.put('/api/lojas/:lojaId/variacoes/:id', admin, rota(async (req, res) => {
  const body = req.body || {};
  try {
    const { rowCount } = await pool.query(
      `UPDATE produto_variacoes SET preco_venda = COALESCE($1, preco_venda), estoque_minimo = COALESCE($2, estoque_minimo),
         ativo = COALESCE($3, ativo), codigo_barras = COALESCE($4, codigo_barras), sku = COALESCE($5, sku)
       WHERE id = $6 AND loja_id = $7`,
      [body.precoVenda != null ? numero(body.precoVenda, 'precoVenda') : null,
        body.estoqueMinimo != null ? numero(body.estoqueMinimo, 'estoqueMinimo') : null,
        typeof body.ativo === 'boolean' ? body.ativo : null,
        soDigitos(body.codigoBarras), texto(body.sku, 'sku', { obrigatorio: false, max: 40 }),
        req.params.id, req.lojaId]
    );
    if (!rowCount) falha(404, 'variação não encontrada');
  } catch (e) {
    if (e.code === '23505') falha(409, 'Esse código de barras já está em uso em outra peça');
    throw e;
  }
  res.json({ ok: true });
}));

// Entrada avulsa (sem nota) — custo médio ponderado, mesma fórmula do Jabá.
async function darEntradaEstoque(c, { lojaId, variacaoId, quantidade, custo, referenciaTipo, referenciaId, observacao, usuarioId }) {
  const { rows } = await c.query('SELECT estoque, custo_unitario FROM produto_variacoes WHERE id = $1 AND loja_id = $2 FOR UPDATE', [variacaoId, lojaId]);
  if (!rows.length) falha(404, 'variação não encontrada: ' + variacaoId);
  const estoqueAtual = Number(rows[0].estoque);
  const custoAtual = Number(rows[0].custo_unitario);
  const novoEstoque = estoqueAtual + quantidade;
  // Estoque negativo/zerado não entra na média (não faz sentido ponderar custo de peça que não existe).
  const base = Math.max(estoqueAtual, 0);
  const custoMedio = round2(base + quantidade > 0 ? (base * custoAtual + quantidade * custo) / (base + quantidade) : custo);
  await c.query('UPDATE produto_variacoes SET estoque = $1, custo_unitario = $2 WHERE id = $3', [novoEstoque, custoMedio, variacaoId]);
  await c.query(
    `INSERT INTO movimentos_estoque_produto
       (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, referencia_id, observacao, criado_por)
     VALUES ($1,$2,$3,'entrada',$4,$5,$6,$7,$8,$9,$10)`,
    [uid(), lojaId, variacaoId, quantidade, custo, round2(quantidade * custo), referenciaTipo, referenciaId || null, observacao || null, usuarioId]
  );
  return { estoque: novoEstoque, custoMedio };
}

app.post('/api/lojas/:lojaId/variacoes/:id/entrada-estoque', admin, rota(async (req, res) => {
  const body = req.body || {};
  const quantidade = numero(body.quantidade, 'quantidade', { minExclusivo: true });
  const custo = numero(body.custoUnitario, 'custoUnitario');
  const r = await transacao((c) => darEntradaEstoque(c, {
    lojaId: req.lojaId, variacaoId: req.params.id, quantidade, custo, referenciaTipo: 'avulsa',
    observacao: texto(body.observacao, 'observacao', { obrigatorio: false, max: 300 }), usuarioId: req.usuario.id,
  }));
  res.json({ ok: true, ...r });
}));

// Acerto de inventário: informa quanto tem de verdade na prateleira; a diferença vira
// movimento "ajuste" (histórico preservado, nunca sobrescreve sem rastro).
app.post('/api/lojas/:lojaId/variacoes/:id/ajuste-estoque', admin, rota(async (req, res) => {
  const body = req.body || {};
  const novoEstoque = numero(body.novoEstoque, 'novoEstoque', { inteiro: true });
  const r = await transacao(async (c) => {
    const { rows } = await c.query('SELECT estoque, custo_unitario FROM produto_variacoes WHERE id = $1 AND loja_id = $2 FOR UPDATE', [req.params.id, req.lojaId]);
    if (!rows.length) falha(404, 'variação não encontrada');
    const diferenca = novoEstoque - Number(rows[0].estoque);
    if (diferenca === 0) return { estoque: novoEstoque, diferenca: 0 };
    await c.query('UPDATE produto_variacoes SET estoque = $1 WHERE id = $2', [novoEstoque, req.params.id]);
    const custo = Number(rows[0].custo_unitario);
    await c.query(
      `INSERT INTO movimentos_estoque_produto
         (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, observacao, criado_por)
       VALUES ($1,$2,$3,'ajuste',$4,$5,$6,'contagem',$7,$8)`,
      [uid(), req.lojaId, req.params.id, diferenca, custo, round2(diferenca * custo),
        texto(body.observacao, 'observacao', { obrigatorio: false, max: 300 }), req.usuario.id]
    );
    return { estoque: novoEstoque, diferenca };
  });
  res.json({ ok: true, ...r });
}));

/* ---------- Caixa (livro caixa do turno) ---------- */

async function resumoSessao(db, sessao) {
  const { rows: porForma } = await db.query(
    `SELECT vp.forma, SUM(vp.valor) AS total FROM venda_pagamentos vp JOIN vendas v ON v.id = vp.venda_id
     WHERE v.caixa_sessao_id = $1 AND NOT v.cancelada GROUP BY vp.forma ORDER BY vp.forma`,
    [sessao.id]
  );
  const { rows: vendas } = await db.query(
    'SELECT count(*)::int AS n, COALESCE(SUM(total), 0) AS total FROM vendas WHERE caixa_sessao_id = $1 AND NOT cancelada',
    [sessao.id]
  );
  const { rows: movimentos } = await db.query(
    `SELECT m.id, m.tipo, m.valor, m.descricao, m.criado_em, u.nome AS criado_por_nome
     FROM caixa_movimentos m JOIN usuarios u ON u.id = m.criado_por WHERE m.sessao_id = $1 ORDER BY m.criado_em`,
    [sessao.id]
  );
  const soma = (tipo) => movimentos.filter((m) => m.tipo === tipo).reduce((s, m) => s + Number(m.valor), 0);
  const dinheiroVendas = Number((porForma.find((f) => f.forma === 'Dinheiro') || {}).total || 0);
  const suprimentos = round2(soma('suprimento'));
  const sangrias = round2(soma('sangria'));
  return {
    vendas: vendas[0].n,
    totalVendas: Number(vendas[0].total),
    porForma: porForma.map((f) => ({ forma: f.forma, total: Number(f.total) })),
    movimentos,
    suprimentos,
    sangrias,
    dinheiroEsperado: round2(Number(sessao.dinheiro_inicial) + dinheiroVendas + suprimentos - sangrias),
  };
}

async function sessaoAberta(db, lojaId, trava) {
  const { rows } = await db.query(
    `SELECT s.*, u.nome AS aberto_por_nome FROM caixa_sessoes s JOIN usuarios u ON u.id = s.aberto_por
     WHERE s.loja_id = $1 AND NOT s.fechado ${trava ? 'FOR ' + trava + ' OF s' : ''}`,
    [lojaId]
  );
  return rows[0] || null;
}

app.get('/api/lojas/:lojaId/caixa/atual', qualquer, rota(async (req, res) => {
  const sessao = await sessaoAberta(pool, req.lojaId);
  if (!sessao) return res.json({ sessao: null });
  res.json({ sessao, resumo: await resumoSessao(pool, sessao) });
}));

app.post('/api/lojas/:lojaId/caixa/abrir', qualquer, rota(async (req, res) => {
  const inicial = numero((req.body || {}).dinheiroInicial || 0, 'dinheiroInicial');
  const id = uid();
  try {
    await pool.query(
      'INSERT INTO caixa_sessoes (id, loja_id, aberto_por, dinheiro_inicial) VALUES ($1,$2,$3,$4)',
      [id, req.lojaId, req.usuario.id, inicial]
    );
  } catch (e) {
    if (e.code === '23505') falha(409, 'Já existe um caixa aberto');
    throw e;
  }
  res.status(201).json({ id });
}));

app.post('/api/lojas/:lojaId/caixa/movimentos', qualquer, rota(async (req, res) => {
  const body = req.body || {};
  if (!['suprimento', 'sangria'].includes(body.tipo)) falha(400, 'tipo deve ser suprimento ou sangria');
  const valor = numero(body.valor, 'valor', { minExclusivo: true });
  const sessao = await sessaoAberta(pool, req.lojaId);
  if (!sessao) falha(409, 'Caixa fechado — abra o caixa primeiro');
  await pool.query(
    'INSERT INTO caixa_movimentos (id, sessao_id, loja_id, tipo, valor, descricao, criado_por) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [uid(), sessao.id, req.lojaId, body.tipo, valor, texto(body.descricao, 'descricao', { obrigatorio: false, max: 200 }), req.usuario.id]
  );
  res.status(201).json({ ok: true });
}));

app.post('/api/lojas/:lojaId/caixa/fechar', qualquer, rota(async (req, res) => {
  const body = req.body || {};
  const contado = numero(body.dinheiroContado, 'dinheiroContado');
  const resultado = await transacao(async (c) => {
    // FOR UPDATE: espera qualquer venda em andamento (que segura FOR SHARE) terminar.
    const sessao = await sessaoAberta(c, req.lojaId, 'UPDATE');
    if (!sessao) falha(409, 'Não há caixa aberto');
    const resumo = await resumoSessao(c, sessao);
    const diferenca = round2(contado - resumo.dinheiroEsperado);
    await c.query(
      `UPDATE caixa_sessoes SET fechado = true, fechado_por = $1, fechado_em = now(), dinheiro_esperado = $2,
         dinheiro_contado = $3, diferenca = $4, observacao = $5 WHERE id = $6`,
      [req.usuario.id, resumo.dinheiroEsperado, contado, diferenca, texto(body.observacao, 'observacao', { obrigatorio: false, max: 300 }), sessao.id]
    );
    return { sessaoId: sessao.id, resumo, dinheiroContado: contado, diferenca };
  });
  res.json(resultado);
}));

app.get('/api/lojas/:lojaId/caixa/sessoes', admin, rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.id, s.aberto_em, s.fechado_em, s.dinheiro_inicial, s.dinheiro_esperado, s.dinheiro_contado, s.diferenca,
            s.observacao, ua.nome AS aberto_por_nome, uf.nome AS fechado_por_nome,
            (SELECT COALESCE(SUM(total),0) FROM vendas v WHERE v.caixa_sessao_id = s.id AND NOT v.cancelada) AS total_vendas
     FROM caixa_sessoes s JOIN usuarios ua ON ua.id = s.aberto_por LEFT JOIN usuarios uf ON uf.id = s.fechado_por
     WHERE s.loja_id = $1 AND s.fechado ORDER BY s.fechado_em DESC LIMIT 30`,
    [req.lojaId]
  );
  res.json(rows);
}));

/* ---------- Clientes ---------- */

const SQL_SALDOS = `
  COALESCE((SELECT SUM(valor) FROM cliente_creditos cc WHERE cc.cliente_id = c.id AND cc.tipo = 'cashback'), 0) AS saldo_cashback,
  COALESCE((SELECT SUM(valor) FROM cliente_creditos cc WHERE cc.cliente_id = c.id AND cc.tipo = 'vale_troca'), 0) AS saldo_vale_troca`;

app.get('/api/lojas/:lojaId/clientes', qualquer, rota(async (req, res) => {
  const busca = typeof req.query.busca === 'string' ? req.query.busca.trim().slice(0, 60) : '';
  const digitos = soDigitos(busca);
  const { rows } = await pool.query(
    `SELECT c.id, c.nome, c.telefone, c.cpf, c.nascimento, ${SQL_SALDOS}
     FROM clientes c
     WHERE c.loja_id = $1 AND ($2 = '' OR c.nome ILIKE '%' || $2 || '%'
       OR ($3::text IS NOT NULL AND (c.telefone LIKE '%' || $3 || '%' OR c.cpf LIKE '%' || $3 || '%')))
     ORDER BY c.nome LIMIT 50`,
    [req.lojaId, busca, digitos]
  );
  res.json(rows.map((r) => ({ ...r, saldo_cashback: Number(r.saldo_cashback), saldo_vale_troca: Number(r.saldo_vale_troca) })));
}));

function dadosCliente(body) {
  const nascimento = body.nascimento ? dataISO(body.nascimento, 'nascimento') : null;
  const telefone = soDigitos(body.telefone);
  const cpf = soDigitos(body.cpf);
  if (telefone && (telefone.length < 10 || telefone.length > 13)) falha(400, 'telefone inválido (use DDD + número)');
  if (cpf && cpf.length !== 11) falha(400, 'CPF deve ter 11 dígitos');
  return { telefone, cpf, nascimento, observacao: texto(body.observacao, 'observacao', { obrigatorio: false, max: 300 }) };
}

app.post('/api/lojas/:lojaId/clientes', qualquer, rota(async (req, res) => {
  const body = req.body || {};
  const nome = texto(body.nome, 'nome', { max: 100 });
  const d = dadosCliente(body);
  const id = uid();
  try {
    await pool.query(
      'INSERT INTO clientes (id, loja_id, nome, telefone, cpf, nascimento, observacao) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, req.lojaId, nome, d.telefone, d.cpf, d.nascimento, d.observacao]
    );
  } catch (e) {
    if (e.code === '23505') falha(409, 'Já existe cliente com esse telefone ou CPF');
    throw e;
  }
  res.status(201).json({ id, nome, telefone: d.telefone, cpf: d.cpf, saldo_cashback: 0, saldo_vale_troca: 0 });
}));

app.put('/api/lojas/:lojaId/clientes/:id', qualquer, rota(async (req, res) => {
  const body = req.body || {};
  const nome = texto(body.nome, 'nome', { max: 100 });
  const d = dadosCliente(body);
  try {
    const { rowCount } = await pool.query(
      'UPDATE clientes SET nome = $1, telefone = $2, cpf = $3, nascimento = $4, observacao = $5 WHERE id = $6 AND loja_id = $7',
      [nome, d.telefone, d.cpf, d.nascimento, d.observacao, req.params.id, req.lojaId]
    );
    if (!rowCount) falha(404, 'cliente não encontrado');
  } catch (e) {
    if (e.code === '23505') falha(409, 'Já existe cliente com esse telefone ou CPF');
    throw e;
  }
  res.json({ ok: true });
}));

app.get('/api/lojas/:lojaId/clientes/:id', qualquer, rota(async (req, res) => {
  const { rows } = await pool.query(`SELECT c.*, ${SQL_SALDOS} FROM clientes c WHERE c.id = $1 AND c.loja_id = $2`, [req.params.id, req.lojaId]);
  if (!rows.length) falha(404, 'cliente não encontrado');
  const { rows: extrato } = await pool.query(
    `SELECT cc.id, cc.tipo, cc.valor, cc.origem, cc.referencia_id, cc.observacao, cc.criado_em
     FROM cliente_creditos cc WHERE cc.cliente_id = $1 ORDER BY cc.criado_em DESC LIMIT 50`,
    [req.params.id]
  );
  const { rows: compras } = await pool.query(
    `SELECT id, total, forma_pagamento, cashback_gerado, criado_em FROM vendas
     WHERE cliente_id = $1 AND NOT cancelada ORDER BY criado_em DESC LIMIT 20`,
    [req.params.id]
  );
  const c = rows[0];
  res.json({ ...c, saldo_cashback: Number(c.saldo_cashback), saldo_vale_troca: Number(c.saldo_vale_troca), extrato, compras });
}));

/* ---------- Vendas ---------- */

// Corpo: { itens: [{variacaoId, qtd, descontoItem}], pagamentos: [{forma, valor}],
//          clienteId?, aprovacao?: {usuarioId, pin} }
app.post('/api/lojas/:lojaId/vendas', qualquer, rota(async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.itens) || !body.itens.length || body.itens.length > 100) falha(400, 'itens deve ter de 1 a 100 linhas');

  // Junta linhas repetidas da mesma peça e ordena por id (trava sempre na mesma ordem → sem deadlock).
  const porVariacao = new Map();
  for (const it of body.itens) {
    if (!it || typeof it.variacaoId !== 'string') falha(400, 'cada item precisa de variacaoId');
    const qtd = numero(it.qtd, 'qtd', { minExclusivo: true, inteiro: true, max: 1000 });
    const desc = it.descontoItem != null && it.descontoItem !== '' ? numero(it.descontoItem, 'descontoItem') : 0;
    const atual = porVariacao.get(it.variacaoId) || { variacaoId: it.variacaoId, qtd: 0, descontoItem: 0 };
    atual.qtd += qtd; atual.descontoItem = round2(atual.descontoItem + desc);
    porVariacao.set(it.variacaoId, atual);
  }
  const itens = [...porVariacao.values()].sort((a, b) => (a.variacaoId < b.variacaoId ? -1 : 1));

  let pagamentos = body.pagamentos;
  if (!Array.isArray(pagamentos) && typeof body.formaPagamento === 'string') pagamentos = [{ forma: body.formaPagamento, valor: null }];
  if (!Array.isArray(pagamentos) || pagamentos.length > 10) falha(400, 'pagamentos inválidos');
  const pagPorForma = new Map();
  for (const p of pagamentos) {
    if (!p || !FORMAS_PAGAMENTO.includes(p.forma)) falha(400, 'forma de pagamento inválida');
    const valor = p.valor == null ? null : numero(p.valor, 'valor do pagamento', { minExclusivo: true });
    pagPorForma.set(p.forma, valor == null ? null : round2((pagPorForma.get(p.forma) || 0) + valor));
  }

  const venda = await transacao(async (c) => {
    // FOR SHARE: várias vendas podem rodar juntas, mas o fechamento (FOR UPDATE) espera elas.
    const sessao = await sessaoAberta(c, req.lojaId, 'SHARE');
    if (!sessao) falha(409, 'Caixa fechado — abra o caixa antes de vender', { codigo: 'caixa_fechado' });
    const { rows: lojaRows } = await c.query('SELECT cashback_pct, desconto_livre_pct FROM lojas WHERE id = $1', [req.lojaId]);
    const cashbackPct = Number(lojaRows[0].cashback_pct);
    const descontoLivrePct = Number(lojaRows[0].desconto_livre_pct);

    let bruto = 0, descontoTotal = 0;
    const gravar = [];
    for (const it of itens) {
      const { rows } = await c.query(
        `SELECT v.id, v.tamanho, v.cor, v.estoque, v.preco_venda, v.custo_unitario, v.ativo, p.nome AS produto_nome
         FROM produto_variacoes v JOIN produtos p ON p.id = v.produto_id
         WHERE v.id = $1 AND v.loja_id = $2 FOR UPDATE OF v`,
        [it.variacaoId, req.lojaId]
      );
      const v = rows[0];
      if (!v || !v.ativo) falha(404, 'Peça não encontrada ou inativa');
      if (Number(v.estoque) < it.qtd) {
        falha(409, 'Estoque insuficiente: ' + v.produto_nome + ' ' + v.tamanho + (v.cor ? ' ' + v.cor : ''),
          { codigo: 'estoque_insuficiente', variacaoId: v.id, disponivel: Number(v.estoque) });
      }
      const precoUnit = Number(v.preco_venda);
      const linha = round2(precoUnit * it.qtd);
      if (it.descontoItem > linha) falha(400, 'Desconto maior que o valor do item ' + v.produto_nome);
      bruto = round2(bruto + linha);
      descontoTotal = round2(descontoTotal + it.descontoItem);
      gravar.push({ ...it, precoUnit, custo: Number(v.custo_unitario), produtoNome: v.produto_nome, tamanho: v.tamanho, cor: v.cor });
    }
    const total = round2(bruto - descontoTotal);

    // Desconto acima do limite livre: Caixa precisa do PIN de um Administrador.
    let aprovadoPor = null;
    const pctDesconto = bruto > 0 ? (descontoTotal / bruto) * 100 : 0;
    if (pctDesconto > descontoLivrePct + 1e-9 && req.usuario.papel !== 'administrador') {
      const ap = body.aprovacao || {};
      if (typeof ap.usuarioId !== 'string' || typeof ap.pin !== 'string') {
        falha(403, 'Desconto de ' + pctDesconto.toFixed(1).replace('.', ',') + '% passa do limite de ' + descontoLivrePct +
          '% — precisa do PIN de um Administrador', { codigo: 'aprovacao_necessaria' });
      }
      const { rows } = await c.query("SELECT id, pin_hash FROM usuarios WHERE id = $1 AND loja_id = $2 AND ativo AND papel = 'administrador'", [ap.usuarioId, req.lojaId]);
      if (!rows.length || !verificarPin(ap.pin, rows[0].pin_hash)) falha(403, 'PIN de Administrador incorreto', { codigo: 'aprovacao_invalida' });
      aprovadoPor = rows[0].id;
    }

    // Pagamentos: um único pagamento sem valor = paga o total inteiro com ele.
    if (pagPorForma.size === 1 && [...pagPorForma.values()][0] == null) pagPorForma.set([...pagPorForma.keys()][0], total);
    if ([...pagPorForma.values()].some((v) => v == null)) falha(400, 'informe o valor de cada pagamento');
    const somaPag = round2([...pagPorForma.values()].reduce((s, v) => s + v, 0));
    if (total > 0 && Math.abs(somaPag - total) > 0.005) {
      falha(400, 'Pagamentos (R$ ' + somaPag.toFixed(2) + ') não fecham com o total (R$ ' + total.toFixed(2) + ')');
    }
    if (total === 0 && somaPag > 0) falha(400, 'Venda com total zero não recebe pagamento');

    let clienteId = null;
    if (body.clienteId) {
      const { rows } = await c.query('SELECT id FROM clientes WHERE id = $1 AND loja_id = $2 FOR UPDATE', [body.clienteId, req.lojaId]);
      if (!rows.length) falha(404, 'cliente não encontrado');
      clienteId = rows[0].id;
    }
    let usadoCredito = 0;
    for (const [forma, valor] of pagPorForma) {
      const tipo = FORMAS_CREDITO[forma];
      if (!tipo) continue;
      if (!clienteId) falha(400, forma + ' só pode ser usado com cliente identificado');
      const saldos = await saldosCliente(c, clienteId);
      if (saldos[tipo] + 0.005 < valor) falha(409, 'Saldo de ' + forma + ' insuficiente (disponível R$ ' + saldos[tipo].toFixed(2) + ')');
      usadoCredito = round2(usadoCredito + valor);
    }

    const vendaId = uid();
    const formasLabel = [...pagPorForma.keys()].join(' + ') || 'Sem pagamento';
    // Troco só existe com pagamento em dinheiro (o valor devolvido ao cliente, pro cupom).
    const troco = pagPorForma.has('Dinheiro') && body.troco != null && body.troco !== '' ? numero(body.troco, 'troco', { max: 100000 }) : 0;
    await c.query(
      `INSERT INTO vendas (id, loja_id, usuario_id, canal, subtotal, desconto, total, forma_pagamento, caixa_sessao_id, cliente_id, aprovado_por, troco)
       VALUES ($1,$2,$3,'loja',$4,$5,$6,$7,$8,$9,$10,$11)`,
      [vendaId, req.lojaId, req.usuario.id, bruto, descontoTotal, total, formasLabel, sessao.id, clienteId, aprovadoPor, troco]
    );
    for (const it of gravar) {
      await c.query('UPDATE produto_variacoes SET estoque = estoque - $1 WHERE id = $2', [it.qtd, it.variacaoId]);
      await c.query(
        `INSERT INTO vendas_itens (id, venda_id, variacao_id, produto_nome, tamanho, cor, qtd, preco_unit, desconto_item)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [uid(), vendaId, it.variacaoId, it.produtoNome, it.tamanho, it.cor, it.qtd, it.precoUnit, it.descontoItem]
      );
      await c.query(
        `INSERT INTO movimentos_estoque_produto
           (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, referencia_id, criado_por)
         VALUES ($1,$2,$3,'venda',$4,$5,$6,'venda',$7,$8)`,
        [uid(), req.lojaId, it.variacaoId, -it.qtd, it.custo, round2(it.custo * it.qtd), vendaId, req.usuario.id]
      );
    }
    for (const [forma, valor] of pagPorForma) {
      await c.query('INSERT INTO venda_pagamentos (id, venda_id, forma, valor) VALUES ($1,$2,$3,$4)', [uid(), vendaId, forma, valor]);
      if (FORMAS_CREDITO[forma]) {
        await c.query(
          `INSERT INTO cliente_creditos (id, loja_id, cliente_id, tipo, valor, origem, referencia_id, criado_por)
           VALUES ($1,$2,$3,$4,$5,'uso_em_venda',$6,$7)`,
          [uid(), req.lojaId, clienteId, FORMAS_CREDITO[forma], -valor, vendaId, req.usuario.id]
        );
      }
    }

    // Cashback: só sobre o que foi pago com dinheiro "de verdade" (não gera cashback de
    // cashback/vale-troca), creditado uma única vez — índice único garante no banco.
    let cashbackGerado = 0;
    if (clienteId && cashbackPct > 0) {
      cashbackGerado = round2(Math.max(0, total - usadoCredito) * cashbackPct / 100);
      if (cashbackGerado > 0) {
        await c.query(
          `INSERT INTO cliente_creditos (id, loja_id, cliente_id, tipo, valor, origem, referencia_id, criado_por)
           VALUES ($1,$2,$3,'cashback',$4,'venda',$5,$6)`,
          [uid(), req.lojaId, clienteId, cashbackGerado, vendaId, req.usuario.id]
        );
        await c.query('UPDATE vendas SET cashback_gerado = $1 WHERE id = $2', [cashbackGerado, vendaId]);
      }
    }

    return {
      id: vendaId, subtotal: bruto, desconto: descontoTotal, total, troco, criadoEm: new Date().toISOString(),
      pagamentos: [...pagPorForma].map(([forma, valor]) => ({ forma, valor })),
      cashbackGerado, clienteId,
      saldosCliente: clienteId ? await saldosCliente(c, clienteId) : null,
      itens: gravar.map((it) => ({ variacaoId: it.variacaoId, produtoNome: it.produtoNome, tamanho: it.tamanho, cor: it.cor, qtd: it.qtd, precoUnit: it.precoUnit, descontoItem: it.descontoItem })),
    };
  });
  res.status(201).json(venda);
}));

// Lista de vendas. ?periodo=hoje filtra pelo dia na hora local da loja.
app.get('/api/lojas/:lojaId/vendas', qualquer, rota(async (req, res) => {
  const hoje = req.query.periodo === 'hoje';
  const { rows } = await pool.query(
    `SELECT v.id, v.usuario_id, u.nome AS usuario_nome, v.canal, v.subtotal, v.desconto, v.total, v.forma_pagamento,
            v.cancelada, v.motivo_cancelamento, v.cashback_gerado, v.criado_em, v.cliente_id, c.nome AS cliente_nome, v.pedido_online_id,
            (SELECT COALESCE(SUM(qtd),0) FROM vendas_itens vi WHERE vi.venda_id = v.id) AS qtd_itens,
            (SELECT count(*) FROM devolucoes d WHERE d.venda_id = v.id)::int AS devolucoes,
            nf.status AS nfce_status, nf.url_danfe AS nfce_danfe, nf.numero AS nfce_numero
     FROM vendas v JOIN usuarios u ON u.id = v.usuario_id LEFT JOIN clientes c ON c.id = v.cliente_id
     LEFT JOIN notas_fiscais nf ON nf.venda_id = v.id
     WHERE v.loja_id = $1 ${hoje ? "AND (v.criado_em AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date" : ''}
     ORDER BY v.criado_em DESC LIMIT 200`,
    hoje ? [req.lojaId, TZ] : [req.lojaId]
  );
  res.json(rows);
}));

app.get('/api/lojas/:lojaId/vendas/:id', qualquer, rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.*, u.nome AS usuario_nome, c.nome AS cliente_nome FROM vendas v
     JOIN usuarios u ON u.id = v.usuario_id LEFT JOIN clientes c ON c.id = v.cliente_id
     WHERE v.id = $1 AND v.loja_id = $2`,
    [req.params.id, req.lojaId]
  );
  if (!rows.length) falha(404, 'venda não encontrada');
  const { rows: itens } = await pool.query(
    `SELECT vi.*, COALESCE((SELECT SUM(di.qtd) FROM devolucoes_itens di WHERE di.venda_item_id = vi.id), 0) AS qtd_devolvida
     FROM vendas_itens vi WHERE vi.venda_id = $1 ORDER BY vi.criado_em`,
    [req.params.id]
  );
  const { rows: pagamentos } = await pool.query('SELECT forma, valor FROM venda_pagamentos WHERE venda_id = $1', [req.params.id]);
  const { rows: devolucoes } = await pool.query('SELECT id, valor_total, criado_em FROM devolucoes WHERE venda_id = $1 ORDER BY criado_em', [req.params.id]);
  const { rows: nota } = await pool.query(SQL_NOTA + ' WHERE venda_id = $1', [req.params.id]);
  res.json({ ...rows[0], itens, pagamentos, devolucoes, nfce: nota[0] || null });
}));

/* ---------- Cancelar venda (só Administrador) ---------- */

// Desfaz a venda inteira: peças de volta ao estoque, cashback gerado estornado, cashback/vale-troca
// usados devolvidos ao cliente. Venda de um caixa já fechado: o dinheiro devolvido sai do caixa de
// hoje como "saída" (o caixa antigo já foi conferido e não é reaberto). Cartão/Pix: o estorno é
// feito na maquininha/banco — a resposta lista o que devolver. Venda que já teve troca/devolução
// não cancela (o cliente ficaria com o vale-troca e o dinheiro).
app.post('/api/lojas/:lojaId/vendas/:id/cancelar', admin, rota(async (req, res) => {
  const motivo = texto((req.body || {}).motivo, 'Motivo do cancelamento', { max: 200 });
  const r = await transacao(async (c) => {
    const { rows } = await c.query('SELECT * FROM vendas WHERE id = $1 AND loja_id = $2 FOR UPDATE', [req.params.id, req.lojaId]);
    const venda = rows[0];
    if (!venda) falha(404, 'venda não encontrada');
    if (venda.cancelada) falha(409, 'Essa venda já foi cancelada');
    const { rowCount: devs } = await c.query('SELECT 1 FROM devolucoes WHERE venda_id = $1', [venda.id]);
    if (devs) falha(409, 'Essa venda já teve troca/devolução — não dá pra cancelar (o cliente já recebeu vale-troca). Faça a troca/devolução do restante.');

    const aberta = await sessaoAberta(c, req.lojaId, 'SHARE');
    const doCaixaAberto = aberta && aberta.id === venda.caixa_sessao_id;
    const { rows: pagamentos } = await c.query('SELECT forma, SUM(valor) AS valor FROM venda_pagamentos WHERE venda_id = $1 GROUP BY forma', [venda.id]);
    const porForma = Object.fromEntries(pagamentos.map((p) => [p.forma, round2(Number(p.valor))]));
    const dinheiro = porForma['Dinheiro'] || 0;
    if (!doCaixaAberto && dinheiro > 0) {
      if (!aberta) falha(409, 'Essa venda é de um caixa já fechado: abra o caixa de hoje pra registrar a devolução do dinheiro', { codigo: 'caixa_fechado' });
      await c.query(
        'INSERT INTO caixa_movimentos (id, sessao_id, loja_id, tipo, valor, descricao, criado_por) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [uid(), aberta.id, req.lojaId, 'sangria', dinheiro, 'Dinheiro devolvido — venda cancelada: ' + motivo, req.usuario.id]);
    }

    const { rows: itens } = await c.query('SELECT variacao_id, SUM(qtd) AS qtd FROM vendas_itens WHERE venda_id = $1 GROUP BY variacao_id ORDER BY variacao_id', [venda.id]);
    for (const it of itens) {
      const { rows: v } = await c.query('SELECT custo_unitario FROM produto_variacoes WHERE id = $1 FOR UPDATE', [it.variacao_id]);
      if (!v.length) continue; // peça apagada do cadastro: não tem estoque pra onde voltar
      const qtd = Number(it.qtd), custo = Number(v[0].custo_unitario);
      await c.query('UPDATE produto_variacoes SET estoque = estoque + $1 WHERE id = $2', [qtd, it.variacao_id]);
      await c.query(
        `INSERT INTO movimentos_estoque_produto (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, referencia_id, observacao, criado_por)
         VALUES ($1,$2,$3,'devolucao',$4,$5,$6,'cancelamento_venda',$7,$8,$9)`,
        [uid(), req.lojaId, it.variacao_id, qtd, custo, round2(qtd * custo), venda.id, 'Venda cancelada: ' + motivo, req.usuario.id]);
    }

    // Créditos do cliente: um ajuste líquido por tipo (devolve o que usou, tira o cashback que ganhou).
    let saldosCli = null;
    if (venda.cliente_id) {
      const ajustes = {
        cashback: round2((porForma['Cashback'] || 0) - Number(venda.cashback_gerado || 0)),
        vale_troca: porForma['Vale-troca'] || 0,
      };
      for (const [tipo, valor] of Object.entries(ajustes)) {
        if (!valor) continue;
        await c.query(
          `INSERT INTO cliente_creditos (id, loja_id, cliente_id, tipo, valor, origem, referencia_id, observacao, criado_por)
           VALUES ($1,$2,$3,$4,$5,'ajuste',$6,$7,$8)`,
          [uid(), req.lojaId, venda.cliente_id, tipo, valor, venda.id, 'Venda cancelada', req.usuario.id]);
      }
      saldosCli = await saldosCliente(c, venda.cliente_id);
    }
    if (venda.pedido_online_id) {
      await c.query("UPDATE pedidos_online SET status = 'cancelado', motivo_cancelamento = $1, atualizado_em = now() WHERE id = $2", ['Venda cancelada: ' + motivo, venda.pedido_online_id]);
    }
    await c.query('UPDATE vendas SET cancelada = true, cancelada_por = $1, cancelada_em = now(), motivo_cancelamento = $2 WHERE id = $3', [req.usuario.id, motivo, venda.id]);
    return {
      ok: true, total: Number(venda.total), doCaixaAberto, dinheiroDevolvido: dinheiro,
      estornarFora: Object.entries(porForma).filter(([f]) => ['Pix', 'Débito', 'Crédito'].includes(f)).map(([forma, valor]) => ({ forma, valor })),
      saldosCliente: saldosCli,
    };
  });
  // NFC-e autorizada: cancela na SEFAZ também (fora da transação — a venda já está cancelada aqui;
  // se a SEFAZ recusar, p.ex. passou do prazo, o painel avisa pra resolver com a contadora).
  try {
    const nota = await fiscal.cancelar(req.lojaId, req.params.id, motivo);
    if (nota) r.nfce = { cancelada: nota.status === 'cancelada', numero: nota.numero, erro: nota.erroCancelamento || null };
  } catch (e) {
    r.nfce = { cancelada: false, erro: 'Sem resposta da Focus NFe (' + e.message + ')' };
  }
  res.json(r);
}));

/* ---------- NFC-e (Focus NFe) ---------- */

const SQL_NOTA = `SELECT id, venda_id, status, ambiente, cpf, status_sefaz, mensagem_sefaz, chave_acesso, numero, serie,
  url_danfe, url_consulta, tentativas, criado_em, atualizado_em FROM notas_fiscais`;
function notaPublica(n) {
  if (!n) return null;
  const { resposta_bruta, status_antes, loja_id, ref, ...resto } = n;
  return resto;
}

// Emite (ou reemite, se foi rejeitada) a NFC-e da venda. Corpo: { cpf? }.
app.post('/api/lojas/:lojaId/vendas/:id/nfce', qualquer, rota(async (req, res) => {
  const cpf = soDigitos((req.body || {}).cpf);
  const nota = await fiscal.emitir(req.lojaId, req.params.id, cpf);
  res.json(notaPublica(nota));
}));

// Produtos sem NCM, por categoria (pra preencher de uma vez).
app.get('/api/lojas/:lojaId/fiscal/ncm', admin, rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(categoria, ''), 'Sem categoria') AS categoria, count(*)::int AS produtos,
            count(*) FILTER (WHERE ncm IS NULL OR ncm !~ '^[0-9]{8}$')::int AS sem_ncm,
            (array_agg(ncm ORDER BY ncm) FILTER (WHERE ncm ~ '^[0-9]{8}$'))[1] AS exemplo_ncm
     FROM produtos WHERE loja_id = $1 AND ativo GROUP BY 1 ORDER BY sem_ncm DESC, 1`, [req.lojaId]);
  res.json(rows);
}));

// Aplica um NCM aos produtos de uma categoria (só nos que estão sem, a não ser que `todos`).
app.put('/api/lojas/:lojaId/fiscal/ncm', admin, rota(async (req, res) => {
  const body = req.body || {};
  const ncm = soDigitos(body.ncm);
  if (!ncm || ncm.length !== 8) falha(400, 'NCM tem 8 números');
  const categoria = texto(body.categoria, 'categoria', { max: 60 });
  const { rowCount } = await pool.query(
    `UPDATE produtos SET ncm = $1 WHERE loja_id = $2 AND ativo AND COALESCE(NULLIF(categoria, ''), 'Sem categoria') = $3
       AND ($4 OR ncm IS NULL OR ncm !~ '^[0-9]{8}$')`,
    [ncm, req.lojaId, categoria, body.todos === true]);
  res.json({ atualizados: rowCount });
}));

/* ---------- Troca / devolução → vale-troca ---------- */

// Corpo: { itens: [{vendaItemId, qtd}], clienteId? (obrigatório se a venda não teve cliente), observacao? }
app.post('/api/lojas/:lojaId/vendas/:id/devolucoes', qualquer, rota(async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.itens) || !body.itens.length) falha(400, 'escolha ao menos uma peça pra devolver');
  const pedidos = new Map();
  for (const it of body.itens) {
    if (!it || typeof it.vendaItemId !== 'string') falha(400, 'vendaItemId inválido');
    const qtd = numero(it.qtd, 'qtd', { minExclusivo: true, inteiro: true, max: 1000 });
    pedidos.set(it.vendaItemId, (pedidos.get(it.vendaItemId) || 0) + qtd);
  }

  const resultado = await transacao(async (c) => {
    const { rows: vendas } = await c.query('SELECT * FROM vendas WHERE id = $1 AND loja_id = $2 FOR UPDATE', [req.params.id, req.lojaId]);
    const venda = vendas[0];
    if (!venda) falha(404, 'venda não encontrada');
    if (venda.cancelada) falha(400, 'venda cancelada não aceita devolução');

    const clienteId = venda.cliente_id || body.clienteId;
    if (!clienteId) falha(400, 'Identifique o cliente — o vale-troca fica no nome dele', { codigo: 'cliente_obrigatorio' });
    const { rowCount } = await c.query('SELECT 1 FROM clientes WHERE id = $1 AND loja_id = $2 FOR UPDATE', [clienteId, req.lojaId]);
    if (!rowCount) falha(404, 'cliente não encontrado');

    const devolucaoId = uid();
    let valorTotal = 0;
    const linhas = [];
    for (const [vendaItemId, qtd] of pedidos) {
      const { rows } = await c.query(
        `SELECT vi.*, COALESCE((SELECT SUM(di.qtd) FROM devolucoes_itens di WHERE di.venda_item_id = vi.id), 0) AS ja_devolvida
         FROM vendas_itens vi WHERE vi.id = $1 AND vi.venda_id = $2`,
        [vendaItemId, venda.id]
      );
      const item = rows[0];
      if (!item) falha(404, 'item não pertence a essa venda');
      const disponivel = Number(item.qtd) - Number(item.ja_devolvida);
      if (qtd > disponivel) falha(409, 'Só dá pra devolver ' + disponivel + ' de ' + item.produto_nome + ' ' + item.tamanho);
      // Devolve o que o cliente pagou pela peça (com o desconto do item já descontado).
      const unitario = (Number(item.preco_unit) * Number(item.qtd) - Number(item.desconto_item)) / Number(item.qtd);
      const valor = round2(unitario * qtd);
      valorTotal = round2(valorTotal + valor);
      linhas.push({ item, qtd, valor });
    }
    await c.query(
      `INSERT INTO devolucoes (id, loja_id, venda_id, cliente_id, valor_total, observacao, criado_por) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [devolucaoId, req.lojaId, venda.id, clienteId, valorTotal, texto(body.observacao, 'observacao', { obrigatorio: false, max: 300 }), req.usuario.id]
    );
    for (const l of linhas.sort((a, b) => (a.item.variacao_id < b.item.variacao_id ? -1 : 1))) {
      await c.query(
        'INSERT INTO devolucoes_itens (id, devolucao_id, venda_item_id, variacao_id, qtd, valor) VALUES ($1,$2,$3,$4,$5,$6)',
        [uid(), devolucaoId, l.item.id, l.item.variacao_id, l.qtd, l.valor]
      );
      const { rows } = await c.query('SELECT custo_unitario FROM produto_variacoes WHERE id = $1 FOR UPDATE', [l.item.variacao_id]);
      await c.query('UPDATE produto_variacoes SET estoque = estoque + $1 WHERE id = $2', [l.qtd, l.item.variacao_id]);
      const custo = rows.length ? Number(rows[0].custo_unitario) : 0;
      await c.query(
        `INSERT INTO movimentos_estoque_produto
           (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, referencia_id, criado_por)
         VALUES ($1,$2,$3,'devolucao',$4,$5,$6,'devolucao',$7,$8)`,
        [uid(), req.lojaId, l.item.variacao_id, l.qtd, custo, round2(custo * l.qtd), devolucaoId, req.usuario.id]
      );
    }
    await c.query(
      `INSERT INTO cliente_creditos (id, loja_id, cliente_id, tipo, valor, origem, referencia_id, criado_por)
       VALUES ($1,$2,$3,'vale_troca',$4,'devolucao',$5,$6)`,
      [uid(), req.lojaId, clienteId, valorTotal, devolucaoId, req.usuario.id]
    );
    // Estorna o cashback proporcional à parte devolvida (o cliente não fica com cashback
    // de peça que voltou). Pode deixar o saldo negativo se ele já tinha gastado —
    // aí as próximas compras compensam.
    let cashbackEstornado = 0;
    if (Number(venda.cashback_gerado) > 0 && venda.cliente_id && Number(venda.total) > 0) {
      cashbackEstornado = round2(Number(venda.cashback_gerado) * Math.min(1, valorTotal / Number(venda.total)));
      if (cashbackEstornado > 0) {
        await c.query(
          `INSERT INTO cliente_creditos (id, loja_id, cliente_id, tipo, valor, origem, referencia_id, observacao, criado_por)
           VALUES ($1,$2,$3,'cashback',$4,'devolucao',$5,'Estorno de cashback por devolução',$6)`,
          [uid(), req.lojaId, venda.cliente_id, -cashbackEstornado, devolucaoId, req.usuario.id]
        );
      }
    }
    return { id: devolucaoId, valeTroca: valorTotal, cashbackEstornado, clienteId, saldosCliente: await saldosCliente(c, clienteId) };
  });
  res.status(201).json(resultado);
}));

/* ---------- Relatórios (Fase 4) ---------- */

// ?inicio=AAAA-MM-DD&fim=AAAA-MM-DD (dias inteiros na hora da loja). Sem nada: últimos 30 dias.
app.get('/api/lojas/:lojaId/relatorios', admin, rota(async (req, res) => {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const fim = req.query.fim ? dataISO(req.query.fim, 'data final') : hoje;
  const inicio = req.query.inicio ? dataISO(req.query.inicio, 'data inicial') : relatorios.somaDias(fim, -29);
  if (inicio > fim) falha(400, 'A data inicial é depois da final');
  if (relatorios.diasEntre(inicio, fim) > 366) falha(400, 'Escolha um período de até 1 ano');
  res.json(await relatorios.montarRelatorio(pool, req.lojaId, inicio, fim, TZ));
}));

/* ---------- Fluxo de caixa (mês) e despesas ---------- */

app.get('/api/lojas/:lojaId/fluxo', admin, rota(async (req, res) => {
  const mes = typeof req.query.mes === 'string' && /^\d{4}-\d{2}$/.test(req.query.mes) ? req.query.mes : null;
  if (!mes) falha(400, 'mes deve ser AAAA-MM');
  const inicio = mes + '-01';
  const { rows: porForma } = await pool.query(
    `SELECT vp.forma, SUM(vp.valor) AS total FROM venda_pagamentos vp JOIN vendas v ON v.id = vp.venda_id
     WHERE v.loja_id = $1 AND NOT v.cancelada
       AND (v.criado_em AT TIME ZONE $3)::date >= $2::date AND (v.criado_em AT TIME ZONE $3)::date < ($2::date + interval '1 month')
     GROUP BY vp.forma ORDER BY total DESC`,
    [req.lojaId, inicio, TZ]
  );
  const { rows: despesas } = await pool.query(
    `SELECT d.id, d.data, d.descricao, d.categoria, d.forma_pagamento, d.valor, u.nome AS criado_por_nome,
            (SELECT id FROM compras cp WHERE cp.despesa_id = d.id LIMIT 1) AS compra_id
     FROM despesas d LEFT JOIN usuarios u ON u.id = d.criado_por
     WHERE d.loja_id = $1 AND d.data >= $2::date AND d.data < ($2::date + interval '1 month')
     ORDER BY d.data DESC, d.criado_em DESC`,
    [req.lojaId, inicio]
  );
  // Receita = dinheiro que entrou. Cashback/vale-troca usados não são entrada (o dinheiro
  // daquilo já tinha entrado na venda original) — aparecem à parte pra conferência.
  const receita = round2(porForma.filter((f) => !FORMAS_CREDITO[f.forma]).reduce((s, f) => s + Number(f.total), 0));
  const creditosUsados = round2(porForma.filter((f) => FORMAS_CREDITO[f.forma]).reduce((s, f) => s + Number(f.total), 0));
  const totalDespesas = round2(despesas.reduce((s, d) => s + Number(d.valor), 0));
  res.json({
    mes, receita, creditosUsados, totalDespesas, saldo: round2(receita - totalDespesas),
    porForma: porForma.map((f) => ({ forma: f.forma, total: Number(f.total) })),
    despesas: despesas.map((d) => ({ ...d, valor: Number(d.valor) })),
  });
}));

app.post('/api/lojas/:lojaId/despesas', admin, rota(async (req, res) => {
  const body = req.body || {};
  const id = uid();
  await pool.query(
    'INSERT INTO despesas (id, loja_id, data, descricao, categoria, forma_pagamento, valor, criado_por) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, req.lojaId, dataISO(body.data, 'data'), texto(body.descricao, 'descricao'),
      texto(body.categoria, 'categoria', { obrigatorio: false, max: 60 }),
      texto(body.formaPagamento, 'formaPagamento', { obrigatorio: false, max: 30 }),
      numero(body.valor, 'valor', { minExclusivo: true }), req.usuario.id]
  );
  res.status(201).json({ id });
}));

app.delete('/api/lojas/:lojaId/despesas/:id', admin, rota(async (req, res) => {
  await transacao(async (c) => {
    await c.query('UPDATE compras SET despesa_id = NULL WHERE despesa_id = $1 AND loja_id = $2', [req.params.id, req.lojaId]);
    const { rowCount } = await c.query('DELETE FROM despesas WHERE id = $1 AND loja_id = $2', [req.params.id, req.lojaId]);
    if (!rowCount) falha(404, 'despesa não encontrada');
  });
  res.json({ ok: true });
}));

/* ---------- Fornecedores e entrada de nota (compras) ---------- */

app.get('/api/lojas/:lojaId/fornecedores', admin, rota(async (req, res) => {
  const { rows } = await pool.query('SELECT id, nome, cnpj, telefone FROM fornecedores WHERE loja_id = $1 ORDER BY nome', [req.lojaId]);
  res.json(rows);
}));

// Corpo: { fornecedorId? | fornecedorNome?, numeroNota?, data, itens: [{variacaoId, qtd, custoUnitario}],
//          lancarDespesa?: bool, formaPagamento?, observacao? }
app.post('/api/lojas/:lojaId/compras', admin, rota(async (req, res) => {
  const body = req.body || {};
  const data = dataISO(body.data, 'data');
  if (!Array.isArray(body.itens) || !body.itens.length || body.itens.length > 500) falha(400, 'a nota precisa de pelo menos um item');
  const itens = body.itens.map((it) => {
    if (!it || typeof it.variacaoId !== 'string') falha(400, 'item sem variacaoId');
    return {
      variacaoId: it.variacaoId,
      qtd: numero(it.qtd, 'qtd', { minExclusivo: true, inteiro: true, max: 100000 }),
      custo: numero(it.custoUnitario, 'custoUnitario'),
      // Vindos da leitura da nota: referência do fornecedor (aprendida pra próxima nota) e o
      // código de barras da etiqueta, quando o Administrador escolheu passar a usá-lo na peça.
      codigoFornecedor: texto(it.codigoFornecedor, 'codigoFornecedor', { obrigatorio: false, max: 60 }),
      codigoBarras: soDigitos(it.codigoBarras),
    };
  }).sort((a, b) => (a.variacaoId < b.variacaoId ? -1 : 1));
  const numeroNota = texto(body.numeroNota, 'numeroNota', { obrigatorio: false, max: 30 });
  const chaveNfe = soDigitos(body.chaveNfe);
  if (chaveNfe && chaveNfe.length !== 44) falha(400, 'chave da NF-e deve ter 44 dígitos');
  const fornecedorCnpj = soDigitos(body.fornecedorCnpj);
  const origem = ['manual', 'xml', 'pdf', 'foto'].includes(body.origem) ? body.origem : 'manual';

  const compra = await transacao(async (c) => {
    let fornecedorId = null, fornecedorNome = null;
    if (body.fornecedorId) {
      const { rows } = await c.query('SELECT id, nome FROM fornecedores WHERE id = $1 AND loja_id = $2', [body.fornecedorId, req.lojaId]);
      if (!rows.length) falha(404, 'fornecedor não encontrado');
      fornecedorId = rows[0].id; fornecedorNome = rows[0].nome;
    } else if (body.fornecedorNome || fornecedorCnpj) {
      const existente = fornecedorCnpj ? (await c.query('SELECT id, nome FROM fornecedores WHERE loja_id = $1 AND cnpj = $2', [req.lojaId, fornecedorCnpj])).rows[0] : null;
      if (existente) { fornecedorId = existente.id; fornecedorNome = existente.nome; }
      else {
        fornecedorNome = texto(body.fornecedorNome, 'fornecedorNome', { max: 100 });
        const { rows } = await c.query(
          `INSERT INTO fornecedores (id, loja_id, nome, cnpj) VALUES ($1,$2,$3,$4)
           ON CONFLICT (loja_id, lower(nome)) DO UPDATE SET cnpj = COALESCE(fornecedores.cnpj, EXCLUDED.cnpj) RETURNING id, nome`,
          [uid(), req.lojaId, fornecedorNome, fornecedorCnpj]
        );
        fornecedorId = rows[0].id; fornecedorNome = rows[0].nome;
      }
    }

    const compraId = uid();
    const total = round2(itens.reduce((s, it) => s + it.qtd * it.custo, 0));
    try {
      await c.query(
        `INSERT INTO compras (id, loja_id, fornecedor_id, numero_nota, data, total, observacao, criado_por, chave_nfe, origem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [compraId, req.lojaId, fornecedorId, numeroNota, data, total, texto(body.observacao, 'observacao', { obrigatorio: false, max: 300 }), req.usuario.id, chaveNfe, origem]
      );
    } catch (e) {
      if (e.code === '23505') falha(409, 'Essa nota já foi lançada antes (mesma chave de NF-e)', { codigo: 'nota_repetida' });
      throw e;
    }
    for (const it of itens) {
      await c.query('INSERT INTO compras_itens (id, compra_id, variacao_id, qtd, custo_unitario) VALUES ($1,$2,$3,$4,$5)', [uid(), compraId, it.variacaoId, it.qtd, it.custo]);
      await darEntradaEstoque(c, {
        lojaId: req.lojaId, variacaoId: it.variacaoId, quantidade: it.qtd, custo: it.custo,
        referenciaTipo: 'compra', referenciaId: compraId, usuarioId: req.usuario.id,
      });
      if (it.codigoBarras) {
        try {
          await c.query('SAVEPOINT codigo');
          await c.query('UPDATE produto_variacoes SET codigo_barras = $1 WHERE id = $2 AND loja_id = $3', [it.codigoBarras, it.variacaoId, req.lojaId]);
          await c.query('RELEASE SAVEPOINT codigo');
        } catch (e) {
          if (e.code !== '23505') throw e;
          falha(409, 'O código de barras ' + it.codigoBarras + ' já está em outra peça — desmarque "usar código da nota" nesse item');
        }
      }
      if (it.codigoFornecedor && fornecedorId) {
        await c.query(
          `INSERT INTO fornecedor_codigos (loja_id, fornecedor_id, codigo, variacao_id) VALUES ($1,$2,$3,$4)
           ON CONFLICT (loja_id, fornecedor_id, codigo) DO UPDATE SET variacao_id = EXCLUDED.variacao_id, atualizado_em = now()`,
          [req.lojaId, fornecedorId, it.codigoFornecedor, it.variacaoId]
        );
      }
    }
    let despesaId = null;
    if (body.lancarDespesa && total > 0) {
      despesaId = uid();
      await c.query(
        `INSERT INTO despesas (id, loja_id, data, descricao, categoria, forma_pagamento, valor, criado_por)
         VALUES ($1,$2,$3,$4,'Mercadoria',$5,$6,$7)`,
        [despesaId, req.lojaId, data, 'Compra' + (fornecedorNome ? ' — ' + fornecedorNome : '') + (numeroNota ? ' (nota ' + numeroNota + ')' : ''),
          texto(body.formaPagamento, 'formaPagamento', { obrigatorio: false, max: 30 }), total, req.usuario.id]
      );
      await c.query('UPDATE compras SET despesa_id = $1 WHERE id = $2', [despesaId, compraId]);
    }
    return { id: compraId, total, despesaId, fornecedorId };
  });
  res.status(201).json(compra);
}));

// Lê a nota (XML exato; PDF/foto pela IA) e devolve um rascunho com cada item já casado com
// uma peça do estoque quando possível. Não grava nada — quem confirma é o POST /compras.
const MIDIAS_NOTA = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
app.post('/api/lojas/:lojaId/compras/ler-nota', admin, express.json({ limit: '25mb' }), rota(async (req, res) => {
  const body = req.body || {};
  let rascunho;
  if (typeof body.xml === 'string' && body.xml.trim()) {
    if (body.xml.length > 5 * 1024 * 1024) falha(413, 'XML grande demais');
    try { rascunho = notas.lerXmlNfe(body.xml); } catch (e) { falha(400, e.message); }
  } else {
    const arquivos = Array.isArray(body.arquivos) ? body.arquivos : [];
    if (!arquivos.length) falha(400, 'Envie o XML, o PDF ou a(s) foto(s) da nota');
    if (arquivos.length > 8) falha(400, 'No máximo 8 fotos por nota');
    for (const a of arquivos) {
      if (!a || !MIDIAS_NOTA.includes(a.mediaType) || typeof a.base64 !== 'string' || !a.base64) falha(400, 'Formato não suportado — use XML, PDF, JPG ou PNG');
    }
    if (!anthropic) falha(503, 'Leitura de PDF/foto não está ligada (falta a chave ANTHROPIC_API_KEY no .env do servidor). O XML da nota funciona sem ela.');
    try {
      rascunho = await notas.lerNotaComIA(anthropic, arquivos);
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        console.error('Leitura de nota — erro da API do Claude:', e.status, e.message);
        falha(502, e.status === 429 ? 'Leitura de nota ocupada agora — tente de novo em um minuto.' : 'Não consegui falar com a IA agora — tente de novo em instantes.');
      }
      falha(422, e.message);
    }
  }
  if (!rascunho.itens.length) falha(422, 'Não achei nenhum item nessa nota.');
  await notas.sugerirCasamentos(pool, anthropic, req.lojaId, rascunho);
  const repetida = await notas.acharCompraRepetida(pool, req.lojaId, rascunho);
  const fornecedor = await notas.acharFornecedor(pool, req.lojaId, rascunho.fornecedor);
  res.json({ ...rascunho, fornecedorId: fornecedor ? fornecedor.id : null, fornecedorCadastrado: fornecedor ? fornecedor.nome : null, repetida });
}));

app.get('/api/lojas/:lojaId/compras', admin, rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cp.id, cp.numero_nota, cp.data, cp.total, cp.despesa_id, cp.criado_em, f.nome AS fornecedor_nome,
            (SELECT COALESCE(SUM(qtd),0) FROM compras_itens ci WHERE ci.compra_id = cp.id) AS qtd_pecas
     FROM compras cp LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id
     WHERE cp.loja_id = $1 ORDER BY cp.data DESC, cp.criado_em DESC LIMIT 50`,
    [req.lojaId]
  );
  res.json(rows);
}));

app.get('/api/lojas/:lojaId/compras/:id', admin, rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cp.*, f.nome AS fornecedor_nome FROM compras cp LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id
     WHERE cp.id = $1 AND cp.loja_id = $2`,
    [req.params.id, req.lojaId]
  );
  if (!rows.length) falha(404, 'compra não encontrada');
  const { rows: itens } = await pool.query(
    `SELECT ci.variacao_id, ci.qtd, ci.custo_unitario, v.tamanho, v.cor, p.nome AS produto_nome
     FROM compras_itens ci JOIN produto_variacoes v ON v.id = ci.variacao_id JOIN produtos p ON p.id = v.produto_id
     WHERE ci.compra_id = $1 ORDER BY p.nome, v.tamanho, v.cor`,
    [req.params.id]
  );
  res.json({ ...rows[0], itens });
}));

/* ---------- Bater ponto ---------- */

// Sem período: pontos de hoje (tela Bater ponto). Com inicio/fim (Calendário): o Administrador vê
// todo mundo; o Caixa vê só os próprios.
app.get('/api/lojas/:lojaId/pontos', qualquer, rota(async (req, res) => {
  const comPeriodo = req.query.inicio || req.query.fim;
  const inicio = comPeriodo ? dataISO(req.query.inicio, 'inicio') : null;
  const fim = comPeriodo ? dataISO(req.query.fim, 'fim') : null;
  const soDoUsuario = comPeriodo && req.usuario.papel !== 'administrador' ? req.usuario.id : null;
  const { rows } = await pool.query(
    `SELECT p.id, p.usuario_id, u.nome, p.tipo, p.metodo, p.registrado_em,
            to_char(p.registrado_em AT TIME ZONE $2, 'YYYY-MM-DD') AS dia
     FROM pontos p JOIN usuarios u ON u.id = p.usuario_id
     WHERE p.loja_id = $1
       AND ${comPeriodo ? '(p.registrado_em AT TIME ZONE $2)::date BETWEEN $3 AND $4' : '(p.registrado_em AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date'}
       ${soDoUsuario ? 'AND p.usuario_id = $5' : ''}
     ORDER BY p.registrado_em`,
    comPeriodo ? (soDoUsuario ? [req.lojaId, TZ, inicio, fim, soDoUsuario] : [req.lojaId, TZ, inicio, fim]) : [req.lojaId, TZ]
  );
  res.json(rows);
}));

/* ---------- Calendário: eventos, escala e aniversariantes ---------- */

function horaHHMM(valor, campo) {
  if (valor == null || valor === '') return null;
  if (typeof valor !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(valor)) falha(400, campo + ' inválida (use HH:MM)');
  return valor;
}

app.get('/api/lojas/:lojaId/agenda', qualquer, rota(async (req, res) => {
  const inicio = dataISO(req.query.inicio, 'inicio');
  const fim = dataISO(req.query.fim, 'fim');
  const { rows } = await pool.query(
    `SELECT a.id, a.tipo, to_char(a.data, 'YYYY-MM-DD') AS data, a.hora_inicio, a.hora_fim, a.titulo, a.usuario_id,
            u.nome AS usuario_nome, a.observacao
     FROM agenda_eventos a LEFT JOIN usuarios u ON u.id = a.usuario_id
     WHERE a.loja_id = $1 AND a.data BETWEEN $2 AND $3
     ORDER BY a.data, a.tipo, a.hora_inicio NULLS LAST, a.criado_em`,
    [req.lojaId, inicio, fim]
  );
  res.json(rows);
}));

function lerAgenda(body, parcial) {
  const d = {};
  if (!parcial || body.data !== undefined) d.data = dataISO(body.data, 'data');
  if (!parcial || body.horaInicio !== undefined) d.horaInicio = horaHHMM(body.horaInicio, 'hora de início');
  if (!parcial || body.horaFim !== undefined) d.horaFim = horaHHMM(body.horaFim, 'hora de fim');
  if (!parcial || body.observacao !== undefined) d.observacao = texto(body.observacao, 'observacao', { obrigatorio: false, max: 300 });
  if (d.horaInicio && d.horaFim && d.horaFim <= d.horaInicio) falha(400, 'A hora de fim precisa ser depois da de início');
  return d;
}

app.post('/api/lojas/:lojaId/agenda', admin, rota(async (req, res) => {
  const body = req.body || {};
  if (!['evento', 'escala'].includes(body.tipo)) falha(400, 'tipo deve ser evento ou escala');
  const d = lerAgenda(body);
  let titulo, usuarioId = null;
  if (body.tipo === 'escala') {
    const { rows } = await pool.query('SELECT id, nome FROM usuarios WHERE id = $1 AND loja_id = $2', [body.usuarioId, req.lojaId]);
    if (!rows.length) falha(400, 'Escolha quem vai ser escalado');
    usuarioId = rows[0].id; titulo = rows[0].nome;
    const { rowCount } = await pool.query('SELECT 1 FROM agenda_eventos WHERE loja_id = $1 AND tipo = $2 AND usuario_id = $3 AND data = $4', [req.lojaId, 'escala', usuarioId, d.data]);
    if (rowCount) falha(409, rows[0].nome + ' já está escalado(a) nesse dia — edite o horário em vez de escalar de novo');
  } else {
    titulo = texto(body.titulo, 'título do evento', { max: 120 });
  }
  const id = uid();
  await pool.query(
    `INSERT INTO agenda_eventos (id, loja_id, tipo, data, hora_inicio, hora_fim, titulo, usuario_id, observacao, criado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, req.lojaId, body.tipo, d.data, d.horaInicio, d.horaFim, titulo, usuarioId, d.observacao, req.usuario.id]
  );
  res.status(201).json({ id });
}));

app.put('/api/lojas/:lojaId/agenda/:id', admin, rota(async (req, res) => {
  const body = req.body || {};
  const { rows } = await pool.query('SELECT tipo, hora_inicio, hora_fim FROM agenda_eventos WHERE id = $1 AND loja_id = $2', [req.params.id, req.lojaId]);
  if (!rows.length) falha(404, 'item do calendário não encontrado');
  const d = lerAgenda(body, true);
  const inicio = d.horaInicio !== undefined ? d.horaInicio : rows[0].hora_inicio;
  const fim = d.horaFim !== undefined ? d.horaFim : rows[0].hora_fim;
  if (inicio && fim && fim <= inicio) falha(400, 'A hora de fim precisa ser depois da de início');
  const titulo = rows[0].tipo === 'evento' && body.titulo !== undefined ? texto(body.titulo, 'título do evento', { max: 120 }) : null;
  await pool.query(
    `UPDATE agenda_eventos SET data = COALESCE($1, data), hora_inicio = $2, hora_fim = $3,
       observacao = CASE WHEN $4 THEN $5 ELSE observacao END, titulo = COALESCE($6, titulo)
     WHERE id = $7 AND loja_id = $8`,
    [d.data || null, inicio, fim, d.observacao !== undefined, d.observacao === undefined ? null : d.observacao, titulo, req.params.id, req.lojaId]
  );
  res.json({ ok: true });
}));

app.delete('/api/lojas/:lojaId/agenda/:id', admin, rota(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM agenda_eventos WHERE id = $1 AND loja_id = $2', [req.params.id, req.lojaId]);
  if (!rowCount) falha(404, 'item do calendário não encontrado');
  res.json({ ok: true });
}));

// Aniversariantes do mês (dia/mês do cadastro do cliente) — pra lembrar de mandar parabéns/cupom.
app.get('/api/lojas/:lojaId/clientes-aniversarios', qualquer, rota(async (req, res) => {
  const mes = Number(req.query.mes);
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) falha(400, 'mes inválido (1 a 12)');
  const { rows } = await pool.query(
    `SELECT id, nome, telefone, EXTRACT(DAY FROM nascimento)::int AS dia
     FROM clientes WHERE loja_id = $1 AND nascimento IS NOT NULL AND EXTRACT(MONTH FROM nascimento) = $2
     ORDER BY dia, nome`,
    [req.lojaId, mes]
  );
  res.json(rows);
}));

// Manual exige o PIN da própria pessoa (ninguém bate ponto pelo colega). Facial é
// aceito de quem está logado no terminal e fica marcado como "facial" pra auditoria.
app.post('/api/lojas/:lojaId/pontos', pinLimiter, qualquer, rota(async (req, res) => {
  const body = req.body || {};
  if (!['pin', 'facial'].includes(body.metodo)) falha(400, 'metodo deve ser pin ou facial');
  const r = await transacao(async (c) => {
    const { rows } = await c.query('SELECT id, nome, pin_hash FROM usuarios WHERE id = $1 AND loja_id = $2 AND ativo FOR UPDATE', [body.usuarioId, req.lojaId]);
    const pessoa = rows[0];
    if (!pessoa) falha(404, 'pessoa não encontrada');
    if (body.metodo === 'pin' && (typeof body.pin !== 'string' || !verificarPin(body.pin, pessoa.pin_hash))) falha(401, 'PIN incorreto');
    const { rows: ultimo } = await c.query(
      `SELECT tipo FROM pontos WHERE usuario_id = $1 AND (registrado_em AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date
       ORDER BY registrado_em DESC LIMIT 1`,
      [pessoa.id, TZ]
    );
    const tipo = ultimo.length && ultimo[0].tipo === 'entrada' ? 'saida' : 'entrada';
    const { rows: novo } = await c.query(
      `INSERT INTO pontos (id, loja_id, usuario_id, tipo, metodo, registrado_por) VALUES ($1,$2,$3,$4,$5,$6) RETURNING registrado_em`,
      [uid(), req.lojaId, pessoa.id, tipo, body.metodo, req.usuario.id]
    );
    return { nome: pessoa.nome, tipo, registradoEm: novo[0].registrado_em };
  });
  res.status(201).json(r);
}));

/* ---------- Fotos dos produtos ---------- */

async function fotosDosProdutos(lojaId) {
  const { rows } = await pool.query('SELECT id, produto_id FROM produto_fotos WHERE loja_id = $1 ORDER BY ordem, criado_em', [lojaId]);
  const mapa = {};
  rows.forEach((f) => { (mapa[f.produto_id] = mapa[f.produto_id] || []).push(f.id); });
  return mapa;
}

const MIDIAS_FOTO = ['image/jpeg', 'image/png', 'image/webp'];
app.post('/api/lojas/:lojaId/produtos/:id/fotos', admin, express.json({ limit: '6mb' }), rota(async (req, res) => {
  const body = req.body || {};
  if (!MIDIAS_FOTO.includes(body.mediaType) || typeof body.base64 !== 'string') falha(400, 'Foto inválida — use JPG, PNG ou WEBP');
  const dados = Buffer.from(body.base64, 'base64');
  if (!dados.length || dados.length > 3 * 1024 * 1024) falha(413, 'Foto grande demais (máx. 3 MB)');
  const { rows } = await pool.query(
    `SELECT p.id, (SELECT COUNT(*)::int FROM produto_fotos f WHERE f.produto_id = p.id) AS n,
            (SELECT COALESCE(MAX(ordem), -1) FROM produto_fotos f WHERE f.produto_id = p.id) AS ultima
     FROM produtos p WHERE p.id = $1 AND p.loja_id = $2`, [req.params.id, req.lojaId]);
  if (!rows.length) falha(404, 'produto não encontrado');
  if (rows[0].n >= 8) falha(400, 'Máximo de 8 fotos por produto');
  const id = uid();
  await pool.query('INSERT INTO produto_fotos (id, loja_id, produto_id, ordem, mime, dados) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, req.lojaId, req.params.id, rows[0].ultima + 1, body.mediaType, dados]);
  res.status(201).json({ id });
}));

// Primeira da lista = capa no site.
app.put('/api/lojas/:lojaId/fotos/:id/capa', admin, rota(async (req, res) => {
  const { rows } = await pool.query('SELECT produto_id FROM produto_fotos WHERE id = $1 AND loja_id = $2', [req.params.id, req.lojaId]);
  if (!rows.length) falha(404, 'foto não encontrada');
  await pool.query('UPDATE produto_fotos SET ordem = CASE WHEN id = $1 THEN -1 ELSE ordem + 1 END WHERE produto_id = $2', [req.params.id, rows[0].produto_id]);
  res.json({ ok: true });
}));

app.delete('/api/lojas/:lojaId/fotos/:id', admin, rota(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM produto_fotos WHERE id = $1 AND loja_id = $2', [req.params.id, req.lojaId]);
  if (!rowCount) falha(404, 'foto não encontrada');
  res.json({ ok: true });
}));

// Pública (o site mostra as fotos). O id é aleatório e a foto nunca muda depois de enviada:
// pode ficar em cache por muito tempo.
app.get('/api/lojas/:lojaId/fotos/:id', rota(async (req, res) => {
  const { rows } = await pool.query('SELECT mime, dados FROM produto_fotos WHERE id = $1 AND loja_id = $2', [req.params.id, req.lojaId]);
  if (!rows.length) return res.status(404).end();
  res.set('Content-Type', rows[0].mime).set('Cache-Control', 'public, max-age=31536000, immutable').send(rows[0].dados);
}));

/* ---------- Site da loja (público, sem login) ---------- */

const limitePedidoSite = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: { erro: 'Muitos pedidos seguidos — aguarde alguns minutos ou chame a loja no WhatsApp.' } });

async function configSite(db, lojaId) {
  const { rows } = await db.query('SELECT nome, site_ativo, aceita_entrega, aceita_retirada, taxa_entrega, whatsapp, endereco, mensagem_site FROM lojas WHERE id = $1', [lojaId]);
  if (!rows.length) falha(404, 'loja não encontrada');
  const l = rows[0];
  return { nome: l.nome, ativo: l.site_ativo, aceitaEntrega: l.aceita_entrega, aceitaRetirada: l.aceita_retirada, taxaEntrega: Number(l.taxa_entrega),
    whatsapp: l.whatsapp || '', endereco: l.endereco || '', mensagem: l.mensagem_site || '' };
}

// Catálogo do site: só produto ativo + publicado. Estoque aparece limitado a 10 (o cliente só
// precisa saber se tem e se são as últimas peças) e custo nunca sai daqui.
app.get('/api/lojas/:lojaId/loja/catalogo', rota(async (req, res) => {
  const config = await configSite(pool, req.lojaId);
  if (!config.ativo) return res.json({ config, produtos: [] });
  const { rows: produtos } = await pool.query(
    `SELECT p.id, p.nome, p.categoria, p.descricao, g.tamanhos AS grade_tamanhos
     FROM produtos p LEFT JOIN grades_tamanho g ON g.id = p.grade_tamanho_id
     WHERE p.loja_id = $1 AND p.ativo AND p.publicado ORDER BY p.criado_em DESC`, [req.lojaId]);
  const { rows: variacoes } = await pool.query(
    `SELECT v.id, v.produto_id, v.tamanho, v.cor, v.preco_venda, LEAST(GREATEST(v.estoque, 0), 10)::int AS disponivel
     FROM produto_variacoes v JOIN produtos p ON p.id = v.produto_id
     WHERE v.loja_id = $1 AND v.ativo AND p.ativo AND p.publicado AND v.preco_venda > 0`, [req.lojaId]);
  const fotos = await fotosDosProdutos(req.lojaId);
  const porProduto = {};
  variacoes.forEach((v) => { (porProduto[v.produto_id] = porProduto[v.produto_id] || []).push({ id: v.id, tamanho: v.tamanho, cor: v.cor, preco: Number(v.preco_venda), disponivel: v.disponivel }); });
  res.set('Cache-Control', 'no-store');
  res.json({
    config,
    produtos: produtos.map((p) => {
      const vs = porProduto[p.id] || [];
      const ordem = p.grade_tamanhos || [];
      vs.sort((a, b) => ((ordem.indexOf(a.tamanho) + 1 || 999) - (ordem.indexOf(b.tamanho) + 1 || 999)) || a.cor.localeCompare(b.cor));
      return { id: p.id, nome: p.nome, categoria: p.categoria || '', descricao: p.descricao || '', fotos: fotos[p.id] || [], variacoes: vs };
    }).filter((p) => p.variacoes.some((v) => v.disponivel > 0)),
  });
}));

const STATUS_LABEL = { recebido: 'Recebido', separando: 'Separando as peças', pronto: 'Pronto', saiu_entrega: 'Saiu para entrega', entregue: 'Concluído', cancelado: 'Cancelado' };

// Pedido do site. Preço e total SEMPRE calculados aqui (nunca confiados do navegador) e as peças
// ficam reservadas na hora. Telefone vira (ou encontra) o cadastro do cliente — ganha cashback.
app.post('/api/lojas/:lojaId/loja/pedidos', limitePedidoSite, rota(async (req, res) => {
  const body = req.body || {};
  const nome = texto(body.nome, 'Seu nome', { max: 100 });
  const telefone = soDigitos(body.telefone) || '';
  if (telefone.length < 10 || telefone.length > 11) falha(400, 'Telefone com DDD, só números (ex.: 84 99999-8888)');
  if (!['entrega', 'retirada'].includes(body.tipo)) falha(400, 'Escolha entrega ou retirada');
  if (!['Pix', 'Dinheiro', 'Débito', 'Crédito'].includes(body.pagamento)) falha(400, 'Escolha a forma de pagamento');
  const endereco = body.tipo === 'entrega' ? texto(body.endereco, 'Endereço de entrega', { max: 300 }) : null;
  const observacao = texto(body.observacao, 'Observação', { obrigatorio: false, max: 300 });
  const origem = body.origem === 'whatsapp' ? 'whatsapp' : 'site';
  if (!Array.isArray(body.itens) || !body.itens.length || body.itens.length > 30) falha(400, 'Sacola vazia');
  const porVariacao = new Map();
  for (const it of body.itens) {
    if (!it || typeof it.variacaoId !== 'string' || it.variacaoId.length > 40) falha(400, 'Item inválido');
    const qtd = numero(it.qtd, 'quantidade', { minExclusivo: true, inteiro: true, max: 20 });
    porVariacao.set(it.variacaoId, (porVariacao.get(it.variacaoId) || 0) + qtd);
  }
  const itens = [...porVariacao].map(([variacaoId, qtd]) => ({ variacaoId, qtd })).sort((a, b) => (a.variacaoId < b.variacaoId ? -1 : 1));

  const r = await transacao(async (c) => {
    const config = await configSite(c, req.lojaId);
    if (!config.ativo) falha(403, 'A loja não está recebendo pedidos pelo site agora');
    if (body.tipo === 'entrega' && !config.aceitaEntrega) falha(400, 'A loja não está fazendo entregas agora');
    if (body.tipo === 'retirada' && !config.aceitaRetirada) falha(400, 'Retirada na loja indisponível agora');
    let subtotal = 0;
    const gravar = [];
    for (const it of itens) {
      const { rows } = await c.query(
        `SELECT v.id, v.tamanho, v.cor, v.estoque, v.preco_venda, v.custo_unitario, p.nome AS produto_nome
         FROM produto_variacoes v JOIN produtos p ON p.id = v.produto_id
         WHERE v.id = $1 AND v.loja_id = $2 AND v.ativo AND p.ativo AND p.publicado AND v.preco_venda > 0 FOR UPDATE OF v`,
        [it.variacaoId, req.lojaId]);
      const v = rows[0];
      if (!v) falha(409, 'Uma das peças não está mais disponível — atualize a página', { codigo: 'peca_indisponivel', variacaoId: it.variacaoId });
      if (Number(v.estoque) < it.qtd) {
        falha(409, 'Só temos ' + Math.max(0, Number(v.estoque)) + ' de ' + v.produto_nome + ' ' + v.tamanho + (v.cor ? ' ' + v.cor : ''),
          { codigo: 'estoque_insuficiente', variacaoId: v.id, disponivel: Math.max(0, Number(v.estoque)) });
      }
      const preco = Number(v.preco_venda);
      subtotal = round2(subtotal + preco * it.qtd);
      gravar.push({ ...it, preco, custo: Number(v.custo_unitario), produtoNome: v.produto_nome, tamanho: v.tamanho, cor: v.cor });
    }
    const taxa = body.tipo === 'entrega' ? config.taxaEntrega : 0;
    const total = round2(subtotal + taxa);
    let trocoPara = null;
    if (body.pagamento === 'Dinheiro' && body.trocoPara != null && body.trocoPara !== '') {
      trocoPara = numero(body.trocoPara, 'Troco para', { max: 100000 });
      if (trocoPara < total) falha(400, 'O valor pra troco precisa ser maior que o total (R$ ' + total.toFixed(2).replace('.', ',') + ')');
    }

    // Cliente pelo telefone (mesmo cadastro da loja física: cashback vale nos dois).
    let clienteId;
    const { rows: cli } = await c.query('SELECT id FROM clientes WHERE loja_id = $1 AND telefone = $2', [req.lojaId, telefone]);
    if (cli.length) clienteId = cli[0].id;
    else {
      clienteId = uid();
      await c.query('INSERT INTO clientes (id, loja_id, nome, telefone, observacao) VALUES ($1,$2,$3,$4,$5)', [clienteId, req.lojaId, nome, telefone, 'Cadastrado por pedido no site']);
    }

    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['pedido_online_numero_' + req.lojaId]);
    const { rows: ult } = await c.query('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM pedidos_online WHERE loja_id = $1', [req.lojaId]);
    const id = uid(), numeroPedido = ult[0].n, token = crypto.randomBytes(18).toString('base64url');
    await c.query(
      `INSERT INTO pedidos_online (id, loja_id, numero, token, cliente_id, cliente_nome, telefone, tipo, endereco, pagamento, troco_para, observacao, subtotal, taxa_entrega, total, origem)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, req.lojaId, numeroPedido, token, clienteId, nome, telefone, body.tipo, endereco, body.pagamento, trocoPara, observacao, subtotal, taxa, total, origem]);
    for (const it of gravar) {
      await c.query('INSERT INTO pedidos_online_itens (id, pedido_id, variacao_id, produto_nome, tamanho, cor, qtd, preco_unit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [uid(), id, it.variacaoId, it.produtoNome, it.tamanho, it.cor, it.qtd, it.preco]);
      await c.query('UPDATE produto_variacoes SET estoque = estoque - $1 WHERE id = $2', [it.qtd, it.variacaoId]);
      await c.query(
        `INSERT INTO movimentos_estoque_produto (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, referencia_id, observacao)
         VALUES ($1,$2,$3,'venda',$4,$5,$6,'pedido_online',$7,'Reservado pelo pedido online')`,
        [uid(), req.lojaId, it.variacaoId, -it.qtd, it.custo, round2(it.custo * it.qtd), id]);
    }
    return { id, numero: numeroPedido, token, total, telefone };
  });
  notificarBot(req.lojaId, r.id, 'recebido');
  res.status(201).json({ numero: r.numero, token: r.token, total: r.total });
}));

async function detalhePedido(db, where, params) {
  const { rows } = await db.query(`SELECT * FROM pedidos_online WHERE ${where}`, params);
  if (!rows.length) return null;
  const p = rows[0];
  const { rows: itens } = await db.query('SELECT variacao_id, produto_nome, tamanho, cor, qtd, preco_unit FROM pedidos_online_itens WHERE pedido_id = $1 ORDER BY produto_nome, tamanho', [p.id]);
  return { ...p, subtotal: Number(p.subtotal), taxa_entrega: Number(p.taxa_entrega), total: Number(p.total), troco_para: p.troco_para == null ? null : Number(p.troco_para),
    itens: itens.map((i) => ({ ...i, preco_unit: Number(i.preco_unit) })) };
}

// Acompanhamento pelo link que o cliente recebe (token aleatório; sem telefone/endereço na resposta).
app.get('/api/lojas/:lojaId/loja/pedidos/:token', rota(async (req, res) => {
  if (!/^[A-Za-z0-9_-]{10,60}$/.test(req.params.token)) falha(404, 'Pedido não encontrado');
  const p = await detalhePedido(pool, 'token = $1 AND loja_id = $2', [req.params.token, req.lojaId]);
  if (!p) falha(404, 'Pedido não encontrado');
  res.set('Cache-Control', 'no-store');
  res.json({ numero: p.numero, status: p.status, statusLabel: STATUS_LABEL[p.status], tipo: p.tipo, pagamento: p.pagamento, clienteNome: p.cliente_nome.split(' ')[0],
    itens: p.itens.map((i) => ({ produtoNome: i.produto_nome, tamanho: i.tamanho, cor: i.cor, qtd: i.qtd, precoUnit: i.preco_unit })),
    subtotal: p.subtotal, taxaEntrega: p.taxa_entrega, total: p.total, criadoEm: p.criado_em, atualizadoEm: p.atualizado_em });
}));

/* ---------- Pedidos online (painel) ---------- */

// Avisa o atendente de WhatsApp (quando existir) que o status mudou — nunca atrasa o painel.
const BOT_URL = process.env.BOT_URL || 'http://127.0.0.1:' + (process.env.BOT_PORT || 3101);
function notificarBot(lojaId, pedidoId, status) {
  if (!process.env.BOT_WEBHOOK_SECRET) return;
  fetch(BOT_URL + '/webhook/pedido-status', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': process.env.BOT_WEBHOOK_SECRET },
    body: JSON.stringify({ lojaId, pedidoId, status }), signal: AbortSignal.timeout(5000) })
    .catch(() => {}); // bot desligado: o pedido segue normal, só não sai o aviso automático
}

app.get('/api/lojas/:lojaId/pedidos-online', qualquer, rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id FROM pedidos_online WHERE loja_id = $1 AND (status NOT IN ('entregue', 'cancelado') OR atualizado_em > now() - interval '2 days')
     ORDER BY criado_em DESC LIMIT 100`, [req.lojaId]);
  const lista = [];
  for (const r of rows) lista.push(await detalhePedido(pool, 'id = $1', [r.id]));
  res.json(lista.map(({ token, ...p }) => p));
}));

app.get('/api/lojas/:lojaId/pedidos-online/contagem', qualquer, rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'recebido')::int AS novos, COUNT(*) FILTER (WHERE status NOT IN ('entregue', 'cancelado'))::int AS abertos,
            MAX(numero) AS ultimo FROM pedidos_online WHERE loja_id = $1`, [req.lojaId]);
  res.json(rows[0]);
}));

const PROXIMO_STATUS = { recebido: ['separando', 'pronto'], separando: ['pronto'], pronto: ['saiu_entrega'] };
app.put('/api/lojas/:lojaId/pedidos-online/:id/status', qualquer, rota(async (req, res) => {
  const body = req.body || {};
  const r = await transacao(async (c) => {
    const { rows } = await c.query('SELECT status, tipo FROM pedidos_online WHERE id = $1 AND loja_id = $2 FOR UPDATE', [req.params.id, req.lojaId]);
    if (!rows.length) falha(404, 'pedido não encontrado');
    const atual = rows[0];
    if (!(PROXIMO_STATUS[atual.status] || []).includes(body.status)) falha(409, 'Esse pedido está "' + STATUS_LABEL[atual.status] + '" — não dá pra mudar pra esse status');
    if (body.status === 'saiu_entrega' && atual.tipo !== 'entrega') falha(400, 'Pedido é de retirada na loja');
    const entregador = body.status === 'saiu_entrega' ? texto(body.entregador, 'entregador', { obrigatorio: false, max: 60 }) : null;
    await c.query('UPDATE pedidos_online SET status = $1, entregador = COALESCE($2, entregador), atualizado_em = now() WHERE id = $3', [body.status, entregador, req.params.id]);
    return { status: body.status };
  });
  notificarBot(req.lojaId, req.params.id, r.status);
  res.json(r);
}));

// Concluir = o cliente recebeu e pagou: vira uma venda do caixa aberto (entra no Livro caixa,
// relatórios e cashback). As peças já tinham saído do estoque na reserva.
app.post('/api/lojas/:lojaId/pedidos-online/:id/concluir', qualquer, rota(async (req, res) => {
  const r = await transacao(async (c) => {
    const { rows } = await c.query('SELECT id FROM pedidos_online WHERE id = $1 AND loja_id = $2 FOR UPDATE', [req.params.id, req.lojaId]);
    if (!rows.length) falha(404, 'pedido não encontrado');
    const p = await detalhePedido(c, 'id = $1', [req.params.id]);
    if (['entregue', 'cancelado'].includes(p.status)) falha(409, 'Esse pedido já está ' + STATUS_LABEL[p.status].toLowerCase());
    const sessao = await sessaoAberta(c, req.lojaId, 'SHARE');
    if (!sessao) falha(409, 'Caixa fechado — abra o caixa no Início pra concluir o pedido', { codigo: 'caixa_fechado' });
    const vendaId = uid();
    await c.query(
      `INSERT INTO vendas (id, loja_id, usuario_id, canal, subtotal, desconto, total, forma_pagamento, caixa_sessao_id, cliente_id, taxa_entrega, pedido_online_id)
       VALUES ($1,$2,$3,'online',$4,0,$5,$6,$7,$8,$9,$10)`,
      [vendaId, req.lojaId, req.usuario.id, p.subtotal, p.total, p.pagamento, sessao.id, p.cliente_id, p.taxa_entrega, p.id]);
    for (const it of p.itens) {
      await c.query(
        `INSERT INTO vendas_itens (id, venda_id, variacao_id, produto_nome, tamanho, cor, qtd, preco_unit, desconto_item) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0)`,
        [uid(), vendaId, it.variacao_id, it.produto_nome, it.tamanho, it.cor, it.qtd, it.preco_unit]);
    }
    await c.query('INSERT INTO venda_pagamentos (id, venda_id, forma, valor) VALUES ($1,$2,$3,$4)', [uid(), vendaId, p.pagamento, p.total]);
    const { rows: loja } = await c.query('SELECT cashback_pct FROM lojas WHERE id = $1', [req.lojaId]);
    let cashback = 0;
    if (p.cliente_id && Number(loja[0].cashback_pct) > 0) {
      cashback = round2(p.subtotal * Number(loja[0].cashback_pct) / 100);
      if (cashback > 0) {
        await c.query(
          `INSERT INTO cliente_creditos (id, loja_id, cliente_id, tipo, valor, origem, referencia_id, criado_por) VALUES ($1,$2,$3,'cashback',$4,'venda',$5,$6)`,
          [uid(), req.lojaId, p.cliente_id, cashback, vendaId, req.usuario.id]);
        await c.query('UPDATE vendas SET cashback_gerado = $1 WHERE id = $2', [cashback, vendaId]);
      }
    }
    await c.query("UPDATE pedidos_online SET status = 'entregue', venda_id = $1, atualizado_em = now() WHERE id = $2", [vendaId, p.id]);
    return { vendaId, total: p.total, cashbackGerado: cashback };
  });
  notificarBot(req.lojaId, req.params.id, 'entregue');
  res.json(r);
}));

// Cancelar devolve as peças reservadas pro estoque.
app.post('/api/lojas/:lojaId/pedidos-online/:id/cancelar', admin, rota(async (req, res) => {
  const motivo = texto((req.body || {}).motivo, 'motivo', { obrigatorio: false, max: 200 });
  await transacao(async (c) => {
    const { rows } = await c.query('SELECT id FROM pedidos_online WHERE id = $1 AND loja_id = $2 FOR UPDATE', [req.params.id, req.lojaId]);
    if (!rows.length) falha(404, 'pedido não encontrado');
    const p = await detalhePedido(c, 'id = $1', [req.params.id]);
    if (['entregue', 'cancelado'].includes(p.status)) falha(409, 'Esse pedido já está ' + STATUS_LABEL[p.status].toLowerCase() + (p.status === 'entregue' ? ' — use Troca/devolução na Venda rápida' : ''));
    for (const it of [...p.itens].sort((a, b) => (a.variacao_id < b.variacao_id ? -1 : 1))) {
      const { rows: v } = await c.query('SELECT custo_unitario FROM produto_variacoes WHERE id = $1 FOR UPDATE', [it.variacao_id]);
      await c.query('UPDATE produto_variacoes SET estoque = estoque + $1 WHERE id = $2', [it.qtd, it.variacao_id]);
      await c.query(
        `INSERT INTO movimentos_estoque_produto (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, referencia_id, observacao, criado_por)
         VALUES ($1,$2,$3,'devolucao',$4,$5,$6,'pedido_online',$7,'Pedido online cancelado',$8)`,
        [uid(), req.lojaId, it.variacao_id, it.qtd, Number(v[0].custo_unitario), round2(Number(v[0].custo_unitario) * it.qtd), p.id, req.usuario.id]);
    }
    await c.query("UPDATE pedidos_online SET status = 'cancelado', motivo_cancelamento = $1, atualizado_em = now() WHERE id = $2", [motivo, p.id]);
  });
  notificarBot(req.lojaId, req.params.id, 'cancelado');
  res.json({ ok: true });
}));

/* ---------- WhatsApp (painel → serviço bot-whatsapp) ---------- */

async function repassarBot(req, res, caminho, metodo) {
  if (!process.env.BOT_WEBHOOK_SECRET) return res.status(503).json({ erro: 'Atendente de WhatsApp não configurado (falta BOT_WEBHOOK_SECRET — rode "npm run setup").', codigo: 'bot_desligado' });
  try {
    const r = await fetch(BOT_URL + caminho, {
      method: metodo || 'GET', headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': process.env.BOT_WEBHOOK_SECRET },
      body: metodo === 'POST' ? JSON.stringify(req.body || {}) : undefined, signal: AbortSignal.timeout(10000),
    });
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch (e) {
    res.status(503).json({ erro: 'O atendente de WhatsApp não está rodando neste computador.', codigo: 'bot_desligado' });
  }
}
app.get('/api/lojas/:lojaId/bot/status', admin, (req, res) => repassarBot(req, res, '/status'));
app.post('/api/lojas/:lojaId/bot/desconectar', admin, (req, res) => repassarBot(req, res, '/desconectar', 'POST'));
app.get('/api/lojas/:lojaId/bot/conversas', admin, (req, res) => repassarBot(req, res, '/conversas'));
app.get('/api/lojas/:lojaId/bot/conversas/:telefone', admin, (req, res) => {
  if (!/^\d{5,20}$/.test(req.params.telefone)) return res.status(400).json({ erro: 'telefone inválido' });
  repassarBot(req, res, '/conversas/' + req.params.telefone);
});
app.post('/api/lojas/:lojaId/bot/enviar', admin, (req, res) => repassarBot(req, res, '/enviar', 'POST'));
app.post('/api/lojas/:lojaId/bot/reativar', admin, (req, res) => repassarBot(req, res, '/reativar', 'POST'));

app.get('/api/lojas/:lojaId/bot/instrucoes', admin, rota(async (req, res) => {
  const { rows } = await pool.query('SELECT bot_instrucoes FROM lojas WHERE id = $1', [req.lojaId]);
  res.json({ instrucoes: rows.length ? rows[0].bot_instrucoes || '' : '' });
}));
app.put('/api/lojas/:lojaId/bot/instrucoes', admin, rota(async (req, res) => {
  const instrucoes = texto((req.body || {}).instrucoes, 'instruções', { obrigatorio: false, max: 4000 }) || '';
  await pool.query('UPDATE lojas SET bot_instrucoes = $1 WHERE id = $2', [instrucoes, req.lojaId]);
  res.json({ ok: true });
}));

/* ---------- Backup ---------- */

app.get('/api/lojas/:lojaId/backup', admin, rota(async (req, res) => {
  res.json({ status: backup.lerStatus(), recentes: backup.listarBackups().slice(0, 10), pasta: backup.PASTA, copia: process.env.BACKUP_COPIA || null });
}));
app.post('/api/lojas/:lojaId/backup', admin, rota(async (req, res) => {
  const status = await backup.fazerBackup('pelo painel (' + req.usuario.nome + ')');
  res.status(status.ok ? 200 : 500).json(status.ok ? status : { ...status, erro: 'Backup falhou: ' + status.erro });
}));

/* ---------- Erros ---------- */

app.use((err, req, res, next) => {
  if (err instanceof ErroApi) return res.status(err.status).json({ erro: err.message, ...(err.extra || {}) });
  if (err instanceof fiscal.ErroFiscal) return res.status(err.status).json({ erro: err.message, codigo: 'fiscal' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido' });
  console.error(err);
  res.status(500).json({ erro: 'Erro interno — tente de novo' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('API da Loja Gutto rodando na porta ' + PORT);
  backup.agendar();
});
