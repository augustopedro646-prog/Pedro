// Abas do menu lateral que já entram nessa primeira fase (mecanismo
// reaproveitado do PDV Jabá, conteúdo ainda por fazer nas que restam).
// "Robô WhatsApp" fica de fora até confirmar se faz sentido pra esse
// contexto. Ordem aqui é a ordem fixa no menu.
const ABAS = [
  { id: 'inicio', nome: 'Início' },
  { id: 'relatorios', nome: 'Relatórios' },
  { id: 'fluxo_caixa', nome: 'Fluxo de caixa' },
  { id: 'calendario', nome: 'Calendário' },
  { id: 'eventos', nome: 'Eventos' },
  { id: 'tarefas', nome: 'Tarefas' },
  { id: 'socios', nome: 'Sócios' },
  { id: 'mensalidades', nome: 'Mensalidades' },
  { id: 'ponto', nome: 'Bater ponto' },
];

module.exports = { ABAS };
