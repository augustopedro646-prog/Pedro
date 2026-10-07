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

-- ================= Atendente de WhatsApp (bot-whatsapp/) =================
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS bot_instrucoes TEXT;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'site';

-- Uma linha por conversa. precisa_humano = "alguém da equipe precisa olhar"; pausado = "o robô não
-- responde sozinho" (só volta pelo botão "Devolver pro robô"). mensagens guarda só texto e uso de
-- ferramentas (sem blocos de raciocínio da IA — ver bot-whatsapp/cerebro.js).
CREATE TABLE IF NOT EXISTS bot_conversas (
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  telefone TEXT NOT NULL,
  mensagens JSONB NOT NULL DEFAULT '[]',
  precisa_humano BOOLEAN NOT NULL DEFAULT false,
  motivo_humano TEXT,
  pausado BOOLEAN NOT NULL DEFAULT false,
  pausado_em TIMESTAMPTZ,
  ultima_falha_envio TEXT,
  nome_perfil TEXT,
  cliente_nome TEXT,
  nao_lidas INTEGER NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (loja_id, telefone)
);

-- Cancelar venda (só Administrador, com motivo).
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS motivo_cancelamento TEXT;

-- Cupom da venda (não fiscal): troco guardado pra reimpressão e rodapé configurável.
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS troco NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS cupom_rodape TEXT;

-- Relatórios (Fase 4): meta de vendas do mês por pessoa e % de comissão da loja.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS meta_mensal NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS comissao_pct NUMERIC NOT NULL DEFAULT 0;

-- NFC-e (Fase 5) via Focus NFe. Uma nota por venda; `ref` é a referência na Focus (muda só quando
-- a SEFAZ rejeita e a nota é reenviada). CFOP/CSOSN da loja: confirmados pela contadora.
CREATE TABLE IF NOT EXISTS notas_fiscais (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  venda_id TEXT NOT NULL UNIQUE REFERENCES vendas(id),
  ref TEXT NOT NULL UNIQUE,
  ambiente TEXT NOT NULL CHECK (ambiente IN ('homologacao', 'producao')),
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'autorizada', 'rejeitada', 'erro', 'cancelada')),
  tentativas INTEGER NOT NULL DEFAULT 1,
  cpf TEXT,
  status_sefaz TEXT,
  mensagem_sefaz TEXT,
  chave_acesso TEXT,
  numero TEXT,
  serie TEXT,
  url_danfe TEXT,
  url_consulta TEXT,
  resposta_bruta JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notas_fiscais_loja_idx ON notas_fiscais(loja_id, criado_em);
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS fiscal_cfop TEXT;
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS fiscal_csosn TEXT;
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS fiscal_origem TEXT NOT NULL DEFAULT '0';
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS nfce_automatica BOOLEAN NOT NULL DEFAULT false;

