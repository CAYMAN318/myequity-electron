const express = require('express');
const router = express.Router();
const db = require('../database');

/**
 * DASHBOARD CONSOLIDADO: Ativos, Passivos e Evolução
 */
router.get('/', (req, res) => {
    try {
        // 1. Total de Ativos (Saldo atual dos baldes habilitados)
        const totalAtivos = db.prepare("SELECT SUM(current_balance) as total FROM Assets WHERE status = 'active'").get().total || 0;
        
        // 2. Total de Dívidas (Saldo devedor principal atualizado)
        const totalDividas = db.prepare(`
            SELECT SUM(total_principal - (CAST(total_principal AS REAL) / installments_total * installments_paid)) as total 
            FROM Loans WHERE status = 'active'
        `).get().total || 0;

        // 3. Renda Passiva (Soma de todos os dividendos no histórico)
        const totalRendimentos = db.prepare("SELECT SUM(amount) as total FROM EquityHistory WHERE type = 'dividend'").get().total || 0;

        // 4. Detalhamento dos Ativos para a Pizza
        const fundos = db.prepare("SELECT name as nome, type as tipo, current_balance as saldo, color as cor FROM Assets WHERE status = 'active'").all();

        // 5. Detalhamento das Dívidas para a Pizza (Calculado)
        const dividasDetalhadas = db.prepare(`
            SELECT description as label, (total_principal - (CAST(total_principal AS REAL) / installments_total * installments_paid)) as valor
            FROM Loans WHERE status = 'active'
        `).all();

        // 6. Evolução Histórica (Opcional: Pode ser expandido buscando no EquityHistory por mês)
        // Por enquanto, o frontend usa o mock se estes arrays vierem vazios
        const evolucaoAtivos = { labels: [], valores: [] };
        const evolucaoDividas = { labels: [], valores: [] };

        res.json({ 
            totalAtivos, 
            totalDividas, 
            totalRendimentos,
            fundos,
            dividasLabels: dividasDetalhadas.map(d => d.label),
            dividasValores: dividasDetalhadas.map(d => d.valor),
            evolucaoAtivos,
            evolucaoDividas
        });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

module.exports = router;