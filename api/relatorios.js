// Relatórios (Fase 4): tudo sai das vendas reais, num período escolhido no painel.
//
// Regras de conta (as mesmas em todos os blocos, pra os números baterem entre si):
// - Entram as vendas não canceladas do período (dia na hora local da loja). Loja e online juntos.
// - "Vendido" = valor das peças já com desconto e SEM o que voltou em troca/devolução (a devolução
//   é descontada da venda original, não do dia em que aconteceu). Taxa de entrega não é venda de
//   peça: aparece à parte.
// - Custo de cada peça = o custo gravado no movimento de estoque da própria venda (snapshot do
//   custo médio naquele dia); se não houver movimento, o custo atual da variação.
// - Lucro bruto = vendido − custo das peças vendidas. Não desconta despesas (isso é o Fluxo).
const DIA_MS = 864e5;

function somaDias(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diasEntre(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / DIA_MS); }
function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

const FILTRO_VENDAS = `v.loja_id = $1 AND NOT v.cancelada AND (v.criado_em AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`;

async function vendasDoPeriodo(db, lojaId, inicio, fim, tz) {
  const { rows } = await db.query(
    `SELECT v.id, v.usuario_id, u.nome AS usuario_nome, v.taxa_entrega::float AS taxa_entrega,
            to_char(v.criado_em AT TIME ZONE $4, 'YYYY-MM-DD') AS dia,
            EXTRACT(ISODOW FROM v.criado_em AT TIME ZONE $4)::int AS dow,
            EXTRACT(HOUR FROM v.criado_em AT TIME ZONE $4)::int AS hora
     FROM vendas v JOIN usuarios u ON u.id = v.usuario_id WHERE ${FILTRO_VENDAS}`,
    [lojaId, inicio, fim, tz]);
  return rows;
}

async function itensDoPeriodo(db, lojaId, inicio, fim, tz) {
  const { rows } = await db.query(
    `SELECT vi.venda_id, vi.variacao_id, pv.produto_id, p.nome AS produto_nome, p.categoria,
            vi.qtd::float AS qtd, (vi.preco_unit * vi.qtd - vi.desconto_item)::float AS receita, vi.desconto_item::float AS desconto,
            GREATEST(COALESCE(vi.preco_cheio, vi.preco_unit) - vi.preco_unit, 0)::float AS promo_unit,
            COALESCE(dv.qtd, 0)::float AS qtd_dev, COALESCE(dv.valor, 0)::float AS valor_dev,
            COALESCE(cm.custo_unit, pv.custo_unitario)::float AS custo_unit
     FROM vendas v
     JOIN vendas_itens vi ON vi.venda_id = v.id
     JOIN produto_variacoes pv ON pv.id = vi.variacao_id
     JOIN produtos p ON p.id = pv.produto_id
     LEFT JOIN LATERAL (SELECT SUM(di.qtd) AS qtd, SUM(di.valor) AS valor FROM devolucoes_itens di WHERE di.venda_item_id = vi.id) dv ON true
     LEFT JOIN LATERAL (
       SELECT SUM(m.valor_total) / NULLIF(SUM(-m.quantidade), 0) AS custo_unit FROM movimentos_estoque_produto m
       WHERE m.variacao_id = vi.variacao_id AND m.loja_id = v.loja_id AND m.tipo = 'venda'
         AND ((m.referencia_tipo = 'venda' AND m.referencia_id = v.id)
           OR (m.referencia_tipo = 'pedido_online' AND m.referencia_id = v.pedido_online_id))
     ) cm ON true
     WHERE ${FILTRO_VENDAS}`,
    [lojaId, inicio, fim, tz]);
  return rows.map((it) => {
    const pecas = it.qtd - it.qtd_dev;
    const vendido = it.receita - it.valor_dev;
    return { ...it, pecas, vendido, custo: it.custo_unit * pecas, promo: it.promo_unit * pecas };
  });
}

