# Sistema de gestão — ATPN

Sistema de gestão da **ATPN** (Associação dos Técnicos em Petróleo de Natal, clube social em
Natal/RN). Projeto irmão do **PDV Jabá**, mesma forma de trabalhar, domínio de negócio diferente
(associação/sócio, não restaurante/mesa).

O sistema roda só pra ATPN — não existe mais conceito de "unidade"/multi-sede (o CEPE deixou de
ser uma unidade operacional separada). A informação de sócios CEPE/ATPN entra como **categoria de
sócio** dentro da aba "Sócios" (clube = CEPE ou CEPE-ATPN, ver seção própria abaixo), não como um
sistema paralelo — e, olhando a planilha real, **não existe sócio "só ATPN"**: todo sócio é do
CEPE, uma parte tem ATPN como parceria extra.

## Estado atual

Esqueleto inicial: base de dados, login por PIN, menu lateral, permissões configuráveis por
cargo e cadastro de cargos. Três abas já têm conteúdo real, por não dependerem do levantamento de
cargos/modelo de sócio:

- **Bater ponto** — cada pessoa bate o próprio (entrada/saída alterna sozinho), Administrador
  corrige (`PUT /api/ponto/:id`, ainda sem tela própria pra isso) ou apaga qualquer registro.
- **Fluxo de caixa** — lançamento manual de despesas e receitas, navegação por mês, cartões de
  receita/despesa/saldo, gráfico de tendência dos últimos 6 meses e detalhamento por categoria.
  "Receita" ainda não vem de mensalidade de sócio (isso depende do modelo de Sócio, a confirmar
  com o Pedro) — por ora é lançamento manual, igual à despesa.
- **Tarefas** — checklist do dia por etapa (Abertura/Durante o dia/Fechamento), tarefa atribuída
  a um cargo (todo mundo daquele cargo vê e marca), frequência diária, por dia da semana ou a cada
  N dias. Administrador cadastra/edita/remove.
- **Calendário** — **integrado de verdade com o PDV Jabá**: reservas/eventos são a mesma agenda
  nos dois sistemas (decisão com o Pedro), não uma cópia sincronizada. Usa a tabela
  `agenda_eventos` do banco do PDV Jabá (que já é multi-loja desde o início); a ATPN entra como
  mais uma "loja" lá — um evento criado aqui já aparece sozinho no calendário consolidado do
  admin do PDV Jabá, sem precisar mexer no repositório de lá. Ver "Integração com o PDV Jabá"
  abaixo pra configurar. Sem configurar, a aba funciona normalmente avisando que a integração
  está pendente.

- **Sócios** — importado direto da planilha oficial (`scripts/importar-socios.js`, abas
  "ATIVO GERAL" e "DESLIGADOS"), não cadastrado à mão. Busca por nome em destaque (foco
  automático ao abrir a aba — é o uso principal, recepção conferindo quem chegou), filtro por
  clube (CEPE/CEPE-ATPN) e por situação (Em dia / Até 2 meses / 3 a 5 meses / 6 meses ou mais /
  Desligado — os mesmos buckets que a planilha já resume no rodapé dela, calculados aqui a
  partir do histórico mensal de pagamento, que fica todo guardado pra conferência). Aviso de que
  a planilha tem ~10 dias de defasagem em relação ao bloqueio físico de acesso. Identidade de
  pessoa compartilhada com o PDV Jabá (fidelidade, fiado) será por **telefone** quando/se isso
  for construído — ainda não tem nada ligado.

  Achados reais que corrigem suposições de antes de ter a planilha: não existe dependente
  cadastrado (categoria "Dependente Provisório" = 0 pessoas); a "matrícula dupla" que ~20% dos
  sócios têm é sistema antigo + novo da mesma pessoa, não titular + dependente.

As demais abas (Início, Relatórios, Eventos) existem no menu mas ainda são só placeholder — o
"quiosque" de bater ponto por outra pessoa via PIN (como o PDV Jabá tem) também não entrou ainda,
por depender de como a associação opera fisicamente na prática.

O "Robô WhatsApp" do PDV Jabá não entrou aqui ainda — precisa confirmar com o Pedro se faz
sentido pra esse contexto antes de construir.

## Decisões em aberto

- **Provedor de nuvem** (Railway, Render ou outro) — a decidir com o Pedro.
- **Identidade visual** — a paleta em `public/index.html` já usa as cores da marca da ATPN
  (verde/dourado) e uma marca em SVG inspirada no logo; falta o arquivo oficial (PNG/SVG) do
  logo pra trocar a marca desenhada pela de verdade.
- **Lista de cargos** — hoje só `Administrador`, `Diretor`, `Atendente` (seed provisório); "resto
  da equipe" fica a conferir na visita.
- **Modelo de dado de Sócio** — não inventar sem conversar com o Pedro primeiro.
- **Nota fiscal / recibo** — não é prioridade agora; confirmar com a contadora o que a
  associação realmente precisa emitir antes de desenhar isso.

## Stack (mesmo padrão do PDV Jabá)

- **Backend**: Node.js + Express puro, JavaScript sem TypeScript/build step. **PostgreSQL** via
  `pg` direto (sem ORM), SQL sempre parametrizado. Schema em SQL puro, sem migration framework.
- **Frontend**: `public/index.html` é **um único arquivo** — HTML/CSS/JS puro, sem
  React/bundler/build step. Um `state` global guarda tudo; `render()` reconstrói `#app.innerHTML`
  inteiro a cada mudança; `viewX()` devolvem string de HTML; `attachEvents()` religa os
  `data-action`/`data-nav`/`data-tecla` depois de cada render. Servido como estático pelo Express.
