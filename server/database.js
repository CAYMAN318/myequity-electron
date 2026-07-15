const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const userDataPath = app.getPath('userData');
const dbPath = path.join(userDataPath, 'bd_myequity_v2.db');

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

    CREATE TABLE IF NOT EXISTS OptionsContracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL, 
        asset_base TEXT NOT NULL, 
        ticker TEXT NOT NULL, 
        quantity INTEGER NOT NULL,
        strike_price REAL NOT NULL,
        premium_unit REAL NOT NULL,
        total_premium REAL NOT NULL,
        expiration_date TEXT NOT NULL,
        style TEXT DEFAULT 'americano', 
        status TEXT DEFAULT 'active', 
        open_date TEXT NOT NULL,
        buyback_total REAL DEFAULT 0,
        realized_profit REAL DEFAULT 0
    );

    -- ========================================================
    -- NOVO MÓDULO: MERCADO GLOBAL (EXTERIOR EM USD)
    -- ========================================================
    CREATE TABLE IF NOT EXISTS GlobalAssets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL, -- REIT, Stock, ETF
        total_quantity REAL DEFAULT 0,
        avg_price_usd REAL DEFAULT 0,
        avg_exchange_rate REAL DEFAULT 0, -- Câmbio médio pago via Wise
        current_balance_usd REAL DEFAULT 0,
        status TEXT DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS GlobalHistory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL,
        type TEXT NOT NULL, -- 'buy', 'sell', 'dividend'
        amount_usd REAL NOT NULL,
        quantity REAL,
        exchange_rate REAL, -- Câmbio do dia da operação na Wise
        taxes_usd REAL DEFAULT 0, -- Imposto retido na fonte (ex: 30% EUA nos dividendos)
        date TEXT NOT NULL,
        FOREIGN KEY (asset_id) REFERENCES GlobalAssets(id) ON DELETE CASCADE
    );
`);

// ==========================================
// 2. SISTEMA DE MIGRAÇÃO CONTÍNUA (ALTER TABLES)
// ==========================================
function columnExists(tableName, columnName) {
    const tableInfo = db.pragma(`table_info(${tableName})`);
    return tableInfo.some(col => col.name === columnName);
}

if (!columnExists('Assets', 'is_rebalancing_active')) db.exec(`ALTER TABLE Assets ADD COLUMN is_rebalancing_active INTEGER DEFAULT 1;`);
if (!columnExists('Assets', 'goal_id')) db.exec(`ALTER TABLE Assets ADD COLUMN goal_id INTEGER;`);
if (!columnExists('Assets', 'cnpj')) db.exec(`ALTER TABLE Assets ADD COLUMN cnpj TEXT;`);
if (!columnExists('Assets', 'razao_social')) db.exec(`ALTER TABLE Assets ADD COLUMN razao_social TEXT;`);
if (!columnExists('Assets', 'corretora')) db.exec(`ALTER TABLE Assets ADD COLUMN corretora TEXT;`);
if (!columnExists('EquityHistory', 'tax_due')) db.exec(`ALTER TABLE EquityHistory ADD COLUMN tax_due REAL DEFAULT 0;`);
if (!columnExists('EquityHistory', 'lucro')) db.exec(`ALTER TABLE EquityHistory ADD COLUMN lucro REAL DEFAULT 0;`);
if (!columnExists('Goals', 'icon')) db.exec(`ALTER TABLE Goals ADD COLUMN icon TEXT DEFAULT 'target';`);
if (!columnExists('Goals', 'color')) db.exec(`ALTER TABLE Goals ADD COLUMN color TEXT DEFAULT '#10b981';`);
if (!columnExists('Loans', 'is_payroll_deductible')) db.exec(`ALTER TABLE Loans ADD COLUMN is_payroll_deductible INTEGER DEFAULT 0;`);

// [NOVO] Colunas para o encerramento antecipado (Recompra) de Opções
if (!columnExists('OptionsContracts', 'buyback_total')) db.exec(`ALTER TABLE OptionsContracts ADD COLUMN buyback_total REAL DEFAULT 0;`);
if (!columnExists('OptionsContracts', 'realized_profit')) db.exec(`ALTER TABLE OptionsContracts ADD COLUMN realized_profit REAL DEFAULT 0;`);

module.exports = db;