-- Contas a pagar: boletos/parcelas com vencimento. Pagar uma conta lança a despesa no Fluxo de
-- caixa (despesa_id); desfazer o pagamento apaga essa despesa. `grupo` junta as parcelas da mesma
-- compra/conta (1/3, 2/3, 3/3).
CREATE TABLE IF NOT EXISTS contas_pagar (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  grupo TEXT NOT NULL,
  descricao TEXT NOT NULL,
  fornecedor_id TEXT REFERENCES fornecedores(id),
  compra_id TEXT REFERENCES compras(id),
  categoria TEXT,
  parcela INTEGER NOT NULL DEFAULT 1,
  parcelas INTEGER NOT NULL DEFAULT 1,
  valor NUMERIC(12,2) NOT NULL CHECK (valor > 0),
  vencimento DATE NOT NULL,
  codigo_barras TEXT,
  observacao TEXT,
  pago_em DATE,
  valor_pago NUMERIC(12,2),
  forma_pagamento TEXT,
  despesa_id TEXT REFERENCES despesas(id) ON DELETE SET NULL,
  criado_por TEXT REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contas_pagar_abertas_idx ON contas_pagar(loja_id, vencimento) WHERE pago_em IS NULL;
CREATE INDEX IF NOT EXISTS contas_pagar_grupo_idx ON contas_pagar(grupo);

-- Promoções: % de desconto por período em produtos escolhidos, numa categoria ou na loja toda.
-- Não somam: vale a maior que cobre o produto naquele dia. O preço da tabela (preco_venda) não
-- muda; a venda guarda o preço cheio e qual promoção deu o desconto.
CREATE TABLE IF NOT EXISTS promocoes (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  desconto_pct NUMERIC(5,2) NOT NULL CHECK (desconto_pct > 0 AND desconto_pct <= 90),
  alvo TEXT NOT NULL CHECK (alvo IN ('produtos', 'categoria', 'loja')),
  categoria TEXT,
  produto_ids TEXT[] NOT NULL DEFAULT '{}',
  inicio DATE NOT NULL,
  fim DATE NOT NULL,
  encerrada_em TIMESTAMPTZ,
  criado_por TEXT REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promocoes_loja_idx ON promocoes(loja_id, fim);
ALTER TABLE vendas_itens ADD COLUMN IF NOT EXISTS preco_cheio NUMERIC(12,2);
ALTER TABLE vendas_itens ADD COLUMN IF NOT EXISTS promocao_id TEXT REFERENCES promocoes(id) ON DELETE SET NULL;
ALTER TABLE pedidos_online_itens ADD COLUMN IF NOT EXISTS preco_cheio NUMERIC(12,2);
ALTER TABLE pedidos_online_itens ADD COLUMN IF NOT EXISTS promocao_id TEXT REFERENCES promocoes(id) ON DELETE SET NULL;

-- Contagem de estoque (inventário) com o bipador. Uma aberta por vez; os itens guardam quanto foi
-- contado de cada variação. Concluir ajusta o estoque (movimento 'ajuste', referência 'contagem').
CREATE TABLE IF NOT EXISTS contagens (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  escopo TEXT NOT NULL CHECK (escopo IN ('tudo', 'categoria', 'produto')),
  categoria TEXT,
  produto_id TEXT REFERENCES produtos(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'concluida', 'cancelada')),
  resumo JSONB,
  criado_por TEXT REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluida_por TEXT REFERENCES usuarios(id),
  concluida_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS contagens_uma_aberta_idx ON contagens(loja_id) WHERE status = 'aberta';
CREATE TABLE IF NOT EXISTS contagem_itens (
  contagem_id TEXT NOT NULL REFERENCES contagens(id) ON DELETE CASCADE,
  variacao_id TEXT NOT NULL REFERENCES produto_variacoes(id) ON DELETE CASCADE,
  contado INTEGER NOT NULL DEFAULT 0 CHECK (contado >= 0),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contagem_id, variacao_id)
);

-- Condicional: a cliente leva peças pra provar em casa. As peças saem do estoque (ajuste com
-- referência 'condicional') e ficam no nome dela até o prazo. No fechamento, tudo volta pro
-- estoque e o que ela ficou vira uma venda normal (POST /vendas com condicionalId), na mesma
-- transação — se a venda não sair, o condicional continua aberto.
CREATE TABLE IF NOT EXISTS condicionais (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  numero INTEGER NOT NULL,
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'fechado')),
  prazo DATE NOT NULL,
  observacao TEXT,
  venda_id TEXT REFERENCES vendas(id),
  criado_por TEXT REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  fechado_por TEXT REFERENCES usuarios(id),
  fechado_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS condicionais_numero_uk ON condicionais(loja_id, numero);
