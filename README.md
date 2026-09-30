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
domínio). Configure em **Equipe → Configurações da loja → Site da loja** (entrega, retirada, taxa,
WhatsApp, endereço). Produto aparece no site se estiver ativo, marcado "Mostrar no site" (na
edição do produto, onde também vão as fotos) e com estoque. As peças de um pedido ficam
reservadas na hora; ao concluir na aba **Pedidos online**, o pedido vira venda do caixa aberto.

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
58 mm e o rodapé (ex.: política de troca) em Equipe → Configurações da loja. A página sai com a
altura exata do conteúdo, sem gastar rolo.

Sai pela janela de impressão do Windows (o navegador lembra a última impressora usada). Pra
imprimir sem a janela, dá pra pôr `--kiosk-printing` no atalho do Edge — aí tudo vai direto pra
impressora padrão do Windows, inclusive as etiquetas; só vale a pena se as etiquetas forem
impressas em outro computador.

## Backup do banco

Automático, de hora em hora, feito pelo próprio servidor (não precisa configurar nada no Windows).
Fica em `C:\LojaGutto\backups`: tudo das últimas 48h e um por dia até 30 dias. Cada backup é
conferido depois de criado. O painel mostra o último backup (Equipe → Backup do banco, com botão
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
