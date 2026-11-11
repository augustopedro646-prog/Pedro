require('dotenv').config();
const path = require('path');
const express = require('express');
const { geral } = require('./rateLimit');
const authRoutes = require('./routes/auth');
const professoresRoutes = require('./routes/professores');
const modalidadesRoutes = require('./routes/modalidades');
const turmasRoutes = require('./routes/turmas');
const alunosRoutes = require('./routes/alunos');
const chamadasRoutes = require('./routes/chamadas');
const relatoriosRoutes = require('./routes/relatorios');

const app = express();
app.set('trust proxy', 1); // necessário pro ipKeyGenerator ver o IP real atrás do proxy da hospedagem

app.use(express.json());
app.use(geral);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/professores', professoresRoutes);
app.use('/api/modalidades', modalidadesRoutes);
app.use('/api/turmas', turmasRoutes);
app.use('/api/alunos', alunosRoutes);
app.use('/api/chamadas', chamadasRoutes);
app.use('/api/relatorios', relatoriosRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erro: 'Erro interno' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Servidor no ar em http://localhost:${PORT}`));
