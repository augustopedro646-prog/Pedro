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
const seguranca = require('./seguranca');
const promocoes = require('./promocoes');
const fiscal = require('./fiscal');
const mensagens = require('./mensagens');
const mp = require('./mercadopago');
const frete = require('./frete');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

// Leitura de nota por PDF/foto usa a IA do Claude (mesma ideia do Jabá). Sem chave no .env,
// o XML continua funcionando normalmente — só PDF/foto ficam indisponíveis.
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ timeout: 5 * 60 * 1000 }) : null;

// Fuso da loja (Parnamirim/RN, UTC-3 sem horário de verão). "Hoje" e "mês" são sempre
// calculados nesse fuso no banco — com UTC, uma venda às 22h cairia no dia seguinte.
const TZ = process.env.TZ_LOJA || 'America/Fortaleza';

const app = express();
app.disable('x-powered-by');
app.use(seguranca.cabecalhos);
app.use(seguranca.filtroInternet); // pela internet (túnel), só o site da loja — ver seguranca.js
app.use(cors());
// Só a leitura de nota recebe arquivo grande (fotos/PDF em base64); o resto fica no limite pequeno.
const jsonPadrao = express.json({ limit: '1mb' });
app.use((req, res, next) => (req.path.endsWith('/compras/ler-nota') || req.path.endsWith('/produtos/importar-planilha') || /\/produtos\/[^/]+\/fotos$/.test(req.path) ? next() : jsonPadrao(req, res, next)));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/painel-gutto.html'));
app.get('/loja', (req, res) => res.redirect('/loja-gutto.html'));

// Limite geral generoso; login e PIN de ponto têm limite apertado à parte (força bruta).
// Contados por visitante (IP real que o Cloudflare manda), não pelo túnel inteiro.
const porVisitante = { keyGenerator: seguranca.ipReal, validate: { xForwardedForHeader: false } };
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 600, ...porVisitante }));
const pinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { erro: 'Muitas tentativas — aguarde alguns minutos.' }, ...porVisitante });
// PIN errado demais trava aquele usuário por um tempo (além do limite por IP acima).
function conferirPin(req, usuario, pin) {
  const min = seguranca.pinTravado(req, usuario.id);
  if (min) falha(429, 'PIN errado muitas vezes — ' + usuario.nome + ' fica bloqueado(a) por ' + min + ' min', { codigo: 'pin_travado' });
  const ok = typeof pin === 'string' && verificarPin(pin, usuario.pin_hash);
  seguranca.registrarPin(req, usuario.id, ok);
  return ok;
}

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
function hojeLoja() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); }
// Mesmo dia nos meses seguintes (31/01 + 1 mês = 28 ou 29/02).
function somaMesesISO(iso, n) {
  const [a, m, d] = iso.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1));
  alvo.setUTCDate(Math.min(d, new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate()));
  return alvo.toISOString().slice(0, 10);
}

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
const FORMAS_PAGAMENTO = ['Dinheiro', 'Débito', 'Crédito', 'Pix', 'Cashback', 'Vale-troca', 'Crediário'];
const FORMAS_RECEBIMENTO = ['Dinheiro', 'Pix', 'Débito', 'Crédito'];
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
  if (!usuario || !conferirPin(req, usuario, pin)) falha(401, 'PIN incorreto');
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

// Pagamento pelo site: quais formas online a loja aceita (só valem com o Mercado Pago no .env) e
// se ainda aceita "pagar na entrega/retirada".
function mesclarPagamento(s) {
  s = s && typeof s === 'object' ? s : {};
  const n = (v, p, min, max) => (Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : p);
  return { pix: s.pix === true, cartao: s.cartao === true, naEntrega: s.naEntrega !== false, maxParcelas: n(s.maxParcelas, 3, 1, 12), minutosPagar: n(s.minutosPagar, 30, 30, 1440) }; // Pix: o Mercado Pago pede no mínimo 30 min
}

app.get('/api/lojas/:lojaId/config', qualquer, rota(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM lojas WHERE id = $1', [req.lojaId]);
  if (!rows.length) falha(404, 'loja não encontrada');
  const l = rows[0];
  res.json({ nome: l.nome, cashbackPct: Number(l.cashback_pct), descontoLivrePct: Number(l.desconto_livre_pct), comissaoPct: Number(l.comissao_pct), leituraIA: !!anthropic,
    crediario: { limitePadrao: Number(l.crediario_limite_padrao), maxParcelas: l.crediario_max_parcelas },
    troca: { diasLoja: l.troca_dias_loja, diasSite: l.troca_dias_site },
    condicional: { limitePadrao: Number(l.condicional_limite_padrao) },
    cupomRodape: l.cupom_rodape || '', siteUrl: (process.env.SITE_URL || '').replace(/\/+$/, '') || null,
    fiscal: { cfop: l.fiscal_cfop || '', csosn: l.fiscal_csosn || '', origem: l.fiscal_origem || '0', automatica: !!l.nfce_automatica,
      ambiente: fiscal.ambiente(), faltandoNoServidor: fiscal.faltandoNoServidor(),
      pronto: !fiscal.faltandoNoServidor().length && /^\d{4}$/.test(l.fiscal_cfop || '') && /^\d{3}$/.test(l.fiscal_csosn || '') },
    site: { ativo: l.site_ativo, aceitaEntrega: l.aceita_entrega, aceitaRetirada: l.aceita_retirada, taxaEntrega: Number(l.taxa_entrega),
      whatsapp: l.whatsapp || '', endereco: l.endereco || '', mensagem: l.mensagem_site || '', avaliacaoGoogle: l.google_avaliacao_url || '' },
    pagamento: { ...mesclarPagamento(l.pagamento_config), configurado: mp.configurado(), teste: mp.modoTeste() },
    envio: { ...frete.mesclarConfig(l.envio_config), configurado: frete.configurado() } });
}));

app.put('/api/lojas/:lojaId/config', admin, rota(async (req, res) => {
  const body = req.body || {};
  const cashback = body.cashbackPct != null ? numero(body.cashbackPct, 'cashbackPct', { max: 50 }) : null;
  const desconto = body.descontoLivrePct != null ? numero(body.descontoLivrePct, 'descontoLivrePct', { max: 100 }) : null;
  await pool.query(
    'UPDATE lojas SET cashback_pct = COALESCE($1, cashback_pct), desconto_livre_pct = COALESCE($2, desconto_livre_pct) WHERE id = $3',
    [cashback, desconto, req.lojaId]
  );
  if (body.crediario && typeof body.crediario === 'object') {
    const cr = body.crediario;
    await pool.query('UPDATE lojas SET crediario_limite_padrao = COALESCE($1, crediario_limite_padrao), crediario_max_parcelas = COALESCE($2, crediario_max_parcelas) WHERE id = $3',
      [cr.limitePadrao != null ? numero(cr.limitePadrao, 'limite padrão do crediário', { max: 1e6 }) : null,
        cr.maxParcelas != null ? numero(cr.maxParcelas, 'máximo de parcelas', { min: 1, max: 24, inteiro: true }) : null, req.lojaId]);
  }
  if (body.condicional && typeof body.condicional === 'object' && body.condicional.limitePadrao != null) {
    await pool.query('UPDATE lojas SET condicional_limite_padrao = $1 WHERE id = $2', [numero(body.condicional.limitePadrao, 'limite do condicional', { max: 1e6 }), req.lojaId]);
  }
  if (body.troca && typeof body.troca === 'object') {
    const t = body.troca;
    await pool.query('UPDATE lojas SET troca_dias_loja = COALESCE($1, troca_dias_loja), troca_dias_site = COALESCE($2, troca_dias_site) WHERE id = $3',
      [t.diasLoja != null ? numero(t.diasLoja, 'prazo de troca na loja', { min: 0, max: 365, inteiro: true }) : null,
        t.diasSite != null ? numero(t.diasSite, 'prazo de troca do site', { min: 0, max: 365, inteiro: true }) : null, req.lojaId]);
  }
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
    if (site.avaliacaoGoogle != null) {
      const url = String(site.avaliacaoGoogle).trim();
      if (url && !/^https:\/\/([a-z0-9-]+\.)*(google\.[a-z.]+|goo\.gl|g\.page)\//i.test(url)) falha(400, 'Link de avaliação: cole o link que o Google dá (começa com https://g.page/, https://search.google.com/... ou https://maps.app.goo.gl/)');
      await pool.query('UPDATE lojas SET google_avaliacao_url = $1 WHERE id = $2', [url.slice(0, 300) || null, req.lojaId]);
    }
  }
  if (body.pagamento && typeof body.pagamento === 'object') {
    const pg = mesclarPagamento(body.pagamento);
    if (!pg.naEntrega && !pg.pix && !pg.cartao) falha(400, 'Deixe pelo menos uma forma de pagamento no site');
    await pool.query('UPDATE lojas SET pagamento_config = $1 WHERE id = $2', [JSON.stringify(pg), req.lojaId]);
  }
  if (body.envio && typeof body.envio === 'object') {
    const ev = frete.mesclarConfig(body.envio);
    if (ev.ativo && !ev.cepOrigem) falha(400, 'Pra enviar pelos Correios, preencha o CEP de onde os pedidos saem');
    await pool.query('UPDATE lojas SET envio_config = $1 WHERE id = $2', [JSON.stringify(ev), req.lojaId]);
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
    `SELECT p.id, p.nome, p.categoria, p.genero, p.descricao, p.ncm, p.foto_url, p.ativo, p.publicado,
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
  const promos = await promocoes.ativas(pool, req.lojaId, TZ);
  const { rows: foraCond } = await pool.query(
    `SELECT ci.variacao_id, SUM(ci.qtd)::int AS qtd FROM condicional_itens ci JOIN condicionais c ON c.id = ci.condicional_id
     WHERE c.loja_id = $1 AND c.status = 'aberto' GROUP BY ci.variacao_id`, [req.lojaId]);
  const emCondicional = Object.fromEntries(foraCond.map((r) => [r.variacao_id, r.qtd]));
  res.json(produtos.map((p) => ({
    ...p,
    grade: p.grade_id ? { id: p.grade_id, nome: p.grade_nome, tamanhos: p.grade_tamanhos } : null,
    // preco_venda = preço da tabela (o que se edita); preco_promo = o que o cliente paga hoje.
    variacoes: (porProduto[p.id] || []).map((v0) => {
      const v = emCondicional[v0.id] ? { ...v0, em_condicional: emCondicional[v0.id] } : v0;
      const pr = promocoes.precoComPromo(promos, p.id, p.categoria, v.preco_venda);
      return pr.promo ? { ...v, preco_promo: pr.preco, promocao: { id: pr.promo.id, nome: pr.promo.nome, pct: pr.promo.pct, fim: pr.promo.fim } } : v;
    }),
    fotos: fotosPorProduto[p.id] || [],
  })));
}));

// Gênero da peça: feminino / masculino / unissex. Aceita também menina/menino, F/M/U (planilha).
// undefined = não mexer; '' ou null = sem gênero.
const GENEROS = { feminino: 'feminino', f: 'feminino', menina: 'feminino', fem: 'feminino', masculino: 'masculino', m: 'masculino', menino: 'masculino', masc: 'masculino', unissex: 'unissex', u: 'unissex', unisex: 'unissex' };
function generoDe(v) {
  if (v === undefined) return undefined;
  if (v === null || String(v).trim() === '') return null;
  const g = GENEROS[String(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()];
  if (!g) falha(400, 'Gênero inválido (use Feminino, Masculino ou Unissex)');
  return g;
}

// Valida os dados de uma variação (tamanho × cor) vindos do painel.
function dadosVariacao(body) {
  return {
    tamanho: texto(body.tamanho, 'tamanho', { max: 10 }),
    cor: texto(body.cor, 'cor', { obrigatorio: false, max: 40 }) || '',
    preco: numero(body.precoVenda, 'precoVenda'),
    custo: body.custoUnitario != null && body.custoUnitario !== '' ? numero(body.custoUnitario, 'custoUnitario') : 0,
    minimo: body.estoqueMinimo != null && body.estoqueMinimo !== '' ? numero(body.estoqueMinimo, 'estoqueMinimo', { inteiro: true }) : 0,
    inicial: body.estoqueInicial != null && body.estoqueInicial !== '' ? numero(body.estoqueInicial, 'estoqueInicial', { inteiro: true, max: 100000 }) : 0,
    codigo: soDigitos(body.codigoBarras),
    sku: texto(body.sku, 'sku', { obrigatorio: false, max: 40 }),
  };
}
// Cria a variação com código de barras próprio; estoque inicial vira entrada no histórico.
async function inserirVariacao(c, lojaId, produtoId, d, usuarioId) {
  const id = uid();
  const codigo = d.codigo || await gerarCodigoBarras(c);
  await c.query(
    `INSERT INTO produto_variacoes
       (id, loja_id, produto_id, tamanho, cor, sku, codigo_barras, preco_venda, custo_unitario, estoque, estoque_minimo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, lojaId, produtoId, d.tamanho, d.cor, d.sku, codigo, d.preco, d.custo, d.inicial, d.minimo]
  );
  if (d.inicial > 0) {
    await c.query(
      `INSERT INTO movimentos_estoque_produto
         (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, criado_por)
       VALUES ($1,$2,$3,'entrada',$4,$5,$6,'cadastro',$7)`,
      [uid(), lojaId, id, d.inicial, d.custo, round2(d.inicial * d.custo), usuarioId]
    );
  }
  return { id, tamanho: d.tamanho, cor: d.cor, codigoBarras: codigo, estoque: d.inicial };
}

// Corpo: { nome, categoria?, descricao?, ncm?, gradeTamanhoId?, variacoes?: [{tamanho, cor, precoVenda, ...}] }.
// Com `variacoes`, cria o produto e a grade inteira numa transação só (tudo ou nada).
app.post('/api/lojas/:lojaId/produtos', admin, rota(async (req, res) => {
  const body = req.body || {};
  const nome = texto(body.nome, 'nome do produto');
  const genero = generoDe(body.genero) || null;
  const variacoes = Array.isArray(body.variacoes) ? body.variacoes : [];
  if (variacoes.length > 300) falha(400, 'Grade grande demais (máximo 300 tamanhos/cores)');
  const dados = variacoes.map(dadosVariacao);
  const chaves = new Set(dados.map((d) => d.tamanho + '|' + d.cor.toLowerCase()));
  if (chaves.size !== dados.length) falha(400, 'Tem tamanho/cor repetido na grade');
  try {
    const r = await transacao(async (c) => {
      const id = uid();
      await c.query(
        `INSERT INTO produtos (id, loja_id, nome, categoria, descricao, grade_tamanho_id, ncm, genero) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, req.lojaId, nome, texto(body.categoria, 'categoria', { obrigatorio: false, max: 60 }),
          texto(body.descricao, 'descricao', { obrigatorio: false, max: 500 }), body.gradeTamanhoId || null,
          soDigitos(body.ncm), genero]
      );
      const criadas = [];
      for (const d of dados) criadas.push(await inserirVariacao(c, req.lojaId, id, d, req.usuario.id));
      return { id, variacoes: criadas };
    });
    res.status(201).json(r);
  } catch (e) {
    if (e.code === '23505') falha(409, 'Esse código de barras já está em uso em outra peça');
    throw e;
  }
}));

app.put('/api/lojas/:lojaId/produtos/:id', admin, rota(async (req, res) => {
  const body = req.body || {};
  const { rowCount } = await pool.query(
    `UPDATE produtos SET nome = COALESCE($1, nome), categoria = COALESCE($2, categoria),
       descricao = COALESCE($3, descricao), ncm = COALESCE($4, ncm), ativo = COALESCE($5, ativo), publicado = COALESCE($8, publicado),
       genero = CASE WHEN $9 THEN $10 ELSE genero END
     WHERE id = $6 AND loja_id = $7`,
    [body.nome != null ? texto(body.nome, 'nome do produto') : null,
      texto(body.categoria, 'categoria', { obrigatorio: false, max: 60 }),
      body.descricao != null ? (texto(body.descricao, 'descricao', { obrigatorio: false, max: 1000 }) || '') : null,
      soDigitos(body.ncm), typeof body.ativo === 'boolean' ? body.ativo : null, req.params.id, req.lojaId,
      typeof body.publicado === 'boolean' ? body.publicado : null, body.genero !== undefined, generoDe(body.genero) || null]
  );
  if (!rowCount) falha(404, 'produto não encontrado');
  res.json({ ok: true });
}));

app.post('/api/lojas/:lojaId/produtos/:id/variacoes', admin, rota(async (req, res) => {
  const d = dadosVariacao(req.body || {});
  try {
    const variacaoId = await transacao(async (c) => {
      const produto = await c.query('SELECT id FROM produtos WHERE id = $1 AND loja_id = $2', [req.params.id, req.lojaId]);
      if (!produto.rowCount) falha(404, 'produto não encontrado');
      return (await inserirVariacao(c, req.lojaId, req.params.id, d, req.usuario.id)).id;
    });
    res.status(201).json({ id: variacaoId });
  } catch (e) {
    if (e.code === '23505') falha(409, 'Já existe essa combinação de tamanho/cor, ou esse código de barras já está em uso');
    throw e;
  }
}));

app.put('/api/lojas/:lojaId/variacoes/:id', admin, rota(async (req, res) => {
  const body = req.body || {};
  // Código apagado ("") = gerar um novo do sistema (ex.: código antigo comprido demais pra etiqueta).
  const codigo = body.codigoBarras === '' ? await gerarCodigoBarras(pool) : soDigitos(body.codigoBarras);
  try {
    const { rowCount } = await pool.query(
      `UPDATE produto_variacoes SET preco_venda = COALESCE($1, preco_venda), estoque_minimo = COALESCE($2, estoque_minimo),
         ativo = COALESCE($3, ativo), codigo_barras = COALESCE($4, codigo_barras), sku = COALESCE($5, sku)
       WHERE id = $6 AND loja_id = $7`,
      [body.precoVenda != null ? numero(body.precoVenda, 'precoVenda') : null,
        body.estoqueMinimo != null ? numero(body.estoqueMinimo, 'estoqueMinimo') : null,
        typeof body.ativo === 'boolean' ? body.ativo : null,
        codigo, texto(body.sku, 'sku', { obrigatorio: false, max: 40 }),
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

/* ---------- Lista de presentes (chá de bebê) ---------- */

// Marca como presenteado o que a venda/pedido tem da lista (até a quantidade que ainda falta).
async function registrarPresentes(c, listaId, itens, ref, deQuem, mensagem) {
  let marcados = 0;
  for (const it of itens) {
    const { rows } = await c.query(
      'SELECT id, qtd_desejada, qtd_presenteada FROM lista_presentes_itens WHERE lista_id = $1 AND variacao_id = $2 FOR UPDATE', [listaId, it.variacaoId]);
    if (!rows.length) continue;
    const q = Math.min(it.qtd, rows[0].qtd_desejada - rows[0].qtd_presenteada);
    if (q <= 0) continue;
    await c.query('UPDATE lista_presentes_itens SET qtd_presenteada = qtd_presenteada + $1 WHERE id = $2', [q, rows[0].id]);
    await c.query('INSERT INTO lista_presentes_dados (id, lista_item_id, qtd, de_quem, mensagem, venda_id, pedido_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [uid(), rows[0].id, q, deQuem || null, mensagem || null, ref.vendaId || null, ref.pedidoId || null]);
    marcados += q;
  }
  return marcados;
}
// Venda/pedido cancelado: o presente volta a "faltar" na lista.
async function desfazerPresentes(c, ref) {
  const { rows } = await c.query(`DELETE FROM lista_presentes_dados WHERE ${ref.vendaId ? 'venda_id' : 'pedido_id'} = $1 RETURNING lista_item_id, qtd`, [ref.vendaId || ref.pedidoId]);
  for (const r of rows) await c.query('UPDATE lista_presentes_itens SET qtd_presenteada = GREATEST(qtd_presenteada - $1, 0) WHERE id = $2', [r.qtd, r.lista_item_id]);
}
async function detalheLista(db, where, params, tz) {
  const { rows } = await db.query(
    `SELECT l.*, to_char(l.data_evento, 'YYYY-MM-DD') AS data_evento, cl.nome AS cliente_nome, cl.telefone AS cliente_telefone
     FROM listas_presentes l JOIN clientes cl ON cl.id = l.cliente_id WHERE ${where}`, params);
  if (!rows.length) return null;
  const l = rows[0];
  const { rows: itens } = await db.query(
    `SELECT li.id, li.variacao_id, li.qtd_desejada, li.qtd_presenteada, p.id AS produto_id, p.nome, p.categoria, v.tamanho, v.cor, v.preco_venda::float AS preco_venda,
            GREATEST(v.estoque, 0)::int AS estoque, (v.ativo AND p.ativo AND p.publicado AND v.preco_venda > 0) AS no_site,
            (SELECT f.id FROM produto_fotos f WHERE f.produto_id = p.id ORDER BY f.ordem, f.criado_em LIMIT 1) AS foto
     FROM lista_presentes_itens li JOIN produto_variacoes v ON v.id = li.variacao_id JOIN produtos p ON p.id = v.produto_id
     WHERE li.lista_id = $1 ORDER BY (li.qtd_presenteada >= li.qtd_desejada), p.nome, v.tamanho`, [l.id]);
  const promos = await promocoes.ativas(db, l.loja_id, tz);
  const { rows: dados } = await db.query(
    `SELECT d.qtd, d.de_quem, d.mensagem, d.criado_em, d.venda_id, d.pedido_id, p.nome, v.tamanho FROM lista_presentes_dados d
     JOIN lista_presentes_itens li ON li.id = d.lista_item_id JOIN produto_variacoes v ON v.id = li.variacao_id JOIN produtos p ON p.id = v.produto_id
     WHERE li.lista_id = $1 ORDER BY d.criado_em DESC`, [l.id]);
  return { ...l, itens: itens.map((i) => ({ ...i, preco: promocoes.precoComPromo(promos, i.produto_id, i.categoria, i.preco_venda).preco })), presentes: dados };
}

app.get('/api/lojas/:lojaId/listas-presentes', qualquer, rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.id, l.token, l.titulo, to_char(l.data_evento, 'YYYY-MM-DD') AS data_evento, l.ativa, cl.nome AS cliente_nome, cl.telefone AS cliente_telefone,
            COALESCE(SUM(li.qtd_desejada), 0)::int AS desejadas, COALESCE(SUM(LEAST(li.qtd_presenteada, li.qtd_desejada)), 0)::int AS presenteadas
     FROM listas_presentes l JOIN clientes cl ON cl.id = l.cliente_id LEFT JOIN lista_presentes_itens li ON li.lista_id = l.id
     WHERE l.loja_id = $1 GROUP BY l.id, cl.nome, cl.telefone ORDER BY l.ativa DESC, l.data_evento NULLS LAST, l.criado_em DESC`, [req.lojaId]);
  res.json(rows);
}));

app.get('/api/lojas/:lojaId/listas-presentes/:id', qualquer, rota(async (req, res) => {
  const l = await detalheLista(pool, 'l.id = $1 AND l.loja_id = $2', [req.params.id, req.lojaId], TZ);
  if (!l) falha(404, 'lista não encontrada');
  res.json(l);
}));

function lerItensLista(itens) {
  if (!Array.isArray(itens) || itens.length > 200) falha(400, 'itens inválidos');
  const por = new Map();
  for (const it of itens) {
    if (!it || typeof it.variacaoId !== 'string') falha(400, 'peça inválida');
    por.set(it.variacaoId, numero(it.qtd, 'quantidade', { minExclusivo: true, inteiro: true, max: 50 }));
  }
  return por;
}
// Corpo: { clienteId, titulo, dataEvento?, mensagem?, itens: [{variacaoId, qtd}] }
app.post('/api/lojas/:lojaId/listas-presentes', qualquer, rota(async (req, res) => {
  const body = req.body || {};
  const titulo = texto(body.titulo, 'título', { max: 80 });
  const itens = lerItensLista(body.itens || []);
  const r = await transacao(async (c) => {
    const { rows: cli } = await c.query('SELECT id FROM clientes WHERE id = $1 AND loja_id = $2', [body.clienteId, req.lojaId]);
    if (!cli.length) falha(400, 'Escolha a cliente (a dona da lista)');
    const id = uid(), token = crypto.randomBytes(9).toString('base64url');
    await c.query('INSERT INTO listas_presentes (id, loja_id, token, cliente_id, titulo, data_evento, mensagem, criado_por) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, req.lojaId, token, cli[0].id, titulo, body.dataEvento ? dataISO(body.dataEvento, 'data do evento') : null,
        texto(body.mensagem, 'mensagem', { obrigatorio: false, max: 400 }), req.usuario.id]);
    for (const [variacaoId, qtd] of itens) {
      const { rowCount } = await c.query('SELECT 1 FROM produto_variacoes WHERE id = $1 AND loja_id = $2', [variacaoId, req.lojaId]);
      if (!rowCount) falha(404, 'peça não encontrada');
      await c.query('INSERT INTO lista_presentes_itens (id, lista_id, variacao_id, qtd_desejada) VALUES ($1,$2,$3,$4)', [uid(), id, variacaoId, qtd]);
    }
    return { id, token };
  });
  res.status(201).json(r);
}));

// Atualiza dados e itens (quantidade 0 tira o item, se ninguém deu ainda). Corpo: { titulo?, dataEvento?, mensagem?, ativa?, itens? }
app.put('/api/lojas/:lojaId/listas-presentes/:id', qualquer, rota(async (req, res) => {
  const body = req.body || {};
  await transacao(async (c) => {
    const { rows } = await c.query('SELECT id FROM listas_presentes WHERE id = $1 AND loja_id = $2 FOR UPDATE', [req.params.id, req.lojaId]);
    if (!rows.length) falha(404, 'lista não encontrada');
    await c.query(`UPDATE listas_presentes SET titulo = COALESCE($1, titulo), data_evento = CASE WHEN $2::boolean THEN $3::date ELSE data_evento END,
        mensagem = COALESCE($4, mensagem), ativa = COALESCE($5, ativa) WHERE id = $6`,
      [body.titulo != null ? texto(body.titulo, 'título', { max: 80 }) : null, body.dataEvento !== undefined,
        body.dataEvento ? dataISO(body.dataEvento, 'data do evento') : null,
        body.mensagem != null ? (texto(body.mensagem, 'mensagem', { obrigatorio: false, max: 400 }) || '') : null,
        typeof body.ativa === 'boolean' ? body.ativa : null, req.params.id]);
    if (Array.isArray(body.itens)) {
      const por = new Map();
      for (const it of body.itens) {
        if (!it || typeof it.variacaoId !== 'string') falha(400, 'peça inválida');
        por.set(it.variacaoId, numero(it.qtd, 'quantidade', { inteiro: true, max: 50 }));
      }
      for (const [variacaoId, qtd] of por) {
        const { rows: ex } = await c.query('SELECT id, qtd_presenteada FROM lista_presentes_itens WHERE lista_id = $1 AND variacao_id = $2', [req.params.id, variacaoId]);
        if (ex.length) {
          if (qtd === 0 && ex[0].qtd_presenteada > 0) falha(409, 'Esse item já foi presenteado — não dá pra tirar da lista');
          if (qtd === 0) await c.query('DELETE FROM lista_presentes_itens WHERE id = $1', [ex[0].id]);
          else await c.query('UPDATE lista_presentes_itens SET qtd_desejada = GREATEST($1, qtd_presenteada) WHERE id = $2', [qtd, ex[0].id]);
        } else if (qtd > 0) {
          const { rowCount } = await c.query('SELECT 1 FROM produto_variacoes WHERE id = $1 AND loja_id = $2', [variacaoId, req.lojaId]);
          if (!rowCount) falha(404, 'peça não encontrada');
          await c.query('INSERT INTO lista_presentes_itens (id, lista_id, variacao_id, qtd_desejada) VALUES ($1,$2,$3,$4)', [uid(), req.params.id, variacaoId, qtd]);
        }
      }
    }
  });
  res.json({ ok: true });
}));

// Página pública da lista (o link que a mãe manda). Sem telefone nem sobrenome.
app.get('/api/lojas/:lojaId/loja/listas/:token', rota(async (req, res) => {
  const l = await detalheLista(pool, 'l.token = $1 AND l.loja_id = $2', [req.params.token, req.lojaId], TZ);
  if (!l) falha(404, 'Lista não encontrada — confira o link');
  res.set('Cache-Control', 'no-store');
  res.json({
    titulo: l.titulo, dataEvento: l.data_evento, mensagem: l.mensagem || '', ativa: l.ativa, dona: String(l.cliente_nome || '').split(' ')[0],
    itens: l.itens.map((i) => ({ variacaoId: i.variacao_id, produtoId: i.produto_id, nome: i.nome, tamanho: i.tamanho, cor: i.cor, preco: i.preco, foto: i.foto,
      desejada: i.qtd_desejada, presenteada: Math.min(i.qtd_presenteada, i.qtd_desejada), noSite: i.no_site && i.estoque > 0 })),
    deQuem: [...new Set(l.presentes.map((p) => p.de_quem).filter(Boolean))],
  });
}));

/* ---------- Crediário (parcelas a receber) ---------- */

const SQL_CRED = `SELECT cp.id, cp.venda_id, cp.cliente_id, cl.nome AS cliente_nome, cl.telefone AS cliente_telefone, cp.parcela, cp.parcelas,
    cp.valor::float AS valor, to_char(cp.vencimento, 'YYYY-MM-DD') AS vencimento, cp.pago_em, cp.valor_pago::float AS valor_pago, cp.forma_recebimento,
    v.criado_em AS venda_em
  FROM crediario_parcelas cp JOIN clientes cl ON cl.id = cp.cliente_id JOIN vendas v ON v.id = cp.venda_id`;

// ?status=abertas (padrão) | recebidas (do mês ?mes=AAAA-MM)
app.get('/api/lojas/:lojaId/crediario', qualquer, rota(async (req, res) => {
  if (req.query.status === 'recebidas') {
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || '')) ? req.query.mes : hojeLoja().slice(0, 7);
    const { rows } = await pool.query(SQL_CRED + ` WHERE cp.loja_id = $1 AND cp.pago_em IS NOT NULL
      AND (cp.pago_em AT TIME ZONE $3)::date >= ($2 || '-01')::date AND (cp.pago_em AT TIME ZONE $3)::date < ($2 || '-01')::date + interval '1 month'
      ORDER BY cp.pago_em DESC`, [req.lojaId, mes, TZ]);
    return res.json({ parcelas: rows });
  }
  const { rows } = await pool.query(SQL_CRED + ' WHERE cp.loja_id = $1 AND cp.pago_em IS NULL ORDER BY cp.vencimento, cl.nome, cp.parcela', [req.lojaId]);
  res.json({ parcelas: rows, hoje: hojeLoja() });
}));

app.get('/api/lojas/:lojaId/crediario/resumo', qualquer, rota(async (req, res) => {
  const hoje = hojeLoja();
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE vencimento < $2::date)::int AS atrasadas, COALESCE(SUM(valor) FILTER (WHERE vencimento < $2::date), 0)::float AS valor_atrasado,
            count(*) FILTER (WHERE vencimento = $2::date)::int AS hoje, COALESCE(SUM(valor) FILTER (WHERE vencimento = $2::date), 0)::float AS valor_hoje,
            COALESCE(SUM(valor), 0)::float AS a_receber, count(DISTINCT cliente_id)::int AS clientes
     FROM crediario_parcelas WHERE loja_id = $1 AND pago_em IS NULL`, [req.lojaId, hoje]);
  res.json(rows[0]);
}));

// Receber uma parcela: entra no caixa aberto. Corpo: { forma, valor? (com juros/desconto) }
app.post('/api/lojas/:lojaId/crediario/:id/receber', qualquer, rota(async (req, res) => {
  const body = req.body || {};
  if (!FORMAS_RECEBIMENTO.includes(body.forma)) falha(400, 'Forma de recebimento inválida');
  const r = await transacao(async (c) => {
    const sessao = await sessaoAberta(c, req.lojaId, 'SHARE');
    if (!sessao) falha(409, 'Caixa fechado — abra o caixa pra receber', { codigo: 'caixa_fechado' });
    const { rows } = await c.query('SELECT * FROM crediario_parcelas WHERE id = $1 AND loja_id = $2 FOR UPDATE', [req.params.id, req.lojaId]);
    const p = rows[0];
    if (!p) falha(404, 'parcela não encontrada');
    if (p.pago_em) falha(409, 'Essa parcela já foi recebida');
    const valor = body.valor != null && body.valor !== '' ? numero(body.valor, 'valor recebido', { minExclusivo: true, max: 1e6 }) : Number(p.valor);
    await c.query('UPDATE crediario_parcelas SET pago_em = now(), valor_pago = $1, forma_recebimento = $2, caixa_sessao_id = $3, recebido_por = $4 WHERE id = $5',
      [valor, body.forma, sessao.id, req.usuario.id, p.id]);
    const { rows: rest } = await c.query('SELECT COALESCE(SUM(valor), 0)::float AS devendo FROM crediario_parcelas WHERE cliente_id = $1 AND pago_em IS NULL', [p.cliente_id]);
    return { ok: true, valor, devendo: rest[0].devendo };
  });
  res.json(r);
}));

// Desfazer recebimento (Administrador), só enquanto o caixa em que entrou estiver aberto.
app.post('/api/lojas/:lojaId/crediario/:id/desfazer', admin, rota(async (req, res) => {
  await transacao(async (c) => {
    const { rows } = await c.query('SELECT * FROM crediario_parcelas WHERE id = $1 AND loja_id = $2 FOR UPDATE', [req.params.id, req.lojaId]);
    if (!rows.length) falha(404, 'parcela não encontrada');
    if (!rows[0].pago_em) falha(409, 'Essa parcela não está recebida');
    const sessao = await sessaoAberta(c, req.lojaId, 'SHARE');
    if (!sessao || sessao.id !== rows[0].caixa_sessao_id) falha(409, 'O caixa em que essa parcela entrou já foi fechado — não dá pra desfazer');
    await c.query('UPDATE crediario_parcelas SET pago_em = NULL, valor_pago = NULL, forma_recebimento = NULL, caixa_sessao_id = NULL, recebido_por = NULL WHERE id = $1', [rows[0].id]);
  });
  res.json({ ok: true });
}));

/* ---------- Condicional (cliente leva pra provar em casa) ---------- */

const SQL_COND = `SELECT c.id, c.numero, c.cliente_id, cl.nome AS cliente_nome, cl.telefone AS cliente_telefone, c.status,
    to_char(c.prazo, 'YYYY-MM-DD') AS prazo, c.observacao, c.venda_id, c.criado_em, c.fechado_em, u.nome AS criado_por_nome
  FROM condicionais c JOIN clientes cl ON cl.id = c.cliente_id LEFT JOIN usuarios u ON u.id = c.criado_por`;
async function itensCondicionais(db, ids) {
  if (!ids.length) return {};
  const { rows } = await db.query(
    `SELECT ci.condicional_id, ci.variacao_id, ci.produto_nome, ci.tamanho, ci.cor, ci.qtd, ci.preco_unit::float AS preco_unit, ci.qtd_comprada, v.codigo_barras
     FROM condicional_itens ci LEFT JOIN produto_variacoes v ON v.id = ci.variacao_id WHERE ci.condicional_id = ANY($1) ORDER BY ci.produto_nome, ci.tamanho`, [ids]);
  const por = {};
  rows.forEach((r) => { (por[r.condicional_id] = por[r.condicional_id] || []).push(r); });
  return por;
}
async function comItens(db, lista) {
  const itens = await itensCondicionais(db, lista.map((c) => c.id));
  const hoje = promocoes.hojeNaLoja(TZ);
  return lista.map((c) => {
    const its = itens[c.id] || [];
    return { ...c, itens: its, pecas: its.reduce((t, i) => t + i.qtd, 0), valor: round2(its.reduce((t, i) => t + i.qtd * i.preco_unit, 0)),
      atrasado: c.status === 'aberto' && c.prazo < hoje };
  });
}
// Devolve todas as peças do condicional pro estoque (no fechamento, com ou sem compra).
async function devolverCondicional(c, cond, usuarioId, lojaId) {
  const { rows: itens } = await c.query('SELECT variacao_id, SUM(qtd)::int AS qtd FROM condicional_itens WHERE condicional_id = $1 GROUP BY variacao_id ORDER BY variacao_id', [cond.id]);
  for (const it of itens) {
    const { rows } = await c.query('SELECT custo_unitario FROM produto_variacoes WHERE id = $1 FOR UPDATE', [it.variacao_id]);
    if (!rows.length) continue;
    const custo = Number(rows[0].custo_unitario);
    await c.query('UPDATE produto_variacoes SET estoque = estoque + $1 WHERE id = $2', [it.qtd, it.variacao_id]);
    await c.query(
      `INSERT INTO movimentos_estoque_produto (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, referencia_id, observacao, criado_por)
       VALUES ($1,$2,$3,'ajuste',$4,$5,$6,'condicional',$7,$8,$9)`,
      [uid(), lojaId, it.variacao_id, it.qtd, custo, round2(it.qtd * custo), cond.id, 'Voltou do condicional nº ' + cond.numero, usuarioId]);
  }
  return itens;
}

app.get('/api/lojas/:lojaId/condicionais', qualquer, rota(async (req, res) => {
  const abertos = req.query.status !== 'fechados';
  const { rows } = await pool.query(SQL_COND + (abertos ? " WHERE c.loja_id = $1 AND c.status = 'aberto' ORDER BY c.prazo, c.numero"
    : " WHERE c.loja_id = $1 AND c.status = 'fechado' ORDER BY c.fechado_em DESC LIMIT 50"), [req.lojaId]);
  res.json(await comItens(pool, rows));
}));

app.get('/api/lojas/:lojaId/condicionais/resumo', qualquer, rota(async (req, res) => {
  const hoje = promocoes.hojeNaLoja(TZ);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS abertos, count(*) FILTER (WHERE prazo < $2::date)::int AS atrasados, count(*) FILTER (WHERE prazo = $2::date)::int AS vencem_hoje
     FROM condicionais WHERE loja_id = $1 AND status = 'aberto'`, [req.lojaId, hoje]);
  res.json(rows[0]);
}));