function resumir(vendas, itens) {
  const soma = (lista, f) => lista.reduce((s, x) => s + f(x), 0);
  const vendido = r2(soma(itens, (i) => i.vendido));
  const custo = r2(soma(itens, (i) => i.custo));
  const lucro = r2(vendido - custo);
  return {
    vendido,
    vendas: vendas.length,
    ticketMedio: vendas.length ? r2(vendido / vendas.length) : 0,
    pecas: soma(itens, (i) => i.pecas),
    custo,
    lucroBruto: lucro,
    margem: vendido > 0 ? lucro / vendido : null,
    descontos: r2(soma(itens, (i) => i.desconto)),
    descontoPromocoes: r2(soma(itens, (i) => i.promo)),
    devolvido: r2(soma(itens, (i) => i.valor_dev)),
    taxasEntrega: r2(soma(vendas, (v) => v.taxa_entrega)),
  };
}

// Período que começa no dia 1 e fica dentro de um mês ("Este mês", "Mês passado"): é quando a
// meta do mês faz sentido, e a comparação é com os mesmos dias do mês anterior (1 a 15 de setembro
// contra 1 a 15 de agosto), não com "os N dias antes".
function mesAlinhado(inicio, fim) {
  return inicio.slice(8) === '01' && inicio.slice(0, 7) === fim.slice(0, 7);
}
function periodoAnterior(inicio, fim, dias) {
  if (mesAlinhado(inicio, fim)) {
    const antInicio = somaDias(inicio, -1).slice(0, 8) + '01';
    const ultimoDia = somaDias(inicio, -1);
    const antFim = antInicio.slice(0, 8) + fim.slice(8);
    return { inicio: antInicio, fim: antFim < ultimoDia ? antFim : ultimoDia };
  }
  return { inicio: somaDias(inicio, -dias), fim: somaDias(inicio, -1) };
}

