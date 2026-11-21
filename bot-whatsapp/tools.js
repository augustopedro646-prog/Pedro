// Ferramentas do atendente da ATPN. Mesma mecânica do robô do PDV Jabá (loop de tool-calling em cerebro.js);
// o que muda aqui é só O QUE o robô consegue consultar: associação (sócio, agenda do espaço, Réveillon, reservas),
// não cardápio/pedido. Lê e grava direto no Postgres da ATPN (mesmo banco do sistema de gestão).
// PRIVACIDADE: dado de sócio só sai pra a própria pessoa (telefone do WhatsApp = telefone do cadastro). A agenda do
// espaço (PDV Jabá, leitura) devolve só "tem/não tem evento", nunca nome de cliente.
require('dotenv').config();
const { Pool } = require('pg');

const LOJA_ID = process.env.LOJA_ID || '1';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', (err) => console.error('Erro inesperado no pool do Postgres (tools):', err));

// leitura da agenda do PDV (opcional: sem JABA_DATABASE_URL a ferramenta pede confirmação da equipe)
const jabaPool = process.env.JABA_DATABASE_URL ? new Pool({ connectionString: process.env.JABA_DATABASE_URL }) : null;
if (jabaPool) jabaPool.on('error', (err) => console.error('Erro inesperado no pool do PDV (tools):', err));
const JABA_LOJA_ID = Number(process.env.JABA_LOJA_ID || 3);

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const digitos = (v) => String(v || '').replace(/\D/g, '');
// o WhatsApp brasileiro às vezes tira o 9 depois do DDD — compara pelos últimos 8 dígitos + DDD
function chavesTelefone(v) {
  let d = digitos(v);
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  if (d.length < 10 || d.length > 13) return []; // 14+ dígitos = código @lid do WhatsApp, não é telefone
  const ddd = d.slice(0, 2), fim = d.slice(-8);
  return [ddd + fim];
}
const ROTULO_STATUS = {
  em_dia: 'em dia',
  ate_2_meses: 'com 1 a 2 meses em atraso',
  '3_a_5_meses': 'com 3 a 5 meses em atraso',
  '6_meses_ou_mais': 'com 6 meses ou mais em atraso',
  desligado: 'desligado',
};

const definicoes = [
  {
    name: 'consultar_meu_cadastro',
    description: 'Situação do cadastro de sócio DE QUEM ESTÁ ESCREVENDO (achado pelo telefone do WhatsApp): nome, categoria, se está em dia e quantos meses em aberto. Só serve pra própria pessoa — nunca use pra consultar outra pessoa. Se não achar, devolve encontrado:false (então chame a equipe, não adivinhe).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'consultar_data',
    description: 'Diz se o espaço (salão da associação/Jabá) já tem algum evento marcado numa data. Só devolve "tem evento" ou "sem evento registrado" — sem detalhes de ninguém. A disponibilidade final é sempre confirmada pela equipe.',
    input_schema: {
      type: 'object',
      properties: { data: { type: 'string', description: 'formato AAAA-MM-DD' } },
      required: ['data'],
    },
  },
  {
    name: 'reveillon_mesas',
    description: 'Situação das mesas do Réveillon: quantas estão livres/reservadas e quais números estão livres. Não reserva nada.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'registrar_interesse_reserva',
    description: 'Registra o interesse de alguém em reservar o espaço, participar de um evento (ex.: Réveillon e a mesa pretendida), visitar ou pedir orçamento — vira uma solicitação que a equipe vê e responde depois. Não cota preço nem garante data/mesa. Use quando a pessoa pedir isso; peça pelo menos nome e telefone.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', description: 'ex.: Réveillon, aniversário, casamento, confraternização, visita' },
        nome: { type: 'string' },
        telefone: { type: 'string' },
        data: { type: 'string', description: 'formato AAAA-MM-DD, se a pessoa souber a data' },
        numPessoas: { type: 'integer' },
        mensagem: { type: 'string', description: 'o que a pessoa pediu, resumido, em português (ex.: mesa 12 do Réveillon, 6 pessoas)' },
      },
      required: ['tipo', 'nome', 'telefone'],
    },
  },
  {
    name: 'ignorar_mensagem',
    description: 'Ignora esta conversa SEM responder nada — use SOMENTE quando a mensagem for com certeza de uma EMPRESA oferecendo produto ou serviço à associação (fornecedor, agência, software, marketing, financeira, prospecção) ou propaganda/robô. Na dúvida, NÃO use.',
    input_schema: {
      type: 'object',
      properties: { motivo: { type: 'string', description: 'em poucas palavras, por que é empresa/propaganda/robô' } },
      required: ['motivo'],
    },
  },
  {
    name: 'chamar_atendente',
    description: 'Chama um atendente humano da equipe pra continuar essa conversa — use quando pedirem uma pessoa, em assunto financeiro/cobrança/negociação/cancelamento/reclamação, ou quando você não conseguir ajudar. A partir daqui você para de responder essa conversa.',
    input_schema: {
      type: 'object',
      properties: { motivo: { type: 'string', description: 'resumo curto do que a pessoa quer/precisa e o que já foi tentado — o responsável recebe isso no WhatsApp dele; escreva em português e diga em que idioma a pessoa fala' } },
      required: ['motivo'],
    },
  },
];

