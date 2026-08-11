const express = require('express');
const router = express.Router();
const db = require('../database');

router.get('/', (req, res) => {
    try {
        // 1. DADOS TOTAIS (Global Spot)
        const totalAtivos = db.prepare("SELECT SUM(current_balance) as total FROM Assets WHERE status = 'active'").get().total || 0;
        const totalDividas = db.prepare(`SELECT SUM(total_principal - (CAST(total_principal AS REAL) / installments_total * installments_paid)) as total FROM Loans WHERE status = 'active'`).get().total || 0;
        const totalRendimentos = db.prepare("SELECT SUM(amount) as total FROM EquityHistory WHERE type = 'dividend'").get().total || 0;
        
        // 2. MÓDULO DE IMPOSTOS (SPOT) E PREJUÍZOS A COMPENSAR
        const totalImpostosDevidos = db.prepare("SELECT SUM(tax_due) as total FROM EquityHistory WHERE tax_due > 0").get().total || 0;
        const prejuizoAcumulado = db.prepare("SELECT SUM(lucro) as total FROM EquityHistory WHERE lucro < 0").get().total || 0;
        
        const impostosAcoesFiis = db.prepare(`
            SELECT EH.id, EH.date, EH.amount as valor_venda, EH.lucro, EH.tax_due as ir_devido, A.name as asset_name
            FROM EquityHistory EH
            JOIN Assets A ON EH.asset_id = A.id
            WHERE EH.tax_due > 0
            ORDER BY EH.date DESC
        `).all();

        const escudoFiscalDetalhados = db.prepare(`
            SELECT EH.id, EH.date, EH.amount as valor_venda, EH.lucro, A.name as asset_name
            FROM EquityHistory EH
            JOIN Assets A ON EH.asset_id = A.id
            WHERE EH.lucro < 0
            ORDER BY EH.date DESC
        `).all();

        // 3. MÓDULO DE DERIVATIVOS (Blind Spot Corrigido e Lucro Realizado Adicionado)
        let derivativosStats = { qtd_contratos: 0, premios_ativos: 0, margem_travada: 0, ir_opcoes: 0, lucro_realizado_opcoes: 0 };
        let impostosOpcoesDetalhados = []; 
        
        try {
            const stats = db.prepare(`
                SELECT 
                    COUNT(CASE WHEN status = 'active' THEN 1 END) as qtd_contratos,
                    SUM(CASE WHEN status = 'active' THEN total_premium ELSE 0 END) as premios_ativos,
                    SUM(CASE WHEN type = 'put' AND status = 'active' THEN (quantity * strike_price) ELSE 0 END) as margem_travada,
                    
                    -- NOVO: O MOTOR DE ÂNIMO (Soma Expiradas + Recompras)
                    SUM(CASE 
                        WHEN status = 'expired' THEN total_premium 
                        WHEN status = 'closed' THEN realized_profit 
                        ELSE 0 
                    END) as lucro_realizado_opcoes,

                    -- CORREÇÃO DE BLIND SPOT: O IR agora pega lucro de recompras também!
                    SUM(CASE 
                        WHEN status = 'expired' THEN total_premium * 0.15 
                        WHEN status = 'closed' AND realized_profit > 0 THEN realized_profit * 0.15
                        ELSE 0 
                    END) as ir_opcoes
            FROM OptionsContracts
            `).get();
            
            if (stats) {
                derivativosStats = {
                    qtd_contratos: stats.qtd_contratos || 0,
                    premios_ativos: stats.premios_ativos || 0,
                    margem_travada: stats.margem_travada || 0,
                    ir_opcoes: stats.ir_opcoes || 0,
                    lucro_realizado_opcoes: stats.lucro_realizado_opcoes || 0
                };
            }

            // CORREÇÃO: O modal agora traz Expiradas E Recompradas com lucro
            impostosOpcoesDetalhados = db.prepare(`
                SELECT id, expiration_date as date, ticker as asset_name, status,
                       CASE WHEN status = 'expired' THEN total_premium ELSE realized_profit END as lucro, 
                       CASE WHEN status = 'expired' THEN (total_premium * 0.15) ELSE (realized_profit * 0.15) END as ir_devido
                FROM OptionsContracts
                WHERE status = 'expired' OR (status = 'closed' AND realized_profit > 0)
                ORDER BY expiration_date DESC
            `).all();
            
        } catch(e) { console.warn("Tabela OptionsContracts ausente."); }

        // 4. DADOS PARA OS GRÁFICOS DE PIZZA
        const classesPie = db.prepare(`
            SELECT C.name as label, SUM(A.current_balance) as valor, C.color
            FROM Assets A 
            JOIN Subcategories S ON A.subcategory_id = S.id 
            JOIN Classes C ON S.class_id = C.id 
            WHERE A.status = 'active' GROUP BY C.id
        `).all();

        const ativosPie = db.prepare(`
            SELECT name as label, current_balance as valor, color 
            FROM Assets WHERE status = 'active' AND current_balance > 0 
            ORDER BY current_balance DESC LIMIT 10
        `).all();

        const dividasDetalhadas = db.prepare(`
            SELECT description as label, 
                   (total_principal - (CAST(total_principal AS REAL) / installments_total * installments_paid)) as valor 
            FROM Loans WHERE status = 'active'
        `).all();

        // 5. REBALANCEAMENTO E BUCKETING
        const rebalanceModule = db.prepare(`
            SELECT A.id, A.name, A.current_balance, A.color, A.subcategory_id,
                   S.class_id, S.name as sub_name, C.name as class_name, C.target_percentage
            FROM Assets A
            JOIN Subcategories S ON A.subcategory_id = S.id
            JOIN Classes C ON S.class_id = C.id
            WHERE A.status = 'active' AND A.is_rebalancing_active = 1
        `).all();

        const goalsModule = db.prepare(`
            SELECT G.id, G.name, G.target_value, G.icon, G.color, SUM(A.current_balance) as current_saved
            FROM Goals G
            LEFT JOIN Assets A ON A.goal_id = G.id AND A.status = 'active'
            GROUP BY G.id
        `).all();

        res.json({ 
            totalAtivos, totalDividas, totalRendimentos,
            totalImpostosDevidos, prejuizoAcumulado, 
            impostosAcoesFiis, escudoFiscalDetalhados, 
            derivativosStats, impostosOpcoesDetalhados, 
            graficos: {
                classes: { labels: classesPie.map(c => c.label), valores: classesPie.map(c => c.valor), cores: classesPie.map(c => c.color) },
                ativos: { labels: ativosPie.map(a => a.label), valores: ativosPie.map(a => a.valor), cores: ativosPie.map(a => a.color) },
                dividas: { labels: dividasDetalhadas.map(d => d.label), valores: dividasDetalhadas.map(d => d.valor) }
            },
            rebalanceModule, goalsModule
        });
    } catch (err) {
        console.error("ERRO GRAVE NO DASHBOARD:", err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;