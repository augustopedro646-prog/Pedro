-- Loja Gutto — proposta de modelo de PRODUTO COM VARIAÇÃO (tamanho/cor).
--
-- Contexto: no PDV Jabá (irmão deste projeto), cada item do cardápio é uma linha num blob JSON
-- com um único campo `estoque` (número), decrementado numa transação atômica
-- (`SELECT ... FOR UPDATE` na linha do blob) — resolveu uma condição de corrida real que já
-- existiu lá (dois pedidos simultâneos podiam "perder" um desconto de estoque).
--
-- Isso não serve direto pra roupa: aqui "item vendável" não é o produto, é a combinação
-- tamanho+cor (uma camiseta P-Azul e a mesma camiseta G-Vermelho têm estoques independentes).
-- Este arquivo propõe nascer já como tabela própria (produtos + produto_variacoes), aplicando de
-- primeira a lição que o Jabá só aprendeu depois de sentir a dor (evitar o estágio "blob JSON
-- reescrito por inteiro").
--
-- STATUS: proposta pra revisão do Pedro — nada disso está aplicado a um banco ainda.
-- Pendente de confirmação antes de virar definitivo (ver docs/modelo-produto-variacao.md):
--   1) como o app antigo do Pedro modelava tamanho/cor (pra não reinventar algo já testado);
--   2) se preço/custo variam por variação (ex.: plus size mais caro) ou só por produto.

CREATE TABLE IF NOT EXISTS lojas (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Grade de tamanhos reutilizável (ex.: "Bebê" = RN,P,M,G; "Infantil numérica" =
-- 2,4,6,8,10,12,14,16) — cadastro simples, uma vez só, em vez de digitar a lista em cada produto
-- novo. É um ARRAY (não uma tabela de tamanhos com FK) de propósito: preserva a ORDEM em que a
-- grade deve aparecer na tela (2 antes de 4 antes de 6...), o que uma FK genérica não garante
-- sem uma coluna de ordenação a mais.
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
  -- NCM fica no produto (não na variação): uma peça compartilha o mesmo NCM entre tamanhos/cores
  -- (uma camiseta P e uma G não mudam de classificação fiscal só pelo tamanho) — mais simples que
  -- o cardápio do Jabá nesse ponto. Só usado quando a NFC-e entrar (não é prioridade agora).
  ncm TEXT,
  foto_url TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS produtos_loja_idx ON produtos(loja_id, ativo);

-- Variação = 1 combinação tamanho+cor de um produto = 1 SKU físico com estoque, preço e custo
-- próprios. Esta é a tabela que NÃO existe no PDV Jabá — lá "item" já é a unidade vendável.
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
-- não deixa cadastrar a mesma combinação tamanho+cor duas vezes pro mesmo produto por engano.
CREATE UNIQUE INDEX IF NOT EXISTS produto_variacoes_produto_tamanho_cor_uk
  ON produto_variacoes(produto_id, tamanho, cor);
-- sku é opcional (nem toda loja usa código próprio), mas quando existe precisa ser único na loja.
CREATE UNIQUE INDEX IF NOT EXISTS produto_variacoes_sku_uk
  ON produto_variacoes(loja_id, sku) WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS produto_variacoes_produto_idx ON produto_variacoes(produto_id);
-- acelera a tela "estoque baixo" (Início/Relatórios) sem varrer toda a tabela a cada carregamento.
CREATE INDEX IF NOT EXISTS produto_variacoes_estoque_baixo_idx
  ON produto_variacoes(loja_id) WHERE estoque <= estoque_minimo;

-- Ledger de movimentos — mesmo padrão já validado no PDV Jabá (`movimentos_estoque`, adicionado só
-- na V2 de lá depois de sentir falta em relatório de CMV). Aqui já nasce desde o V1: 1 linha por
-- mudança de estoque, custo em snapshot (não retroage se o custo médio mudar depois), referência
-- pra rastrear de qual venda veio a baixa.
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
  criado_por TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS movimentos_estoque_produto_variacao_idx
  ON movimentos_estoque_produto(variacao_id, criado_em);
CREATE INDEX IF NOT EXISTS movimentos_estoque_produto_loja_tipo_idx
  ON movimentos_estoque_produto(loja_id, tipo, criado_em);
