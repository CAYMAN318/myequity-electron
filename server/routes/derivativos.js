const express = require('express');
const router = express.Router();
const db = require('../database');

// ============================================================================
// MIGRAÇÃO SEGURA: Adiciona coluna de garantia se não existir
// ============================================================================
try {
    const columns = db.prepare("PRAGMA table_info(OptionsContracts)").all().map(c => c.name);
    if (!columns.includes('guarantee_asset_id')) {
        db.exec("ALTER TABLE OptionsContracts ADD COLUMN guarantee_asset_id INTEGER;");
    }
} catch (e) { console.error("Erro na migração da tabela de derivativos:", e); }

// ============================================================================
// 1. LISTAR CONTRATOS ATIVOS (Com nome da garantia)
// ============================================================================
router.get('/', (req, res) => {
    try {
        // Traz as opções e faz o Join com a tabela Assets para pegar o nome do CDB/Tesouro usado como garantia
        const contracts = db.prepare(`
            SELECT O.*, A.name as guarantee_asset_name
            FROM OptionsContracts O
            LEFT JOIN Assets A ON O.guarantee_asset_id = A.id
            WHERE O.status = 'active' 
            ORDER BY O.expiration_date ASC
        `).all();
        
        res.json(contracts);
    } catch (err) {
        console.error("Erro ao listar derivativos:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// 2. LANÇAR NOVO CONTRATO (ABRIR POSIÇÃO COM DEFESA)
// ============================================================================
router.post('/', (req, res) => {
    const { tipo, ativoBase, tickerOpcao, quantidade, strike, premioUnico, vencimento, estilo, guarantee_asset_id } = req.body;
    
    // 1ª TRAVA DE SEGURANÇA: Evita erro 500 de "cannot read properties of undefined (reading 'toUpperCase')"
    if (!ativoBase || !tickerOpcao) {
        return res.status(400).json({ error: "O Ticker da Opção e o Ativo Subjacente são obrigatórios." });
    }

    // 2ª TRAVA DE SEGURANÇA: Se for PUT, a garantia financeira é obrigatória
    if (tipo === 'put' && !guarantee_asset_id) {
        return res.status(400).json({ error: "Para lançar uma Venda de Put, selecione o ativo de Renda Fixa/Caixa que servirá de garantia." });
    }

    const totalPremium = parseFloat(quantidade) * parseFloat(premioUnico);
    const openDate = new Date().toISOString().split('T')[0];

    try {
        db.prepare(`
            INSERT INTO OptionsContracts (
                type, asset_base, ticker, quantity, strike_price, 
                premium_unit, total_premium, expiration_date, style, open_date, guarantee_asset_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            tipo, ativoBase.toUpperCase(), tickerOpcao.toUpperCase(), 
            parseInt(quantidade), parseFloat(strike), parseFloat(premioUnico), 
            totalPremium, vencimento, estilo, openDate, guarantee_asset_id || null
        );
        res.json({ success: true, message: "Contrato lançado com sucesso." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 3. EDITAR CONTRATO EXISTENTE
// ============================================================================
router.put('/:id', (req, res) => {
    const { tipo, ativoBase, tickerOpcao, quantidade, strike, premioUnico, vencimento, estilo, guarantee_asset_id } = req.body;
    
    if (!ativoBase || !tickerOpcao) {
        return res.status(400).json({ error: "O Ticker da Opção e o Ativo Subjacente são obrigatórios." });
    }

    const totalPremium = parseFloat(quantidade) * parseFloat(premioUnico);

    try {
        db.prepare(`
            UPDATE OptionsContracts SET
                type = ?, asset_base = ?, ticker = ?, quantity = ?, strike_price = ?,
                premium_unit = ?, total_premium = ?, expiration_date = ?, style = ?, guarantee_asset_id = ?
            WHERE id = ?
        `).run(
            tipo, ativoBase.toUpperCase(), tickerOpcao.toUpperCase(), 
            parseInt(quantidade), parseFloat(strike), parseFloat(premioUnico), 
            totalPremium, vencimento, estilo, guarantee_asset_id || null, req.params.id
        );
        res.json({ success: true, message: "Contrato atualizado com sucesso." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 4. EXCLUIR CONTRATO
// ============================================================================
router.delete('/:id', (req, res) => {
    try {
        db.prepare("DELETE FROM OptionsContracts WHERE id = ?").run(req.params.id);
        res.json({ success: true, message: "Contrato removido com sucesso." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// FUNÇÕES AUXILIARES: SPOT E SNAPSHOT (AUTO-CURA)
// ============================================================================
function recalcularAtivoSpot(asset_id, dbInstance) {
    const history = dbInstance.prepare("SELECT * FROM EquityHistory WHERE asset_id = ? ORDER BY date ASC, id ASC").all(asset_id);
    let qty = 0; let invested = 0;

    history.forEach(h => {
        if (h.type === 'contribution') {
            qty += (h.quantity || 0); invested += (h.amount || 0);
        } else if (h.type === 'withdrawal') {
            qty -= (h.quantity || 0);
            if (qty > 0) invested -= (invested / (qty + (h.quantity || 0))) * (h.quantity || 0);
            else invested = 0;
        }
    });

    const pm = qty > 0 ? (invested / qty) : 0;
    dbInstance.prepare(`UPDATE Assets SET total_quantity = ?, avg_price = ?, status = CASE WHEN ? = 0 THEN 'closed' ELSE 'active' END WHERE id = ?`).run(qty, pm, qty, asset_id);
}

function gerarSnapshotHoje(asset_id, dbInstance) {
    const asset = dbInstance.prepare("SELECT current_balance, total_quantity FROM Assets WHERE id = ?").get(asset_id);
    if (!asset) return;
    
    const hoje = new Date().toISOString().split('T')[0];
    const price = asset.total_quantity > 0 ? (asset.current_balance / asset.total_quantity) : 0;
    
    dbInstance.prepare("DELETE FROM AssetSnapshots WHERE asset_id = ? AND date = ?").run(asset_id, hoje);
    dbInstance.prepare(`INSERT INTO AssetSnapshots (asset_id, date, quantity, price, total_value) VALUES (?, ?, ?, ?, ?)`).run(asset_id, hoje, asset.total_quantity, price, asset.current_balance);
}

// ============================================================================
// 5. RECOMPRAR OPÇÃO (Buy to Close / Rolagem)
// ============================================================================
router.put('/:id/recomprar', (req, res) => {
    const { preco_recompra } = req.body;
    const contractId = req.params.id;

    try {
        const contract = db.prepare("SELECT * FROM OptionsContracts WHERE id = ?").get(contractId);
        if (!contract) return res.status(404).json({ error: "Contrato não encontrado." });

        const buybackTotal = parseFloat(preco_recompra) * contract.quantity;
        const realizedProfit = contract.total_premium - buybackTotal;

        db.prepare(`
            UPDATE OptionsContracts 
            SET status = 'closed', buyback_total = ?, realized_profit = ? 
            WHERE id = ?
        `).run(buybackTotal, realizedProfit, contractId);

        res.json({ 
            success: true, 
            message: `Opção recomprada! Lucro/Prejuízo: R$ ${realizedProfit.toFixed(2)}. Suas garantias foram liberadas.`
        });
    } catch (err) {
        console.error("Erro ao recomprar opção:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// 6. ALTERAR STATUS (VIRAR PÓ / EXERCÍCIO) COM INTEGRAÇÃO SPOT
// ============================================================================
router.put('/:id/status', (req, res) => {
    const { status } = req.body; 
    const contractId = req.params.id;
    
    try {
        const contract = db.prepare("SELECT * FROM OptionsContracts WHERE id = ?").get(contractId);
        if (!contract) return res.status(404).json({ error: "Contrato não encontrado." });

        if (status === 'exercised') {
            db.transaction(() => {
                db.prepare("UPDATE OptionsContracts SET status = 'exercised' WHERE id = ?").run(contractId);

                const assetName = contract.asset_base;
                let asset = db.prepare("SELECT * FROM Assets WHERE name = ?").get(assetName);

                const dataOperacao = new Date().toISOString().split('T')[0];
                const valorOperacao = contract.quantity * contract.strike_price;

                if (contract.type === 'put') {
                    // EXERCÍCIO DE PUT: Transforma a garantia financeira num novo ativo físico
                    let assetId;
                    if (!asset) {
                        const insertAsset = db.prepare(`INSERT INTO Assets (name, type, color, is_rebalancing_active, current_balance) VALUES (?, 'Ações', '#3b82f6', 1, ?)`).run(assetName, valorOperacao);
                        assetId = insertAsset.lastInsertRowid;
                    } else {
                        assetId = asset.id;
                        db.prepare("UPDATE Assets SET current_balance = current_balance + ? WHERE id = ?").run(valorOperacao, assetId);
                    }

                    db.prepare(`INSERT INTO EquityHistory (asset_id, type, amount, quantity, date) VALUES (?, 'contribution', ?, ?, ?)`).run(assetId, valorOperacao, contract.quantity, dataOperacao);
                    recalcularAtivoSpot(assetId, db);
                    gerarSnapshotHoje(assetId, db);

                } else if (contract.type === 'call') {
                    // EXERCÍCIO DE CALL
                    if (!asset) throw new Error("Ativo não encontrado na carteira de Investimentos.");
                    
                    const pmAtual = asset.avg_price || 0;
                    if (contract.quantity > asset.total_quantity) throw new Error(`Você possui apenas ${asset.total_quantity} cotas.`);

                    const custoAquisicao = contract.quantity * pmAtual;
                    const lucro = valorOperacao - custoAquisicao;
                    const imposto = lucro > 0 ? lucro * 0.15 : 0; 

                    const novaQtdTotal = Math.max(0, asset.total_quantity - contract.quantity);
                    const novoSaldo = novaQtdTotal === 0 ? 0 : asset.current_balance * (novaQtdTotal / asset.total_quantity);
                    db.prepare("UPDATE Assets SET current_balance = ? WHERE id = ?").run(novoSaldo, asset.id);

                    db.prepare(`INSERT INTO EquityHistory (asset_id, type, amount, quantity, lucro, tax_due, date) VALUES (?, 'withdrawal', ?, ?, ?, ?, ?)`).run(asset.id, valorOperacao, contract.quantity, lucro, imposto, dataOperacao);
                    recalcularAtivoSpot(asset.id, db);
                    gerarSnapshotHoje(asset.id, db);
                }
            })();
            res.json({ success: true, message: `Exercício Confirmado! Carteira atualizada.` });
        } else {
            // VIRAR PÓ -> O lucro total é o prêmio recebido
            db.prepare(`
                UPDATE OptionsContracts 
                SET status = ?, realized_profit = total_premium 
                WHERE id = ?
            `).run(status, contractId);
            res.json({ success: true, message: `Status do contrato atualizado para Virou Pó.` });
        }
        
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;