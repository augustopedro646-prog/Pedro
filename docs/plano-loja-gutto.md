# Plano — Loja Gutto (sistema de gestão)

Baseado na análise do sistema antigo (`analise-sistema-antigo-gdoor.md`) e nas decisões
tomadas com o Pedro em 30/09/2026. Este documento é o plano de execução — schema → API →
tela, mesma ordem já usada no PDV Jabá, cada pedaço testado isolado antes de virar produção.

## Decisões já fechadas

| Tema | Decisão |
|---|---|
| Stack | Node.js LTS + Express (JS puro, sem TS/build) + PostgreSQL — mesma stack e mesmo estilo do PDV Jabá |
| Frontend | HTML/JS estático sem framework, servido pela própria API — mesmo padrão do Jabá (login PIN, menu lateral, tema claro/escuro — já prototipados) |
| Hospedagem | Nuvem — Pedro vai comprar um host próprio pra rodar vários sistemas seus (não só a Gutto); a API/banco da Gutto são portáveis pra qualquer provedor (Railway/Render/VPS), decisão de qual host fica pra quando ele comprar |
| Offline | **Não é requisito.** Se a internet da loja cair, aceita pausa breve nas vendas até voltar — sistema fica bem mais simples sem precisar de app local + sincronização |
| Pontos de venda | 1 caixa físico + canal de **pedidos online** (o site/loja pro cliente comprar remoto) |

## Modelo de dados (visão geral)

Reaproveita 3 coisas já validadas no Jabá **sem alteração de desenho**: `caixa_sessoes`/
`caixa_movimentos` (livro caixa), `despesas` (fluxo de caixa), `pontos` (bater ponto),
`app_dados_historico` (proteção contra sobrescrita), rate limiting. E reaproveita a lógica
(não a tabela) de `contas_fiado` pra crédito de cliente/vale-troca, e de `pedidos_online`
pro canal de pedido remoto.

**Produto e estoque** (já rascunhado em `db/schema-produtos-proposta.sql`, mantido):
- `grades_tamanho` — lista reutilizável e **reordenável** de tamanhos (resolve a maior dor
  do GDOOR: lá "coluna/linha" não tinha significado fixo).
- `produtos` — produto pai (nome, categoria, NCM, grade).
- `produto_variacoes` — 1 linha por tamanho+cor = 1 SKU/EAN real, com preço, custo e
  estoque próprios. Descrição do produto não carrega tamanho/cor (mesmo padrão do GDOOR,
  que funciona bem) — só a variação diferencia.
- `movimentos_estoque_produto` — ledger de toda entrada/saída, com baixa atômica na venda
  (mesma proteção contra corrida que o Jabá já validou com teste de carga).

**Novo, que o GDOOR trouxe e ainda não tínhamos desenhado:**
- `fornecedores` — cadastro simples.
- `compras` + `compras_itens` — entrada de mercadoria (manual no início; leitura de XML
  fica pra uma fase depois), casando item com `produto_variacoes` por EAN, atualizando
  custo por média ponderada (mesma fórmula que o Jabá já usa em `ingredientes`) e estoque
  via ledger.
- `clientes` — cadastro + saldo de crédito.
- `vale_troca` — crédito de cliente originado de troca/devolução, vinculado à venda de
  origem (evita duplicar lógica de `contas_fiado`).
- `vendas` + `vendas_itens` — cabeçalho e itens, com desconto por item (o GDOOR mostrou que
  é muito comum, chegando a ~30%), vendedor por item (comissão), canal (`loja` | `online`),
  múltiplas formas de pagamento por venda.
- `comissoes_vendedor` / `metas_vendedor` — ranking e comissão, como o GDOOR já tinha.
- `pedidos_online` — canal de pedido remoto (adaptado do Jabá: item vira produto+variação).

**Fica pra quando chegar a hora** (mesma ordem que já estava combinada): `notas_fiscais`
(NFC-e) — a análise trouxe muito detalhe fiscal útil (CSOSN 102, CFOP 5102, NCM por
produto, contingência), guardado no doc de análise pra quando formos construir essa parte.

## Fiscal: provedor vs emissão própria (como você pediu pra comparar)

| | Emissão própria (como o GDOOR faz) | Provedor (Focus NFe — já validado no Jabá) |
|---|---|---|
| Custo | Sem custo por nota | Custo por nota emitida (tabela do provedor) |
| Trabalho de construir | Alto — protocolo inteiro da SEFAZ (assinatura, contingência, DANFE) do zero | Baixo — reaproveita conhecimento e parte do código já testado no Jabá (`api/fiscal.js`) |
| Risco | Todo nosso (foi o que causou a contingência por certificado vencido no GDOOR) | Compartilhado com o provedor, que já opera em produção |

**Recomendação**: seguir com Focus NFe, mesmo caminho do Jabá — mas isso só entra quando
chegarmos na fase fiscal (ver ordem de entrega abaixo), não agora.

## Telas

Já prototipadas (protótipo HTML que te mandei): Login (PIN), Início, Venda rápida, Estoque,
Fluxo de caixa, Equipe, Bater ponto (com reconhecimento facial), Relatórios básicos.

