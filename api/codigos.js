// EAN-13 interno: prefixo 2 (faixa GS1 reservada pra uso interno da loja) + 11 dígitos
// da sequência + dígito verificador. Leitor de código de barras comum lê normalmente.
function digitoVerificadorEan13(doze) {
  let soma = 0;
  for (let i = 0; i < 12; i++) soma += Number(doze[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (soma % 10)) % 10);
}

async function gerarCodigoBarras(db) {
  const { rows } = await db.query("SELECT nextval('codigo_barras_seq') AS n");
  const doze = '2' + String(rows[0].n).padStart(11, '0');
  return doze + digitoVerificadorEan13(doze);
}

module.exports = { gerarCodigoBarras, digitoVerificadorEan13 };
