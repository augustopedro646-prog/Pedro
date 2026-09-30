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
