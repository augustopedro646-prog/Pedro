require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { pool, uid } = require('./db');
const { verificarPin, gerarToken, requireAuth, requirePapel } = require('./auth');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/painel-gutto.html'));

// Limite geral generoso (evita abuso óbvio); login tem limite mais apertado
// à parte, porque é o alvo natural de tentativa de força bruta de PIN.
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 300 }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { erro: 'Muitas tentativas — aguarde alguns minutos.' } });

app.get('/api/health', (req, res) => res.json({ ok: true }));

function lojaIdNum(req) {
  const n = Number(req.params.lojaId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Aritmética de dinheiro em JS (float) acumula erro de arredondamento
// (39.9*3 = 119.69999999999999) — o Postgres corrige sozinho ao gravar como
// NUMERIC(12,2), mas a resposta da API precisa do mesmo arredondamento, senão
// devolve pro cliente um valor visualmente errado mesmo com o banco certo.
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/* ---------- Autenticação ---------- */

// Lista de usuários pra montar a tela de login (papel → pessoa) — sem pin_hash.
app.get('/api/lojas/:lojaId/usuarios', async (req, res) => {
  const lojaId = lojaIdNum(req);
  if (!lojaId) return res.status(400).json({ erro: 'lojaId inválido' });
  const { rows } = await pool.query(
    'SELECT id, nome, papel FROM usuarios WHERE loja_id = $1 AND ativo = true ORDER BY nome',
    [lojaId]
  );
  res.json(rows);
});

app.post('/api/lojas/:lojaId/login', loginLimiter, async (req, res) => {
  const lojaId = lojaIdNum(req);
  if (!lojaId) return res.status(400).json({ erro: 'lojaId inválido' });
  const { usuarioId, pin } = req.body || {};
  if (typeof usuarioId !== 'string' || typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ erro: 'usuarioId e pin (4 dígitos) são obrigatórios' });
  }
  const { rows } = await pool.query(
    'SELECT * FROM usuarios WHERE id = $1 AND loja_id = $2 AND ativo = true',
    [usuarioId, lojaId]
  );
  const usuario = rows[0];
  if (!usuario || !verificarPin(pin, usuario.pin_hash)) {
    return res.status(401).json({ erro: 'PIN incorreto' });
  }
  const token = gerarToken(usuario);
  res.json({ token, usuario: { id: usuario.id, nome: usuario.nome, papel: usuario.papel } });
});

/* ---------- Grades de tamanho ---------- */

app.get('/api/lojas/:lojaId/grades-tamanho', requireAuth, async (req, res) => {
  const lojaId = lojaIdNum(req);
  if (!lojaId) return res.status(400).json({ erro: 'lojaId inválido' });
  const { rows } = await pool.query(
    'SELECT id, nome, tamanhos FROM grades_tamanho WHERE loja_id = $1 ORDER BY nome',
    [lojaId]
  );
  res.json(rows);
});

app.post('/api/lojas/:lojaId/grades-tamanho', requireAuth, requirePapel('administrador'), async (req, res) => {
  const lojaId = lojaIdNum(req);
  if (!lojaId) return res.status(400).json({ erro: 'lojaId inválido' });
  const { nome, tamanhos } = req.body || {};
  if (typeof nome !== 'string' || !nome.trim() || nome.length > 60) {
    return res.status(400).json({ erro: 'nome da grade inválido' });
  }
  if (!Array.isArray(tamanhos) || !tamanhos.length || tamanhos.length > 30 ||
      !tamanhos.every((t) => typeof t === 'string' && t.trim() && t.length <= 10)) {
    return res.status(400).json({ erro: 'tamanhos deve ser uma lista de textos curtos, não vazia' });
  }
  const id = uid();
  await pool.query(
    'INSERT INTO grades_tamanho (id, loja_id, nome, tamanhos) VALUES ($1, $2, $3, $4)',
    [id, lojaId, nome.trim(), tamanhos.map((t) => t.trim())]
  );
  res.status(201).json({ id, nome: nome.trim(), tamanhos });
});

/* ---------- Produtos e variações ---------- */

