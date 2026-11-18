// Importa a planilha real de sócios (abas "ATIVO GERAL" e "DESLIGADOS") pro
// banco. Uso: node scripts/importar-socios.js "caminho/da/planilha.xlsx"
//
// Reimportável: cada rodada é um snapshot novo — casa com um sócio já
// existente por matrícula (ou por nome+clube quando não tem matrícula) e
// substitui o cadastro e o histórico mensal dele. Não é incremental.
//
// Achados reais da planilha (ver comentário maior em db/schema.sql):
// não existe sócio "só ATPN" (todo mundo é CEPE, uma parte com ATPN de
// parceria); a matrícula dupla é sistema antigo+novo da mesma pessoa; não
// há dependente nos dados; e o "status" é calculado do histórico mensal de
// pagamento, replicando os buckets que a própria planilha já resume no
// rodapé (EM DIA / ATÉ 2 MESES / 3 A 5 MESES / 6 MESES OU MAIS / DESLIGADO).
require('dotenv').config();
const XLSX = require('xlsx');
const { pool } = require('../server/db');

const MESES_PT = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };

// Código -> nome da categoria legada (coluna F numérica, só na aba
// DESLIGADOS). Tirado do rodapé "CATEG." da própria planilha. O código 2
// está duplicado na fonte original (usado tanto pra "Sócio Efetivo
// Aposentado CEPE" quanto "Sócio contribuinte CEPE") — ficamos com o mais
// específico; se isso importar pra alguma conferência, vale checar à mão.
const LEGENDA_CATEGORIA = {
  1: 'Sócio Efetivo Petrobras CEPE', 2: 'Sócio contribuinte CEPE', 4: 'Sócio fundador',
  5: 'Sócio Benemérito', 6: 'Não sócio/Aluno', 7: 'Funcionário', 8: 'Aluno Coeduc',
  9: 'Aluno Escola Vida', 10: 'Sócio aposentado CEPE', 11: 'Dependente Provisório',
  12: 'Desligado/Inativo', 13: 'Convidados', 14: 'Alunos Gerais', 15: 'Sócio Contribuinte/família',
  16: 'Supervisor', 17: 'Portaria-Livre', 18: 'Gerência', 19: 'Diretor de dia', 20: 'Portaria-Pago',
  21: 'Aluno Tereza de Lisieux', 22: 'Arrendatário', 23: 'Clientes', 24: 'Contribuinte / Prática',
  25: 'Cont. C. Saúde Natal', 26: 'Aluno Itaece', 27: 'Aluno PHD', 28: 'Contribuinte / TV Cabugi',
  29: 'Colégio Link', 30: 'Aluno CAP', 31: 'Cepe / ATPN', 32: 'Aluno Objetivo', 33: 'Eventos e promoções',
  34: 'Cont. Metal Super', 35: 'Atletas', 36: 'Contribuinte/ATPN', 37: 'Aposentado/ATPN',
  39: 'SóciosNãoIdentificados', 40: 'ARRENDATÁRIO', 41: 'Convidados outro Cepe', 42: 'Contribuinte/Prest.',
  43: 'Socio INFRAERO', 44: 'Liquigás', 45: 'Cont. Policia Rodoviaria', 46: 'Sócio Amigo', 48: 'Sócio provisório',
  49: 'Aluno provisório', 50: 'Sócio Cont/Atleta FutMesa', 51: 'Contribuinte / SISJERN',
  52: 'Contribuinte ASTRA - 21', 53: 'Contribuinte AMILCI-RN', 54: 'SóciosCont. AOJERN',
  55: 'Soc. Contr. SINTRAJURN', 56: 'Alunos_Musculação', 57: 'Alunos_Natação', 58: 'Alunos_Hidroginástica',
  59: 'Alunos_Voley', 60: 'Alunos Futebol Campo', 61: 'Alunos Nova Visão', 62: 'Sócio Efetivo Transpetro',
  63: 'Sóc. Efetivo BR Distribui', 64: 'Socio Assesp/RN', 65: 'Karate', 66: 'Sócio Amigo/ATPN',
  67: 'Transpetro/ATPN', 68: 'AlunoEspera', 69: 'Jovem Aprendiz', 70: 'Nao Socio/peladeiros',
  71: 'Sócio Cont. Individual',
};

function parseMesAno(header) {
  if (header instanceof Date) return { ano: header.getFullYear(), mes: header.getMonth() + 1 };
  if (typeof header === 'string') {
    const m = header.trim().toLowerCase().match(/^([a-zç]{3})\.?-?(\d{2,4})$/);
    if (m && MESES_PT[m[1]]) {
      let ano = parseInt(m[2], 10);
      if (ano < 100) ano += 2000;
      return { ano, mes: MESES_PT[m[1]] };
    }
  }
  return null;
}

