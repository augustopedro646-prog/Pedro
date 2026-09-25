// Escapa qualquer texto livre digitado por pessoa antes de ir pro
// innerHTML. Sem isso é XSS armazenado — usar em TODO dado de usuário.
function esc(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Padrão de campo numérico: nunca usar <input type="number"> puro (ele
// apaga "10," e depende do locale do navegador). Usar type="text"
// inputmode="decimal" + este parser.
function parseNumero(texto) {
  const limpo = String(texto ?? '').trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(limpo);
  return Number.isFinite(n) ? n : 0;
}
