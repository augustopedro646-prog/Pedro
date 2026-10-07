# Loja Gutto — sistema de gestão

Plano e decisões: `docs/plano-loja-gutto.md`. Código da API + tela: `api/`.

## Como rodar no Windows (primeira vez)

1. **Instalar o Node.js** (versão LTS): https://nodejs.org → baixar o instalador "LTS" e
   clicar em avançar até o fim.
2. **Instalar o PostgreSQL**: https://www.postgresql.org/download/windows/ → baixar o
   instalador. Durante a instalação ele pede uma **senha pro usuário `postgres`** —
   anote, vai precisar no passo 5. O resto pode deixar tudo no padrão (porta 5432).
3. **Baixar o código**: no GitHub, na branch do projeto, botão verde **Code → Download
   ZIP**. Descompacte numa pasta (ex.: `C:\LojaGutto`).
4. Abra o **Prompt de Comando** dentro da pasta `api` (no Explorer, entre na pasta `api`,
   clique na barra de endereço, digite `cmd` e Enter) e rode:
   ```
   npm install
   npm run setup
   ```
   Na primeira vez o `setup` cria um arquivo `.env` e para.
5. Abra o arquivo `api\.env` no Bloco de Notas, troque `COLOQUE_A_SENHA_DO_POSTGRES_AQUI`
   pela senha do passo 2, salve, e rode de novo:
   ```
   npm run setup
   ```
   Ele cria o banco, as tabelas e os usuários Pedro (PIN 1103) e Lorena (PIN 1007).

## Configuração inicial da loja (uma vez)

Depois do `npm run setup`, rode na pasta `api` (no Windows: `npm.cmd run configurar`):

```
npm run configurar
```

Ele aplica o que foi combinado e pode rodar de novo sem duplicar nada:
- **Grades de tamanho:** Bebê (0-3M, 3-6M, 6-9M, G), Infantil (1, 2, 3, 4, 6, 8, 10) e Juvenil
  (12, 14, 16).
- **Cashback:** 5%.
- **Desconto que a vendedora dá sem PIN:** até 20%.
- **Limite do crediário:** R$ 700 por cliente.
- **Limite do condicional:** R$ 700 em peças que a cliente pode ter em casa pra provar (somando os
  condicionais abertos dela). Acima disso, pede o PIN de um Administrador. Dá pra mudar o limite de
  uma cliente específica no cadastro dela.
- **Troca:** 15 dias na loja e 30 dias pelo site. O rodapé do cupom fica "Trocas em até 15 dias com
  a etiqueta e este cupom".

Tudo isso continua editável na aba Configurações.

**Prazo de troca:** a tela de troca mostra há quantos dias foi a compra e o prazo (da loja ou do
site). Fora do prazo, a troca pede o PIN de um Administrador e fica anotada como "fora do prazo,
autorizada por ...". O prazo do site aparece pro cliente no site, e o robô sabe responder.

## Peças que já têm etiqueta (sistema antigo ou do fabricante)

No **+ Novo produto**, marque **"As peças já têm etiqueta com código de barras"**:
- aparece um campo por tamanho/cor; clique no primeiro e bipe a etiqueta de uma peça de cada
  tamanho/cor. O cursor pula sozinho pro próximo;
- quem ficar em branco ganha um código novo (e aí sim imprime etiqueta só dessas).

Na venda, é só bipar a etiqueta antiga. Esqueceu de bipar no cadastro? Na venda, o Administrador
bipa a peça, o sistema avisa que o código não está cadastrado e deixa escolher de qual
produto/tamanho é. Dali pra frente bipa direto.

Antes de começar, teste com 1 peça: se o bipador não colocar nada no campo, a etiqueta antiga pode
ter letras no código, e aí me avise.

## Importar produtos por planilha (Estoque → "Importar planilha")

Pra cadastrar muitos produtos de uma vez:
1. **Baixar planilha modelo**: vem com uma aba de exemplo e a explicação.
2. Preencha no Excel, **uma linha pra cada tamanho/cor**:
   - "Produto" em branco nas linhas de baixo = o mesmo produto da linha de cima.
   - Preço e custo em branco repetem os de cima.
   - Quantidade = peças que tem agora.
   - Código de barras só se a peça já tiver etiqueta; senão o sistema cria.
3. **Escolher planilha**: aparece a prévia com tudo que vai entrar e, se tiver, as linhas pra
   corrigir. Com problema, nada entra até corrigir.
4. **Importar**, e no fim **Imprimir as etiquetas** de tudo que entrou.

