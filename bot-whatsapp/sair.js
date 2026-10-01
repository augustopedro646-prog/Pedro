// Cliente respondeu SAIR (ou parecido) a um aviso: para de receber as mensagens da loja
// (aniversário, cashback, novidade). Os avisos de pedido e o atendimento continuam normais.
const { LOJA_ID, pool } = require('./config');

// Só a mensagem inteira (sem "cancelar", que costuma ser sobre pedido).
const PEDIDOS = ['sair', 'parar', 'pare', 'stop', 'descadastrar', 'nao quero mais', 'não quero mais', 'nao quero receber', 'não quero receber'];
function pediuPraSair(texto) {
  return PEDIDOS.includes(String(texto || '').trim().toLowerCase().replace(/[.!]+$/, ''));
}

// Marca no cadastro (achado pelo telefone) e tira da fila o que ainda não foi. Devolve quantos
// cadastros achou — 0 quando o contato não tem número conhecido ("@lid") ou não é cliente.
async function descadastrar(telefoneLocal) {
  if (!telefoneLocal) return 0;
  const { rows } = await pool.query(
    'UPDATE clientes SET aceita_mensagens = false WHERE loja_id = $1 AND telefone = $2 RETURNING id', [LOJA_ID, telefoneLocal]);
  if (rows.length) {
    await pool.query("UPDATE mensagens_clientes SET status = 'descartada' WHERE cliente_id = ANY($1) AND status IN ('pendente', 'na_fila', 'erro')",
      [rows.map((r) => r.id)]);
  }
  return rows.length;
}

module.exports = { pediuPraSair, descadastrar };
