const express = require('express');
const router = express.Router();
const db = require('../database');
const https = require('https');

// ============================================================================
// FUNÇÕES DE INTEGRIDADE MATEMÁTICA E SNAPSHOTS
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

function gerarSnapshotHoje(asset_id, dbInstance) {
    const asset = dbInstance.prepare("SELECT current_balance FROM Assets WHERE id = ?").get(asset_id);
    if (!asset) return;
    
    const estado = calcularEstadoMatematico(asset_id, dbInstance);
    const hoje = new Date().toISOString().split('T')[0];
    const price = estado.quantidade > 0 ? (asset.current_balance / estado.quantidade) : 0;
    
    dbInstance.prepare("DELETE FROM AssetSnapshots WHERE asset_id = ? AND date = ?").run(asset_id, hoje);
    dbInstance.prepare(`
        INSERT INTO AssetSnapshots (asset_id, date, quantity, price, total_value)
        VALUES (?, ?, ?, ?, ?)
    `).run(asset_id, hoje, estado.quantidade, price, asset.current_balance);
}

// ============================================================================
// 1. LISTAGEM DE ATIVOS (COM CÁLCULO DE GARANTIAS DE DERIVATIVOS)
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
        
        // [INTEGRAÇÃO]: Busca todos os contratos de Venda Coberta (Call) e Venda de Put ativos
        let activeCalls = [];
        let activePuts = [];
        try {
            // Conta as ações travadas em Calls (Garantia Física)
            activeCalls = db.prepare(`
                SELECT asset_base, SUM(quantity) as locked_qty
                FROM OptionsContracts
                WHERE type = 'call' AND status = 'active'
                GROUP BY asset_base
            `).all();

            // Soma o dinheiro travado em Puts atrelado a um CDB/Caixa (Garantia Financeira)
            activePuts = db.prepare(`
                SELECT guarantee_asset_id, SUM(quantity * strike_price) as locked_financial
                FROM OptionsContracts
                WHERE type = 'put' AND status = 'active' AND guarantee_asset_id IS NOT NULL
                GROUP BY guarantee_asset_id
            `).all();
        } catch (e) { console.warn("Tabela OptionsContracts ausente no momento."); }

        const enriched = assets.map(asset => {
            const estadoReal = calcularEstadoMatematico(asset.id, db);
            asset.avg_price = estadoReal.precoMedio;
            asset.total_quantity = estadoReal.quantidade;
            
            // [CADEADO FÍSICO]: Ações presas em Calls
            const callLock = activeCalls.find(c => c.asset_base === asset.name);
            asset.locked_quantity = callLock ? callLock.locked_qty : 0;
            asset.available_quantity = Math.max(0, asset.total_quantity - asset.locked_quantity);

            // [CADEADO FINANCEIRO]: Dinheiro de Renda Fixa preso em Puts
            const putLock = activePuts.find(p => p.guarantee_asset_id === asset.id);
            asset.locked_value = putLock ? putLock.locked_financial : 0;

            return asset;
        });

        res.json(enriched);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ============================================================================
