require('dotenv').config();
const path = require('path');
const express = require('express');
const { geral } = require('./rateLimit');
const authRoutes = require('./routes/auth');
const configRoutes = require('./routes/config');
const pontoRoutes = require('./routes/ponto');
const financeiroRoutes = require('./routes/financeiro');
const tarefasRoutes = require('./routes/tarefas');
const calendarioRoutes = require('./routes/calendario');
const sociosRoutes = require('./routes/socios');

const app = express();
app.set('trust proxy', 1); // necessário pro ipKeyGenerator ver o IP real atrás do proxy da hospedagem

app.use(express.json());
app.use(geral);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/config', configRoutes);
app.use('/api/ponto', pontoRoutes);
app.use('/api/financeiro', financeiroRoutes);
app.use('/api/tarefas', tarefasRoutes);
app.use('/api/calendario', calendarioRoutes);
app.use('/api/socios', sociosRoutes);
app.use('/api/inicio', require('./routes/inicio'));
app.use('/api/relatorios', require('./routes/relatorios'));
app.use('/api/historico', require('./routes/historico'));
app.use('/api/reservas', require('./routes/reservas'));
app.use('/api/mensalidades', require('./routes/mensalidades'));
app.use('/api/escalas', require('./routes/escalas'));
app.use('/api/badges', require('./routes/badges'));
app.use('/api/presencas', require('./routes/presencas'));
app.use('/api/reveillon', require('./routes/reveillon'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erro: 'Erro interno' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor no ar em http://localhost:${PORT}`));
