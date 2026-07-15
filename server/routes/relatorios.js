const express = require('express');
const router = express.Router();
const db = require('../database');

// ============================================================================
// FUNÇÃO MÁQUINA DO TEMPO: B3 (IRPF)
// ============================================================================
function calcularEstadoAteData(asset_id, dataLimite, dbInstance) {
    const history = dbInstance.prepare(`
        SELECT * FROM EquityHistory 
        WHERE asset_id = ? AND date <= ? 
        ORDER BY date ASC, id ASC
    `).all(asset_id, dataLimite);
    
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
    return { quantidade: qty, precoMedio: qty > 0 ? (invested / qty) : 0 };
}

// ============================================================================
// FUNÇÃO MÁQUINA DO TEMPO: GLOBAL / OFFSHORE (IRPF)
// Calcula Câmbio Médio BRL e Preço Médio USD travados na data de corte
// ============================================================================
function calcularEstadoAteDataGlobal(asset_id, dataLimite, dbInstance) {
    const history = dbInstance.prepare(`
        SELECT * FROM GlobalHistory 
        WHERE asset_id = ? AND date <= ? 
        ORDER BY date ASC, id ASC
    `).all(asset_id, dataLimite);
    
    let qty = 0; let investedUsd = 0; let totalBrlSpent = 0;
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
                investedUsd = 0; totalBrlSpent = 0;
            }
        }
    });

    return {
        quantidade: qty,
        precoMedioUsd: qty > 0 ? (investedUsd / qty) : 0,
        cambioMedioBrl: investedUsd > 0 ? (totalBrlSpent / investedUsd) : 0,
        totalInvestidoBRL: totalBrlSpent
    };
}

