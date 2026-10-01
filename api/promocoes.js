// Promoções: % de desconto por período (produtos escolhidos, uma categoria ou a loja toda).
// O preço promocional é sempre calculado aqui no servidor — caixa, site, robô e etiqueta usam a
// mesma conta. Promoções não somam: vale a de maior desconto que cobre o produto no dia.

function hojeNaLoja(tz) { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); }
function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

async function ativas(db, lojaId, tz) {
  const { rows } = await db.query(
    `SELECT id, nome, desconto_pct::float AS pct, alvo, categoria, produto_ids, to_char(fim, 'YYYY-MM-DD') AS fim
     FROM promocoes WHERE loja_id = $1 AND encerrada_em IS NULL AND inicio <= $2::date AND fim >= $2::date`,
    [lojaId, hojeNaLoja(tz)]);
  return rows;
}

function cobre(promo, produtoId, categoria) {
  if (promo.alvo === 'loja') return true;
  if (promo.alvo === 'categoria') return !!categoria && String(categoria).toLowerCase() === String(promo.categoria || '').toLowerCase();
  return (promo.produto_ids || []).includes(produtoId);
}

function melhor(promos, produtoId, categoria) {
  let escolhida = null;
  for (const p of promos) if (cobre(p, produtoId, categoria) && (!escolhida || p.pct > escolhida.pct)) escolhida = p;
  return escolhida;
}

// { preco (o que o cliente paga), precoCheio, promo|null }
function precoComPromo(promos, produtoId, categoria, precoTabela) {
  const cheio = Number(precoTabela);
  const promo = melhor(promos, produtoId, categoria);
  if (!promo) return { preco: cheio, precoCheio: cheio, promo: null };
  return { preco: r2(cheio * (1 - promo.pct / 100)), precoCheio: cheio, promo };
}

module.exports = { ativas, precoComPromo, hojeNaLoja };
