// Abas do menu lateral que já entram nessa primeira fase (mecanismo
// reaproveitado do PDV Jabá, conteúdo ainda por fazer). "Sócios" fica de
// fora até o modelo de dado ser fechado com o Pedro depois da visita.
// "Robô WhatsApp" também fica de fora até confirmar se faz sentido pra
// esse contexto. Ordem aqui é a ordem fixa no menu.
const ABAS = [
  { id: 'inicio', nome: 'Início' },
  { id: 'relatorios', nome: 'Relatórios' },
  { id: 'fluxo_caixa', nome: 'Fluxo de caixa' },
  { id: 'calendario', nome: 'Calendário' },
  { id: 'eventos', nome: 'Eventos' },
  { id: 'tarefas', nome: 'Tarefas' },
  { id: 'ponto', nome: 'Bater ponto' },
];

module.exports = { ABAS };
