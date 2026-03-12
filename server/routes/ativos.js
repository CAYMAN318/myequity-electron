const express = require('express');
const router = express.Router();
const db = require('../database');

// 1. Obter todos os ativos com cálculos (Quantidade e Preço Médio)
router.get('/', (req, res) => {
    try {
        const assets = db.prepare("SELECT * FROM Assets ORDER BY status, name").all();
        
        const enriched = assets.map(asset => {
            const history = db.prepare("SELECT * FROM EquityHistory WHERE asset_id = ?").all(asset.id);
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

// 2. Aporte
router.post('/aporte', (req, res) => {
    const { asset_id, quantity, price, date } = req.body;
    const amount = quantity * price;
    try {
        db.transaction(() => {
            db.prepare(`INSERT INTO EquityHistory (asset_id, type, amount, quantity, date) VALUES (?, 'contribution', ?, ?, ?)`).run(asset_id, amount, quantity, date);
            db.prepare(`UPDATE Assets SET current_balance = current_balance + ? WHERE id = ?`).run(amount, asset_id);
        })();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. Venda
router.post('/venda', (req, res) => {
    const { asset_id, quantity, price, date } = req.body;
    const amount = quantity * price;
    try {
        db.transaction(() => {
            db.prepare(`INSERT INTO EquityHistory (asset_id, type, amount, quantity, date) VALUES (?, 'withdrawal', ?, ?, ?)`).run(asset_id, amount, quantity, date);
            db.prepare(`UPDATE Assets SET current_balance = MAX(0, current_balance - ?) WHERE id = ?`).run(amount, asset_id);
        })();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. Rendimentos (Proventos / Dividendos)
router.post('/rendimentos', (req, res) => {
    const { asset_id, amount, date } = req.body;
    try {
        db.prepare(`INSERT INTO EquityHistory (asset_id, type, amount, quantity, date) VALUES (?, 'dividend', ?, 0, ?)`).run(asset_id, amount, date);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. Histórico do Ativo
router.get('/history/:id', (req, res) => {
    try {
        const history = db.prepare("SELECT * FROM EquityHistory WHERE asset_id = ? ORDER BY date DESC, id DESC").all(req.params.id);
        res.json(history);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. Editar Histórico
router.put('/history/:id', (req, res) => {
    const { amount, quantity, date } = req.body;
    try {
        db.prepare(`UPDATE EquityHistory SET amount = ?, quantity = ?, date = ? WHERE id = ?`).run(amount, quantity, date, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 7. Excluir Histórico
router.delete('/history/:id', (req, res) => {
    try {
        db.prepare("DELETE FROM EquityHistory WHERE id = ?").run(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. Rota de Busca de Tickers (Usada nos Parâmetros)
router.get('/search-ticker', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json([]);
    
    try {
        const tokenRow = db.prepare("SELECT value FROM Settings WHERE key = 'BRAPI_TOKEN'").get();
        const token = tokenRow ? tokenRow.value : '';
        
        if (token) {
            const response = await fetch(`https://brapi.dev/api/available?search=${query}&token=${token}`);
            const data = await response.json();
            const stocks = (data.stocks || []).slice(0, 5).map(ticker => ({ ticker, name: ticker, type: 'Ações' }));
            return res.json(stocks);
        }
        res.json([]);
    } catch (err) { res.json([]); }
});

// 9. NOVO: Sincronização de Mercado (A Rota que faltava para evitar o Erro 404)
router.post('/sync', async (req, res) => {
    const { asset_id, confirmar, novoSaldo } = req.body;
    
    try {
        if (confirmar) {
            // Efetivação da Sincronização
            const asset = db.prepare("SELECT current_balance FROM Assets WHERE id = ?").get(asset_id);
            const diferenca = novoSaldo - (asset ? asset.current_balance : 0);
            
            db.transaction(() => {
                db.prepare("UPDATE Assets SET current_balance = ?, last_sync = date('now') WHERE id = ?").run(novoSaldo, asset_id);
                // Registra o ganho ou perda no histórico (market_update)
                if (diferenca !== 0) {
                    db.prepare(`
                        INSERT INTO EquityHistory (asset_id, type, amount, quantity, date)
                        VALUES (?, 'market_update', ?, 0, date('now'))
                    `).run(asset_id, diferenca);
                }
            })();
            return res.json({ success: true });
        } else {
            // Modo de Simulação (Busca cotação online e sugere valor)
            const asset = db.prepare("SELECT name, type FROM Assets WHERE id = ?").get(asset_id);
            if (!asset) return res.status(404).json({ error: "Ativo não encontrado." });
            
            // Verifica Qtd Total
            const qtyRow = db.prepare(`SELECT SUM(CASE WHEN type = 'contribution' THEN quantity WHEN type = 'withdrawal' THEN -quantity ELSE 0 END) as total_qty FROM EquityHistory WHERE asset_id = ?`).get(asset_id);
            const totalQty = qtyRow ? qtyRow.total_qty : 0;
            let currentPrice = 0;
            
            if (asset.type === 'Ações' || asset.type === 'FIIs') {
                const tokenRow = db.prepare("SELECT value FROM Settings WHERE key = 'BRAPI_TOKEN'").get();
                const token = tokenRow ? tokenRow.value : '';
                if (!token) return res.status(400).json({ error: "Token Brapi ausente nos Parâmetros." });
                
                const response = await fetch(`https://brapi.dev/api/quote/${asset.name}?token=${token}`);
                const data = await response.json();
                if (data.error) return res.status(400).json({ error: data.message || "Erro na B3." });
                if (data.results && data.results.length > 0) {
                    currentPrice = data.results[0].regularMarketPrice;
                } else {
                    return res.status(400).json({ error: "Ticker não localizado na B3." });
                }
            } else if (asset.type === 'Cripto') {
                const map = { 'BTC': 'bitcoin', 'ETH': 'ethereum', 'USDT': 'tether' };
                const id = map[asset.name.toUpperCase()] || asset.name.toLowerCase();
                const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=brl`);
                const data = await response.json();
                if (data[id] && data[id].brl) {
                    currentPrice = data[id].brl;
                } else {
                    return res.status(400).json({ error: "Criptomoeda não suportada ou símbolo incorreto." });
                }
            } else {
                return res.status(400).json({ error: "Atualização automática indisponível para esta classe." });
            }
            
            const novoSaldoProjetado = currentPrice * totalQty;
            return res.json({ sugerido: currentPrice, novoSaldo: novoSaldoProjetado });
        }
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

module.exports = router;