CREATE INDEX IF NOT EXISTS condicionais_abertos_idx ON condicionais(loja_id, prazo) WHERE status = 'aberto';
CREATE TABLE IF NOT EXISTS condicional_itens (
  id TEXT PRIMARY KEY,
  condicional_id TEXT NOT NULL REFERENCES condicionais(id) ON DELETE CASCADE,
  variacao_id TEXT NOT NULL REFERENCES produto_variacoes(id),
  produto_nome TEXT NOT NULL,
  tamanho TEXT NOT NULL,
  cor TEXT NOT NULL DEFAULT '',
  qtd INTEGER NOT NULL CHECK (qtd > 0),
  preco_unit NUMERIC(12,2) NOT NULL,
  qtd_comprada INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS condicional_itens_cond_idx ON condicional_itens(condicional_id);

-- Crediário (venda a prazo na loja, "carnê"). A parte da venda paga no crediário vira parcelas a
-- receber no nome da cliente. Receber uma parcela entra no caixa do dia (caixa_sessao_id) e no
-- Fluxo de caixa do mês do recebimento — não no da venda.
ALTER TABLE venda_pagamentos DROP CONSTRAINT IF EXISTS venda_pagamentos_forma_check;
ALTER TABLE venda_pagamentos ADD CONSTRAINT venda_pagamentos_forma_check
  CHECK (forma IN ('Dinheiro', 'Débito', 'Crédito', 'Pix', 'Cashback', 'Vale-troca', 'Crediário'));
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS limite_crediario NUMERIC(12,2);
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS crediario_limite_padrao NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS crediario_max_parcelas INTEGER NOT NULL DEFAULT 6;
CREATE TABLE IF NOT EXISTS crediario_parcelas (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  venda_id TEXT NOT NULL REFERENCES vendas(id),
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  parcela INTEGER NOT NULL,
  parcelas INTEGER NOT NULL,
  valor NUMERIC(12,2) NOT NULL CHECK (valor > 0),
  vencimento DATE NOT NULL,
  pago_em TIMESTAMPTZ,
  valor_pago NUMERIC(12,2),
  forma_recebimento TEXT,
  caixa_sessao_id TEXT REFERENCES caixa_sessoes(id),
  recebido_por TEXT REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crediario_abertas_idx ON crediario_parcelas(loja_id, vencimento) WHERE pago_em IS NULL;
CREATE INDEX IF NOT EXISTS crediario_cliente_idx ON crediario_parcelas(cliente_id);
CREATE INDEX IF NOT EXISTS crediario_sessao_idx ON crediario_parcelas(caixa_sessao_id);

-- Lista de presentes (chá de bebê, aniversário): a mãe escolhe as peças, os convidados veem pelo
-- link (token) o que falta e presenteiam pelo site ou na loja. Cada presente fica registrado com
-- quem deu e de qual venda/pedido veio (cancelar desfaz).
CREATE TABLE IF NOT EXISTS listas_presentes (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  titulo TEXT NOT NULL,
  data_evento DATE,
  mensagem TEXT,
  ativa BOOLEAN NOT NULL DEFAULT true,
  criado_por TEXT REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lista_presentes_itens (
  id TEXT PRIMARY KEY,
  lista_id TEXT NOT NULL REFERENCES listas_presentes(id) ON DELETE CASCADE,
  variacao_id TEXT NOT NULL REFERENCES produto_variacoes(id),
  qtd_desejada INTEGER NOT NULL CHECK (qtd_desejada > 0),
  qtd_presenteada INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lista_id, variacao_id)
);
CREATE TABLE IF NOT EXISTS lista_presentes_dados (
  id TEXT PRIMARY KEY,
  lista_item_id TEXT NOT NULL REFERENCES lista_presentes_itens(id) ON DELETE CASCADE,
  qtd INTEGER NOT NULL CHECK (qtd > 0),
  de_quem TEXT,
  mensagem TEXT,
  venda_id TEXT REFERENCES vendas(id),
  pedido_id TEXT REFERENCES pedidos_online(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lista_presentes_dados_venda_idx ON lista_presentes_dados(venda_id);
CREATE INDEX IF NOT EXISTS lista_presentes_dados_pedido_idx ON lista_presentes_dados(pedido_id);
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS lista_id TEXT REFERENCES listas_presentes(id) ON DELETE SET NULL;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS presente_de TEXT;

-- ============================================================================
-- Mensagens pros clientes pelo WhatsApp: aniversário da criança, cashback parado e
-- "chegou novidade no tamanho que seu filho usa". O sistema SUGERE (fila de revisão no
-- painel); só sai depois de aprovada (ou sozinha, se a loja ligar o envio automático), pelo
-- mesmo número do atendente, com ritmo humano e limite por dia.
-- ============================================================================
CREATE TABLE IF NOT EXISTS cliente_filhos (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  cliente_id TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  nascimento DATE,
  tamanho TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cliente_filhos_cliente_idx ON cliente_filhos(cliente_id);
-- Cliente que respondeu SAIR (ou que pediu no balcão) não recebe mais aviso nenhum.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS aceita_mensagens BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS mensagens_config JSONB NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS mensagens_clientes (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  cliente_id TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('aniversario', 'cashback', 'novidade')),
  chave TEXT NOT NULL, -- impede sugerir a mesma mensagem duas vezes (ex.: aniversário do filho X em 2026)
  telefone TEXT NOT NULL,
  texto TEXT NOT NULL,
  detalhe JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'na_fila', 'enviando', 'enviada', 'descartada', 'erro', 'vencida')),
  erro TEXT,
  aprovada_por TEXT REFERENCES usuarios(id),
  aprovada_em TIMESTAMPTZ,
  enviada_em TIMESTAMPTZ,
  enviada_manual BOOLEAN NOT NULL DEFAULT false,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (loja_id, chave)
);
CREATE INDEX IF NOT EXISTS mensagens_clientes_status_idx ON mensagens_clientes(loja_id, status, criado_em);
CREATE INDEX IF NOT EXISTS mensagens_clientes_cliente_idx ON mensagens_clientes(cliente_id, tipo, criado_em);

-- ============================================================================
-- Pagamento pelo site (Mercado Pago: Pix com QR na própria página + cartão no Checkout Pro) e
-- envio pra outras cidades com frete calculado pelo CEP (Melhor Envio).
-- Pedido pago online nasce "aguardando_pagamento" com as peças já reservadas; vira "recebido"
-- quando o Mercado Pago confirma. Não pagou no prazo → cancela sozinho e devolve as peças.
-- ============================================================================
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS pagamento_config JSONB NOT NULL DEFAULT '{}';
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS envio_config JSONB NOT NULL DEFAULT '{}';

ALTER TABLE pedidos_online DROP CONSTRAINT IF EXISTS pedidos_online_status_check;
ALTER TABLE pedidos_online ADD CONSTRAINT pedidos_online_status_check
  CHECK (status IN ('aguardando_pagamento', 'recebido', 'separando', 'pronto', 'saiu_entrega', 'entregue', 'cancelado'));
ALTER TABLE pedidos_online DROP CONSTRAINT IF EXISTS pedidos_online_tipo_check;
ALTER TABLE pedidos_online ADD CONSTRAINT pedidos_online_tipo_check CHECK (tipo IN ('entrega', 'retirada', 'envio'));

ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS pago_online BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS pag_metodo TEXT; -- 'pix' | 'cartao' (como a pessoa escolheu pagar no site)
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS pag_status TEXT; -- aguardando | pago | expirado | estornado
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS pag_expira_em TIMESTAMPTZ;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS pago_em TIMESTAMPTZ;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS pag_parcelas INTEGER;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS pag_nota TEXT; -- ex.: "estornado: pago depois de expirar"
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS mp_pagamento_id TEXT;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS mp_preferencia_url TEXT;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS pix_copia_cola TEXT;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS pix_qr_base64 TEXT;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS cep TEXT;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS cidade TEXT;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS uf TEXT;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS envio_servico_id TEXT;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS envio_servico TEXT;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS envio_prazo_dias INTEGER;
ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS rastreio TEXT;
CREATE INDEX IF NOT EXISTS pedidos_online_aguardando_idx ON pedidos_online(loja_id, pag_expira_em) WHERE status = 'aguardando_pagamento';

-- Face ID do ponto (mesmo desenho do Jabá, 01/10/2026): o rosto vira 128 números ("descritor",
-- não a foto) guardados AQUI no servidor, com o PIN da pessoa e o consentimento registrado (rosto
-- é dado biométrico sensível pela LGPD). A comparação é feita só no servidor — o navegador manda o
-- rosto da tentativa e nunca recebe o de ninguém.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS face_descritores JSONB;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS face_consentimento_em TIMESTAMPTZ;

-- Entregadores da loja (igual aos motoboys do Jabá): ao marcar "saiu para entrega", o robô manda
-- pro WhatsApp do entregador o cliente, o endereço com link do mapa e quanto receber.
CREATE TABLE IF NOT EXISTS entregadores (
  id TEXT PRIMARY KEY,
  loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  whatsapp TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Link "Avaliar no Google" (Google Meu Negócio → Pedir avaliações): aparece no site e vai na
-- mensagem de pedido concluído, igual ao Jabá.
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS google_avaliacao_url TEXT;

-- Prazo de troca: loja física e site (compra online, inclusive de outros estados). Fora do prazo,
-- a troca precisa do PIN de um Administrador.
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS troca_dias_loja INTEGER NOT NULL DEFAULT 15;
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS troca_dias_site INTEGER NOT NULL DEFAULT 30;
