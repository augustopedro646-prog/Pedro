// Conexão própria de WhatsApp (Baileys, tipo WhatsApp Web via QR Code) — sem depender da API
// paga/oficial da Meta. A sessão fica salva em ./auth (equivalente a uma aba do WhatsApp Web
// permanentemente logada — não tem backup automático disso, ver CLAUDE.md).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers } = require('baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const { responder, SINAL_IGNORAR } = require('./cerebro');
const { transcrever, transcricaoConfigurada } = require('./transcricao');
const idiomaMod = require('./idioma');
const espelho = require('./espelho'); // espelho de TODAS as conversas do número (aba WhatsApp do painel)

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', (err) => console.error('Erro inesperado no pool do Postgres (conexao):', err));

const LOJA_ID = process.env.LOJA_ID || '1';
const PASTA_AUTH = path.join(__dirname, 'auth');
const HISTORICO_MAX_MENSAGENS = 24; // mesmo valor de cerebro.js — mantém as duas listas do mesmo tamanho

// baileys pede um logger no formato pino (trace/debug/info/warn/error/fatal + child()) — em vez de
// adicionar a dependência do pino só por causa disso, um objeto mínimo silencioso já serve.
// Só `error`/`fatal` do Baileys vão pro log do serviço (resumidos), pra dar pra saber DE QUEM é uma falha de
// descriptografia ("Failed to decrypt..." traz o remoteJid) — antes o logger era totalmente mudo e as
// mensagens que não abriam sumiam sem deixar rastro de quem eram. O resto continua silencioso.
function resumoLog(obj, msg) {
  let t = '';
  try { t = typeof obj === 'string' ? obj : JSON.stringify(obj, (k, v) => (typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v)); } catch (e) { t = String(obj); }
  return '[baileys] ' + (msg ? msg + ' ' : '') + String(t).slice(0, 400);
}
const logger = { level: 'error', child: () => logger, trace(){}, debug(){}, info(){}, warn(){},
  error(obj, msg) { console.error(resumoLog(obj, msg)); }, fatal(obj, msg) { console.error(resumoLog(obj, msg)); } };

// últimas mensagens que ESTE robô enviou (id -> conteúdo), pro Baileys conseguir reenviar quando o celular de
// quem recebeu pede (getMessage em makeWASocket). Só memória; 2000 é de sobra pro volume de uma associação.
const mensagensEnviadas = new Map();
function guardarEnviada(r) {
  try {
    if (r && r.key && r.key.id && r.message) {
      mensagensEnviadas.set(r.key.id, r.message);
      if (mensagensEnviadas.size > 2000) mensagensEnviadas.delete(mensagensEnviadas.keys().next().value);
    }
  } catch (e) { /* cache é só reforço, nunca pode derrubar um envio */ }
}

let sock = null;
let iniciando = false;
let tentativasReconexao = 0;
// retrato da conexão agora, lido pelo GET /status — nunca persistido, só vive em memória
let estado = { estado: 'desconectado', qrDataUrl: null, numero: null };
let encerrando = false;

// --- Resiliência da sessão -------------------------------------------------------------------
// Achado (08/10/2026): o erro "500" (DisconnectReason.badSession) NÃO quer dizer sessão corrompida —
// no Baileys é o código genérico de qualquer "stream:error" que a WhatsApp devolve sem motivo
// conhecido (instabilidade do servidor deles). O código antigo apagava ./auth a cada 500, obrigando
// a escanear o QR de novo (aconteceu 25/09, 07/10 e 08/10). Agora 500 é tratado como falha
// passageira: reconecta com as MESMAS credenciais. Só depois de MUITAS falhas seguidas tenta uma
// cópia de segurança e, em último caso, guarda a sessão quebrada numa pasta própria (nunca apaga).
const PASTA_BACKUP = path.join(__dirname, 'auth-backup');
const BACKUPS_MANTIDOS = 4;
const INTERVALO_BACKUP_MS = 30 * 60 * 1000;
let badSessionSeguidas = 0;
let restauradoDeBackup = false;
let timerBackup = null;

// cópia da pasta ./auth enquanto a conexão está saudável (versões numeradas por horário, mantém só
// as últimas BACKUPS_MANTIDOS). Seguro contra "sessão ruim": só roda com estado 'conectado'.
function snapshotAuth() {
  if (estado.estado !== 'conectado') return;
  try {
    fs.mkdirSync(PASTA_BACKUP, { recursive: true });
    fs.cpSync(PASTA_AUTH, path.join(PASTA_BACKUP, String(Date.now())), { recursive: true });
    const pastas = fs.readdirSync(PASTA_BACKUP).filter((n) => /^\d+$/.test(n)).sort();
    pastas.slice(0, Math.max(0, pastas.length - BACKUPS_MANTIDOS))
      .forEach((n) => fs.rmSync(path.join(PASTA_BACKUP, n), { recursive: true, force: true }));
  } catch (e) { console.error('Falha ao fazer backup da sessão:', e.message); }
}
function guardarAuthQuebrada() {
  try {
    if (fs.existsSync(PASTA_AUTH)) fs.renameSync(PASTA_AUTH, PASTA_AUTH + '-quebrada-' + Date.now());
  } catch (e) { console.error('Falha ao guardar auth quebrada:', e.message); }
}
function restaurarUltimoBackup() {
  try {
    const pastas = fs.readdirSync(PASTA_BACKUP).filter((n) => /^\d+$/.test(n)).sort();
    if (!pastas.length) return false;
    guardarAuthQuebrada();
    fs.cpSync(path.join(PASTA_BACKUP, pastas[pastas.length - 1]), PASTA_AUTH, { recursive: true });
    return true;
  } catch (e) { console.error('Falha ao restaurar backup da sessão:', e.message); return false; }
}

