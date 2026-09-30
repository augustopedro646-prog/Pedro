-- Loja Gutto — schema Fase 1 (Fundação): lojas, usuários, produtos com grade
-- tamanho/cor, e vendas. Segue o mesmo espírito do PDV Jabá (loja_id em tudo,
-- id textual gerado no servidor, histórico de movimentos em vez de reescrever
-- estado), com uma diferença de propósito: este sistema é exposto na internet
-- (hospedagem em nuvem, decisão do Pedro), então login usa PIN com hash
-- (bcrypt) e token assinado (JWT) desde o início — o Jabá começou com PIN em
-- texto puro por rodar só em rede local isolada; aqui essa suposição não vale.

CREATE TABLE IF NOT EXISTS lojas (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Só dois papéis (loja pequena, reabrindo): administrador (dono/sócio) e
-- caixa (opera o PDV — é o próprio vendedor, não existe papel "vendedor"
-- separado). pin_hash nunca guarda o PIN em texto puro.
CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  papel TEXT NOT NULL CHECK (papel IN ('administrador', 'caixa')),
  pin_hash TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usuarios_loja_idx ON usuarios(loja_id, ativo);

-- Grade de tamanhos reutilizável (ex.: "Bebê" = RN,P,M,G) — ARRAY preserva a
-- ORDEM de exibição, que uma tabela relacional genérica não garantiria sem
-- coluna de ordenação extra. Ver docs/modelo-produto-variacao.md.
CREATE TABLE IF NOT EXISTS grades_tamanho (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  tamanhos TEXT[] NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grades_tamanho_loja_idx ON grades_tamanho(loja_id);

CREATE TABLE IF NOT EXISTS produtos (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  categoria TEXT,
  descricao TEXT,
  grade_tamanho_id TEXT REFERENCES grades_tamanho(id),
  ncm TEXT, -- opcional, só usado quando a NFC-e entrar (Fase 5)
  foto_url TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS produtos_loja_idx ON produtos(loja_id, ativo);

-- Variação = 1 combinação tamanho+cor = 1 SKU físico com estoque, preço e
-- custo próprios. Peça central que não existe no PDV Jabá.
CREATE TABLE IF NOT EXISTS produto_variacoes (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  produto_id TEXT NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  tamanho TEXT NOT NULL,
  cor TEXT NOT NULL DEFAULT '',
  sku TEXT,
  codigo_barras TEXT,
  preco_venda NUMERIC(12,2) NOT NULL,
  custo_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
  estoque NUMERIC NOT NULL DEFAULT 0,
  estoque_minimo NUMERIC NOT NULL DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS produto_variacoes_produto_tamanho_cor_uk
  ON produto_variacoes(produto_id, tamanho, cor);
CREATE UNIQUE INDEX IF NOT EXISTS produto_variacoes_sku_uk
  ON produto_variacoes(loja_id, sku) WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS produto_variacoes_produto_idx ON produto_variacoes(produto_id);
CREATE INDEX IF NOT EXISTS produto_variacoes_estoque_baixo_idx
  ON produto_variacoes(loja_id) WHERE estoque <= estoque_minimo;

-- Ledger de movimentos — 1 linha por mudança de estoque, custo em snapshot
-- (não retroage se o custo médio mudar depois). Toda baixa/entrada passa por
-- aqui, nunca só por um UPDATE solto em produto_variacoes.estoque.
CREATE TABLE IF NOT EXISTS movimentos_estoque_produto (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  variacao_id TEXT NOT NULL REFERENCES produto_variacoes(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada', 'venda', 'ajuste', 'perda', 'devolucao')),
  quantidade NUMERIC NOT NULL CHECK (quantidade <> 0), -- positivo=entrada, negativo=saída
  custo_unitario NUMERIC NOT NULL DEFAULT 0,
  valor_total NUMERIC NOT NULL DEFAULT 0,
  referencia_tipo TEXT, -- 'venda' | 'compra' | 'contagem' | null
  referencia_id TEXT,
  observacao TEXT,
  criado_por TEXT REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS movimentos_estoque_produto_variacao_idx
  ON movimentos_estoque_produto(variacao_id, criado_em);
CREATE INDEX IF NOT EXISTS movimentos_estoque_produto_loja_tipo_idx
  ON movimentos_estoque_produto(loja_id, tipo, criado_em);

-- Vendas: cabeçalho nunca é reescrito depois de criado (só o campo
-- `cancelada` muda). Vendedor = o próprio usuário logado (loja pequena,
-- caixa e vendedor são a mesma pessoa) — não existe tabela de vendedor.
CREATE TABLE IF NOT EXISTS vendas (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  canal TEXT NOT NULL DEFAULT 'loja' CHECK (canal IN ('loja', 'online')),
  subtotal NUMERIC(12,2) NOT NULL,
  desconto NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL,
  forma_pagamento TEXT NOT NULL,
  cancelada BOOLEAN NOT NULL DEFAULT false,
  cancelada_por TEXT REFERENCES usuarios(id),
  cancelada_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vendas_loja_criado_idx ON vendas(loja_id, criado_em);

-- Itens da venda guardam SNAPSHOT do nome/tamanho/cor/preço no momento da
-- venda (não FK só-leitura pro nome atual) — editar o produto depois não pode
-- reescrever o histórico de uma venda já fechada. Mesmo princípio do `venda
-- jsonb` do Jabá, só que normalizado em vez de blob.
CREATE TABLE IF NOT EXISTS vendas_itens (
  id TEXT PRIMARY KEY,
  venda_id TEXT NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  variacao_id TEXT NOT NULL REFERENCES produto_variacoes(id),
  produto_nome TEXT NOT NULL,
  tamanho TEXT NOT NULL,
  cor TEXT NOT NULL,
  qtd NUMERIC NOT NULL CHECK (qtd > 0),
  preco_unit NUMERIC(12,2) NOT NULL,
  desconto_item NUMERIC(12,2) NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vendas_itens_venda_idx ON vendas_itens(venda_id);
CREATE INDEX IF NOT EXISTS vendas_itens_variacao_idx ON vendas_itens(variacao_id);
