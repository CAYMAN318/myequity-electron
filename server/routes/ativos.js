const express = require('express');
const router = express.Router();
const db = require('../database');

// ============================================================================
// 1. LISTAGEM DE ATIVOS (COM CÁLCULO DE PM E RELACIONAMENTOS V2.0)
// ============================================================================
router.get('/', (req, res) => {
    try {
        const assets = db.prepare(`
            SELECT A.*, 
                   S.name as subcategory_name, 
                   C.name as class_name,
                   G.name as goal_name
            FROM Assets A
            LEFT JOIN Subcategories S ON A.subcategory_id = S.id
            LEFT JOIN Classes C ON S.class_id = C.id
            LEFT JOIN Goals G ON A.goal_id = G.id
            ORDER BY A.status, A.name
        `).all();
        
        const enriched = assets.map(asset => {
            const history = db.prepare("SELECT * FROM EquityHistory WHERE asset_id = ? ORDER BY date ASC, id ASC").all(asset.id);
            let totalQty = 0;
            let totalInvestido = 0;
            
            history.forEach(h => {
                if (h.type === 'contribution') {
                    totalQty += h.quantity;
                    totalInvestido += h.amount;
                } else if (h.type === 'withdrawal') {
                    totalQty -= h.quantity;
                    if (totalQty > 0) {
                        totalInvestido -= (totalInvestido / (totalQty + h.quantity)) * h.quantity;
                    } else {
                        totalInvestido = 0;
                    }
                }
            });
            
            asset.total_quantity = totalQty;
            asset.avg_price = totalQty > 0 ? (totalInvestido / totalQty) : 0;
            return asset;
        });
        
        res.json(enriched);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 2. CRIAÇÃO DE NOVO ATIVO
// ============================================================================
router.post('/', (req, res) => {
    const { name, type, color, subcategory_id, goal_id, is_rebalancing_active } = req.body;
    try {
        db.prepare(`
            INSERT INTO Assets (name, type, color, subcategory_id, goal_id, is_rebalancing_active, status)
            VALUES (?, ?, ?, ?, ?, ?, 'active')
        `).run(
            name, 
            type, 
            color || '#3b82f6', 
            subcategory_id || null, 
            goal_id || null, 
            is_rebalancing_active ? 1 : 0
        );
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ============================================================================
// 3. OPERAÇÕES: APORTE E VENDA
// ============================================================================
router.post('/aporte', (req, res) => {
    const { asset_id, quantity, price, date } = req.body;
    try {
        const amount = quantity * price;
        db.prepare("INSERT INTO EquityHistory (asset_id, type, amount, quantity, date) VALUES (?, 'contribution', ?, ?, ?)").run(asset_id, amount, quantity, date);
        db.prepare("UPDATE Assets SET current_balance = current_balance + ? WHERE id = ?").run(amount, asset_id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/venda', (req, res) => {
    const { asset_id, quantity, price, date } = req.body;
    try {
        const asset = db.prepare("SELECT * FROM Assets WHERE id = ?").get(asset_id);
        if (!asset) return res.status(404).json({ error: "Ativo não encontrado" });

        const history = db.prepare("SELECT * FROM EquityHistory WHERE asset_id = ? ORDER BY date ASC, id ASC").all(asset_id);
        let totalQty = 0;
        let totalInvestido = 0;
        
        history.forEach(h => {
            if (h.type === 'contribution') {
                totalQty += h.quantity;
                totalInvestido += h.amount;
            } else if (h.type === 'withdrawal') {
                totalQty -= h.quantity;
                if (totalQty > 0) totalInvestido -= (totalInvestido / (totalQty + h.quantity)) * h.quantity;
            }
        });

        const avgPrice = totalQty > 0 ? (totalInvestido / totalQty) : 0;
        const lucroBrutoOperacao = (price - avgPrice) * quantity;
        let taxDue = 0;

        if (lucroBrutoOperacao > 0) {
            const tipo = asset.type.toUpperCase();
            if (tipo.includes('AÇÃO') || tipo.includes('ACOES') || tipo.includes('BDR')) taxDue = lucroBrutoOperacao * 0.15; 
            else if (tipo.includes('FII') || tipo.includes('ETF') || tipo.includes('FIAGRO') || tipo.includes('INFRA')) taxDue = lucroBrutoOperacao * 0.20;
        }

        const amount = quantity * price;
        db.prepare("INSERT INTO EquityHistory (asset_id, type, amount, quantity, date, tax_due) VALUES (?, 'withdrawal', ?, ?, ?, ?)").run(asset_id, amount, quantity, date, taxDue);
        db.prepare("UPDATE Assets SET current_balance = MAX(0, current_balance - ?) WHERE id = ?").run(amount, asset_id);
        
        res.json({ success: true, lucro_apurado: lucroBrutoOperacao, imposto_gerado: taxDue });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/rendimento', (req, res) => {
    const { asset_id, amount, date } = req.body;
    try {
        db.prepare("INSERT INTO EquityHistory (asset_id, type, amount, quantity, date) VALUES (?, 'dividend', ?, 0, ?)").run(asset_id, amount, date);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 4. SINCRONIZAÇÃO E ATUALIZAÇÃO MANUAL
// ============================================================================
router.post('/sync/:id', async (req, res) => {
    try {
        const asset = db.prepare("SELECT * FROM Assets WHERE id = ?").get(req.params.id);
        if (!asset) return res.status(404).json({ error: "Ativo não encontrado." });

        const history = db.prepare("SELECT type, quantity FROM EquityHistory WHERE asset_id = ?").all(asset.id);
        let totalQty = 0;
        history.forEach(h => {
            if (h.type === 'contribution') totalQty += h.quantity;
            else if (h.type === 'withdrawal') totalQty -= h.quantity;
        });

        if (totalQty <= 0) return res.status(400).json({ error: "Você não possui cotas deste ativo para sincronizar." });

        let currentPrice = 0;

        if (['Ações', 'FIIs', 'BDRs', 'Fiagro', 'FI-Infra', 'Exterior'].includes(asset.type)) {
            const tokenRow = db.prepare("SELECT value FROM Settings WHERE key = 'brapi_token'").get();
            if (!tokenRow || !tokenRow.value) return res.status(400).json({ error: "Token da Brapi não configurado nos parâmetros." });
            
            const response = await fetch(`https://brapi.dev/api/quote/${asset.name}?token=${tokenRow.value}`);
            const data = await response.json();
            
            if (data.error) return res.status(400).json({ error: data.message || "Erro retornado pela Brapi." });
            if (data.results && data.results.length > 0) {
                currentPrice = data.results[0].regularMarketPrice;
            } else {
                return res.status(400).json({ error: "Ticker não localizado na B3." });
            }
        } else if (asset.type === 'Cripto') {
            const map = { 'BTC': 'bitcoin', 'ETH': 'ethereum', 'USDT': 'tether', 'SOL': 'solana' };
            const id = map[asset.name.toUpperCase()] || asset.name.toLowerCase();
            const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=brl`);
            const data = await response.json();
            
            if (data[id] && data[id].brl) {
                currentPrice = data[id].brl;
            } else {
                return res.status(400).json({ error: "Criptomoeda não suportada ou símbolo incorreto na CoinGecko." });
            }
        }
        
        const novoSaldoProjetado = currentPrice * totalQty;
        return res.json({ sugerido: currentPrice, novoSaldo: novoSaldoProjetado });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

router.post('/aplicar-sync/:id', (req, res) => {
    const { novo_saldo } = req.body;
    try {
        if (novo_saldo === undefined || novo_saldo === null) return res.status(400).json({ error: "Valor do novo saldo não fornecido." });
        db.prepare("UPDATE Assets SET current_balance = ? WHERE id = ?").run(novo_saldo, req.params.id);
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ============================================================================
// 5. GESTÃO DE HISTÓRICO (EXTRATO)
// ============================================================================
router.get('/history/:id', (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM EquityHistory WHERE asset_id = ? ORDER BY date DESC, id DESC").all(req.params.id);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', (req, res) => {
    try {
        db.prepare("DELETE FROM Assets WHERE id = ?").run(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// CORREÇÃO: Ao excluir do histórico, o saldo financeiro do ativo é ajustado!
router.delete('/history/:id', (req, res) => {
    try {
        const historyItem = db.prepare("SELECT * FROM EquityHistory WHERE id = ?").get(req.params.id);
        
        if (!historyItem) {
            return res.status(404).json({ error: "Registro não encontrado." });
        }

        // Se for um aporte, subtraímos do saldo atual. Se for venda, devolvemos ao saldo.
        if (historyItem.type === 'contribution') {
            db.prepare("UPDATE Assets SET current_balance = MAX(0, current_balance - ?) WHERE id = ?").run(historyItem.amount, historyItem.asset_id);
        } else if (historyItem.type === 'withdrawal') {
            db.prepare("UPDATE Assets SET current_balance = current_balance + ? WHERE id = ?").run(historyItem.amount, historyItem.asset_id);
        }

        // Após ajustar o saldo, excluímos a linha do extrato
        db.prepare("DELETE FROM EquityHistory WHERE id = ?").run(req.params.id);
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

module.exports = router;