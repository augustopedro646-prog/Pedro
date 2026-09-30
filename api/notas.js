// Leitura de nota de compra (entrada de mercadoria): XML da NF-e, PDF (DANFE) ou foto(s).
// Nada aqui grava no banco — devolve um RASCUNHO que o Administrador confere na tela antes de
// confirmar (mesma regra do Jabá: a IA sugere, gente decide).
const { XMLParser } = require('fast-xml-parser');

const MODELO = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function num(v) { const n = Number(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) ? n : 0; }
function digitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
// EAN-13 "0789..." e UPC "789..." são a mesma etiqueta; "SEM GTIN" vira vazio.
function normalizarCodigo(v) { return digitos(v).replace(/^0+/, ''); }
function lista(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }

const UNIDADES_PECA = ['UN', 'UND', 'UNID', 'UNIDADE', 'PC', 'PÇ', 'PCS', 'PECA', 'PEÇA', 'PR', 'PAR', 'CJ', 'CONJ', 'KIT'];
function ehUnidadePeca(u) { return UNIDADES_PECA.includes(String(u || '').trim().toUpperCase()); }

/* ---------------- XML da NF-e ---------------- */

// Custo real de cada peça = o que a loja pagou naquela linha (produto − desconto + frete, seguro,
// outras despesas, IPI e ICMS-ST) dividido pelas peças. É esse custo que entra no custo médio.
function lerXmlNfe(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, removeNSPrefix: true });
  let doc;
  try { doc = parser.parse(xml); } catch (e) { throw new Error('Não consegui ler esse XML — confira se é o arquivo da nota (NF-e).'); }
  const nfe = (doc.nfeProc && doc.nfeProc.NFe) || doc.NFe;
  const inf = nfe && nfe.infNFe;
  if (!inf || !inf.det) throw new Error('Esse XML não parece ser uma NF-e (não achei os itens da nota).');

  const ide = inf.ide || {}, emit = inf.emit || {};
  const chave = digitos(inf['@Id']) || digitos(doc.nfeProc && doc.nfeProc.protNFe && doc.nfeProc.protNFe.infProt && doc.nfeProc.protNFe.infProt.chNFe);
  const dataEmissao = String(ide.dhEmi || ide.dEmi || '').slice(0, 10);

  const itens = lista(inf.det).map((det) => {
    const p = det.prod || {};
    const imp = det.imposto || {};
    const ipi = imp.IPI && imp.IPI.IPITrib ? num(imp.IPI.IPITrib.vIPI) : 0;
    let st = 0;
    if (imp.ICMS) for (const grupo of Object.values(imp.ICMS)) if (grupo && typeof grupo === 'object') st += num(grupo.vICMSST);
    const valorLinha = num(p.vProd) - num(p.vDesc) + num(p.vFrete) + num(p.vSeg) + num(p.vOutro) + ipi + st;

    // Quantidade em peças: usa a unidade comercial se for peça; senão a tributável; senão avisa.
    let qtd = num(p.qCom), unidade = String(p.uCom || '').trim(), aviso = null;
    if (!ehUnidadePeca(unidade) && ehUnidadePeca(p.uTrib)) { qtd = num(p.qTrib); unidade = String(p.uTrib).trim(); }
    else if (/^(DZ|DUZIA|DÚZIA)$/i.test(unidade)) { qtd = qtd * 12; unidade = 'UN'; aviso = 'Nota em dúzias — convertido pra peças'; }
    else if (!ehUnidadePeca(unidade)) aviso = 'Unidade "' + unidade + '" na nota — confira a quantidade de peças';
    if (!Number.isInteger(qtd)) { aviso = 'Quantidade fracionada (' + qtd + ') — confira'; qtd = Math.max(1, Math.round(qtd)); }

    const ean = [p.cEAN, p.cEANTrib].map(normalizarCodigo).find((c) => c.length >= 8) || '';
    return {
      descricao: String(p.xProd || '').trim(),
      codigoFornecedor: String(p.cProd || '').trim(),
      ean,
      ncm: digitos(p.NCM),
      qtd,
      custoUnitario: qtd > 0 ? round2(valorLinha / qtd) : 0,
      unidade,
      aviso,
    };
  });

  return {
    origem: 'xml',
    fornecedor: { nome: String(emit.xFant || emit.xNome || '').trim(), razaoSocial: String(emit.xNome || '').trim(), cnpj: digitos(emit.CNPJ || emit.CPF) },
    numeroNota: String(ide.nNF || '').trim(),
    chave: chave.length === 44 ? chave : null,
    data: /^\d{4}-\d{2}-\d{2}$/.test(dataEmissao) ? dataEmissao : null,
    total: inf.total && inf.total.ICMSTot ? num(inf.total.ICMSTot.vNF) : round2(itens.reduce((s, i) => s + i.qtd * i.custoUnitario, 0)),
    itens,
  };
}

