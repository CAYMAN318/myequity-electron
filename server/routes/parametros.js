const express = require('express');
const router = express.Router();
const db = require('../database');
const fs = require('fs');
const multer = require('multer');
const os = require('os');
const { app } = require('electron');

// Usa a pasta temporária do próprio Sistema Operacional para evitar bloqueios de escrita
const upload = multer({ dest: os.tmpdir() });

// ============================================================================
// 1. GESTÃO DE SISTEMA E INTEGRAÇÕES (SETTINGS)
// ============================================================================
router.get('/settings/:key', (req, res) => {
    try {
        const row = db.prepare("SELECT value FROM Settings WHERE key = ?").get(req.params.key);
        res.json({ value: row ? row.value : "" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/settings', (req, res) => {
    const { key, value } = req.body;
    try {
        db.prepare("INSERT INTO Settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 2. MACRO-CLASSES (ALOCAÇÃO ALVO)
// ============================================================================
router.get('/classes', (req, res) => {
    try { 
        res.json(db.prepare("SELECT * FROM Classes ORDER BY name").all()); 
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/classes', (req, res) => {
    const { name, target_percentage, color } = req.body;
    try {
        db.prepare("INSERT INTO Classes (name, target_percentage, color) VALUES (?, ?, ?)").run(name, target_percentage, color || '#3b82f6');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/classes/:id', (req, res) => {
    const { name, target_percentage, color } = req.body;
    try {
        db.prepare("UPDATE Classes SET name = ?, target_percentage = ?, color = ? WHERE id = ?").run(name, target_percentage, color, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/classes/:id', (req, res) => {
    try {
        db.prepare("DELETE FROM Classes WHERE id = ?").run(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 3. SETORES E SUBCATEGORIAS
// ============================================================================
router.get('/subcategories', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT s.*, c.name as class_name 
            FROM Subcategories s 
            LEFT JOIN Classes c ON s.class_id = c.id 
            ORDER BY c.name, s.name
        `).all();
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/subcategories', (req, res) => {
    const { class_id, name } = req.body;
    try {
        db.prepare("INSERT INTO Subcategories (class_id, name) VALUES (?, ?)").run(class_id, name);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/subcategories/:id', (req, res) => {
    const { class_id, name } = req.body;
    try {
        db.prepare("UPDATE Subcategories SET class_id = ?, name = ? WHERE id = ?").run(class_id, name, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/subcategories/:id', (req, res) => {
    try {
        db.prepare("DELETE FROM Subcategories WHERE id = ?").run(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 4. METAS (BUCKETING / GOALS)
// ============================================================================
router.get('/goals', (req, res) => {
    try { res.json(db.prepare("SELECT * FROM Goals ORDER BY deadline, name").all()); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/goals', (req, res) => {
    const { name, target_value, deadline } = req.body;
    try {
        db.prepare("INSERT INTO Goals (name, target_value, deadline) VALUES (?, ?, ?)").run(name, target_value, deadline || null);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/goals/:id', (req, res) => {
    const { name, target_value, deadline } = req.body;
    try {
        db.prepare("UPDATE Goals SET name = ?, target_value = ?, deadline = ? WHERE id = ?").run(name, target_value, deadline || null, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/goals/:id', (req, res) => {
    try {
        db.prepare("DELETE FROM Goals WHERE id = ?").run(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 5. BACKUP E RESTORE DO BANCO DE DADOS
// ============================================================================
router.get('/system/backup', (req, res) => {
    const dbPath = db.name; // Pega dinamicamente o caminho real que o SQLite está usando
    if (fs.existsSync(dbPath)) {
        res.download(dbPath, `myequity_backup_${new Date().toISOString().split('T')[0]}.db`);
    } else {
        res.status(404).json({ error: "Banco de dados não encontrado no servidor." });
    }
});

router.post('/system/restore', upload.single('database'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado." });
    
    const tempPath = req.file.path;
    const dbPath = db.name; // Caminho real

    try {
        // Obrigatório fechar a conexão no Windows antes de substituir o arquivo físico
        db.close(); 
        fs.copyFileSync(tempPath, dbPath);
        fs.unlinkSync(tempPath); // Limpa o arquivo temporário
        
        // Reinicia o aplicativo automaticamente para carregar o novo banco de dados
        setTimeout(() => {
            app.relaunch();
            app.exit(0);
        }, 1000);

        res.json({ success: true, message: "Backup restaurado com sucesso. Reiniciando..." });
    } catch (err) {
        res.status(500).json({ error: "Falha catastrófica ao restaurar: " + err.message });
    }
});

module.exports = router;