Produto com o mesmo nome de um que já existe é pulado, então importar o mesmo arquivo de novo não
duplica. Aceita também CSV salvo pelo Excel.

## Cadastro rápido de produtos (Estoque → "+ Novo produto")

- Uma tabela **tamanho × cor** pra digitar quantas peças tem de cada uma (ou "Todos com N").
  Cores vazias = cor única. Com "Não criar os tamanhos/cores com 0 peças" marcado, só nascem os
  tamanhos/cores que existem na loja.
- O NCM é copiado de outro produto da mesma categoria (confira).
- No fim: **Imprimir etiquetas** (uma por peça) e **Cadastrar outro parecido**, que já vem com
  categoria, NCM, grade, cores, preço e custo, faltando só o nome e as quantidades. O mesmo botão
  "Cadastrar parecido" fica no detalhe de qualquer produto do Estoque.
- O produto e todas as variações são criados de uma vez: se algo der errado, nada fica pela metade.

## Leitura de nota (Compras → "Ler nota")

- **XML da nota** (o arquivo que o fornecedor manda por e-mail junto do PDF): leitura exata,
  sem custo e sem precisar de nada extra. Sempre que tiver o XML, use ele.
- **PDF ou foto(s)**: lidos pela IA do Claude. Precisa de uma chave da API da Anthropic no
  `api\.env`, numa linha `ANTHROPIC_API_KEY=...` (a mesma que o Jabá usa serve), e reiniciar
  o servidor. Cada leitura custa alguns centavos.

Nada é lançado direto: aparece a tela **Conferir nota** com cada item já apontado pra peça
certa (pelo código de barras, pela referência que o fornecedor usou em notas anteriores ou
por sugestão da IA). Dá pra corrigir quantidade, custo e peça, criar produto novo ali mesmo
ou deixar um item de fora. A mesma NF-e não entra duas vezes.

## Site da loja (pedidos online)

O site pro cliente fica em **http://localhost:3000/loja** (depois do domínio, no endereço do
domínio). Configure em **Configurações → Site da loja** (entrega, retirada, taxa,
WhatsApp, endereço). Produto aparece no site se estiver ativo, marcado "Mostrar no site" (na
edição do produto, onde também vão as fotos) e com estoque. As peças de um pedido ficam
reservadas na hora; ao concluir na aba **Pedidos online**, o pedido vira venda do caixa aberto.

### Pedidos online no dia a dia

- **🖨 Imprimir** em cada pedido: recibo pra separar as peças (com quadradinhos pra ir marcando) e
  pra ir com a entrega. Mostra se está **pago pelo site** ou quanto o entregador recebe, e o troco.
- **Entregadores** (Configurações → Entregadores): nome e WhatsApp. No "Saiu para entrega" você
  escolhe quem leva, e o robô manda pro WhatsApp dele o cliente, o telefone, o endereço com o link
  do mapa e quanto receber. A conversa com o entregador fica fora do atendimento automático. Se o
  robô estiver desligado, aparece o botão pra mandar pelo celular.
- **Avaliação no Google** (Configurações → Site da loja): cole o link do Google Meu Negócio
  (Pedir avaliações). Ele aparece no rodapé do site, no acompanhamento do pedido concluído e na
  mensagem de "pedido concluído" do WhatsApp.
- No WhatsApp, o robô mostra o resumo do pedido (peças com o preço certo, taxa, total e troco)
  **antes** de fechar, e só fecha depois do "sim" do cliente.

## Pagamento pelo site (Mercado Pago)

Configure em **Configurações → Pagamento pelo site**: Pix, cartão de crédito
(com o máximo de parcelas) e se ainda aceita pagar na entrega/retirada.

- **Pix:** o QR Code e o "copia e cola" aparecem na própria página do pedido. Quando o pagamento
  cai, a página e o painel atualizam sozinhos e a cliente recebe "recebemos o pagamento" no WhatsApp.
- **Cartão:** a cliente vai pra página do Mercado Pago, paga e volta pro acompanhamento do pedido.
  Os dados do cartão nunca passam pelo sistema da loja.
- Enquanto não paga, o pedido fica em **"Esperando o pagamento pelo site"** com as peças
  reservadas. Passou do prazo (padrão 30 minutos), cancela sozinho e as peças voltam. Se alguém
  pagar depois disso, o dinheiro é devolvido automaticamente.
- **Cancelar um pedido já pago devolve o dinheiro** pelo Mercado Pago (no cartão pode levar alguns
  dias pra aparecer na fatura).
- Ao concluir, vira venda no caixa em Pix ou Crédito (o dinheiro está na conta do Mercado Pago, não
  na gaveta).

