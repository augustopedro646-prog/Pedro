// Frete pelo CEP pra mandar pedido pra outras cidades (Correios, Jadlog... via Melhor Envio) e
// endereço preenchido sozinho pelo CEP (ViaCEP, gratuito).
//
// Precisa no api/.env (melhorenvio.com.br → Integrações → Permissões de acesso → Gerar token):
//   MELHORENVIO_TOKEN=...
//   MELHORENVIO_AMBIENTE=producao     (ou sandbox, pra testar com a conta de testes)
//   MELHORENVIO_EMAIL=email@da-loja    (o Melhor Envio pede um contato técnico em cada chamada)
// E na tela (Equipe → Configurações da loja → Envio pelos Correios): CEP de onde sai e o peso/
// tamanho médio de uma peça embalada.
//
// O preço do frete SEMPRE é recalculado no servidor na hora do pedido (o do navegador não vale).
// A etiqueta continua sendo comprada no site do Melhor Envio (com o endereço que aparece no pedido).

class ErroFrete extends Error {
  constructor(msg, status) { super(msg); this.status = status || 502; }
}

const PADRAO = {
  ativo: false, cepOrigem: '', pesoPecaG: 300, alturaCm: 4, larguraCm: 20, comprimentoCm: 25,
  diasManuseio: 1, freteGratisAcima: 0, entregaLocalCidades: '',
};

function inteiro(v, p, min, max) { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : p; }
function mesclarConfig(s) {
  s = s && typeof s === 'object' ? s : {};
  const cep = String(s.cepOrigem || '').replace(/\D/g, '');
  const gratis = Number(s.freteGratisAcima);
  return {
    ativo: s.ativo === true, cepOrigem: cep.length === 8 ? cep : '',
    pesoPecaG: inteiro(s.pesoPecaG, PADRAO.pesoPecaG, 10, 30000), alturaCm: inteiro(s.alturaCm, PADRAO.alturaCm, 1, 100),
    larguraCm: inteiro(s.larguraCm, PADRAO.larguraCm, 1, 100), comprimentoCm: inteiro(s.comprimentoCm, PADRAO.comprimentoCm, 1, 100),
    diasManuseio: inteiro(s.diasManuseio, PADRAO.diasManuseio, 0, 30),
    freteGratisAcima: Number.isFinite(gratis) && gratis >= 0 && gratis <= 100000 ? gratis : 0,
    entregaLocalCidades: typeof s.entregaLocalCidades === 'string' ? s.entregaLocalCidades.slice(0, 300) : '',
  };
}

function configurado() { return !!process.env.MELHORENVIO_TOKEN; }
function baseUrl() {
  if (process.env.MELHORENVIO_URL) return process.env.MELHORENVIO_URL.replace(/\/$/, ''); // testes
  return process.env.MELHORENVIO_AMBIENTE === 'sandbox' ? 'https://sandbox.melhorenvio.com.br' : 'https://melhorenvio.com.br';
}
function soCep(c) { const d = String(c || '').replace(/\D/g, ''); return d.length === 8 ? d : null; }
const semAcento = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// Entrega da própria loja vale pra essa cidade? Lista vazia = vale pra qualquer CEP.
function entregaLocalAtende(cfg, cidade) {
  const lista = cfg.entregaLocalCidades.split(/[,;\n]/).map(semAcento).filter(Boolean);
  return !lista.length || lista.includes(semAcento(cidade));
}

