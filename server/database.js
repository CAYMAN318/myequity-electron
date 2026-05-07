const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * Lógica de Isolamento de Dados:
 * Ao usar app.getPath('userData'), o Electron retorna uma pasta baseada no "productName" do package.json.
 */
const userDataPath = app.getPath('userData');
const dbPath = path.join(userDataPath, 'bd_myequity_v2.db');

// Garante que a pasta userData existe
if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// ==========================================
// 1. INICIALIZAÇÃO DAS TABELAS (ESTRUTURA BASE)
// ==========================================
db.exec(`
    CREATE TABLE IF NOT EXISTS Classes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        target_percentage REAL DEFAULT 0,
        color TEXT DEFAULT '#3b82f6'
    );

    CREATE TABLE IF NOT EXISTS Subcategories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER,
        name TEXT NOT NULL,
        FOREIGN KEY (class_id) REFERENCES Classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS Goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        target_value REAL DEFAULT 0,
        icon TEXT DEFAULT 'target',
        color TEXT DEFAULT '#10b981'
    );

    CREATE TABLE IF NOT EXISTS Assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        total_quantity REAL DEFAULT 0,
        avg_price REAL DEFAULT 0,
        current_balance REAL DEFAULT 0,
        status TEXT DEFAULT 'active',
        color TEXT DEFAULT '#3b82f6',
        subcategory_id INTEGER,
        goal_id INTEGER,
        is_rebalancing_active INTEGER DEFAULT 1,
        cnpj TEXT,
        razao_social TEXT,
        corretora TEXT,
        FOREIGN KEY (subcategory_id) REFERENCES Subcategories(id) ON DELETE SET NULL,
        FOREIGN KEY (goal_id) REFERENCES Goals(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS EquityHistory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER,
        loan_id INTEGER,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        quantity REAL,
        lucro REAL DEFAULT 0,
        tax_due REAL DEFAULT 0,
        interest_saved REAL DEFAULT 0,
        date TEXT NOT NULL,
        FOREIGN KEY (asset_id) REFERENCES Assets(id) ON DELETE CASCADE,
        FOREIGN KEY (loan_id) REFERENCES Loans(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS AssetSnapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        total_value REAL NOT NULL,
        FOREIGN KEY (asset_id) REFERENCES Assets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS Loans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        description TEXT NOT NULL,
        total_principal REAL NOT NULL,
        interest_rate REAL NOT NULL,
        installments_total INTEGER NOT NULL,
        installments_paid INTEGER DEFAULT 0,
        monthly_payment REAL NOT NULL,
        start_date TEXT NOT NULL,
        is_payroll_deductible INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS Settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
`);

// ==========================================
// 2. SISTEMA DE MIGRAÇÃO CONTÍNUA (ALTER TABLES)
// ==========================================
// Esta função verifica se uma coluna existe antes de tentar criá-la.
function columnExists(tableName, columnName) {
    const tableInfo = db.pragma(`table_info(${tableName})`);
    return tableInfo.some(col => col.name === columnName);
}

// Migração: Rebalanceamento e Objetivos
if (!columnExists('Assets', 'is_rebalancing_active')) {
    db.exec(`ALTER TABLE Assets ADD COLUMN is_rebalancing_active INTEGER DEFAULT 1;`);
}
if (!columnExists('Assets', 'goal_id')) {
    db.exec(`ALTER TABLE Assets ADD COLUMN goal_id INTEGER;`);
}

// ==========================================
// Migração: Módulo de IRPF (A causa do Erro 500)
// ==========================================
if (!columnExists('Assets', 'cnpj')) {
    console.log("Migração: Adicionando coluna 'cnpj' na tabela Assets...");
    db.exec(`ALTER TABLE Assets ADD COLUMN cnpj TEXT;`);
}
if (!columnExists('Assets', 'razao_social')) {
    console.log("Migração: Adicionando coluna 'razao_social' na tabela Assets...");
    db.exec(`ALTER TABLE Assets ADD COLUMN razao_social TEXT;`);
}
if (!columnExists('Assets', 'corretora')) {
    console.log("Migração: Adicionando coluna 'corretora' na tabela Assets...");
    db.exec(`ALTER TABLE Assets ADD COLUMN corretora TEXT;`);
}

// Migração: Módulo de Impostos (Histórico)
if (!columnExists('EquityHistory', 'tax_due')) {
    db.exec(`ALTER TABLE EquityHistory ADD COLUMN tax_due REAL DEFAULT 0;`);
}
if (!columnExists('EquityHistory', 'lucro')) {
    db.exec(`ALTER TABLE EquityHistory ADD COLUMN lucro REAL DEFAULT 0;`);
}

// Migração: Módulo de Passivos e Metas Visuais
if (!columnExists('Goals', 'icon')) {
    db.exec(`ALTER TABLE Goals ADD COLUMN icon TEXT DEFAULT 'target';`);
}
if (!columnExists('Goals', 'color')) {
    db.exec(`ALTER TABLE Goals ADD COLUMN color TEXT DEFAULT '#10b981';`);
}
if (!columnExists('Loans', 'is_payroll_deductible')) {
    db.exec(`ALTER TABLE Loans ADD COLUMN is_payroll_deductible INTEGER DEFAULT 0;`);
}

module.exports = db;