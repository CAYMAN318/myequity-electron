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
        
        // MÓDULO DE IMPOSTOS
        const totalImpostosDevidos = db.prepare("SELECT SUM(tax_due) as total FROM EquityHistory WHERE tax_due > 0").get().total || 0;
        const impostosDetalhados = db.prepare(`
            SELECT EH.id, EH.date, EH.amount as valor_venda, EH.tax_due as ir_devido, A.name as asset_name
            FROM EquityHistory EH
            JOIN Assets A ON EH.asset_id = A.id
            WHERE EH.tax_due > 0
            ORDER BY EH.date DESC
        `).all();

        // 2. MÓDULO DE REBALANCEAMENTO (Corrigido para buscar target_percentage em Classes)
        const rebalanceModule = db.prepare(`
            SELECT C.name as category, 
                   SUM(A.current_balance) as current_amount,
                   C.target_percentage as target_pct
            FROM Classes C
            LEFT JOIN Subcategories S ON S.class_id = C.id
            LEFT JOIN Assets A ON A.subcategory_id = S.id AND A.status = 'active' AND A.is_rebalancing_active = 1
            GROUP BY C.id
        `).all();

        // 3. MÓDULO DE BUCKETING (METAS - Corrigido nome da coluna para target_value)
        const goalsModule = db.prepare(`
            SELECT G.name as goal, 
                   SUM(A.current_balance) as current_amount,
                   G.target_value as target_amount
            FROM Goals G
            LEFT JOIN Assets A ON A.goal_id = G.id AND A.status = 'active'
            GROUP BY G.id
        `).all();

        // 4. DISTRIBUIÇÃO GERAL (PIZZA DE ATIVOS E DÍVIDAS)
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

        // ==========================================================
        // 5. NOVOS MÓDULOS DE BI (MÁQUINA DO TEMPO / EVOLUÇÃO)
        // ==========================================================
        
        // Histórico completo de investimentos para o Gráfico de Evolução
        const evolutionInvestments = db.prepare(`
            SELECT EH.date, EH.amount, EH.type, EH.asset_id, A.name as asset_name
            FROM EquityHistory EH
            JOIN Assets A ON EH.asset_id = A.id
            WHERE EH.type IN ('contribution', 'withdrawal', 'dividend')
            ORDER BY EH.date ASC
        `).all();

        // Contratos ativos para a Projeção de Dívidas (Gráfico Vermelho)
        const activeLoans = db.prepare(`
            SELECT * FROM Loans 
            WHERE status != 'quitted' AND status != 'deleted'
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
            goalsModule,
            evolutionInvestments,
            activeLoans
        });
    } catch (err) {
        console.error("ERRO GRAVE NO DASHBOARD:", err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;