const execucoes = {
  async consultar_meu_cadastro(_input, { telefone } = {}) {
    // telefone da conversa (dígitos do WhatsApp) + telefone real, se o WhatsApp informou (contato "@lid" oculto)
    const { rows: conv } = await pool.query('SELECT telefone_real FROM bot_conversas WHERE loja_id = $1 AND telefone = $2', [LOJA_ID, telefone]);
    const chaves = new Set([...chavesTelefone(telefone), ...chavesTelefone(conv[0] && conv[0].telefone_real)]);
    if (!chaves.size) return { encontrado: false, motivo: 'Não tenho o número de telefone dessa conversa (WhatsApp ocultou). Peça pra equipe conferir.' };
    const { rows } = await pool.query(
      `SELECT s.nome, s.clube, s.categoria, s.status, s.meses_em_aberto, s.situacao_especial,
              (SELECT count(*)::int FROM dependentes d WHERE d.socio_id = s.id) AS dependentes
       FROM socios s
       WHERE regexp_replace(COALESCE(s.telefone, ''), '\\D', '', 'g') <> '' AND (
         substr(regexp_replace(s.telefone, '\\D', '', 'g'), 1, 2) || right(regexp_replace(s.telefone, '\\D', '', 'g'), 8) = ANY($1)
         OR substr(regexp_replace(COALESCE(s.telefone_secundario, ''), '\\D', '', 'g'), 1, 2) || right(regexp_replace(COALESCE(s.telefone_secundario, ''), '\\D', '', 'g'), 8) = ANY($1)
       ) ORDER BY s.nome LIMIT 3`,
      [[...chaves]]
    );
    if (!rows.length) return { encontrado: false, motivo: 'Nenhum cadastro com esse telefone. Não adivinhe: ofereça chamar a equipe.' };
    if (rows.length > 1) return { encontrado: false, motivo: 'Mais de um cadastro com esse telefone. Peça pra equipe conferir (não revele nomes).' };
    const s = rows[0];
    return {
      encontrado: true,
      nome: s.nome,
      clube: s.clube,
      categoria: s.categoria,
      situacao: ROTULO_STATUS[s.status] || s.status,
      mesesEmAberto: s.meses_em_aberto,
      dependentes: s.dependentes,
      observacao: s.situacao_especial || null,
      aviso: 'Informe só a situação. Valores, acordos e baixa de pagamento são com a equipe.',
    };
  },

  async consultar_data({ data }) {
    if (!DATA_RE.test(String(data || ''))) return { erro: 'Data inválida — use AAAA-MM-DD.' };
    if (!jabaPool) return { tem_evento: null, aviso: 'Agenda indisponível agora — a equipe confirma a data.' };
    // Disponibilidade do salão: tudo que ocupa o espaço conta (Jabá, ATPN, ambos); só
    // evento 'externo' (fora do salão) não bloqueia. O robô só diz "tem/não tem", sem título.
    const consulta = (comEscopo) => jabaPool.query(
      `SELECT (SELECT count(*) FROM agenda_eventos a WHERE a.tipo = 'evento' AND a.evento_id IS NULL AND a.data = $1${comEscopo ? " AND a.escopo <> 'externo'" : ''})
            + (SELECT count(*) FROM encomendas_evento e WHERE e.data_evento = $1 AND e.status NOT IN ('recusado')${comEscopo ? " AND e.escopo <> 'externo'" : ''})::int AS n`,
      [data]
    );
    let rows;
    try { ({ rows } = await consulta(true)); } catch (e) { ({ rows } = await consulta(false)); } // coluna escopo ainda não criada no PDV
    const n = Number(rows[0].n);
    return { data, tem_evento: n > 0, aviso: 'A disponibilidade final é confirmada pela equipe.' };
  },

  async reveillon_mesas() {
    const { rows } = await pool.query(`SELECT mesa_numero FROM reveillon_reservas WHERE status <> 'cancelada'`);
    const ocupadas = new Set(rows.map((r) => r.mesa_numero));
    const TOTAL = 30; // mesas da planta do salão (public/planta-salao.js)
    const livres = [];
    for (let n = 1; n <= TOTAL; n++) if (!ocupadas.has(n)) livres.push(n);
    return { total: TOTAL, reservadas: ocupadas.size, livres, aviso: 'Reserva só vale depois da confirmação da equipe.' };
  },

  async registrar_interesse_reserva({ tipo, nome, telefone, data, numPessoas, mensagem }) {
    const dataOk = DATA_RE.test(String(data || '')) ? data : null;
    // reservas.data é obrigatório: sem data informada, usa hoje e marca na observação (a equipe vê "sem data definida")
    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' });
    const obs = [dataOk ? null : '(sem data definida — combinar)', mensagem ? String(mensagem).slice(0, 400) : null, 'Origem: WhatsApp (robô)'].filter(Boolean).join(' · ');
    const n = Number.isInteger(numPessoas) && numPessoas > 0 && numPessoas < 2000 ? numPessoas : null;
    await pool.query(
      `INSERT INTO reservas (titulo, solicitante, telefone, data, num_convidados, observacao, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'novo')`,
      [String(tipo || 'Reserva').slice(0, 80), String(nome || '').slice(0, 80), String(telefone || '').slice(0, 30), dataOk || hoje, n, obs]
    );
    return { ok: true, mensagem: 'Pedido registrado! A equipe vai entrar em contato pra confirmar os detalhes.' };
  },

  // empresa/propaganda/robô: a conversa fica PAUSADA (o robô não responde mais esse contato e não gasta chamada de IA; aparece no
  // inbox como "Robô pausado" e "Devolver pro robô" desfaz se foi engano). Não abre chamado nem avisa o responsável.
  async ignorar_mensagem({ motivo }, { telefone } = {}) {
    await pool.query(
      `INSERT INTO bot_conversas (loja_id, telefone, pausado, pausado_em)
       VALUES ($1, $2, true, now())
       ON CONFLICT (loja_id, telefone) DO UPDATE SET pausado = true, pausado_em = now(), precisa_humano = false`,
      [LOJA_ID, telefone]
    );
    console.log(`Mensagem ignorada pelo robô (empresa/propaganda/robô) — ${telefone}: ${String(motivo || '').slice(0, 120)}`);
    return { ok: true, ignorada: true };
  },

  async chamar_atendente({ motivo }, { telefone, textoRecebido, nomePerfil } = {}) {
    await pool.query(
      `INSERT INTO bot_conversas (loja_id, telefone, precisa_humano, pausado, pausado_em)
       VALUES ($1, $2, true, true, now())
       ON CONFLICT (loja_id, telefone) DO UPDATE SET precisa_humano = true, pausado = true, pausado_em = now()`,
      [LOJA_ID, telefone]
    );
    // avisa o responsável no WhatsApp pessoal dele (resumo + resposta por lá). require aqui dentro porque conexao.js carrega
    // cerebro.js, que carrega este arquivo — no topo seria dependência circular. Sem await: a pessoa não espera o aviso.
    try {
      require('./conexao').abrirChamado({ telefone, motivo, textoRecebido, nomePerfil })
        .catch((e) => console.error('Falha ao avisar o responsável do chamado:', e.message));
    } catch (e) { console.error('Falha ao acionar abrirChamado:', e.message); }
    return { ok: true, mensagem: 'Vou chamar alguém da equipe pra te ajudar, só um momento! 🙋' };
  },
};

module.exports = { definicoes, execucoes };
