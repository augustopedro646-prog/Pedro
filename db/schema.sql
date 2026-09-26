-- Schema inicial do sistema de gestão CEPE/ATPN.
-- A aba "Sócios" ainda não entra aqui: o modelo de dado depende da visita
-- do Pedro à associação (ver prompt inicial). Este schema cobre só a base
-- reaproveitada do PDV Jabá: unidades, cargos, pessoas, permissões por
-- aba/cargo e histórico de versão de dado sensível.

CREATE TABLE IF NOT EXISTS unidades (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL UNIQUE,
  cnpj TEXT,
  contato TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- Quais unidades cada pessoa acessa. Login só pede pra escolher unidade
-- quando a pessoa tem mais de uma linha aqui.
CREATE TABLE IF NOT EXISTS pessoa_unidades (
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  unidade_id INTEGER NOT NULL REFERENCES unidades(id) ON DELETE CASCADE,
  PRIMARY KEY (pessoa_id, unidade_id)
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
  unidade_id INTEGER NOT NULL REFERENCES unidades(id) ON DELETE CASCADE,
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada', 'saida')),
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  corrigido_por INTEGER REFERENCES pessoas(id),
  corrigido_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pontos_unidade_pessoa ON pontos(unidade_id, pessoa_id, registrado_em);

-- Fluxo de caixa (aba "fluxo_caixa"): lançamentos manuais de despesa/receita
-- por unidade, navegação por mês. "Receita" ainda não tem fonte estruturada
-- (depende do modelo de Sócio/mensalidade, a confirmar com o Pedro) — por
-- ora é lançamento manual igual à despesa, mesmo formato de tabela.
CREATE TABLE IF NOT EXISTS despesas (
  id SERIAL PRIMARY KEY,
  unidade_id INTEGER NOT NULL REFERENCES unidades(id) ON DELETE CASCADE,
  data DATE NOT NULL,
  descricao TEXT NOT NULL,
  categoria TEXT,
  forma_pagamento TEXT,
  valor NUMERIC NOT NULL CHECK (valor > 0),
  criado_por INTEGER REFERENCES pessoas(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_despesas_unidade_data ON despesas(unidade_id, data);

CREATE TABLE IF NOT EXISTS receitas (
  id SERIAL PRIMARY KEY,
  unidade_id INTEGER NOT NULL REFERENCES unidades(id) ON DELETE CASCADE,
  data DATE NOT NULL,
  descricao TEXT NOT NULL,
  categoria TEXT,
  forma_pagamento TEXT,
  valor NUMERIC NOT NULL CHECK (valor > 0),
  criado_por INTEGER REFERENCES pessoas(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_receitas_unidade_data ON receitas(unidade_id, data);
