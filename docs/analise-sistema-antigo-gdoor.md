# Análise do sistema antigo — GDOOR PRO

Levantamento feito pelo Pedro (auditoria só-leitura, sem alterar nada em produção)
no sistema que a loja usa hoje. Serve de referência de negócio e de modelo de
dados pro sistema novo (Loja Gutto) — **não é pra copiar os problemas dele**,
listados no fim. Fonte: análise 1:1 do banco/telas do GDOOR PRO rodando na loja.

## Contexto do negócio

- Loja física de moda infantil e artigos para presentes, em shopping
  (Parnamirim/RN). Regime Simples Nacional (CRT=1).
- Sistema antigo: **GDOOR PRO** — desktop Windows, Delphi, banco **Firebird
  2.0**, rede local com servidor de PDV. Está em produção, não pode ser mexido.
- Uso real medido nas NFC-e guardadas: ~2.600 XMLs de NFC-e (jan/2024 a
  jan/2026) e ~280 NF-e. Mix de pagamento nas NFC-e: crédito ~1.670, débito
  ~250, dinheiro ~160, PIX ~80, outros ~100. ~260 notas saíram em contingência
  offline. Desconto por item é muito comum (ex.: ~30% por item numa venda de
  exemplo). Ticket e itens por venda: de 1 a vários itens; unidade sempre UND.

## Produtos e grade (tamanho/cor)

- Tabela `estoque`: `codigo` (6 dígitos sequencial), `barras` (EAN, prefixo
  790 = interno), `cod_fabricante`, `descricao`, `und`, `grupo`, `familia`,
  `caracteristicas`, `elo`, `cod_ncm`, `st`, `preco_custo`, `preco_venda`,
  `qtd`, `validade`, `situacao` (Ativo/Inativo).
- Cada combinação tamanho/cor é um **produto separado** em `estoque` (código e
  barras próprios). Ligação por: `variacao` (id, titulo_variacao),
  `variacao_itens` (id, id_variacao, coluna, linha → grade bidimensional,
  exibida "coluna/linha", ex. "P/Azul"), `variacao_estoque` (codigo filho,
  codigo_matriz pai, id_variacao_itens). Exclusão lógica (`deleted_at`).
  Grades são reutilizáveis entre produtos.
- Tabelas de preço: `tabelapreco` + `tabelapreco_item` (codigo, preco_venda
  por tabela).