const cacheCep = new Map();
async function endereco(cep) {
  const c = soCep(cep);
  if (!c) throw new ErroFrete('CEP precisa ter 8 números', 400);
  const guardado = cacheCep.get(c);
  if (guardado && Date.now() - guardado.em < 24 * 3600e3) return guardado.v;
  let r;
  try {
    r = await fetch((process.env.VIACEP_URL || 'https://viacep.com.br/ws').replace(/\/$/, '') + '/' + c + '/json/', { signal: AbortSignal.timeout(8000) });
  } catch (e) { throw new ErroFrete('Não consegui consultar o CEP agora — digite o endereço', 502); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.erro) throw new ErroFrete('CEP não encontrado', 404);
  const v = { cep: c, rua: d.logradouro || '', bairro: d.bairro || '', cidade: d.localidade || '', uf: d.uf || '' };
  cacheCep.set(c, { v, em: Date.now() });
  if (cacheCep.size > 2000) cacheCep.delete(cacheCep.keys().next().value);
  return v;
}

// Opções de frete pra `qtdPecas` peças valendo `valor` (seguro). Devolve [{ id, nome, empresa, preco, precoCheio, prazo }].
const cacheFrete = new Map();
async function cotar(cfg, cepDestino, qtdPecas, valor) {
  if (!cfg.ativo || !cfg.cepOrigem) throw new ErroFrete('Envio pelos Correios não está ativo', 400);
  if (!configurado()) throw new ErroFrete('Envio não configurado (falta MELHORENVIO_TOKEN)', 503);
  const destino = soCep(cepDestino);
  if (!destino) throw new ErroFrete('CEP precisa ter 8 números', 400);
  const chave = [cfg.cepOrigem, destino, qtdPecas, valor.toFixed(2), cfg.pesoPecaG, cfg.alturaCm, cfg.larguraCm, cfg.comprimentoCm].join('|');
  const guardado = cacheFrete.get(chave);
  let servicos;
  if (guardado && Date.now() - guardado.em < 30 * 60e3) servicos = guardado.v;
  else {
    let r;
    try {
      r = await fetch(baseUrl() + '/api/v2/me/shipment/calculate', {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.MELHORENVIO_TOKEN,
          'User-Agent': 'Loja Gutto (' + (process.env.MELHORENVIO_EMAIL || 'contato@lojagutto') + ')' },
        body: JSON.stringify({
          from: { postal_code: cfg.cepOrigem }, to: { postal_code: destino },
          products: [{ id: 'pecas', width: cfg.larguraCm, height: cfg.alturaCm, length: cfg.comprimentoCm, weight: cfg.pesoPecaG / 1000,
            insurance_value: Number((valor / qtdPecas).toFixed(2)), quantity: qtdPecas }],
          options: { receipt: false, own_hand: false },
        }),
      });
    } catch (e) { throw new ErroFrete('Não consegui calcular o frete agora — tente de novo em instantes', 502); }
    const d = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(d)) throw new ErroFrete('Não consegui calcular o frete pra esse CEP' + (d && d.message ? ' (' + d.message + ')' : ''), 502);
    servicos = d.filter((s) => !s.error && Number(s.custom_price || s.price) > 0).map((s) => ({
      id: String(s.id), nome: s.name, empresa: (s.company && s.company.name) || '',
      preco: Number(Number(s.custom_price || s.price).toFixed(2)), prazo: Number(s.custom_delivery_time || s.delivery_time || 0),
    }));
    cacheFrete.set(chave, { v: servicos, em: Date.now() });
    if (cacheFrete.size > 2000) cacheFrete.delete(cacheFrete.keys().next().value);
  }
  if (!servicos.length) throw new ErroFrete('Nenhuma transportadora atende esse CEP', 404);
  const ordenado = [...servicos].sort((a, b) => a.preco - b.preco);
  const gratis = cfg.freteGratisAcima > 0 && valor >= cfg.freteGratisAcima;
  return ordenado.map((s, i) => ({
    id: s.id, nome: (s.empresa ? s.empresa + ' ' : '') + s.nome, preco: gratis && i === 0 ? 0 : s.preco, precoCheio: s.preco,
    prazo: s.prazo + cfg.diasManuseio,
  }));
}

module.exports = { ErroFrete, PADRAO, mesclarConfig, configurado, endereco, cotar, entregaLocalAtende, soCep };