app.get('/api/lojas/:lojaId/produtos', requireAuth, async (req, res) => {
  const lojaId = lojaIdNum(req);
  if (!lojaId) return res.status(400).json({ erro: 'lojaId inválido' });
  const { rows: produtos } = await pool.query(
    `SELECT p.id, p.nome, p.categoria, p.descricao, p.ncm, p.foto_url, p.ativo,
            g.id AS grade_id, g.nome AS grade_nome, g.tamanhos AS grade_tamanhos
     FROM produtos p
     LEFT JOIN grades_tamanho g ON g.id = p.grade_tamanho_id
     WHERE p.loja_id = $1
     ORDER BY p.nome`,
    [lojaId]
  );
  if (!produtos.length) return res.json([]);
  const { rows: variacoes } = await pool.query(
    `SELECT id, produto_id, tamanho, cor, sku, codigo_barras, preco_venda, custo_unitario,
            estoque, estoque_minimo, ativo
     FROM produto_variacoes
     WHERE loja_id = $1
     ORDER BY tamanho, cor`,
    [lojaId]
  );
  const porProduto = {};
  variacoes.forEach((v) => {
    (porProduto[v.produto_id] = porProduto[v.produto_id] || []).push(v);
  });
  res.json(produtos.map((p) => ({
    ...p,
    grade: p.grade_id ? { id: p.grade_id, nome: p.grade_nome, tamanhos: p.grade_tamanhos } : null,
    variacoes: porProduto[p.id] || [],
  })));
});

app.post('/api/lojas/:lojaId/produtos', requireAuth, requirePapel('administrador'), async (req, res) => {
  const lojaId = lojaIdNum(req);
  if (!lojaId) return res.status(400).json({ erro: 'lojaId inválido' });
  const { nome, categoria, descricao, gradeTamanhoId, ncm } = req.body || {};
  if (typeof nome !== 'string' || !nome.trim() || nome.length > 200) {
    return res.status(400).json({ erro: 'nome do produto inválido' });
  }
  const id = uid();
  await pool.query(
    `INSERT INTO produtos (id, loja_id, nome, categoria, descricao, grade_tamanho_id, ncm)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, lojaId, nome.trim(), categoria || null, descricao || null, gradeTamanhoId || null, ncm || null]
  );
  res.status(201).json({ id });
});

app.put('/api/lojas/:lojaId/produtos/:id', requireAuth, requirePapel('administrador'), async (req, res) => {
  const lojaId = lojaIdNum(req);
  if (!lojaId) return res.status(400).json({ erro: 'lojaId inválido' });
  const { nome, categoria, descricao, ncm, ativo } = req.body || {};
  const { rowCount } = await pool.query(
    `UPDATE produtos SET
       nome = COALESCE($1, nome),
       categoria = COALESCE($2, categoria),
       descricao = COALESCE($3, descricao),
       ncm = COALESCE($4, ncm),
       ativo = COALESCE($5, ativo)
     WHERE id = $6 AND loja_id = $7`,
    [nome || null, categoria || null, descricao || null, ncm || null, typeof ativo === 'boolean' ? ativo : null, req.params.id, lojaId]
  );
  if (!rowCount) return res.status(404).json({ erro: 'produto não encontrado' });
  res.json({ ok: true });
});

app.post('/api/lojas/:lojaId/produtos/:id/variacoes', requireAuth, requirePapel('administrador'), async (req, res) => {
  const lojaId = lojaIdNum(req);
  if (!lojaId) return res.status(400).json({ erro: 'lojaId inválido' });
  const { tamanho, cor, sku, codigoBarras, precoVenda, custoUnitario, estoqueMinimo, estoqueInicial } = req.body || {};
  if (typeof tamanho !== 'string' || !tamanho.trim()) return res.status(400).json({ erro: 'tamanho é obrigatório' });
  const preco = Number(precoVenda);
  if (!Number.isFinite(preco) || preco < 0) return res.status(400).json({ erro: 'precoVenda inválido' });
  const custo = Number(custoUnitario) || 0;
  const minimo = Number(estoqueMinimo) || 0;
  const inicial = Number(estoqueInicial) || 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const produto = await client.query('SELECT id FROM produtos WHERE id = $1 AND loja_id = $2', [req.params.id, lojaId]);
    if (!produto.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ erro: 'produto não encontrado' }); }

    const variacaoId = uid();
    await client.query(
      `INSERT INTO produto_variacoes
         (id, loja_id, produto_id, tamanho, cor, sku, codigo_barras, preco_venda, custo_unitario, estoque, estoque_minimo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [variacaoId, lojaId, req.params.id, tamanho.trim(), (cor || '').trim(), sku || null, codigoBarras || null, preco, custo, inicial, minimo]
    );
    if (inicial > 0) {
      await client.query(
        `INSERT INTO movimentos_estoque_produto
           (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, criado_por)
         VALUES ($1,$2,$3,'entrada',$4,$5,$6,'cadastro',$7)`,
        [uid(), lojaId, variacaoId, inicial, custo, inicial * custo, req.usuario.id]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ id: variacaoId });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ erro: 'já existe essa combinação de tamanho/cor (ou SKU) pra esse produto' });
    console.error(e);
    res.status(500).json({ erro: 'falha ao criar variação' });
  } finally {
    client.release();
  }
});