app.get('/api/lojas/:lojaId/condicionais/:id', qualquer, rota(async (req, res) => {
  const { rows } = await pool.query(SQL_COND + ' WHERE c.id = $1 AND c.loja_id = $2', [req.params.id, req.lojaId]);
  if (!rows.length) falha(404, 'condicional não encontrado');
  res.json((await comItens(pool, rows))[0]);
}));

// Corpo: { clienteId, prazo, itens: [{variacaoId, qtd}], observacao? }
app.post('/api/lojas/:lojaId/condicionais', qualquer, rota(async (req, res) => {
  const body = req.body || {};
  const prazo = dataISO(body.prazo, 'prazo de devolução');
  if (prazo < promocoes.hojeNaLoja(TZ)) falha(400, 'O prazo de devolução já passou');
  if (!Array.isArray(body.itens) || !body.itens.length || body.itens.length > 100) falha(400, 'Coloque as peças no carrinho');
  const porVar = new Map();
  for (const it of body.itens) {
    if (!it || typeof it.variacaoId !== 'string') falha(400, 'peça inválida');
    porVar.set(it.variacaoId, (porVar.get(it.variacaoId) || 0) + numero(it.qtd, 'qtd', { minExclusivo: true, inteiro: true, max: 100 }));
  }
  const r = await transacao(async (c) => {
    const { rows: cli } = await c.query('SELECT id, nome FROM clientes WHERE id = $1 AND loja_id = $2', [body.clienteId, req.lojaId]);
    if (!cli.length) falha(400, 'Escolha a cliente — o condicional fica no nome dela', { codigo: 'cliente_obrigatorio' });
    await c.query('SELECT pg_advisory_xact_lock($1)', [910000 + req.lojaId]); // numeração sem repetir
    const { rows: n } = await c.query('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM condicionais WHERE loja_id = $1', [req.lojaId]);
    const id = uid(), numeroCond = n[0].n;
    await c.query('INSERT INTO condicionais (id, loja_id, numero, cliente_id, prazo, observacao, criado_por) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, req.lojaId, numeroCond, cli[0].id, prazo, texto(body.observacao, 'observação', { obrigatorio: false, max: 300 }), req.usuario.id]);
    const promos = await promocoes.ativas(c, req.lojaId, TZ);
    for (const [variacaoId, qtd] of [...porVar].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const { rows } = await c.query(
        `SELECT v.id, v.tamanho, v.cor, v.estoque, v.preco_venda, v.custo_unitario, v.ativo, p.nome, p.id AS produto_id, p.categoria
         FROM produto_variacoes v JOIN produtos p ON p.id = v.produto_id WHERE v.id = $1 AND v.loja_id = $2 FOR UPDATE OF v`, [variacaoId, req.lojaId]);
      const v = rows[0];
      if (!v || !v.ativo) falha(404, 'Peça não encontrada ou inativa');
      if (Number(v.estoque) < qtd) falha(409, 'Estoque insuficiente: ' + v.nome + ' ' + v.tamanho + (v.cor ? ' ' + v.cor : ''), { codigo: 'estoque_insuficiente', variacaoId: v.id, disponivel: Number(v.estoque) });
      const preco = promocoes.precoComPromo(promos, v.produto_id, v.categoria, v.preco_venda).preco;
      await c.query('INSERT INTO condicional_itens (id, condicional_id, variacao_id, produto_nome, tamanho, cor, qtd, preco_unit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [uid(), id, v.id, v.nome, v.tamanho, v.cor, qtd, preco]);
      await c.query('UPDATE produto_variacoes SET estoque = estoque - $1 WHERE id = $2', [qtd, v.id]);
      const custo = Number(v.custo_unitario);
      await c.query(
        `INSERT INTO movimentos_estoque_produto (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, referencia_id, observacao, criado_por)
         VALUES ($1,$2,$3,'ajuste',$4,$5,$6,'condicional',$7,$8,$9)`,
        [uid(), req.lojaId, v.id, -qtd, custo, round2(-qtd * custo), id, 'Saiu no condicional nº ' + numeroCond + ' (' + cli[0].nome + ')', req.usuario.id]);
    }
    // Limite: tudo que ela tem em casa em condicional aberto (incluindo este) não passa do limite
    // dela (ou o padrão da loja). Passou: só com o PIN de um Administrador. 0 = sem limite.
    const { rows: lim } = await c.query(
      `SELECT COALESCE(cl.limite_condicional, l.condicional_limite_padrao)::float AS limite,
              (SELECT COALESCE(SUM(ci.qtd * ci.preco_unit), 0) FROM condicional_itens ci JOIN condicionais cd ON cd.id = ci.condicional_id
               WHERE cd.cliente_id = cl.id AND cd.status = 'aberto')::float AS em_casa
       FROM clientes cl JOIN lojas l ON l.id = cl.loja_id WHERE cl.id = $1`, [cli[0].id]);
    const { limite, em_casa: emCasa } = lim[0];
    if (limite > 0 && emCasa > limite + 0.005 && req.usuario.papel !== 'administrador') {
      const ap = body.aprovacao || {};
      const motivo = 'Com esse condicional, ' + cli[0].nome.split(' ')[0] + ' fica com R$ ' + emCasa.toFixed(2).replace('.', ',') + ' em peças em casa — o limite é R$ ' + limite.toFixed(2).replace('.', ',') + '. Precisa do PIN de um Administrador';
      if (typeof ap.usuarioId !== 'string' || typeof ap.pin !== 'string') falha(403, motivo, { codigo: 'aprovacao_necessaria' });
      const { rows: adm } = await c.query("SELECT id, nome, pin_hash FROM usuarios WHERE id = $1 AND loja_id = $2 AND ativo AND papel = 'administrador'", [ap.usuarioId, req.lojaId]);
      if (!adm.length || !conferirPin(req, adm[0], ap.pin)) falha(403, 'PIN de Administrador incorreto', { codigo: 'aprovacao_invalida' });
      await c.query("UPDATE condicionais SET observacao = trim(COALESCE(observacao, '') || ' · Acima do limite, autorizado por ' || $1) WHERE id = $2", [adm[0].nome, id]);
    }
    const { rows } = await c.query(SQL_COND + ' WHERE c.id = $1', [id]);
    return (await comItens(c, rows))[0];
  });
  res.status(201).json(r);
}));

app.put('/api/lojas/:lojaId/condicionais/:id', qualquer, rota(async (req, res) => {
  const body = req.body || {};
  const { rowCount } = await pool.query(
    "UPDATE condicionais SET prazo = COALESCE($1, prazo), observacao = COALESCE($2, observacao) WHERE id = $3 AND loja_id = $4 AND status = 'aberto'",
    [body.prazo ? dataISO(body.prazo, 'prazo') : null, body.observacao != null ? (texto(body.observacao, 'observação', { obrigatorio: false, max: 300 }) || '') : null, req.params.id, req.lojaId]);
  if (!rowCount) falha(409, 'Condicional não encontrado ou já fechado');
  res.json({ ok: true });
}));

// Devolveu tudo (não ficou com nada): peças voltam pro estoque e o condicional fecha.
app.post('/api/lojas/:lojaId/condicionais/:id/devolver-tudo', qualquer, rota(async (req, res) => {
  await transacao(async (c) => {
    const { rows } = await c.query("SELECT * FROM condicionais WHERE id = $1 AND loja_id = $2 FOR UPDATE", [req.params.id, req.lojaId]);
    if (!rows.length) falha(404, 'condicional não encontrado');
    if (rows[0].status !== 'aberto') falha(409, 'Esse condicional já foi fechado');
    await devolverCondicional(c, rows[0], req.usuario.id, req.lojaId);
    await c.query("UPDATE condicionais SET status = 'fechado', fechado_por = $1, fechado_em = now() WHERE id = $2", [req.usuario.id, rows[0].id]);
  });
  res.json({ ok: true });
}));

/* ---------- Contagem de estoque (inventário com o bipador) ---------- */

// Variações que entram na contagem (só peças ativas de produtos ativos).
function filtroEscopo(ct) {
  if (ct.escopo === 'categoria') return { sql: "AND COALESCE(NULLIF(p.categoria, ''), 'Sem categoria') = $2", params: [ct.categoria] };
  if (ct.escopo === 'produto') return { sql: 'AND p.id = $2', params: [ct.produto_id] };
  return { sql: '', params: [] };
}
async function itensDaContagem(db, ct) {
  const f = filtroEscopo(ct);
  const { rows } = await db.query(
    `SELECT v.id AS variacao_id, p.id AS produto_id, p.nome AS produto, p.categoria, v.tamanho, v.cor, v.codigo_barras,
            v.estoque::int AS sistema, v.custo_unitario::float AS custo, ci.contado, g.tamanhos AS ordem
     FROM produto_variacoes v JOIN produtos p ON p.id = v.produto_id
     LEFT JOIN grades_tamanho g ON g.id = p.grade_tamanho_id
     LEFT JOIN contagem_itens ci ON ci.variacao_id = v.id AND ci.contagem_id = $${f.params.length + 2}
     WHERE v.loja_id = $1 AND v.ativo AND p.ativo ${f.sql}
     ORDER BY p.nome, v.cor`, [ct.loja_id, ...f.params, ct.id]);
  return rows.map(({ ordem, ...r }) => ({ ...r, ordemTamanho: ordem ? ordem.indexOf(r.tamanho) : -1 }))
    .sort((a, b) => a.produto.localeCompare(b.produto) || (a.ordemTamanho - b.ordemTamanho) || a.tamanho.localeCompare(b.tamanho) || a.cor.localeCompare(b.cor));
}
async function contagemAberta(db, lojaId, trava) {
  const { rows } = await db.query(`SELECT * FROM contagens WHERE loja_id = $1 AND status = 'aberta'${trava ? ' FOR UPDATE' : ''}`, [lojaId]);
  return rows[0] || null;
}
function descreverEscopo(ct, nomeProduto) {
  return ct.escopo === 'tudo' ? 'Loja inteira' : ct.escopo === 'categoria' ? 'Categoria ' + ct.categoria : 'Produto ' + (nomeProduto || '');
}

app.get('/api/lojas/:lojaId/contagens/aberta', qualquer, rota(async (req, res) => {
  const ct = await contagemAberta(pool, req.lojaId);
  if (!ct) return res.json({ contagem: null });
  const itens = await itensDaContagem(pool, ct);
  const { rows: v } = await pool.query('SELECT count(*)::int AS n FROM vendas WHERE loja_id = $1 AND NOT cancelada AND criado_em > $2', [req.lojaId, ct.criado_em]);
  const nomeProd = ct.produto_id ? (itens[0] && itens[0].produto) : null;
  res.json({ contagem: { ...ct, descricao: descreverEscopo(ct, nomeProd) }, itens, vendasDesdeInicio: v[0].n });
}));

app.get('/api/lojas/:lojaId/contagens', admin, rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.escopo, c.categoria, c.status, c.resumo, c.criado_em, c.concluida_em, p.nome AS produto_nome, u.nome AS concluida_por_nome
     FROM contagens c LEFT JOIN produtos p ON p.id = c.produto_id LEFT JOIN usuarios u ON u.id = c.concluida_por
     WHERE c.loja_id = $1 AND c.status <> 'aberta' ORDER BY c.criado_em DESC LIMIT 20`, [req.lojaId]);
  res.json(rows.map((c) => ({ ...c, descricao: descreverEscopo(c, c.produto_nome) })));
}));

// Corpo: { escopo: 'tudo'|'categoria'|'produto', categoria?, produtoId? }
app.post('/api/lojas/:lojaId/contagens', admin, rota(async (req, res) => {
  const body = req.body || {};
  if (!['tudo', 'categoria', 'produto'].includes(body.escopo)) falha(400, 'Escolha o que vai ser contado');
  const categoria = body.escopo === 'categoria' ? texto(body.categoria, 'categoria', { max: 60 }) : null;
  let produtoId = null;
  if (body.escopo === 'produto') {
    const { rows } = await pool.query('SELECT id FROM produtos WHERE id = $1 AND loja_id = $2', [body.produtoId, req.lojaId]);
    if (!rows.length) falha(404, 'produto não encontrado');
    produtoId = rows[0].id;
  }
  const id = uid();
  try {
    await pool.query('INSERT INTO contagens (id, loja_id, escopo, categoria, produto_id, criado_por) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, req.lojaId, body.escopo, categoria, produtoId, req.usuario.id]);
  } catch (e) {
    if (e.code === '23505') falha(409, 'Já tem uma contagem aberta — continue ou cancele ela antes', { codigo: 'contagem_aberta' });
    throw e;
  }
  res.status(201).json({ id });
}));

// Bipou uma peça: soma `qtd` (padrão 1; -1 desfaz) na variação com esse código.
app.post('/api/lojas/:lojaId/contagens/:id/bipar', qualquer, rota(async (req, res) => {
  const body = req.body || {};
  const codigo = soDigitos(body.codigo) || texto(body.codigo, 'código', { max: 60 });
  const qtd = body.qtd != null ? numero(body.qtd, 'qtd', { inteiro: true, min: -1000, max: 1000 }) : 1;
  const r = await transacao(async (c) => {
    const ct = await contagemAberta(c, req.lojaId);
    if (!ct || ct.id !== req.params.id) falha(409, 'Essa contagem não está mais aberta', { codigo: 'contagem_fechada' });
    const { rows } = await c.query(
      `SELECT v.id, p.nome, v.tamanho, v.cor, p.categoria, p.id AS produto_id, v.ativo, p.ativo AS produto_ativo FROM produto_variacoes v JOIN produtos p ON p.id = v.produto_id
       WHERE v.loja_id = $1 AND (v.codigo_barras = $2 OR v.sku = $2)`, [req.lojaId, codigo]);
    const v = rows[0];
    if (!v) falha(404, 'Código ' + codigo + ' não é de nenhuma peça cadastrada', { codigo: 'codigo_desconhecido' });
    const peca = v.nome + ' ' + v.tamanho + (v.cor ? ' ' + v.cor : '');
    if (!v.ativo || !v.produto_ativo) falha(409, peca + ' está desativada no cadastro', { codigo: 'fora_escopo' });
    const fora = (ct.escopo === 'categoria' && String(v.categoria || 'Sem categoria') !== ct.categoria) || (ct.escopo === 'produto' && v.produto_id !== ct.produto_id);
    if (fora) falha(409, peca + ' não faz parte dessa contagem (' + descreverEscopo(ct) + ')', { codigo: 'fora_escopo' });
    const { rows: it } = await c.query(
      `INSERT INTO contagem_itens (contagem_id, variacao_id, contado) VALUES ($1, $2, GREATEST($3, 0))
       ON CONFLICT (contagem_id, variacao_id) DO UPDATE SET contado = GREATEST(contagem_itens.contado + $3, 0), atualizado_em = now()
       RETURNING contado`, [ct.id, v.id, qtd]);
    return { variacaoId: v.id, peca, contado: it[0].contado };
  });
  res.json(r);
}));

// Digitou a quantidade contada (sem bipar). Corpo: { contado }
app.put('/api/lojas/:lojaId/contagens/:id/itens/:variacaoId', qualquer, rota(async (req, res) => {
  const contado = numero((req.body || {}).contado, 'quantidade contada', { inteiro: true, max: 100000 });
  await transacao(async (c) => {
    const ct = await contagemAberta(c, req.lojaId);
    if (!ct || ct.id !== req.params.id) falha(409, 'Essa contagem não está mais aberta', { codigo: 'contagem_fechada' });
    const itens = await itensDaContagem(c, ct);
    if (!itens.some((i) => i.variacao_id === req.params.variacaoId)) falha(409, 'Essa peça não faz parte dessa contagem');
    await c.query(
      `INSERT INTO contagem_itens (contagem_id, variacao_id, contado) VALUES ($1,$2,$3)
       ON CONFLICT (contagem_id, variacao_id) DO UPDATE SET contado = EXCLUDED.contado, atualizado_em = now()`, [ct.id, req.params.variacaoId, contado]);
  });
  res.json({ ok: true, contado });
}));

// Concluir: ajusta o estoque de cada peça pro que foi contado. Corpo: { zerarNaoContadas: bool }
// (peças da contagem que ninguém bipou: com true viram 0; com false ficam como estão).
app.post('/api/lojas/:lojaId/contagens/:id/concluir', admin, rota(async (req, res) => {
  const zerar = (req.body || {}).zerarNaoContadas === true;
  const r = await transacao(async (c) => {
    const ct = await contagemAberta(c, req.lojaId, true);
    if (!ct || ct.id !== req.params.id) falha(409, 'Essa contagem não está mais aberta');
    const itens = await itensDaContagem(c, ct);
    const resumo = { conferidas: 0, sobras: 0, faltas: 0, pecasSobrando: 0, pecasFaltando: 0, valorDiferenca: 0, naoContadas: 0, zeradas: 0 };
    for (const it of [...itens].sort((a, b) => (a.variacao_id < b.variacao_id ? -1 : 1))) {
      if (it.contado == null && !zerar) { resumo.naoContadas++; continue; }
      const { rows } = await c.query('SELECT estoque::int AS estoque, custo_unitario::float AS custo FROM produto_variacoes WHERE id = $1 FOR UPDATE', [it.variacao_id]);
      const contado = it.contado == null ? 0 : it.contado;
      const dif = contado - rows[0].estoque;
      resumo.conferidas++;
      if (it.contado == null) resumo.zeradas++;
      if (!dif) continue;
      if (dif > 0) { resumo.sobras++; resumo.pecasSobrando += dif; } else { resumo.faltas++; resumo.pecasFaltando -= dif; }
      resumo.valorDiferenca = round2(resumo.valorDiferenca + dif * rows[0].custo);
      await c.query('UPDATE produto_variacoes SET estoque = $1 WHERE id = $2', [contado, it.variacao_id]);
      await c.query(
        `INSERT INTO movimentos_estoque_produto (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, referencia_id, observacao, criado_por)
         VALUES ($1,$2,$3,'ajuste',$4,$5,$6,'contagem',$7,$8,$9)`,
        [uid(), req.lojaId, it.variacao_id, dif, rows[0].custo, round2(dif * rows[0].custo), ct.id, 'Contagem de estoque', req.usuario.id]);
    }
    await c.query("UPDATE contagens SET status = 'concluida', resumo = $1, concluida_por = $2, concluida_em = now() WHERE id = $3", [JSON.stringify(resumo), req.usuario.id, ct.id]);
    return resumo;
  });
  res.json({ ok: true, resumo: r });
}));

app.post('/api/lojas/:lojaId/contagens/:id/cancelar', admin, rota(async (req, res) => {
  const { rowCount } = await pool.query("UPDATE contagens SET status = 'cancelada', concluida_por = $1, concluida_em = now() WHERE id = $2 AND loja_id = $3 AND status = 'aberta'",
    [req.usuario.id, req.params.id, req.lojaId]);
  if (!rowCount) falha(409, 'Essa contagem não está mais aberta');
  res.json({ ok: true });
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
  // Parcelas de crediário recebidas nesse caixa aparecem como entradas (só as em dinheiro mexem na gaveta).
  const { rows: recebidos } = await db.query(
    `SELECT cp.id, cp.valor_pago, cp.forma_recebimento, cp.pago_em, cp.parcela, cp.parcelas, cl.nome AS cliente_nome, u.nome AS criado_por_nome
     FROM crediario_parcelas cp JOIN clientes cl ON cl.id = cp.cliente_id LEFT JOIN usuarios u ON u.id = cp.recebido_por
     WHERE cp.caixa_sessao_id = $1 AND cp.pago_em IS NOT NULL`, [sessao.id]);
  const dinheiroCrediario = round2(recebidos.filter((r) => r.forma_recebimento === 'Dinheiro').reduce((t, r) => t + Number(r.valor_pago), 0));
  movimentos.push(...recebidos.map((r) => ({ id: r.id, tipo: 'recebimento', valor: r.valor_pago, criado_em: r.pago_em, criado_por_nome: r.criado_por_nome || '',
    descricao: 'Crediário ' + r.cliente_nome + ' (' + r.parcela + '/' + r.parcelas + ') · ' + r.forma_recebimento })));
  movimentos.sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));
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
    recebimentosCrediario: round2(recebidos.reduce((t, r) => t + Number(r.valor_pago), 0)),
    dinheiroEsperado: round2(Number(sessao.dinheiro_inicial) + dinheiroVendas + dinheiroCrediario + suprimentos - sangrias),
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
  COALESCE((SELECT SUM(valor) FROM cliente_creditos cc WHERE cc.cliente_id = c.id AND cc.tipo = 'vale_troca'), 0) AS saldo_vale_troca,
  COALESCE((SELECT SUM(valor) FROM crediario_parcelas cp WHERE cp.cliente_id = c.id AND cp.pago_em IS NULL), 0)::float AS crediario_devendo,
  (SELECT count(*) FROM crediario_parcelas cp WHERE cp.cliente_id = c.id AND cp.pago_em IS NULL AND cp.vencimento < (now() AT TIME ZONE '${TZ}')::date)::int AS crediario_atrasadas`;

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
  return { telefone, cpf, nascimento, observacao: texto(body.observacao, 'observacao', { obrigatorio: false, max: 300 }),
    aceitaMensagens: typeof body.aceitaMensagens === 'boolean' ? body.aceitaMensagens : null, filhos: lerFilhos(body.filhos) };
}
// Crianças da cliente (pro parabéns no aniversário e pra saber o tamanho que usa). undefined = não mexe.
function lerFilhos(lista) {
  if (lista === undefined || lista === null) return null;
  if (!Array.isArray(lista) || lista.length > 10) falha(400, 'filhos: até 10 crianças');
  return lista.map((f) => ({
    nome: texto(f && f.nome, 'nome da criança', { max: 60 }),
    nascimento: f.nascimento ? dataISO(f.nascimento, 'nascimento da criança') : null,
    tamanho: texto(f.tamanho, 'tamanho da criança', { obrigatorio: false, max: 20 }) || null,
  }));
}
async function salvarFilhos(c, lojaId, clienteId, filhos) {
  if (!filhos) return;
  await c.query('DELETE FROM cliente_filhos WHERE cliente_id = $1 AND loja_id = $2', [clienteId, lojaId]);
  for (const f of filhos) {
    await c.query('INSERT INTO cliente_filhos (id, loja_id, cliente_id, nome, nascimento, tamanho) VALUES ($1,$2,$3,$4,$5,$6)',
      [uid(), lojaId, clienteId, f.nome, f.nascimento, f.tamanho]);
  }
}

app.post('/api/lojas/:lojaId/clientes', qualquer, rota(async (req, res) => {
  const body = req.body || {};
  const nome = texto(body.nome, 'nome', { max: 100 });
  const d = dadosCliente(body);
  const id = uid();
  try {
    await transacao(async (c) => {
      await c.query(
        'INSERT INTO clientes (id, loja_id, nome, telefone, cpf, nascimento, observacao, aceita_mensagens) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, req.lojaId, nome, d.telefone, d.cpf, d.nascimento, d.observacao, d.aceitaMensagens !== false]
      );
      await salvarFilhos(c, req.lojaId, id, d.filhos);
    });
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
    await transacao(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE clientes SET nome = $1, telefone = $2, cpf = $3, nascimento = $4, observacao = $5, aceita_mensagens = COALESCE($8, aceita_mensagens)
         WHERE id = $6 AND loja_id = $7`,
        [nome, d.telefone, d.cpf, d.nascimento, d.observacao, req.params.id, req.lojaId, d.aceitaMensagens]
      );
      if (!rowCount) falha(404, 'cliente não encontrado');
      await salvarFilhos(c, req.lojaId, req.params.id, d.filhos);
      // Quem pediu pra não receber sai também da fila de mensagens que ainda não foram.
      if (d.aceitaMensagens === false) {
        await c.query("UPDATE mensagens_clientes SET status = 'descartada' WHERE cliente_id = $1 AND status IN ('pendente', 'na_fila', 'erro')", [req.params.id]);
      }
    });
  } catch (e) {
    if (e.code === '23505') falha(409, 'Já existe cliente com esse telefone ou CPF');
    throw e;
  }
  // Limite do condicional: só o Administrador muda. Vazio = padrão da loja.
  if (body.limiteCondicional !== undefined && req.usuario.papel === 'administrador') {
    const lim = body.limiteCondicional === null || body.limiteCondicional === '' ? null : numero(body.limiteCondicional, 'limite do condicional', { max: 1e6 });
    await pool.query('UPDATE clientes SET limite_condicional = $1 WHERE id = $2 AND loja_id = $3', [lim, req.params.id, req.lojaId]);
  }
  // Limite do crediário: só o Administrador muda. Vazio = usa o limite padrão da loja.
  if (body.limiteCrediario !== undefined && req.usuario.papel === 'administrador') {
    const lim = body.limiteCrediario === null || body.limiteCrediario === '' ? null : numero(body.limiteCrediario, 'limite do crediário', { max: 1e6 });
    await pool.query('UPDATE clientes SET limite_crediario = $1 WHERE id = $2 AND loja_id = $3', [lim, req.params.id, req.lojaId]);
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
  const { rows: parcelas } = await pool.query(SQL_CRED + ' WHERE cp.cliente_id = $1 ORDER BY (cp.pago_em IS NULL) DESC, cp.vencimento LIMIT 60', [req.params.id]);
  const { rows: cfg } = await pool.query('SELECT crediario_limite_padrao, condicional_limite_padrao FROM lojas WHERE id = $1', [req.lojaId]);
  const { rows: emCasa } = await pool.query(
    `SELECT COALESCE(SUM(ci.qtd * ci.preco_unit), 0)::float AS v FROM condicional_itens ci JOIN condicionais cd ON cd.id = ci.condicional_id
     WHERE cd.cliente_id = $1 AND cd.status = 'aberto'`, [req.params.id]);
  const limite = c.limite_crediario != null ? Number(c.limite_crediario) : Number(cfg[0].crediario_limite_padrao);
  const { rows: filhos } = await pool.query(
    "SELECT id, nome, to_char(nascimento, 'YYYY-MM-DD') AS nascimento, tamanho FROM cliente_filhos WHERE cliente_id = $1 ORDER BY nascimento NULLS LAST, nome", [req.params.id]);
  const limCond = c.limite_condicional != null ? Number(c.limite_condicional) : Number(cfg[0].condicional_limite_padrao);
  c.condicional = { limite: limCond, limiteProprio: c.limite_condicional != null, emCasa: emCasa[0].v };
  res.json({ ...c, filhos, saldo_cashback: Number(c.saldo_cashback), saldo_vale_troca: Number(c.saldo_vale_troca), extrato, compras,
    crediario: { limite, limiteProprio: c.limite_crediario != null, devendo: c.crediario_devendo, disponivel: round2(Math.max(0, limite - c.crediario_devendo)), parcelas } });
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
    // Fechando um condicional: as peças dele voltam pro estoque antes (o que a cliente ficou sai
    // de novo logo abaixo, como venda normal). Tudo na mesma transação.
    let condicional = null;
    if (body.condicionalId) {
      const { rows } = await c.query('SELECT * FROM condicionais WHERE id = $1 AND loja_id = $2 FOR UPDATE', [body.condicionalId, req.lojaId]);
      if (!rows.length) falha(404, 'condicional não encontrado');
      if (rows[0].status !== 'aberto') falha(409, 'Esse condicional já foi fechado', { codigo: 'condicional_fechado' });
      condicional = rows[0];
      if (body.clienteId && body.clienteId !== condicional.cliente_id) falha(400, 'A venda do condicional tem que ser no nome da mesma cliente');
      body.clienteId = condicional.cliente_id;
      await devolverCondicional(c, condicional, req.usuario.id, req.lojaId);
    }
    const { rows: lojaRows } = await c.query('SELECT cashback_pct, desconto_livre_pct FROM lojas WHERE id = $1', [req.lojaId]);
    const cashbackPct = Number(lojaRows[0].cashback_pct);
    const descontoLivrePct = Number(lojaRows[0].desconto_livre_pct);

    let bruto = 0, descontoTotal = 0;
    const gravar = [];
    const promos = await promocoes.ativas(c, req.lojaId, TZ);
    for (const it of itens) {
      const { rows } = await c.query(
        `SELECT v.id, v.tamanho, v.cor, v.estoque, v.preco_venda, v.custo_unitario, v.ativo, p.nome AS produto_nome, p.id AS produto_id, p.categoria
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
      const pr = promocoes.precoComPromo(promos, v.produto_id, v.categoria, v.preco_venda);
      const precoUnit = pr.preco;
      const linha = round2(precoUnit * it.qtd);
      if (it.descontoItem > linha) falha(400, 'Desconto maior que o valor do item ' + v.produto_nome);
      bruto = round2(bruto + linha);
      descontoTotal = round2(descontoTotal + it.descontoItem);
      gravar.push({ ...it, precoUnit, precoCheio: pr.precoCheio, promocaoId: pr.promo ? pr.promo.id : null, custo: Number(v.custo_unitario), produtoNome: v.produto_nome, tamanho: v.tamanho, cor: v.cor });
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
      const { rows } = await c.query("SELECT id, nome, pin_hash FROM usuarios WHERE id = $1 AND loja_id = $2 AND ativo AND papel = 'administrador'", [ap.usuarioId, req.lojaId]);
      if (!rows.length || !conferirPin(req, rows[0], ap.pin)) falha(403, 'PIN de Administrador incorreto', { codigo: 'aprovacao_invalida' });
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
    // Crediário: parcelas no nome da cliente, dentro do limite dela (acima, só com PIN de Administrador).
    let parcelasCrediario = null;
    if (pagPorForma.has('Crediário')) {
      if (!clienteId) falha(400, 'Crediário só com a cliente identificada', { codigo: 'cliente_obrigatorio' });
      const valorCred = pagPorForma.get('Crediário');
      const cr = body.crediario || {};
      const { rows: cfgCred } = await c.query('SELECT crediario_limite_padrao, crediario_max_parcelas FROM lojas WHERE id = $1', [req.lojaId]);
      const n = numero(cr.parcelas, 'número de parcelas', { min: 1, max: cfgCred[0].crediario_max_parcelas, inteiro: true });
      const primeiro = dataISO(cr.primeiroVencimento, '1º vencimento');
      if (primeiro < hojeLoja()) falha(400, 'O 1º vencimento já passou');
      const { rows: lim } = await c.query(
        `SELECT c.nome, c.limite_crediario, COALESCE((SELECT SUM(valor) FROM crediario_parcelas cp WHERE cp.cliente_id = c.id AND cp.pago_em IS NULL), 0) AS devendo
         FROM clientes c WHERE c.id = $1`, [clienteId]);
      const limite = lim[0].limite_crediario != null ? Number(lim[0].limite_crediario) : Number(cfgCred[0].crediario_limite_padrao);
      const disponivel = round2(limite - Number(lim[0].devendo));
      if (valorCred > disponivel + 0.005 && req.usuario.papel !== 'administrador' && !aprovadoPor) {
        const ap = body.aprovacao || {};
        const msg = 'Crediário de R$ ' + valorCred.toFixed(2) + ' passa do limite disponível de ' + lim[0].nome + ' (R$ ' + Math.max(0, disponivel).toFixed(2) + ') — precisa do PIN de um Administrador';
        if (typeof ap.usuarioId !== 'string' || typeof ap.pin !== 'string') falha(403, msg, { codigo: 'aprovacao_necessaria' });
        const { rows } = await c.query("SELECT id, nome, pin_hash FROM usuarios WHERE id = $1 AND loja_id = $2 AND ativo AND papel = 'administrador'", [ap.usuarioId, req.lojaId]);
        if (!rows.length || !conferirPin(req, rows[0], ap.pin)) falha(403, 'PIN de Administrador incorreto', { codigo: 'aprovacao_invalida' });
        aprovadoPor = rows[0].id;
      }
      const base = Math.floor((valorCred / n) * 100) / 100;
      parcelasCrediario = Array.from({ length: n }, (_, i) => ({ parcela: i + 1, parcelas: n, vencimento: somaMesesISO(primeiro, i),
        valor: i === n - 1 ? round2(valorCred - base * (n - 1)) : base }));
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
    const { rows: [{ codigo_troca: codigoTroca }] } = await c.query(
      `INSERT INTO vendas (id, loja_id, usuario_id, canal, subtotal, desconto, total, forma_pagamento, caixa_sessao_id, cliente_id, aprovado_por, troco)
       VALUES ($1,$2,$3,'loja',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING codigo_troca`,
      [vendaId, req.lojaId, req.usuario.id, bruto, descontoTotal, total, formasLabel, sessao.id, clienteId, aprovadoPor, troco]
    );
    for (const it of gravar) {
      await c.query('UPDATE produto_variacoes SET estoque = estoque - $1 WHERE id = $2', [it.qtd, it.variacaoId]);
      await c.query(
        `INSERT INTO vendas_itens (id, venda_id, variacao_id, produto_nome, tamanho, cor, qtd, preco_unit, desconto_item, preco_cheio, promocao_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [uid(), vendaId, it.variacaoId, it.produtoNome, it.tamanho, it.cor, it.qtd, it.precoUnit, it.descontoItem, it.precoCheio, it.promocaoId]
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

    if (body.listaId) {
      const { rows: ls } = await c.query('SELECT id FROM listas_presentes WHERE id = $1 AND loja_id = $2 AND ativa', [body.listaId, req.lojaId]);
      if (!ls.length) falha(404, 'Lista de presentes não encontrada ou encerrada');
      await registrarPresentes(c, ls[0].id, gravar.map((it) => ({ variacaoId: it.variacaoId, qtd: it.qtd })), { vendaId },
        texto(body.presenteDeQuem, 'nome de quem deu o presente', { obrigatorio: false, max: 80 }), null);
    }
    if (parcelasCrediario) {
      for (const p of parcelasCrediario) {
        await c.query('INSERT INTO crediario_parcelas (id, loja_id, venda_id, cliente_id, parcela, parcelas, valor, vencimento) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [uid(), req.lojaId, vendaId, clienteId, p.parcela, p.parcelas, p.valor, p.vencimento]);
      }
    }
    if (condicional) {
      for (const it of gravar) {
        await c.query('UPDATE condicional_itens SET qtd_comprada = LEAST(qtd, $1) WHERE condicional_id = $2 AND variacao_id = $3', [it.qtd, condicional.id, it.variacaoId]);
      }
      await c.query("UPDATE condicionais SET status = 'fechado', venda_id = $1, fechado_por = $2, fechado_em = now() WHERE id = $3", [vendaId, req.usuario.id, condicional.id]);
    }

    // Cashback: só sobre o que foi pago com dinheiro "de verdade" (não gera cashback de
    // cashback/vale-troca), creditado uma única vez — índice único garante no banco.
    let cashbackGerado = 0;
    if (clienteId && cashbackPct > 0) {
      // Crediário não gera cashback na venda (o dinheiro ainda não entrou).
      cashbackGerado = round2(Math.max(0, total - usadoCredito - (pagPorForma.get('Crediário') || 0)) * cashbackPct / 100);
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
      id: vendaId, codigoTroca, subtotal: bruto, desconto: descontoTotal, total, troco, criadoEm: new Date().toISOString(),
      pagamentos: [...pagPorForma].map(([forma, valor]) => ({ forma, valor })),
      cashbackGerado, clienteId, crediario: parcelasCrediario,
      saldosCliente: clienteId ? await saldosCliente(c, clienteId) : null,
      itens: gravar.map((it) => ({ variacaoId: it.variacaoId, produtoNome: it.produtoNome, tamanho: it.tamanho, cor: it.cor, qtd: it.qtd, precoUnit: it.precoUnit, precoCheio: it.precoCheio, descontoItem: it.descontoItem })),
    };
  });
  res.status(201).json(venda);
}));

// Lista de vendas. ?periodo=hoje filtra pelo dia na hora local da loja; ?de=AAAA-MM-DD&ate=AAAA-MM-DD
// pega um intervalo de dias (aba Vendas). Sem nada: as 200 últimas.
app.get('/api/lojas/:lojaId/vendas', qualquer, rota(async (req, res) => {
  const hoje = req.query.periodo === 'hoje';
  if (!hoje && (req.query.de || req.query.ate)) {
    const de = dataISO(req.query.de, 'data inicial'), ate = dataISO(req.query.ate || req.query.de, 'data final');
    if (ate < de) falha(400, 'A data final é antes da inicial');
    const { rows } = await pool.query(
      `SELECT v.id, v.usuario_id, u.nome AS usuario_nome, v.canal, v.subtotal, v.desconto, v.total, v.forma_pagamento, v.codigo_troca,
              v.cancelada, v.motivo_cancelamento, v.cashback_gerado, v.criado_em, v.cliente_id, c.nome AS cliente_nome, v.pedido_online_id,
              (SELECT COALESCE(SUM(qtd),0) FROM vendas_itens vi WHERE vi.venda_id = v.id) AS qtd_itens,
              (SELECT count(*) FROM devolucoes d WHERE d.venda_id = v.id)::int AS devolucoes,
              (SELECT COALESCE(SUM(d.valor_total),0) FROM devolucoes d WHERE d.venda_id = v.id) AS valor_devolvido,
              (SELECT json_agg(json_build_object('forma', vp.forma, 'valor', vp.valor)) FROM venda_pagamentos vp WHERE vp.venda_id = v.id) AS pagamentos,
              nf.status AS nfce_status, nf.url_danfe AS nfce_danfe, nf.numero AS nfce_numero
       FROM vendas v JOIN usuarios u ON u.id = v.usuario_id LEFT JOIN clientes c ON c.id = v.cliente_id
       LEFT JOIN notas_fiscais nf ON nf.venda_id = v.id
       WHERE v.loja_id = $1 AND (v.criado_em AT TIME ZONE $2)::date BETWEEN $3 AND $4
       ORDER BY v.criado_em DESC LIMIT 2000`,
      [req.lojaId, TZ, de, ate]);
    return res.json(rows);
  }
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

// Aba Trocas: acha a venda pelo código de barras do cupom (98...) ou pelo número que aparece no
// cupom ("Venda 1A2B3C" — os 6 últimos caracteres), pra cupons impressos antes do código de barras.
app.get('/api/lojas/:lojaId/vendas/por-codigo/:codigo', qualquer, rota(async (req, res) => {
  const bruto = String(req.params.codigo || '').trim();
  let rows;
  if (/^\d{6,20}$/.test(bruto)) {
    ({ rows } = await pool.query('SELECT id FROM vendas WHERE loja_id = $1 AND codigo_troca = $2', [req.lojaId, bruto]));
  }
  if (!rows || !rows.length) {
    const numero = bruto.replace(/^venda\s*/i, '').replace(/[^0-9a-z]/gi, '').toLowerCase();
    if (numero.length !== 6) falha(404, 'Cupom não encontrado — confira o código ou procure a venda na lista');
    ({ rows } = await pool.query('SELECT id FROM vendas WHERE loja_id = $1 AND right(id, 6) = $2 ORDER BY criado_em DESC LIMIT 2', [req.lojaId, numero]));
    if (rows.length > 1) falha(409, 'Tem mais de uma venda com esse número — procure pela lista de vendas');
  }
  if (!rows.length) falha(404, 'Cupom não encontrado — confira o código ou procure a venda na lista');
  res.json({ id: rows[0].id });
}));

// Trocas e devoluções feitas nos últimos dias (aba Trocas).
app.get('/api/lojas/:lojaId/devolucoes', qualquer, rota(async (req, res) => {
  const dias = Math.min(366, Math.max(1, parseInt(req.query.dias, 10) || 30));
  const { rows } = await pool.query(
    `SELECT d.id, d.venda_id, d.valor_total, d.observacao, d.criado_em, c.nome AS cliente_nome, c.telefone AS cliente_telefone, u.nome AS usuario_nome,
            (SELECT string_agg(di.qtd::int || 'x ' || vi.produto_nome || ' ' || vi.tamanho, ', ' ORDER BY vi.produto_nome)
               FROM devolucoes_itens di JOIN vendas_itens vi ON vi.id = di.venda_item_id WHERE di.devolucao_id = d.id) AS pecas
     FROM devolucoes d JOIN clientes c ON c.id = d.cliente_id JOIN usuarios u ON u.id = d.criado_por
     WHERE d.loja_id = $1 AND d.criado_em >= now() - ($2 || ' days')::interval
     ORDER BY d.criado_em DESC LIMIT 300`, [req.lojaId, String(dias)]);
  res.json(rows.map((r) => ({ ...r, valor_total: Number(r.valor_total) })));
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
    const { rowCount: credPagas } = await c.query('SELECT 1 FROM crediario_parcelas WHERE venda_id = $1 AND pago_em IS NOT NULL', [venda.id]);
    if (credPagas) falha(409, 'Essa venda no crediário já tem parcela paga — desfaça o recebimento das parcelas antes de cancelar');
    await c.query('DELETE FROM crediario_parcelas WHERE venda_id = $1 AND pago_em IS NULL', [venda.id]);
    await desfazerPresentes(c, { vendaId: venda.id });
    if (venda.pedido_online_id) await desfazerPresentes(c, { pedidoId: venda.pedido_online_id });
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

/* ---------- Importar produtos por planilha ---------- */
// Uma linha por tamanho/cor. "Produto" em branco = mesmo produto da linha de cima (e preço/custo
// em branco repetem os de cima). Produto que já existe no sistema (mesmo nome) é pulado, então
// importar o mesmo arquivo duas vezes não duplica nada.
const COLS_IMPORT = [
  ['produto', 'Produto', 34], ['categoria', 'Categoria', 16], ['genero', 'Gênero', 12], ['grade', 'Grade', 12], ['tamanho', 'Tamanho', 10], ['cor', 'Cor', 14],
  ['quantidade', 'Quantidade', 11], ['preco', 'Preço de venda', 14], ['custo', 'Custo', 11], ['codigo', 'Código de barras (opcional)', 22],
  ['ncm', 'NCM (opcional)', 14], ['descricao', 'Descrição (opcional)', 30],
];
const semAcentoMin = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
function numeroPlanilha(cel) {
  if (cel == null || cel === '') return null;
  if (typeof cel === 'number') return cel;
  let t = String(cel).replace(/r\$|\s/gi, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}
function valorCelula(c) {
  const v = c.value;
  if (v == null) return '';
  if (typeof v === 'object' && v.result !== undefined) return v.result; // fórmula
  if (typeof v === 'object' && v.richText) return v.richText.map((r) => r.text).join('');
  return v;
}

app.get('/api/lojas/:lojaId/produtos/planilha-modelo', admin, rota(async (req, res) => {
  const { rows: grades } = await pool.query('SELECT nome, tamanhos FROM grades_tamanho WHERE loja_id = $1 ORDER BY nome', [req.lojaId]);
  const livro = new ExcelJS.Workbook();
  const aba = livro.addWorksheet('Produtos', { views: [{ state: 'frozen', ySplit: 1 }] });
  aba.columns = COLS_IMPORT.map(([key, header, width]) => ({ key, header, width }));
  aba.getRow(1).font = { bold: true };
  aba.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE3D6' } };
  ['codigo', 'ncm', 'tamanho'].forEach((k) => { aba.getColumn(k).numFmt = '@'; });
  if (grades.length) {
    for (let r = 2; r <= 1000; r++) aba.getCell('D' + r).dataValidation = { type: 'list', allowBlank: true, formulae: ['"' + grades.map((g) => g.nome).join(',') + '"'] };
  }
  for (let r = 2; r <= 1000; r++) aba.getCell('C' + r).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Feminino,Masculino,Unissex"'] };
  const ex = livro.addWorksheet('Exemplo');
  ex.columns = COLS_IMPORT.map(([key, header, width]) => ({ key, header, width }));
  ex.getRow(1).font = { bold: true };
  [
    { produto: 'Body Ursinho Manga Longa', categoria: 'Bodies', genero: 'Unissex', grade: 'Bebê', tamanho: '0-3M', cor: 'Branco', quantidade: 3, preco: 39.9, custo: 18 },
    { tamanho: '3-6M', cor: 'Branco', quantidade: 2 },
    { tamanho: '0-3M', cor: 'Azul', quantidade: 2 },
    { tamanho: '3-6M', cor: 'Azul', quantidade: 1 },
    { produto: 'Vestido Floral Alcinha', categoria: 'Vestidos', genero: 'Feminino', grade: 'Infantil', tamanho: '2', cor: '', quantidade: 2, preco: 89.9, custo: 40, descricao: 'Viscose, forrado' },
    { tamanho: '4', quantidade: 3 },
    { tamanho: '6', quantidade: 1, preco: 94.9 },
  ].forEach((r) => ex.addRow(r));
  const ajuda = livro.addWorksheet('Como preencher');
  ajuda.getColumn(1).width = 120;
  ['Cadastro de produtos da Loja Gutto por planilha', '',
    'Preencha a aba "Produtos": UMA LINHA PARA CADA TAMANHO/COR (veja a aba "Exemplo").',
    '• Produto: nome sem tamanho e sem cor. Deixe EM BRANCO nas linhas de baixo do mesmo produto.',
    '• Gênero: Feminino, Masculino ou Unissex (opcional; só na 1ª linha do produto).',
    '• Tamanho: obrigatório (ex.: 0-3M, 2, 4, P, M). Cor: deixe em branco se a peça só tem uma cor.',
    '• Quantidade: quantas peças tem agora na loja (pode ser 0).',
    '• Preço de venda: obrigatório na 1ª linha do produto; em branco nas de baixo = mesmo preço.',
    '• Custo: quanto pagou por peça (opcional, mas ajuda nos relatórios de lucro).',
    '• Grade: ' + (grades.length ? grades.map((g) => g.nome + ' (' + g.tamanhos.join(', ') + ')').join('; ') : 'nenhuma grade cadastrada ainda') + '. Opcional — ajuda a ordenar os tamanhos.',
    '• Código de barras: só se a peça JÁ TEM etiqueta com código. Em branco = o sistema cria um e você imprime a etiqueta.',
    '• NCM: se souber (8 números). Se não, a contadora preenche depois pela planilha de NCM.',
    '', 'Produto que já existe no sistema com o mesmo nome é pulado (não duplica).',
    'Antes de importar, o sistema mostra uma prévia com tudo que vai entrar e o que precisa corrigir.',
  ].forEach((t) => ajuda.addRow([t]));
  ajuda.getRow(1).font = { bold: true, size: 14 };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="cadastro-produtos-loja-gutto.xlsx"');
  res.send(Buffer.from(await livro.xlsx.writeBuffer()));
}));

// Corpo: { arquivo (base64), nome, importar: bool }. Sem "importar": só a prévia.
app.post('/api/lojas/:lojaId/produtos/importar-planilha', admin, express.json({ limit: '15mb' }), rota(async (req, res) => {
  const body = req.body || {};
  if (typeof body.arquivo !== 'string' || !body.arquivo) falha(400, 'Envie o arquivo da planilha');
  const livro = await abrirPlanilhaEnviada(body);
  // Aba "Produtos" (ou a primeira que tiver as colunas Produto e Tamanho), colunas pelo cabeçalho.
  let aba = null, cols = null;
  const tentar = (a) => {
    if (aba || /^exemplo|^como preencher/i.test(a.name)) return;
    const achadas = {};
    a.getRow(1).eachCell((cel, n) => {
      const t = semAcentoMin(cel.text);
      for (const [key, header] of COLS_IMPORT) if (!achadas[key] && t.startsWith(semAcentoMin(header).split(' (')[0])) achadas[key] = n;
      if (!achadas.preco && t.startsWith('preco')) achadas.preco = n;
    });
    if (achadas.produto && achadas.tamanho) { aba = a; cols = achadas; }
  };
  const principal = livro.getWorksheet('Produtos');
  if (principal) tentar(principal);
  livro.eachSheet(tentar);
  if (!aba) falha(400, 'Não achei as colunas "Produto" e "Tamanho" — use a planilha modelo do sistema');

  const { rows: grades } = await pool.query('SELECT id, nome, tamanhos FROM grades_tamanho WHERE loja_id = $1', [req.lojaId]);
  const gradePorNome = new Map(grades.map((g) => [semAcentoMin(g.nome), g]));
  const { rows: existentes } = await pool.query('SELECT nome FROM produtos WHERE loja_id = $1', [req.lojaId]);
  const nomesExistentes = new Set(existentes.map((p) => semAcentoMin(p.nome)));
  const { rows: codigos } = await pool.query('SELECT codigo_barras FROM produto_variacoes WHERE loja_id = $1 AND codigo_barras IS NOT NULL', [req.lojaId]);
  const codigosUsados = new Set(codigos.map((c) => c.codigo_barras));

  const produtos = new Map(); // nome normalizado → produto
  const problemas = [], avisos = [];
  let atual = null, ultimoPreco = null, ultimoCusto = null;
  const cel = (linha, key) => (cols[key] ? valorCelula(linha.getCell(cols[key])) : '');
  aba.eachRow((linha, n) => {
    if (n === 1) return;
    const txt = (key) => String(cel(linha, key) == null ? '' : cel(linha, key)).trim();
    const nomeLinha = txt('produto'), tamanho = txt('tamanho');
    if (!nomeLinha && !tamanho && !txt('cor') && !txt('quantidade') && !txt('preco')) return; // linha vazia
    if (nomeLinha) {
      const chave = semAcentoMin(nomeLinha);
      atual = produtos.get(chave);
      if (!atual) {
        atual = { nome: nomeLinha.slice(0, 120), categoria: txt('categoria').slice(0, 60) || null, gradeNome: txt('grade'), grade: null,
          ncm: txt('ncm').replace(/\D/g, '') || null, descricao: txt('descricao').slice(0, 500) || null, variacoes: [], linha: n,
          jaExiste: nomesExistentes.has(chave) };
        if (atual.gradeNome) {
          atual.grade = gradePorNome.get(semAcentoMin(atual.gradeNome)) || null;
          if (!atual.grade) problemas.push({ linha: n, produto: atual.nome, motivo: 'grade "' + atual.gradeNome + '" não existe (deixe em branco ou crie a grade antes)' });
        }
        try { atual.genero = generoDe(txt('genero')) || null; } catch (e) { atual.genero = null; problemas.push({ linha: n, produto: atual.nome, motivo: 'gênero "' + txt('genero') + '" não existe (use Feminino, Masculino ou Unissex)' }); }
        if (atual.ncm && atual.ncm.length === 7) atual.ncm = '0' + atual.ncm;
        if (atual.ncm && atual.ncm.length !== 8) problemas.push({ linha: n, produto: atual.nome, motivo: 'NCM precisa ter 8 números' });
        produtos.set(chave, atual);
      }
      ultimoPreco = null; ultimoCusto = null;
    }
    if (!atual) { problemas.push({ linha: n, motivo: 'linha sem produto (preencha a coluna Produto na primeira linha de cada produto)' }); return; }
    if (!tamanho) { problemas.push({ linha: n, produto: atual.nome, motivo: 'falta o tamanho' }); return; }
    const cor = txt('cor').slice(0, 40);
    let preco = numeroPlanilha(cel(linha, 'preco'));
    if (preco == null) preco = ultimoPreco;
    if (preco == null || !(preco > 0)) { problemas.push({ linha: n, produto: atual.nome, motivo: 'preço de venda inválido ou em branco' }); return; }
    let custo = numeroPlanilha(cel(linha, 'custo'));
    if (custo == null) custo = ultimoCusto;
    if (custo != null && !(custo >= 0)) { problemas.push({ linha: n, produto: atual.nome, motivo: 'custo inválido' }); return; }
    let qtd = numeroPlanilha(cel(linha, 'quantidade'));
    if (qtd == null) qtd = 0;
    if (!Number.isInteger(qtd) || qtd < 0 || qtd > 100000) { problemas.push({ linha: n, produto: atual.nome, motivo: 'quantidade precisa ser um número inteiro' }); return; }
    const codigo = txt('codigo').replace(/\D/g, '') || null;
    if (codigo && (codigosUsados.has(codigo) || atual.variacoes.some((v) => v.codigo === codigo) || [...produtos.values()].some((p) => p.variacoes.some((v) => v.codigo === codigo)))) {
      problemas.push({ linha: n, produto: atual.nome, motivo: 'código de barras ' + codigo + ' repetido (já está em outra peça)' }); return;
    }
    if (atual.variacoes.some((v) => semAcentoMin(v.tamanho) === semAcentoMin(tamanho) && semAcentoMin(v.cor) === semAcentoMin(cor))) {
      problemas.push({ linha: n, produto: atual.nome, motivo: 'tamanho ' + tamanho + (cor ? ' ' + cor : '') + ' repetido nesse produto' }); return;
    }
    if (atual.grade && !atual.grade.tamanhos.some((t) => semAcentoMin(t) === semAcentoMin(tamanho))) {
      avisos.push({ linha: n, produto: atual.nome, motivo: 'tamanho ' + tamanho + ' não está na grade ' + atual.grade.nome + ' (entra assim mesmo)' });
    }
    ultimoPreco = preco; ultimoCusto = custo;
    atual.variacoes.push({ tamanho: tamanho.slice(0, 10), cor, preco: round2(preco), custo: custo != null ? round2(custo) : 0, qtd, codigo, linha: n });
  });
  const lista = [...produtos.values()];
  lista.filter((p) => p.jaExiste).forEach((p) => avisos.push({ linha: p.linha, produto: p.nome, motivo: 'já existe no sistema — vai ser pulado' }));
  lista.filter((p) => !p.jaExiste && !p.variacoes.length).forEach((p) => problemas.push({ linha: p.linha, produto: p.nome, motivo: 'produto sem nenhum tamanho válido' }));
  const novos = lista.filter((p) => !p.jaExiste && p.variacoes.length);
  const resumo = {
    produtos: lista.map((p) => ({ nome: p.nome, categoria: p.categoria, genero: p.genero, grade: p.grade ? p.grade.nome : null, variacoes: p.variacoes.length,
      pecas: p.variacoes.reduce((t, v) => t + v.qtd, 0), jaExiste: p.jaExiste,
      precos: [...new Set(p.variacoes.map((v) => v.preco))] })),
    totais: { produtos: novos.length, variacoes: novos.reduce((t, p) => t + p.variacoes.length, 0), pecas: novos.reduce((t, p) => t + p.variacoes.reduce((s, v) => s + v.qtd, 0), 0) },
    problemas: problemas.slice(0, 100), avisos: avisos.slice(0, 100),
  };
  if (!body.importar) return res.json(resumo);
  if (problemas.length) falha(400, 'Corrija as linhas com problema antes de importar', { codigo: 'planilha_com_problemas', ...resumo });
  if (!novos.length) falha(400, 'Nenhum produto novo pra importar');
  const criados = await transacao(async (c) => {
    const ids = [];
    for (const p of novos) {
      const id = uid();
      await c.query('INSERT INTO produtos (id, loja_id, nome, categoria, descricao, grade_tamanho_id, ncm, genero) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, req.lojaId, p.nome, p.categoria, p.descricao, p.grade ? p.grade.id : null, p.ncm, p.genero]);
      for (const v of p.variacoes) {
        await inserirVariacao(c, req.lojaId, id, { tamanho: v.tamanho, cor: v.cor, preco: v.preco, custo: v.custo, minimo: 0, inicial: v.qtd, codigo: v.codigo, sku: null }, req.usuario.id);
      }
      ids.push(id);
    }
    return ids;
  });
  res.status(201).json({ ...resumo, importados: criados });
}));

// Dados pra imprimir o DANFE da NFC-e no formato de cupom (na térmica do caixa, igual ao cupom da
// venda — lição do Jabá: abrir a página da Focus não sai direito na impressora do caixa).
// O QR Code (obrigatório no DANFE) vai como imagem PNG.
app.get('/api/lojas/:lojaId/vendas/:id/nfce/danfe', qualquer, rota(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM notas_fiscais WHERE venda_id = $1 AND loja_id = $2 AND status = 'autorizada'", [req.params.id, req.lojaId]);
  if (!rows.length) falha(404, 'Essa venda não tem NFC-e autorizada');
  const n = rows[0], bruta = n.resposta_bruta || {};
  const { rows: itens } = await pool.query('SELECT produto_nome, tamanho, cor, qtd, preco_unit, desconto_item FROM vendas_itens WHERE venda_id = $1 ORDER BY criado_em, id', [req.params.id]);
  const { rows: pags } = await pool.query('SELECT forma, valor FROM venda_pagamentos WHERE venda_id = $1', [req.params.id]);
  const { rows: vs } = await pool.query('SELECT total, desconto, taxa_entrega, troco FROM vendas WHERE id = $1', [req.params.id]);
  const { rows: lj } = await pool.query('SELECT nome, endereco FROM lojas WHERE id = $1', [req.lojaId]);
  const qrUrl = bruta.qrcode_url || null;
  res.json({
    emitente: { nome: process.env.NFCE_EMITENTE_NOME || lj[0].nome, cnpj: String(process.env.FOCUS_NFE_CNPJ_EMITENTE || '').replace(/\D/g, ''),
      ie: process.env.NFCE_EMITENTE_IE || '', endereco: process.env.NFCE_EMITENTE_ENDERECO || lj[0].endereco || '' },
    ambiente: n.ambiente, numero: n.numero, serie: n.serie, chave: String(n.chave_acesso || bruta.chave_nfe || '').replace(/^NFe/i, ''),
    protocolo: bruta.protocolo || null, emitidaEm: bruta.data_emissao || n.criado_em, cpf: n.cpf,
    consulta: bruta.url_consulta_nf || 'www.nfce.set.rn.gov.br', urlDanfe: n.url_danfe,
    qrPng: qrUrl ? await QRCode.toDataURL(qrUrl, { errorCorrectionLevel: 'M', margin: 1, width: 240 }) : null,
    itens: itens.map((i) => ({ nome: i.produto_nome + ' ' + i.tamanho + (i.cor ? ' ' + i.cor : ''), qtd: Number(i.qtd), preco: Number(i.preco_unit), desconto: Number(i.desconto_item) })),
    pagamentos: pags.map((p) => ({ forma: p.forma, valor: Number(p.valor) })),
    total: Number(vs[0].total), desconto: Number(vs[0].desconto), taxaEntrega: Number(vs[0].taxa_entrega), troco: Number(vs[0].troco),
  });
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

// Planilha pra contadora: um produto por linha, ela preenche o NCM e a planilha volta pelo painel.
const COL_CODIGO = 'Código (não mexer)', COL_NCM = 'NCM (8 números)';
app.get('/api/lojas/:lojaId/fiscal/planilha', admin, rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.nome, p.categoria, p.descricao, p.ncm,
            string_agg(DISTINCT v.tamanho, ', ') AS tamanhos, string_agg(DISTINCT NULLIF(v.cor, ''), ', ') AS cores
     FROM produtos p LEFT JOIN produto_variacoes v ON v.produto_id = p.id AND v.ativo
     WHERE p.loja_id = $1 AND p.ativo GROUP BY p.id ORDER BY p.categoria NULLS LAST, p.nome`, [req.lojaId]);
  const livro = new ExcelJS.Workbook();
  const aba = livro.addWorksheet('Produtos', { views: [{ state: 'frozen', ySplit: 1 }] });
  aba.columns = [
    { header: COL_CODIGO, key: 'id', width: 20 }, { header: 'Produto', key: 'nome', width: 34 }, { header: 'Categoria', key: 'categoria', width: 16 },
    { header: 'Descrição / tecido', key: 'descricao', width: 30 }, { header: 'Tamanhos', key: 'tamanhos', width: 18 }, { header: 'Cores', key: 'cores', width: 18 },
    { header: COL_NCM, key: 'ncm', width: 16 }, { header: 'Observação', key: 'obs', width: 30 },
  ];
  for (const r of rows) aba.addRow({ ...r, ncm: r.ncm || '' });
  aba.getRow(1).font = { bold: true };
  aba.getColumn('ncm').numFmt = '@';
  aba.getColumn('ncm').eachCell((cel, n) => { if (n > 1) cel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4CC' } }; });
  const ajuda = livro.addWorksheet('Como preencher');
  ajuda.getColumn(1).width = 110;
  ['Planilha de produtos da Loja Gutto pra classificação fiscal (NFC-e).', '',
    'Preencha a coluna "NCM (8 números)" de cada produto (pode ser com ou sem pontos: 6104.42.00 ou 61044200).',
    'Não mexa na coluna "Código" — é por ela que o sistema acha o produto.',
    'Linha com NCM vazio fica como está no sistema. Pode usar a coluna "Observação" pra comentários.',
    'CFOP, CSOSN e origem são da loja inteira (configurados à parte) — só o NCM é por produto.',
  ].forEach((t) => ajuda.addRow([t]));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="produtos-ncm-loja-gutto.xlsx"');
  res.send(Buffer.from(await livro.xlsx.writeBuffer()));
}));

// Abre a planilha mandada pelo painel (.xlsx ou .csv, em base64).
async function abrirPlanilhaEnviada(body) {
  const buf = Buffer.from(body.arquivo, 'base64');
  const livro = new ExcelJS.Workbook();
  const ehCsv = /\.csv$/i.test(String(body.nome || ''));
  try {
    if (ehCsv) {
      // Excel em português salva CSV com ";" e, às vezes, em Windows-1252.
      let txt = buf.toString('utf8');
      if (txt.includes('\uFFFD')) txt = new TextDecoder('windows-1252').decode(buf);
      const aba = livro.addWorksheet('csv');
      const sep = (txt.split(/\r?\n/)[0].match(/;/g) || []).length ? ';' : ',';
      for (const linha of txt.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        if (linha.trim()) aba.addRow(linha.split(sep).map((x) => x.replace(/^"|"$/g, '').trim()));
      }
    } else {
      await livro.xlsx.load(buf);
    }
  } catch (e) {
    falha(400, 'Não consegui abrir essa planilha — salve como .xlsx (Excel) e tente de novo');
  }
  return livro;
}

// Planilha preenchida de volta (.xlsx ou .csv, em base64). Aplica o NCM de cada linha preenchida.
app.post('/api/lojas/:lojaId/fiscal/planilha', admin, express.json({ limit: '8mb' }), rota(async (req, res) => {
  const body = req.body || {};
  if (typeof body.arquivo !== 'string' || !body.arquivo) falha(400, 'Envie o arquivo da planilha');
  const livro = await abrirPlanilhaEnviada(body);
  // Acha a aba e as colunas pelo cabeçalho (a contadora pode ter mudado a ordem das colunas).
  let aba = null, colCodigo = 0, colNcm = 0;
  livro.eachSheet((a) => {
    if (aba) return;
    a.getRow(1).eachCell((cel, n) => {
      const t = String(cel.text || '').toLowerCase();
      if (t.startsWith('código') || t.startsWith('codigo')) colCodigo = n;
      if (t.startsWith('ncm')) colNcm = n;
    });
    if (colCodigo && colNcm) aba = a; else { colCodigo = 0; colNcm = 0; }
  });
  if (!aba) falha(400, 'Essa planilha não tem as colunas "Código" e "NCM" — use a planilha baixada do sistema');
  const { rows: produtos } = await pool.query('SELECT id, nome FROM produtos WHERE loja_id = $1', [req.lojaId]);
  const nomes = new Map(produtos.map((p) => [p.id, p.nome]));
  const aplicar = [], problemas = [];
  aba.eachRow((linha, n) => {
    if (n === 1) return;
    const codigo = String(linha.getCell(colCodigo).text || '').trim();
    let ncm = String(linha.getCell(colNcm).text || '').replace(/\D/g, '');
    if (!codigo && !ncm) return;
    if (!ncm) return; // vazio: fica como está
    if (ncm.length === 7) ncm = '0' + ncm; // Excel come o zero da frente quando trata como número
    if (!nomes.has(codigo)) { problemas.push({ linha: n, motivo: 'código "' + codigo + '" não é de nenhum produto' }); return; }
    if (ncm.length !== 8) { problemas.push({ linha: n, produto: nomes.get(codigo), motivo: 'NCM "' + linha.getCell(colNcm).text + '" não tem 8 números' }); return; }
    aplicar.push([codigo, ncm]);
  });
  let atualizados = 0;
  await transacao(async (c) => {
    for (const [id, ncm] of aplicar) {
      atualizados += (await c.query('UPDATE produtos SET ncm = $1 WHERE id = $2 AND loja_id = $3 AND ncm IS DISTINCT FROM $1', [ncm, id, req.lojaId])).rowCount;
    }
  });
  res.json({ atualizados, problemas: problemas.slice(0, 50) });
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

    // Prazo de troca (loja física × compra pelo site). Passou: só com o PIN de um Administrador.
    const { rows: pz } = await c.query(
      `SELECT CASE WHEN $2 = 'online' THEN troca_dias_site ELSE troca_dias_loja END AS prazo,
              ((now() AT TIME ZONE $3)::date - ($4::timestamptz AT TIME ZONE $3)::date) AS dias
       FROM lojas WHERE id = $1`, [req.lojaId, venda.canal, TZ, venda.criado_em]);
    const { prazo, dias } = pz[0];
    let aprovadoPor = null;
    if (dias > prazo && req.usuario.papel !== 'administrador') {
      const ap = body.aprovacao || {};
      const motivo = 'Compra feita há ' + dias + ' dias — o prazo de troca ' + (venda.canal === 'online' ? 'do site' : 'da loja') + ' é ' + prazo + ' dias. Precisa do PIN de um Administrador';
      if (typeof ap.usuarioId !== 'string' || typeof ap.pin !== 'string') falha(403, motivo, { codigo: 'aprovacao_necessaria' });
      const { rows: adm } = await c.query("SELECT id, nome, pin_hash FROM usuarios WHERE id = $1 AND loja_id = $2 AND ativo AND papel = 'administrador'", [ap.usuarioId, req.lojaId]);
      if (!adm.length || !conferirPin(req, adm[0], ap.pin)) falha(403, 'PIN de Administrador incorreto', { codigo: 'aprovacao_invalida' });
      aprovadoPor = adm[0].nome;
    }

    // Presente: quem traz pra trocar pode não ser quem comprou — o crédito fica com quem a loja escolher.
    const clienteId = (typeof body.clienteId === 'string' && body.clienteId) || venda.cliente_id;
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
      [devolucaoId, req.lojaId, venda.id, clienteId, valorTotal,
        [texto(body.observacao, 'observacao', { obrigatorio: false, max: 300 }), dias > prazo ? `Fora do prazo (${dias} de ${prazo} dias)${aprovadoPor ? ', autorizada por ' + aprovadoPor : ''}` : null].filter(Boolean).join(' · ') || null,
        req.usuario.id]
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
  // Crediário entra na receita quando a parcela é recebida (no mês do recebimento), não na venda.
  const { rows: recCred } = await pool.query(
    `SELECT COALESCE(SUM(valor_pago), 0)::float AS total FROM crediario_parcelas WHERE loja_id = $1 AND pago_em IS NOT NULL
       AND (pago_em AT TIME ZONE $3)::date >= $2::date AND (pago_em AT TIME ZONE $3)::date < ($2::date + interval '1 month')`, [req.lojaId, inicio, TZ]);
  const crediarioRecebido = round2(recCred[0].total);
  const crediarioVendido = round2(porForma.filter((f) => f.forma === 'Crediário').reduce((s, f) => s + Number(f.total), 0));
  const receita = round2(porForma.filter((f) => !FORMAS_CREDITO[f.forma] && f.forma !== 'Crediário').reduce((s, f) => s + Number(f.total), 0) + crediarioRecebido);
  const creditosUsados = round2(porForma.filter((f) => FORMAS_CREDITO[f.forma]).reduce((s, f) => s + Number(f.total), 0));
  const totalDespesas = round2(despesas.reduce((s, d) => s + Number(d.valor), 0));
  res.json({
    mes, receita, creditosUsados, totalDespesas, saldo: round2(receita - totalDespesas), crediarioVendido, crediarioRecebido,
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
    const { rowCount: daConta } = await c.query('SELECT 1 FROM contas_pagar WHERE despesa_id = $1 AND loja_id = $2', [req.params.id, req.lojaId]);
    if (daConta) falha(409, 'Essa despesa é o pagamento de uma conta a pagar — use "desfazer pagamento" em Contas a pagar');
    await c.query('UPDATE compras SET despesa_id = NULL WHERE despesa_id = $1 AND loja_id = $2', [req.params.id, req.lojaId]);
    const { rowCount } = await c.query('DELETE FROM despesas WHERE id = $1 AND loja_id = $2', [req.params.id, req.lojaId]);
    if (!rowCount) falha(404, 'despesa não encontrada');
  });
  res.json({ ok: true });
}));

/* ---------- Promoções ---------- */

function lerPromocao(body) {
  const alvo = ['produtos', 'categoria', 'loja'].includes(body.alvo) ? body.alvo : falha(400, 'Escolha onde vale a promoção');
  const inicio = dataISO(body.inicio, 'data de início'), fim = dataISO(body.fim, 'data de fim');
  if (fim < inicio) falha(400, 'A promoção termina antes de começar');
  const produtoIds = alvo === 'produtos' ? (Array.isArray(body.produtoIds) ? [...new Set(body.produtoIds.filter((x) => typeof x === 'string'))] : []) : [];
  if (alvo === 'produtos' && !produtoIds.length) falha(400, 'Escolha os produtos da promoção');
  if (produtoIds.length > 2000) falha(400, 'Produtos demais');
  return {
    nome: texto(body.nome, 'nome da promoção', { max: 60 }),
    pct: numero(body.descontoPct, 'desconto (%)', { minExclusivo: true, max: 90 }),
    alvo, inicio, fim, produtoIds,
    categoria: alvo === 'categoria' ? texto(body.categoria, 'categoria', { max: 60 }) : null,
  };
}

app.get('/api/lojas/:lojaId/promocoes', admin, rota(async (req, res) => {
  const hoje = promocoes.hojeNaLoja(TZ);
  const { rows } = await pool.query(
    `SELECT pr.id, pr.nome, pr.desconto_pct::float AS desconto_pct, pr.alvo, pr.categoria, pr.produto_ids,
            to_char(pr.inicio, 'YYYY-MM-DD') AS inicio, to_char(pr.fim, 'YYYY-MM-DD') AS fim, pr.encerrada_em,
            (SELECT COALESCE(SUM(vi.qtd), 0)::int FROM vendas_itens vi JOIN vendas v ON v.id = vi.venda_id WHERE vi.promocao_id = pr.id AND NOT v.cancelada) AS pecas_vendidas
     FROM promocoes pr WHERE pr.loja_id = $1 ORDER BY (pr.encerrada_em IS NULL AND pr.fim >= $2::date) DESC, pr.inicio DESC`, [req.lojaId, hoje]);
  res.json(rows.map((p) => ({ ...p,
    situacao: p.encerrada_em || p.fim < hoje ? 'encerrada' : p.inicio > hoje ? 'agendada' : 'ativa' })));
}));

app.post('/api/lojas/:lojaId/promocoes', admin, rota(async (req, res) => {
  const d = lerPromocao(req.body || {});
  const id = uid();
  await pool.query(
    `INSERT INTO promocoes (id, loja_id, nome, desconto_pct, alvo, categoria, produto_ids, inicio, fim, criado_por) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, req.lojaId, d.nome, d.pct, d.alvo, d.categoria, d.produtoIds, d.inicio, d.fim, req.usuario.id]);
  res.status(201).json({ id });
}));

app.put('/api/lojas/:lojaId/promocoes/:id', admin, rota(async (req, res) => {
  const d = lerPromocao(req.body || {});
  const { rowCount } = await pool.query(
    `UPDATE promocoes SET nome = $1, desconto_pct = $2, alvo = $3, categoria = $4, produto_ids = $5, inicio = $6, fim = $7, encerrada_em = NULL
     WHERE id = $8 AND loja_id = $9`, [d.nome, d.pct, d.alvo, d.categoria, d.produtoIds, d.inicio, d.fim, req.params.id, req.lojaId]);
  if (!rowCount) falha(404, 'promoção não encontrada');
  res.json({ ok: true });
}));

// Encerrar agora (antes da data de fim). As vendas já feitas continuam com o preço da promoção.
app.post('/api/lojas/:lojaId/promocoes/:id/encerrar', admin, rota(async (req, res) => {
  const { rowCount } = await pool.query('UPDATE promocoes SET encerrada_em = now() WHERE id = $1 AND loja_id = $2 AND encerrada_em IS NULL', [req.params.id, req.lojaId]);
  if (!rowCount) falha(404, 'promoção não encontrada ou já encerrada');
  res.json({ ok: true });
}));

app.delete('/api/lojas/:lojaId/promocoes/:id', admin, rota(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM promocoes WHERE id = $1 AND loja_id = $2', [req.params.id, req.lojaId]);
  if (!rowCount) falha(404, 'promoção não encontrada');
  res.json({ ok: true });
}));

/* ---------- Contas a pagar (boletos, parcelas) ---------- */

function lerParcelas(lista) {
  if (lista.length > 60) falha(400, 'No máximo 60 parcelas');
  return lista.map((p, i) => ({
    vencimento: dataISO(p && p.vencimento, 'vencimento da parcela ' + (i + 1)),
    valor: numero(p && p.valor, 'valor da parcela ' + (i + 1), { minExclusivo: true, max: 1e8 }),
    codigoBarras: soDigitos(p && p.codigoBarras),
  }));
}
async function criarContas(c, req, { descricao, fornecedorId, compraId, categoria, observacao, parcelas }) {
  const grupo = uid(), ids = [];
  for (let i = 0; i < parcelas.length; i++) {
    const p = parcelas[i], id = uid();
    await c.query(
      `INSERT INTO contas_pagar (id, loja_id, grupo, descricao, fornecedor_id, compra_id, categoria, parcela, parcelas, valor, vencimento, codigo_barras, observacao, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, req.lojaId, grupo, descricao, fornecedorId || null, compraId || null, categoria || null, i + 1, parcelas.length,
        p.valor, p.vencimento, p.codigoBarras || null, observacao || null, req.usuario.id]);
    ids.push(id);
  }
  return ids;
}
async function acharOuCriarFornecedor(c, lojaId, nome) {
  if (!nome) return null;
  const { rows } = await c.query('SELECT id FROM fornecedores WHERE loja_id = $1 AND lower(nome) = lower($2) LIMIT 1', [lojaId, nome]);
  if (rows.length) return rows[0].id;
  const id = uid();
  await c.query('INSERT INTO fornecedores (id, loja_id, nome) VALUES ($1,$2,$3)', [id, lojaId, nome]);
  return id;
}

const SQL_CONTAS = `SELECT cp.id, cp.grupo, cp.descricao, cp.fornecedor_id, f.nome AS fornecedor_nome, cp.compra_id, cp.categoria,
    cp.parcela, cp.parcelas, cp.valor::float AS valor, to_char(cp.vencimento, 'YYYY-MM-DD') AS vencimento, cp.codigo_barras, cp.observacao,
    to_char(cp.pago_em, 'YYYY-MM-DD') AS pago_em, cp.valor_pago::float AS valor_pago, cp.forma_pagamento, cp.despesa_id
  FROM contas_pagar cp LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id`;

// ?status=abertas (padrão) | pagas&mes=AAAA-MM. Abertas: todas, por vencimento.
app.get('/api/lojas/:lojaId/contas-pagar', admin, rota(async (req, res) => {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  if (req.query.status === 'pagas') {
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || '')) ? req.query.mes : hoje.slice(0, 7);
    const { rows } = await pool.query(SQL_CONTAS + ` WHERE cp.loja_id = $1 AND cp.pago_em IS NOT NULL
      AND cp.pago_em >= ($2 || '-01')::date AND cp.pago_em < ($2 || '-01')::date + interval '1 month' ORDER BY cp.pago_em DESC, cp.descricao`, [req.lojaId, mes]);
    return res.json({ contas: rows });
  }
  const { rows } = await pool.query(SQL_CONTAS + ' WHERE cp.loja_id = $1 AND cp.pago_em IS NULL ORDER BY cp.vencimento, cp.descricao, cp.parcela', [req.lojaId]);
  res.json({ contas: rows, resumo: resumoContas(rows, hoje), hoje });
}));
function resumoContas(abertas, hoje) {
  const em7 = new Date(Date.parse(hoje + 'T12:00:00Z') + 7 * 864e5).toISOString().slice(0, 10);
  const soma = (l) => Math.round(l.reduce((t, c) => t + c.valor, 0) * 100) / 100;
  const vencidas = abertas.filter((c) => c.vencimento < hoje), deHoje = abertas.filter((c) => c.vencimento === hoje);
  const proximas = abertas.filter((c) => c.vencimento > hoje && c.vencimento <= em7);
  return { vencidas: { n: vencidas.length, valor: soma(vencidas) }, hoje: { n: deHoje.length, valor: soma(deHoje) },
    proximos7: { n: proximas.length, valor: soma(proximas) }, abertas: { n: abertas.length, valor: soma(abertas) } };
}
app.get('/api/lojas/:lojaId/contas-pagar/resumo', admin, rota(async (req, res) => {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const { rows } = await pool.query(SQL_CONTAS + ' WHERE cp.loja_id = $1 AND cp.pago_em IS NULL', [req.lojaId]);
  res.json(resumoContas(rows, hoje));
}));

// Corpo: { descricao, fornecedorNome?, categoria?, observacao?, parcelas: [{vencimento, valor, codigoBarras?}] }
app.post('/api/lojas/:lojaId/contas-pagar', admin, rota(async (req, res) => {
  const body = req.body || {};
  const descricao = texto(body.descricao, 'descrição', { max: 120 });
  if (!Array.isArray(body.parcelas) || !body.parcelas.length) falha(400, 'Informe ao menos uma parcela (vencimento e valor)');
  const parcelas = lerParcelas(body.parcelas);
  const ids = await transacao(async (c) => {
    const fornecedorId = await acharOuCriarFornecedor(c, req.lojaId, texto(body.fornecedorNome, 'fornecedor', { obrigatorio: false, max: 100 }));
    return criarContas(c, req, { descricao, fornecedorId, categoria: texto(body.categoria, 'categoria', { obrigatorio: false, max: 60 }),
      observacao: texto(body.observacao, 'observação', { obrigatorio: false, max: 300 }), parcelas });
  });
  res.status(201).json({ ids });
}));

// Editar uma conta ainda não paga (valor, vencimento, código do boleto, descrição).
app.put('/api/lojas/:lojaId/contas-pagar/:id', admin, rota(async (req, res) => {
  const body = req.body || {};
  const { rowCount } = await pool.query(
    `UPDATE contas_pagar SET descricao = COALESCE($1, descricao), valor = COALESCE($2, valor), vencimento = COALESCE($3, vencimento),
       codigo_barras = COALESCE($4, codigo_barras), observacao = COALESCE($5, observacao)
     WHERE id = $6 AND loja_id = $7 AND pago_em IS NULL`,
    [body.descricao != null ? texto(body.descricao, 'descrição', { max: 120 }) : null,
      body.valor != null ? numero(body.valor, 'valor', { minExclusivo: true, max: 1e8 }) : null,
      body.vencimento != null ? dataISO(body.vencimento, 'vencimento') : null,
      body.codigoBarras != null ? (soDigitos(body.codigoBarras) || '') : null,
      body.observacao != null ? (texto(body.observacao, 'observação', { obrigatorio: false, max: 300 }) || '') : null, req.params.id, req.lojaId]);
  if (!rowCount) falha(409, 'Conta não encontrada ou já paga (desfaça o pagamento pra editar)');
  res.json({ ok: true });
}));

app.delete('/api/lojas/:lojaId/contas-pagar/:id', admin, rota(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM contas_pagar WHERE id = $1 AND loja_id = $2 AND pago_em IS NULL', [req.params.id, req.lojaId]);
  if (!rowCount) falha(409, 'Conta não encontrada ou já paga (desfaça o pagamento antes de excluir)');
  res.json({ ok: true });
}));

// Dar baixa: vira despesa no Fluxo de caixa na data do pagamento. Corpo: { data, valorPago?, formaPagamento? }
app.post('/api/lojas/:lojaId/contas-pagar/:id/pagar', admin, rota(async (req, res) => {
  const body = req.body || {};
  const data = dataISO(body.data, 'data do pagamento');
  const r = await transacao(async (c) => {
    const { rows } = await c.query(SQL_CONTAS + ' WHERE cp.id = $1 AND cp.loja_id = $2 FOR UPDATE OF cp', [req.params.id, req.lojaId]);
    const conta = rows[0];
    if (!conta) falha(404, 'conta não encontrada');
    if (conta.pago_em) falha(409, 'Essa conta já foi paga em ' + conta.pago_em.split('-').reverse().join('/'));
    const valor = body.valorPago != null && body.valorPago !== '' ? numero(body.valorPago, 'valor pago', { minExclusivo: true, max: 1e8 }) : conta.valor;
    const forma = texto(body.formaPagamento, 'forma de pagamento', { obrigatorio: false, max: 30 }) || 'Boleto';
    const despesaId = uid();
    const descricao = conta.descricao + (conta.parcelas > 1 ? ' (' + conta.parcela + '/' + conta.parcelas + ')' : '');
    await c.query(
      `INSERT INTO despesas (id, loja_id, data, descricao, categoria, forma_pagamento, valor, criado_por) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [despesaId, req.lojaId, data, descricao.slice(0, 200), conta.categoria || 'Contas a pagar', forma, valor, req.usuario.id]);
    await c.query('UPDATE contas_pagar SET pago_em = $1, valor_pago = $2, forma_pagamento = $3, despesa_id = $4 WHERE id = $5',
      [data, valor, forma, despesaId, conta.id]);
    return { ok: true, despesaId, valor };
  });
  res.json(r);
}));

// Desfazer pagamento (lançou errado): apaga a despesa e a conta volta a ficar em aberto.
app.post('/api/lojas/:lojaId/contas-pagar/:id/desfazer', admin, rota(async (req, res) => {
  await transacao(async (c) => {
    const { rows } = await c.query('SELECT id, despesa_id, pago_em FROM contas_pagar WHERE id = $1 AND loja_id = $2 FOR UPDATE', [req.params.id, req.lojaId]);
    if (!rows.length) falha(404, 'conta não encontrada');
    if (!rows[0].pago_em) falha(409, 'Essa conta não está paga');
    await c.query('UPDATE contas_pagar SET pago_em = NULL, valor_pago = NULL, forma_pagamento = NULL, despesa_id = NULL WHERE id = $1', [rows[0].id]);
    if (rows[0].despesa_id) await c.query('DELETE FROM despesas WHERE id = $1 AND loja_id = $2', [rows[0].despesa_id, req.lojaId]);
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
      ncm: soDigitos(it.ncm),
    };
  }).sort((a, b) => (a.variacaoId < b.variacaoId ? -1 : 1));
  const numeroNota = texto(body.numeroNota, 'numeroNota', { obrigatorio: false, max: 30 });
  const chaveNfe = soDigitos(body.chaveNfe);
  if (chaveNfe && chaveNfe.length !== 44) falha(400, 'chave da NF-e deve ter 44 dígitos');
  const fornecedorCnpj = soDigitos(body.fornecedorCnpj);
  const origem = ['manual', 'xml', 'pdf', 'foto'].includes(body.origem) ? body.origem : 'manual';
  // A prazo: as parcelas (boletos) viram contas a pagar, em vez de despesa na hora.
  const parcelas = Array.isArray(body.parcelas) && body.parcelas.length ? lerParcelas(body.parcelas) : null;
  if (parcelas && body.lancarDespesa) falha(400, 'Escolha: pago agora (despesa) ou a prazo (contas a pagar)');

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
    let ncmPreenchidos = 0;
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
      // NCM do XML do fornecedor preenche o produto que ainda não tem (nunca troca um já preenchido).
      if (origem === 'xml' && it.ncm && it.ncm.length === 8) {
        const { rowCount } = await c.query(
          `UPDATE produtos SET ncm = $1 WHERE loja_id = $3 AND id = (SELECT produto_id FROM produto_variacoes WHERE id = $2)
             AND (ncm IS NULL OR ncm !~ '^[0-9]{8}$')`, [it.ncm, it.variacaoId, req.lojaId]);
        ncmPreenchidos += rowCount;
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
    let contas = 0;
    if (parcelas) {
      const desc = 'Compra' + (fornecedorNome ? ' — ' + fornecedorNome : '') + (numeroNota ? ' (nota ' + numeroNota + ')' : '');
      contas = (await criarContas(c, req, { descricao: desc, fornecedorId, compraId, categoria: 'Mercadoria', parcelas })).length;
    }
    return { id: compraId, total, despesaId, fornecedorId, ncmPreenchidos, contas };
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
    `SELECT id, nome, telefone, EXTRACT(DAY FROM nascimento)::int AS dia, NULL AS crianca, NULL AS idade
     FROM clientes WHERE loja_id = $1 AND nascimento IS NOT NULL AND EXTRACT(MONTH FROM nascimento) = $2
     UNION ALL
     SELECT c.id, c.nome, c.telefone, EXTRACT(DAY FROM f.nascimento)::int, f.nome, ($3 - EXTRACT(YEAR FROM f.nascimento))::int
     FROM cliente_filhos f JOIN clientes c ON c.id = f.cliente_id
     WHERE f.loja_id = $1 AND f.nascimento IS NOT NULL AND EXTRACT(MONTH FROM f.nascimento) = $2
     ORDER BY dia, nome`,
    [req.lojaId, mes, Number(req.query.ano) || Number(hojeLoja().slice(0, 4))]
  );
  res.json(rows);
}));

/* ---------- Ponto: Face ID ---------- */
// Mesmo desenho do Jabá. O que fica guardado é o "descritor" (128 números), nunca a foto.
// - Cadastro exige o PIN da própria pessoa e o consentimento (LGPD: dado biométrico sensível).
// - A comparação é feita só aqui no servidor: o navegador manda o rosto da tentativa e nunca
//   recebe o de ninguém — um navegador adulterado não consegue "dizer" que reconheceu alguém.
// - Limitação honesta: não detecta foto/vídeo na frente da câmera (prova de vida). Pra um
//   computador da loja, com a equipe se revezando, basta; não é segurança de banco.
const FACE_LIMIAR = 0.5; // distância máxima pra considerar a mesma pessoa (face-api sugere ~0.6)
function descritorValido(d) { return Array.isArray(d) && d.length === 128 && d.every((n) => typeof n === 'number' && Number.isFinite(n)); }
function distancia(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s); }

app.get('/api/lojas/:lojaId/pontos/faces', qualquer, rota(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, face_consentimento_em FROM usuarios WHERE loja_id = $1 AND ativo AND face_descritores IS NOT NULL', [req.lojaId]);
  res.json(rows.map((r) => ({ usuarioId: r.id, desde: r.face_consentimento_em })));
}));

app.post('/api/lojas/:lojaId/pontos/cadastrar-face', pinLimiter, qualquer, rota(async (req, res) => {
  const { usuarioId, pin, descritores, consentimento } = req.body || {};
  if (consentimento !== true) falha(400, 'Precisa do consentimento da pessoa pra guardar o rosto');
  if (!Array.isArray(descritores) || descritores.length < 1 || descritores.length > 8 || !descritores.every(descritorValido)) falha(400, 'Amostras do rosto inválidas');
  const { rows } = await pool.query('SELECT id, nome, pin_hash FROM usuarios WHERE id = $1 AND loja_id = $2 AND ativo', [usuarioId, req.lojaId]);
  if (!rows.length) falha(404, 'pessoa não encontrada');
  if (!conferirPin(req, rows[0], pin)) falha(401, 'PIN incorreto');
  await pool.query('UPDATE usuarios SET face_descritores = $1, face_consentimento_em = now() WHERE id = $2', [JSON.stringify(descritores), usuarioId]);
  res.json({ ok: true });
}));

// Apagar o rosto: a própria pessoa (com o PIN dela) ou um Administrador.
app.delete('/api/lojas/:lojaId/pontos/cadastrar-face/:usuarioId', qualquer, rota(async (req, res) => {
  const { rows } = await pool.query('SELECT id, nome, pin_hash FROM usuarios WHERE id = $1 AND loja_id = $2', [req.params.usuarioId, req.lojaId]);
  if (!rows.length) falha(404, 'pessoa não encontrada');
  if (req.usuario.papel !== 'administrador' && !conferirPin(req, rows[0], (req.body || {}).pin)) falha(401, 'PIN incorreto');
  await pool.query('UPDATE usuarios SET face_descritores = NULL, face_consentimento_em = NULL WHERE id = $1', [req.params.usuarioId]);
  res.json({ ok: true });
}));

// Bater ponto. PIN: a própria pessoa digita o dela (ninguém bate pelo colega). Face ID: o
// navegador manda só o descritor do rosto na câmera e o servidor descobre quem é.
// O reconhecimento tenta a cada 1–2 s enquanto a câmera está ligada: tem limite próprio (achar um
// rosto "no chute" com 128 números é impraticável); o PIN continua com o limite apertado.
const limiteFace = rateLimit({ windowMs: 60 * 1000, max: 90, message: { erro: 'Muitas tentativas do Face ID — aguarde um minuto.' }, ...porVisitante });
const limitePonto = (req, res, next) => ((req.body || {}).metodo === 'facial' ? limiteFace : pinLimiter)(req, res, next);
app.post('/api/lojas/:lojaId/pontos', limitePonto, qualquer, rota(async (req, res) => {
  const body = req.body || {};
  if (!['pin', 'facial'].includes(body.metodo)) falha(400, 'metodo deve ser pin ou facial');
  let usuarioId = body.usuarioId;
  if (body.metodo === 'facial') {
    if (!descritorValido(body.descritor)) falha(400, 'Rosto inválido');
    const { rows: comRosto } = await pool.query('SELECT id, face_descritores FROM usuarios WHERE loja_id = $1 AND ativo AND face_descritores IS NOT NULL', [req.lojaId]);
    let melhor = null;
    for (const u of comRosto) {
      for (const amostra of u.face_descritores || []) {
        if (!descritorValido(amostra)) continue;
        const d = distancia(body.descritor, amostra);
        if (!melhor || d < melhor.d) melhor = { id: u.id, d };
      }
    }
    if (!melhor || melhor.d > FACE_LIMIAR) return res.json({ ok: false, motivo: 'nao_reconhecido' });
    usuarioId = melhor.id;
  }
  const r = await transacao(async (c) => {
    const { rows } = await c.query('SELECT id, nome, pin_hash FROM usuarios WHERE id = $1 AND loja_id = $2 AND ativo FOR UPDATE', [usuarioId, req.lojaId]);
    const pessoa = rows[0];
    if (!pessoa) falha(404, 'pessoa não encontrada');
    if (body.metodo === 'pin' && !conferirPin(req, pessoa, body.pin)) falha(401, 'PIN incorreto');
    // Câmera vê a mesma pessoa de novo logo em seguida: não bate duas vezes.
    if (body.metodo === 'facial') {
      const { rows: recente } = await c.query(
        "SELECT tipo, registrado_em FROM pontos WHERE usuario_id = $1 AND registrado_em > now() - interval '2 minutes' ORDER BY registrado_em DESC LIMIT 1", [pessoa.id]);
      if (recente.length) return { ok: true, repetido: true, usuarioId: pessoa.id, nome: pessoa.nome, tipo: recente[0].tipo, registradoEm: recente[0].registrado_em };
    }
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
    return { ok: true, usuarioId: pessoa.id, nome: pessoa.nome, tipo, registradoEm: novo[0].registrado_em };
  });
  res.status(r.repetido ? 200 : 201).json(r);
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

const limitePedidoSite = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: { erro: 'Muitos pedidos seguidos — aguarde alguns minutos ou chame a loja no WhatsApp.' }, ...porVisitante });

async function configSite(db, lojaId) {
  const { rows } = await db.query('SELECT nome, site_ativo, aceita_entrega, aceita_retirada, taxa_entrega, whatsapp, endereco, mensagem_site, pagamento_config, envio_config, google_avaliacao_url, troca_dias_loja, troca_dias_site FROM lojas WHERE id = $1', [lojaId]);
  if (!rows.length) falha(404, 'loja não encontrada');
  const l = rows[0];
  const pg = mesclarPagamento(l.pagamento_config), ev = frete.mesclarConfig(l.envio_config);
  const pix = pg.pix && mp.configurado(), cartao = pg.cartao && mp.configurado();
  return { nome: l.nome, ativo: l.site_ativo, aceitaEntrega: l.aceita_entrega, aceitaRetirada: l.aceita_retirada, taxaEntrega: Number(l.taxa_entrega),
    whatsapp: l.whatsapp || '', endereco: l.endereco || '', mensagem: l.mensagem_site || '', avaliacaoGoogle: l.google_avaliacao_url || '',
    trocaDiasSite: l.troca_dias_site, trocaDiasLoja: l.troca_dias_loja,
    // naEntrega cai pra true se nenhuma forma online estiver de pé (nunca deixa o site sem como pagar)
    pagamento: { pix, cartao, naEntrega: pg.naEntrega || (!pix && !cartao), maxParcelas: pg.maxParcelas, minutosPagar: pg.minutosPagar },
    envio: { ativo: ev.ativo && !!ev.cepOrigem && frete.configurado() && (pix || cartao), freteGratisAcima: ev.freteGratisAcima },
    _envio: ev };
}

// Catálogo do site: só produto ativo + publicado. Estoque aparece limitado a 10 (o cliente só
// precisa saber se tem e se são as últimas peças) e custo nunca sai daqui.
app.get('/api/lojas/:lojaId/loja/catalogo', rota(async (req, res) => {
  const { _envio, ...config } = await configSite(pool, req.lojaId);
  if (!config.ativo) return res.json({ config, produtos: [] });
  const { rows: produtos } = await pool.query(
    `SELECT p.id, p.nome, p.categoria, p.genero, p.descricao, g.tamanhos AS grade_tamanhos
     FROM produtos p LEFT JOIN grades_tamanho g ON g.id = p.grade_tamanho_id
     WHERE p.loja_id = $1 AND p.ativo AND p.publicado ORDER BY p.criado_em DESC`, [req.lojaId]);
  const { rows: variacoes } = await pool.query(
    `SELECT v.id, v.produto_id, v.tamanho, v.cor, v.preco_venda, LEAST(GREATEST(v.estoque, 0), 10)::int AS disponivel
     FROM produto_variacoes v JOIN produtos p ON p.id = v.produto_id
     WHERE v.loja_id = $1 AND v.ativo AND p.ativo AND p.publicado AND v.preco_venda > 0`, [req.lojaId]);
  const fotos = await fotosDosProdutos(req.lojaId);
  const promos = await promocoes.ativas(pool, req.lojaId, TZ);
  const catDe = Object.fromEntries(produtos.map((p) => [p.id, p.categoria]));
  const porProduto = {};
  variacoes.forEach((v) => {
    const pr = promocoes.precoComPromo(promos, v.produto_id, catDe[v.produto_id], v.preco_venda);
    (porProduto[v.produto_id] = porProduto[v.produto_id] || []).push({ id: v.id, tamanho: v.tamanho, cor: v.cor, preco: pr.preco, disponivel: v.disponivel,
      ...(pr.promo ? { precoCheio: pr.precoCheio, promocao: pr.promo.nome, promocaoAte: pr.promo.fim } : {}) });
  });
  res.set('Cache-Control', 'no-store');
  res.json({
    config,
    produtos: produtos.map((p) => {
      const vs = porProduto[p.id] || [];
      const ordem = p.grade_tamanhos || [];
      vs.sort((a, b) => ((ordem.indexOf(a.tamanho) + 1 || 999) - (ordem.indexOf(b.tamanho) + 1 || 999)) || a.cor.localeCompare(b.cor));
      return { id: p.id, nome: p.nome, categoria: p.categoria || '', genero: p.genero || '', descricao: p.descricao || '', fotos: fotos[p.id] || [], variacoes: vs };
    }).filter((p) => p.variacoes.some((v) => v.disponivel > 0)),
  });
}));

const STATUS_LABEL = { aguardando_pagamento: 'Aguardando pagamento', recebido: 'Recebido', separando: 'Separando as peças', pronto: 'Pronto', saiu_entrega: 'Saiu para entrega', entregue: 'Concluído', cancelado: 'Cancelado' };
function rotuloStatus(p) { return p.tipo === 'envio' && p.status === 'saiu_entrega' ? 'Enviado' : STATUS_LABEL[p.status]; }

// Itens da sacola → [{ variacaoId, qtd }] (somando linhas repetidas, ordenado pra travar sempre na mesma ordem).
function lerItensSacola(lista) {
  if (!Array.isArray(lista) || !lista.length || lista.length > 30) falha(400, 'Sacola vazia');
  const porVariacao = new Map();
  for (const it of lista) {
    if (!it || typeof it.variacaoId !== 'string' || it.variacaoId.length > 40) falha(400, 'Item inválido');
    const qtd = numero(it.qtd, 'quantidade', { minExclusivo: true, inteiro: true, max: 20 });
    porVariacao.set(it.variacaoId, (porVariacao.get(it.variacaoId) || 0) + qtd);
  }
  return [...porVariacao].map(([variacaoId, qtd]) => ({ variacaoId, qtd })).sort((a, b) => (a.variacaoId < b.variacaoId ? -1 : 1));
}
// Subtotal da sacola (com promoção), sem travar nada — pra cotar o frete antes do pedido.
async function subtotalSacola(lojaId, itens) {
  const promos = await promocoes.ativas(pool, lojaId, TZ);
  const { rows } = await pool.query(
    `SELECT v.id, v.preco_venda, p.id AS produto_id, p.categoria FROM produto_variacoes v JOIN produtos p ON p.id = v.produto_id
     WHERE v.id = ANY($1) AND v.loja_id = $2 AND v.ativo AND p.ativo AND p.publicado`, [itens.map((i) => i.variacaoId), lojaId]);
  const porId = Object.fromEntries(rows.map((r) => [r.id, r]));
  let subtotal = 0;
  for (const it of itens) {
    const v = porId[it.variacaoId];
    if (!v) falha(409, 'Uma das peças não está mais disponível — atualize a página', { codigo: 'peca_indisponivel', variacaoId: it.variacaoId });
    subtotal = round2(subtotal + promocoes.precoComPromo(promos, v.produto_id, v.categoria, v.preco_venda).preco * it.qtd);
  }
  return { subtotal, pecas: itens.reduce((t, i) => t + i.qtd, 0) };
}

const limiteFrete = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, message: { erro: 'Muitas consultas de frete seguidas — aguarde alguns minutos.' }, ...porVisitante });
// Corpo: { cep, itens } → endereço do CEP, se a entrega da loja atende e as opções de envio.
app.post('/api/lojas/:lojaId/loja/frete', limiteFrete, rota(async (req, res) => {
  const body = req.body || {};
  const config = await configSite(pool, req.lojaId);
  const end = await frete.endereco(body.cep).catch((e) => { throw new ErroApi(e.status || 502, e.message); });
  const entregaLocal = config.aceitaEntrega && frete.entregaLocalAtende(config._envio, end.cidade);
  let opcoes = [], erroEnvio = null;
  if (config.envio.ativo) {
    const { subtotal, pecas } = await subtotalSacola(req.lojaId, lerItensSacola(body.itens));
    try { opcoes = await frete.cotar(config._envio, end.cep, pecas, subtotal); } catch (e) { erroEnvio = e.message; }
  }
  res.json({ endereco: end, entregaLocal: entregaLocal ? { taxa: config.taxaEntrega } : null, opcoes, erroEnvio });
}));

// Prévia do pedido (o robô do WhatsApp mostra antes de o cliente confirmar — igual ao Jabá):
// peças com o preço de verdade (promoção incluída), taxa, total e troco. Não reserva nada.
// Corpo: { itens, tipo: 'retirada'|'entrega', pagamento?, trocoPara? }
app.post('/api/lojas/:lojaId/loja/pedidos/previa', limiteFrete, rota(async (req, res) => {
  const body = req.body || {};
  const itens = lerItensSacola(body.itens);
  const config = await configSite(pool, req.lojaId);
  if (!['retirada', 'entrega'].includes(body.tipo)) falha(400, 'Escolha retirada ou entrega');
  const promos = await promocoes.ativas(pool, req.lojaId, TZ);
  const { rows } = await pool.query(
    `SELECT v.id, v.tamanho, v.cor, v.estoque, v.preco_venda, p.id AS produto_id, p.nome, p.categoria FROM produto_variacoes v JOIN produtos p ON p.id = v.produto_id
     WHERE v.id = ANY($1) AND v.loja_id = $2 AND v.ativo AND p.ativo AND p.publicado AND v.preco_venda > 0`, [itens.map((i) => i.variacaoId), req.lojaId]);
  const porId = Object.fromEntries(rows.map((r) => [r.id, r]));
  let subtotal = 0;
  const linhas = [], problemas = [];
  for (const it of itens) {
    const v = porId[it.variacaoId];
    if (!v) { problemas.push({ variacaoId: it.variacaoId, motivo: 'peça não está mais à venda' }); continue; }
    const pr = promocoes.precoComPromo(promos, v.produto_id, v.categoria, v.preco_venda);
    if (Number(v.estoque) < it.qtd) problemas.push({ variacaoId: v.id, motivo: 'só tem ' + Math.max(0, Number(v.estoque)) + ' de ' + v.nome + ' ' + v.tamanho });
    subtotal = round2(subtotal + pr.preco * it.qtd);
    linhas.push({ variacaoId: v.id, produto: v.nome, tamanho: v.tamanho, cor: v.cor || undefined, qtd: it.qtd, preco: pr.preco,
      ...(pr.promo ? { precoSemPromocao: pr.precoCheio, promocao: pr.promo.nome } : {}) });
  }
  const taxaEntrega = body.tipo === 'entrega' ? config.taxaEntrega : 0;
  const total = round2(subtotal + taxaEntrega);
  let pagaCom = null, troco = null;
  if (body.pagamento === 'Dinheiro' && body.trocoPara != null && body.trocoPara !== '') {
    pagaCom = Number(String(body.trocoPara).replace(/[^\d,.]/g, '').replace(',', '.'));
    if (Number.isFinite(pagaCom) && pagaCom > 0) troco = round2(Math.max(0, pagaCom - total)); else pagaCom = null;
  }
  res.json({ itens: linhas, subtotal, taxaEntrega, total, ...(pagaCom != null ? { pagaCom, troco, trocoSuficiente: pagaCom >= total } : {}), problemas });
}));

// Frete pra venda feita pela equipe (não depende do site estar com pagamento online ligado).
app.post('/api/lojas/:lojaId/pedidos-online/frete', qualquer, rota(async (req, res) => {
  const body = req.body || {};
  const config = await configSite(pool, req.lojaId);
  const end = await frete.endereco(body.cep).catch((e) => { throw new ErroApi(e.status || 502, e.message); });
  const ev = config._envio;
  let opcoes = [], erroEnvio = null;
  if (ev.ativo && ev.cepOrigem && frete.configurado()) {
    const { subtotal, pecas } = await subtotalSacola(req.lojaId, lerItensSacola(body.itens));
    try { opcoes = await frete.cotar(ev, end.cep, pecas, subtotal); } catch (e) { erroEnvio = e.message; }
  } else erroEnvio = 'Envio pelos Correios não está configurado (Configurações → Envio)';
  res.json({ endereco: end, entregaLocal: frete.entregaLocalAtende(ev, end.cidade) ? { taxa: config.taxaEntrega } : null, opcoes, erroEnvio,
    pagamentoOnline: { pix: config.pagamento.pix, cartao: config.pagamento.cartao } });
}));

function urlSite(req) { return (process.env.SITE_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, ''); }
function urlNotificacao(lojaId) {
  const site = (process.env.SITE_URL || '').replace(/\/+$/, '');
  return /^https:\/\//.test(site) ? site + '/api/lojas/' + lojaId + '/loja/pagamentos/webhook' : null;
}

// Pedido do site. Preço e total SEMPRE calculados aqui (nunca confiados do navegador) e as peças
// ficam reservadas na hora. Telefone vira (ou encontra) o cadastro do cliente — ganha cashback.
// Pago pelo site (pagamentoOnline 'pix' | 'cartao'): nasce "aguardando_pagamento" e só vira pedido
// de verdade quando o Mercado Pago confirma. Envio pelos Correios (tipo 'envio') exige pagar online.
app.post('/api/lojas/:lojaId/loja/pedidos', limitePedidoSite, rota((req, res) => criarPedidoOnline(req, res, {})));

// Pedido feito pela equipe (venda pelo WhatsApp/Instagram pra mandar pra fora): mesmo caminho do
// site, mas pode marcar "pagamento já recebido direto" (Pix na conta da loja) e não depende do site
// estar aberto.
app.post('/api/lojas/:lojaId/pedidos-online', qualquer, rota((req, res) => criarPedidoOnline(req, res, { equipe: true })));

async function criarPedidoOnline(req, res, { equipe }) {
  const body = req.body || {};
  const nome = texto(body.nome, equipe ? 'Nome do cliente' : 'Seu nome', { max: 100 });
  const telefone = soDigitos(body.telefone) || '';
  if (telefone.length < 10 || telefone.length > 11) falha(400, 'Telefone com DDD, só números (ex.: 84 99999-8888)');
  if (!['entrega', 'retirada', 'envio'].includes(body.tipo)) falha(400, 'Escolha como quer receber');
  const online = ['pix', 'cartao'].includes(body.pagamentoOnline) ? body.pagamentoOnline : null;
  const pagoManual = !!(equipe && body.pagoManual && !online);
  if (!online && !['Pix', 'Dinheiro', 'Débito', 'Crédito'].includes(body.pagamento)) falha(400, 'Escolha a forma de pagamento');
  const origem = equipe ? (['whatsapp', 'instagram', 'loja'].includes(body.origem) ? body.origem : 'whatsapp') : body.origem === 'whatsapp' ? 'whatsapp' : 'site';
  const observacao = texto(body.observacao, 'Observação', { obrigatorio: false, max: 300 });
  const itens = lerItensSacola(body.itens);
  const config = await configSite(pool, req.lojaId);
  if (body.tipo === 'envio' && !online && !pagoManual) falha(400, 'Pra enviar pelos Correios, o pagamento é feito pelo site (Pix ou cartão)' + (equipe ? ' ou marcado como já recebido' : ''));
  if (online && !config.pagamento[online]) falha(400, 'Essa forma de pagamento pelo site não está disponível agora' + (equipe ? ' (ligue em Configurações → Pagamento pelo site)' : ''));
  if (!online && !config.pagamento.naEntrega && origem === 'site') falha(400, 'O pagamento é feito pelo site (Pix ou cartão)');
  let email = null;
  if (online) {
    email = texto(body.email, 'E-mail (pro comprovante do pagamento)', { max: 120 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) falha(400, 'E-mail inválido');
  }

  // Endereço: com CEP, cidade/UF vêm do próprio CEP (não do navegador).
  let endereco = null, cep = null, cidade = null, uf = null, envio = null;
  if (body.tipo !== 'retirada') {
    endereco = texto(body.endereco, 'Endereço de entrega', { max: 300 });
    cep = body.cep ? frete.soCep(body.cep) : null;
    if (body.cep && !cep) falha(400, 'CEP precisa ter 8 números');
    if (body.tipo === 'envio' && !cep) falha(400, 'Digite o CEP pra calcular o envio');
    if (cep) {
      const end = await frete.endereco(cep).catch((e) => { throw new ErroApi(e.status || 502, e.message); });
      cidade = end.cidade; uf = end.uf;
    }
    if (body.tipo === 'entrega' && cidade && !frete.entregaLocalAtende(config._envio, cidade)) {
      falha(400, 'A entrega da loja não atende ' + cidade + (config.envio.ativo ? ' — escolha o envio pelos Correios' : ''));
    }
    if (body.tipo === 'envio') {
      if (!config.envio.ativo && !(equipe && config._envio.ativo && config._envio.cepOrigem && frete.configurado())) falha(400, 'Envio pelos Correios indisponível agora' + (equipe ? ' (ligue em Configurações → Envio)' : ''));
      const servicoId = String((body.envio && body.envio.servicoId) || '');
      const { subtotal: previa, pecas } = await subtotalSacola(req.lojaId, itens);
      const opcoes = await frete.cotar(config._envio, cep, pecas, previa).catch((e) => { throw new ErroApi(e.status || 502, e.message); });
      envio = opcoes.find((o) => o.id === servicoId);
      if (!envio) falha(409, 'Essa opção de frete mudou — escolha de novo', { codigo: 'frete_mudou' });
    }
  }

  const r = await transacao(async (c) => {
    const config = await configSite(c, req.lojaId);
    if (!equipe) {
      if (!config.ativo) falha(403, 'A loja não está recebendo pedidos pelo site agora');
      if (body.tipo === 'entrega' && !config.aceitaEntrega) falha(400, 'A loja não está fazendo entregas agora');
      if (body.tipo === 'retirada' && !config.aceitaRetirada) falha(400, 'Retirada na loja indisponível agora');
    }
    let subtotal = 0;
    const gravar = [];
    const promos = await promocoes.ativas(c, req.lojaId, TZ);
    for (const it of itens) {
      const { rows } = await c.query(
        `SELECT v.id, v.tamanho, v.cor, v.estoque, v.preco_venda, v.custo_unitario, p.nome AS produto_nome, p.id AS produto_id, p.categoria
         FROM produto_variacoes v JOIN produtos p ON p.id = v.produto_id
         WHERE v.id = $1 AND v.loja_id = $2 AND v.ativo AND p.ativo AND p.publicado AND v.preco_venda > 0 FOR UPDATE OF v`,
        [it.variacaoId, req.lojaId]);
      const v = rows[0];
      if (!v) falha(409, 'Uma das peças não está mais disponível — atualize a página', { codigo: 'peca_indisponivel', variacaoId: it.variacaoId });
      if (Number(v.estoque) < it.qtd) {
        falha(409, 'Só temos ' + Math.max(0, Number(v.estoque)) + ' de ' + v.produto_nome + ' ' + v.tamanho + (v.cor ? ' ' + v.cor : ''),
          { codigo: 'estoque_insuficiente', variacaoId: v.id, disponivel: Math.max(0, Number(v.estoque)) });
      }
      const pr = promocoes.precoComPromo(promos, v.produto_id, v.categoria, v.preco_venda);
      const preco = pr.preco;
      subtotal = round2(subtotal + preco * it.qtd);
      gravar.push({ ...it, preco, precoCheio: pr.precoCheio, promocaoId: pr.promo ? pr.promo.id : null, custo: Number(v.custo_unitario), produtoNome: v.produto_nome, tamanho: v.tamanho, cor: v.cor });
    }
    const taxa = body.tipo === 'entrega' ? config.taxaEntrega : body.tipo === 'envio' ? envio.preco : 0;
    const total = round2(subtotal + taxa);
    let trocoPara = null;
    if (!online && body.pagamento === 'Dinheiro' && body.trocoPara != null && body.trocoPara !== '') {
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
    const pagamento = online ? (online === 'pix' ? 'Pix' : 'Crédito') : body.pagamento;
    const expira = online ? new Date(Date.now() + config.pagamento.minutosPagar * 60000) : null;
    await c.query(
      `INSERT INTO pedidos_online (id, loja_id, numero, token, cliente_id, cliente_nome, telefone, tipo, endereco, pagamento, troco_para, observacao, subtotal, taxa_entrega, total, origem,
         status, pago_online, pag_metodo, pag_status, pag_expira_em, email, cep, cidade, uf, envio_servico_id, envio_servico, envio_prazo_dias, pago_em, pag_nota)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
      [id, req.lojaId, numeroPedido, token, clienteId, nome, telefone, body.tipo, endereco, pagamento, trocoPara, observacao, subtotal, taxa, total, origem,
        online ? 'aguardando_pagamento' : 'recebido', !!online, online, online ? 'aguardando' : pagoManual ? 'pago' : null, expira, email, cep, cidade, uf,
        envio ? envio.id : null, envio ? envio.nome : null, envio ? envio.prazo : null,
        pagoManual ? new Date() : null, pagoManual ? 'Pagamento (' + pagamento + ') recebido direto pela loja — confirmado por ' + req.usuario.nome : null]);
    for (const it of gravar) {
      await c.query('INSERT INTO pedidos_online_itens (id, pedido_id, variacao_id, produto_nome, tamanho, cor, qtd, preco_unit, preco_cheio, promocao_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [uid(), id, it.variacaoId, it.produtoNome, it.tamanho, it.cor, it.qtd, it.preco, it.precoCheio, it.promocaoId]);
      await c.query('UPDATE produto_variacoes SET estoque = estoque - $1 WHERE id = $2', [it.qtd, it.variacaoId]);
      await c.query(
        `INSERT INTO movimentos_estoque_produto (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, referencia_id, observacao)
         VALUES ($1,$2,$3,'venda',$4,$5,$6,'pedido_online',$7,'Reservado pelo pedido online')`,
        [uid(), req.lojaId, it.variacaoId, -it.qtd, it.custo, round2(it.custo * it.qtd), id]);
    }
    // Presente de lista (chá de bebê): marca na lista o que esse pedido tem dela.
    if (body.lista && typeof body.lista === 'object' && typeof body.lista.token === 'string') {
      const { rows: ls } = await c.query('SELECT id, titulo FROM listas_presentes WHERE token = $1 AND loja_id = $2 AND ativa', [body.lista.token, req.lojaId]);
      if (ls.length) {
        const deQuem = texto(body.lista.deQuem, 'seu nome no presente', { obrigatorio: false, max: 80 }) || nome;
        await registrarPresentes(c, ls[0].id, gravar.map((it) => ({ variacaoId: it.variacaoId, qtd: it.qtd })), { pedidoId: id }, deQuem,
          texto(body.lista.mensagem, 'mensagem do presente', { obrigatorio: false, max: 300 }));
        await c.query('UPDATE pedidos_online SET lista_id = $1, presente_de = $2 WHERE id = $3', [ls[0].id, deQuem, id]);
      }
    }
    return { id, numero: numeroPedido, token, total, taxa, gravar, expira, maxParcelas: config.pagamento.maxParcelas };
  });

  if (!online) {
    notificarBot(req.lojaId, r.id, 'recebido');
    return res.status(201).json({ numero: r.numero, token: r.token, total: r.total, ...(equipe ? { linkPedido: urlSite(req) + '/loja-gutto.html#pedido=' + r.token } : {}) });
  }
  // Gera a cobrança no Mercado Pago. Se não der, desfaz o pedido (as peças voltam) e avisa.
  let pagamento;
  try {
    if (online === 'pix') {
      const pix = await mp.criarPix({ referencia: r.id, valor: r.total, descricao: 'Pedido #' + r.numero + ' - ' + config.nome, email, nome,
        expiraEm: r.expira, notificacaoUrl: urlNotificacao(req.lojaId) });
      await pool.query('UPDATE pedidos_online SET mp_pagamento_id = $1, pix_copia_cola = $2, pix_qr_base64 = $3 WHERE id = $4', [pix.id, pix.copiaCola, pix.qrBase64, r.id]);
      pagamento = { metodo: 'pix', pix: { copiaCola: pix.copiaCola, qrBase64: pix.qrBase64 }, expiraEm: r.expira };
    } else {
      const ck = await mp.criarCheckoutCartao({ referencia: r.id, email, nome, frete: r.taxa, maxParcelas: r.maxParcelas, expiraEm: r.expira,
        itens: r.gravar.map((it) => ({ id: it.variacaoId, titulo: it.produtoNome + ' Tam ' + it.tamanho + (it.cor ? ' ' + it.cor : ''), qtd: it.qtd, preco: it.preco })),
        voltarUrl: urlSite(req) + '/loja-gutto.html#pedido=' + r.token, notificacaoUrl: urlNotificacao(req.lojaId) });
      await pool.query('UPDATE pedidos_online SET mp_preferencia_url = $1 WHERE id = $2', [ck.url, r.id]);
      pagamento = { metodo: 'cartao', checkoutUrl: ck.url, expiraEm: r.expira };
    }
  } catch (e) {
    console.error('Mercado Pago (pedido ' + r.numero + '):', e.message);
    await transacao((c) => cancelarPedidoTx(c, req.lojaId, r.id, 'Não foi possível gerar o pagamento', null, 'expirado')).catch((e2) => console.error(e2));
    falha(502, 'Não consegui gerar o pagamento agora. Tente de novo em instantes' + (config.pagamento.naEntrega && body.tipo !== 'envio' ? ' ou escolha pagar na ' + (body.tipo === 'retirada' ? 'retirada' : 'entrega') : '') + '.');
  }
  res.status(201).json({ numero: r.numero, token: r.token, total: r.total, pagamento, ...(equipe ? { linkPedido: urlSite(req) + '/loja-gutto.html#pedido=' + r.token } : {}) });
}

async function detalhePedido(db, where, params) {
  const { rows } = await db.query(`SELECT po.*, lp.titulo AS lista_titulo FROM pedidos_online po LEFT JOIN listas_presentes lp ON lp.id = po.lista_id WHERE ${where.replace(/\b(id|token|loja_id)\b/g, 'po.$1')}`, params);
  if (!rows.length) return null;
  const p = rows[0];
  const { rows: itens } = await db.query('SELECT variacao_id, produto_nome, tamanho, cor, qtd, preco_unit, preco_cheio, promocao_id FROM pedidos_online_itens WHERE pedido_id = $1 ORDER BY produto_nome, tamanho', [p.id]);
  return { ...p, subtotal: Number(p.subtotal), taxa_entrega: Number(p.taxa_entrega), total: Number(p.total), troco_para: p.troco_para == null ? null : Number(p.troco_para),
    itens: itens.map((i) => ({ ...i, preco_unit: Number(i.preco_unit) })) };
}

// Acompanhamento pelo link que o cliente recebe (token aleatório; sem telefone/endereço na resposta).
app.get('/api/lojas/:lojaId/loja/pedidos/:token', rota(async (req, res) => {
  if (!/^[A-Za-z0-9_-]{10,60}$/.test(req.params.token)) falha(404, 'Pedido não encontrado');
  let p = await detalhePedido(pool, 'token = $1 AND loja_id = $2', [req.params.token, req.lojaId]);
  if (!p) falha(404, 'Pedido não encontrado');
  // Esperando pagamento: confere no Mercado Pago (no máximo a cada poucos segundos por pedido).
  if (p.status === 'aguardando_pagamento') {
    await sincronizarPagamento(req.lojaId, p.id, { volta: req.query.voltou === '1' }).catch((e) => console.error('Conferir pagamento:', e.message));
    p = await detalhePedido(pool, 'token = $1 AND loja_id = $2', [req.params.token, req.lojaId]);
  }
  res.set('Cache-Control', 'no-store');
  const esperando = p.status === 'aguardando_pagamento';
  res.json({ numero: p.numero, status: p.status, statusLabel: rotuloStatus(p), tipo: p.tipo, pagamento: p.pagamento, clienteNome: p.cliente_nome.split(' ')[0],
    itens: p.itens.map((i) => ({ produtoNome: i.produto_nome, tamanho: i.tamanho, cor: i.cor, qtd: i.qtd, precoUnit: i.preco_unit })),
    subtotal: p.subtotal, taxaEntrega: p.taxa_entrega, total: p.total, criadoEm: p.criado_em, atualizadoEm: p.atualizado_em,
    online: p.pago_online ? { metodo: p.pag_metodo, status: p.pag_status, pagoEm: p.pago_em, expiraEm: esperando ? p.pag_expira_em : null, parcelas: p.pag_parcelas,
      pix: esperando && p.pag_metodo === 'pix' ? { copiaCola: p.pix_copia_cola, qrBase64: p.pix_qr_base64 } : null,
      checkoutUrl: esperando && p.pag_metodo === 'cartao' ? p.mp_preferencia_url : null, nota: p.pag_nota } : null,
    envio: p.tipo === 'envio' ? { servico: p.envio_servico, prazoDias: p.envio_prazo_dias, rastreio: p.rastreio, cidade: p.cidade, uf: p.uf } : null });
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
  res.json(lista.map(({ token, pix_qr_base64, pix_copia_cola, mp_preferencia_url, ...p }) => p));
}));

app.get('/api/lojas/:lojaId/pedidos-online/contagem', qualquer, rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'recebido')::int AS novos, COUNT(*) FILTER (WHERE status NOT IN ('entregue', 'cancelado'))::int AS abertos,
            MAX(numero) AS ultimo FROM pedidos_online WHERE loja_id = $1`, [req.lojaId]);
  res.json(rows[0]);
}));

/* ---------- Entregadores ---------- */
function dadosEntregador(body) {
  const nome = texto(body.nome, 'nome do entregador', { max: 60 });
  const whatsapp = soDigitos(body.whatsapp) || null;
  if (whatsapp && (whatsapp.length < 10 || whatsapp.length > 11)) falha(400, 'WhatsApp do entregador: DDD + número (ex.: 84999998888)');
  return { nome, whatsapp };
}
app.get('/api/lojas/:lojaId/entregadores', qualquer, rota(async (req, res) => {
  const { rows } = await pool.query('SELECT id, nome, whatsapp FROM entregadores WHERE loja_id = $1 AND ativo ORDER BY nome', [req.lojaId]);
  res.json(rows);
}));
app.post('/api/lojas/:lojaId/entregadores', admin, rota(async (req, res) => {
  const d = dadosEntregador(req.body || {});
  const id = uid();
  await pool.query('INSERT INTO entregadores (id, loja_id, nome, whatsapp) VALUES ($1,$2,$3,$4)', [id, req.lojaId, d.nome, d.whatsapp]);
  res.status(201).json({ id, ...d });
}));
app.put('/api/lojas/:lojaId/entregadores/:id', admin, rota(async (req, res) => {
  const d = dadosEntregador(req.body || {});
  const { rowCount } = await pool.query('UPDATE entregadores SET nome = $1, whatsapp = $2 WHERE id = $3 AND loja_id = $4', [d.nome, d.whatsapp, req.params.id, req.lojaId]);
  if (!rowCount) falha(404, 'entregador não encontrado');
  res.json({ ok: true });
}));
app.delete('/api/lojas/:lojaId/entregadores/:id', admin, rota(async (req, res) => {
  await pool.query('UPDATE entregadores SET ativo = false WHERE id = $1 AND loja_id = $2', [req.params.id, req.lojaId]);
  res.json({ ok: true });
}));

// Mensagem pro entregador: cliente, telefone, endereço com mapa e quanto receber.
function textoEntregador(p, entregador) {
  const receber = p.pag_status === 'pago' ? 'Já está PAGO — não cobrar nada.'
    : p.pagamento === 'Dinheiro' ? `Receber ${brlTexto(p.total)} em DINHEIRO${p.troco_para ? ` (cliente paga com ${brlTexto(p.troco_para)} — levar ${brlTexto(round2(p.troco_para - p.total))} de troco)` : ''}.`
    : `Receber ${brlTexto(p.total)} no ${p.pagamento === 'Pix' ? 'Pix' : 'cartão (' + p.pagamento.toLowerCase() + ') — levar a maquininha'}.`;
  const pecas = p.itens.reduce((t, i) => t + i.qtd, 0);
  return `Oi, ${entregador.nome.split(' ')[0]}! 🛵 Entrega da Loja Gutto — pedido #${p.numero}\n\n`
    + `Cliente: ${p.cliente_nome}\nTelefone: ${p.telefone}\nEndereço: ${p.endereco}\n`
    + `Mapa: https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.endereco || '')}\n\n`
    + `${pecas} peça${pecas === 1 ? '' : 's'}. ${receber}`;
}
function brlTexto(v) { return 'R$ ' + Number(v).toFixed(2).replace('.', ','); }

// Manda pelo número do robô (sem precisar clicar "enviar"). A conversa com o entregador fica pausada
// pro robô (ele não é cliente). Bot desligado: devolve o link wa.me pra mandar pelo celular.
async function avisarEntregador(p, entregador) {
  const texto = textoEntregador(p, entregador);
  const linkManual = 'https://wa.me/55' + entregador.whatsapp + '?text=' + encodeURIComponent(texto);
  if (!process.env.BOT_WEBHOOK_SECRET) return { ok: false, motivo: 'Atendente de WhatsApp não configurado', linkManual };
  try {
    const r = await fetch(BOT_URL + '/enviar-equipe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': process.env.BOT_WEBHOOK_SECRET },
      body: JSON.stringify({ telefoneLocal: entregador.whatsapp, texto, nome: 'Entregador ' + entregador.nome }), signal: AbortSignal.timeout(20000) });
    const d = await r.json().catch(() => ({}));
    return r.ok ? { ok: true } : { ok: false, motivo: d.erro || 'falha ao enviar', linkManual };
  } catch (e) {
    return { ok: false, motivo: 'O atendente de WhatsApp não está rodando', linkManual };
  }
}

const PROXIMO_STATUS = { recebido: ['separando', 'pronto'], separando: ['pronto'], pronto: ['saiu_entrega'] };
app.put('/api/lojas/:lojaId/pedidos-online/:id/status', qualquer, rota(async (req, res) => {
  const body = req.body || {};
  const r = await transacao(async (c) => {
    const { rows } = await c.query('SELECT status, tipo FROM pedidos_online WHERE id = $1 AND loja_id = $2 FOR UPDATE', [req.params.id, req.lojaId]);
    if (!rows.length) falha(404, 'pedido não encontrado');
    const atual = rows[0];
    if (!(PROXIMO_STATUS[atual.status] || []).includes(body.status)) falha(409, 'Esse pedido está "' + STATUS_LABEL[atual.status] + '" — não dá pra mudar pra esse status');
    if (body.status === 'saiu_entrega' && atual.tipo === 'retirada') falha(400, 'Pedido é de retirada na loja');
    let entregador = body.status === 'saiu_entrega' && atual.tipo === 'entrega' ? texto(body.entregador, 'entregador', { obrigatorio: false, max: 60 }) : null;
    let cadastro = null;
    if (body.status === 'saiu_entrega' && atual.tipo === 'entrega' && body.entregadorId) {
      const { rows: es } = await c.query('SELECT id, nome, whatsapp FROM entregadores WHERE id = $1 AND loja_id = $2 AND ativo', [body.entregadorId, req.lojaId]);
      if (!es.length) falha(404, 'entregador não encontrado');
      cadastro = es[0]; entregador = cadastro.nome;
    }
    const rastreio = body.status === 'saiu_entrega' && atual.tipo === 'envio' ? (texto(body.rastreio, 'código de rastreio', { obrigatorio: false, max: 40 }) || '').replace(/\s+/g, '').toUpperCase() || null : null;
    await c.query('UPDATE pedidos_online SET status = $1, entregador = COALESCE($2, entregador), rastreio = COALESCE($4, rastreio), atualizado_em = now() WHERE id = $3',
      [body.status, entregador, req.params.id, rastreio]);
    return { status: body.status, cadastro };
  });
  notificarBot(req.lojaId, req.params.id, r.status);
  let avisoEntregador;
  if (r.cadastro && body.avisarEntregador) {
    if (!r.cadastro.whatsapp) avisoEntregador = { ok: false, motivo: 'Esse entregador não tem WhatsApp cadastrado' };
    else avisoEntregador = await avisarEntregador(await detalhePedido(pool, 'id = $1', [req.params.id]), r.cadastro);
  }
  res.json({ status: r.status, ...(avisoEntregador ? { avisoEntregador } : {}) });
}));

// Concluir = o cliente recebeu e pagou: vira uma venda do caixa aberto (entra no Livro caixa,
// relatórios e cashback). As peças já tinham saído do estoque na reserva.
app.post('/api/lojas/:lojaId/pedidos-online/:id/concluir', qualquer, rota(async (req, res) => {
  const r = await transacao(async (c) => {
    const { rows } = await c.query('SELECT id FROM pedidos_online WHERE id = $1 AND loja_id = $2 FOR UPDATE', [req.params.id, req.lojaId]);
    if (!rows.length) falha(404, 'pedido não encontrado');
    const p = await detalhePedido(c, 'id = $1', [req.params.id]);
    if (['entregue', 'cancelado'].includes(p.status)) falha(409, 'Esse pedido já está ' + STATUS_LABEL[p.status].toLowerCase());
    if (p.status === 'aguardando_pagamento') falha(409, 'Esse pedido ainda não foi pago pelo site');
    const sessao = await sessaoAberta(c, req.lojaId, 'SHARE');
    if (!sessao) falha(409, 'Caixa fechado — abra o caixa no Início pra concluir o pedido', { codigo: 'caixa_fechado' });
    const vendaId = uid();
    await c.query(
      `INSERT INTO vendas (id, loja_id, usuario_id, canal, subtotal, desconto, total, forma_pagamento, caixa_sessao_id, cliente_id, taxa_entrega, pedido_online_id)
       VALUES ($1,$2,$3,'online',$4,0,$5,$6,$7,$8,$9,$10)`,
      [vendaId, req.lojaId, req.usuario.id, p.subtotal, p.total, p.pagamento, sessao.id, p.cliente_id, p.taxa_entrega, p.id]);
    for (const it of p.itens) {
      await c.query(
        `INSERT INTO vendas_itens (id, venda_id, variacao_id, produto_nome, tamanho, cor, qtd, preco_unit, desconto_item, preco_cheio, promocao_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10)`,
        [uid(), vendaId, it.variacao_id, it.produto_nome, it.tamanho, it.cor, it.qtd, it.preco_unit, it.preco_cheio, it.promocao_id]);
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

// Cancela dentro de uma transação: devolve as peças reservadas pro estoque e tira da lista de
// presentes. Pedido pago pelo site: devolve o dinheiro no Mercado Pago ANTES (se o estorno falhar,
// nada é cancelado). `pagStatus`: como fica o pagamento online ('expirado' quando não pagou a tempo).
async function cancelarPedidoTx(c, lojaId, pedidoId, motivo, usuarioId, pagStatus) {
  const { rows } = await c.query('SELECT id FROM pedidos_online WHERE id = $1 AND loja_id = $2 FOR UPDATE', [pedidoId, lojaId]);
  if (!rows.length) falha(404, 'pedido não encontrado');
  const p = await detalhePedido(c, 'id = $1', [pedidoId]);
  if (['entregue', 'cancelado'].includes(p.status)) falha(409, 'Esse pedido já está ' + STATUS_LABEL[p.status].toLowerCase() + (p.status === 'entregue' ? ' — use Troca/devolução na Venda rápida' : ''));
  let novoPag = p.pago_online ? (pagStatus || p.pag_status) : null;
  if (p.pago_online && p.pag_status === 'pago') {
    try { await mp.estornar(p.mp_pagamento_id); } catch (e) { falha(502, 'Não consegui devolver o dinheiro no Mercado Pago (' + e.message + '). O pedido continua de pé — tente de novo.'); }
    novoPag = 'estornado';
  }
  for (const it of [...p.itens].sort((a, b) => (a.variacao_id < b.variacao_id ? -1 : 1))) {
    const { rows: v } = await c.query('SELECT custo_unitario FROM produto_variacoes WHERE id = $1 FOR UPDATE', [it.variacao_id]);
    await c.query('UPDATE produto_variacoes SET estoque = estoque + $1 WHERE id = $2', [it.qtd, it.variacao_id]);
    await c.query(
      `INSERT INTO movimentos_estoque_produto (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, referencia_id, observacao, criado_por)
       VALUES ($1,$2,$3,'devolucao',$4,$5,$6,'pedido_online',$7,'Pedido online cancelado',$8)`,
      [uid(), lojaId, it.variacao_id, it.qtd, Number(v[0].custo_unitario), round2(Number(v[0].custo_unitario) * it.qtd), p.id, usuarioId]);
  }
  await c.query("UPDATE pedidos_online SET status = 'cancelado', motivo_cancelamento = $1, pag_status = $2, atualizado_em = now() WHERE id = $3", [motivo, novoPag, p.id]);
  await desfazerPresentes(c, { pedidoId: p.id });
  return { ...p, pag_status: novoPag };
}

app.post('/api/lojas/:lojaId/pedidos-online/:id/cancelar', admin, rota(async (req, res) => {
  const motivo = texto((req.body || {}).motivo, 'motivo', { obrigatorio: false, max: 200 });
  const p = await transacao((c) => cancelarPedidoTx(c, req.lojaId, req.params.id, motivo, req.usuario.id));
  if (p.status !== 'aguardando_pagamento') notificarBot(req.lojaId, req.params.id, 'cancelado');
  res.json({ ok: true, estornado: p.pag_status === 'estornado' });
}));

/* ---------- Pagamento pelo site (Mercado Pago) ---------- */

// Confere no Mercado Pago se o pedido foi pago. Marca pago (e o pedido entra na fila da loja), ou,
// se pagaram depois que o pedido já tinha expirado, devolve o dinheiro sozinho.
// Devolve { pago, emAnalise } — emAnalise = cartão em análise antifraude (não expira ainda).
const ultimaConferencia = new Map();
async function sincronizarPagamento(lojaId, pedidoId, { forcar, volta } = {}) {
  const agora = Date.now();
  if (!forcar && agora - (ultimaConferencia.get(pedidoId) || 0) < (volta ? 1500 : 4000)) return { pago: false, emAnalise: false, pulou: true };
  ultimaConferencia.set(pedidoId, agora);
  if (ultimaConferencia.size > 5000) ultimaConferencia.delete(ultimaConferencia.keys().next().value);
  const { rows } = await pool.query('SELECT status, pago_online, pag_status, total FROM pedidos_online WHERE id = $1 AND loja_id = $2', [pedidoId, lojaId]);
  if (!rows.length || !rows[0].pago_online || ['pago', 'estornado'].includes(rows[0].pag_status)) return { pago: rows.length && rows[0].pag_status === 'pago', emAnalise: false };
  const pagamentos = await mp.buscarPorReferencia(pedidoId);
  const total = Number(rows[0].total);
  const aprovado = pagamentos.find((x) => x.status === 'approved' && x.referencia === pedidoId && x.valor >= total - 0.01);
  const emAnalise = pagamentos.some((x) => ['in_process', 'authorized'].includes(x.status));
  if (!aprovado) return { pago: false, emAnalise };
  const r = await transacao(async (c) => {
    const { rows: ps } = await c.query('SELECT status, pag_status, numero FROM pedidos_online WHERE id = $1 FOR UPDATE', [pedidoId]);
    const p = ps[0];
    if (p.status === 'aguardando_pagamento') {
      await c.query(
        `UPDATE pedidos_online SET status = 'recebido', pag_status = 'pago', pago_em = COALESCE($1::timestamptz, now()), mp_pagamento_id = $2, pagamento = $3,
           pag_parcelas = $4, pix_copia_cola = NULL, pix_qr_base64 = NULL, atualizado_em = now() WHERE id = $5`,
        [aprovado.aprovadoEm, aprovado.id, mp.formaDoPagamento(aprovado.tipo), aprovado.parcelas, pedidoId]);
      return 'pago';
    }
    if (p.status === 'cancelado' && p.pag_status !== 'estornado') {
      await mp.estornar(aprovado.id);
      await c.query("UPDATE pedidos_online SET pag_status = 'estornado', mp_pagamento_id = $1, pag_nota = $2 WHERE id = $3",
        [aprovado.id, 'Pagaram depois que o pedido já tinha sido cancelado — o dinheiro foi devolvido automaticamente', pedidoId]);
      return 'estornado';
    }
    return null;
  });
  if (r === 'pago') notificarBot(lojaId, pedidoId, 'recebido');
  return { pago: r === 'pago', emAnalise };
}

// Aviso do Mercado Pago ("caiu um pagamento"): só serve de gatilho — o pagamento é consultado lá.
const limiteWebhook = rateLimit({ windowMs: 60 * 1000, max: 120, ...porVisitante });
app.post('/api/lojas/:lojaId/loja/pagamentos/webhook', limiteWebhook, async (req, res) => {
  const body = req.body || {};
  const tipo = req.query.type || req.query.topic || body.type || body.topic;
  const id = req.query['data.id'] || (body.data && body.data.id) || req.query.id;
  if (!id || !/^[A-Za-z0-9-]{1,40}$/.test(String(id))) return res.status(200).json({ ok: true });
  if (!mp.assinaturaValida(req, id)) return res.status(401).json({ erro: 'assinatura inválida' });
  res.status(200).json({ ok: true });
  if (tipo !== 'payment') return;
  try {
    const pg = await mp.consultar(id);
    if (!pg.referencia) return;
    const { rows } = await pool.query('SELECT id FROM pedidos_online WHERE id = $1 AND loja_id = $2', [pg.referencia, req.lojaId]);
    if (rows.length) await sincronizarPagamento(req.lojaId, rows[0].id, { forcar: true });
  } catch (e) { console.error('Webhook do Mercado Pago:', e.message); }
});

// De minuto em minuto: confere os pedidos esperando pagamento (caso o aviso do Mercado Pago não
// chegue — ex.: sem domínio) e cancela os que passaram do prazo, devolvendo as peças pro estoque.
async function rodarPagamentosPendentes() {
  if (!mp.configurado()) return;
  const { rows } = await pool.query(
    `SELECT id, loja_id, mp_pagamento_id, pag_metodo, (pag_expira_em < now()) AS vencido FROM pedidos_online
     WHERE status = 'aguardando_pagamento' AND criado_em < now() - interval '1 minute' ORDER BY pag_expira_em LIMIT 30`);
  for (const p of rows) {
    try {
      const st = await sincronizarPagamento(p.loja_id, p.id, { forcar: p.vencido });
      if (!p.vencido || st.pago || st.emAnalise) continue;
      if (p.pag_metodo === 'pix' && p.mp_pagamento_id) await mp.cancelar(p.mp_pagamento_id).catch(() => {});
      await transacao((c) => cancelarPedidoTx(c, p.loja_id, p.id, 'Pagamento não foi feito a tempo', null, 'expirado'));
    } catch (e) { console.error('Pedido esperando pagamento ' + p.id + ':', e.message); }
  }
  // Expirou mas a pessoa pagou mesmo assim (Pix já copiado, por exemplo): devolve o dinheiro.
  const { rows: expirados } = await pool.query(
    `SELECT id, loja_id FROM pedidos_online WHERE status = 'cancelado' AND pago_online AND pag_status = 'expirado'
       AND atualizado_em > now() - interval '3 hours' ORDER BY atualizado_em DESC LIMIT 30`);
  for (const p of expirados) await sincronizarPagamento(p.loja_id, p.id).catch((e) => console.error('Pedido expirado ' + p.id + ':', e.message));
}

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

/* ---------- Mensagens pros clientes (aniversário, cashback, novidade) ---------- */
// O sistema sugere; o Administrador revisa (pode editar o texto) e aprova. As aprovadas vão pra
// fila que o serviço bot-whatsapp envia aos poucos. Sem o robô ligado, dá pra mandar uma a uma
// pelo WhatsApp do celular (link wa.me) e marcar como enviada.

function cutucarBot() {
  if (!process.env.BOT_WEBHOOK_SECRET) return Promise.resolve(false);
  return fetch(BOT_URL + '/mensagens/processar', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': process.env.BOT_WEBHOOK_SECRET },
    body: '{}', signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
}
function siteUrl() { return process.env.SITE_URL || null; }
async function gerarMensagens(lojaId) {
  const r = await mensagens.gerar(pool, lojaId, TZ, siteUrl());
  if (r.automatico && Object.values(r.criadas).some(Boolean)) cutucarBot();
  return r;
}

const SQL_MSG = `SELECT m.id, m.cliente_id, c.nome AS cliente_nome, m.tipo, m.telefone, m.texto, m.detalhe, m.status, m.erro,
  m.criado_em, m.aprovada_em, m.enviada_em, m.enviada_manual, u.nome AS aprovada_por_nome
  FROM mensagens_clientes m JOIN clientes c ON c.id = m.cliente_id LEFT JOIN usuarios u ON u.id = m.aprovada_por`;

function idsDoCorpo(body) {
  const ids = (body || {}).ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some((i) => typeof i !== 'string')) falha(400, 'ids: lista de mensagens');
  return ids;
}

app.get('/api/lojas/:lojaId/mensagens-clientes', admin, rota(async (req, res) => {
  const historico = req.query.ver === 'historico';
  if (!historico) await gerarMensagens(req.lojaId);
  const { rows } = historico
    ? await pool.query(SQL_MSG + ` WHERE m.loja_id = $1 AND m.status NOT IN ('pendente', 'erro') AND m.criado_em > now() - interval '30 days'
        ORDER BY COALESCE(m.enviada_em, m.aprovada_em, m.criado_em) DESC LIMIT 300`, [req.lojaId])
    : await pool.query(SQL_MSG + ` WHERE m.loja_id = $1 AND m.status IN ('pendente', 'erro') ORDER BY m.status DESC, m.tipo, m.criado_em`, [req.lojaId]);
  const { cfg } = await mensagens.lerConfig(pool, req.lojaId);
  res.json({ itens: rows, resumo: await mensagens.resumo(pool, req.lojaId, TZ), robo: !!process.env.BOT_WEBHOOK_SECRET, automatico: cfg.automatico });
}));

app.get('/api/lojas/:lojaId/mensagens-clientes/resumo', admin, rota(async (req, res) => {
  res.json(await mensagens.resumo(pool, req.lojaId, TZ));
}));

app.get('/api/lojas/:lojaId/mensagens-clientes/config', admin, rota(async (req, res) => {
  const { cfg } = await mensagens.lerConfig(pool, req.lojaId);
  res.json({ ...cfg, padrao: mensagens.PADRAO, rodape: mensagens.RODAPE_SAIR });
}));
app.put('/api/lojas/:lojaId/mensagens-clientes/config', admin, rota(async (req, res) => {
  const cfg = mensagens.mesclarConfig(req.body || {});
  await pool.query('UPDATE lojas SET mensagens_config = $1 WHERE id = $2', [JSON.stringify(cfg), req.lojaId]);
  res.json(cfg);
}));

app.put('/api/lojas/:lojaId/mensagens-clientes/:id', admin, rota(async (req, res) => {
  const t = texto((req.body || {}).texto, 'texto', { max: 2000 });
  const { rowCount } = await pool.query(
    "UPDATE mensagens_clientes SET texto = $1 WHERE id = $2 AND loja_id = $3 AND status IN ('pendente', 'erro')", [t, req.params.id, req.lojaId]);
  if (!rowCount) falha(409, 'Essa mensagem já foi aprovada ou enviada');
  res.json({ ok: true });
}));

// Corpo: { ids: [...], textos?: { id: texto editado } }
app.post('/api/lojas/:lojaId/mensagens-clientes/aprovar', admin, rota(async (req, res) => {
  const ids = idsDoCorpo(req.body);
  const textos = (req.body || {}).textos && typeof req.body.textos === 'object' ? req.body.textos : {};
  let aprovadas = 0;
  await transacao(async (c) => {
    for (const id of ids) {
      const t = textos[id] !== undefined ? texto(textos[id], 'texto', { max: 2000 }) : null;
      const { rowCount } = await c.query(
        `UPDATE mensagens_clientes SET status = 'na_fila', erro = NULL, aprovada_por = $1, aprovada_em = now(), texto = COALESCE($2, texto)
         WHERE id = $3 AND loja_id = $4 AND status IN ('pendente', 'erro')`, [req.usuario.id, t, id, req.lojaId]);
      aprovadas += rowCount;
    }
  });
  const robo = aprovadas ? await cutucarBot() : false;
  res.json({ aprovadas, robo });
}));

app.post('/api/lojas/:lojaId/mensagens-clientes/descartar', admin, rota(async (req, res) => {
  const ids = idsDoCorpo(req.body);
  const { rowCount } = await pool.query(
    "UPDATE mensagens_clientes SET status = 'descartada' WHERE id = ANY($1) AND loja_id = $2 AND status IN ('pendente', 'erro', 'na_fila')", [ids, req.lojaId]);
  res.json({ descartadas: rowCount });
}));

// Tira da fila de envio (volta pra revisão) — só se o robô ainda não pegou.
app.post('/api/lojas/:lojaId/mensagens-clientes/:id/voltar', admin, rota(async (req, res) => {
  const { rowCount } = await pool.query(
    "UPDATE mensagens_clientes SET status = 'pendente', aprovada_por = NULL, aprovada_em = NULL WHERE id = $1 AND loja_id = $2 AND status = 'na_fila'", [req.params.id, req.lojaId]);
  if (!rowCount) falha(409, 'Essa mensagem não está mais na fila (já foi enviada ou está saindo agora)');
  res.json({ ok: true });
}));

// Mandou pelo WhatsApp do celular (link wa.me): só registra.
app.post('/api/lojas/:lojaId/mensagens-clientes/:id/manual', admin, rota(async (req, res) => {
  const t = (req.body || {}).texto !== undefined ? texto(req.body.texto, 'texto', { max: 2000 }) : null;
  const { rowCount } = await pool.query(
    `UPDATE mensagens_clientes SET status = 'enviada', enviada_manual = true, enviada_em = now(), erro = NULL, texto = COALESCE($1, texto),
       aprovada_por = $2, aprovada_em = COALESCE(aprovada_em, now())
     WHERE id = $3 AND loja_id = $4 AND status IN ('pendente', 'erro', 'na_fila')`, [t, req.usuario.id, req.params.id, req.lojaId]);
  if (!rowCount) falha(409, 'Essa mensagem já foi enviada ou descartada');
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
  if (err instanceof mp.ErroPagamento) return res.status(err.status).json({ erro: err.message, codigo: 'pagamento' });
  if (err instanceof frete.ErroFrete) return res.status(err.status).json({ erro: err.message, codigo: 'frete' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido' });
  console.error(err);
  res.status(500).json({ erro: 'Erro interno — tente de novo' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('API da Loja Gutto rodando na porta ' + PORT);
  backup.agendar();
  // Sugere as mensagens do dia sozinho (de 3 em 3 horas), mesmo sem ninguém abrir a tela —
  // assim o envio automático (se ligado) e o aviso do Início funcionam.
  const rodarMensagens = () => pool.query('SELECT id FROM lojas').then(({ rows }) => Promise.all(rows.map((l) => gerarMensagens(l.id))))
    .catch((e) => console.error('Mensagens pros clientes:', e.message));
  setTimeout(rodarMensagens, 60 * 1000).unref();
  setInterval(rodarPagamentosPendentes, Number(process.env.PAGAMENTOS_INTERVALO_MS || 60 * 1000)).unref();
  setInterval(rodarMensagens, 3 * 60 * 60 * 1000).unref();
});
