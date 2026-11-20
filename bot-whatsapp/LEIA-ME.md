# Robô de WhatsApp da ATPN

Cópia da mecânica do robô do PDV Jabá (`Sistema clode/bot-whatsapp`). **Só mudou o que o robô sabe e diz**:
as instruções (`prompt-atpn.txt`, que vira o `SYSTEM_PROMPT` em `cerebro.js`) e as ferramentas (`tools.js`).
Conexão, fila, ritmo humano, aquecimento, pausa, chamado ao responsável e o painel são os mesmos.

O robô roda **separado** do sistema de gestão (porta 3003, só `127.0.0.1`) e **não toca** no robô do Jabá
(porta 3001, outro número, outra pasta `auth/`). A aba **WhatsApp** do sistema (só Administrador) fala com ele
por `/api/whatsapp/*` (`server/routes/whatsapp.js`), nunca direto do navegador.

## Como ligar (uma vez)
1. Colocar a chave da Anthropic em `bot-whatsapp/.env` (`ANTHROPIC_API_KEY=`, de console.anthropic.com — não é a do Claude.ai).
   Opcional: `DONO_WHATSAPP=` (número de quem atende os chamados), `STT_API_KEY=` (transcrição de áudio).
2. Como Administrador do Windows: `powershell -ExecutionPolicy Bypass -File bot-whatsapp\instalar-servico.ps1`
   (cria o serviço `ATPNBot`, igual ao `PDVJabaBot`: sobe com o computador e reinicia se cair).
3. No sistema: aba **WhatsApp** → escanear o QR Code com o **número da ATPN** (WhatsApp → Aparelhos conectados).
   Use um número **separado** do Jabá: dois robôs no mesmo número se derrubam.

## Como funciona
Mensagem chega (Baileys, conexão tipo WhatsApp Web) → espera o contato terminar de escrever (lote) → manda tudo
junto pro Claude com as instruções + ferramentas → ele consulta o sistema (`consultar_meu_cadastro`,
`consultar_data`, `reveillon_mesas`, `registrar_interesse_reserva`) e responde → a resposta sai na fila, com
"digitando…". Histórico por contato fica em `bot_conversas` (só as últimas 14 mensagens viajam pro modelo).

Duas camadas de instruções:
- **Bloco A (fixo, no código)**: `prompt-atpn.txt` — quem ele é, o que NÃO faz (cobrar, negociar, prometer, aprovar
  associação), privacidade de sócios, idioma, estilo. Pra mudar, edita o arquivo e reinicia o serviço.
- **Bloco B (texto livre)**: aba WhatsApp → *Instruções pro robô*. Vale na hora, sem reiniciar (tabela `bot_config`).

## O que ele faz pra não travar nem ser banido
Isto **reduz** sinais de automação; **não torna o uso oficial** — é uma conexão não homologada pela Meta, e o risco de
ban existe (igual ao Jabá).
- **Ritmo humano**: toda saída passa por uma **fila de um por vez**, com pausa de 0,4–1,2 s antes de "começar a digitar"
  e "digitando…" proporcional ao tamanho (0,9 a 4,5 s). Nunca duas mensagens no mesmo milissegundo.
- **Aquecimento de número novo**: limite recomendado por dia cresce com a idade do número (40 nos 2 primeiros dias →
  80 → 120 → 200 → 300 → 400) e com a reputação (+2 por contato diferente que escreveu na semana, até +100).
  A aba mostra a "saúde do número". Avisos **automáticos** (que nós começamos) param se passarem muito do limite;
  **respostas a quem escreveu nunca são bloqueadas** (travar atendimento é pior que o risco).
- **Lote**: várias mensagens seguidas viram uma resposta só (espera 6 s de silêncio, máx. 30 s) — menos envios e menos custo de IA.
- **Sessão que não cai à toa**: o erro 500 do WhatsApp é tratado como falha passageira (reconecta com as MESMAS
  credenciais, sem pedir QR de novo). Cópia de segurança da pasta `auth/` a cada 30 min (mantém 4) só com a conexão
  saudável; sessão realmente quebrada é guardada à parte, nunca apagada. O serviço recebe "parada com calma" (8 s)
  pra gravar as chaves antes de fechar.
- **Pausa geral** (botão na aba): o robô para de responder todo mundo e não chama a IA; as mensagens ficam no painel
  marcadas "Precisa de atendente". Sobrevive a reinício.
- **Humano assume**: se alguém escreve pelo celular/WhatsApp Web do número, o robô para naquela conversa na hora
  e só volta com "Devolver pro robô" (ou o responsável mandar "devolve pro robô").
- **Chamado ao responsável**: `chamar_atendente` pausa a conversa e manda um resumo mínimo pro WhatsApp do
  responsável (`DONO_WHATSAPP`), que responde por lá; o robô redige e envia, devolve o controle e confirma. Lembrete
  se ninguém responder em 30 min. Só vale a mensagem do número cadastrado ou que cita o resumo enviado.
- **Empresa/propaganda/robô**: `ignorar_mensagem` pausa o contato sem gastar IA.
- **Custo**: cache de prompt (regras + instruções + ferramentas), histórico curto, pensamento antigo descartado.
- **Falha de envio** fica registrada na conversa (aviso no painel) em vez de sumir.

## O que é diferente do Jabá
- Sem cardápio/pedido/cashback/entrega: as ferramentas são de associação (sócio, agenda do espaço, Réveillon, reservas).
- **Privacidade**: dado de sócio só sai pra a própria pessoa (telefone do WhatsApp = telefone do cadastro). Sem
  correspondência, ele chama a equipe. A agenda do espaço só diz "tem/não tem evento", sem nome de ninguém.
- Não cobra, não negocia dívida, não promete desconto/isenção, não reserva mesa sozinho — vira pedido pra equipe (aba Eventos).
- Banco: o mesmo da ATPN (`atpn_gestao`); instruções em `bot_config` (no Jabá era `app_dados`).
