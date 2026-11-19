# Controle de aulas — Clube da Petrobras

Sistema de controle de professores, turmas e horas de aula do clube da Petrobras. Levantado numa
reunião inicial com o cliente — **ainda não temos a planilha real deles pra migrar os dados**;
o que está aqui é o que já dá pra desenvolver sem ela. Projeto separado do CEPE/ATPN e do PDV
Jabá, mesmo jeito de construir (equipe/padrão reaproveitado, domínio de negócio diferente).

**Decisão do Pedro**: sem cadastro de aluno nem chamada por aluno — o controle é só da
diretoria, lançando quando uma turma deu aula, pra alimentar o cálculo de horas/pagamento dos
professores. Professor só acessa pra ver (leitura).

## O que já tem

- **Login por PIN**, dois tipos de acesso fixos: **Professor(a)** (só vê as próprias turmas e o
  próprio relatório de horas) e **Diretoria** (vê e edita tudo, inclusive lança as aulas dadas).
- **Turmas**: sigla (mesmo padrão que eles já usam na planilha, ex: `TN7`, `TN14`), modalidade
  (já com nível embutido, ex: "Natação — Infantil A"), professor responsável, dias da semana,
  horário, vagas (informativo) e cor (pro calendário).
- **Registro de aulas**: a diretoria escolhe a turma e marca a data em que ela deu aula — isso
  já entra direto no cálculo de horas. Lista as datas já lançadas no mês (pra evitar duplicar) e
  permite remover um lançamento errado.
- **Relatório de horas**: soma as aulas lançadas por professor no mês, calcula a duração pela
  turma e já aplica o valor fixo de R$ 35,00/hora citado na reunião. Professor só vê o próprio;
  diretoria vê todo mundo.
- **Calendário**: grade semanal (recorrente por dia da semana) mostrando as turmas com a cor
  cadastrada.
- **Configurações** (diretoria): cadastro de modalidades e de professores/acessos (nome, tipo,
  empresa terceirizada quando for o caso, PIN).

## O que ficou de fora (de propósito)

- **Cadastro de aluno e chamada por aluno** — removido a pedido do Pedro: o controle é só da
  diretoria lançando aula dada, não há rastreio de quem compareceu.
- **Calendário por data específica** (feriados, reposição, férias) — só a grade semanal
  recorrente por enquanto.
- **Projetos de campanha de matrícula / divisão ótima de turmas entre professores** — citado na
  reunião como objetivo futuro, não dá pra desenhar sem saber como eles medem isso hoje.

## Stack

Mesmo padrão dos outros sistemas da casa: Node.js + Express puro (sem TypeScript/build step),
PostgreSQL via `pg` direto (sem ORM, SQL parametrizado), frontend num único `public/index.html`
(HTML/CSS/JS puro, sem framework/bundler), auth com token HMAC (`crypto.createHmac`, 12h de
validade, conferido sempre no servidor), PIN com hash `bcryptjs`.

## Rodando localmente

```bash
cp .env.example .env   # ajustar DATABASE_URL (porta sugerida: 3001, não conflita com o CEPE/ATPN) e AUTH_SECRET
npm install
npm run db:schema
npm run db:seed                                    # modalidades provisórias
node scripts/seed-diretoria.js "Seu Nome" 1234      # cria o primeiro acesso de Diretoria
npm start
```

Abrir `http://localhost:3001`. Pela tela de Configurações (logado como Diretoria) dá pra cadastrar
os professores, modalidades reais e turmas.

## Estrutura

```
db/schema.sql           tabelas (professores, modalidades, turmas, aulas_registradas)
db/seed.sql              modalidades provisórias (trocar pelas reais)
server/                  Express: auth HMAC (12h), rate limiting, rotas de turmas/registro/relatório
public/index.html        tela de login + shell + todas as abas, tudo num arquivo só
scripts/seed-diretoria.js   cria o primeiro acesso de Diretoria
```
