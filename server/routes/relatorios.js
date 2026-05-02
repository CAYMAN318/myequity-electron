const express = require('express');
const router = express.Router();
const db = require('../database');

router.get('/', (req, res) => {
    try {
        // 1. Histórico de Aportes e Proventos (EquityHistory)
        const evolutionInvestments = db.prepare(`
            SELECT EH.date, EH.amount, EH.type, EH.asset_id, A.name as asset_name
            FROM EquityHistory EH
            JOIN Assets A ON EH.asset_id = A.id
            WHERE EH.type IN ('contribution', 'withdrawal', 'dividend')
            ORDER BY EH.date ASC
        `).all();

        // 2. Fotografias de Valorização (Marcação a Mercado / Snapshots)
        const snapshots = db.prepare(`
            SELECT date, SUM(total_value) as patrimonio_total
            FROM AssetSnapshots
            GROUP BY date
            ORDER BY date ASC
        `).all();

        // 3. Contratos de Empréstimos Ativos (Loans)
        const activeLoans = db.prepare(`
            SELECT * FROM Loans 
            WHERE status != 'quitted' AND status != 'deleted'
        `).all();

        res.json({ 
            evolutionInvestments, 
            snapshots,
            activeLoans 
        });
        
    } catch (err) {
        console.error("Erro na rota de relatórios:", err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;