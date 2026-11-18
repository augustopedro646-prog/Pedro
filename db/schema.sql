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

-- Sócios (aba "socios") — importado da planilha real da associação
-- (scripts/importar-socios.js), não cadastrado manualmente. Achados reais
-- que mudam o que se sabia antes:
--   * Não existe sócio "só ATPN" nessa planilha — todo mundo é sócio do
--     CEPE, e uma parte tem ATPN como parceria extra (clube = 'cepe_atpn').
--     As categorias "Cepe/ATPN", "Aposentado/ATPN" etc. do legado são só
--     o clube 'cepe_atpn' combinado com efetivo/contribuinte/aposentado,
--     não um tipo de sócio à parte.
--   * A "matrícula dupla" (dois números na mesma célula, ~20% das linhas)
--     é sistema antigo + novo da mesma pessoa, não titular+dependente —
--     confirmado pela ausência de nome diferente na segunda matrícula.
--   * Não há dependente nenhum nos dados reais (categoria "Dependente
--     Provisório" = 0 pessoas) — a tabela de dependentes fica pra quando
--     (se) a associação passar a cadastrar isso de verdade.
--   * O "status" não é um campo solto — é calculado a partir do histórico
--     mensal de pagamento, igual ao resumo que a própria planilha já tira
--     (EM DIA / ATÉ 2 MESES / 3 A 5 MESES / 6 MESES OU MAIS / DESLIGADO).
--     Guardamos o histórico completo (`socios_mensalidades`) pra poder
--     reconferir/recalcular, e um status já calculado pra busca/filtro.
CREATE TABLE IF NOT EXISTS socios (
  id SERIAL PRIMARY KEY,
  matricula TEXT,
  matricula_secundaria TEXT, -- número do sistema antigo/novo, quando a célula trazia dois
  nome TEXT NOT NULL,
  cpf TEXT,
  clube TEXT NOT NULL CHECK (clube IN ('cepe', 'cepe_atpn')),
  categoria TEXT CHECK (categoria IN ('efetivo', 'contribuinte')), -- null = legado sem mapeamento claro (ver categoria_original)
  categoria_original TEXT, -- texto/código cru da planilha, pra conferência
  dia_vencimento INTEGER,
  telefone TEXT,
  telefone_secundario TEXT,
  status TEXT NOT NULL CHECK (status IN ('em_dia', 'ate_2_meses', '3_a_5_meses', '6_meses_ou_mais', 'desligado')),
  situacao_especial TEXT, -- ex: "ABONADO", "ISENTO", "Sem margem" no mês mais recente — não é bucket de atraso
  motivo_desligamento TEXT,
  origem_planilha TEXT NOT NULL CHECK (origem_planilha IN ('ativo_geral', 'desligados')),
  planilha_atualizada_em DATE NOT NULL, -- data da própria planilha importada — base pro aviso dos "10 dias"
  importado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_socios_nome ON socios(nome);
CREATE INDEX IF NOT EXISTS idx_socios_matricula ON socios(matricula);
CREATE INDEX IF NOT EXISTS idx_socios_clube_status ON socios(clube, status);

-- Histórico mensal de pagamento, como está na planilha (valor OU uma nota
-- livre tipo "DESLIGADO - ...", "ABONADO", "Sem margem") — fonte de onde
-- o `status` de cima foi calculado na importação.
CREATE TABLE IF NOT EXISTS socios_mensalidades (
  id SERIAL PRIMARY KEY,
  socio_id INTEGER NOT NULL REFERENCES socios(id) ON DELETE CASCADE,
  ano INTEGER NOT NULL,
  mes INTEGER NOT NULL CHECK (mes BETWEEN 1 AND 12),
  valor NUMERIC,
  observacao TEXT,
  UNIQUE (socio_id, ano, mes)
);
CREATE INDEX IF NOT EXISTS idx_socios_mensalidades_socio ON socios_mensalidades(socio_id);

-- Configurações editáveis da associação (nome, contato, endereço, horário de
-- funcionamento). Uma linha por chave, valor em JSON; versões anteriores vão
-- pra app_dados_historico (tabela = 'configuracoes', registro_id = id daqui).
CREATE TABLE IF NOT EXISTS configuracoes (
  id SERIAL PRIMARY KEY,
  chave TEXT NOT NULL UNIQUE,
  valor JSONB NOT NULL,
  atualizado_por INTEGER REFERENCES pessoas(id),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reservas/eventos do espaço da ATPN (aba Eventos). Funil: novo -> negociando
-- -> confirmado | recusado (-> concluido depois da data). Só as CONFIRMADAS
-- viram linha na agenda compartilhada do PDV Jabá (agenda_eventos, loja da
-- ATPN); agenda_id guarda o id dessa linha pra poder editar/remover.
CREATE TABLE IF NOT EXISTS reservas (
  id SERIAL PRIMARY KEY,
  titulo TEXT NOT NULL,
  solicitante TEXT,
  telefone TEXT,
  data DATE NOT NULL,
  hora_inicio TEXT,
  hora_fim TEXT,
  num_convidados INTEGER,
  observacao TEXT,
  status TEXT NOT NULL DEFAULT 'novo' CHECK (status IN ('novo', 'negociando', 'confirmado', 'recusado', 'concluido')),
  agenda_id TEXT,
  criado_por INTEGER REFERENCES pessoas(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reservas_data ON reservas(data);