// --- Anti-detecção: ritmo humano no envio + aquecimento de número novo ------------------------
// Pesquisado antes de implementar (guias de "anti-ban" pra Baileys/conexão não-oficial, comparado
// com o que o Anota Aí e o mercado em geral fazem — nenhum concorrente usa a API oficial da Meta
// pra esse tipo de atendente, todos usam conexão tipo WhatsApp Web como essa). As duas coisas que
// mais entregam um número como bot, segundo esses guias: (1) mandar mensagem sem nenhum sinal de
// "alguém digitando" e sem pausa nenhuma entre uma e outra, e (2) volume alto logo nos primeiros
// dias de um número novo, antes dele ter qualquer "reputação". As duas foram implementadas abaixo.
// **Isso não torna o uso oficial nem elimina o risco de ban** — é uma conexão não-homologada pela
// Meta de qualquer jeito (avisado ao Pedro, decisão dele, documentada no CLAUDE.md); isso só reduz
// os sinais mais óbvios de automação, que é o que reduz a chance de detecção na prática.
const ARQ_AQUECIMENTO = path.join(__dirname, 'aquecimento-estado.json');
function lerAquecimento() {
  try { return JSON.parse(fs.readFileSync(ARQ_AQUECIMENTO, 'utf8')); } catch { return null; }
}
function salvarAquecimento(dados) {
  try { fs.writeFileSync(ARQ_AQUECIMENTO, JSON.stringify(dados)); } catch (e) { console.error('Falha ao salvar aquecimento-estado.json:', e.message); }
}
// o "relógio de aquecimento" começa a contar do primeiro pareamento bem-sucedido (connection===
// 'open'), não da instalação do bot — e é apagado junto com ./auth sempre que a sessão é encerrada/
// substituída (logout, sessão corrompida): um QR novo pode ser um número diferente, então a
// contagem tem que recomeçar do zero também.
function garantirAquecimentoIniciado() {
  let a = lerAquecimento();
  if (!a) { a = { primeiraConexaoEm: Date.now(), envios: {}, dias: {} }; salvarAquecimento(a); }
  if (!a.dias) a.dias = {};
  return a;
}
// dia e hora no fuso de Fortaleza (o servidor pode estar em UTC: usar toISOString virava o "dia" às 21h locais)
function hojeStr() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' }); }
function horaStr() { return new Date().toLocaleString('sv-SE', { timeZone: 'America/Fortaleza', hour: '2-digit', hour12: false }).slice(0, 2); }
function diaObj(a, dia) {
  if (!a.dias[dia]) a.dias[dia] = { total: a.envios && a.envios[dia] ? a.envios[dia] : 0, robo: 0, equipe: 0, sistema: 0, dono: 0, contatos: [], recebidas: 0, clientes: [], horas: {} };
  return a.dias[dia];
}
// guarda só um pedaço do hash do número (não o telefone) — serve pra contar contatos diferentes sem manter dado pessoal em disco
function marca(id) { return require('crypto').createHash('sha1').update(String(id || '')).digest('hex').slice(0, 10); }
function podarDias(a) {
  const corte = Date.now() - 35 * 24 * 60 * 60 * 1000;
  for (const d of Object.keys(a.dias)) if (new Date(d + 'T12:00:00Z').getTime() < corte) delete a.dias[d];
  delete a.envios; // formato antigo (só total/dia) — já migrado pra dias{}
}
// tipo: 'robo' (resposta do robô), 'equipe' (resposta pelo painel/WhatsApp do dono), 'sistema' (aviso automático
// que NÓS começamos, ex. "saiu pra entrega" — é o tipo mais arriscado), 'dono' (aviso/lembrete pro WhatsApp do dono)
function registrarEnvio(tipo, jid) {
  const a = garantirAquecimentoIniciado();
  const d = diaObj(a, hojeStr());
  d.total++;
  d[tipo] = (d[tipo] || 0) + 1;
  const h = horaStr();
  d.horas[h] = (d.horas[h] || 0) + 1;
  if (tipo !== 'dono') {
    const c = marca(jid);
    if (!d.contatos.includes(c) && d.contatos.length < 1000) d.contatos.push(c);
  }
  podarDias(a);
  salvarAquecimento(a);
}
function registrarRecebida(telefone) {
  const a = garantirAquecimentoIniciado();
  const d = diaObj(a, hojeStr());
  d.recebidas++;
  const c = marca(telefone);
  if (!d.clientes.includes(c) && d.clientes.length < 1000) d.clientes.push(c);
  salvarAquecimento(a);
}
// Limite RECOMENDADO por dia: cresce com o TEMPO (número novo começa devagar) e com a REPUTAÇÃO (cada cliente
// diferente que escreveu pra gente na última semana soma 2 mensagens, até +100 — quem recebe conversa de
// verdade é um número com uso legítimo). Nunca fica "ilimitado": mesmo um número antigo tem teto.
function limiteBasePorDia(dias) { return dias <= 2 ? 40 : dias <= 4 ? 80 : dias <= 7 ? 120 : dias <= 14 ? 200 : dias <= 30 ? 300 : 400; }
function faseDoNumero(dias) { return dias <= 7 ? 'Aquecimento' : dias <= 30 ? 'Crescimento' : 'Estável'; }
function calcularSaude() {
  const a = garantirAquecimentoIniciado();
  const dias = Math.floor((Date.now() - a.primeiraConexaoEm) / (24 * 60 * 60 * 1000)) + 1;
  const hoje = diaObj(a, hojeStr());
  const clientesSemana = new Set();
  const ultimos7 = [];
  for (let i = 6; i >= 0; i--) {
    const dia = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' });
    const d = a.dias[dia];
    if (d) d.clientes.forEach((c) => clientesSemana.add(c));
    ultimos7.push({ dia, total: d ? d.total : 0 });
  }
  const base = limiteBasePorDia(dias);
  const bonus = Math.min(100, clientesSemana.size * 2);
  const limiteHoje = base + bonus;
  const limiteIniciadas = Math.max(10, Math.round(limiteHoje * 0.25));
  const ultimaHora = hoje.horas[horaStr()] || 0;
  const pct = hoje.total / limiteHoje;
  const nivel = pct >= 1 ? 'acima' : pct >= 0.7 ? 'atencao' : 'ok';
  let aviso;
  if (nivel === 'acima') aviso = 'Você passou do volume recomendado de hoje. Evite mandar avisos extras e não divulgue o número em massa — volume alto demais é o que mais faz o WhatsApp banir.';
  else if (nivel === 'atencao') aviso = 'Está chegando perto do limite recomendado de hoje. Segure mensagens que não sejam respostas a clientes.';
  else aviso = 'Volume tranquilo. O limite sobe sozinho conforme o número envelhece e recebe conversas de clientes de verdade.';
  if (hoje.sistema >= limiteIniciadas) aviso += ' Os avisos automáticos (saiu pra entrega etc.) já passaram do recomendado hoje.';
  if (ultimaHora >= 40) aviso += ' Muitas mensagens na última hora — cuidado com rajadas.';
  return {
    diaAtual: dias, fase: faseDoNumero(dias), aquecido: dias > 30,
    limiteHoje, limiteBase: base, bonusReputacao: bonus, limiteIniciadas,
    enviadasHoje: hoje.total, respostasRobo: hoje.robo, respostasEquipe: hoje.equipe, avisosAutomaticos: hoje.sistema,
    contatosUnicos: hoje.contatos.length, recebidasHoje: hoje.recebidas, clientesSemana: clientesSemana.size,
    ultimaHora, nivel, aviso, ultimos7
  };
}
function statusAquecimento() { return calcularSaude(); }
// proteção real: aviso AUTOMÁTICO (começado por nós, não resposta a cliente) para de sair se passar muito do
// recomendado — resposta a quem escreveu pra gente NUNCA é bloqueada (travar atendimento é pior que o risco)
function envioSistemaBloqueado() {
  const s = calcularSaude();
  return s.avisosAutomaticos >= s.limiteIniciadas * 2 || s.enviadasHoje >= s.limiteHoje * 3;
}

