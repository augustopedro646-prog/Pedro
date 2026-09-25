require('dotenv').config();
const path = require('path');
const express = require('express');
const { geral } = require('./rateLimit');
const authRoutes = require('./routes/auth');
const configRoutes = require('./routes/config');

const app = express();
app.set('trust proxy', 1); // necessário pro ipKeyGenerator ver o IP real atrás do proxy da hospedagem

app.use(express.json());
app.use(geral);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/config', configRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erro: 'Erro interno' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor no ar em http://localhost:${PORT}`));
