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
        const totalImpostosDevidos = db.prepare("SELECT SUM(tax_due) as total FROM EquityHistory WHERE tax_due > 0").get().total || 0;

        // 2. MÓDULO DE REBALANCEAMENTO DE PORTFÓLIO
        // Agrupa os ativos por Macro-Classes, mas apenas os ativos marcados como "is_rebalancing_active = 1"
        const classes = db.prepare(`
            SELECT C.id, C.name, C.target_percentage, C.color,
                   COALESCE(SUM(A.current_balance), 0) as current_balance
            FROM Classes C
            LEFT JOIN Subcategories S ON S.class_id = C.id
            LEFT JOIN Assets A ON A.subcategory_id = S.id AND A.status = 'active' AND A.is_rebalancing_active = 1
            GROUP BY C.id
        `).all();

        const patrimonyForRebalance = classes.reduce((acc, c) => acc + c.current_balance, 0);
        
        const rebalanceModule = classes.map(c => {
            const currentPercentage = patrimonyForRebalance > 0 ? (c.current_balance / patrimonyForRebalance) * 100 : 0;
            const diffPercentage = currentPercentage - c.target_percentage;
            
            return {
                ...c,
                current_percentage: currentPercentage,
                difference_percentage: diffPercentage,
                // Algoritmo de Conselheiro: Determina ação baseada na variação (margem de erro de 2%)
                action: diffPercentage < -2 ? 'COMPRAR' : (diffPercentage > 2 ? 'AGUARDAR' : 'MANTER')
            };
        });

        // 3. GESTÃO DE OBJETIVOS (Bucketing Financeiro)
        // Calcula o progresso de cada meta baseado nos ativos "carimbados" nela
        const goals = db.prepare(`
            SELECT G.id, G.name, G.target_value, G.deadline, G.status,
                   COALESCE(SUM(A.current_balance), 0) as current_balance
            FROM Goals G
            LEFT JOIN Assets A ON A.goal_id = G.id AND A.status = 'active'
            GROUP BY G.id
        `).all();

        const goalsModule = goals.map(g => {
            const progress = g.target_value > 0 ? (g.current_balance / g.target_value) * 100 : 0;
            return { ...g, progress_percentage: Math.min(progress, 100) };
        });

        // 4. DETALHAMENTOS PARA GRÁFICOS
        // Correção: Agora puxa a cor exata do Ativo (A.color). Se não tiver, puxa da Classe. Se não tiver, usa cinza.
        // E adicionado o filtro A.current_balance > 0 para não poluir a pizza com ativos zerados.
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
            // Totais
            totalAtivos, 
            totalDividas, 
            totalRendimentos,
            totalImpostosDevidos,
            // Gráficos (Pizza)
            fundos,
            dividasLabels: dividasDetalhadas.map(d => d.label),
            dividasValores: dividasDetalhadas.map(d => d.valor),
            // Novos Módulos V2.0
            rebalanceModule,
            goalsModule
        });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

module.exports = router;