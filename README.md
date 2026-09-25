# Sistema de gestão — CEPE / ATPN

Sistema de gestão pra associação que o pai do Pedro dirige (unidades **CEPE**, em Cidade Verde
Nova Parnamirim, e **ATPN**, onde fica a loja do Jaba Mar). Projeto irmão do **PDV Jabá**, mesma
forma de trabalhar, domínio de negócio diferente (associação/sócio, não restaurante/mesa).

## Estado atual

Esqueleto inicial: base de dados, login por PIN, menu lateral, permissões configuráveis por
cargo e cadastro de unidades/cargos. **Ainda não tem a aba "Sócios"** — o modelo de dado dela
depende da visita do Pedro à associação pra ver o sistema que eles já usam hoje (ver histórico da
conversa). As demais abas (Início, Relatórios, Fluxo de caixa, Calendário, Eventos, Tarefas,
Bater ponto) existem no menu mas ainda são só placeholder — conteúdo real vem depois que os
cargos e o fluxo de trabalho real da associação estiverem confirmados.

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

## Rodando localmente

```bash
cp .env.example .env   # ajustar DATABASE_URL e JWT_SECRET
npm install
npm run db:schema      # cria as tabelas
npm run db:seed        # cargos provisórios + unidades CEPE/ATPN
node scripts/seed-admin.js "Seu Nome" 1234   # cria o primeiro Administrador
npm start
```

Abrir `http://localhost:3000`.

## Estrutura

```
db/schema.sql       tabelas (unidades, cargos, pessoas, permissões, histórico de versão)
db/seed.sql          cargos/unidades provisórios
server/              Express: auth (JWT 12h), rate limiting, rotas de config
public/              tela de login + shell (tema claro/escuro, menu lateral, permissões)
scripts/seed-admin.js  cria o primeiro Administrador
```

Padrões reaproveitados do PDV Jabá (mecanismo, não código copiado): histórico de versão pra dado
sensível reescrito por inteiro (`app_dados_historico`), rate limiting por IP normalizado
(`ipKeyGenerator`), `esc()` em todo texto livre antes do `innerHTML`, campo numérico como
`type="text" inputmode="decimal"` + parser próprio.
