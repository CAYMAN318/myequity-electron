const { app, BrowserWindow } = require('electron');
const path = require('path');
const serverModule = require('./server/app.js'); 

let expressServerInstance = null;

function createWindow() {
    // Cria a janela principal do Electron para o MyEquity
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 1000,
        minHeight: 700,
        title: "MyEquity - Gestão Patrimonial Estratégica",
        icon: path.join(__dirname, 'assets', 'icon.png'), 
        webPreferences: {
            nodeIntegration: false, 
            contextIsolation: true, 
        }
    });

    // Abre o console de desenvolvedor automaticamente para depuração
    //mainWindow.webContents.openDevTools(); 

    // Remove o menu padrão para uma aparência mais limpa
    mainWindow.setMenuBarVisibility(false);

    // Carrega o ponto de entrada principal (Shell)
    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

// Inicia o servidor e a janela quando o Electron estiver pronto
app.on('ready', () => {
    // Porta 3001 para evitar conflito com outros sistemas (MyWallet3)
    expressServerInstance = serverModule.startServer(3001); 

    createWindow();
    console.log(">>> [ELECTRON] MyEquity iniciado com sucesso na porta 3001");
});

// Encerramento do aplicativo
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});