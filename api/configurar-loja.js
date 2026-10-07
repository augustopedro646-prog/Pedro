// Configuração inicial da Loja Gutto com os valores que o Pedro definiu (07/10/2026).
// Rodar uma vez, depois do "npm run setup":  npm run configurar   (no Windows: npm.cmd run configurar)
// Pode rodar de novo sem problema: grade que já existe com o mesmo nome não é duplicada.
// Tudo isso também dá pra mudar depois na aba Configurações e no cadastro de produto.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { pool, uid } = require('./db');

const LOJA_ID = Number(process.env.LOJA_ID || 1);

const GRADES = [
  { nome: 'Bebê', tamanhos: ['0-3M', '3-6M', '6-9M', 'G'] },
  { nome: 'Infantil', tamanhos: ['1', '2', '3', '4', '6', '8', '10'] },
  { nome: 'Juvenil', tamanhos: ['12', '14', '16'] },
];
const CONFIG = {
  cashbackPct: 5, // % que volta pra cliente em cashback
  descontoLivrePct: 20, // desconto que a vendedora dá sem PIN de Administrador
  crediarioLimite: 700, // limite padrão do crediário por cliente (dá pra mudar cliente a cliente)
  trocaDiasLoja: 15,
  trocaDiasSite: 30, // compras pelo site (inclusive outros estados)
};

async function main() {
  const { rows: loja } = await pool.query('SELECT id, nome, cupom_rodape FROM lojas WHERE id = $1', [LOJA_ID]);
  if (!loja.length) throw new Error('Loja ' + LOJA_ID + ' não existe — rode "npm run setup" antes.');

  for (const g of GRADES) {
    const { rows } = await pool.query('SELECT id FROM grades_tamanho WHERE loja_id = $1 AND lower(nome) = lower($2)', [LOJA_ID, g.nome]);
    if (rows.length) { console.log(`Grade "${g.nome}" já existia — não mexi.`); continue; }
    await pool.query('INSERT INTO grades_tamanho (id, loja_id, nome, tamanhos) VALUES ($1,$2,$3,$4)', [uid(), LOJA_ID, g.nome, g.tamanhos]);
    console.log(`Grade "${g.nome}" criada: ${g.tamanhos.join(', ')}`);
  }

  const rodape = `Trocas em até ${CONFIG.trocaDiasLoja} dias com a etiqueta e este cupom.`;
  await pool.query(
    `UPDATE lojas SET cashback_pct = $1, desconto_livre_pct = $2, crediario_limite_padrao = $3, troca_dias_loja = $4, troca_dias_site = $5,
       cupom_rodape = CASE WHEN COALESCE(cupom_rodape, '') = '' THEN $6 ELSE cupom_rodape END WHERE id = $7`,
    [CONFIG.cashbackPct, CONFIG.descontoLivrePct, CONFIG.crediarioLimite, CONFIG.trocaDiasLoja, CONFIG.trocaDiasSite, rodape, LOJA_ID]);
  console.log(`Cashback: ${CONFIG.cashbackPct}%`);
  console.log(`Desconto da vendedora sem PIN: até ${CONFIG.descontoLivrePct}%`);
  console.log(`Limite do crediário: R$ ${CONFIG.crediarioLimite},00 por cliente`);
  console.log(`Troca: ${CONFIG.trocaDiasLoja} dias na loja, ${CONFIG.trocaDiasSite} dias pelo site`);
  console.log(loja[0].cupom_rodape ? 'Rodapé do cupom: mantive o que já estava.' : 'Rodapé do cupom: "' + rodape + '"');
  console.log('\nPronto! Reinicie o sistema (ou o computador) e confira na aba Configurações.');
}

main().then(() => pool.end()).catch((e) => { console.error('Erro:', e.message); pool.end(); process.exit(1); });
