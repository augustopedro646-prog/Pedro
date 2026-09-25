# Sistema de gestão — CEPE / ATPN

Sistema de gestão pra associação que o pai do Pedro dirige (unidades **CEPE**, em Cidade Verde
Nova Parnamirim, e **ATPN**, onde fica a loja do Jaba Mar). Projeto irmão do **PDV Jabá**, mesma
forma de trabalhar, domínio de negócio diferente (associação/sócio, não restaurante/mesa).

## Estado atual

Esqueleto inicial: base de dados, login por PIN, menu lateral, permissões configuráveis por
cargo e cadastro de unidades/cargos. Duas abas já têm conteúdo real, por não dependerem do
levantamento de cargos/modelo de sócio:

- **Bater ponto** — cada pessoa bate o próprio (entrada/saída alterna sozinho), Administrador
  corrige (`PUT /api/ponto/:id`, ainda sem tela própria pra isso) ou apaga qualquer registro.
- **Fluxo de caixa** — lançamento manual de despesas e receitas por unidade, navegação por mês,
  categoria e forma de pagamento livres. "Receita" ainda não vem de mensalidade de sócio (isso
  depende do modelo de Sócio, a confirmar com o Pedro) — por ora é lançamento manual, igual à
  despesa.

**Ainda não tem a aba "Sócios"** — o modelo de dado dela depende da visita do Pedro à associação
pra ver o sistema que eles já usam hoje (ver histórico da conversa). As demais abas (Início,
Relatórios, Calendário, Eventos, Tarefas) existem no menu mas ainda são só placeholder — o
"quiosque" de bater ponto por outra pessoa via PIN (como o PDV Jabá tem) também não entrou ainda,
por depender de como a associação opera fisicamente na prática.

O "Robô WhatsApp" do PDV Jabá não entrou aqui ainda — precisa confirmar com o Pedro se faz
sentido pra esse contexto antes de construir.

## Decisões em aberto

- **Provedor de nuvem** (Railway, Render ou outro) — a decidir com o Pedro.
- **Identidade visual** — a paleta em `public/index.html` é neutra/provisória; trocar quando
  tiver logo/cores reais do CEPE/ATPN.
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
npm run db:seed        # cargos provisórios + unidades CEPE/ATPN
node scripts/seed-admin.js "Seu Nome" 1234   # cria o primeiro Administrador
npm start
```

Abrir `http://localhost:3000`.

## Estrutura

```
db/schema.sql        tabelas (unidades, cargos, pessoas, permissões, ponto, despesas/receitas, histórico)
db/seed.sql           cargos/unidades provisórios
server/               Express: auth HMAC (12h), rate limiting, rotas de config/ponto/financeiro
public/index.html     tela de login + shell + Bater ponto + Fluxo de caixa, tudo num arquivo só
scripts/seed-admin.js  cria o primeiro Administrador
```

Padrões reaproveitados do PDV Jabá (mecanismo, não código copiado): histórico de versão pra dado
sensível reescrito por inteiro (`app_dados_historico`), rate limiting por IP normalizado
(`ipKeyGenerator`), `esc()` em todo texto livre antes do `innerHTML`, campo numérico como
`type="text" inputmode="decimal"` + parser próprio.