/* ---------------- Claude: PDF e fotos ---------------- */

// Structured outputs: toda propriedade obrigatória e sem campos extras; "não sei" vira null.
function ou(tipo, description) { return { anyOf: [description ? { type: tipo, description } : { type: tipo }, { type: 'null' }] }; }
const SCHEMA_NOTA = {
  type: 'object',
  additionalProperties: false,
  required: ['fornecedorNome', 'fornecedorCnpj', 'numeroNota', 'chave', 'dataEmissao', 'totalNota', 'itens'],
  properties: {
    fornecedorNome: ou('string'),
    fornecedorCnpj: ou('string', 'só números'),
    numeroNota: ou('string'),
    chave: ou('string', 'chave de acesso de 44 dígitos, só números, se aparecer'),
    dataEmissao: ou('string', 'AAAA-MM-DD'),
    totalNota: ou('number'),
    itens: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['descricao', 'codigoFornecedor', 'ean', 'qtd', 'custoUnitario', 'aviso'],
        properties: {
          descricao: { type: 'string', description: 'texto do item exatamente como está na nota' },
          codigoFornecedor: ou('string', 'código/referência do produto na nota'),
          ean: ou('string', 'código de barras (GTIN/EAN) se aparecer, só números'),
          qtd: { type: 'integer', description: 'quantidade em PEÇAS (dúzia vira 12, caixa com N peças vira N)' },
          custoUnitario: { type: 'number', description: 'valor pago por peça, já com desconto e IPI da linha se houver' },
          aviso: ou('string', 'o que ficou ilegível ou duvidoso nessa linha'),
        },
      },
    },
  },
};

const SISTEMA_EXTRACAO = `Você lê notas fiscais de compra (DANFE em PDF ou foto) de uma loja de roupas infantis no Brasil e extrai o cabeçalho e cada item comprado.
- Uma linha por item da nota, na ordem da nota. Ignore totais, impostos resumidos, dados de transporte e observações.
- qtd é sempre em peças inteiras. Se a unidade for dúzia (DZ), multiplique por 12; se for caixa/pacote com quantidade indicada, multiplique.
- custoUnitario é o valor por peça: valor total da linha (com desconto e IPI daquela linha, se a nota mostrar) dividido pelas peças.
- Se algo estiver ilegível ou você não tiver certeza, preencha com o melhor palpite e explique em "aviso". Nunca invente item que não está na nota.
- Várias imagens podem ser páginas da MESMA nota: junte tudo numa resposta só.`;

// Opus 5.5 pode recusar por política: com fallbacks "default" a própria API tenta de novo em outro
// modelo. Se ainda assim recusar, ou a resposta cortar, avisa em vez de devolver meia nota.
async function chamarClaude(anthropic, { system, content, schema, maxTokens }) {
  const resposta = await anthropic.beta.messages.create({
    model: MODELO,
    max_tokens: maxTokens || 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content }],
  });
  if (resposta.stop_reason === 'refusal') throw new Error('A IA não conseguiu ler esse arquivo. Tente outra foto ou lance a nota na mão.');
  if (resposta.stop_reason === 'max_tokens') throw new Error('A nota é grande demais pra ler de uma vez — envie em partes (menos páginas por vez).');
  const texto = resposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(texto); } catch (e) { throw new Error('A IA respondeu num formato inesperado — tente de novo.'); }
}

