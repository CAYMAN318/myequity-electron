const express = require('express');
const router = express.Router();
const db = require('../database');

// ============================================================================
// FUNÇÃO CENTRAL MATEMÁTICA: GLOBAL (USD / BRL)
// Calcula Qtd, PM em Dólar e Câmbio Médio ponderado pelo volume das remessas.
// ============================================================================
function calcularEstadoGlobal(asset_id, dbInstance) {
    const history = dbInstance.prepare("SELECT * FROM GlobalHistory WHERE asset_id = ? ORDER BY date ASC, id ASC").all(asset_id);
    
    let qty = 0;
    let investedUsd = 0;
    let totalBrlSpent = 0;

    history.forEach(h => {
        if (h.type === 'buy') {
            qty += (h.quantity || 0);
            investedUsd += (h.amount_usd || 0);
            totalBrlSpent += ((h.amount_usd || 0) * (h.exchange_rate || 0));
        } else if (h.type === 'sell') {
            qty -= (h.quantity || 0);
            if (qty > 0) {
                const proportion = (h.quantity || 0) / (qty + (h.quantity || 0));
                investedUsd -= (investedUsd * proportion);
                totalBrlSpent -= (totalBrlSpent * proportion);
            } else {
                investedUsd = 0;
                totalBrlSpent = 0;
            }
        }
    });

    return {
        quantidade: qty,
        precoMedioUsd: qty > 0 ? (investedUsd / qty) : 0,
        cambioMedioBrl: investedUsd > 0 ? (totalBrlSpent / investedUsd) : 0
    };
}

