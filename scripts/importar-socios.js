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

// ehDesligamento/calcularStatusAtivo moraram aqui; agora ficam em
// server/statusSocio.js porque a baixa direta de mensalidade (recepção) usa a
// MESMA regra pra recalcular o status quando um pagamento é registrado.
const { ehDesligamento, calcularStatusAtivo, recalcularStatusSocio } = require('../server/statusSocio');
const { criarLeitor, separarNomes, classificarCorLinha, STATUS_DA_COR } = require('./lib/xlsx-extras');

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

function lerAba(wb, sheetName, origemPlanilha, extras) {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Aba "${sheetName}" não encontrada na planilha`);
  const xml = extras.lerAba(sheetName); // cores e texto colorido (linha do XML = linha do SheetJS + 1)
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

    const x = xml.get(r + 1) || {};
    const nomes = separarNomes(x.C && x.C.trechos, nome); // titular em cima; nomes em azul = dependentes
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
      const celula = x[XLSX.utils.encode_col(mc.col)];
      const emAberto = !!(celula && /rgb="FFFF0000"/i.test(celula.fill)); // célula do mês pintada de vermelho = atraso
      if ((v == null || v === '') && !emAberto) continue;
      if (typeof v === 'number') mensalidades.push({ ano: mc.ano, mes: mc.mes, valor: v, observacao: null, emAberto });
      else mensalidades.push({ ano: mc.ano, mes: mc.mes, valor: null, observacao: v == null || v === '' ? null : String(v).trim(), emAberto });
    }

    // Situação = COR da coluna A (legenda da planilha). Sem cor reconhecida, cai na regra antiga e avisa.
    let status; let situacaoEspecial = null; let motivo = null;
    const corLinha = classificarCorLinha(x.A && x.A.fill);
    if (origemPlanilha === 'desligados') {
      status = 'desligado';
      motivo = motivoDesligamento(mensalidades);
    } else if (corLinha) {
      status = STATUS_DA_COR[corLinha];
      if (status === 'desligado') motivo = motivoDesligamento(mensalidades);
    } else {
      ({ status, situacaoEspecial, motivo } = calcularStatusAtivo(mensalidades));
      avisos.push(`${origemPlanilha} linha ${r + 1} (${nomes.titular}): linha sem cor de situação reconhecida — usei a regra por valores`);
    }
    const ultima = mensalidades[mensalidades.length - 1];
    if (status !== 'desligado' && ultima && !ultima.emAberto && ultima.valor == null && ultima.observacao
        && !ehDesligamento(ultima.observacao) && /isent|abonad|inss|ausent/i.test(ultima.observacao)) {
      situacaoEspecial = ultima.observacao; // isento/abonado/INSS/ausente: informação, não atraso
    }
    const mesesEmAberto = mensalidades.filter((m) => m.emAberto).length;

    linhas.push({
      matricula, matriculaSecundaria, nome: nomes.titular || String(nome).trim(),
      dependentes: nomes.dependentes, nomeNota: nomes.notas.join(' · ') || null, mesesEmAberto, possivelDuplicado: false,
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
    // sem matrícula: casa por nome dentro do clube (o cadastro antigo pode ter os dois nomes na célula)
    const candidatos = await client.query('SELECT id, nome FROM socios WHERE matricula IS NULL AND clube = $1', [socio.clube]);
    const mesma = candidatos.rows.find((c) => mesmaPessoa(c.nome, socio.nome));
    existente = { rows: mesma ? [mesma] : [] };
  }

  const campos = [
    socio.matricula, socio.matriculaSecundaria, socio.nome, socio.cpf, socio.clube,
    socio.categoria, socio.categoriaOriginal, socio.diaVencimento, socio.telefone,
    socio.telefoneSecundario, socio.status, socio.situacaoEspecial, socio.motivoDesligamento,
    origemPlanilha, planilhaAtualizadaEm, socio.mesesEmAberto, socio.nomeNota, socio.possivelDuplicado,
  ];

  let socioId;
  if (existente.rows[0]) {
    socioId = existente.rows[0].id;
    await client.query(
      `UPDATE socios SET matricula=$1, matricula_secundaria=$2, nome=$3, cpf=$4, clube=$5, categoria=$6,
              categoria_original=$7, dia_vencimento=$8, telefone=$9, telefone_secundario=$10, status=$11,
              situacao_especial=$12, motivo_desligamento=$13, origem_planilha=$14, planilha_atualizada_em=$15,
              meses_em_aberto=$16, nome_nota=$17, possivel_duplicado=$18, importado_em = now()
       WHERE id = $19`,
      [...campos, socioId]
    );
    await client.query('DELETE FROM socios_mensalidades WHERE socio_id = $1', [socioId]);
  } else {
    const { rows } = await client.query(
      `INSERT INTO socios (matricula, matricula_secundaria, nome, cpf, clube, categoria, categoria_original,
              dia_vencimento, telefone, telefone_secundario, status, situacao_especial, motivo_desligamento,
              origem_planilha, planilha_atualizada_em, meses_em_aberto, nome_nota, possivel_duplicado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      campos
    );
    socioId = rows[0].id;
  }

  idsDestaRodada.add(socioId);
  for (const m of socio.mensalidades) {
    await client.query(
      'INSERT INTO socios_mensalidades (socio_id, ano, mes, valor, observacao, em_aberto) VALUES ($1,$2,$3,$4,$5,$6)',
      [socioId, m.ano, m.mes, m.valor, m.observacao, !!m.emAberto]
    );
  }

  // dependentes (nomes em azul): mantém os que já existem (presença registrada aponta pra eles),
  // cria os novos e tira só quem saiu da planilha E nunca teve presença registrada
  const atuais = (await client.query('SELECT id, nome FROM dependentes WHERE socio_id = $1', [socioId])).rows;
  const nomesNovos = new Set(socio.dependentes.map((n) => semAcento(n)));
  for (const d of atuais) {
    if (!nomesNovos.has(semAcento(d.nome))) {
      const usado = (await client.query('SELECT 1 FROM presencas WHERE dependente_id = $1 LIMIT 1', [d.id])).rowCount;
      if (!usado) await client.query('DELETE FROM dependentes WHERE id = $1', [d.id]);
    }
  }
  const jaTem = new Set(atuais.map((d) => semAcento(d.nome)));
  for (const nome of socio.dependentes) {
    if (!jaTem.has(semAcento(nome))) await client.query('INSERT INTO dependentes (socio_id, nome) VALUES ($1, $2)', [socioId, nome]);
  }
}

