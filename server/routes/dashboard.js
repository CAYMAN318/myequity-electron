const express = require('express');
const router = express.Router();
const db = require('../database');

/**
 * DASHBOARD CONSOLIDADO: Wealth Management (V2.0)
 */
router.get('/', (req, res) => {
    try {
        // 1. DADOS TOTAIS (Global)
        const totalAtivos = db.prepare("SELECT SUM(current_balance) as total FROM Assets WHERE status = 'active'").get().total || 0;
        const totalDividas = db.prepare(`SELECT SUM(total_principal - (CAST(total_principal AS REAL) / installments_total * installments_paid)) as total FROM Loans WHERE status = 'active'`).get().total || 0;
        const totalRendimentos = db.prepare("SELECT SUM(amount) as total FROM EquityHistory WHERE type = 'dividend'").get().total || 0;
        
        // MÓDULO DE IMPOSTOS (Agora direto, pois o database.js no Canvas garante a coluna)
        const totalImpostosDevidos = db.prepare("SELECT SUM(tax_due) as total FROM EquityHistory WHERE tax_due > 0").get().total || 0;
        const impostosDetalhados = db.prepare(`
            SELECT EH.id, EH.date, EH.amount as valor_venda, EH.tax_due as ir_devido, A.name as asset_name
            FROM EquityHistory EH
            JOIN Assets A ON EH.asset_id = A.id
            WHERE EH.tax_due > 0
            ORDER BY EH.date DESC
        `).all();

        // 2. MÓDULO DE REBALANCEAMENTO DE PORTFÓLIO (Lendo is_rebalancing_active)
        const classes = db.prepare(`
            SELECT C.id, C.name, C.target_percentage, C.color,
                   COALESCE(SUM(A.current_balance), 0) as current_balance
            FROM Classes C
            LEFT JOIN Subcategories S ON S.class_id = C.id
            LEFT JOIN Assets A ON A.subcategory_id = S.id AND A.status = 'active' AND A.is_rebalancing_active = 1
            GROUP BY C.id
        `).all();

        const totalRebalance = classes.reduce((sum, c) => sum + c.current_balance, 0);

        const rebalanceModule = classes.map(c => {
            const current_percentage = totalRebalance > 0 ? (c.current_balance / totalRebalance) * 100 : 0;
            const target_balance = (c.target_percentage / 100) * totalRebalance;
            const diff_value = target_balance - c.current_balance;

            return {
                id: c.id,
                name: c.name,
                target_percentage: c.target_percentage,
                current_percentage: current_percentage,
                current_balance: c.current_balance,
                target_balance: target_balance,
                diff_value: diff_value,
                status: diff_value > 0 ? 'COMPRAR' : (diff_value < -100 ? 'AGUARDAR' : 'MANTER'),
                color: c.color || '#cbd5e1'
            };
        });

        // 3. MÓDULO DE OBJETIVOS (BUCKETING) - Corrigido para ler target_value como target_amount
        const goalsModule = db.prepare(`
            SELECT G.id, G.name, G.target_value as target_amount, G.deadline, G.icon,
                   COALESCE(SUM(A.current_balance), 0) as current_balance
            FROM Goals G
            LEFT JOIN Assets A ON A.goal_id = G.id AND A.status = 'active'
            GROUP BY G.id
        `).all();

        // 4. DISTRIBUIÇÃO GERAL (PIZZA)
        const fundos = db.prepare(`
            SELECT A.name as nome, 
                   COALESCE(C.name, 'Sem Classe') as tipo, 
                   A.current_balance as saldo, 
                   COALESCE(A.color, C.color, '#cbd5e1') as cor 
            FROM Assets A
            LEFT JOIN Subcategories S ON A.subcategory_id = S.id
            LEFT JOIN Classes C ON S.class_id = C.id
            WHERE A.status = 'active' AND A.current_balance > 0
        `).all();

        const dividasDetalhadas = db.prepare(`
            SELECT description as label, (total_principal - (CAST(total_principal AS REAL) / installments_total * installments_paid)) as valor
            FROM Loans WHERE status = 'active' AND installments_paid < installments_total
        `).all();

        res.json({ 
            totalAtivos, 
            totalDividas, 
            totalRendimentos,
            totalImpostosDevidos,
            impostosDetalhados,
            fundos,
            dividasLabels: dividasDetalhadas.map(d => d.label),
            dividasValores: dividasDetalhadas.map(d => d.valor),
            rebalanceModule,
            goalsModule
        });
    } catch (err) {
        console.error("ERRO GRAVE NO DASHBOARD:", err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;