// ============================================================================
// 1. ROTA PADRÃO DE DADOS DOS GRÁFICOS (MISTURANDO B3 + GLOBAL)
// ============================================================================
router.get('/', (req, res) => {
    try {
        const ativosAtuais = db.prepare("SELECT id, current_balance, total_quantity FROM Assets").all();
        const hoje = new Date().toISOString().split('T')[0];
        
        db.transaction(() => {
            ativosAtuais.forEach(a => {
                const check = db.prepare("SELECT id FROM AssetSnapshots WHERE asset_id = ? AND date = ?").get(a.id, hoje);
                if (!check) {
                    const price = a.total_quantity > 0 ? (a.current_balance / a.total_quantity) : 0;
                    db.prepare(`INSERT INTO AssetSnapshots (asset_id, date, quantity, price, total_value) VALUES (?, ?, ?, ?, ?)`).run(a.id, hoje, a.total_quantity, price, a.current_balance);
                }
            });
        })();

        // Histórico B3 (Nacional)
        const historyB3 = db.prepare(`
            SELECT EH.date, EH.amount, EH.type, EH.asset_id, A.name as asset_name
            FROM EquityHistory EH JOIN Assets A ON EH.asset_id = A.id
            WHERE EH.type IN ('contribution', 'withdrawal', 'dividend')
        `).all().map(h => ({ ...h, market: 'B3' }));

        // Histórico Global (Exterior) - Converte p/ BRL para empilhar no gráfico
        let historyGlobal = [];
        try {
            historyGlobal = db.prepare(`
                SELECT GH.date, GH.amount_usd, GH.exchange_rate, GH.type, GH.asset_id, GA.ticker as asset_name
                FROM GlobalHistory GH JOIN GlobalAssets GA ON GH.asset_id = GA.id
            `).all().map(gh => {
                const typeMap = { 'buy': 'contribution', 'sell': 'withdrawal', 'dividend': 'dividend' };
                const rate = gh.exchange_rate || 5.20; // Default estético para dividendos sem câmbio registrado
                return {
                    date: gh.date,
                    amount: gh.amount_usd * rate,
                    type: typeMap[gh.type],
                    asset_id: `global_${gh.asset_id}`,
                    asset_name: gh.asset_name,
                    market: 'Global'
                };
            });
        } catch(e) { console.warn("Tabela Global não encontrada para os gráficos."); }

        // Junta tudo e ordena no tempo
        const evolutionInvestments = [...historyB3, ...historyGlobal].sort((a, b) => new Date(a.date) - new Date(b.date));

        const snapshots = db.prepare(`SELECT date, asset_id, total_value FROM AssetSnapshots ORDER BY date ASC`).all();
        
        // Simula snapshots de hoje para os Globais na linha de "Marcação a Mercado"
        try {
            const globaisAtuais = db.prepare("SELECT id, current_balance_usd, avg_exchange_rate FROM GlobalAssets WHERE status = 'active'").all();
            globaisAtuais.forEach(g => {
                snapshots.push({
                    date: hoje,
                    asset_id: `global_${g.id}`,
                    total_value: g.current_balance_usd * (g.avg_exchange_rate || 5.20)
                });
            });
        } catch(e) {}

        const activeLoans = db.prepare(`SELECT * FROM Loans WHERE status != 'quitted' AND status != 'deleted'`).all();

        res.json({ evolutionInvestments, snapshots, activeLoans });
        
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 2. ROTA ASSISTENTE DE IRPF (B3 + OPÇÕES + EXTERIOR)
// ============================================================================
router.get('/irpf/:ano', (req, res) => {
    const ano = req.params.ano; 
    const dataCorte = `${ano}-12-31`;

    try {
        const bens = [];

        // --- BENS: B3 ---
        const todosAtivos = db.prepare("SELECT id, name, type, razao_social, cnpj, corretora FROM Assets").all();
        todosAtivos.forEach(ativo => {
            const estadoFinal = calcularEstadoAteData(ativo.id, dataCorte, db);
            if (estadoFinal.quantidade > 0) {
                bens.push({ ...ativo, natureza: 'ativo', quantidade: estadoFinal.quantidade, precoMedio: estadoFinal.precoMedio, totalInvestidoBRL: estadoFinal.quantidade * estadoFinal.precoMedio });
            }
        });

        // --- BENS: OPÇÕES (DÍVIDAS/ÔNUS) ---
        try {
            const opcoesAbertas = db.prepare(`SELECT * FROM OptionsContracts WHERE open_date <= ? AND (status = 'active' OR expiration_date > ?)`).all(dataCorte, dataCorte);
            opcoesAbertas.forEach(op => {
                bens.push({
                    id: `opt_${op.id}`, natureza: 'opcao', name: op.ticker,
                    type: op.type === 'call' ? 'Venda Coberta (Call)' : 'Venda Garantida (Put)',
                    quantidade: op.quantity, totalInvestidoBRL: op.total_premium
                });
            });
        } catch(e) {}

        // --- BENS: EXTERIOR (OFFSHORE) ---
        try {
            const globais = db.prepare("SELECT id, ticker, name, type FROM GlobalAssets").all();
            globais.forEach(g => {
                const estadoFinal = calcularEstadoAteDataGlobal(g.id, dataCorte, db);
                if (estadoFinal.quantidade > 0) {
                    bens.push({
                        id: `global_${g.id}`, natureza: 'exterior', name: g.ticker, razao_social: g.name, type: g.type,
                        quantidade: estadoFinal.quantidade, precoMedioUSD: estadoFinal.precoMedioUsd, cambioMedioBRL: estadoFinal.cambioMedioBrl,
                        totalInvestidoBRL: estadoFinal.totalInvestidoBRL
                    });
                }
            });
        } catch(e) {}
        
        bens.sort((a, b) => b.totalInvestidoBRL - a.totalInvestidoBRL);

        // --- PROVENTOS: B3 e EXTERIOR ---
        let proventos = db.prepare(`
            SELECT A.name, A.type, A.razao_social, A.cnpj, A.corretora, SUM(EH.amount) as total_recebido, 'BR' as origem
            FROM EquityHistory EH JOIN Assets A ON EH.asset_id = A.id
            WHERE EH.type = 'dividend' AND strftime('%Y', EH.date) = ? 
            GROUP BY EH.asset_id 
        `).all(ano);

        try {
            const proventosGlobal = db.prepare(`
                SELECT GA.ticker as name, GA.type, GA.name as razao_social, SUM(GH.amount_usd) as total_recebido_usd, SUM(GH.taxes_usd) as total_imposto_retido_usd, 'Exterior' as origem
                FROM GlobalHistory GH JOIN GlobalAssets GA ON GH.asset_id = GA.id
                WHERE GH.type = 'dividend' AND strftime('%Y', GH.date) = ?
                GROUP BY GH.asset_id
            `).all(ano);
            proventos = [...proventos, ...proventosGlobal];
        } catch(e) {}
        
        proventos.sort((a, b) => (b.total_recebido || b.total_recebido_usd) - (a.total_recebido || a.total_recebido_usd));

        // --- VENDAS E GANHOS DE CAPITAL ---
        const vendas = [];
        const mesesNomes = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
        
        for (let i = 1; i <= 12; i++) {
            const mesStr = i.toString().padStart(2, '0');
            
            const vendasSpot = db.prepare(`
                SELECT A.type, SUM(EH.amount) as total_vendido, SUM(EH.lucro) as total_lucro, SUM(EH.tax_due) as total_imposto
                FROM EquityHistory EH JOIN Assets A ON EH.asset_id = A.id
                WHERE EH.type = 'withdrawal' AND strftime('%Y', EH.date) = ? AND strftime('%m', EH.date) = ?
                GROUP BY A.type
            `).all(ano, mesStr);

            let volVendaAcoes = 0; let lucroAcoes = 0; let impostoAcoes = 0;
            let volVendaOutros = 0; let lucroOutros = 0; let impostoOutros = 0;

            vendasSpot.forEach(v => {
                if (v.type === 'Ações') {
                    volVendaAcoes += (v.total_vendido || 0); lucroAcoes += (v.total_lucro || 0); impostoAcoes += (v.total_imposto || 0);
                } else {
                    volVendaOutros += (v.total_vendido || 0); lucroOutros += (v.total_lucro || 0); impostoOutros += (v.total_imposto || 0);
                }
            });

            // Opções
            let lucroOpcoes = 0; let impostoOpcoes = 0;
            try {
                const expiredOpts = db.prepare(`SELECT SUM(total_premium) as lucro FROM OptionsContracts WHERE status = 'expired' AND strftime('%Y', expiration_date) = ? AND strftime('%m', expiration_date) = ?`).get(ano, mesStr);
                const closedOpts = db.prepare(`SELECT SUM(realized_profit) as lucro FROM OptionsContracts WHERE status = 'closed' AND strftime('%Y', expiration_date) = ? AND strftime('%m', expiration_date) = ?`).get(ano, mesStr);
                lucroOpcoes = (expiredOpts?.lucro || 0) + (closedOpts?.lucro || 0);
                if (lucroOpcoes > 0) impostoOpcoes = lucroOpcoes * 0.15;
            } catch(e) {}

            // Exterior (Vendas Offshore - Lei 14.754/23)
            let lucroExteriorUSD = 0; let lucroExteriorBRL = 0; let impostoExteriorBRL = 0;
            try {
                const vendasOffshore = db.prepare(`
                    SELECT SUM(taxes_usd) as lucro_usd, SUM(taxes_usd * exchange_rate) as lucro_brl 
                    FROM GlobalHistory WHERE type = 'sell' AND strftime('%Y', date) = ? AND strftime('%m', date) = ?
                `).get(ano, mesStr);
                
                if (vendasOffshore && vendasOffshore.lucro_usd) {
                    lucroExteriorUSD = vendasOffshore.lucro_usd;
                    lucroExteriorBRL = vendasOffshore.lucro_brl;
                    if (lucroExteriorBRL > 0) impostoExteriorBRL = lucroExteriorBRL * 0.15; // 15% fixo sobre o lucro em Reais
                }
            } catch(e) {}

            vendas.push({ 
                mesNumero: i, mesNome: mesesNomes[i - 1], 
                acoes_total_vendido: volVendaAcoes, acoes_total_lucro: lucroAcoes, acoes_total_imposto: impostoAcoes, 
                tributavel_total_vendido: volVendaOutros, tributavel_total_lucro: lucroOutros + lucroOpcoes, tributavel_total_imposto: impostoOutros + impostoOpcoes,
                exterior_lucro_usd: lucroExteriorUSD, exterior_lucro_brl: lucroExteriorBRL, exterior_imposto_brl: impostoExteriorBRL
            });
        }

        res.json({ bens, proventos, vendas });
        
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;