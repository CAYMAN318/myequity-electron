const express = require('express');
const router = express.Router();
const db = require('../database');
const https = require('https');

// ============================================================================
// FUNÇÃO CENTRAL DE INTEGRIDADE MATEMÁTICA (NOVO)
// Resolve problemas de precisão de decimais (Cripto/Fundos) e dessincronização de cache.
// ============================================================================
function calcularEstadoMatematico(asset_id, dbInstance) {
    const history = dbInstance.prepare("SELECT * FROM EquityHistory WHERE asset_id = ? ORDER BY date ASC, id ASC").all(asset_id);
    let qty = 0;
    let invested = 0;

    history.forEach(h => {
        if (h.type === 'contribution') {
            qty += (h.quantity || 0);
            invested += (h.amount || 0);
        } else if (h.type === 'withdrawal') {
            qty -= (h.quantity || 0);
            if (qty > 0) {
                invested -= (invested / (qty + (h.quantity || 0))) * (h.quantity || 0);
            } else {
                invested = 0;
            }
        }
    });

    return {
        quantidade: qty,
        precoMedio: qty > 0 ? (invested / qty) : 0
    };
}

// ============================================================================
// 1. LISTAGEM DE ATIVOS 
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
            // Usa o novo motor central para enviar dados sempre corretos para a tela
            const estadoReal = calcularEstadoMatematico(asset.id, db);
            asset.avg_price = estadoReal.precoMedio;
            asset.total_quantity = estadoReal.quantidade;
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
// 4. NOVO APORTE (COMPRA)
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

            // Calcula matematicamente o estado real lendo todo o histórico
            const estadoReal = calcularEstadoMatematico(asset_id, db);
            const qtdAntiga = estadoReal.quantidade;
            const pmAntigo = estadoReal.precoMedio;
            
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
// 5. REGISTRAR VENDA (COM TRAVA BLINDADA E TOLERÂNCIA DE DECIMAIS)
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

            // Calcula o estado real blindando contra "Memórias Fantasmas" do DB
            const estadoReal = calcularEstadoMatematico(asset_id, db);

            // A margem de tolerância (0.00000001) impede erros do JavaScript ao comparar cotas de Fundos e Cripto
            if (qtdVendida > (estadoReal.quantidade + 0.00000001)) {
                throw new Error(`Você possui ${estadoReal.quantidade.toFixed(4)} cotas, mas tentou vender ${qtdVendida.toFixed(4)}.`);
            }

            const custoDeAquisicao = qtdVendida * estadoReal.precoMedio;
            lucroRealizado = valorBrutoVenda - custoDeAquisicao;

            if (lucroRealizado > 0) {
                if (['FIIs', 'Fiagro', 'FI-Infra'].includes(asset.type)) {
                    impostoGerado = lucroRealizado * 0.20;
                } else if (['Ações', 'BDRs', 'Cripto', 'Exterior'].includes(asset.type)) {
                    impostoGerado = lucroRealizado * 0.15;
                }
            }

            const novaQtdTotal = Math.max(0, estadoReal.quantidade - qtdVendida);
            const novoSaldo = novaQtdTotal === 0 ? 0 : asset.current_balance * (novaQtdTotal / estadoReal.quantidade);

            db.prepare(`
                UPDATE Assets 
                SET total_quantity = ?, current_balance = ? 
                WHERE id = ?
            `).run(novaQtdTotal, novoSaldo, asset_id);

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
// 7. SINCRONIZAR COTAÇÃO (BRAPI / BINANCE)
// ============================================================================
router.post('/sync/:id', (req, res) => {
    try {
        const asset = db.prepare("SELECT * FROM Assets WHERE id = ?").get(req.params.id);
        if (!asset) return res.status(404).json({ error: "Ativo não encontrado." });

        let tickerLimpo = asset.name.trim().toUpperCase();
        const isCripto = (asset.type === 'Cripto');

        // Puxa a quantidade exata para calcular o saldo projetado
        const qtdExata = calcularEstadoMatematico(asset.id, db).quantidade;

        if (isCripto) {
            tickerLimpo = tickerLimpo.replace('-', '').replace('BRL', '') + 'BRL';
            const urlBinance = `https://api.binance.com/api/v3/ticker/price?symbol=${tickerLimpo}`;

            https.get(urlBinance, (response) => {
                let data = '';
                response.on('data', (chunk) => data += chunk);
                response.on('end', () => {
                    try {
                        if (response.statusCode !== 200) {
                            return res.status(400).json({ error: `Criptomoeda '${tickerLimpo}' não encontrada na Binance.` });
                        }
                        
                        const jsonData = JSON.parse(data);
                        const precoMercado = parseFloat(jsonData.price);
                        
                        if (isNaN(precoMercado)) {
                            return res.status(400).json({ error: "Preço indisponível na Binance hoje." });
                        }

                        const novoSaldo = qtdExata * precoMercado;
                        return res.json({ sugerido: precoMercado, novoSaldo: novoSaldo });
                    } catch (parseErr) {
                        return res.status(500).json({ error: "Erro ao interpretar dados da Binance." });
                    }
                });
            }).on('error', (err) => {
                return res.status(500).json({ error: `Falha de conexão com a Binance: ${err.message}` });
            });

        } else {
            const settingsRow = db.prepare("SELECT value FROM Settings WHERE key = 'brapi_token'").get();
            const BRAPI_TOKEN = settingsRow ? settingsRow.value : '';

            if (!BRAPI_TOKEN) {
                return res.status(400).json({ error: "Token da Brapi não configurado. Por favor, adicione na página de Parâmetros." });
            }

            const urlBrapi = `https://brapi.dev/api/quote/${tickerLimpo}?token=${BRAPI_TOKEN}`;

            https.get(urlBrapi, (response) => {
                let data = '';
                response.on('data', (chunk) => data += chunk);
                response.on('end', () => {
                    try {
                        const jsonData = JSON.parse(data);

                        if (response.statusCode !== 200 || jsonData.error) {
                            const errorMsg = jsonData.message || jsonData.error || 'Erro desconhecido';
                            return res.status(400).json({ error: `Recusa da Brapi [Status ${response.statusCode}]: ${errorMsg}` });
                        }

                        if (jsonData.results && jsonData.results.length > 0) {
                            const precoMercado = jsonData.results[0].regularMarketPrice;
                            
                            if (precoMercado === undefined || precoMercado === null) {
                                return res.status(400).json({ error: "A Brapi encontrou o ativo, mas o preço não está disponível hoje." });
                            }

                            const novoSaldo = qtdExata * precoMercado;
                            return res.json({ sugerido: precoMercado, novoSaldo: novoSaldo });
                        } else {
                            return res.status(400).json({ error: `Ticker '${tickerLimpo}' não encontrado na Bolsa.` });
                        }
                    } catch (parseErr) {
                        return res.status(500).json({ error: "Erro ao interpretar os dados da Brapi." });
                    }
                });
            }).on('error', (err) => {
                return res.status(500).json({ error: `Falha de conexão: ${err.message}` });
            });
        }
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ============================================================================
// 8. APLICAR NOVO SALDO (ATUALIZAÇÃO MANUAL OU VIA SYNC)
// ============================================================================
router.post('/aplicar-sync/:id', (req, res) => {
    const { novo_saldo } = req.body;
    try {
        const asset = db.prepare("SELECT * FROM Assets WHERE id = ?").get(req.params.id);
        if (!asset) return res.status(404).json({ error: "Ativo não encontrado." });

        db.prepare("UPDATE Assets SET current_balance = ? WHERE id = ?").run(novo_saldo, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 9. EXTRATO HISTÓRICO DE UM ATIVO
// ============================================================================
router.get('/history/:id', (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM EquityHistory WHERE asset_id = ? ORDER BY date ASC, id ASC").all(req.params.id);
        
        let totalQty = 0;
        let totalInvestido = 0;
        const historicoEnriquecido = [];

        rows.forEach(row => {
            let pmAtual = totalQty > 0 ? (totalInvestido / totalQty) : 0;
            let lucroCalculado = row.lucro || 0; 

            if (row.type === 'contribution') {
                totalQty += (row.quantity || 0);
                totalInvestido += (row.amount || 0);
            } else if (row.type === 'withdrawal') {
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

            if (['contribution', 'withdrawal', 'dividend'].includes(row.type)) {
                historicoEnriquecido.push({
                    ...row,
                    ir_devido: row.tax_due || 0,
                    lucro: lucroCalculado
                });
            }
        });

        historicoEnriquecido.sort((a, b) => {
            if (b.date === a.date) return b.id - a.id;
            return new Date(b.date) - new Date(a.date);
        });

        res.json(historicoEnriquecido);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 10. EXCLUIR ITEM DO HISTÓRICO (SEMPRE RECALCULA O CACHE DO BANCO)
// ============================================================================
router.delete('/history/:id', (req, res) => {
    try {
        const historyItem = db.prepare("SELECT * FROM EquityHistory WHERE id = ?").get(req.params.id);
        
        if (!historyItem) {
            return res.status(404).json({ error: "Registro não encontrado." });
        }

        const assetId = historyItem.asset_id;

        // Estorno proporcional do Saldo Financeiro
        if (historyItem.type === 'contribution') {
            db.prepare("UPDATE Assets SET current_balance = MAX(0, current_balance - ?) WHERE id = ?").run(historyItem.amount, assetId);
        } else if (historyItem.type === 'withdrawal') {
            db.prepare("UPDATE Assets SET current_balance = current_balance + ? WHERE id = ?").run(historyItem.amount, assetId);
        }

        // Deleta do Extrato
        db.prepare("DELETE FROM EquityHistory WHERE id = ?").run(req.params.id);

        // AUTOCURA DO BANCO DE DADOS: Atualiza o cache do Asset para nunca ficar dessincronizado
        const estadoCurado = calcularEstadoMatematico(assetId, db);
        db.prepare("UPDATE Assets SET total_quantity = ?, avg_price = ? WHERE id = ?").run(estadoCurado.quantidade, estadoCurado.precoMedio, assetId);

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;