// Separa "123\n456" em [primeiro, segundo]; "???" (placeholder de número
// desconhecido na planilha) vira null.
function primeiraSegunda(valor) {
  if (valor == null) return [null, null];
  const partes = String(valor).split('\n').map((s) => s.trim()).filter(Boolean);
  const limpa = (s) => (s && s !== '???' ? s : null);
  return [limpa(partes[0]), limpa(partes[1])];
}

function normalizarClube(valor) {
  return String(valor || '').trim().toUpperCase() === 'CEPE-ATPN' ? 'cepe_atpn' : 'cepe';
}

function normalizarCategoriaTexto(valor) {
  const v = String(valor || '').trim().toUpperCase();
  if (v === 'EFETIVO') return 'efetivo';
  if (v.startsWith('CONTRI')) return 'contribuinte';
  return null;
}

function categoriaDoNomeLegado(nome) {
  if (!nome) return null;
  const n = nome.toLowerCase();
  if (n.includes('contribuinte') || n.includes('contri')) return 'contribuinte';
  if (n.includes('efetivo') || n.includes('aposentado') || n.includes('fundador') || n.includes('benemérito') || n.includes('amigo')) return 'efetivo';
  return null; // aluno/funcionário/portaria/etc não é categoria de sócio — deixa null de propósito
}

// Status da aba ATIVO GERAL: olha o mês mais recente preenchido. Texto
// "DESLIGADO..." vira desligado; outro texto (ABONADO, ISENTO, Sem margem,
// INSS, AUSENTE...) é uma situação especial, não atraso; valor numérico
// conta quantos meses seguidos (voltando) vieram exatamente 0 e aplica o
// mesmo corte que a planilha já usa no resumo (até 2 / 3 a 5 / 6 ou mais).
// A planilha é digitada à mão: "DESLIGADO", "DESLIGAMENTO - ...", e também
// erros como "desligaod", "desigado", "desliagdo". Tudo que começa com
// "desl"/"desig" é desligamento; sem isso essas pessoas ficavam como ativas.
function ehDesligamento(texto) {
  return /^(desl|desig)/i.test(String(texto || '').trim());
}

function calcularStatusAtivo(mensalidades) {
  if (!mensalidades.length) return { status: 'em_dia', situacaoEspecial: null, motivo: null };
  const ultimo = mensalidades[mensalidades.length - 1];
  const obsUltimo = (ultimo.observacao || '').trim();
  if (ehDesligamento(obsUltimo)) return { status: 'desligado', situacaoEspecial: null, motivo: obsUltimo };
  if (obsUltimo && ultimo.valor == null) return { status: 'em_dia', situacaoEspecial: obsUltimo, motivo: null };

  let mesesSemPagamento = 0;
  for (let i = mensalidades.length - 1; i >= 0; i--) {
    if (mensalidades[i].valor === 0) mesesSemPagamento++;
    else break;
  }
  if (mesesSemPagamento === 0) return { status: 'em_dia', situacaoEspecial: null, motivo: null };
  if (mesesSemPagamento <= 2) return { status: 'ate_2_meses', situacaoEspecial: null, motivo: null };
  if (mesesSemPagamento <= 5) return { status: '3_a_5_meses', situacaoEspecial: null, motivo: null };
  return { status: '6_meses_ou_mais', situacaoEspecial: null, motivo: null };
}

// Motivo de quem já está na aba DESLIGADOS: o primeiro "DESLIGADO..." no
// histórico (ordem cronológica) é o evento real; o resto depois disso é só
// preenchimento (traço, repetição). Sem nenhum, cai pro último texto não
// vazio/"-" como melhor esforço.
function motivoDesligamento(mensalidades) {
  for (const m of mensalidades) {
    if (m.observacao && ehDesligamento(m.observacao)) return m.observacao.trim();
  }
  for (let i = mensalidades.length - 1; i >= 0; i--) {
    const obs = (mensalidades[i].observacao || '').trim();
    if (obs && obs !== '-') return obs;
  }
  return null;
}