Precisam ser criadas: **Compras/Entrada de nota**, **Clientes** (cadastro + crédito/vale-troca),
**Pedidos online**, **Configurações** (grades de tamanho, cargos, dados da loja).

Precisam crescer em cima do protótipo: Venda rápida (desconto por item, forma de pagamento
múltipla, vendedor por item, troca/devolução), Relatórios (curva ABC, giro de estoque,
comissão, metas — hoje só tem produtos mais vendidos e formas de pagamento).

## Ordem de entrega

1. **Fundação** — banco de verdade (não mais proposta), login com PIN real (hash, não texto
   puro), Produtos/Estoque com grade tamanho×cor, Venda rápida ligada ao banco (decremento
   atômico de estoque).
2. **Operação da loja** — Fluxo de caixa real, Clientes (crédito/vale-troca), Compras/
   Entrada de nota (lançamento manual pra começar), Equipe com papéis/permissões reais,
   Bater ponto.
3. **Canal online** — Pedidos online.
4. **Relatórios completos** — curva ABC, giro, comissão, metas, estoque baixo por grade.
5. **Fiscal** — NFC-e via Focus NFe.
6. **Migração do GDOOR** — produtos, grade, clientes, saldos — quando você conseguir a
   senha do Firebird (não bloqueia nenhuma fase anterior).

## Decisões fechadas em 30/09/2026 (2ª rodada)

1. **Cargos**: só **Administrador** e **Caixa** têm login no sistema — bem mais simples
   que o GDOOR. Loja pequena reabrindo: **o caixa é o próprio vendedor**, então não existe
   cadastro de vendedor separado — quem vendeu cada item é sempre o usuário logado no
   momento da venda (auto-atribuído, sem seleção manual). Comissão/meta (Fase 4) calculam
   em cima do usuário, não de uma entidade "vendedor" à parte. Sem Gerente — Administrador
   acumula a aprovação de desconto acima do limite (mesmo modelo que o Jabá já usa).
2. **Fidelidade**: entra **já na primeira versão** — cashback, reaproveitando a lógica
   já validada no Jabá Club (crédito só uma vez, na confirmação da venda, nunca
   duplicado). Passa a fazer parte da Fase 1/2, não da Fase 4.
3. **Migração**: confirmado que **não bloqueia o lançamento** — a loja começa com
   catálogo cadastrado na mão; histórico do GDOOR migra depois (Fase 6), quando a senha
   do Firebird estiver disponível.

## Ajuste na ordem de entrega (com as decisões acima)

1. **Fundação** — banco real, login com PIN de verdade (hash), papéis Administrador/Caixa,
   Produtos/Estoque com grade tamanho×cor, Venda rápida ligada ao banco (decremento
   atômico de estoque, vendedor = usuário logado).
2. **Operação da loja** — Fluxo de caixa real, Clientes (crédito/vale-troca + **cashback**),
   Compras/Entrada de nota, Bater ponto.
3. **Canal online** — Pedidos online.
4. **Relatórios completos** — curva ABC, giro, comissão, metas, estoque baixo por grade.
5. **Fiscal** — NFC-e via Focus NFe.
6. **Migração do GDOOR** — produtos, grade, clientes, saldos.

Plano fechado — pronto pra começar a Fase 1.

## Andamento

- **Fase 1 — Fundação: concluída.** Banco real, login com PIN (hash), Produtos/Estoque com
  grade tamanho×cor, Venda rápida ligada ao banco. Instalado no PC da loja (C:\LojaGutto).
- **Fase 2 — Operação da loja: concluída (30/09/2026).**
  - Caixa: abertura com troco, suprimento, sangria, fechamento com contagem cega
    (esperado × contado) e histórico de fechamentos (só Administrador vê).
  - Venda rápida: leitor de código de barras (EAN-13 interno gerado automaticamente por
    tamanho/cor), desconto por item em % (Caixa até o limite configurado — padrão 10% —
    acima disso pede PIN de Administrador), pagamento dividido em várias formas com troco,
    cliente na venda.
  - Clientes: cadastro, cashback (padrão 5%, só sobre o que foi pago sem crédito),
    vale-troca, extrato de crédito e últimas compras.
  - Troca/devolução: peça volta pro estoque, cliente ganha vale-troca pelo valor pago
    (já com desconto), cashback da venda é estornado na proporção.
  - Compras: entrada de nota manual por grade, custo médio ponderado, fornecedor
    cadastrado na hora, lançamento opcional como despesa no fluxo.
  - Fluxo de caixa real por mês (receita por forma; cashback/vale-troca usados não contam
    como receita), despesas com inclusão/exclusão.
  - Equipe: criar/editar usuários, trocar PIN, desativar; configuração de cashback % e
    desconto livre %.
  - Estoque: editar produto, preço, código de barras, mínimo, ativar/desativar variação,
    ajuste de contagem (fica no histórico), nova cor.
  - Bater ponto gravado no banco (PIN da própria pessoa ou reconhecimento facial).
- **Próximas**: Fase 3 (pedidos online), Fase 4 (relatórios), Fase 5 (NFC-e), Fase 6
  (migração do GDOOR). Também na fila: importar XML de nota do fornecedor e imprimir
  etiqueta de código de barras.