// 2. CRIAR NOVO ATIVO (Com Metadados de IRPF)
// ============================================================================
router.post('/', (req, res) => {
    const { name, type, color, subcategory_id, goal_id, is_rebalancing_active, cnpj, razao_social, corretora } = req.body;
    
    try {
        db.prepare(`
            INSERT INTO Assets (name, type, color, subcategory_id, goal_id, is_rebalancing_active, cnpj, razao_social, corretora) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            name, type, color || '#3b82f6', subcategory_id || null, goal_id || null, 
            is_rebalancing_active ? 1 : 0, cnpj || null, razao_social || null, corretora || null
        );
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ============================================================================
// 3. EDITAR DADOS CADASTRAIS DO ATIVO (EDIÇÃO DE METADADOS)
// ============================================================================
router.put('/:id', (req, res) => {
    const { name, color, subcategory_id, goal_id, is_rebalancing_active, cnpj, razao_social, corretora } = req.body;
    const assetId = req.params.id;

    try {
        db.prepare(`
            UPDATE Assets 
            SET name = ?, color = ?, subcategory_id = ?, goal_id = ?, is_rebalancing_active = ?, cnpj = ?, razao_social = ?, corretora = ?
            WHERE id = ?
        `).run(
            name, color, subcategory_id || null, goal_id || null, 
            is_rebalancing_active ? 1 : 0, cnpj || null, razao_social || null, corretora || null, assetId
        );
        res.json({ success: true, message: "Ativo atualizado com sucesso." });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ============================================================================
// 4. EXCLUIR ATIVO DEFINITIVAMENTE
// ============================================================================
router.delete('/:id', (req, res) => {
    try {
        db.prepare("DELETE FROM Assets WHERE id = ?").run(req.params.id);
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ============================================================================
// 5. NOVO APORTE (COMPRA)
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

            const estadoReal = calcularEstadoMatematico(asset_id, db);
            const qtdAntiga = estadoReal.quantidade;
            const pmAntigo = estadoReal.precoMedio;
            
            const novaQtdTotal = qtdAntiga + qtd;
            const novoPM = ((qtdAntiga * pmAntigo) + valorTotal) / novaQtdTotal;
            const novoSaldo = asset.current_balance + valorTotal;

            db.prepare(`
                UPDATE Assets 
                SET total_quantity = ?, avg_price = ?, current_balance = ?, status = 'active'
                WHERE id = ?
            `).run(novaQtdTotal, novoPM, novoSaldo, asset_id);

            db.prepare(`
                INSERT INTO EquityHistory (asset_id, type, amount, quantity, date) 
                VALUES (?, 'contribution', ?, ?, ?)
            `).run(asset_id, valorTotal, qtd, date);
        });

        insertTransaction();
        gerarSnapshotHoje(asset_id, db);
        
        res.json({ success: true, message: "Aporte registrado com sucesso." });
    } catch (err) {
        console.error("Erro no Aporte:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// 6. REGISTRAR VENDA (COM IRPF E TRAVA DE DERIVATIVOS DUPLA)
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

            const estadoReal = calcularEstadoMatematico(asset_id, db);

            // [INTEGRAÇÃO DE SEGURANÇA MÁXIMA]
            let lockedQty = 0;       // Travado por Call
            let lockedFinancial = 0; // Travado por Put
            try {
                // 1. Checa a trava física (Se for uma ação)
                const callLock = db.prepare(`SELECT SUM(quantity) as locked_qty FROM OptionsContracts WHERE type = 'call' AND status = 'active' AND asset_base = ?`).get(asset.name);
                lockedQty = callLock ? (callLock.locked_qty || 0) : 0;

                // 2. Checa a trava financeira (Se for um CDB/Renda Fixa/Caixa)
                const putLock = db.prepare(`SELECT SUM(quantity * strike_price) as locked_financial FROM OptionsContracts WHERE type = 'put' AND status = 'active' AND guarantee_asset_id = ?`).get(asset.id);
                lockedFinancial = putLock ? (putLock.locked_financial || 0) : 0;
            } catch (e) { /* Fallback caso a tabela não exista */ }

            // Verifica o Bloqueio Físico (Para as ações atreladas em Calls)
            const availableQty = estadoReal.quantidade - lockedQty;
            if (qtdVendida > (availableQty + 0.00000001)) {
                if (lockedQty > 0) {
                    throw new Error(`Operação Bloqueada (Garantia de Call): Você tem ${estadoReal.quantidade.toFixed(2)} cotas, mas ${lockedQty} estão presas como margem na Mesa Tática. Disponível: ${availableQty.toFixed(2)}.`);
                } else {
                    throw new Error(`Tentativa inválida: Você tentou vender ${qtdVendida.toFixed(4)}, mas possui apenas ${estadoReal.quantidade.toFixed(4)}.`);
                }
            }

            // Verifica o Bloqueio Financeiro (Para Renda Fixa/Caixa atrelado em Puts)
            const availableFinancial = asset.current_balance - lockedFinancial;
            if (valorBrutoVenda > (availableFinancial + 0.01)) {
                throw new Error(`Operação Bloqueada (Garantia de Put): Seu saldo atual é de R$ ${asset.current_balance.toFixed(2)}, mas R$ ${lockedFinancial.toFixed(2)} estão presos como margem na Mesa Tática. Resgate livre: R$ ${availableFinancial.toFixed(2)}.`);
            }

            // Calculando Custo e Lucro (Respeitando a Matemática da RFB)
            const custoDeAquisicao = qtdVendida * estadoReal.precoMedio;
            lucroRealizado = valorBrutoVenda - custoDeAquisicao;

            // Motor de Impostos Padrão
            if (lucroRealizado > 0) {
                if (['FIIs', 'Fiagro', 'FI-Infra'].includes(asset.type)) {
                    impostoGerado = lucroRealizado * 0.20;
                } else if (['Ações', 'BDRs', 'Cripto', 'Exterior'].includes(asset.type)) {
                    impostoGerado = lucroRealizado * 0.15;
                }
            }

            const novaQtdTotal = Math.max(0, estadoReal.quantidade - qtdVendida);
            const novoSaldo = novaQtdTotal === 0 ? 0 : asset.current_balance * (novaQtdTotal / estadoReal.quantidade);
            const novoStatus = novaQtdTotal === 0 ? 'closed' : 'active';

            db.prepare(`
                UPDATE Assets 
                SET total_quantity = ?, current_balance = ?, status = ?
                WHERE id = ?
            `).run(novaQtdTotal, novoSaldo, novoStatus, asset_id);

            db.prepare(`
                INSERT INTO EquityHistory (asset_id, type, amount, quantity, lucro, tax_due, date) 
                VALUES (?, 'withdrawal', ?, ?, ?, ?, ?)
            `).run(asset_id, valorBrutoVenda, qtdVendida, lucroRealizado, impostoGerado, date);
        });

        sellTransaction();
        gerarSnapshotHoje(asset_id, db);
        
        res.json({ 
            success: true, 
            imposto_gerado: impostoGerado,
            lucro: lucroRealizado
        });
    } catch (err) {
        console.error("Erro na Venda:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// 7. REGISTRAR RENDIMENTO (PROVENTO)
// ============================================================================
router.post('/rendimento', (req, res) => {
    const { asset_id, amount, date } = req.body;
    try {
        db.prepare(`
            INSERT INTO EquityHistory (asset_id, type, amount, date) 
            VALUES (?, 'dividend', ?, ?)
        `).run(asset_id, parseFloat(amount), date);
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ============================================================================
// 8. SINCRONIZAR COTAÇÃO NA BOLSA (BRAPI / BINANCE)
// ============================================================================
router.post('/sync/:id', (req, res) => {
    try {
        const asset = db.prepare("SELECT * FROM Assets WHERE id = ?").get(req.params.id);
        if (!asset) return res.status(404).json({ error: "Ativo não encontrado." });

        let tickerLimpo = asset.name.trim().toUpperCase();
        const qtdExata = calcularEstadoMatematico(asset.id, db).quantidade;

        if (asset.type === 'Cripto') {
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
                        
                        if (isNaN(precoMercado)) return res.status(400).json({ error: "Preço indisponível na Binance." });

                        const novoSaldo = qtdExata * precoMercado;
                        return res.json({ sugerido: precoMercado, novoSaldo: novoSaldo });
                    } catch (err) {
                        return res.status(500).json({ error: "Erro ao interpretar dados da Binance." });
                    }
                });
            }).on('error', (err) => res.status(500).json({ error: `Falha de conexão: ${err.message}` }));

        } else {
            const settingsRow = db.prepare("SELECT value FROM Settings WHERE key = 'brapi_token'").get();
            if (!settingsRow || !settingsRow.value) {
                return res.status(400).json({ error: "Token da Brapi não configurado na página de Parâmetros." });
            }

            const urlBrapi = `https://brapi.dev/api/quote/${tickerLimpo}?token=${settingsRow.value}`;

            https.get(urlBrapi, (response) => {
                let data = '';
                response.on('data', (chunk) => data += chunk);
                response.on('end', () => {
                    try {
                        const jsonData = JSON.parse(data);

                        if (response.statusCode !== 200 || jsonData.error) {
                            const errorMsg = jsonData.message || jsonData.error || 'Erro desconhecido';
                            return res.status(400).json({ error: `Recusa da Brapi: ${errorMsg}` });
                        }

                        if (jsonData.results && jsonData.results.length > 0) {
                            const precoMercado = jsonData.results[0].regularMarketPrice;
                            if (precoMercado === undefined || precoMercado === null) {
                                return res.status(400).json({ error: "Ativo encontrado, mas preço indisponível." });
                            }

                            const novoSaldo = qtdExata * precoMercado;
                            return res.json({ sugerido: precoMercado, novoSaldo: novoSaldo });
                        } else {
                            return res.status(400).json({ error: `Ticker '${tickerLimpo}' não encontrado.` });
                        }
                    } catch (err) {
                        return res.status(500).json({ error: "Erro ao interpretar dados da Brapi." });
                    }
                });
            }).on('error', (err) => res.status(500).json({ error: `Falha de conexão: ${err.message}` }));
        }
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ============================================================================
// 9. APLICAR NOVO SALDO APÓS SINCRONIZAÇÃO E REGISTRAR SNAPSHOT
// ============================================================================
router.post('/aplicar-sync/:id', (req, res) => {
    try {
        const asset_id = req.params.id;
        const novo_saldo = req.body.novo_saldo;

        db.prepare("UPDATE Assets SET current_balance = ? WHERE id = ?").run(novo_saldo, asset_id);
        gerarSnapshotHoje(asset_id, db);
        
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ============================================================================
// 10. EXTRATO HISTÓRICO DE UM ATIVO
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
                historicoEnriquecido.push({ ...row, ir_devido: row.tax_due || 0, lucro: lucroCalculado });
            }
        });

        historicoEnriquecido.sort((a, b) => {
            if (b.date === a.date) return b.id - a.id;
            return new Date(b.date) - new Date(a.date);
        });

        res.json(historicoEnriquecido);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ============================================================================
// 11. EXCLUIR ITEM DO HISTÓRICO (ESTORNO E AUTO-CURA)
// ============================================================================
router.delete('/history/:id', (req, res) => {
    try {
        const historyItem = db.prepare("SELECT * FROM EquityHistory WHERE id = ?").get(req.params.id);
        if (!historyItem) return res.status(404).json({ error: "Registro não encontrado." });

        const assetId = historyItem.asset_id;

        if (historyItem.type === 'contribution') {
            db.prepare("UPDATE Assets SET current_balance = MAX(0, current_balance - ?) WHERE id = ?").run(historyItem.amount, assetId);
        } else if (historyItem.type === 'withdrawal') {
            db.prepare("UPDATE Assets SET current_balance = current_balance + ? WHERE id = ?").run(historyItem.amount, assetId);
        }

        db.prepare("DELETE FROM EquityHistory WHERE id = ?").run(req.params.id);

        const estadoCurado = calcularEstadoMatematico(assetId, db);
        db.prepare(`
            UPDATE Assets 
            SET total_quantity = ?, avg_price = ? 
            WHERE id = ?
        `).run(estadoCurado.quantidade, estadoCurado.precoMedio, assetId);
        
        gerarSnapshotHoje(assetId, db); 
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

module.exports = router;