// Possível contagem em dobro: a mesma matrícula em pessoas DIFERENTES (ex.: o dependente
// tem linha própria além de aparecer em azul na linha do titular). Fica sinalizado.
function marcarPossiveisDuplicados(todas) {
  const porMatricula = new Map();
  todas.forEach((s) => { if (s.matricula) { if (!porMatricula.has(s.matricula)) porMatricula.set(s.matricula, []); porMatricula.get(s.matricula).push(s); } });
  let n = 0;
  for (const grupo of porMatricula.values()) {
    if (grupo.length < 2) continue;
    grupo.forEach((a) => {
      if (grupo.some((b) => b !== a && !mesmaPessoa(a.nome, b.nome))) { a.possivelDuplicado = true; n++; }
    });
  }
  return n;
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

  // bookFiles: o SheetJS guarda os XMLs internos, de onde saem as cores e o texto em azul
  const wb = XLSX.readFile(caminho, { cellDates: true, bookFiles: true });
  const extras = criarLeitor(wb);
  const { linhas: ativos, avisos: avisosAtivos } = lerAba(wb, 'ATIVO GERAL', 'ativo_geral', extras);
  const { linhas: desligados, avisos: avisosDesligados } = lerAba(wb, 'DESLIGADOS', 'desligados', extras);

  console.log(`Lidos: ${ativos.length} em ATIVO GERAL, ${desligados.length} em DESLIGADOS.`);
  [...avisosAtivos, ...avisosDesligados].forEach((a) => console.warn('  aviso:', a));
  const nDup = marcarPossiveisDuplicados([...ativos, ...desligados]);
  console.log(`Possível contagem em dobro (mesma matrícula em pessoas diferentes): ${nDup} linha(s) sinalizada(s).`);
  console.log(`Dependentes encontrados (nomes em azul): ${[...ativos, ...desligados].reduce((s, x) => s + x.dependentes.length, 0)}.`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // desligados primeiro, ativos por último: se por algum erro na planilha a
    // mesma matrícula aparecer nas duas abas, quem venceu foi "ativo" —
    // sinal mais forte de que a pessoa está mesmo frequentando hoje.
    for (const s of desligados) await salvarSocio(client, s, 'desligados', planilhaAtualizadaEm);
    for (const s of ativos) await salvarSocio(client, s, 'ativo_geral', planilhaAtualizadaEm);
    // sobras de importações antigas (linhas que esta rodada não tocou): só some quem não tem
    // presença nem pagamento registrado ligados — o resto fica, e é avisado
    const ids = [...idsDestaRodada];
    const sobras = (await client.query('SELECT id FROM socios WHERE NOT (id = ANY($1))', [ids])).rows.map((r) => r.id);
    let removidas = 0; let mantidas = 0;
    for (const id of sobras) {
      const ligado = (await client.query(
        `SELECT (SELECT count(*) FROM presencas WHERE socio_id = $1) + (SELECT count(*) FROM mensalidade_pagamentos WHERE socio_id = $1) AS n`, [id]
      )).rows[0].n;
      if (Number(ligado) > 0) { mantidas++; continue; }
      await client.query('DELETE FROM dependentes WHERE socio_id = $1', [id]);
      await client.query('DELETE FROM socios_mensalidades WHERE socio_id = $1', [id]);
      await client.query('DELETE FROM socios WHERE id = $1', [id]);
      removidas++;
    }
    if (sobras.length) console.log(`\nLinhas antigas que não estão mais na planilha: ${removidas} removida(s), ${mantidas} mantida(s) (têm presença/pagamento registrado).`);

    // pagamentos registrados na ATPN (baixa direta) valem por cima da planilha:
    // recalcula o status de quem tem pagamento, dentro da mesma transação
    const { rows: comPagamento } = await client.query(
      'SELECT DISTINCT socio_id FROM mensalidade_pagamentos WHERE cancelado_em IS NULL'
    );
    for (const { socio_id } of comPagamento) await recalcularStatusSocio(client, socio_id);
    if (comPagamento.length) console.log(`\nStatus recalculado considerando pagamentos registrados na ATPN: ${comPagamento.length} sócio(s).`);
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