async function lerNotaComIA(anthropic, arquivos) {
  const content = arquivos.map((a) => a.mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.base64 } }
    : { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.base64 } });
  content.push({ type: 'text', text: 'Extraia o cabeçalho e os itens desta nota de compra.' });
  const r = await chamarClaude(anthropic, { system: SISTEMA_EXTRACAO, content, schema: SCHEMA_NOTA });
  const chave = digitos(r.chave);
  const data = /^\d{4}-\d{2}-\d{2}$/.test(r.dataEmissao || '') ? r.dataEmissao : null;
  return {
    origem: arquivos.some((a) => a.mediaType === 'application/pdf') ? 'pdf' : 'foto',
    fornecedor: { nome: (r.fornecedorNome || '').trim(), razaoSocial: (r.fornecedorNome || '').trim(), cnpj: digitos(r.fornecedorCnpj) },
    numeroNota: (r.numeroNota || '').replace(/\s/g, ''),
    chave: chave.length === 44 ? chave : null,
    data,
    total: r.totalNota != null ? round2(num(r.totalNota)) : null,
    itens: (r.itens || []).map((i) => ({
      descricao: String(i.descricao || '').trim(),
      codigoFornecedor: String(i.codigoFornecedor || '').trim(),
      ean: normalizarCodigo(i.ean).length >= 8 ? normalizarCodigo(i.ean) : '',
      ncm: '',
      qtd: Math.max(1, Math.round(num(i.qtd))),
      custoUnitario: round2(Math.max(0, num(i.custoUnitario))),
      unidade: 'UN',
      aviso: i.aviso || null,
    })),
  };
}

/* ---------------- Casar cada item com uma peça do estoque ---------------- */

const SCHEMA_CASAMENTO = {
  type: 'object',
  additionalProperties: false,
  required: ['itens'],
  properties: {
    itens: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['indice', 'variacaoId', 'novoProduto', 'categoria', 'tamanho', 'cor'],
        properties: {
          indice: { type: 'integer' },
          variacaoId: ou('string', 'id de uma variação da lista, só se for claramente a mesma peça (mesmo produto, tamanho e cor)'),
          novoProduto: ou('string', 'nome do produto SEM tamanho e SEM cor, quando não existir no estoque. Itens que são o mesmo modelo em tamanhos/cores diferentes usam exatamente o mesmo nome.'),
          categoria: ou('string'),
          tamanho: ou('string'),
          cor: ou('string'),
        },
      },
    },
  },
};

const SISTEMA_CASAMENTO = `Você ajuda uma loja de roupas infantis a dar entrada numa nota de fornecedor. Cada item da nota é uma peça de um tamanho e uma cor.
Pra cada item recebido, decida:
- se já existe no estoque: devolva o variacaoId da lista (mesmo produto, mesmo tamanho e mesma cor — marca/abreviação diferentes contam como o mesmo produto se for claramente a mesma peça);
- se não existe: variacaoId null e sugira novoProduto (nome curto, sem tamanho, sem cor, sem código, com a primeira letra de cada palavra maiúscula), categoria (ex.: Vestidos, Blusas, Conjuntos, Bermudas, Calças, Macacões, Bodies, Pijamas, Acessórios), tamanho e cor, lendo a descrição da nota. Se for um produto existente só que em tamanho/cor que ainda não tem, use o MESMO nome do produto existente em novoProduto.
Tamanhos de roupa infantil costumam ser RN, P, M, G, GG, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16 (na nota podem vir como "T4", "TAM 4", "04"). Escreva a cor por extenso com a primeira letra maiúscula (ex.: "ROSA BB" → "Rosa Bebê"). Se não houver cor na descrição, use "Única".
Responda um objeto por item recebido, com o mesmo indice.`;

