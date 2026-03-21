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

// Inicialização das Tabelas da V2 (Estrutura Completa)
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
        deadline DATE,
        status TEXT DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS Assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subcategory_id INTEGER,
        goal_id INTEGER,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        current_balance REAL DEFAULT 0,
        avg_price REAL DEFAULT 0,
        total_quantity REAL DEFAULT 0,
        color TEXT DEFAULT '#3b82f6',
        is_rebalancing_active INTEGER DEFAULT 1,
        status TEXT DEFAULT 'active',
        FOREIGN KEY (subcategory_id) REFERENCES Subcategories(id),
        FOREIGN KEY (goal_id) REFERENCES Goals(id)
    );

    CREATE TABLE IF NOT EXISTS Loans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        description TEXT NOT NULL,
        total_principal REAL NOT NULL,
        interest_rate REAL NOT NULL,
        installments_total INTEGER NOT NULL,
        installments_paid INTEGER DEFAULT 0,
        monthly_payment REAL DEFAULT 0,
        start_date DATE,
        is_payroll_deductible INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS EquityHistory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER,
        loan_id INTEGER,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        quantity REAL DEFAULT 0,
        interest_saved REAL DEFAULT 0,
        tax_due REAL DEFAULT 0,
        date DATE NOT NULL,
        FOREIGN KEY (asset_id) REFERENCES Assets(id) ON DELETE CASCADE,
        FOREIGN KEY (loan_id) REFERENCES Loans(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS Settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
`);

module.exports = db;