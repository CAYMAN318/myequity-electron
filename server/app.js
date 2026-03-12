const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const db = require('./database'); 

const app = express();

app.use(cors());
app.use(bodyParser.json());

// Serve os arquivos do frontend
const staticPath = path.join(__dirname, '../src');
app.use(express.static(staticPath));

// --- Registro das Rotas MyEquity ---
const dashboardRoutes = require('./routes/dashboard');
const dividasRoutes = require('./routes/dividas');
const ativosRoutes = require('./routes/ativos');
const parametrosRouter = require('./routes/parametros');

// Roteamento da API para Ativos, Dívidas e Dashboard
app.use('/api/dashboard-patrimonial', dashboardRoutes);
app.use('/api/dividas', dividasRoutes);
app.use('/api/ativos', ativosRoutes); 
app.use('/api/parametros', parametrosRouter);

// Fallback para abrir a index.html (SPA Pattern)
app.get('/', (req, res) => {
    res.sendFile('index.html', { root: staticPath });
});

let serverInstance = null;

/**
 * Inicia o servidor Express na porta especificada (padrão 3001 para MyEquity)
 */
const startServer = (port = 3001) => {
    if (serverInstance) return serverInstance;
    serverInstance = app.listen(port, () => {
        console.log(`>>> [MYEQUITY] Servidor operacional na porta ${port}`);
    });
    return serverInstance;
};

/**
 * Encerra o servidor de forma limpa
 */
const stopServer = () => {
    if (serverInstance) {
        serverInstance.close();
        serverInstance = null;
    }
};

module.exports = { startServer, stopServer };