- Descrição do produto não carrega tamanho/cor (ex.: "VESTIDO PEROLA LINHO
  MARIE PRINCESS"); só a grade diferencia.
- Etiquetas de produto em 2 tamanhos (36 e 42 mm) para impressora Elgin L42;
  código de barras impresso.

## Estoque

- Saldo por variação (`estoque.qtd`), histórico em `estoque_movimentacoes`
  (data, produto, quantidade, tipo). Baixa automática na venda.
- Relatórios existentes e usados: estoque mínimo, estoque por grade,
  quantidade por tamanho, movimentação de item, curva ABC, giro de mercadoria
  (por grupo/fornecedor), inventário e conferência, previsão de compra, tempo
  em estoque, lucro bruto/margem, custo de aquisição, produtos vendidos por
  variação (analítico e sintético), produtos cadastrados por variação, vendas
  por gênero.

## Compras / entrada de notas

- Entrada por importação do XML do fornecedor, com `fator_conversao` (un.
  compra → un. venda), flag `importado_xml` e rastreabilidade (lote,
  fabricação, validade). Guarda ICMS, ICMS-ST, IPI, frete, seguro, desconto,
  outros, tributos aproximados, transportadora.
- Existem pedido de compra, cotação (comparativo de fornecedores),
  conferência de compra, débito/crédito de ICMS de compras, compras por
  CFOP/CST.
- **Não verificado**: como a nota atualiza custo/estoque e casa itens com
  variações — desenhar isso do zero na Gutto.

## Fiscal

- NFC-e modelo 65, série 1, layout 4.00, **emissão própria direta na
  SEFAZ-RN** com certificado digital A1 (sem provedor tipo Focus NFe).
  Ambiente de produção. Contingência offline (tpEmis 9) quando falha; já
  ocorreu por certificado vencido.
- Itens: CFOP 5102, CSOSN 102 (orig 0), NCM por produto (ex.: 61044200
  vestido, 62034200), unidade UND, tributos aproximados IBPT no texto
  adicional. Informação adicional traz vendedor, operador e nº da pré-venda.
  Grava valor de desconto por item. Pagamento com tPag (01 dinheiro, 03
  crédito, 04 débito, 17 PIX…) e dados de cartão (CNPJ credenciadora,
  bandeira, autorização).
- Também presente no sistema (módulos maiores que a loja usa): NF-e 55,
  SAT/CF-e, NFS-e, CT-e/MDF-e, manifestação do destinatário, carta de
  correção, cancelamento/inutilização, envio de XMLs ao contador (e-mail
  automático), preparação para reforma tributária (IBS/CBS). **Pra loja, o
  essencial é NFC-e + NF-e (devolução/entrada) + XML ao contador.**

## Vendas / PDV

- Fluxo: pré-venda (vendedor monta) → caixa converte em venda + NFC-e.
  Também orçamento, pedido de venda, DAV.
- `vendas` (nota, modelo, serie, data_emissao, hora_saida, cliente, operador,
  natureza, cfop, nfe_status, processada, cancelada, mov_financeiro,
  totais/impostos) e `itevendas` (id_vendas, codigo, barras, descricao, und,
  qtd, valor_unita, desconto, id_vendedor, vendedor, cancelada, campos de
  imposto).
- Vendedor por item e comissão por vendedor; metas mensais por vendedor
  (`meta_geral`, `meta_vendedores`).
- Pagamentos: dinheiro, cartão crédito/débito (bandeira, NSU, autorização,
  parcelas, taxa por operadora/parcela/antecipação, dias para receber, plano
  de contas), PIX, crediário (contas a receber), cheque, Vale Troca. TEF/SiTef
  existe mas está desligado; usam maquininha/POS separada.
- Troca/devolução: `troca_extrato` + `troca_extrato_item` (item da venda
  original, quantidade), gera Vale Troca; nota referenciada (`nfref`) em
  devolução.
- Cancelamento de venda/item com registro do usuário. Caixa: abertura,
  suprimento/sangria, fechamento (relatório 80mm), movimentação por operador
  e espécie.
- Impressão de cupom em térmica 80mm; busca de produto por código de barras,
  código ou nome (com opção fonética).

## Clientes / fidelidade

- Cadastro (código, nome, fantasia, CPF/CNPJ, endereço, telefone…), contatos
  e aniversariantes. Relatórios: ficha, histórico financeiro, ranking/ABC,
  recompra, clientes que não compram no período, aniversariantes, prazo
  médio, inadimplência, clientes com crédito.
- Fidelidade: **não há** pontos/cashback ativo (configuração "Nenhuma"). Só
  crédito de cliente e Vale Troca.

## Financeiro e outros

- Contas a pagar/receber, plano de contas, centro de custo, caixa, extrato
  bancário, fluxo de caixa, boletos/carnê/cheque, conciliação de cartão
  (`movimentacao_cartao`, `taxas_cartao`).
- Módulos do produto que **não** interessam a esta loja: restaurante/
  pizzaria (comandas, mesas, adicionais), ótica, ordem de serviço, CT-e/
  MDF-e, entregas, iFood, autoatendimento.

## Relatórios (~200 modelos; os relevantes)

Vendas totais/por dia/mês/vendedor/operador/cliente/grupo/estado/espécie de
pagamento; produtos vendidos (com grade); canceladas; fechamento de caixa;
NFC-e emitidas; a receber/a pagar; comissão; metas; cartão; compras por
fornecedor/período; estoque (lista acima); clientes (lista acima). Filtros
típicos: período, cliente, fornecedor, grupo, vendedor, operador, variação.

## Usuários

Login por usuário; usuário padrão ADMINISTRADOR; controle de usuários
conectados; auditoria de cancelamentos por usuário. Níveis de permissão não
verificados.

## Limitações / dores observadas (fatos, não opinião)

- Grade duplica o cadastro: 1 produto por tamanho/cor; `coluna`/`linha` sem
  semântica fixa (o que é tamanho e o que é cor depende do cadastro);
  reordenar/editar grade não ficou claro.
- Descrição sem tamanho/cor; o cliente/vendedor precisa entender a grade
  pra achar o item.
- Muitos módulos irrelevantes pra loja de roupa (restaurante, ótica, CT-e),
  ~200 relatórios, muitas variantes duplicadas.
- Sistema local (rede + Firebird + servidor de PDV), sem acesso remoto
  simples; atualização por instalador.
- Certificado vencido gerou contingência em várias notas; sem alerta visível
  de vencimento (não confirmado em tela).
- Não verificado ainda: telas/cliques exatos, permissões, como a compra
  atualiza custo. Tratar como oportunidade de redesenho, não como requisito.

## O que o Pedro quer no sistema novo (ponto de partida pro plano)

1. Produto com grade tamanho × cor em um único cadastro (produto pai com
   variações geradas por grade reutilizável e reordenável), SKU/EAN por
   variação, estoque por variação, mínimo e alerta.
2. Entrada de nota por XML com conferência, atualização de custo/estoque e
   sugestão de preço/margem.
3. PDV rápido (leitor de código de barras), desconto por item/venda com
   permissão, múltiplas formas de pagamento por venda, troca/devolução com
   Vale Troca, vendedor por item, comissão e metas.
4. Fiscal: NFC-e (e NF-e de devolução/entrada), CSOSN 102 / CFOP 5102 / NCM
   por produto, ambiente homologação/produção, alerta de validade do
   certificado, contingência. Avaliar provedor (ex.: Focus NFe) vs emissão
   própria — comparar custo/risco antes de decidir.
5. Clientes com crédito/Vale Troca e, opcionalmente, fidelidade
   (pontos/cashback).
6. Financeiro básico (contas a pagar/receber, conciliação de cartão) e um
   conjunto enxuto de relatórios (vendas, estoque/curva ABC/giro, caixa,
   comissão, clientes).
7. Usuários e permissões (dono, gerente, vendedor, caixa).
8. Migração dos dados do sistema antigo (produtos, grade, clientes, saldos)
   — banco de origem Firebird 2.0; senha ainda não obtida, tratar como
   pendência.
