# Modelo de produto com variação (tamanho/cor) — proposta

Peça de modelo de dado mais nova deste projeto em relação ao PDV Jabá (ver
`prompt-app-loja-de-roupas.md`). Este documento explica as decisões da proposta em
`db/schema-produtos-proposta.sql` e o que ainda depende de resposta do Pedro.

## Por que não copiar o `cardapio` do Jabá direto

No Jabá, `cardapio` é um array dentro de um blob JSON (`app_dados`), e cada item tem um único
campo `estoque` (número). O item **é** a unidade vendável — não tem variação.

Em roupa, o item vendável de verdade é a combinação **tamanho + cor** de um produto. Uma
camiseta "Foguete" P-Azul e a mesma camiseta G-Vermelho são duas unidades físicas diferentes,
cada uma com seu próprio estoque, e possivelmente seu próprio preço/custo (ex.: plus size mais
caro). Continuar com `estoque` como um número só no produto pai perderia essa granularidade.

## As 3 tabelas novas

- **`grades_tamanho`** — catálogo reutilizável de listas de tamanho (ex.: "Bebê" = RN,P,M,G;
  "Infantil numérica" = 2,4,...,16). Existe só pra não digitar a lista em cada produto novo e
  pra manter a ordem certa na grade da tela. **Assunção**: um produto usa uma grade só (não dá
  pra misturar "P/M/G" com "2/4/6" no mesmo produto) — parece razoável pra roupa infantil, mas
  confirma com o Pedro se algum produto realmente precisa de mistura.
- **`produtos`** — o produto "pai" (nome, categoria, foto, NCM). NCM fica aqui, não na
  variação, porque uma peça compartilha a mesma classificação fiscal entre tamanhos/cores (isso
  já está documentado no prompt original).
- **`produto_variacoes`** — 1 linha por combinação tamanho+cor: SKU, código de barras, preço,
  custo, estoque e estoque mínimo próprios. **É a peça nova de verdade.**

## Estoque: já nasce como tabela + ledger, pulando a fase que doeu no Jabá

O Jabá passou por 3 estágios até chegar num modelo de estoque seguro contra concorrência:
1. Blob JSON reescrito por inteiro → **bug real**: dois pedidos simultâneos "perdiam" um
   desconto de estoque (confirmado com teste: 21+9 unidades não decrementaram nenhuma vez).
2. Corrigido com transação atômica (`SELECT ... FOR UPDATE` na linha do blob antes de decrementar).
3. Só na V2 (Estoque & CMV automático) ganhou um ledger de movimentos (`movimentos_estoque`)
   pra separar CMV teórico de CMV real sem lógica espalhada em relatório.

Esta proposta já nasce nos estágios 2 e 3 ao mesmo tempo: `produto_variacoes.estoque` é uma
coluna simples (não um blob), e toda baixa/entrada passa por uma função que:
1. Abre transação, trava a linha da variação (`SELECT ... FOR UPDATE`);
2. Confirma que tem estoque suficiente (senão, erro — nunca deixa negativo numa venda);
3. Atualiza `produto_variacoes.estoque` e insere 1 linha em `movimentos_estoque_produto`
   (auditoria: quando, quanto, por causa de qual venda).

Pseudocódigo do endpoint (mesmo espírito do `decrementar-estoque` que corrigiu a corrida no
Jabá):

```js
async function baixarEstoque(variacaoId, qtd, referencia) {
  return db.transaction(async (tx) => {
    const v = await tx.query(
      'SELECT estoque, custo_unitario FROM produto_variacoes WHERE id=$1 FOR UPDATE',
      [variacaoId]
    );
    if (v.estoque < qtd) throw new EstoqueInsuficiente(variacaoId, v.estoque);
    await tx.query(
      'UPDATE produto_variacoes SET estoque = estoque - $1 WHERE id=$2',
      [qtd, variacaoId]
    );
    await tx.query(
      `INSERT INTO movimentos_estoque_produto
         (id, loja_id, variacao_id, tipo, quantidade, custo_unitario, valor_total,
          referencia_tipo, referencia_id, criado_por)
       VALUES ($1,$2,$3,'venda',$4,$5,$6,$7,$8,$9)`,
      [uid(), lojaId, variacaoId, -qtd, v.custo_unitario, qtd * v.custo_unitario, ...referencia]
    );
  });
}
```

Requisições concorrentes pra mesma variação ficam em fila pelo Postgres (serializadas pelo
lock), exatamente como o Jabá já comprovou com teste de carga (20 requisições simultâneas, 30
em estoque, resultado exato sem perder nem duplicar nenhuma).

## Como isso aparece nas telas

- **Estoque/Produtos**: lista de produtos; abrir um produto mostra uma grade
  tamanho (linha) × cor (coluna), cada célula com o estoque daquela variação — editar preço,
  custo, estoque mínimo por célula ou em lote.
- **Venda rápida (PDV)**: grade de produtos (foto+nome+preço "a partir de") — tocar abre um
  seletor de tamanho/cor (variações sem estoque aparecem desabilitadas/cinza) antes de ir pro
  carrinho. O carrinho guarda a variação exata (não o produto), pra o fechamento da venda baixar
  o SKU certo.

## Em aberto — preciso da sua confirmação antes de fechar isso

1. **App antigo**: como ele modelava tamanho/cor? Se ele já resolvia isso bem, me diga o que
   copiar/evitar antes de eu tratar esta proposta como definitiva.
2. **Preço/custo por variação**: confirma que cada variação pode ter preço/custo próprios (não
   só um preço fixo por produto)? Ajuda a decidir se a tela de cadastro deve pedir isso por
   variação ou só ter um valor padrão com opção de sobrescrever.
3. **Uma grade de tamanho por produto**: confirma que nenhum produto precisa misturar duas
   grades diferentes (ex.: "P/M/G" e "36/38/40" no mesmo item)?
4. **Código de barras**: a loja hoje usa/pretende usar leitor de código de barras no caixa? Se
   sim, o campo já está no schema (`codigo_barras`) — só preciso confirmar se é prioridade pro
   MVP ou fica pra depois.

Nada aqui foi aplicado a um banco ainda — é proposta para revisão.