// Ordem de confiança: código de barras → código do fornecedor já aprendido em notas anteriores → IA.
async function sugerirCasamentos(db, anthropic, lojaId, rascunho) {
  const { rows: variacoes } = await db.query(
    `SELECT v.id, v.tamanho, v.cor, v.codigo_barras, p.id AS produto_id, p.nome AS produto, p.categoria
       FROM produto_variacoes v JOIN produtos p ON p.id = v.produto_id
      WHERE v.loja_id = $1`, [lojaId]);
  const porCodigo = new Map();
  for (const v of variacoes) if (v.codigo_barras) porCodigo.set(normalizarCodigo(v.codigo_barras), v);

  let aprendidos = new Map();
  const forn = await acharFornecedor(db, lojaId, rascunho.fornecedor);
  if (forn) {
    const { rows } = await db.query('SELECT codigo, variacao_id FROM fornecedor_codigos WHERE loja_id = $1 AND fornecedor_id = $2', [lojaId, forn.id]);
    aprendidos = new Map(rows.map((r) => [r.codigo, r.variacao_id]));
  }
  const porId = new Map(variacoes.map((v) => [v.id, v]));

  const pendentes = [];
  rascunho.itens.forEach((item, indice) => {
    let v = item.ean ? porCodigo.get(item.ean) : null;
    let como = v ? 'codigo_barras' : null;
    if (!v && item.codigoFornecedor && aprendidos.has(item.codigoFornecedor)) { v = porId.get(aprendidos.get(item.codigoFornecedor)); como = v ? 'codigo_fornecedor' : null; }
    item.sugestao = v ? { tipo: 'existente', variacaoId: v.id, como } : null;
    if (!v) pendentes.push(indice);
  });

  if (pendentes.length && anthropic) {
    const catalogo = variacoes.map((v) => [v.id, v.produto, v.categoria || '', v.tamanho, v.cor].join(' | ')).join('\n') || '(estoque ainda vazio)';
    const itensTexto = pendentes.map((i) => `${i}: ${rascunho.itens[i].descricao}${rascunho.itens[i].codigoFornecedor ? ' (ref ' + rascunho.itens[i].codigoFornecedor + ')' : ''}`).join('\n');
    try {
      const r = await chamarClaude(anthropic, {
        system: SISTEMA_CASAMENTO,
        content: [{ type: 'text', text: `Estoque atual (id | produto | categoria | tamanho | cor):\n${catalogo}\n\nItens da nota (indice: descrição):\n${itensTexto}` }],
        schema: SCHEMA_CASAMENTO,
      });
      for (const s of r.itens || []) {
        const item = rascunho.itens[s.indice];
        if (!item || item.sugestao || !pendentes.includes(s.indice)) continue;
        if (s.variacaoId && porId.has(s.variacaoId)) item.sugestao = { tipo: 'existente', variacaoId: s.variacaoId, como: 'ia' };
        else if (s.novoProduto) {
          const existente = variacoes.find((v) => v.produto.toLowerCase() === s.novoProduto.trim().toLowerCase());
          item.sugestao = { tipo: 'novo', nome: existente ? existente.produto : s.novoProduto.trim(), produtoId: existente ? existente.produto_id : null,
            categoria: s.categoria || (existente && existente.categoria) || '', tamanho: (s.tamanho || '').trim(), cor: (s.cor || 'Única').trim() };
        }
      }
    } catch (e) {
      rascunho.avisoCasamento = 'Não consegui sugerir as peças automaticamente (' + e.message + '). Escolha cada uma na lista.';
    }
  }
  return rascunho;
}

async function acharFornecedor(db, lojaId, f) {
  if (!f) return null;
  if (f.cnpj) {
    const { rows } = await db.query('SELECT id, nome FROM fornecedores WHERE loja_id = $1 AND cnpj = $2', [lojaId, f.cnpj]);
    if (rows.length) return rows[0];
  }
  for (const nome of [f.nome, f.razaoSocial].filter(Boolean)) {
    const { rows } = await db.query('SELECT id, nome FROM fornecedores WHERE loja_id = $1 AND lower(nome) = lower($2)', [lojaId, nome]);
    if (rows.length) return rows[0];
  }
  return null;
}

// Mesma nota lançada duas vezes dobraria o estoque: procura pela chave ou por fornecedor + número.
async function acharCompraRepetida(db, lojaId, rascunho) {
  if (rascunho.chave) {
    const { rows } = await db.query('SELECT id, data FROM compras WHERE loja_id = $1 AND chave_nfe = $2', [lojaId, rascunho.chave]);
    if (rows.length) return rows[0];
  }
  const forn = await acharFornecedor(db, lojaId, rascunho.fornecedor);
  if (forn && rascunho.numeroNota) {
    const { rows } = await db.query('SELECT id, data FROM compras WHERE loja_id = $1 AND fornecedor_id = $2 AND numero_nota = $3', [lojaId, forn.id, rascunho.numeroNota]);
    if (rows.length) return rows[0];
  }
  return null;
}

module.exports = { lerXmlNfe, lerNotaComIA, sugerirCasamentos, acharFornecedor, acharCompraRepetida, normalizarCodigo };
