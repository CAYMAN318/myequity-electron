const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * Lógica de Isolamento de Dados:
 * Ao usar app.getPath('userData'), o Electron retorna uma pasta baseada no "productName" do package.json.
 * V1 (MyEquity) -> AppData/Roaming/MyEquity
 * V2 (MyEquity V2) -> AppData/Roaming/MyEquity V2
 */
const userDataPath = app.getPath('userData');
const dbPath = path.join(userDataPath, 'bd_myequity_v2.db');

// Garante que a pasta userData existe
if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// 1. Inicialização das Tabelas da V2 (Estrutura Base Original)
// Nota: O SQLite ignora as novas colunas aqui se a tabela já existir.
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
        subcategory_id INTEGER,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        color TEXT DEFAULT '#cbd5e1',
        status TEXT DEFAULT 'active',
        current_balance REAL DEFAULT 0,
        FOREIGN KEY (subcategory_id) REFERENCES Subcategories(id)
    );

    CREATE TABLE IF NOT EXISTS EquityHistory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER,
        loan_id INTEGER,
        type TEXT NOT NULL, 
        amount REAL NOT NULL,
        quantity REAL,
        interest_saved REAL DEFAULT 0,
        date TEXT NOT NULL,
        FOREIGN KEY (asset_id) REFERENCES Assets(id) ON DELETE CASCADE,
        FOREIGN KEY (loan_id) REFERENCES Loans(id) ON DELETE CASCADE
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

    -- ========================================================
    -- NOVO: Tabela de Fotografia de Valorização (Snapshotting)
    -- ========================================================
    CREATE TABLE IF NOT EXISTS AssetSnapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        total_value REAL NOT NULL,
        FOREIGN KEY (asset_id) REFERENCES Assets(id) ON DELETE CASCADE
    );
`);

// 2. Módulo de Migração Simples (Adiciona colunas se não existirem)
// Função auxiliar para verificar se uma coluna existe numa tabela
function columnExists(tableName, columnName) {
    const tableInfo = db.pragma(`table_info(${tableName})`);
    return tableInfo.some(col => col.name === columnName);
}

// Módulo de Rebalanceamento e Objetivos (Tabela Assets)
if (!columnExists('Assets', 'is_rebalancing_active')) {
    console.log("Migração: Adicionando coluna 'is_rebalancing_active' na tabela Assets...");
    db.exec(`ALTER TABLE Assets ADD COLUMN is_rebalancing_active INTEGER DEFAULT 1;`);
}

if (!columnExists('Assets', 'goal_id')) {
    console.log("Migração: Adicionando coluna 'goal_id' na tabela Assets...");
    db.exec(`ALTER TABLE Assets ADD COLUMN goal_id INTEGER;`);
}

// Módulo de Impostos (Tabela EquityHistory)
if (!columnExists('EquityHistory', 'tax_due')) {
    console.log("Migração: Adicionando coluna 'tax_due' na tabela EquityHistory...");
    db.exec(`ALTER TABLE EquityHistory ADD COLUMN tax_due REAL DEFAULT 0;`);
}

if (!columnExists('EquityHistory', 'lucro')) {
    console.log("Migração: Adicionando coluna 'lucro' na tabela EquityHistory...");
    db.exec(`ALTER TABLE EquityHistory ADD COLUMN lucro REAL DEFAULT 0;`);
}

// Módulo de Objetivos - Correção de Nomenclatura (Tabela Goals)
if (!columnExists('Goals', 'icon')) {
    console.log("Migração: Adicionando coluna 'icon' na tabela Goals...");
    db.exec(`ALTER TABLE Goals ADD COLUMN icon TEXT DEFAULT 'target';`);
}

module.exports = db;