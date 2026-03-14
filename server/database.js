const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

// Mágica do Electron: Usa AppData em produção e a pasta local no desenvolvimento
const dbPath = app.isPackaged 
    ? path.join(app.getPath('userData'), 'bd_myequity.db')
    : path.join(__dirname, '..', 'bd_myequity.db');

const db = new Database(dbPath);

db.pragma('foreign_keys = ON');

// --- ESTRUTURA COMPLETA E ATUALIZADA ---
db.exec(`
    -- CONFIGURAÇÕES GERAIS DO SISTEMA
    CREATE TABLE IF NOT EXISTS Settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );

    -- CATEGORIAS
    CREATE TABLE IF NOT EXISTS Categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        color TEXT DEFAULT '#cbd5e1',
        icon TEXT DEFAULT 'tag'
    );

    -- BALDES DE ATIVOS
    CREATE TABLE IF NOT EXISTS Assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        current_balance REAL DEFAULT 0,
        target_goal REAL DEFAULT 0,
        color TEXT DEFAULT '#3b82f6',
        status TEXT DEFAULT 'active',
        last_sync TEXT
    );

    -- CONTRATOS DE DÍVIDA
    CREATE TABLE IF NOT EXISTS Loans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        description TEXT NOT NULL,
        total_principal REAL NOT NULL,
        interest_rate REAL NOT NULL,
        installments_total INTEGER NOT NULL,
        installments_paid INTEGER DEFAULT 0,
        monthly_payment REAL DEFAULT 0,
        start_date TEXT,
        is_payroll_deductible INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active'
    );

    -- HISTÓRICO PATRIMONIAL
    CREATE TABLE IF NOT EXISTS EquityHistory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER,
        loan_id INTEGER,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        quantity REAL DEFAULT 0,
        interest_saved REAL DEFAULT 0,
        date TEXT NOT NULL,
        FOREIGN KEY (asset_id) REFERENCES Assets (id) ON DELETE CASCADE,
        FOREIGN KEY (loan_id) REFERENCES Loans (id) ON DELETE CASCADE
    );
`);

console.log(">>> [BANCO DE DADOS] Conectado em:", dbPath);

module.exports = db;