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
