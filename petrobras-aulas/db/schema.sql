-- Sistema de controle de professores/turmas do clube da Petrobras.
-- Levantado numa reunião inicial, sem a planilha real deles ainda — campos
-- e regras aqui são o que já dá pra desenvolver.
--
-- Decisão do Pedro: sem cadastro de aluno nem chamada por aluno — o
-- controle é só da diretoria, lançando quando uma aula aconteceu, pra
-- alimentar o cálculo de horas/pagamento dos professores.

-- Só dois tipos de acesso (confirmado na reunião): professor (só enxerga as
-- próprias turmas e o próprio relatório de horas, não lança nada) e
-- diretoria (vê e edita tudo, inclusive lança as aulas dadas). Sem matriz
-- de permissão configurável — é um projeto menor que o CEPE/ATPN, dois
-- papéis fixos bastam.
CREATE TABLE IF NOT EXISTS professores (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('professor', 'diretoria')),
  -- empresa terceirizada que contratou o professor; NULL = quadro próprio
  -- do clube. Guardado solto (não é cadastro de empresas à parte) porque
  -- por ora só precisa aparecer como informação, não como entidade com
  -- regras próprias.
  empresa TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Modalidade já "por nível" (ex: Natação + Infantil A) — nível fica dentro
-- da própria modalidade em vez de tabela separada, pra não inventar uma
-- hierarquia que a planilha real pode não ter.
CREATE TABLE IF NOT EXISTS modalidades (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  nivel TEXT,
  UNIQUE (nome, nivel)
);

-- Turma = uma sigla (ex: TN7, TN14, igual ao que já usam na planilha deles)
-- com modalidade, professor, dias da semana, horário e limite de vagas
-- (só informativo agora — não há mais cadastro de aluno pra ocupar vaga).
CREATE TABLE IF NOT EXISTS turmas (
  id SERIAL PRIMARY KEY,
  sigla TEXT NOT NULL UNIQUE,
  modalidade_id INTEGER NOT NULL REFERENCES modalidades(id),
  professor_id INTEGER REFERENCES professores(id),
  -- dias da semana como texto curto ('seg','ter','qua','qui','sex','sab','dom')
  dias TEXT[] NOT NULL DEFAULT '{}',
  hora_inicio TIME NOT NULL,
  hora_fim TIME NOT NULL,
  vagas INTEGER NOT NULL DEFAULT 0 CHECK (vagas >= 0),
  -- cor pro calendário (hex, ex: '#2f6f4f')
  cor TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_turmas_professor ON turmas(professor_id);
CREATE INDEX IF NOT EXISTS idx_turmas_modalidade ON turmas(modalidade_id);

-- Uma linha por turma+data em que a diretoria lançou que a aula aconteceu.
-- Existir a linha já conta como "aula dada" pro cálculo de horas — não
-- existe lançamento = não houve aula naquele dia (férias, feriado,
-- professor faltou). professor_id grava quem dava a turma na hora do
-- lançamento (não muda se o professor da turma for trocado depois).
CREATE TABLE IF NOT EXISTS aulas_registradas (
  id SERIAL PRIMARY KEY,
  turma_id INTEGER NOT NULL REFERENCES turmas(id),
  data DATE NOT NULL,
  professor_id INTEGER REFERENCES professores(id),
  registrado_por INTEGER REFERENCES professores(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (turma_id, data)
);
CREATE INDEX IF NOT EXISTS idx_aulas_registradas_professor_data ON aulas_registradas(professor_id, data);