function lerAba(wb, sheetName, origemPlanilha) {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Aba "${sheetName}" não encontrada na planilha`);
  const range = XLSX.utils.decode_range(ws['!ref']);
  const linhaCabecalhoMeses = 4; // linha 5 (0-based)
  const linhaInicioDados = 6; // linha 7 (0-based)

  const mesesCols = [];
  for (let c = 8; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: linhaCabecalhoMeses, c })];
    const parsed = cell ? parseMesAno(cell.v) : null;
    if (parsed) mesesCols.push({ col: c, ...parsed });
  }

  const linhas = [];
  const avisos = [];
  for (let r = linhaInicioDados; r <= range.e.r; r++) {
    const getCell = (c) => { const cell = ws[XLSX.utils.encode_cell({ r, c })]; return cell ? cell.v : null; };
    const matriculaRaw = getCell(1);
    const nome = getCell(2);
    if (matriculaRaw != null && String(matriculaRaw).trim().toUpperCase() === 'TOTAIS') break;
    if (!nome || !String(nome).trim()) continue;

    const [matricula, matriculaSecundaria] = primeiraSegunda(matriculaRaw);
    const cpfRaw = getCell(3);
    const clubeRaw = getCell(4);
    const categoriaRaw = getCell(5);
    const vencimentoRaw = getCell(6);
    const [telefone, telefoneSecundario] = primeiraSegunda(getCell(7));

    let clube; let categoria; let categoriaOriginal;
    const categoriaEhCodigo = typeof categoriaRaw === 'number' || (typeof categoriaRaw === 'string' && /^\d+$/.test(categoriaRaw.trim()));
    if (categoriaEhCodigo) {
      const codigo = Number(categoriaRaw);
      const nomeLegado = LEGENDA_CATEGORIA[codigo] || null;
      categoriaOriginal = nomeLegado ? `${codigo} - ${nomeLegado}` : String(categoriaRaw);
      categoria = categoriaDoNomeLegado(nomeLegado);
      clube = nomeLegado && nomeLegado.toUpperCase().includes('ATPN') ? 'cepe_atpn' : normalizarClube(clubeRaw);
      if (!nomeLegado) avisos.push(`${origemPlanilha} linha ${r + 1} (${nome}): código de categoria ${codigo} sem legenda conhecida`);
    } else {
      categoria = normalizarCategoriaTexto(categoriaRaw);
      categoriaOriginal = categoriaRaw != null ? String(categoriaRaw).trim() : null;
      clube = normalizarClube(clubeRaw);
    }

    const mensalidades = [];
    for (const mc of mesesCols) {
      const v = getCell(mc.col);
      if (v == null || v === '') continue;
      if (typeof v === 'number') mensalidades.push({ ano: mc.ano, mes: mc.mes, valor: v, observacao: null });
      else mensalidades.push({ ano: mc.ano, mes: mc.mes, valor: null, observacao: String(v).trim() });
    }

    let status; let situacaoEspecial; let motivo;
    if (origemPlanilha === 'desligados') {
      status = 'desligado';
      situacaoEspecial = null;
      motivo = motivoDesligamento(mensalidades);
    } else {
      ({ status, situacaoEspecial, motivo } = calcularStatusAtivo(mensalidades));
    }

    linhas.push({
      matricula, matriculaSecundaria, nome: String(nome).trim(),
      cpf: cpfRaw ? String(cpfRaw).trim() : null,
      clube, categoria, categoriaOriginal,
      diaVencimento: typeof vencimentoRaw === 'number' ? vencimentoRaw : null,
      telefone, telefoneSecundario, status, situacaoEspecial,
      motivoDesligamento: motivo, mensalidades,
    });
  }
  return { linhas, avisos };
}

// A célula de nome às vezes traz mais de uma pessoa ("Titular\n(Outra pessoa)")
// e a mesma matrícula aparece em linhas de pessoas DIFERENTES (família, erro de
// digitação). Matrícula igual sozinha não prova que é a mesma pessoa: só
// tratamos como a mesma se algum nome da célula também bate (igual, ou mesmo
// primeiro e último nome, ignorando acento/caixa). Antes, matrícula igual
// fundia as duas e uma pessoa sumia da lista, junto com as mensalidades dela.
const semAcento = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function nomesDaCelula(valor) {
  return String(valor).split('\n')
    .map((n) => semAcento(n).replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
function mesmaPessoa(a, b) {
  const na = nomesDaCelula(a);
  const nb = nomesDaCelula(b);
  return na.some((x) => nb.some((y) => {
    if (x === y) return true;
    const px = x.split(' ');
    const py = y.split(' ');
    return px.length > 1 && py.length > 1 && px[0] === py[0] && px[px.length - 1] === py[py.length - 1];
  }));
}

const duplicadasNaPlanilha = [];
const idsDestaRodada = new Set();

async function salvarSocio(client, socio, origemPlanilha, planilhaAtualizadaEm) {
  let existente;
  if (socio.matricula) {
    const candidatos = await client.query('SELECT id, nome FROM socios WHERE matricula = $1', [socio.matricula]);
    const mesma = candidatos.rows.find((c) => mesmaPessoa(c.nome, socio.nome));
    existente = { rows: mesma ? [mesma] : [] };
    // só conta como repetição se o registro foi gravado NESTA rodada (os de
    // rodadas anteriores são a reimportação normal, não duplicata)
    if (mesma && idsDestaRodada.has(mesma.id)) duplicadasNaPlanilha.push(`matrícula ${socio.matricula}: "${socio.nome.replace(/\n/g, ' ')}" aparece mais de uma vez (a última linha lida prevalece)`);
  } else {
    existente = await client.query('SELECT id FROM socios WHERE nome = $1 AND clube = $2 AND matricula IS NULL', [socio.nome, socio.clube]);
  }

  const campos = [
    socio.matricula, socio.matriculaSecundaria, socio.nome, socio.cpf, socio.clube,
    socio.categoria, socio.categoriaOriginal, socio.diaVencimento, socio.telefone,
    socio.telefoneSecundario, socio.status, socio.situacaoEspecial, socio.motivoDesligamento,
    origemPlanilha, planilhaAtualizadaEm,
  ];

  let socioId;
  if (existente.rows[0]) {
    socioId = existente.rows[0].id;
    await client.query(
      `UPDATE socios SET matricula=$1, matricula_secundaria=$2, nome=$3, cpf=$4, clube=$5, categoria=$6,
              categoria_original=$7, dia_vencimento=$8, telefone=$9, telefone_secundario=$10, status=$11,
              situacao_especial=$12, motivo_desligamento=$13, origem_planilha=$14, planilha_atualizada_em=$15,
              importado_em = now()
       WHERE id = $16`,
      [...campos, socioId]
    );
    await client.query('DELETE FROM socios_mensalidades WHERE socio_id = $1', [socioId]);
  } else {
    const { rows } = await client.query(
      `INSERT INTO socios (matricula, matricula_secundaria, nome, cpf, clube, categoria, categoria_original,
              dia_vencimento, telefone, telefone_secundario, status, situacao_especial, motivo_desligamento,
              origem_planilha, planilha_atualizada_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      campos
    );
    socioId = rows[0].id;
  }

  idsDestaRodada.add(socioId);
  for (const m of socio.mensalidades) {
    await client.query(
      'INSERT INTO socios_mensalidades (socio_id, ano, mes, valor, observacao) VALUES ($1,$2,$3,$4,$5)',
      [socioId, m.ano, m.mes, m.valor, m.observacao]
    );
  }
}