// ============================================================================
// 1. LISTAR ATIVOS GLOBAIS
// ============================================================================
router.get('/', (req, res) => {
    try {
        const assets = db.prepare("SELECT * FROM GlobalAssets WHERE status = 'active' ORDER BY ticker ASC").all();
        
        // Puxa histórico para Proventos e Atualiza Saldo Real
        const enriched = assets.map(asset => {
            const history = db.prepare("SELECT * FROM GlobalHistory WHERE asset_id = ?").all(asset.id);
            const proventos = history.filter(h => h.type === 'dividend').reduce((acc, h) => acc + h.amount_usd, 0);
            
            const estadoReal = calcularEstadoGlobal(asset.id, db);
            
            return {
                ...asset,
                total_quantity: estadoReal.quantidade,
                avg_price_usd: estadoReal.precoMedioUsd,
                avg_exchange_rate: estadoReal.cambioMedioBrl,
                proventos_acumulados: proventos
            };
        });

        res.json(enriched);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 2. CRIAR NOVO ATIVO GLOBAL (METADADOS)
// ============================================================================
router.post('/', (req, res) => {
    const { ticker, name, type } = req.body;
    try {
        db.prepare(`
            INSERT INTO GlobalAssets (ticker, name, type) 
            VALUES (?, ?, ?)
        `).run(ticker.toUpperCase(), name, type);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 3. EDITAR ATIVO GLOBAL
// ============================================================================
router.put('/:id', (req, res) => {
    const { ticker, name, type } = req.body;
    try {
        db.prepare(`
            UPDATE GlobalAssets SET ticker = ?, name = ?, type = ? WHERE id = ?
        `).run(ticker.toUpperCase(), name, type, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 4. REGISTRAR COMPRA (BUY / REMESSA)
// ============================================================================
router.post('/buy', (req, res) => {
    const { asset_id, quantity, price_usd, exchange_rate, date } = req.body;
    const qty = parseFloat(quantity);
    const preco = parseFloat(price_usd);
    const cambio = parseFloat(exchange_rate);
    const valorTotalUSD = qty * preco;

    try {
        db.transaction(() => {
            const asset = db.prepare("SELECT * FROM GlobalAssets WHERE id = ?").get(asset_id);
            if (!asset) throw new Error("Ativo não encontrado.");

            const estadoReal = calcularEstadoGlobal(asset_id, db);
            const novaQtdTotal = estadoReal.quantidade + qty;
            const novoSaldo = asset.current_balance_usd + valorTotalUSD;

            db.prepare(`INSERT INTO GlobalHistory (asset_id, type, amount_usd, quantity, exchange_rate, date) VALUES (?, 'buy', ?, ?, ?, ?)`).run(asset_id, valorTotalUSD, qty, cambio, date);
            
            // Recalcula logo após a inserção para atualizar a tabela principal
            const novoEstado = calcularEstadoGlobal(asset_id, db);
            
            db.prepare(`UPDATE GlobalAssets SET total_quantity = ?, avg_price_usd = ?, avg_exchange_rate = ?, current_balance_usd = ? WHERE id = ?`).run(novoEstado.quantidade, novoEstado.precoMedioUsd, novoEstado.cambioMedioBrl, novoSaldo, asset_id);
        })();

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 5. REGISTRAR VENDA (SELL) E CALCULAR LUCRO
// ============================================================================
router.post('/sell', (req, res) => {
    const { asset_id, quantity, price_usd, date } = req.body;
    const qtyVendida = parseFloat(quantity);
    const precoVenda = parseFloat(price_usd);
    const valorBrutoUSD = qtyVendida * precoVenda;

    try {
        let lucroRealizadoUSD = 0;

        db.transaction(() => {
            const asset = db.prepare("SELECT * FROM GlobalAssets WHERE id = ?").get(asset_id);
            if (!asset) throw new Error("Ativo não encontrado.");

            const estadoReal = calcularEstadoGlobal(asset_id, db);

            if (qtyVendida > (estadoReal.quantidade + 0.000001)) {
                throw new Error(`Tentativa de vender mais cotas do que possui.`);
            }

            const custoDeAquisicaoUSD = qtyVendida * estadoReal.precoMedioUsd;
            lucroRealizadoUSD = valorBrutoUSD - custoDeAquisicaoUSD;

            const exchangeRateSale = estadoReal.cambioMedioBrl; // Usamos o câmbio médio como base neutra na venda (Regra IRPF fará o resto)

            db.prepare(`INSERT INTO GlobalHistory (asset_id, type, amount_usd, quantity, exchange_rate, taxes_usd, date) VALUES (?, 'sell', ?, ?, ?, ?, ?)`).run(asset_id, valorBrutoUSD, qtyVendida, exchangeRateSale, lucroRealizadoUSD, date);

            const novaQtdTotal = Math.max(0, estadoReal.quantidade - qtyVendida);
            const novoSaldo = novaQtdTotal === 0 ? 0 : asset.current_balance_usd * (novaQtdTotal / estadoReal.quantidade);

            db.prepare(`UPDATE GlobalAssets SET total_quantity = ?, current_balance_usd = ? WHERE id = ?`).run(novaQtdTotal, novoSaldo, asset_id);
        })();

        res.json({ success: true, lucro_usd: lucroRealizadoUSD });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 6. REGISTRAR DIVIDENDOS (DIVS COM IMPOSTO RETIDO)
// ============================================================================
router.post('/dividend', (req, res) => {
    const { asset_id, amount_usd, taxes_usd, date } = req.body;
    try {
        db.prepare(`INSERT INTO GlobalHistory (asset_id, type, amount_usd, taxes_usd, date) VALUES (?, 'dividend', ?, ?, ?)`).run(asset_id, parseFloat(amount_usd), parseFloat(taxes_usd || 0), date);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 7. ATUALIZAÇÃO MANUAL DE COTAÇÃO
// ============================================================================
router.post('/sync-manual/:id', (req, res) => {
    const { novo_saldo_usd } = req.body;
    try {
        db.prepare("UPDATE GlobalAssets SET current_balance_usd = ? WHERE id = ?").run(novo_saldo_usd, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 8. EXTRATO HISTÓRICO
// ============================================================================
router.get('/history/:id', (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM GlobalHistory WHERE asset_id = ? ORDER BY date DESC, id DESC").all(req.params.id);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 9. DELETAR HISTÓRICO (AUTO-CURA)
// ============================================================================
router.delete('/history/:id', (req, res) => {
    try {
        const historyItem = db.prepare("SELECT * FROM GlobalHistory WHERE id = ?").get(req.params.id);
        if (!historyItem) return res.status(404).json({ error: "Registro não encontrado." });

        const assetId = historyItem.asset_id;

        if (historyItem.type === 'buy') {
            db.prepare("UPDATE GlobalAssets SET current_balance_usd = MAX(0, current_balance_usd - ?) WHERE id = ?").run(historyItem.amount_usd, assetId);
        } else if (historyItem.type === 'sell') {
            db.prepare("UPDATE GlobalAssets SET current_balance_usd = current_balance_usd + ? WHERE id = ?").run(historyItem.amount_usd, assetId);
        }

        db.prepare("DELETE FROM GlobalHistory WHERE id = ?").run(req.params.id);

        const estadoCurado = calcularEstadoGlobal(assetId, db);
        db.prepare(`UPDATE GlobalAssets SET total_quantity = ?, avg_price_usd = ?, avg_exchange_rate = ? WHERE id = ?`).run(estadoCurado.quantidade, estadoCurado.precoMedioUsd, estadoCurado.cambioMedioBrl, assetId);
        
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 10. DELETAR ATIVO GLOBAL
// ============================================================================
router.delete('/:id', (req, res) => {
    try {
        db.prepare("UPDATE GlobalAssets SET status = 'deleted' WHERE id = ?").run(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;