app.put('/api/lojas/:lojaId/variacoes/:id', requireAuth, requirePapel('administrador'), async (req, res) => {
  const lojaId = lojaIdNum(req);
  if (!lojaId) return res.status(400).json({ erro: 'lojaId inválido' });
  const { precoVenda, estoqueMinimo, ativo, codigoBarras, sku } = req.body || {};
  const { rowCount } = await pool.query(
    `UPDATE produto_variacoes SET
       preco_venda = COALESCE($1, preco_venda),
       estoque_minimo = COALESCE($2, estoque_minimo),
       ativo = COALESCE($3, ativo),
       codigo_barras = COALESCE($4, codigo_barras),
       sku = COALESCE($5, sku)
     WHERE id = $6 AND loja_id = $7`,
    [
      precoVenda != null ? Number(precoVenda) : null,
      estoqueMinimo != null ? Number(estoqueMinimo) : null,
      typeof ativo === 'boolean' ? ativo : null,
      codigoBarras || null,
      sku || null,
      req.params.id, lojaId,
    ]
  );
  if (!rowCount) return res.status(404).json({ erro: 'variação não encontrada' });
  res.json({ ok: true });
});

/* ---------- Estoque: entrada e ajuste (sempre via ledger) ---------- */

app.post('/api/lojas/:lojaId/variacoes/:id/entrada-estoque', requireAuth, requirePapel('administrador'), async (req, res) => {
  const lojaId = lojaIdNum(req);
  if (!lojaId) return res.status(400).json({ erro: 'lojaId inválido' });
  const quantidade = Number((req.body || {}).quantidade);
  const custoNovo = Number((req.body || {}).custoUnitario);
  const observacao = (req.body || {}).observacao;
  if (!Number.isFinite(quantidade) || quantidade <= 0) return res.status(400).json({ erro: 'quantidade deve ser positiva' });
  if (!Number.isFinite(custoNovo) || custoNovo < 0) return res.status(400).json({ erro: 'custoUnitario inválido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT estoque, custo_unitario FROM produto_variacoes WHERE id = $1 AND loja_id = $2 FOR UPDATE',
      [req.params.id, lojaId]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ erro: 'variação não encontrada' }); }
    const atual = rows[0];
    const estoqueAtual = Number(atual.estoque);
    const custoAtual = Number(atual.custo_unitario);
    // Custo médio ponderado — mesma fórmula já validada no PDV Jabá (ingredientes/beneficiados).
    const novoEstoque = estoqueAtual + quantidade;
    const custoMedio = round2(novoEstoque > 0 ? (estoqueAtual * custoAtual + quantidade * custoNovo) / novoEstoque : custoNovo);

    await client.query(
      'UPDATE produto_variacoes SET estoque = $1, custo_unitario = $2 WHERE id = $3',
      [novoEstoque, custoMedio, req.params.id]
    );
    await client.query(
      `INSERT INTO movimentos_estoque_produto
         (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, observacao, criado_por)
       VALUES ($1,$2,$3,'entrada',$4,$5,$6,'compra',$7,$8)`,
      [uid(), lojaId, req.params.id, quantidade, custoNovo, quantidade * custoNovo, (observacao || '').slice(0, 300), req.usuario.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true, estoque: novoEstoque, custoMedio });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ erro: 'falha ao registrar entrada de estoque' });
  } finally {
    client.release();
  }
});

/* ---------- Vendas (Venda rápida) ---------- */