**Pra ligar:**
1. Crie a conta no Mercado Pago (de preferência como empresa, com o CNPJ da Gutto).
2. Em mercadopago.com.br/developers → **Suas integrações** → **Criar aplicação** (tipo "Pagamentos
   online", produto "Checkout Pro"), pegue o **Access Token**. Comece pelas credenciais de **teste**
   (começam com `TEST-`): dá pra pagar com cartões de teste sem cobrar ninguém.
3. No `api\.env`: `MERCADOPAGO_ACCESS_TOKEN=...` e reinicie a API (`Restart-Service LojaGuttoAPI`).
4. Com o domínio no ar, em **Webhooks** da aplicação: URL
   `https://SEU-DOMINIO/api/lojas/1/loja/pagamentos/webhook`, evento **Pagamentos**. Copie a
   "assinatura secreta" pra `MERCADOPAGO_WEBHOOK_SECRET=` (opcional, mas recomendado).
5. Testou tudo? Troque pelo Access Token de **produção** (`APP_USR-...`).

As taxas são as do Mercado Pago (Pix costuma ser bem mais barato que cartão). Os juros do
parcelamento seguem o que estiver configurado na conta do Mercado Pago.

## Envio pelos Correios (Melhor Envio)

Configure em **Configurações → Envio pra outras cidades**: CEP de onde sai, peso e
tamanho médio de uma peça embalada, dias pra postar, frete grátis a partir de um valor e as
**cidades onde a entrega da própria loja vai** (ex.: "Natal, Parnamirim").

- No site, em "Receber em casa", a cliente digita o **CEP**: o endereço é preenchido sozinho e
  aparecem as opções — a entrega da loja (se a cidade estiver na lista) e os Correios (PAC, SEDEX...)
  com preço e prazo. Envio pelos Correios é sempre pago pelo site.
- No painel, o pedido mostra o serviço e o endereço com **"copiar endereço pra etiqueta"**. Compre
  a etiqueta no site do Melhor Envio, poste, e clique **"📦 Postado"** com o código de rastreio: a
  cliente recebe o código no WhatsApp e vê no acompanhamento.

**Pra ligar:** crie a conta em melhorenvio.com.br, vá em **Integrações → Permissões de acesso →
Gerar novo token** (marque as permissões de cálculo de frete), e no `api\.env`:
`MELHORENVIO_TOKEN=...`, `MELHORENVIO_EMAIL=email-da-loja` e reinicie a API.

⚠ **Nota fiscal pra outros estados:** a NFC-e (cupom fiscal) só vale pra venda ao consumidor
dentro do RN. Pra mandar pra outro estado precisa de **NF-e** (modelo 55) e pode ter DIFAL —
confirme com a contadora antes de ligar o envio pra fora do estado.

## Atendente de WhatsApp (pasta `bot-whatsapp/`)

Mesmo modelo do Jabá: um programa à parte que conecta no WhatsApp da loja (pareado por QR Code,
como o WhatsApp Web) e responde os clientes com a IA do Claude — consulta a vitrine/estoque, manda
foto das peças, fecha pedido, informa status e cashback, e passa pra equipe quando precisa.
Também avisa o cliente a cada mudança de status dos pedidos (do site e do WhatsApp).

- Usa o mesmo `api\.env` (banco, `ANTHROPIC_API_KEY` e o `BOT_WEBHOOK_SECRET`, que o
  `npm run setup` gera sozinho). Opcional: `SITE_URL=https://seu-dominio` pra ele mandar o link do site.
- Instalar e ligar: na pasta `bot-whatsapp`, `npm install` e `npm start` — ou, como a API, como
  serviço do Windows (`LojaGuttoBot`, via NSSM, pasta `bot-whatsapp`, `node server.js`).
- Conectar: aba **WhatsApp** no painel → aparece o QR Code → no celular da loja, WhatsApp →
  Aparelhos conectados → Conectar um aparelho.
- Testar sem WhatsApp: `npm run testar` (conversa pelo terminal com a IA de verdade).
- ⚠ Não é a API oficial da Meta: existe risco de bloqueio do número se ele parecer robô. O
  atendente escreve em ritmo humano e mostra no painel o "aquecimento" de número novo — divulgue
  o número aos poucos nos primeiros dias.

## Mensagens pros clientes (aba WhatsApp → "Mensagens pros clientes")

Todo dia o sistema procura, sozinho, quem merece uma mensagem:

- **🎂 Aniversário da criança**: parabéns no dia. Cadastre as crianças na ficha do cliente
  (nome, nascimento e o tamanho que usa). Os aniversários também aparecem no Calendário.
- **💰 Cashback parado**: quem tem saldo (a partir de R$ 10) e não compra há 30 dias. No máximo um
  lembrete a cada 30 dias.
- **✨ Chegou novidade no tamanho**: peças cadastradas nos últimos 7 dias, com estoque, no tamanho
  que a criança usa (o cadastrado na criança + o que a cliente comprou nos últimos 6 meses). Não
  repete peça já avisada nem já comprada.

Como sai:

- As sugestões ficam **pra revisar** (aviso no Início). Dá pra editar o texto, **Aprovar e
  enviar**, **Mandar pelo celular** (abre o WhatsApp com o texto pronto, sem precisar do robô) ou
  **descartar**.
- As aprovadas saem pelo número do atendente, **uma de cada vez** (40 a 90 segundos entre elas),
  só no horário configurado (padrão 9h às 20h) e até o limite por dia (padrão 30). Se o robô ou o
  WhatsApp estiver desligado, elas esperam na fila e saem quando voltar. Parabéns que não saiu no
  dia não é mandado atrasado.
- Toda mensagem termina com "Se não quiser mais receber esses avisos, é só responder SAIR".
  Quem responde SAIR é desmarcado na hora (também dá pra desmarcar na ficha do cliente).
- **Configurar**: liga/desliga cada tipo, valores (saldo mínimo, dias), os textos (com campos
  como `{cliente}`, `{crianca}`, `{valor}`, `{tamanho}`, `{produtos}`) e o **envio automático**
  (sem revisão) — recomendo deixar desligado nas primeiras semanas.
- Precisa do atendente ligado e conectado (e da chave da Anthropic, que ele usa pra responder
  quem conversar depois). Sem ele, funciona tudo pelo "Mandar pelo celular".

## Etiquetas de código de barras (Elgin L42 ou outra térmica)

Estoque → produto → **Imprimir etiquetas** (já vem com a quantidade em estoque de cada tamanho/cor),
ou automaticamente depois de dar entrada numa nota (só as peças que chegaram), ou em Compras →
nota → "Imprimir etiquetas desta nota". Sai pelo driver do Windows: na janela de impressão,
escolha a Elgin L42, papel do tamanho do rolo, margens "Nenhuma" e escala 100%. O tamanho da
etiqueta (padrão 40×25 mm, 2 colunas) se ajusta na própria tela e fica salvo no computador.
Código de 13 dígitos sai em EAN-13 (o interno do sistema e o EAN do fabricante), 8 dígitos em
EAN-8 e os demais em Code 128.

## Cupom da venda (impressora térmica do caixa)

Depois de confirmar a venda: **Imprimir cupom** (ou marque "imprimir automaticamente em toda
venda"). Reimpressão em Venda rápida → **Vendas / troca** → "cupom". Na troca/devolução sai o
comprovante de **vale-troca**. É cupom **não fiscal** (a NFC-e é outra etapa). Papel de 80 ou
58 mm e o rodapé (ex.: política de troca) em Configurações. A página sai com a
altura exata do conteúdo, sem gastar rolo.

Sai pela janela de impressão do Windows (o navegador lembra a última impressora usada). Pra
imprimir sem a janela, dá pra pôr `--kiosk-printing` no atalho do Edge — aí tudo vai direto pra
impressora padrão do Windows, inclusive as etiquetas; só vale a pena se as etiquetas forem
impressas em outro computador.

## Nota fiscal do consumidor (NFC-e)

Emitida pela **Focus NFe** (o mesmo serviço do Jabá), que conversa com a SEFAZ. O cupom da venda
continua sendo "não fiscal"; a NFC-e é a nota de verdade.

**Antes de ligar (uma vez só):**
1. **Certificado digital e-CNPJ A1** da Loja Gutto (arquivo `.pfx` + senha). Quem providencia é a
   contadora ou uma certificadora.
2. **CSC da NFC-e** no site da SEFAZ-RN. São dois: um pra homologação e outro pra produção, e são
   diferentes. A contadora gera os dois.
3. No **painel da Focus NFe** (dá pra usar a mesma conta do Jabá): cadastrar a empresa da Gutto com
   CNPJ, Inscrição Estadual, regime Simples Nacional, certificado e os dois CSC. Copie os **tokens
   da empresa** (homologação e produção).
4. No `api\.env`, acrescente:
   ```
   FOCUS_NFE_AMBIENTE=homologacao
   FOCUS_NFE_CNPJ_EMITENTE=cnpj da Gutto, só números
   FOCUS_NFE_TOKEN_HOMOLOGACAO=token de homologação da empresa
   FOCUS_NFE_TOKEN_PRODUCAO=token de produção da empresa
   ```
   Depois reinicie o serviço: `Restart-Service LojaGuttoAPI`.
5. Em **Configurações → Nota fiscal**:
   - Preencha **CFOP**, **CSOSN** e **origem**. Confirme esses três com a contadora; numa loja de
     roupa do Simples costuma ser 5102 / 102 / 0.
   - Preencha o **NCM** dos produtos. É o único dado fiscal que vai em cada produto (CFOP, CSOSN e
     origem são da loja inteira). Três jeitos, que podem ser combinados:
     - **XML do fornecedor**: ao lançar uma compra pelo XML (Compras → Ler nota), o NCM que o
       fornecedor usou vai sozinho pros produtos que ainda não têm. Um NCM já preenchido nunca é
       trocado. Vale também pra produto cadastrado à mão, depois de ligado ao item da nota.
     - **Planilha pra contadora**: "Baixar planilha pra contadora" gera um Excel com todos os
       produtos. Ela preenche a coluna NCM, e "Importar planilha preenchida" aplica tudo de uma
       vez. Linha com problema (NCM incompleto, código apagado) é listada e não mexe em nada.
     - **Por categoria** (quando a categoria inteira tem o mesmo NCM) ali mesmo, ou um por um
       no Estoque.

**Testar** (homologação, sem valor fiscal): faça uma venda e clique em **Emitir NFC-e**. A nota sai
marcada "teste". Só depois de algumas notas autorizadas em teste troque para
`FOCUS_NFE_AMBIENTE=producao` e reinicie. No Jabá, o primeiro teste parou em "CNPJ emitente não
cadastrado", porque a SEFAZ exige credenciamento separado para homologação. Se aparecer isso, é
com a contadora.

**No dia a dia:**
- Depois da venda aparece **Emitir NFC-e**, com o **CPF na nota** opcional. Se a cliente está
  identificada e tem CPF no cadastro, ele já vem preenchido.
- Pra emitir sozinho em toda venda, marque **Emitir automaticamente**.
- **Imprimir NFC-e** imprime o DANFE no formato de cupom, na térmica do caixa (com o QR Code de
  consulta). "ver na Focus" abre a página da nota na Focus NFe, se precisar.
  - Pra sair o nome, a IE e o endereço certos no topo do DANFE, coloque no `api\.env`:
    `NFCE_EMITENTE_NOME=`, `NFCE_EMITENTE_IE=` e `NFCE_EMITENTE_ENDERECO=`.
  - ⚠ Lição do Jabá: a térmica **Elgin i8** não imprime imagem mandada pelo navegador, e aí o QR
    Code não sai. No Jabá isso foi resolvido pelo app de computador, que imprime pelo Windows. Se
    a térmica da Gutto também for uma i8, avise que eu trago essa parte.
- Se a SEFAZ recusar, aparece o motivo (ex.: NCM errado): corrija e clique em **Tentar de novo**.
  Se a internet cair no meio, clique de novo; o sistema confere antes de reenviar, então nunca sai
  nota duplicada.
- Em **Vendas / troca**, cada venda mostra a nota (ou "emitir NFC-e", pra emitir depois).
- **Cancelar a venda** cancela a NFC-e também. A SEFAZ só aceita cancelamento logo depois da
  emissão (30 minutos na maioria dos estados). Depois disso o painel avisa e a correção é com a
  contadora (nota de devolução).
- Troca/devolução não mexe na NFC-e original. O vale-troca é controle interno da loja; se a
  contadora pedir nota de devolução pra isso, é à parte.

## Bater ponto com Face ID

Na aba **Bater ponto**, cada pessoa cadastra o próprio Face ID no cartão dela: a câmera tira 3
amostras do rosto (de frente e um pouco pra cada lado), e a pessoa digita o **PIN** e marca a
**autorização** (rosto é dado sensível pela LGPD). Depois é só ligar a câmera e olhar: o sistema
reconhece e bate a entrada ou a saída.

- O que fica guardado é um código numérico do rosto, **não a foto**, e fica no servidor (vale em
  qualquer computador da loja). Quem reconhece é o servidor, não o navegador.
- O reconhecimento funciona sem internet (os arquivos ficam no próprio computador).
- Dá pra apagar o Face ID no cartão da pessoa ("remover"): a própria pessoa com o PIN dela, ou o
  Administrador.
- Limite honesto: não detecta foto na frente da câmera. Pra um computador da loja é suficiente.
- Quem tinha cadastrado o rosto na versão antiga precisa cadastrar de novo (antes ficava só no
  navegador, sem PIN nem autorização).

## Relatórios (só Administrador)

Tudo sai das vendas reais. Um filtro de período no topo (Hoje, 7 dias, 30 dias, Este mês, Mês
passado ou datas escolhidas) vale pra tela inteira, e cada número vem com a seta de comparação com o
período anterior. "Este mês" compara com os mesmos dias do mês passado.

- **Vendido, vendas, ticket médio, peças, lucro bruto (e margem) e descontos.** Vendas canceladas
  não entram. O que voltou em troca/devolução é descontado da venda original. O lucro usa o custo
  do dia da venda e não desconta despesas (isso é o Fluxo de caixa).
- **Vendido por dia** (por mês, se o período passar de 2 meses): passe o mouse na coluna pra ver
  o valor, ou use "Ver tabela".
- **Mais vendidos e curva ABC.** A = os produtos que fazem os primeiros 80% do vendido, B até 95%,
  C o resto. A coluna "Dura" diz quantos dias o estoque atual aguenta no ritmo de venda do período.
- **Vendas por pessoa**, com comissão e barra da meta do mês. A meta aparece em "Este mês" e em
  "Mês passado". A meta de cada pessoa se define em Equipe → Editar, e o % de comissão em
  Configurações.
- **Formas de pagamento** e **horários de pico** (dia da semana × hora; quanto mais escuro, mais
  vendas).
- **Parados no estoque**: produtos com estoque que não venderam no período, com o custo parado.
- **Precisa repor**: peças abaixo do estoque mínimo agora.

Cada bloco tem **Baixar planilha** (abre direto no Excel).

## Lista de presentes (Clientes → "Listas de presentes")

- **Criar**: escolha a cliente (a mãe), título ("Chá de bebê do Davi"), data, mensagem pros
  convidados e as peças (produto → tamanho/cor, quantas de cada).
- **Link**: "Mandar o link no WhatsApp" manda pra mãe o link da lista, que ela repassa pros
  convidados. No link, o convidado vê o que **ainda falta**, clica em **Presentear** e faz o
  pedido pelo site (com o nome dele e uma mensagem pra família). A lista não mostra telefone nem
  sobrenome.
- **Na loja**: no caixa, "🎁 É presente de uma lista?" → escolha a lista e quem está dando.
- A lista se atualiza sozinha (só conta até a quantidade que faltava). No painel aparece **quem deu
  o quê**, pelo site ou na loja. Cancelar a venda/pedido tira o presente da lista. "Encerrar lista"
  quando o evento passar.

## Crediário (venda a prazo na loja, "carnê")

- No caixa, com a **cliente identificada**, aparece a forma **"Crediário"**. Pode ter entrada
  (ex.: Pix 60 + Crediário 240). Escolha em quantas vezes e o 1º vencimento; as parcelas caem todo
  mês no mesmo dia. No fim, **"Imprimir carnê"** sai na térmica com as parcelas pra ela assinar.
- **Limite**: cada cliente tem um limite (o padrão da loja, em Configurações, ou um
  próprio no cadastro dela — só o Administrador muda). Passou do limite, pede PIN de
  Administrador. O carrinho mostra quanto ela já deve e se tem parcela atrasada.
- **Receber** (Clientes → "Crediário", ou no cadastro da cliente): escolha a forma (dinheiro,
  Pix, cartão); dá pra ajustar o valor (juros/desconto). Entra no **caixa do dia** (em dinheiro,
  soma na gaveta) e na receita do **mês em que recebeu** — a venda no crediário só vira receita
  quando o dinheiro entra.
- O **Início** avisa as parcelas atrasadas e as que vencem hoje; a lista tem "cobrar no WhatsApp".
- Crediário não gera cashback (só a parte paga na hora). Venda no crediário com parcela já paga não
  cancela (desfaça o recebimento antes).

## Condicional (cliente leva pra provar em casa)

- No caixa, monte o carrinho e clique **"Enviar como condicional"**: escolha a cliente e até quando
  ela devolve. As peças saem do estoque e ficam no nome dela (o Estoque mostra "+ N em
  condicional"). Imprima o **comprovante** pra ela assinar e, se quiser, mande a lista no WhatsApp.
- **Na volta** (Venda rápida → "Condicionais" → Fechar): marque quantas peças ela **ficou**.
  - Ficou com alguma: "Ir pro caixa" põe essas peças no carrinho, já no nome dela. Ao confirmar a
    venda (com promoção, cashback, NFC-e...), o que voltou entra no estoque — tudo junto. Se a
    venda não for confirmada, o condicional continua aberto.
  - Não ficou com nada: "Devolveu tudo".
- O **Início** avisa os condicionais atrasados e os que vencem hoje; na lista tem "cobrar no
  WhatsApp" com a mensagem pronta, e "mudar prazo".

## Contagem de estoque (Estoque → "Contagem")

- Escolha o que contar: **loja inteira**, **uma categoria** ou **um produto**. Depois é só **bipar
  cada peça** da prateleira. Cada bip soma 1, com um apito curto (grave = erro: código desconhecido
  ou peça que não é dessa contagem). "Desfazer" tira o último bip; também dá pra digitar a
  quantidade direto na tabela.
- A tabela mostra **no sistema × contado × diferença** ("falta 2", "sobra 1", "certo"), com filtros
  "com diferença" e "não contadas".
- A contagem fica salva: dá pra **continuar depois** e contar em **mais de um computador/celular**
  ao mesmo tempo. O Caixa pode bipar; começar e concluir é com o Administrador.
- **Concluir** mostra o resumo antes de mexer no estoque. Os tamanhos/cores que ninguém bipou ficam
  como estão, ou são zerados se você marcar "não achei essas peças". Cada ajuste vai pro histórico
  do produto e aparece a diferença em dinheiro (a preço de custo).
- Melhor contar com a loja fechada: o sistema avisa se houve venda durante a contagem.

## Promoções (Estoque → "Promoções")

- **Desconto em %** com data de começo e fim, em **produtos escolhidos**, numa **categoria** ou na
  **loja inteira**. Não somam: se um produto está em duas, vale a de maior desconto.
- Durante o período o preço com desconto entra **sozinho** no caixa (sem pedir PIN, porque não é
  desconto do caixa), no **site** (com "de/por", o nome da promoção e até quando) e no
  **WhatsApp**. O preço normal do produto não muda; quando a promoção acaba, volta sozinho.
- "Encerrar agora" termina antes da data. Promoção agendada só começa no dia marcado.
- **Etiqueta**: tem a opção de imprimir com "de/por" nas peças em promoção (por padrão sai o preço
  normal, que continua valendo depois).
- **Relatórios**: em "Parados no estoque", o botão "Criar liquidação com esses" já monta a
  promoção com os produtos que não estão vendendo. O desconto das promoções aparece junto dos
  descontos dados.

## Contas a pagar (Fluxo de caixa → "Contas a pagar")

- **Boletos e parcelas com vencimento**: fornecedor, aluguel, máquina... Informe o total, quantas
  parcelas e o 1º vencimento; as parcelas são geradas (todo mês no mesmo dia, ou a cada 30 dias) e
  cada uma dá pra ajustar. Dá pra guardar a linha digitável do boleto e copiar na hora de pagar.
- **Compra a prazo**: na entrada de nota, "Pagamento da nota" tem "A prazo (boletos)". Pelo **XML**,
  os boletos da própria nota (vencimentos e valores) já vêm preenchidos.
- **Pagar** lança a despesa no Fluxo de caixa na data do pagamento (com juros/desconto, ajuste o
  valor). Lançou errado? "Desfazer" em "Pagas" tira a despesa e a conta volta a ficar em aberto.
- O **Início** avisa as vencidas, as que vencem hoje e as dos próximos 7 dias (só Administrador).

## Domínio (site da loja na internet)

Pelo **Cloudflare Tunnel**, como no Jabá. Não abre porta no roteador e o banco continua no
computador da loja.

**O que fica na internet:** só o **site da loja**. Isso é a vitrine, o pedido, o acompanhamento do
pedido e as fotos. Quem digitar o domínio cai no site. O **painel** (PIN da equipe, vendas, caixa,
relatórios) continua respondendo só no computador e na rede da loja; pela internet ele nem
aparece. Se um dia quiser abrir o painel de casa, coloque `PAINEL_REMOTO=1` no `api\.env` e
reinicie a LojaGuttoAPI.

**Proteções que já valem:**
- Limite de tentativas contado por visitante. Um abusado não trava o site pros outros clientes.
- **PIN errado 6 vezes** bloqueia aquela pessoa por 15 minutos. A contagem é separada para a
  internet e para a loja: alguém de fora errando PIN não tranca a equipe no balcão.

**Instalar (quando o domínio estiver na conta Cloudflare):**
1. Na Cloudflare, adicione o domínio e troque os nameservers no registrador pelos que a Cloudflare
   indicar.
2. No PowerShell como Administrador, em `C:\LojaGutto`:
   ```
   powershell -ExecutionPolicy Bypass -File .\cloudflared\instalar-tunel.ps1 -Dominio seudominio.com.br
   ```
   O script faz o seguinte:
   - Baixa o `cloudflared`.
   - Abre o navegador pra autorizar a conta (escolha o domínio).
   - Cria o túnel `loja-gutto` e aponta `seudominio.com.br` e `www.seudominio.com.br` pra loja.
   - Instala o serviço **LojaGuttoTunel**, que liga sozinho com o Windows.
   - Coloca `SITE_URL` no `.env`, pro link do site no painel e no WhatsApp.
3. Teste no celular fora do Wi-Fi da loja. Se não abrir, é a propagação do DNS (de minutos a
   ~24h).

## Backup do banco

Automático, de hora em hora, feito pelo próprio servidor (não precisa configurar nada no Windows).
Fica em `C:\LojaGutto\backups`: tudo das últimas 48h e um por dia até 30 dias. Cada backup é
conferido depois de criado. O painel mostra o último backup (Configurações → Backup do banco, com botão
"Fazer backup agora") e o Início avisa se ele parar de funcionar.

**Cópia fora do computador (importante):** no `api\.env`, uma linha
`BACKUP_COPIA=C:\Users\SEU_USUARIO\OneDrive\LojaGutto-backups` (ou uma pasta do Google Drive
pra computador, ou um HD externo). Recebe um arquivo por dia; guarda 30 dias. Sem isso, se o HD
do computador der problema, o backup vai junto.

**Restaurar** (⚠ substitui todos os dados atuais pelos do backup — antes, o script guarda o estado
atual, então dá pra desfazer). PowerShell como Administrador:
```
Stop-Service LojaGuttoAPI
cd C:\LojaGutto\api
node restaurar.js                       (lista os backups)
node restaurar.js loja_gutto_AAAA-MM-DD_HH-mm-ss.dump
Start-Service LojaGuttoAPI
```

## Dia a dia

Na pasta `api`:
```
npm start
```
e abra **http://localhost:3000** no navegador. Pra parar, feche a janela do Prompt
(ou Ctrl+C).

## Abrir como aplicativo (janela própria, sem barra do navegador)

**Jeito recomendado — instalar pelo Edge/Chrome**: abra http://localhost:3000 no Edge,
menu **⋯ → Aplicativos → Instalar este site como aplicativo** (no Chrome: ícone de
instalar na barra de endereço). Vira um app "Loja Gutto" com ícone "G" na Área de
Trabalho, menu Iniciar e barra de tarefas, abrindo numa janela só dele. Funciona mesmo com
o **Controle Inteligente de Aplicativos** do Windows 11 ligado.

## App Loja Gutto.exe (alternativa)

⚠ O `.exe` não tem assinatura digital, então o Windows 11 com **Controle Inteligente de
Aplicativos** ligado bloqueia ("Uma política de Controle de Aplicativo bloqueou este
arquivo"). Desligar essa proteção não tem volta sem reinstalar o Windows — por isso, nesses
PCs, use o jeito acima.

Mesmo modelo do `Jaba PDV.exe`: um `.exe` portátil (feito com Electron, código em
`desktop/`) que abre o sistema numa janela só dele, maximizada, com o ícone laranja "G".
Não precisa instalar, é só dar dois cliques. Ele **só abre a tela**: quem guarda os dados
continua sendo a API (`api/`), que precisa estar rodando.

**Servidor como serviço do Windows** (recomendado, igual ao Jabá): a API roda como o
serviço `LojaGuttoAPI` (via NSSM), liga sozinha quando o computador liga e reinicia
sozinha se cair — ninguém precisa abrir Prompt nem `npm start`.

**Gerar o .exe** (no Windows, PowerShell **como Administrador** na primeira vez — o
electron-builder cria links simbólicos e sem isso falha com "Cannot create symbolic link"):
```
cd desktop
npm install
npm run build
```
O arquivo sai em `desktop\dist\Loja Gutto.exe`. Pra trocar o ícone: edite `gen-icon.js`
e rode `npm run icone` antes do build.

**Pra onde o .exe aponta**: sem configuração, `http://localhost:3000` (o PC da loja, onde a
API roda). Pra usar em outro computador, crie um arquivo `servidor.txt` na pasta
**Documentos** desse computador com uma linha só:
- `192.168.0.10:3000` — outro PC na mesma rede da loja (IP do PC principal); ou
- `https://sistema.seudominio.com.br` — pela internet, depois que o domínio estiver ligado.

Se não conseguir conectar, o próprio app mostra onde procurou o `servidor.txt` e o que
conferir.