async function montarRelatorio(db, lojaId, inicio, fim, tz) {
  const dias = diasEntre(inicio, fim) + 1;
  const { inicio: antInicio, fim: antFim } = periodoAnterior(inicio, fim, dias);

  const [vendas, itens, vendasAnt, itensAnt, loja, formasQ, produtosQ, reposicaoQ, equipeQ] = await Promise.all([
    vendasDoPeriodo(db, lojaId, inicio, fim, tz),
    itensDoPeriodo(db, lojaId, inicio, fim, tz),
    vendasDoPeriodo(db, lojaId, antInicio, antFim, tz),
    itensDoPeriodo(db, lojaId, antInicio, antFim, tz),
    db.query('SELECT comissao_pct::float AS comissao_pct FROM lojas WHERE id = $1', [lojaId]),
    db.query(
      `SELECT vp.forma, SUM(vp.valor)::float AS valor, count(DISTINCT v.id)::int AS vendas
       FROM venda_pagamentos vp JOIN vendas v ON v.id = vp.venda_id WHERE ${FILTRO_VENDAS}
       GROUP BY vp.forma ORDER BY valor DESC`, [lojaId, inicio, fim, tz]),
    // Estoque atual por produto + última venda de todos os tempos (pra "parados" e cobertura).
    db.query(
      `SELECT p.id, p.nome, p.categoria, p.criado_em,
              COALESCE(SUM(pv.estoque) FILTER (WHERE pv.ativo AND pv.estoque > 0), 0)::float AS estoque,
              COALESCE(SUM(pv.estoque * pv.custo_unitario) FILTER (WHERE pv.ativo AND pv.estoque > 0), 0)::float AS valor_custo,
              COALESCE(SUM(pv.estoque * pv.preco_venda) FILTER (WHERE pv.ativo AND pv.estoque > 0), 0)::float AS valor_venda,
              (SELECT MAX(v.criado_em) FROM vendas v JOIN vendas_itens vi ON vi.venda_id = v.id
                 JOIN produto_variacoes x ON x.id = vi.variacao_id WHERE x.produto_id = p.id AND NOT v.cancelada) AS ultima_venda
       FROM produtos p LEFT JOIN produto_variacoes pv ON pv.produto_id = p.id
       WHERE p.loja_id = $1 AND p.ativo GROUP BY p.id`, [lojaId]),
    db.query(
      `SELECT pv.id, p.nome AS produto_nome, pv.tamanho, pv.cor, pv.estoque::float AS estoque, pv.estoque_minimo::float AS estoque_minimo,
              pv.custo_unitario::float AS custo_unitario
       FROM produto_variacoes pv JOIN produtos p ON p.id = pv.produto_id
       WHERE pv.loja_id = $1 AND pv.ativo AND p.ativo AND pv.estoque <= pv.estoque_minimo
       ORDER BY p.nome, pv.tamanho, pv.cor`, [lojaId]),
    db.query('SELECT id, nome, ativo, meta_mensal::float AS meta_mensal FROM usuarios WHERE loja_id = $1', [lojaId]),
  ]);
  const comissaoPct = loja.rows.length ? loja.rows[0].comissao_pct : 0;

  const vendidoPorVenda = new Map(), pecasPorVenda = new Map();
  for (const it of itens) {
    vendidoPorVenda.set(it.venda_id, (vendidoPorVenda.get(it.venda_id) || 0) + it.vendido);
    pecasPorVenda.set(it.venda_id, (pecasPorVenda.get(it.venda_id) || 0) + it.pecas);
  }

  // Vendas por dia (ou por mês, se o período passar de ~2 meses: barras diárias ficariam finas demais).
  const agrupamento = dias <= 62 ? 'dia' : 'mes';
  const chave = (dia) => (agrupamento === 'dia' ? dia : dia.slice(0, 7));
  const serie = new Map();
  for (let d = inicio; d <= fim; d = somaDias(d, 1)) if (!serie.has(chave(d))) serie.set(chave(d), { chave: chave(d), vendido: 0, vendas: 0 });
  for (const v of vendas) {
    const b = serie.get(chave(v.dia));
    if (b) { b.vendas += 1; b.vendido += vendidoPorVenda.get(v.id) || 0; }
  }
  const porPeriodo = [...serie.values()].map((b) => ({ ...b, vendido: r2(b.vendido) }));

  // Produtos: ranking + curva ABC (A = os que fazem os primeiros 80% do vendido, B até 95%, C o resto).
  const estoquePorProduto = new Map(produtosQ.rows.map((p) => [p.id, p]));
  const porProduto = new Map();
  for (const it of itens) {
    const p = porProduto.get(it.produto_id) || { produtoId: it.produto_id, nome: it.produto_nome, categoria: it.categoria || '', pecas: 0, vendido: 0, custo: 0 };
    p.pecas += it.pecas; p.vendido += it.vendido; p.custo += it.custo;
    porProduto.set(it.produto_id, p);
  }
  const totalVendido = [...porProduto.values()].reduce((s, p) => s + Math.max(0, p.vendido), 0);
  let acumulado = 0;
  const produtos = [...porProduto.values()].filter((p) => p.pecas > 0 || p.vendido > 0)
    .sort((a, b) => b.vendido - a.vendido || b.pecas - a.pecas)
    .map((p) => {
      const antes = totalVendido > 0 ? acumulado / totalVendido : 0;
      acumulado += Math.max(0, p.vendido);
      const est = estoquePorProduto.get(p.produtoId);
      const estoque = est ? est.estoque : 0;
      const porDia = p.pecas / dias;
      return {
        produtoId: p.produtoId, nome: p.nome, categoria: p.categoria, pecas: p.pecas,
        vendido: r2(p.vendido), lucro: r2(p.vendido - p.custo), margem: p.vendido > 0 ? (p.vendido - p.custo) / p.vendido : null,
        participacao: totalVendido > 0 ? Math.max(0, p.vendido) / totalVendido : 0,
        classe: antes < 0.8 ? 'A' : antes < 0.95 ? 'B' : 'C',
        estoque, coberturaDias: porDia > 0 ? Math.round(estoque / porDia) : null,
      };
    });

  // Parados: tem estoque e não vendeu nada no período.
  const venderam = new Set(produtos.map((p) => p.produtoId));
  const hoje = Date.now();
  const parados = produtosQ.rows.filter((p) => p.estoque > 0 && !venderam.has(p.id))
    .map((p) => ({
      produtoId: p.id, nome: p.nome, categoria: p.categoria || '', estoque: p.estoque,
      valorCusto: r2(p.valor_custo), valorVenda: r2(p.valor_venda),
      ultimaVenda: p.ultima_venda, diasSemVender: Math.floor((hoje - new Date(p.ultima_venda || p.criado_em).getTime()) / DIA_MS),
    }))
    .sort((a, b) => b.valorCusto - a.valorCusto || b.diasSemVender - a.diasSemVender);

  // Vendas por pessoa + comissão (sobre o vendido líquido) + meta (quando o período é dentro de um mês, a partir do dia 1).
  const temMeta = mesAlinhado(inicio, fim);
  const porPessoa = new Map();
  for (const v of vendas) {
    const p = porPessoa.get(v.usuario_id) || { usuarioId: v.usuario_id, nome: v.usuario_nome, vendas: 0, vendido: 0, pecas: 0 };
    p.vendas += 1; p.vendido += vendidoPorVenda.get(v.id) || 0; p.pecas += pecasPorVenda.get(v.id) || 0;
    porPessoa.set(v.usuario_id, p);
  }
  if (temMeta) {
    for (const u of equipeQ.rows) {
      if (u.ativo && u.meta_mensal > 0 && !porPessoa.has(u.id)) porPessoa.set(u.id, { usuarioId: u.id, nome: u.nome, vendas: 0, vendido: 0, pecas: 0 });
    }
  }
  const metas = new Map(equipeQ.rows.map((u) => [u.id, u.meta_mensal]));
  const vendedores = [...porPessoa.values()].sort((a, b) => b.vendido - a.vendido).map((p) => ({
    ...p, vendido: r2(p.vendido), ticketMedio: p.vendas ? r2(p.vendido / p.vendas) : 0,
    comissao: r2(Math.max(0, p.vendido) * comissaoPct / 100),
    meta: temMeta && metas.get(p.usuarioId) > 0 ? metas.get(p.usuarioId) : null,
  }));

  // Horários de pico: dia da semana (1 = segunda) × hora.
  const celulas = new Map();
  for (const v of vendas) {
    const k = v.dow + '-' + v.hora;
    const c = celulas.get(k) || { dow: v.dow, hora: v.hora, vendas: 0, vendido: 0 };
    c.vendas += 1; c.vendido += vendidoPorVenda.get(v.id) || 0;
    celulas.set(k, c);
  }
  const horarios = [...celulas.values()].map((c) => ({ ...c, vendido: r2(c.vendido) }));

  // Reposição: abaixo do mínimo. Peça com mínimo 0 e sem estoque só entra se vendeu no período
  // (senão aparecem todos os tamanhos que a loja nem trabalha mais).
  const vendidasPorVariacao = new Map();
  for (const it of itens) vendidasPorVariacao.set(it.variacao_id, (vendidasPorVariacao.get(it.variacao_id) || 0) + it.pecas);
  const reposicao = reposicaoQ.rows
    .map((r) => ({ variacaoId: r.id, produtoNome: r.produto_nome, tamanho: r.tamanho, cor: r.cor, estoque: r.estoque,
      estoqueMinimo: r.estoque_minimo, vendidasNoPeriodo: vendidasPorVariacao.get(r.id) || 0 }))
    .filter((r) => r.estoqueMinimo > 0 || r.vendidasNoPeriodo > 0)
    .sort((a, b) => b.vendidasNoPeriodo - a.vendidasNoPeriodo || a.estoque - b.estoque);

  return {
    periodo: { inicio, fim, dias },
    anteriorPeriodo: { inicio: antInicio, fim: antFim },
    resumo: resumir(vendas, itens),
    anterior: resumir(vendasAnt, itensAnt),
    agrupamento, porPeriodo, produtos, parados, vendedores, comissaoPct, temMeta,
    formas: formasQ.rows.map((f) => ({ forma: f.forma, valor: r2(f.valor), vendas: f.vendas })),
    horarios, reposicao,
  };
}

module.exports = { montarRelatorio, somaDias, diasEntre };
