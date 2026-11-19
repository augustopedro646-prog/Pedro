// O que o SheetJS não entrega e a planilha de sócios usa pra valer: a COR de
// preenchimento das células e o texto colorido dentro de uma mesma célula.
// Lê direto do XML interno do .xlsx (o SheetJS guarda os arquivos com bookFiles: true).
//
// Legenda da planilha (confirmada pelo Pedro com o pai dele, e conferida nas 403
// linhas ATPN: 303 verdes, 44 ciano, 17 laranja, 15 vermelho, 24 rosa):
//   coluna A de cada linha = situação do sócio
//     verde (sem atraso) ........ em dia           ("deve nenhum mês")
//     ciano (azul claro) ........ 1 ou 2 meses
//     laranja ................... 3 a 5 meses
//     vermelho .................. 6 meses ou mais
//     rosa ...................... desativado
//   célula de MÊS pintada de vermelho = mês em atraso (muitas trazem "Sem margem",
//     que é o desconto em folha que não passou — é atraso, não "situação especial")
//   nome em AZUL, embaixo do nome do sócio na mesma célula = dependente

const decodificar = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&#13;/g, '\r');

const conteudo = (wb, caminho) => {
  const e = wb.files && wb.files[caminho];
  if (!e) return null;
  const c = e.content;
  return Buffer.isBuffer(c) ? c.toString('utf8') : (typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
};

// azul de verdade (0000FF, 0309FD...): componente azul alto, vermelho e verde baixos
function ehAzul(rgb) {
  const m = /^(?:FF)?([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(rgb || '');
  if (!m) return false;
  const [r, g, b] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  return b >= 0xC0 && r <= 0x50 && g <= 0x50;
}

function classificarCorLinha(fill) {
  if (!fill) return null;
  if (/rgb="FF00FFFF"/i.test(fill)) return 'ciano';
  if (/rgb="FFFFC000"/i.test(fill)) return 'laranja';
  if (/rgb="FFFF0000"/i.test(fill)) return 'vermelho';
  if (/rgb="FFFF66FF"/i.test(fill)) return 'rosa';
  if (/theme="6"/.test(fill)) return 'verde';
  return null;
}

const STATUS_DA_COR = { verde: 'em_dia', ciano: 'ate_2_meses', laranja: '3_a_5_meses', vermelho: '6_meses_ou_mais', rosa: 'desligado' };

function criarLeitor(wb) {
  // textos compartilhados, com os trechos coloridos
  const sst = [];
  const sstXml = conteudo(wb, 'xl/sharedStrings.xml') || '';
  for (const m of sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const rs = [...m[1].matchAll(/<r>([\s\S]*?)<\/r>/g)];
    if (rs.length) {
      sst.push(rs.map((r) => ({
        texto: [...r[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodificar(x[1])).join(''),
        azul: ehAzul(((r[1].match(/<color [^>]*?rgb="([0-9A-Fa-f]{6,8})"/) || [])[1]) || ''),
      })));
    } else {
      sst.push([{ texto: [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodificar(x[1])).join(''), azul: false }]);
    }
  }

  // preenchimentos e estilos
  const st = conteudo(wb, 'xl/styles.xml') || '';
  const fillsXml = (st.match(/<fills[^>]*>([\s\S]*?)<\/fills>/) || [])[1] || '';
  const fills = [...fillsXml.matchAll(/<fill>([\s\S]*?)<\/fill>/g)].map((f) => {
    const fg = (f[1].match(/<fgColor ([^>]*?)\/?>/) || [])[1];
    return fg ? fg.replace(/\s+/g, ' ').trim() : '';
  });
  const xfsXml = (st.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/) || [])[1] || '';
  const xfs = [...xfsXml.matchAll(/<xf ([^>]*?)(\/>|>)/g)].map((x) => Number((x[1].match(/fillId="(\d+)"/) || [])[1] || 0));

  // nome da aba -> arquivo da planilha (pelo workbook.xml e pelos relacionamentos)
  const wbXml = conteudo(wb, 'xl/workbook.xml') || '';
  const relXml = conteudo(wb, 'xl/_rels/workbook.xml.rels') || '';
  const alvoPorId = new Map([...relXml.matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  alvoPorId.forEach((v, k) => { /* pode vir com Target antes do Id */ });
  for (const m of relXml.matchAll(/<Relationship [^>]*Target="([^"]+)"[^>]*Id="([^"]+)"/g)) if (!alvoPorId.has(m[2])) alvoPorId.set(m[2], m[1]);
  const arquivoDaAba = new Map();
  for (const m of wbXml.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const alvo = alvoPorId.get(m[2]);
    if (alvo) arquivoDaAba.set(decodificar(m[1]), `xl/${alvo.replace(/^\/?(xl\/)?/, '')}`);
  }

  // linhas de uma aba: { numeroDaLinha(1-based): { A: {fill}, C: {fill, linhas:[{texto, azul}]}, ... } }
  function lerAba(nomeDaAba) {
    const arq = arquivoDaAba.get(nomeDaAba);
    const xml = arq ? conteudo(wb, arq) : null;
    if (!xml) throw new Error(`Não achei o XML da aba "${nomeDaAba}" (cores/dependentes ficariam sem leitura)`);
    const linhas = new Map();
    for (const r of xml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const cel = {};
      for (const c of r[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[2];
        const s = Number((attrs.match(/ s="(\d+)"/) || [])[1] || 0);
        const t = (attrs.match(/ t="(\w+)"/) || [])[1];
        const v = ((c[4] || '').match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        const item = { fill: fills[xfs[s]] || '' };
        if (v !== undefined && t === 's') item.trechos = sst[Number(v)] || null;
        cel[c[1]] = item;
      }
      linhas.set(Number(r[1]), cel);
    }
    return linhas;
  }

  return { lerAba };
}

// Quebra o texto de uma célula em linhas, cada uma com a cor do começo dela.
// Devolve { titular, dependentes:[nomes em azul], notas:[outras linhas] }.
function separarNomes(trechos, textoSimples) {
  const base = trechos && trechos.length ? trechos : [{ texto: String(textoSimples || ''), azul: false }];
  const linhas = [];
  let atual = { texto: '', azul: null };
  for (const t of base) {
    const partes = t.texto.split(/\r?\n/);
    partes.forEach((p, i) => {
      if (i > 0) { linhas.push(atual); atual = { texto: '', azul: null }; }
      if (p.trim() && atual.azul === null) atual.azul = t.azul;
      atual.texto += p;
    });
  }
  linhas.push(atual);
  const limpa = (s) => s.replace(/^[\s(]+|[\s)]+$/g, '').replace(/\s+/g, ' ').trim();
  const ls = linhas.map((l) => ({ texto: limpa(l.texto), azul: !!l.azul })).filter((l) => l.texto);
  if (!ls.length) return { titular: '', dependentes: [], notas: [] };
  const titular = ls[0].texto;
  const dependentes = []; const notas = [];
  ls.slice(1).forEach((l) => (l.azul ? dependentes : notas).push(l.texto));
  return { titular, dependentes, notas };
}

module.exports = { criarLeitor, separarNomes, classificarCorLinha, STATUS_DA_COR, ehAzul };
