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

-- ============================================================================
-- Fase 2 — caixa, pagamentos, clientes/crédito, devoluções, fluxo, compras, ponto
-- Tudo idempotente (IF NOT EXISTS), pode rodar em cima de um banco da Fase 1.
-- ============================================================================

-- Parâmetros da loja: % de cashback creditado ao cliente e limite de desconto que o
-- Caixa pode dar sem PIN de Administrador (acima disso, precisa aprovação).
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS cashback_pct NUMERIC NOT NULL DEFAULT 5;
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS desconto_livre_pct NUMERIC NOT NULL DEFAULT 10;

-- Código de barras interno: EAN-13 com prefixo 2 (faixa GS1 de uso interno da loja).
-- Sequência garante que nunca repete; o dígito verificador é calculado no servidor.
CREATE SEQUENCE IF NOT EXISTS codigo_barras_seq;
CREATE UNIQUE INDEX IF NOT EXISTS produto_variacoes_codigo_barras_uk
  ON produto_variacoes(loja_id, codigo_barras) WHERE codigo_barras IS NOT NULL;

-- Livro caixa: uma sessão aberta por vez (índice parcial garante no banco, mesmo
-- padrão do Jabá). Venda só passa com sessão aberta.
CREATE TABLE IF NOT EXISTS caixa_sessoes (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  aberto_por TEXT NOT NULL REFERENCES usuarios(id),
  aberto_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  dinheiro_inicial NUMERIC(12,2) NOT NULL DEFAULT 0,
  fechado BOOLEAN NOT NULL DEFAULT false,
  fechado_por TEXT REFERENCES usuarios(id),
  fechado_em TIMESTAMPTZ,
  dinheiro_esperado NUMERIC(12,2),
  dinheiro_contado NUMERIC(12,2),
  diferenca NUMERIC(12,2),
  observacao TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS caixa_sessoes_uma_aberta_idx ON caixa_sessoes(loja_id) WHERE NOT fechado;
CREATE INDEX IF NOT EXISTS caixa_sessoes_loja_idx ON caixa_sessoes(loja_id, aberto_em);

CREATE TABLE IF NOT EXISTS caixa_movimentos (
  id TEXT PRIMARY KEY,
  sessao_id TEXT NOT NULL REFERENCES caixa_sessoes(id) ON DELETE CASCADE,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('suprimento', 'sangria')),
  valor NUMERIC(12,2) NOT NULL CHECK (valor > 0),
  descricao TEXT,
  criado_por TEXT NOT NULL REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS caixa_movimentos_sessao_idx ON caixa_movimentos(sessao_id);

CREATE TABLE IF NOT EXISTS clientes (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  telefone TEXT,
  cpf TEXT,
  nascimento DATE,
  observacao TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS clientes_telefone_uk ON clientes(loja_id, telefone) WHERE telefone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS clientes_cpf_uk ON clientes(loja_id, cpf) WHERE cpf IS NOT NULL;
CREATE INDEX IF NOT EXISTS clientes_loja_nome_idx ON clientes(loja_id, nome);

-- Crédito do cliente como ledger (nunca um saldo reescrito): saldo = soma de valor por
-- tipo. cashback = % creditado nas compras; vale_troca = gerado em devolução.
-- O índice único impede creditar o cashback de uma mesma venda duas vezes — o bug real
-- que o Jabá Club teve (crédito em dois lugares) não tem como acontecer aqui.
CREATE TABLE IF NOT EXISTS cliente_creditos (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  cliente_id TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('cashback', 'vale_troca')),
  valor NUMERIC(12,2) NOT NULL CHECK (valor <> 0),
  origem TEXT NOT NULL CHECK (origem IN ('venda', 'uso_em_venda', 'devolucao', 'ajuste')),
  referencia_id TEXT,
  observacao TEXT,
  criado_por TEXT REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cliente_creditos_unico_uk
  ON cliente_creditos(cliente_id, tipo, origem, referencia_id) WHERE referencia_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cliente_creditos_cliente_idx ON cliente_creditos(cliente_id, criado_em);

ALTER TABLE vendas ADD COLUMN IF NOT EXISTS caixa_sessao_id TEXT REFERENCES caixa_sessoes(id);
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS cliente_id TEXT REFERENCES clientes(id);
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS aprovado_por TEXT REFERENCES usuarios(id);
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS cashback_gerado NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Uma venda pode ser paga em várias formas (ex.: parte vale-troca, parte Pix).
-- valor é o que foi APLICADO na venda (troco de dinheiro não entra aqui).
CREATE TABLE IF NOT EXISTS venda_pagamentos (
  id TEXT PRIMARY KEY,
  venda_id TEXT NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  forma TEXT NOT NULL CHECK (forma IN ('Dinheiro', 'Débito', 'Crédito', 'Pix', 'Cashback', 'Vale-troca')),
  valor NUMERIC(12,2) NOT NULL CHECK (valor > 0)
);
CREATE INDEX IF NOT EXISTS venda_pagamentos_venda_idx ON venda_pagamentos(venda_id);

-- Troca/devolução: devolve a peça ao estoque e gera vale-troca pro cliente.
CREATE TABLE IF NOT EXISTS devolucoes (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  venda_id TEXT NOT NULL REFERENCES vendas(id),
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  valor_total NUMERIC(12,2) NOT NULL,
  observacao TEXT,
  criado_por TEXT NOT NULL REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devolucoes_venda_idx ON devolucoes(venda_id);

CREATE TABLE IF NOT EXISTS devolucoes_itens (
  id TEXT PRIMARY KEY,
  devolucao_id TEXT NOT NULL REFERENCES devolucoes(id) ON DELETE CASCADE,
  venda_item_id TEXT NOT NULL REFERENCES vendas_itens(id),
  variacao_id TEXT NOT NULL REFERENCES produto_variacoes(id),
  qtd NUMERIC NOT NULL CHECK (qtd > 0),
  valor NUMERIC(12,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS devolucoes_itens_venda_item_idx ON devolucoes_itens(venda_item_id);

-- Fluxo de caixa (contabilidade do mês). Receita não tem tabela: sai de venda_pagamentos.
CREATE TABLE IF NOT EXISTS despesas (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  data DATE NOT NULL,
  descricao TEXT NOT NULL,
  categoria TEXT,
  forma_pagamento TEXT,
  valor NUMERIC(12,2) NOT NULL CHECK (valor > 0),
  criado_por TEXT REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS despesas_loja_data_idx ON despesas(loja_id, data);

CREATE TABLE IF NOT EXISTS fornecedores (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  cnpj TEXT,
  telefone TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fornecedores_loja_nome_uk ON fornecedores(loja_id, lower(nome));

-- Entrada de nota (manual por enquanto; importação de XML vem depois).
CREATE TABLE IF NOT EXISTS compras (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  fornecedor_id TEXT REFERENCES fornecedores(id),
  numero_nota TEXT,
  data DATE NOT NULL,
  total NUMERIC(12,2) NOT NULL,
  despesa_id TEXT REFERENCES despesas(id),
  observacao TEXT,
  criado_por TEXT NOT NULL REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS compras_loja_data_idx ON compras(loja_id, data);

CREATE TABLE IF NOT EXISTS compras_itens (
  id TEXT PRIMARY KEY,
  compra_id TEXT NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
  variacao_id TEXT NOT NULL REFERENCES produto_variacoes(id),
  qtd NUMERIC NOT NULL CHECK (qtd > 0),
  custo_unitario NUMERIC(12,2) NOT NULL CHECK (custo_unitario >= 0)
);
CREATE INDEX IF NOT EXISTS compras_itens_compra_idx ON compras_itens(compra_id);

-- Leitura de nota (XML/PDF/foto): a chave de 44 dígitos impede lançar a mesma NF-e duas vezes.
ALTER TABLE compras ADD COLUMN IF NOT EXISTS chave_nfe TEXT;
ALTER TABLE compras ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'manual';
CREATE UNIQUE INDEX IF NOT EXISTS compras_loja_chave_uk ON compras(loja_id, chave_nfe) WHERE chave_nfe IS NOT NULL;

-- Código/referência que o fornecedor usa pra cada peça: aprendido ao confirmar uma nota, casa
-- sozinho nas próximas notas do mesmo fornecedor (muita confecção pequena não usa código de barras).
CREATE TABLE IF NOT EXISTS fornecedor_codigos (
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  fornecedor_id TEXT NOT NULL REFERENCES fornecedores(id) ON DELETE CASCADE,
  codigo TEXT NOT NULL,
  variacao_id TEXT NOT NULL REFERENCES produto_variacoes(id) ON DELETE CASCADE,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (loja_id, fornecedor_id, codigo)
);

-- Bater ponto. metodo registra se veio de PIN (conferido no servidor) ou do
-- reconhecimento facial (que roda no navegador — fica anotado pra auditoria).
CREATE TABLE IF NOT EXISTS pontos (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada', 'saida')),
  metodo TEXT NOT NULL CHECK (metodo IN ('pin', 'facial')),
  registrado_por TEXT REFERENCES usuarios(id),
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pontos_loja_usuario_idx ON pontos(loja_id, usuario_id, registrado_em);

-- Calendário (mesmo modelo do Jabá): eventos da loja e escala da equipe. Todo mundo vê, só o
-- Administrador cria/edita. Horário é texto HH:MM (opcional).
CREATE TABLE IF NOT EXISTS agenda_eventos (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('evento', 'escala')),
  data DATE NOT NULL,
  hora_inicio TEXT,
  hora_fim TEXT,
  titulo TEXT NOT NULL,
  usuario_id TEXT REFERENCES usuarios(id) ON DELETE CASCADE,
  observacao TEXT,
  criado_por TEXT REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agenda_eventos_loja_data_idx ON agenda_eventos(loja_id, data);

-- ================= Pedidos online (site da loja) =================
-- Configuração do site, na própria loja.
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS site_ativo BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS aceita_entrega BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS aceita_retirada BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS taxa_entrega NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS whatsapp TEXT;
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS endereco TEXT;
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS mensagem_site TEXT;

-- Produto aparece no site só se estiver ativo, publicado e com alguma variação com estoque.
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS publicado BOOLEAN NOT NULL DEFAULT true;

-- Fotos no próprio banco (vão junto no backup e na mudança pra nuvem, sem pasta de arquivos à parte).
CREATE TABLE IF NOT EXISTS produto_fotos (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  produto_id TEXT NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  ordem INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL,
  dados BYTEA NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS produto_fotos_produto_idx ON produto_fotos(produto_id, ordem);

-- Pedido: a peça fica RESERVADA (sai do estoque) assim que o pedido chega, pra não ser vendida
-- no balcão enquanto isso; cancelar devolve. Concluir transforma o pedido numa venda de verdade.
-- token = link público de acompanhamento que só o cliente recebe (o id nunca vai pro site).
CREATE TABLE IF NOT EXISTS pedidos_online (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  numero INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'recebido' CHECK (status IN ('recebido', 'separando', 'pronto', 'saiu_entrega', 'entregue', 'cancelado')),
  cliente_id TEXT REFERENCES clientes(id),
  cliente_nome TEXT NOT NULL,
  telefone TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('entrega', 'retirada')),
  endereco TEXT,
  pagamento TEXT NOT NULL CHECK (pagamento IN ('Pix', 'Dinheiro', 'Débito', 'Crédito')),
  troco_para NUMERIC(12,2),
  observacao TEXT,
  subtotal NUMERIC(12,2) NOT NULL,
  taxa_entrega NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL,
  entregador TEXT,
  venda_id TEXT REFERENCES vendas(id),
  motivo_cancelamento TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (loja_id, numero)
);
CREATE INDEX IF NOT EXISTS pedidos_online_loja_status_idx ON pedidos_online(loja_id, status, criado_em);

CREATE TABLE IF NOT EXISTS pedidos_online_itens (
  id TEXT PRIMARY KEY,
  pedido_id TEXT NOT NULL REFERENCES pedidos_online(id) ON DELETE CASCADE,
  variacao_id TEXT NOT NULL REFERENCES produto_variacoes(id),
  produto_nome TEXT NOT NULL,
  tamanho TEXT NOT NULL,
  cor TEXT NOT NULL DEFAULT '',
  qtd INTEGER NOT NULL CHECK (qtd > 0),
  preco_unit NUMERIC(12,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS pedidos_online_itens_pedido_idx ON pedidos_online_itens(pedido_id);

ALTER TABLE vendas ADD COLUMN IF NOT EXISTS taxa_entrega NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pedido_online_id TEXT REFERENCES pedidos_online(id);