// fila simples: todo envio passa por aqui, um de cada vez — evita rajada (dois clientes escrevendo
// ao mesmo tempo nunca vira duas mensagens saindo no mesmo milissegundo, um dos sinais mais óbvios
// de automação).
let filaEnvio = Promise.resolve();
function comFila(fn) {
  const proxima = filaEnvio.then(fn, fn);
  filaEnvio = proxima.catch(() => {});
  return proxima;
}
function espera(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter(min, max) { return min + Math.random() * (max - min); }
// simula "digitando..." por um tempo proporcional ao tamanho da mensagem (~28-45 caracteres/s,
// velocidade de digitação humana no celular), com piso e teto — sem isso a resposta aparece
// instantânea, sem nenhum sinal de "alguém" do outro lado escrevendo.
async function simularDigitando(jid, texto) {
  try { await sock.sendPresenceUpdate('composing', jid); } catch {}
  await espera(Math.min(4500, Math.max(900, texto.length * jitter(28, 45))));
  try { await sock.sendPresenceUpdate('paused', jid); } catch {}
}

// telefone (sem sufixo) -> remoteJid original completo, tipo "5584999999999@s.whatsapp.net"
// ou "49692889096262@lid" (endereçamento novo do WhatsApp, usado às vezes no lugar do número de
// telefone de verdade). Sem isso, responder a uma conversa de "@lid" assumindo sempre
// "@s.whatsapp.net" monta um destino que não existe — a mensagem "envia" sem erro nenhum (Baileys
// não recusa), mas nunca chega em lugar nenhum. Só em memória (reseta a cada restart do serviço) —
// sem problema, porque pra responder alguém sempre chega uma mensagem recebida primeiro, que já
// repopula isso antes de qualquer resposta ser enviada.
const jidPorTelefone = new Map();

function normalizarTelefone(remoteJid) {
  return String(remoteJid || '').split('@')[0];
}

// INSERT...ON CONFLICT (não UPDATE simples) porque a linha pode não existir ainda — ex.: primeiro
// contato com esse telefone sendo um envio de fora pra dentro (aviso de status de pedido feito no
// site, ou a equipe mandando mensagem pro cliente antes dele nunca ter mandado nada pro bot).
async function marcarFalhaEnvio(telefone, mensagemErro) {
  await pool.query(
    `INSERT INTO bot_conversas (loja_id, telefone, ultima_falha_envio)
     VALUES ($1, $2, $3)
     ON CONFLICT (loja_id, telefone) DO UPDATE SET ultima_falha_envio = $3`,
    [LOJA_ID, telefone, mensagemErro]
  ).catch((e) => console.error('Falha ao gravar ultima_falha_envio:', e.message));
}

// cadastra o cliente (nome + telefone) na primeira mensagem que ele manda, usando o nome de
// perfil do WhatsApp (pushName) — o endpoint só preenche o nome se o cliente ainda não tiver
// nenhum cadastrado (nunca sobrescreve um nome que a equipe já ajustou na mão). Fire-and-forget:
// falha aqui não pode atrapalhar o bot responder a mensagem.
// Telefone no formato dos cadastros do sistema: só dígitos, sem o 55 do Brasil (84999277208).
function telefoneNacional(digitos) {
  let d = String(digitos || '').replace(/\D/g, '');
  if (d.length >= 12 && d.length <= 13 && d.startsWith('55')) d = d.slice(2);
  return d;
}
// "@lid" = número oculto pelo WhatsApp: o código longo do JID NÃO é telefone. Telefone de verdade só quando o próprio
// WhatsApp informa (msg.key.senderPn) ou quando o cliente passou pro robô ao fazer um pedido (tools.js, criar_pedido).
// Nunca cadastra cliente com o código longo — antes isso enchia a aba Clientes de "números" de 14–15 dígitos.
function telefoneRealDoJid(msg) {
  const jid = msg.key.remoteJid || '';
  if (jid.endsWith('@s.whatsapp.net')) return telefoneNacional(jid.split('@')[0].split(':')[0]);
  const pn = msg.key.senderPn || msg.key.remoteJidAlt || '';
  if (String(pn).endsWith('@s.whatsapp.net')) return telefoneNacional(String(pn).split('@')[0].split(':')[0]);
  return '';
}
// guarda nome do perfil e telefone real na própria conversa (o painel mostra isso em vez do código) e, quando o telefone
// real é conhecido, (na ATPN não cadastra ninguém sozinho)
async function registrarContato(telefoneConversa, nomePerfil, telefoneReal) {
  const nome = nomePerfil && nomePerfil.trim() ? nomePerfil.trim().slice(0, 120) : null;
  const real = telefoneReal || null;
  if (nome || real) {
    await pool.query(
      `INSERT INTO bot_conversas (loja_id, telefone, nome, telefone_real)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (loja_id, telefone) DO UPDATE SET nome = COALESCE($3, bot_conversas.nome), telefone_real = COALESCE($4, bot_conversas.telefone_real)`,
      [LOJA_ID, telefoneConversa, nome, real]
    ).catch((e) => console.error('Falha ao gravar nome/telefone da conversa:', e.message));
  }
  // (PDV Jabá cadastrava aqui o cliente no Jabá Club; na ATPN não há cadastro automático — sócio só entra pela planilha)
}

// ---- PAUSA GERAL do robô (atendimento 100% manual) ----
// Com a pausa ligada o robô NÃO responde nenhum cliente (nem aviso de erro) e nunca chama a IA — só registra a mensagem
// no inbox do painel (marcada "Precisa de atendente") pra equipe responder pelo painel ou pelo próprio celular do
// número. Avisos automáticos de pedido (saiu pra entrega / entregue) continuam. Persistido em pausa-geral.json (sobrevive
// a reinício) e ligado/desligado pela aba WhatsApp do painel.
const ARQ_PAUSA = path.join(__dirname, 'pausa-geral.json');
let pausaGeralAtiva = false;
try { pausaGeralAtiva = !!JSON.parse(fs.readFileSync(ARQ_PAUSA, 'utf8')).pausado; } catch (e) { /* sem arquivo = robô ligado */ }
function pausaGeral() { return pausaGeralAtiva; }
function definirPausaGeral(ativa) {
  pausaGeralAtiva = !!ativa;
  try { fs.writeFileSync(ARQ_PAUSA, JSON.stringify({ pausado: pausaGeralAtiva, em: new Date().toISOString() })); } catch (e) { console.error('Falha ao gravar pausa-geral.json:', e.message); }
  console.log(pausaGeralAtiva ? 'Robô em PAUSA GERAL (atendimento manual).' : 'Pausa geral desligada — robô voltou a atender.');
}

async function conversaEstaPausada(telefone) {
  const { rows } = await pool.query(
    'SELECT pausado FROM bot_conversas WHERE loja_id = $1 AND telefone = $2',
    [LOJA_ID, telefone]
  );
  return rows.length ? rows[0].pausado : false;
}

// usado só quando a conversa está pausada (humano assumiu) — cerebro.responder já grava sozinho
// o histórico (pergunta + resposta) quando ele é chamado; aqui, sem chamar o robô, precisamos
// registrar a mensagem do cliente na mão pra ela continuar aparecendo no inbox do painel.
async function registrarMensagemSemResponder(telefone, texto) {
  const { rows } = await pool.query(
    'SELECT mensagens FROM bot_conversas WHERE loja_id = $1 AND telefone = $2',
    [LOJA_ID, telefone]
  );
  const mensagens = [...(rows.length ? rows[0].mensagens : []), { role: 'user', content: texto, ts: Date.now() }].slice(-HISTORICO_MAX_MENSAGENS);
  await pool.query(
    `INSERT INTO bot_conversas (loja_id, telefone, mensagens, atualizado_em)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (loja_id, telefone) DO UPDATE SET mensagens = EXCLUDED.mensagens, atualizado_em = now()`,
    [LOJA_ID, telefone, JSON.stringify(mensagens)]
  );
}

// grava no histórico uma mensagem que SAIU sem passar pelo loop de tool-calling do cerebro.js (que
// já se grava sozinho) — resposta manual da equipe ou aviso automático de status de pedido. Sem
// isso, o "chat" no painel mostra a pergunta do cliente sem nenhuma resposta visível, mesmo tendo
// sido respondida de verdade no WhatsApp — e o Claude perde o contexto do que já foi dito na
// próxima mensagem desse cliente. `remetente` ('equipe'|'sistema') só decide o rótulo mostrado no
// painel; ver `normalizarParaClaude` em cerebro.js pra como isso não quebra a alternância que a API
// da Anthropic exige.
async function registrarMensagemEnviada(telefone, texto, remetente) {
  const { rows } = await pool.query(
    'SELECT mensagens FROM bot_conversas WHERE loja_id = $1 AND telefone = $2',
    [LOJA_ID, telefone]
  );
  const mensagens = [...(rows.length ? rows[0].mensagens : []), { role: 'assistant', content: texto, remetente, ts: Date.now() }].slice(-HISTORICO_MAX_MENSAGENS);
  await pool.query(
    `INSERT INTO bot_conversas (loja_id, telefone, mensagens, atualizado_em)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (loja_id, telefone) DO UPDATE SET mensagens = EXCLUDED.mensagens, atualizado_em = now()`,
    [LOJA_ID, telefone, JSON.stringify(mensagens)]
  );
}

// --- Atendimento pelo WhatsApp pessoal do dono (08/10/2026) ----------------------------------
// Quando o robô chama um atendente (chamar_atendente), em vez de só marcar a conversa no painel ele
// manda um resumo pro WhatsApp do dono (DONO_WHATSAPP no .env, aceita vários separados por vírgula).
// O dono responde a mensagem do resumo (usando "Responder") e o robô redige a resposta ao cliente
// com base na orientação, envia, devolve o controle da conversa pro robô e confirma pro dono.
// Segurança: só conta como dono (a) mensagem vinda do número cadastrado, ou (b) mensagem que CITA uma
// mensagem que este robô mandou pro dono (o id citado é aleatório e só existe na conversa dos dois) —
// é assim que um contato "@lid" (número oculto) é reconhecido na primeira vez; depois fica salvo em
// dono-estado.json. Qualquer outra pessoa continua sendo tratada como cliente.
const DONOS = (process.env.DONO_WHATSAPP || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);
const ARQ_DONO = path.join(__dirname, 'dono-estado.json');
const MINUTOS_LEMBRETE_CHAMADO = Number(process.env.CHAMADO_LEMBRETE_MIN || 30);
const MAX_REPASSES_POR_CHAMADO = 2;
// o WhatsApp brasileiro às vezes tira o 9 depois do DDD (55 84 9 9999-9999 <-> 55 84 9999-9999)
function variantesNumero(n) {
  const s = new Set([n]);
  const com9 = n.match(/^55(\d{2})9(\d{8})$/);
  if (com9) s.add(`55${com9[1]}${com9[2]}`);
  const sem9 = n.match(/^55(\d{2})(\d{8})$/);
  if (sem9) s.add(`55${sem9[1]}9${sem9[2]}`);
  return s;
}
const numerosDono = new Set(DONOS.flatMap((n) => [...variantesNumero(n)]));
function lerEstadoDono() {
  try { return JSON.parse(fs.readFileSync(ARQ_DONO, 'utf8')); } catch { return { lids: [], handshake: [] }; }
}
let estadoDono = lerEstadoDono();
function salvarEstadoDono() {
  try { fs.writeFileSync(ARQ_DONO, JSON.stringify(estadoDono)); } catch (e) { console.error('Falha ao salvar dono-estado.json:', e.message); }
}
const nomePorTelefone = new Map(); // telefone -> nome de perfil do WhatsApp (só memória)
let jidsDonoCache = null;
let timerChamados = null;

async function criarTabelasChamados() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_chamados (
      id BIGSERIAL PRIMARY KEY,
      loja_id INTEGER NOT NULL,
      telefone TEXT NOT NULL,
      jid TEXT,
      nome TEXT,
      motivo TEXT,
      status TEXT NOT NULL DEFAULT 'aberto',
      lembrete_enviado BOOLEAN NOT NULL DEFAULT false,
      repasses INTEGER NOT NULL DEFAULT 0,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      respondido_em TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS bot_chamados_abertos_idx ON bot_chamados(loja_id, status, criado_em);
    CREATE TABLE IF NOT EXISTS bot_chamado_msgs (
      msg_id TEXT PRIMARY KEY,
      chamado_id BIGINT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function cortar(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
function textoDeMensagem(m) {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ');
  return '';
}
function descreverContato(telefone, jid, nome) {
  const oculto = String(jid || '').endsWith('@lid');
  const num = oculto ? 'número oculto pelo WhatsApp' : telefone.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, '+55 ($1) $2-$3');
  return nome ? `${nome} — ${num}` : num;
}

// descobre o JID certo de cada número do dono (resolve a questão do 9 extra) e guarda
async function jidsDoDono() {
  if (jidsDonoCache) return jidsDonoCache;
  const out = [];
  for (const n of DONOS) {
    let jid = `${n}@s.whatsapp.net`;
    try {
      const r = await sock.onWhatsApp(n);
      const ok = Array.isArray(r) && r.find((x) => x && x.exists);
      if (ok && ok.jid) jid = ok.jid;
    } catch (e) { console.error('onWhatsApp falhou pro dono:', e.message); }
    numerosDono.add(normalizarTelefone(jid).split(':')[0]);
    out.push(jid);
  }
  jidsDonoCache = out;
  return out;
}

// manda texto pro(s) dono(s) e devolve [{jid,id}] — sem gravar nada em bot_conversas (a conversa com o
// dono não é uma conversa de cliente e não pode aparecer no inbox do painel)
async function enviarParaDono(texto) {
  if (!DONOS.length || !sock || estado.estado !== 'conectado') return [];
  const enviados = [];
  let jids;
  try { jids = await jidsDoDono(); } catch (e) { console.error('Falha ao resolver o dono:', e.message); return []; }
  for (const jid of jids) {
    await comFila(async () => {
      try {
        await espera(jitter(300, 900));
        await simularDigitando(jid, texto);
        const r = await sock.sendMessage(jid, { text: texto });
        guardarEnviada(r);
        registrarEnvio('dono', jid);
        enviados.push({ jid, id: r && r.key && r.key.id });
      } catch (e) { console.error('Falha ao avisar o dono:', e.message); }
    });
  }
  return enviados;
}
async function registrarMsgDoDono(enviados, chamadoId) {
  for (const e of enviados) {
    if (!e.id) continue;
    await pool.query(
      'INSERT INTO bot_chamado_msgs (msg_id, chamado_id) VALUES ($1, $2) ON CONFLICT (msg_id) DO NOTHING',
      [e.id, chamadoId]
    ).catch((err) => console.error('Falha ao gravar bot_chamado_msgs:', err.message));
  }
}

// chamado pelo tool chamar_atendente (e pela rede de segurança de processarMensagemRecebida)
async function abrirChamado({ telefone, motivo, textoRecebido, nomePerfil }) {
  if (!DONOS.length) return;
  const nome = (nomePerfil && nomePerfil.trim()) || nomePorTelefone.get(telefone) || null;
  const jid = jidPorTelefone.get(telefone) || null;
  const aberto = await pool.query(
    `SELECT id FROM bot_chamados WHERE loja_id = $1 AND telefone = $2 AND status = 'aberto' ORDER BY criado_em DESC LIMIT 1`,
    [LOJA_ID, telefone]
  );
  let id;
  if (aberto.rowCount) {
    // já existe chamado aberto desse cliente e o dono já foi avisado: só atualiza o registro, NÃO manda outro aviso (13/11/2026, pedido do Pedro: menos mensagens, sem repetir)
    id = aberto.rows[0].id;
    await pool.query('UPDATE bot_chamados SET motivo = $2, jid = COALESCE($3, jid), nome = COALESCE($4, nome) WHERE id = $1', [id, motivo, jid, nome]);
    return;
  } else {
    const r = await pool.query(
      `INSERT INTO bot_chamados (loja_id, telefone, jid, nome, motivo) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [LOJA_ID, telefone, jid, nome, motivo]
    );
    id = r.rows[0].id;
  }
  // aviso MÍNIMO (13/11/2026, pedido do Pedro): cabeçalho + resumo do motivo + o que o cliente acabou de escrever (só se for diferente do resumo).
  // Antes vinha também um trecho do histórico (falas do robô e do cliente) que só repetia o que o resumo já dizia.
  const recentes = [];
  if (textoRecebido && !ehTrivialDoCliente(textoRecebido) && !/falar com (um )?(humano|atendente)/i.test(textoRecebido)) {
    recentes.push(`• Cliente: ${cortar(textoRecebido, 150)}`);
  }
  const idiomaCliente = await idiomaMod.obterIdioma(telefone).catch(() => null);
  const msg = [
    `🔔 *Atendente* #${id} — ${descreverContato(telefone, jid, nome)}`,
    idiomaCliente && idiomaCliente !== 'pt' ? `🌐 Fala *${idiomaMod.ROTULO[idiomaCliente]}* (responda em português)` : '',
    `📝 ${cortar(motivo, 180)}`,
    recentes.length ? recentes.join('\n') : '',
    `↩️ Responda esta mensagem.`
  ].filter(Boolean).join('\n');
  await registrarMsgDoDono(await enviarParaDono(msg), id);
}

// "ok", "obrigada", "blz", só emoji, "👍"... — não vale uma mensagem pro dono
function ehTrivialDoCliente(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return true; // só emoji/pontuação
  if (t.length > 40) return false;
  return /^(ok+|okay|oks|blz|beleza|certo|tudo bem|tudo certo|t[aá] bom|ta bom|ta|show|top|valeu|vlw|obrigad[oa]s?|obg|brigad[oa]|muito obrigad[oa]|ok obrigad[oa]|entendi|combinado|fechado|sim|isso|aguardo|no aguardo|aguardando|bom dia|boa tarde|boa noite|oi|ola|opa)( [a-z]+)?$/.test(t);
}

// cliente escreveu de novo enquanto o chamado está aberto: repassa pro dono — só o que importa, e no máximo 2 vezes por chamado
async function repassarAoDono(telefone, texto) {
  if (!DONOS.length) return;
  if (ehTrivialDoCliente(texto)) return;
  const r = await pool.query(
    `SELECT id, nome, jid, repasses FROM bot_chamados WHERE loja_id = $1 AND telefone = $2 AND status = 'aberto' ORDER BY criado_em DESC LIMIT 1`,
    [LOJA_ID, telefone]
  );
  if (!r.rowCount || r.rows[0].repasses >= MAX_REPASSES_POR_CHAMADO) return;
  const c = r.rows[0];
  await pool.query('UPDATE bot_chamados SET repasses = repasses + 1 WHERE id = $1', [c.id]);
  const msg = `💬 #${c.id} *${c.nome || descreverContato(telefone, c.jid, null)}*: ${cortar(texto, 250)}`;
  await registrarMsgDoDono(await enviarParaDono(msg), c.id);
}

async function fecharChamadosDoTelefone(telefone) {
  await pool.query(
    `UPDATE bot_chamados SET status = 'respondido', respondido_em = now() WHERE loja_id = $1 AND telefone = $2 AND status = 'aberto'`,
    [LOJA_ID, telefone]
  ).catch((e) => console.error('Falha ao fechar chamados:', e.message));
}

function citadoDe(msg) {
  const m = msg.message || {};
  return (m.extendedTextMessage && m.extendedTextMessage.contextInfo && m.extendedTextMessage.contextInfo.stanzaId) || null;
}

async function identificarDono(msg) {
  if (!numerosDono.size) return false;
  const jid = msg.key.remoteJid || '';
  if (jid.endsWith('@s.whatsapp.net')) return numerosDono.has(normalizarTelefone(jid).split(':')[0]);
  if (estadoDono.lids.includes(jid)) return true;
  if (jid.endsWith('@lid')) {
    const q = citadoDe(msg);
    if (q) {
      const r = await pool.query('SELECT 1 FROM bot_chamado_msgs WHERE msg_id = $1', [q]);
      if (r.rowCount) {
        estadoDono.lids.push(jid);
        salvarEstadoDono();
        console.log('Dono reconhecido por citação (contato @lid salvo).');
        return true;
      }
    }
  }
  return false;
}

// devolve true se a mensagem foi consumida como resposta do dono (senão cai no fluxo de cliente —
// assim o dono ainda consegue testar o robô como cliente quando não há chamado aberto)
// curto e com verbo de devolver + robô/bot/IA — textos longos são orientação ao cliente, não comando
function ehComandoDevolverAoRobo(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 60) return false;
  return /\b(devolv\w*|volt\w*|pass\w*|entreg\w*|deix\w*|libera\w*|retom\w*)\b.*\b(bot|robo|ia|assistente|atendente virtual)\b/.test(t);
}

async function tratarMensagemDoDono(msg, texto) {
  let chamado = null;
  const citado = citadoDe(msg);
  if (citado) {
    const m = await pool.query('SELECT chamado_id FROM bot_chamado_msgs WHERE msg_id = $1', [citado]);
    if (m.rowCount) {
      if (m.rows[0].chamado_id == null) {
        await enviarParaDono('✅ Tudo certo, reconheci o seu número. Quando um cliente precisar de atendente, eu aviso por aqui.');
        return true;
      }
      const c = await pool.query('SELECT * FROM bot_chamados WHERE id = $1', [m.rows[0].chamado_id]);
      if (c.rowCount) chamado = c.rows[0];
    }
  }
  let abertos = [];
  if (!chamado) {
    abertos = (await pool.query(
      `SELECT * FROM bot_chamados WHERE loja_id = $1 AND status = 'aberto' ORDER BY criado_em DESC`, [LOJA_ID]
    )).rows;
    if (!abertos.length) return false;
    chamado = abertos[0];
  }
  if (!texto) {
    await enviarParaDono('Só consigo ler texto por aqui 🙂 Escreva a orientação para o cliente.');
    return true;
  }
  const quem = chamado.nome || descreverContato(chamado.telefone, chamado.jid, null);
  // comando do dono: "devolva pro bot", "volta pro robô", "deixa o bot responder"... — entrega a conversa de volta ao robô, sem escrever nada ao cliente
  if (ehComandoDevolverAoRobo(texto)) {
    await fecharChamadosDoTelefone(chamado.telefone);
    await pool.query(
      `UPDATE bot_conversas SET pausado = false, precisa_humano = false WHERE loja_id = $1 AND telefone = $2`,
      [LOJA_ID, chamado.telefone]
    );
    await enviarParaDono(`✅ *${quem}* devolvido pro robô.`);
    return true;
  }
  let textoCliente;
  try {
    textoCliente = await responder(chamado.telefone, texto, chamado.nome, { orientacaoDono: true });
  } catch (e) {
    console.error('Falha ao redigir a resposta do dono pro cliente:', e);
    await enviarParaDono(`⚠️ Falha ao redigir para *${quem}*. Tente de novo ou responda pelo painel.`);
    return true;
  }
  const destino = chamado.jid || chamado.telefone;
  // sem `remetente`: responder() já gravou essa resposta no histórico (evita mensagem duplicada no inbox)
  const envio = await enviarMensagem(destino, textoCliente);
  if (!envio.ok) {
    await enviarParaDono(`⚠️ Envio para *${quem}* falhou (${cortar(envio.erro || 'erro', 80)}). Tente de novo.`);
    return true;
  }
  await pool.query(
    `UPDATE bot_chamados SET status = 'respondido', respondido_em = now() WHERE id = $1`, [chamado.id]
  );
  await pool.query(
    `UPDATE bot_conversas SET pausado = false, precisa_humano = false WHERE loja_id = $1 AND telefone = $2`,
    [LOJA_ID, chamado.telefone]
  );
  // confirmação curta (13/11/2026): o texto completo continua visível na aba WhatsApp do painel
  let aviso = `✅ Enviado para *${quem}*: «${cortar(textoCliente, 90)}»`;
  if (abertos.length > 1) aviso += `\n(${abertos.length} chamados abertos; respondi o mais recente.)`;
  await enviarParaDono(aviso);
  return true;
}

async function verificarChamadosSemResposta() {
  if (estado.estado !== 'conectado') return;
  try {
    await pool.query(`UPDATE bot_chamados SET status = 'expirado' WHERE status = 'aberto' AND criado_em < now() - interval '24 hours'`);
    const { rows } = await pool.query(
      `SELECT * FROM bot_chamados WHERE loja_id = $1 AND status = 'aberto' AND lembrete_enviado = false
         AND criado_em < now() - ($2 || ' minutes')::interval`,
      [LOJA_ID, String(MINUTOS_LEMBRETE_CHAMADO)]
    );
    for (const c of rows) {
      await pool.query('UPDATE bot_chamados SET lembrete_enviado = true WHERE id = $1', [c.id]);
      // 13/11/2026 (pedido do Pedro: menos mensagens, sem repetir): não manda mais "já avisei a equipe" ao cliente, e o lembrete ao dono
      // é UMA linha curta, sem repetir o resumo que ele já recebeu.
      const quem = c.nome || descreverContato(c.telefone, c.jid, null);
      await registrarMsgDoDono(await enviarParaDono(`⏰ #${c.id} *${quem}* ainda aguarda (${MINUTOS_LEMBRETE_CHAMADO} min). Responda a mensagem #${c.id} acima.`), c.id);
    }
  } catch (e) { console.error('Falha ao verificar chamados sem resposta:', e.message); }
}

// uma única vez por número do dono: mensagem de boas-vindas que também ensina o robô a reconhecê-lo
async function enviarHandshakeDono() {
  if (!DONOS.length || DONOS.every((n) => estadoDono.handshake.includes(n))) return;
  const enviados = await enviarParaDono('✅ *Atendimento pelo seu WhatsApp ativado.* A partir de agora, quando um cliente pedir atendente (ou eu não souber responder), eu mando um resumo aqui. Você responde usando "Responder" na mensagem e eu escrevo e envio ao cliente.\n\n👉 Para eu reconhecer o seu número, responda esta mensagem com qualquer coisa (ex.: ok).');
  if (enviados.length) {
    await registrarMsgDoDono(enviados, null);
    for (const n of DONOS) if (!estadoDono.handshake.includes(n)) estadoDono.handshake.push(n);
    salvarEstadoDono();
  }
}

// Foto e áudio do cliente (pedido do Pedro, 09/10/2026). Foto vai pro Claude como imagem (ele enxerga); áudio vira
// texto por um serviço de transcrição (ver transcricao.js) e segue como mensagem de texto. Devolve:
//   {tipo:'texto', texto}                 -> áudio transcrito
//   {tipo:'imagem', imagem:{base64,mediaType}, legenda}
//   {tipo:'aviso', aviso}                 -> não deu pra processar; `aviso` é o que responder ao cliente
//   null                                  -> mensagem sem mídia que o robô entenda (figurinha, vídeo, contato...)
const TIPOS_SEM_CONTEUDO = new Set([
  'protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'pollUpdateMessage', 'pollCreationMessage',
  'keepInChatMessage', 'encReactionMessage', 'editedMessage', 'requestPhoneNumberMessage', 'peerDataOperationRequestMessage',
  'peerDataOperationRequestResponseMessage', 'bcallMessage', 'call', 'placeholderMessage', 'secretEncryptedMessage', 'albumMessage'
]);
const IMAGENS_ACEITAS = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const LIMITE_IMAGEM_BYTES = 4 * 1024 * 1024;
const LIMITE_AUDIO_SEGUNDOS = 180;
async function extrairMidia(msg, idiomaConhecido) {
  const m = msg.message || {};
  try {
    if (m.imageMessage) {
      const mime = String(m.imageMessage.mimetype || 'image/jpeg').split(';')[0];
      if (!IMAGENS_ACEITAS.has(mime)) return { tipo: 'aviso', aviso: 'Recebi sua imagem, mas não consegui abrir esse formato — pode mandar como foto normal ou escrever?' };
      if (Number(m.imageMessage.fileLength) > LIMITE_IMAGEM_BYTES) return { tipo: 'aviso', aviso: 'Essa foto ficou grande demais pra eu abrir — pode mandar uma menor ou escrever o que precisa?' };
      const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      if (buf.length > LIMITE_IMAGEM_BYTES) return { tipo: 'aviso', aviso: 'Essa foto ficou grande demais pra eu abrir — pode mandar uma menor ou escrever o que precisa?' };
      return { tipo: 'imagem', imagem: { base64: buf.toString('base64'), mediaType: mime }, legenda: (m.imageMessage.caption || '').trim() };
    }
    if (m.audioMessage) {
      if (!transcricaoConfigurada()) return { tipo: 'aviso', aviso: 'No momento não consigo escutar o áudio, teria como escrever?' };
      if (Number(m.audioMessage.seconds) > LIMITE_AUDIO_SEGUNDOS) return { tipo: 'aviso', aviso: 'Seu áudio ficou longo demais pra eu ouvir — pode mandar um mais curto ou escrever?' };
      const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      const t = await transcrever(buf, m.audioMessage.mimetype, idiomaConhecido);
      if (!t) return { tipo: 'aviso', aviso: 'Não consegui entender seu áudio — pode repetir ou escrever?' };
      return { tipo: 'texto', texto: '[Áudio transcrito automaticamente — pode ter erros] ' + t };
    }
  } catch (e) {
    console.error('Falha ao processar mídia do cliente:', e.message);
    return { tipo: 'aviso', aviso: 'Não consegui abrir sua mensagem agora — pode escrever o que precisa?' };
  }
  return null;
}

// MENSAGENS EM LOTE (22/10/2026, pedido do Pedro): o cliente manda várias mensagens/fotos/áudios em sequência e o robô respondia
// uma por vez (uma chamada de IA e uma resposta pra cada). Agora cada contato tem um "lote": espera o cliente ficar
// LOTE_ESPERA_MS em silêncio (máx. LOTE_MAX_MS no total) e manda tudo junto pra IA, que responde UMA vez. Em conversa pausada
// (pausa geral ou humano assumiu) não tem lote: cada mensagem é registrada na hora, sem custo de IA.
const LOTE_ESPERA_MS = Number(process.env.LOTE_ESPERA_MS) || 6000;
const LOTE_MAX_MS = Number(process.env.LOTE_MAX_MS) || 30000;
const LOTE_MAX_FOTOS = 6;
const lotes = new Map();           // telefone -> { textos, imagens, nome, inicio, timer }
const processandoLote = new Set(); // telefones com uma resposta sendo gerada agora (nunca duas ao mesmo tempo pro mesmo contato)
function enfileirarParaLote(telefone, texto, nomePerfil, imagem) {
  let l = lotes.get(telefone);
  if (!l) { l = { textos: [], imagens: [], nome: nomePerfil, inicio: Date.now(), timer: null }; lotes.set(telefone, l); }
  if (texto) l.textos.push(texto);
  if (imagem) {
    if (l.imagens.length < LOTE_MAX_FOTOS) l.imagens.push(imagem);
    else l.textos.push('[mais uma foto — limite de fotos por vez atingido, não anexada]');
  }
  if (nomePerfil) l.nome = nomePerfil;
  clearTimeout(l.timer);
  const restante = Math.max(0, LOTE_MAX_MS - (Date.now() - l.inicio));
  l.timer = setTimeout(() => { fecharLote(telefone).catch((e) => console.error('Erro fechando lote de ' + telefone + ':', e)); }, Math.min(LOTE_ESPERA_MS, restante));
}
async function fecharLote(telefone) {
  const l = lotes.get(telefone);
  if (!l) return;
  // ainda gerando a resposta do lote anterior desse contato: espera (senão duas chamadas leriam o mesmo histórico e responderiam por cima uma da outra)
  if (processandoLote.has(telefone)) { l.timer = setTimeout(() => { fecharLote(telefone).catch(() => {}); }, 700); return; }
  lotes.delete(telefone);
  processandoLote.add(telefone);
  try {
    const linhas = [];
    if (l.imagens.length) linhas.push('[o cliente enviou ' + l.imagens.length + ' foto(s) — estão anexadas como imagens]');
    linhas.push(...l.textos);
    if (!linhas.length) return;
    await processarMensagemRecebida(telefone, linhas.join('\n'), l.nome, { imagens: l.imagens, jaContada: true });
  } finally {
    processandoLote.delete(telefone);
  }
}

// só contas comerciais mandam estes tipos de mensagem (a resposta do cliente a eles — templateButtonReply, buttonsResponse, listResponse — NÃO entra aqui)
const TIPOS_SO_DE_EMPRESA = ['templateMessage', 'buttonsMessage', 'listMessage', 'interactiveMessage', 'orderMessage', 'productMessage', 'highlyStructuredMessage'];
function ehMensagemDeEmpresa(msg) {
  if (msg && msg.verifiedBizName) return true;
  const m = (msg && msg.message) || {};
  return TIPOS_SO_DE_EMPRESA.some((t) => m[t]);
}

// (18/11/2026) Quando o Pedro/equipe escreve pro cliente PELO CELULAR (ou WhatsApp Web) do número do robô, o robô para
// de responder essa conversa na hora (pausado=true) e só volta quando alguém clicar em "devolver ao robô" no painel
// (ou o dono mandar "devolve pro robô"). Mensagens do próprio robô não entram aqui: elas chegam como 'append' (eco do
// sendMessage) e/ou têm o id guardado em mensagensEnviadas. O WhatsApp NÃO avisa quando alguém está DIGITANDO em outro
// aparelho — só quando a mensagem é enviada; por isso, se o cliente responder no meio da digitação e o robô já estiver
// gerando a resposta, a resposta é descartada se a pessoa enviar antes dela sair (humanoFalouEm).
const humanoFalouEm = new Map(); // telefone -> timestamp da última mensagem escrita por pessoa
async function humanoFalouNaConversa(msg) {
  const jid = msg.key.remoteJid || '';
  if (!/@(s.whatsapp.net|lid)$/.test(jid)) return; // grupo, status, lista de transmissão
  const m = msg.message || {};
  if (m.reactionMessage || m.protocolMessage || m.senderKeyDistributionMessage || m.editedMessage) return;
  // conversa "com você mesmo" (anotações que o dono manda pro próprio número): não é cliente, ignora
  const meusIds = [sock && sock.user && sock.user.id, sock && sock.user && sock.user.lid].filter(Boolean).map((x) => String(x).split('@')[0].split(':')[0]);
  if (meusIds.includes(String(jid).split('@')[0].split(':')[0])) return;
  const id = msg.key.id;
  await espera(1500); // dá tempo do envio do robô terminar de se registrar em mensagensEnviadas
  if (id && mensagensEnviadas.has(id)) return; // foi o próprio robô
  const telefone = normalizarTelefone(jid);
  if (DONOS.length && telefone && DONOS.some((d) => String(d).replace(/D/g, '').endsWith(telefone.replace(/D/g, '')) && telefone.length >= 10)) return; // conversa com o próprio dono (chamados): não pausa
  humanoFalouEm.set(telefone, Date.now());
  jidPorTelefone.set(telefone, jid);
  await pool.query(
    `INSERT INTO bot_conversas (loja_id, telefone, pausado, pausado_em) VALUES ($1, $2, true, now())
     ON CONFLICT (loja_id, telefone) DO UPDATE SET pausado = true, pausado_em = now()`,
    [LOJA_ID, telefone]
  );
  // pro robô saber o que foi dito quando voltar: entra no histórico como mensagem da equipe
  const texto = m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '[mídia enviada pela equipe]';
  await registrarMensagemEnviada(telefone, texto, 'equipe').catch((e) => console.error('Falha ao registrar fala da equipe no histórico:', e.message));
  console.log(`Equipe falou com ${telefone} pelo celular — conversa pausada (robô só volta quando devolverem no painel).`);
}

async function processarMensagemRecebida(telefone, texto, nomePerfil, extras = {}) {
  if (!extras.jaContada) { try { registrarRecebida(telefone); } catch (e) { /* contagem é só estatística */ } }
  const temFoto = !!extras.imagem || (Array.isArray(extras.imagens) && extras.imagens.length > 0);
  if (pausaGeralAtiva) {
    const textoPausa = temFoto ? '[foto do cliente] ' + texto : texto;
    await registrarMensagemSemResponder(telefone, textoPausa);
    await pool.query(
      `INSERT INTO bot_conversas (loja_id, telefone, precisa_humano) VALUES ($1, $2, true)
       ON CONFLICT (loja_id, telefone) DO UPDATE SET precisa_humano = true`,
      [LOJA_ID, telefone]
    ).catch((e) => console.error('Falha ao marcar conversa na pausa geral:', e.message));
    return;
  }
  const pausado = await conversaEstaPausada(telefone);
  if (pausado) {
    const textoRegistro = temFoto ? '[foto do cliente] ' + texto : texto; // nunca grava a imagem em si no histórico
    await registrarMensagemSemResponder(telefone, textoRegistro);
    repassarAoDono(telefone, textoRegistro).catch((e) => console.error('Falha ao repassar ao dono:', e.message));
    return;
  }
  // rede de segurança: sem isso, qualquer erro dentro de responder() (a API da Anthropic fora do
  // ar, um bug de conversa corrompida como o que já aconteceu de verdade — ver
  // turnoValidoNoInicio em cerebro.js —, qualquer coisa) deixava o cliente sem resposta NENHUMA,
  // sem aviso nenhum nem pra ele nem pro painel. Agora, se `responder()` falhar por qualquer
  // motivo, o cliente pelo menos recebe um aviso em vez de silêncio total, e a equipe é chamada.
  let resposta;
  const tsInicioResposta = Date.now();
  try {
    resposta = await responder(telefone, texto, nomePerfil, (extras.imagens && extras.imagens.length) ? { imagens: extras.imagens } : (extras.imagem ? { imagem: extras.imagem } : {}));
  } catch (e) {
    abrirChamado({ telefone, motivo: 'Erro técnico do robô ao responder esse cliente — precisa de atendimento humano.', textoRecebido: texto, nomePerfil })
      .catch((e2) => console.error('Falha ao avisar o dono do erro técnico:', e2.message));
    console.error(`responder() falhou pra ${telefone}, avisando o cliente em vez de deixar sem resposta:`, e);
    resposta = idiomaMod.msg('falhaTecnica', idiomaMod.detectarIdioma(texto) || (await idiomaMod.obterIdioma(telefone)) || 'pt');
    // mesmo efeito de chamar_atendente (tools.js) — replicado aqui direto (mesmo pool já aberto
    // nesse arquivo) pra não acoplar conexao.js em tools.js só por causa disso
    await pool.query(
      `INSERT INTO bot_conversas (loja_id, telefone, precisa_humano, pausado, pausado_em)
       VALUES ($1, $2, true, true, now())
       ON CONFLICT (loja_id, telefone) DO UPDATE SET precisa_humano = true, pausado = true, pausado_em = now()`,
      [LOJA_ID, telefone]
    ).catch((e2) => console.error('Falha ao marcar precisa_humano após erro de responder():', e2.message));
  }
  if (resposta === SINAL_IGNORAR) { console.log(`Robô decidiu não responder (empresa/propaganda/robô): ${telefone}`); return; }
  // uma pessoa da equipe escreveu pro cliente enquanto o robô gerava a resposta: não manda por cima dela
  if ((humanoFalouEm.get(telefone) || 0) >= tsInicioResposta - 1000) { console.log(`Resposta do robô descartada: a equipe falou com ${telefone} enquanto ele respondia.`); return; }
  await enviarMensagem(telefone, resposta);
}

async function enviarMensagem(telefone, texto, opts = {}) {
  if (!sock || estado.estado !== 'conectado') {
    await marcarFalhaEnvio(telefone, 'WhatsApp desconectado no momento do envio.');
    return { ok: false, erro: 'desconectado' };
  }
  if (opts.remetente === 'sistema' && envioSistemaBloqueado()) {
    console.error(`Aviso automático NÃO enviado (limite de segurança do número atingido hoje): ${telefone}`);
    return { ok: false, erro: 'limite de segurança de avisos automáticos atingido hoje' };
  }
  const jid = telefone.includes('@') ? telefone : (jidPorTelefone.get(telefone) || `${telefone}@s.whatsapp.net`);
  return comFila(async () => {
    try {
      await espera(jitter(400, 1200)); // pequena pausa antes de "começar a digitar" — tempo de ler a mensagem
      await simularDigitando(jid, texto);
      const enviado = await sock.sendMessage(jid, { text: texto });
      guardarEnviada(enviado);
      // grava no espelho com o remetente certo (robô / equipe do painel / aviso automático) — o eco do WhatsApp não sobrescreve isso
      espelho.salvarMensagem(enviado, { remetente: opts.remetente === 'sistema' ? 'sistema' : opts.remetente === 'equipe' ? 'equipe' : 'robo', forcarRemetente: true }).catch((e) => console.error('Espelho: falha ao gravar envio:', e.message));
      registrarEnvio(opts.remetente === 'sistema' ? 'sistema' : opts.remetente === 'equipe' ? 'equipe' : 'robo', jid);
      // a equipe respondeu (painel ou WhatsApp do dono): o chamado desse cliente deixa de ficar aberto
      if (opts.remetente === 'equipe') await fecharChamadosDoTelefone(normalizarTelefone(jid));
      // resposta do robô (chamada de dentro de processarMensagemRecebida) já se grava sozinha, com
      // mais detalhe, dentro de cerebro.responder() — só grava aqui quando é a equipe/um aviso
      // automático, que não passam por lá (ver registrarMensagemEnviada acima)
      if (opts.remetente) {
        await registrarMensagemEnviada(normalizarTelefone(jid), texto, opts.remetente)
          .catch((e) => console.error('Falha ao registrar mensagem enviada no histórico:', e.message));
      }
      await pool.query(
        'UPDATE bot_conversas SET ultima_falha_envio = NULL WHERE loja_id = $1 AND telefone = $2',
        [LOJA_ID, normalizarTelefone(jid)]
      ).catch(() => {});
      return { ok: true, id: enviado && enviado.key && enviado.key.id };
    } catch (e) {
      console.error(`Falha ao enviar WhatsApp pra ${telefone}:`, e.message);
      await marcarFalhaEnvio(normalizarTelefone(jid), e.message);
      return { ok: false, erro: e.message };
    }
  });
}

// Telefone que veio de um pedido (site ou robô) costuma ser só DDD+número ("84988655821"), sem o 55, e o
// WhatsApp brasileiro às vezes não tem o 9 extra — então acrescenta o 55 e pergunta ao próprio WhatsApp
// (onWhatsApp) qual é o JID certo. Se o cliente já escreveu pra gente (jidPorTelefone), usa o JID dele.
const jidPorNumero = new Map();
async function resolverJidDeNumero(numero) {
  let d = String(numero || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (jidPorTelefone.has(d)) return jidPorTelefone.get(d);
  if (jidPorNumero.has(d)) return jidPorNumero.get(d);
  let jid = d + '@s.whatsapp.net';
  try {
    const r = await sock.onWhatsApp(d);
    const ok = Array.isArray(r) && r.find((x) => x && x.exists);
    if (ok && ok.jid) jid = ok.jid;
    else if (Array.isArray(r) && r.length) return null; // número sem WhatsApp
  } catch (e) { /* segue com o JID padrão */ }
  jidPorNumero.set(d, jid);
  return jid;
}
async function enviarParaNumero(numero, texto, opts = {}) {
  if (!sock || estado.estado !== 'conectado') return { ok: false, erro: 'desconectado' };
  const jid = await resolverJidDeNumero(numero);
  if (!jid) return { ok: false, erro: 'número sem WhatsApp' };
  return enviarMensagem(jid, texto, opts);
}

function getStatus() {
  return { ...estado, pausaGeral: pausaGeralAtiva, aquecimento: estado.estado === 'conectado' ? statusAquecimento() : null };
}

async function desconectar() {
  if (sock) {
    try { await sock.logout(); } catch (e) { /* pode já estar desconectado, ignora */ }
  }
  estado = { estado: 'desconectado', qrDataUrl: null, numero: null };
}

async function iniciar() {
  if (iniciando) return;
  iniciando = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(PASTA_AUTH);
    // getMessage: quando o celular de quem recebeu NÃO consegue abrir uma mensagem nossa ("Aguardando
    // mensagem. Essa ação pode levar alguns instantes" no WhatsApp dele), ele pede um reenvio ao Baileys, e
    // o Baileys só consegue reenviar se souber devolver o conteúdo original — sem isto a mensagem ficava
    // "aguardando" pra sempre (visto de verdade no WhatsApp do Pedro, 09/10/2026). Guarda as últimas enviadas.
    sock = makeWASocket({ auth: state, logger, printQRInTerminal: false, ...(process.env.WA_HISTORICO_COMPLETO === '1' ? { browser: Browsers.macOS('Desktop'), syncFullHistory: true } : {}), getMessage: async (key) => mensagensEnviadas.get(key && key.id) || undefined });

    // sem isso, todo reinício do processo (inclusive um crash-restart do NSSM) invalida a
    // sessão e pede escanear o QR de novo — destrói o propósito de persistir em ./auth.
    sock.ev.on('creds.update', saveCreds);

    // ---- espelho das conversas (aba WhatsApp do painel mostra TUDO, como o WhatsApp Web) ----
    // histórico que o WhatsApp entrega quando o aparelho é conectado (só vem na hora do pareamento por QR)
    sock.ev.on('messaging-history.set', (h) => { espelho.salvarHistorico(h || {}).catch((e) => console.error('Espelho: falha ao gravar histórico:', e.message)); });
    // toda mensagem individual, de qualquer pessoa e também as mandadas do celular do dono (fromMe) — independe do robô responder ou não
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages || []) espelho.salvarMensagem(m, { remetente: 'equipe' }).catch((e) => console.error('Espelho: falha ao gravar mensagem:', e.message));
    });
    sock.ev.on('contacts.upsert', (cs) => { for (const c of cs || []) espelho.salvarNome(c.id, c.name || c.notify || c.verifiedName).catch(() => {}); });
    sock.ev.on('contacts.update', (cs) => { for (const c of cs || []) if (c.id) espelho.salvarNome(c.id, c.name || c.notify || c.verifiedName).catch(() => {}); });
    sock.ev.on('chats.upsert', (cs) => { for (const c of cs || []) espelho.salvarNome(c.id, c.name || c.displayName).catch(() => {}); });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        estado = { estado: 'aguardando_qr', qrDataUrl: await QRCode.toDataURL(qr), numero: null };
      }

      if (connection === 'open') {
        tentativasReconexao = 0;
        badSessionSeguidas = 0;
        restauradoDeBackup = false;
        const numero = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : null;
        estado = { estado: 'conectado', qrDataUrl: null, numero };
        garantirAquecimentoIniciado();
        console.log(`WhatsApp conectado como ${numero}`);
        setTimeout(snapshotAuth, 30 * 1000); // depois de alguns segundos estável
        if (!timerBackup) timerBackup = setInterval(snapshotAuth, INTERVALO_BACKUP_MS);
        // atendimento pelo WhatsApp do dono: tabelas, lembrete de chamado sem resposta e boas-vindas (1 vez)
        jidsDonoCache = null;
        if (DONOS.length) {
          criarTabelasChamados()
            .then(() => {
              if (!timerChamados) timerChamados = setInterval(verificarChamadosSemResposta, 60 * 1000);
              setTimeout(() => enviarHandshakeDono().catch((e) => console.error('Falha no handshake do dono:', e.message)), 20 * 1000);
            })
            .catch((e) => console.error('Falha ao criar tabelas de chamados:', e.message));
        }
      }

      if (connection === 'close') {
        if (encerrando) return; // o serviço está sendo parado de propósito — não reconecta
        const codigo = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : undefined;

        if (codigo === DisconnectReason.loggedOut) {
          console.log('WhatsApp: sessão encerrada (logout) — apagando ./auth, vai pedir QR novo.');
          try { fs.rmSync(PASTA_AUTH, { recursive: true, force: true }); } catch {}
          try { fs.rmSync(ARQ_AQUECIMENTO, { force: true }); } catch {} // QR novo pode ser outro número — recomeça o aquecimento
          estado = { estado: 'desconectado', qrDataUrl: null, numero: null };
          iniciando = false;
          return; // não reconecta sozinho
        }
        if (codigo === DisconnectReason.connectionReplaced) {
          console.log('WhatsApp: sessão substituída por outro QR escaneado em outro lugar.');
          estado = { estado: 'substituida', qrDataUrl: null, numero: null };
          iniciando = false;
          return; // não reconecta sozinho
        }
        if (codigo === DisconnectReason.badSession) {
          // NÃO apaga a sessão (ver comentário no topo): reconecta com backoff e as mesmas credenciais
          badSessionSeguidas++;
          console.error(`WhatsApp: erro 500 do servidor (${badSessionSeguidas}ª seguida) — mantendo a sessão e tentando de novo.`);
          if (badSessionSeguidas === 12 && !restauradoDeBackup) {
            restauradoDeBackup = true;
            console.error('WhatsApp: 12 falhas seguidas — tentando a cópia de segurança mais recente da sessão.');
            if (restaurarUltimoBackup()) { iniciando = false; setTimeout(iniciar, 2000); return; }
          }
          if (badSessionSeguidas >= 30) {
            console.error('WhatsApp: 30 falhas seguidas — guardando a sessão em auth-quebrada-* (não apagada) e pedindo QR novo.');
            guardarAuthQuebrada();
            try { fs.rmSync(ARQ_AQUECIMENTO, { force: true }); } catch {}
            badSessionSeguidas = 0;
            estado = { estado: 'desconectado', qrDataUrl: null, numero: null };
            iniciando = false;
            iniciar();
            return;
          }
          // segue pro reconectar com espera, logo abaixo
        }
        if (codigo === DisconnectReason.restartRequired) {
          iniciando = false;
          iniciar(); // reconecta na hora — é o WhatsApp pedindo reinício de rotina, não uma falha
          return;
        }
        // qualquer outro motivo (rede caiu, etc.) — reconecta com backoff, pra não bater no
        // servidor do WhatsApp em loop apertado se a instabilidade for sustentada
        tentativasReconexao++;
        const espera = Math.min(30000, 2000 * Math.pow(2, tentativasReconexao - 1));
        estado = { estado: 'reconectando', qrDataUrl: null, numero: null };
        console.log(`WhatsApp: conexão caiu (código ${codigo}), tentando de novo em ${espera / 1000}s...`);
        iniciando = false;
        setTimeout(iniciar, espera);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // Baileys só manda 2 tipos aqui (nunca o resync de histórico completo, que é outro evento —
      // 'messaging-history.set' — que este código nem assina): 'notify' é mensagem ao vivo; 'append'
      // é mensagem que a própria WhatsApp marcou como recebida enquanto ESTA sessão estava offline
      // (`node.attrs.offline` no Baileys) — ou seja, exatamente o que fica acumulado durante uma
      // queda de conexão (como a de 25-30/09) e precisa ser respondido assim que reconectar, não
      // ignorado. Pedido explícito do Pedro depois de esse caso acontecer de verdade.
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of messages) {
        if (!msg.message) continue;
        if (msg.key.fromMe) { // mensagem mandada do próprio celular linkado: se foi uma PESSOA digitando (não o robô), o robô sai da conversa
          if (type === 'notify') humanoFalouNaConversa(msg).catch((e) => console.error('Falha ao pausar conversa quando a equipe falou:', e.message));
          continue;
        }
        if (msg.key.remoteJid?.endsWith('@g.us')) continue; // ignora grupo
        // só conversa de pessoa: ignora status (status@broadcast), listas de transmissão e canais — antes um status de
        // alguém virava um "cliente" chamado "status"
        if (!/@(s\.whatsapp\.net|lid)$/.test(msg.key.remoteJid || '')) continue;
        // reação com emoji a uma mensagem (👍 ❤️ etc.) não é uma mensagem nova: o robô não responde nem registra nada. Antes caía no ramo de
        // "mídia não suportada" e o cliente recebia "não entendi" (pedido do Pedro, 04/11/2026). Vale também pro dono reagindo a um chamado.
        if (msg.message.reactionMessage) continue;
        // eventos de sistema do WhatsApp que NÃO são mensagem do cliente (aviso de protocolo, mensagem editada/apagada, chave de grupo,
        // atualização de enquete, mensagens temporárias ligadas/desligadas...): chegam junto com as mensagens reais e antes caíam no ramo de
        // "mídia não suportada" — o cliente recebia "só consigo ler texto" do nada (caso real 18/11/2026, "Olá" e "Tá bem obg" que só tinham texto).
        {
          const chaves = Object.keys(msg.message).filter((k) => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage');
          if (!chaves.length || chaves.every((k) => TIPOS_SEM_CONTEUDO.has(k))) {
            console.log(`Evento de sistema ignorado (sem conteúdo do cliente): ${Object.keys(msg.message).join(', ')} ${msg.key.remoteJid}`);
            continue;
          }
        }
        let texto =msg.message.conversation || msg.message.extendedTextMessage?.text;
        // mensagem do dono respondendo a um chamado? (ver "Atendimento pelo WhatsApp pessoal do dono")
        if (DONOS.length && await identificarDono(msg).catch(() => false)) {
          const consumida = await tratarMensagemDoDono(msg, texto).catch((e) => { console.error('Erro tratando mensagem do dono:', e); return true; });
          if (consumida) continue;
        }
        // conta COMERCIAL verificada (selo verde) ou mensagem de modelo/botões/lista/catálogo (só empresas enviam isso): o robô não responde
        if (ehMensagemDeEmpresa(msg)) { console.log(`Mensagem de empresa ignorada (conta comercial): ${msg.verifiedBizName || msg.pushName || ''} ${msg.key.remoteJid}`); continue; }
        const telefone = normalizarTelefone(msg.key.remoteJid);
        jidPorTelefone.set(telefone, msg.key.remoteJid); // guarda o JID real (@lid ou @s.whatsapp.net) pra responder certo
        if (msg.pushName) nomePorTelefone.set(telefone, msg.pushName);
        await registrarContato(telefone, msg.pushName, telefoneRealDoJid(msg)).catch(() => {});
        let extras = {};
        if (!texto) {
          const idiomaConversa = await idiomaMod.obterIdioma(telefone);
          const midia = await extrairMidia(msg, idiomaConversa);
          if (midia && midia.tipo === 'texto') texto = midia.texto;
          else if (midia && midia.tipo === 'imagem') { extras = { imagem: midia.imagem }; texto = midia.legenda || ''; }
          else {
            // pausa geral: nada de aviso automático — só registra no inbox pra equipe ver
            if (pausaGeralAtiva) { await processarMensagemRecebida(telefone, '[mensagem de mídia: áudio, figurinha, vídeo ou outro — abra no WhatsApp]', msg.pushName, {}).catch(() => {}); continue; }
            // já tem lote aberto: em vez de uma resposta separada só pra isso, anota no lote pra IA avisar tudo numa mensagem só
            if (lotes.has(telefone)) { try { registrarRecebida(telefone); } catch (e) {} enfileirarParaLote(telefone, '[uma mídia que o cliente enviou não pôde ser aberta/entendida — peça com gentileza para escrever ou reenviar]', msg.pushName, null); continue; }
            // figurinha, vídeo, documento, localização... ou mídia que não deu pra abrir: avisa em vez de deixar sem resposta
            await enviarMensagem(telefone, idiomaMod.traduzirAviso((midia && midia.aviso) || idiomaMod.msg('midiaNaoSuportada', 'pt'), idiomaConversa)).catch(() => {});
            continue;
          }
        }
        // pushName é o nome de exibição que a própria pessoa escolheu no WhatsApp dela — passa pro
        // cérebro pra ele poder cumprimentar pelo nome ("Oi, Fulano!"), sem precisar perguntar nem
        // chamar nenhuma ferramenta só pra isso; pode vir vazio (contato sem nome salvo).
        // `await` de propósito (não é fire-and-forget) — um catch-up de queda longa pode trazer várias
        // mensagens da MESMA pessoa (ou de gente diferente) no mesmo lote; processar em paralelo faria
        // duas chamadas lerem o histórico da conversa ao mesmo tempo e responderem por cima uma da
        // outra, ou gerar 2+ respostas picadas em vez de uma só coerente.
        // conversa pausada (pausa geral ou humano assumiu): registra na hora, sem lote e sem IA. Senão entra no lote do contato.
        if (pausaGeralAtiva || await conversaEstaPausada(telefone).catch(() => false)) {
          await processarMensagemRecebida(telefone, texto || '(o cliente enviou esta foto sem legenda)', msg.pushName, extras).catch((e) => console.error(`Erro processando mensagem de ${telefone}:`, e));
        } else {
          try { registrarRecebida(telefone); } catch (e) { /* contagem é só estatística */ }
          enfileirarParaLote(telefone, texto, msg.pushName, extras.imagem || null);
        }
      }
    });
  } finally {
    iniciando = false;
  }
}

// chamado quando o serviço recebe pedido de parada (restart do Windows/NSSM): fecha o socket e dá
// um tempinho pro Baileys terminar de gravar as chaves — matar o processo no meio de uma gravação
// pode deixar um arquivo de chave pela metade (uma das suspeitas das sessões "corrompidas").
async function encerrar() {
  encerrando = true;
  // lotes que ainda estavam esperando o cliente terminar: responde agora, antes de fechar a conexão
  for (const tel of [...lotes.keys()]) { const l = lotes.get(tel); if (l) { clearTimeout(l.timer); await fecharLote(tel).catch(() => {}); } }
  if (timerBackup) { clearInterval(timerBackup); timerBackup = null; }
  if (timerChamados) { clearInterval(timerChamados); timerChamados = null; }
  try { if (sock) sock.end(undefined); } catch {}
  await espera(2000);
}

module.exports = { iniciar, enviarMensagem, enviarParaNumero, getStatus, desconectar, encerrar, abrirChamado, definirPausaGeral };
