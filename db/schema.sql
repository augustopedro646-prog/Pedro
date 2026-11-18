-- Schema inicial do sistema de gestão da ATPN.
-- A aba "Sócios" ainda não entra aqui: o modelo de dado depende da visita
-- do Pedro à associação (ver prompt inicial) — mas já vai incluir sócios
-- só-ATPN e sócios conjuntos CEPE-ATPN como categorias de sócio, não como
-- unidades separadas (o sistema roda só pra ATPN; não há mais conceito de
-- "unidade"/multi-sede). Este schema cobre a base reaproveitada do PDV
-- Jabá: cargos, pessoas, permissões por aba/cargo e histórico de versão de
-- dado sensível.

-- Lista de cargos é editável (tela de Configurações), não um enum fixo.
-- Os três abaixo (seed.sql) são os que o Pedro já adiantou; "resto da
-- equipe" fica a conferir na visita.
CREATE TABLE IF NOT EXISTS cargos (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL UNIQUE,
  administrador BOOLEAN NOT NULL DEFAULT false, -- sempre irrestrito, não aparece na tela de permissões
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pessoas (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  cargo_id INTEGER NOT NULL REFERENCES cargos(id),
  pin_hash TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Abas do menu lateral x cargo. Administrador nunca aparece aqui (sempre
-- irrestrito). Ausência de linha para um par aba/cargo = sem acesso.
CREATE TABLE IF NOT EXISTS permissoes (
  cargo_id INTEGER NOT NULL REFERENCES cargos(id) ON DELETE CASCADE,
  aba TEXT NOT NULL,
  permitido BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (cargo_id, aba)
);

-- Histórico de versão pra dado sensível reescrito por inteiro: protege
-- contra dois dispositivos salvando ao mesmo tempo ou reinício de serviço
-- no meio de uma escrita.
CREATE TABLE IF NOT EXISTS app_dados_historico (
  id SERIAL PRIMARY KEY,
  tabela TEXT NOT NULL,
  registro_id INTEGER NOT NULL,
  dado_anterior JSONB NOT NULL,
  alterado_por INTEGER REFERENCES pessoas(id),
  alterado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pessoas_cargo ON pessoas(cargo_id);
CREATE INDEX IF NOT EXISTS idx_historico_tabela_registro ON app_dados_historico(tabela, registro_id);

-- Bater ponto (aba "ponto"): cada pessoa bate o próprio; tipo alterna com o
-- último registro dela (não depende de "que dia é hoje" pro fuso do
-- servidor) — mesmo padrão do PDV Jabá. Administrador corrige/apaga.
CREATE TABLE IF NOT EXISTS pontos (
  id SERIAL PRIMARY KEY,
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada', 'saida')),
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  corrigido_por INTEGER REFERENCES pessoas(id),
  corrigido_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pontos_pessoa ON pontos(pessoa_id, registrado_em);

-- Fluxo de caixa (aba "fluxo_caixa"): lançamentos manuais de despesa/receita,
-- navegação por mês. "Receita" ainda não tem fonte estruturada (depende do
-- modelo de Sócio/mensalidade, a confirmar com o Pedro) — por ora é
-- lançamento manual igual à despesa, mesmo formato de tabela.
CREATE TABLE IF NOT EXISTS despesas (
  id SERIAL PRIMARY KEY,
  data DATE NOT NULL,
  descricao TEXT NOT NULL,
  categoria TEXT,
  forma_pagamento TEXT,
  valor NUMERIC NOT NULL CHECK (valor > 0),
  criado_por INTEGER REFERENCES pessoas(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_despesas_data ON despesas(data);

CREATE TABLE IF NOT EXISTS receitas (
  id SERIAL PRIMARY KEY,
  data DATE NOT NULL,
  descricao TEXT NOT NULL,
  categoria TEXT,
  forma_pagamento TEXT,
  valor NUMERIC NOT NULL CHECK (valor > 0),
  criado_por INTEGER REFERENCES pessoas(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_receitas_data ON receitas(data);

-- Tarefas (aba "tarefas"): checklist do dia por etapa (abertura/durante o
-- dia/fechamento), atribuída a um cargo — todo mundo daquele cargo vê e
-- marca (mesmo padrão do PDV Jabá). Pra atribuir a mais de um cargo, cria
-- a mesma tarefa de novo pro outro cargo (sem tabela de junção — simples
-- de bastar). Administrador sempre vê todas, cria/edita/remove.
CREATE TABLE IF NOT EXISTS tarefas (
  id SERIAL PRIMARY KEY,
  titulo TEXT NOT NULL,
  descricao TEXT,
  cargo_id INTEGER NOT NULL REFERENCES cargos(id) ON DELETE CASCADE,
  etapa TEXT NOT NULL CHECK (etapa IN ('abertura', 'durante_dia', 'fechamento')),
  -- 'diaria' repete todo dia; 'dias_semana' usa dias_semana (0=domingo..6=sábado);
  -- 'intervalo' repete a cada intervalo_dias dias, contando da criação.
  frequencia TEXT NOT NULL CHECK (frequencia IN ('diaria', 'dias_semana', 'intervalo')),
  dias_semana INTEGER[],
  intervalo_dias INTEGER,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tarefas_cargo ON tarefas(cargo_id) WHERE ativo;

-- Uma linha por tarefa concluída num dia específico — não guarda "pendente"
-- (pendente é só a ausência de linha aqui pra uma tarefa que se aplica ao dia).
CREATE TABLE IF NOT EXISTS tarefas_concluidas (
  id SERIAL PRIMARY KEY,
  tarefa_id INTEGER NOT NULL REFERENCES tarefas(id) ON DELETE CASCADE,
  data DATE NOT NULL,
  concluido_por INTEGER REFERENCES pessoas(id),
  concluido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tarefa_id, data)
);
