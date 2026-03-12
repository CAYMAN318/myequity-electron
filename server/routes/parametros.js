const express = require('express');
const router = express.Router();
const db = require('../database');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const upload = multer({ dest: 'temp/' });

/**
 * --- GESTÃO DE SETTINGS ---
 */
router.get('/settings/:key', (req, res) => {
    try {
        const row = db.prepare("SELECT value FROM Settings WHERE key = ?").get(req.params.key);
        res.json({ value: row ? row.value : "" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/settings', (req, res) => {
    const { key, value } = req.body;
    try {
        db.prepare("INSERT INTO Settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(key, value);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * --- CARTEIRA DE ATIVOS (SETUP) ---
 */
router.get('/assets', (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM Assets ORDER BY status, name").all();
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/assets-setup', (req, res) => {
    const { name, type, target_goal, color, initial_qty, initial_price, date } = req.body;
    const initial_amount = (parseFloat(initial_qty) || 0) * (parseFloat(initial_price) || 0);

    try {
        db.transaction(() => {
            const info = db.prepare(`
                INSERT INTO Assets (name, type, current_balance, target_goal, color, status, last_sync)
                VALUES (?, ?, ?, ?, ?, 'active', ?)
            `).run(name.toUpperCase(), type, initial_amount, target_goal || 0, color || '#3b82f6', date);

            if (initial_amount > 0) {
                db.prepare(`
                    INSERT INTO EquityHistory (asset_id, type, amount, quantity, date)
                    VALUES (?, 'contribution', ?, ?, ?)
                `).run(info.lastInsertRowid, initial_amount, initial_qty, date);
            }
        })();
        res.status(201).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/assets/:id', (req, res) => {
    try {
        db.prepare("DELETE FROM Assets WHERE id = ?").run(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * --- CONTRATOS DE DÍVIDA (LOANS) ---
 */
router.get('/loans', (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM Loans ORDER BY status, description").all();
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/loans', (req, res) => {
    const { 
        description, total_principal, interest_rate, installments_total, 
        installments_paid, monthly_payment, start_date, is_payroll_deductible 
    } = req.body;
    try {
        db.prepare(`
            INSERT INTO Loans (
                description, total_principal, interest_rate, installments_total, 
                installments_paid, monthly_payment, start_date, is_payroll_deductible, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
        `).run(
            description, parseFloat(total_principal), parseFloat(interest_rate), 
            parseInt(installments_total), parseInt(installments_paid) || 0, 
            parseFloat(monthly_payment), start_date, is_payroll_deductible ? 1 : 0
        );
        res.status(201).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// NOVO: Rota para Editar (Atualizar) o Contrato de Dívida
router.put('/loans/:id', (req, res) => {
    const { 
        description, total_principal, interest_rate, installments_total, 
        installments_paid, monthly_payment, start_date, is_payroll_deductible 
    } = req.body;
    try {
        db.prepare(`
            UPDATE Loans SET 
                description = ?, total_principal = ?, interest_rate = ?, 
                installments_total = ?, installments_paid = ?, monthly_payment = ?, 
                start_date = ?, is_payroll_deductible = ?
            WHERE id = ?
        `).run(
            description, parseFloat(total_principal), parseFloat(interest_rate), 
            parseInt(installments_total), parseInt(installments_paid) || 0, 
            parseFloat(monthly_payment), start_date, is_payroll_deductible ? 1 : 0, req.params.id
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/loans/:id', (req, res) => {
    try {
        db.prepare("DELETE FROM Loans WHERE id = ?").run(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * --- SISTEMA: BACKUP & RESTORE ---
 */
router.get('/system/backup', (req, res) => {
    const dbPath = path.join(__dirname, '../../bd_myequity.db');
    if (fs.existsSync(dbPath)) {
        res.download(dbPath, `myequity_backup_${new Date().toISOString().split('T')[0]}.db`);
    } else {
        res.status(404).json({ error: "Banco não encontrado" });
    }
});

router.post('/system/restore', upload.single('database'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado." });
    const tempPath = req.file.path;
    const dbPath = path.join(__dirname, '../../bd_myequity.db');
    try {
        fs.copyFileSync(tempPath, dbPath);
        fs.unlinkSync(tempPath);
        res.json({ success: true, message: "Backup restaurado. Por favor, reinicie o aplicativo." });
    } catch (err) {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        res.status(500).json({ error: "Erro ao restaurar arquivo: " + err.message });
    }
});

module.exports = router;