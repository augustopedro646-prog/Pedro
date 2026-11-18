# Sistema de gestão — ATPN

Sistema de gestão da **ATPN** (Associação dos Técnicos em Petróleo de Natal, clube social em
Natal/RN). Projeto irmão do **PDV Jabá**, mesma forma de trabalhar, domínio de negócio diferente
(associação/sócio, não restaurante/mesa).

O sistema roda só pra ATPN — não existe mais conceito de "unidade"/multi-sede (o CEPE deixou de
ser uma unidade operacional separada). A informação de sócios CEPE/ATPN em geral continua
relevante e vai entrar como **categoria de sócio** dentro da futura aba "Sócios" (sócio só-ATPN,
sócio conjunto CEPE-ATPN etc.), não como um sistema paralelo.

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

**Ainda não tem a aba "Sócios"** — o modelo de dado dela depende da visita do Pedro à associação
pra ver o sistema que eles já usam hoje (ver histórico da conversa); quando entrar, a identidade
de pessoa compartilhada com o PDV Jabá (fidelidade, fiado) será por **telefone**, do jeito que o
PDV Jabá já usa hoje. As demais abas (Início, Relatórios, Eventos) existem no menu mas ainda são
só placeholder — o "quiosque" de bater ponto por outra pessoa via PIN (como o PDV Jabá tem)
também não entrou ainda, por depender de como a associação opera fisicamente na prática.

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

## Estrutura

```
db/schema.sql                       tabelas (cargos, pessoas, permissões, ponto, despesas/receitas, tarefas, histórico)
db/seed.sql                          cargos provisórios
server/                              Express: auth HMAC (12h), rate limiting, rotas de config/ponto/financeiro/tarefas/calendário
server/jabaDb.js                     segunda conexão Postgres, só pra agenda_eventos do PDV Jabá (Calendário)
public/index.html                    tela de login + shell + todas as abas com conteúdo real, tudo num arquivo só
scripts/seed-admin.js                cria o primeiro Administrador
scripts/configurar-integracao-jaba.js  passo único: registra a loja "ATPN" no banco do PDV Jabá
```

Padrões reaproveitados do PDV Jabá (mecanismo, não código copiado): histórico de versão pra dado
sensível reescrito por inteiro (`app_dados_historico`), rate limiting por IP normalizado
(`ipKeyGenerator`), `esc()` em todo texto livre antes do `innerHTML`, campo numérico como
`type="text" inputmode="decimal"` + parser próprio.
