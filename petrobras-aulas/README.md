# Controle de aulas — Clube da Petrobras

Sistema de controle de professores, turmas e chamada do clube da Petrobras. Levantado numa
reunião inicial com o cliente — **ainda não temos a planilha real deles pra migrar os dados**;
o que está aqui é o que já dá pra desenvolver sem ela. Projeto separado do CEPE/ATPN e do PDV
Jabá, mesmo jeito de construir (equipe/padrão reaproveitado, domínio de negócio diferente).

## O que já tem

- **Login por PIN**, dois tipos de acesso fixos: **Professor(a)** (só vê e faz chamada das
  próprias turmas) e **Diretoria** (vê e edita tudo).
- **Turmas**: sigla (mesmo padrão que eles já usam na planilha, ex: `TN7`, `TN14`), modalidade
  (já com nível embutido, ex: "Natação — Infantil A"), professor responsável, dias da semana,
  horário, limite de vagas e cor (pro calendário/aviso de lotação). Mostra vagas ocupadas/livres
  com aviso visual (verde/amarelo/vermelho) direto na listagem.
- **Alunos**: cadastro mínimo (nome, matrícula, situação ativo/inadimplente/suspenso), vínculo
  com turma com histórico — trocar de turma/horário/modalidade fecha o vínculo antigo e abre um
  novo, sem perder o registro de onde o aluno já passou. Confere vaga antes de matricular.
- **Chamada**: professor só chama as turmas que são dele; lista só quem está matriculado agora;
  presença marcada por padrão (desmarca quem faltou).
- **Relatório de horas**: soma as aulas dadas (uma chamada registrada = uma aula) por professor
  no mês, calcula a duração pela turma e já aplica o valor fixo de R$ 35,00/hora citado na
  reunião. Professor só vê o próprio; diretoria vê todo mundo.
- **Calendário**: grade semanal (recorrente por dia da semana) mostrando as turmas com a cor
  cadastrada.
- **Configurações** (diretoria): cadastro de modalidades e de professores/acessos (nome, tipo,
  empresa terceirizada quando for o caso, PIN).

## O que ainda não entrou (de propósito)

- **Modelo de dado definitivo de aluno/matrícula** — depende da planilha real que o cliente vai
  passar pra migração; o que existe hoje é o mínimo pra "conferência de matrícula atualizada"
  funcionar.
- **Calendário por data específica** (feriados, reposição, férias) — só a grade semanal
  recorrente por enquanto.
- **Projetos de campanha de matrícula / divisão ótima de turmas entre professores** — citado na
  reunião como objetivo futuro, não dá pra desenhar sem saber como eles medem isso hoje.
- **Otimização automática de alocação de turmas** — mesma razão acima.

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
db/schema.sql         tabelas (professores, modalidades, turmas, alunos, vínculo aluno-turma com
                       histórico, chamadas, presenças)
db/seed.sql            modalidades provisórias (trocar pelas reais)
server/                Express: auth HMAC (12h), rate limiting, rotas de turmas/alunos/chamadas/relatório
public/index.html      tela de login + shell + todas as abas, tudo num arquivo só
scripts/seed-diretoria.js  cria o primeiro acesso de Diretoria
```