async function main() {
  const caminho = process.argv[2];
  if (!caminho) {
    console.error('Uso: node scripts/importar-socios.js "caminho/da/planilha.xlsx" [AAAA-MM-DD]');
    console.error('O segundo argumento (opcional) é a data em que essa planilha foi atualizada;');
    console.error('sem ele, usa a data de hoje.');
    process.exit(1);
  }
  const planilhaAtualizadaEm = process.argv[3] || new Date().toISOString().slice(0, 10);

  const wb = XLSX.readFile(caminho, { cellDates: true });
  const { linhas: ativos, avisos: avisosAtivos } = lerAba(wb, 'ATIVO GERAL', 'ativo_geral');
  const { linhas: desligados, avisos: avisosDesligados } = lerAba(wb, 'DESLIGADOS', 'desligados');

  console.log(`Lidos: ${ativos.length} em ATIVO GERAL, ${desligados.length} em DESLIGADOS.`);
  [...avisosAtivos, ...avisosDesligados].forEach((a) => console.warn('  aviso:', a));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // desligados primeiro, ativos por último: se por algum erro na planilha a
    // mesma matrícula aparecer nas duas abas, quem venceu foi "ativo" —
    // sinal mais forte de que a pessoa está mesmo frequentando hoje.
    for (const s of desligados) await salvarSocio(client, s, 'desligados', planilhaAtualizadaEm);
    for (const s of ativos) await salvarSocio(client, s, 'ativo_geral', planilhaAtualizadaEm);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (duplicadasNaPlanilha.length) {
    console.log(`\n${duplicadasNaPlanilha.length} linha(s) da planilha repetem uma pessoa já lida (mesma matrícula e nome; inclui quem aparece em DESLIGADOS e depois em ATIVO). Fica uma só:`);
    duplicadasNaPlanilha.slice(0, 15).forEach((d) => console.log('  ', d));
  }

  const resumo = await pool.query(
    `SELECT clube, status, count(*) FROM socios GROUP BY clube, status ORDER BY clube, status`
  );
  console.log('\nResumo depois da importação:');
  resumo.rows.forEach((r) => console.log(`  ${r.clube} / ${r.status}: ${r.count}`));

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
