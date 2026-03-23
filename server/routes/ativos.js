const express = require('express');
const router = express.Router();
const db = require('../database');

// ============================================================================
// 1. LISTAGEM DE ATIVOS (COM CÁLCULO DINÂMICO DE PM E RELACIONAMENTOS)
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
                    totalQty += (h.quantity || 0);
                    totalInvestido += (h.amount || 0);
                } else if (h.type === 'withdrawal') {
                    totalQty -= (h.quantity || 0);
                    if (totalQty > 0) {
                        totalInvestido -= (totalInvestido / (totalQty + (h.quantity || 0))) * (h.quantity || 0);
                    } else {
                        totalInvestido = 0;
                    }
                }
            });
            
            // Recalcula o PM em tempo real para ser imune a exclusões manuais de histórico
            asset.avg_price = totalQty > 0 ? (totalInvestido / totalQty) : 0;
            asset.total_quantity = totalQty;
            
            return asset;
        });

        res.json(enriched);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 2. CRIAR NOVO ATIVO
// ============================================================================
router.post('/', (req, res) => {
    const { name, type, color, subcategory_id, goal_id, is_rebalancing_active } = req.body;
    try {
        db.prepare(`
            INSERT INTO Assets (name, type, color, subcategory_id, goal_id, is_rebalancing_active) 
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(name, type, color || '#3b82f6', subcategory_id || null, goal_id || null, is_rebalancing_active ? 1 : 0);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 3. EXCLUIR ATIVO
// ============================================================================
router.delete('/:id', (req, res) => {
    try {
        db.prepare("DELETE FROM Assets WHERE id = ?").run(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 4. NOVO APORTE (COMPRA) - Atualiza PM e Saldo
// ============================================================================
router.post('/aporte', (req, res) => {
    const { asset_id, quantity, price, date } = req.body;
    const qtd = parseFloat(quantity);
    const preco = parseFloat(price);
    const valorTotal = qtd * preco;

    try {
        const insertTransaction = db.transaction(() => {
            const asset = db.prepare("SELECT * FROM Assets WHERE id = ?").get(asset_id);
            if (!asset) throw new Error("Ativo não encontrado.");

            const qtdAntiga = asset.total_quantity || 0;
            const pmAntigo = asset.avg_price || 0;
            
            const novaQtdTotal = qtdAntiga + qtd;
            const novoPM = ((qtdAntiga * pmAntigo) + valorTotal) / novaQtdTotal;
            const novoSaldo = asset.current_balance + valorTotal;

            db.prepare(`
                UPDATE Assets 
                SET total_quantity = ?, avg_price = ?, current_balance = ? 
                WHERE id = ?
            `).run(novaQtdTotal, novoPM, novoSaldo, asset_id);

            db.prepare(`
                INSERT INTO EquityHistory (asset_id, type, amount, quantity, date) 
                VALUES (?, 'contribution', ?, ?, ?)
            `).run(asset_id, valorTotal, qtd, date);
        });

        insertTransaction();
        res.json({ success: true, message: "Aporte registrado e Preço Médio atualizado!" });
    } catch (err) {
        console.error("Erro no Aporte:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// 5. REGISTRAR VENDA - Calcula Lucro e Provisão de Imposto
// ============================================================================
router.post('/venda', (req, res) => {
    const { asset_id, quantity, price, date } = req.body;
    const qtdVendida = parseFloat(quantity);
    const precoVenda = parseFloat(price);
    const valorBrutoVenda = qtdVendida * precoVenda;

    try {
        let lucroRealizado = 0;
        let impostoGerado = 0;

        const sellTransaction = db.transaction(() => {
            const asset = db.prepare("SELECT * FROM Assets WHERE id = ?").get(asset_id);
            if (!asset) throw new Error("Ativo não encontrado.");

            if (qtdVendida > asset.total_quantity) {
                throw new Error("Você não possui cotas suficientes para esta venda.");
            }

            const custoDeAquisicao = qtdVendida * asset.avg_price;
            lucroRealizado = valorBrutoVenda - custoDeAquisicao;

            if (lucroRealizado > 0) {
                if (['FIIs', 'Fiagro', 'FI-Infra'].includes(asset.type)) {
                    impostoGerado = lucroRealizado * 0.20;
                } else if (['Ações', 'BDRs', 'Cripto', 'Exterior'].includes(asset.type)) {
                    impostoGerado = lucroRealizado * 0.15;
                }
            }

            const novaQtdTotal = asset.total_quantity - qtdVendida;
            const novoSaldo = novaQtdTotal === 0 ? 0 : asset.current_balance * (novaQtdTotal / asset.total_quantity);

            db.prepare(`
                UPDATE Assets 
                SET total_quantity = ?, current_balance = ? 
                WHERE id = ?
            `).run(novaQtdTotal, novoSaldo, asset_id);

            // Grava colunas lucro e tax_due
            db.prepare(`
                INSERT INTO EquityHistory (asset_id, type, amount, quantity, lucro, tax_due, date) 
                VALUES (?, 'withdrawal', ?, ?, ?, ?, ?)
            `).run(asset_id, valorBrutoVenda, qtdVendida, lucroRealizado, impostoGerado, date);
        });

        sellTransaction();
        
        res.json({ 
            success: true, 
            imposto_gerado: impostoGerado,
            lucro: lucroRealizado,
            message: "Venda registrada com sucesso." 
        });
    } catch (err) {
        console.error("Erro na Venda:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// 6. REGISTRAR RENDIMENTO (PROVENTO)
// ============================================================================
router.post('/rendimento', (req, res) => {
    const { asset_id, amount, date } = req.body;
    try {
        db.prepare(`
            INSERT INTO EquityHistory (asset_id, type, amount, date) 
            VALUES (?, 'dividend', ?, ?)
        `).run(asset_id, parseFloat(amount), date);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 7. SINCRONIZAR COTAÇÃO (MOCK / PLACEHOLDER PARA API EXTERNA)
// ============================================================================
router.post('/sync/:id', async (req, res) => {
    try {
        const asset = db.prepare("SELECT * FROM Assets WHERE id = ?").get(req.params.id);
        if (!asset) return res.status(404).json({ error: "Ativo não encontrado." });
        
        // Espaço reservado para a sua integração com Brapi / HG Finance
        const precoMercado = asset.avg_price || 0; 
        const novoSaldo = asset.total_quantity * precoMercado;
        
        res.json({ sugerido: precoMercado, novoSaldo: novoSaldo });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 8. APLICAR NOVO SALDO (ATUALIZAÇÃO MANUAL OU VIA SYNC)
// ============================================================================
router.post('/aplicar-sync/:id', (req, res) => {
    const { novo_saldo } = req.body;
    try {
        const asset = db.prepare("SELECT * FROM Assets WHERE id = ?").get(req.params.id);
        if (!asset) return res.status(404).json({ error: "Ativo não encontrado." });

        const diff = parseFloat(novo_saldo) - asset.current_balance;

        db.transaction(() => {
            db.prepare("UPDATE Assets SET current_balance = ? WHERE id = ?").run(novo_saldo, req.params.id);
            db.prepare(`
                INSERT INTO EquityHistory (asset_id, type, amount, date) 
                VALUES (?, 'market_update', ?, date('now'))
            `).run(req.params.id, diff);
        })();

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 9. EXTRATO HISTÓRICO DE UM ATIVO (CÁLCULO DINÂMICO DE LUCRO)
// ============================================================================
router.get('/history/:id', (req, res) => {
    try {
        // Puxa do mais antigo para o mais novo para calcular o Preço Médio sequencialmente
        const rows = db.prepare("SELECT * FROM EquityHistory WHERE asset_id = ? ORDER BY date ASC, id ASC").all(req.params.id);
        
        let totalQty = 0;
        let totalInvestido = 0;
        const historicoEnriquecido = [];

        rows.forEach(row => {
            let pmAtual = totalQty > 0 ? (totalInvestido / totalQty) : 0;
            let lucroCalculado = row.lucro || 0; // Tenta usar o do banco primeiro

            if (row.type === 'contribution') {
                totalQty += (row.quantity || 0);
                totalInvestido += (row.amount || 0);
            } else if (row.type === 'withdrawal') {
                // SE O LUCRO ESTIVER ZERADO NO BANCO, NÓS CALCULAMOS RETROATIVAMENTE AQUI!
                if (!row.lucro && row.quantity > 0) {
                    const custoAquisicao = (row.quantity || 0) * pmAtual;
                    lucroCalculado = (row.amount || 0) - custoAquisicao;
                }

                totalQty -= (row.quantity || 0);
                if (totalQty > 0) {
                    totalInvestido -= pmAtual * (row.quantity || 0);
                } else {
                    totalInvestido = 0;
                }
            }

            historicoEnriquecido.push({
                ...row,
                ir_devido: row.tax_due || 0,
                lucro: lucroCalculado // Envia o lucro real sempre calculado
            });
        });

        // O Frontend (investimentos.html) espera a lista decrescente (mais recente primeiro)
        historicoEnriquecido.sort((a, b) => {
            if (b.date === a.date) return b.id - a.id;
            return new Date(b.date) - new Date(a.date);
        });

        res.json(historicoEnriquecido);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 10. EXCLUIR ITEM DO HISTÓRICO (COM AJUSTE ESTORNO DE SALDO)
// ============================================================================
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
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;