- **Auth**: token assinado à mão com HMAC (`crypto.createHmac`, sem JWT nem lib de sessão),
  validade 12h, conferido sempre no servidor (`server/auth.js`). O PIN, diferente do trecho
  original do PDV Jabá, fica com hash (`bcryptjs`) em vez de texto puro no banco — banco gerenciado
  na nuvem é mais exposto que a máquina local de um restaurante, vale a camada extra.

## Rodando localmente

```bash
cp .env.example .env   # ajustar DATABASE_URL e AUTH_SECRET
npm install
npm run db:schema      # cria as tabelas
npm run db:seed        # cargos provisórios
node scripts/seed-admin.js "Seu Nome" 1234   # cria o primeiro Administrador
npm start
```

Abrir `http://localhost:3001` (porta separada da 3000 do PDV Jabá, pra rodar nos dois ao mesmo
tempo na mesma máquina).

## Integração com o PDV Jabá (Calendário)

Passo único, na máquina onde os dois sistemas rodam juntos:

```bash
JABA_DATABASE_URL="postgresql://postgres:<senha>@localhost:5432/pdv_jaba" node scripts/configurar-integracao-jaba.js
```

A senha é a mesma que já está em `api/.env` do PDV Jabá. O script cria (ou encontra) a loja
"ATPN" no banco do PDV Jabá e imprime `JABA_DATABASE_URL`/`JABA_LOJA_ID` pra colar no `.env`
**deste** projeto. Reinicie o servidor da ATPN depois.

## Importar a planilha de sócios

```bash
node scripts/importar-socios.js "caminho/da/planilha.xlsx"
```

Lê as abas "ATIVO GERAL" e "DESLIGADOS" e popula `socios`/`socios_mensalidades`. Reimportável —
roda de novo a cada planilha nova, sem acumular duplicata (casa por matrícula, ou por nome+clube
quando não tem matrícula, e substitui cadastro + histórico mensal). Segundo argumento opcional:
a data em que essa planilha foi atualizada (`AAAA-MM-DD`); sem ele, usa a data de hoje — é o que
alimenta o aviso dos ~10 dias na aba Sócios. O arquivo da planilha **nunca** deve ir pro
repositório (dado real de sócio) — só rodar local, apontando pro caminho onde ele estiver.
**Passe sempre a data da planilha** (ex.: `node scripts/importar-socios.js planilha.xlsx 2026-11-10`).

Casamento de sócios: matrícula igual **e** nome parecido = mesma pessoa; matrícula igual com nome
diferente = pessoas diferentes (família/erro de digitação), cada uma vira um sócio. Textos como
"desligamento", "desligaod" ou "desigado" na planilha contam como desligado. Depois da importação o
status é recalculado considerando os pagamentos registrados na aba Mensalidades.

## Regras de negócio que não são óbvias

- **Financeiro só da ATPN.** Relatórios, Fluxo de caixa e Início usam apenas sócios `cepe_atpn`;
  dados de sócios do CEPE aparecem somente na aba Sócios.
- **Mensalidade do mês (`server/mensalidades.js`)**: valor da planilha se for > 0; senão a soma dos
  pagamentos registrados na ATPN (aba Mensalidades, tabela `mensalidade_pagamentos`, que a
  reimportação da planilha nunca apaga); senão o que a planilha tiver. O mesmo dinheiro nunca conta
  duas vezes. Só 2026 em diante (2024/2025 existem só para quem já saiu e dariam total falso). O
  mês da planilha e os seguintes são parciais.
- **Estorno** de mensalidade não apaga: marca `cancelado_em` (só Administrador).
- **Despesas** têm tipo (compra/boleto/conta/pagamento/outro) e `pago`. Conta a pagar
  (`pago = false`, `data` = vencimento) não entra no resultado do mês até ser paga; ao pagar, `data`
  vira o dia do pagamento. Foto/PDF da nota fica no Postgres (`despesas_anexos`, entra no backup).
- **Leitura de foto por IA é opcional** (`ANTHROPIC_API_KEY` própria da ATPN no `.env`); sem a
  chave, cadastra-se digitando e a foto fica anexada. A resposta é só rascunho para conferir.
- **Reservas** (aba Eventos): só as confirmadas entram na agenda do PDV Jabá (linha da loja ATPN).
  Conflito de espaço é aviso, nunca bloqueio.
- **Backup**: tarefa `ATPNBackup` (hora em hora, `scripts/backup.ps1`), só cópia local.

## Estrutura

```
db/schema.sql                       tabelas (cargos, pessoas, permissões, ponto, despesas/receitas, tarefas, sócios, histórico)
db/seed.sql                          cargos provisórios
server/                              Express: auth HMAC (12h), rate limiting, rotas de config/ponto/financeiro/tarefas/calendário/sócios
server/jabaDb.js                     segunda conexão Postgres, só pra agenda_eventos do PDV Jabá (Calendário)
public/index.html                    tela de login + shell + todas as abas com conteúdo real, tudo num arquivo só
scripts/seed-admin.js                cria o primeiro Administrador
scripts/configurar-integracao-jaba.js  passo único: registra a loja "ATPN" no banco do PDV Jabá
scripts/importar-socios.js           lê a planilha oficial e popula a aba Sócios (reimportável)
```

Padrões reaproveitados do PDV Jabá (mecanismo, não código copiado): histórico de versão pra dado
sensível reescrito por inteiro (`app_dados_historico`), rate limiting por IP normalizado
(`ipKeyGenerator`), `esc()` em todo texto livre antes do `innerHTML`, campo numérico como
`type="text" inputmode="decimal"` + parser próprio.