app.post('/api/lojas/:lojaId/vendas', requireAuth, requirePapel('administrador', 'caixa'), async (req, res) => {
  const lojaId = lojaIdNum(req);
  if (!lojaId) return res.status(400).json({ erro: 'lojaId inválido' });
  const { itens, formaPagamento, desconto } = req.body || {};
  if (!Array.isArray(itens) || !itens.length || itens.length > 100) {
    return res.status(400).json({ erro: 'itens deve ter de 1 a 100 linhas' });
  }
  if (typeof formaPagamento !== 'string' || !formaPagamento.trim()) {
    return res.status(400).json({ erro: 'formaPagamento é obrigatória' });
  }
  const descontoVenda = Number(desconto) || 0;
  if (descontoVenda < 0) return res.status(400).json({ erro: 'desconto não pode ser negativo' });
  for (const it of itens) {
    if (typeof it.variacaoId !== 'string' || !Number.isFinite(Number(it.qtd)) || Number(it.qtd) <= 0) {
      return res.status(400).json({ erro: 'cada item precisa de variacaoId e qtd positiva' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let subtotal = 0;
    const itensParaGravar = [];

    for (const it of itens) {
      const qtd = Number(it.qtd);
      const descontoItem = Number(it.descontoItem) || 0;
      const { rows } = await client.query(
        `SELECT v.id, v.tamanho, v.cor, v.estoque, v.preco_venda, v.custo_unitario, v.ativo, p.nome AS produto_nome
         FROM produto_variacoes v JOIN produtos p ON p.id = v.produto_id
         WHERE v.id = $1 AND v.loja_id = $2 FOR UPDATE`,
        [it.variacaoId, lojaId]
      );
      if (!rows.length || !rows[0].ativo) {
        await client.query('ROLLBACK');
        return res.status(404).json({ erro: 'variação não encontrada: ' + it.variacaoId });
      }
      const v = rows[0];
      if (Number(v.estoque) < qtd) {
        await client.query('ROLLBACK');
        return res.status(409).json({ erro: 'estoque insuficiente', variacaoId: it.variacaoId, disponivel: Number(v.estoque) });
      }
      const precoUnit = Number(v.preco_venda);
      subtotal = round2(subtotal + round2(precoUnit * qtd) - descontoItem);

      await client.query('UPDATE produto_variacoes SET estoque = estoque - $1 WHERE id = $2', [qtd, v.id]);
      itensParaGravar.push({
        variacaoId: v.id, produtoNome: v.produto_nome, tamanho: v.tamanho, cor: v.cor,
        qtd, precoUnit, descontoItem, custoUnitario: Number(v.custo_unitario),
      });
    }

    if (subtotal - descontoVenda < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: 'desconto maior que o total da venda' });
    }

    const vendaId = uid();
    const total = round2(subtotal - descontoVenda);
    await client.query(
      `INSERT INTO vendas (id, loja_id, usuario_id, canal, subtotal, desconto, total, forma_pagamento)
       VALUES ($1,$2,$3,'loja',$4,$5,$6,$7)`,
      [vendaId, lojaId, req.usuario.id, subtotal, descontoVenda, total, formaPagamento.trim()]
    );

    for (const it of itensParaGravar) {
      await client.query(
        `INSERT INTO vendas_itens (id, venda_id, variacao_id, produto_nome, tamanho, cor, qtd, preco_unit, desconto_item)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [uid(), vendaId, it.variacaoId, it.produtoNome, it.tamanho, it.cor, it.qtd, it.precoUnit, it.descontoItem]
      );
      await client.query(
        `INSERT INTO movimentos_estoque_produto
           (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total, referencia_tipo, referencia_id, criado_por)
         VALUES ($1,$2,$3,'venda',$4,$5,$6,'venda',$7,$8)`,
        [uid(), lojaId, it.variacaoId, -it.qtd, it.custoUnitario, it.custoUnitario * it.qtd, vendaId, req.usuario.id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ id: vendaId, subtotal, desconto: descontoVenda, total, itens: itensParaGravar });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ erro: 'falha ao registrar venda' });
  } finally {
    client.release();
  }
});

app.get('/api/lojas/:lojaId/vendas', requireAuth, async (req, res) => {
  const lojaId = lojaIdNum(req);
  if (!lojaId) return res.status(400).json({ erro: 'lojaId inválido' });
  const { rows: vendas } = await pool.query(
    `SELECT id, usuario_id, canal, subtotal, desconto, total, forma_pagamento, cancelada, criado_em
     FROM vendas WHERE loja_id = $1 ORDER BY criado_em DESC LIMIT 200`,
    [lojaId]
  );
  res.json(vendas);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API da Loja Gutto rodando na porta ' + PORT));
