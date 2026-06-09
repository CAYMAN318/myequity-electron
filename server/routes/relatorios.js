const express = require('express');
const router = express.Router();
const db = require('../database');

// ============================================================================
// FUNÇÃO MÁQUINA DO TEMPO (IRPF)
// Calcula a quantidade de cotas e o Preço Médio exato até uma data de corte.
// Isso é essencial para a declaração de "Bens e Direitos" em 31/12.
// ============================================================================
function calcularEstadoAteData(asset_id, dataLimite, dbInstance) {
    const history = dbInstance.prepare(`
        SELECT * FROM EquityHistory 
        WHERE asset_id = ? AND date <= ? 
        ORDER BY date ASC, id ASC
    `).all(asset_id, dataLimite);
    
    let qty = 0; 
    let invested = 0;

    history.forEach(h => {
        if (h.type === 'contribution') { 
            qty += (h.quantity || 0); 
            invested += (h.amount || 0); 
        } 
        else if (h.type === 'withdrawal') {
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
// 1. ROTA PADRÃO DE DADOS DOS GRÁFICOS (COM AUTO-CURA)
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
                    db.prepare(`
                        INSERT INTO AssetSnapshots (asset_id, date, quantity, price, total_value)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(a.id, hoje, a.total_quantity, price, a.current_balance);
                }
            });
        })();

        const evolutionInvestments = db.prepare(`
            SELECT EH.date, EH.amount, EH.type, EH.asset_id, A.name as asset_name
            FROM EquityHistory EH 
            JOIN Assets A ON EH.asset_id = A.id
            WHERE EH.type IN ('contribution', 'withdrawal', 'dividend') 
            ORDER BY EH.date ASC
        `).all();

        const snapshots = db.prepare(`
            SELECT date, asset_id, total_value
            FROM AssetSnapshots
            ORDER BY date ASC
        `).all();

        const activeLoans = db.prepare(`
            SELECT * FROM Loans 
            WHERE status != 'quitted' AND status != 'deleted'
        `).all();

        res.json({ evolutionInvestments, snapshots, activeLoans });
        
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ============================================================================
// 2. ROTA ASSISTENTE DE IRPF (AUDITORIA E DECLARAÇÃO)
// Agora enxergando Opções e separando a Isenção de 20k!
// ============================================================================
router.get('/irpf/:ano', (req, res) => {
    const ano = req.params.ano; 
    const dataCorte = `${ano}-12-31`;

    try {
        // --------------------------------------------------------------------
        // ABA 1: BENS E DIREITOS (Ativos + Opções Lançadas)
        // --------------------------------------------------------------------
        const todosAtivos = db.prepare("SELECT id, name, type, razao_social, cnpj, corretora FROM Assets").all();
        const bens = [];

        todosAtivos.forEach(ativo => {
            const estadoFinal = calcularEstadoAteData(ativo.id, dataCorte, db);
            if (estadoFinal.quantidade > 0) {
                bens.push({ 
                    ...ativo, 
                    natureza: 'ativo',
                    quantidade: estadoFinal.quantidade, 
                    precoMedio: estadoFinal.precoMedio, 
                    totalInvestido: estadoFinal.quantidade * estadoFinal.precoMedio 
                });
            }
        });

        // [NOVO] Adicionando Opções abertas em 31/12 como "Dívidas/Ônus"
        let opcoesAbertas = [];
        try {
            opcoesAbertas = db.prepare(`
                SELECT * FROM OptionsContracts 
                WHERE open_date <= ? AND (status = 'active' OR expiration_date > ?)
            `).all(dataCorte, dataCorte);
            
            opcoesAbertas.forEach(op => {
                bens.push({
                    id: `opt_${op.id}`,
                    natureza: 'opcao',
                    name: op.ticker,
                    type: op.type === 'call' ? 'Venda Coberta (Call)' : 'Venda Garantida (Put)',
                    quantidade: op.quantity,
                    totalInvestido: op.total_premium // Na declaração, o saldo é o prêmio recebido
                });
            });
        } catch(e) { console.warn("Tabela de Opções não encontrada."); }
        
        bens.sort((a, b) => b.totalInvestido - a.totalInvestido);

        // --------------------------------------------------------------------
        // ABA 2: PROVENTOS (Dividendos e Rendimentos)
        // --------------------------------------------------------------------
        const proventos = db.prepare(`
            SELECT A.name, A.type, A.razao_social, A.cnpj, A.corretora, SUM(EH.amount) as total_recebido
            FROM EquityHistory EH 
            JOIN Assets A ON EH.asset_id = A.id
            WHERE EH.type = 'dividend' AND strftime('%Y', EH.date) = ? 
            GROUP BY EH.asset_id 
            ORDER BY total_recebido DESC
        `).all(ano);

        // --------------------------------------------------------------------
        // ABA 3: VENDAS (Ganhos de Capital Separados: Ações vs Outros/Opções)
        // --------------------------------------------------------------------
        const vendas = [];
        const mesesNomes = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
        
        for (let i = 1; i <= 12; i++) {
            const mesStr = i.toString().padStart(2, '0');
            
            // 1. Vendas de Spot (Separado por Ações vs FIIs/BDRs)
            const vendasSpot = db.prepare(`
                SELECT A.type, SUM(EH.amount) as total_vendido, SUM(EH.lucro) as total_lucro, SUM(EH.tax_due) as total_imposto
                FROM EquityHistory EH
                JOIN Assets A ON EH.asset_id = A.id
                WHERE EH.type = 'withdrawal' AND strftime('%Y', EH.date) = ? AND strftime('%m', EH.date) = ?
                GROUP BY A.type
            `).all(ano, mesStr);

            let volVendaAcoes = 0; let lucroAcoes = 0; let impostoAcoes = 0;
            let volVendaOutros = 0; let lucroOutros = 0; let impostoOutros = 0;

            vendasSpot.forEach(v => {
                if (v.type === 'Ações') {
                    volVendaAcoes += (v.total_vendido || 0);
                    lucroAcoes += (v.total_lucro || 0);
                    impostoAcoes += (v.total_imposto || 0);
                } else {
                    volVendaOutros += (v.total_vendido || 0);
                    lucroOutros += (v.total_lucro || 0);
                    impostoOutros += (v.total_imposto || 0);
                }
            });

            // 2. [NOVO] Adicionando Lucros de Opções (Sempre Tributáveis)
            let lucroOpcoes = 0; let impostoOpcoes = 0;
            try {
                // Busca Opções Expiradas (Virou pó = lucro total)
                const expiredOpts = db.prepare(`
                    SELECT SUM(total_premium) as lucro FROM OptionsContracts 
                    WHERE status = 'expired' AND strftime('%Y', expiration_date) = ? AND strftime('%m', expiration_date) = ?
                `).get(ano, mesStr);
                
                // Busca Opções Recompradas (Closed = lucro realizado gravado)
                const closedOpts = db.prepare(`
                    SELECT SUM(realized_profit) as lucro FROM OptionsContracts 
                    WHERE status = 'closed' AND strftime('%Y', expiration_date) = ? AND strftime('%m', expiration_date) = ?
                `).get(ano, mesStr);

                lucroOpcoes = (expiredOpts?.lucro || 0) + (closedOpts?.lucro || 0);
                // Calcula o IR de 15% apenas se o resultado da opção for lucro
                if (lucroOpcoes > 0) impostoOpcoes = lucroOpcoes * 0.15;

            } catch(e) {}

            vendas.push({ 
                mesNumero: i, 
                mesNome: mesesNomes[i - 1], 
                
                // Cesta Ações (Com isenção de 20k)
                acoes_total_vendido: volVendaAcoes, 
                acoes_total_lucro: lucroAcoes, 
                acoes_total_imposto: impostoAcoes, 
                
                // Cesta Tributável Direta (FIIs, BDRs + Opções)
                tributavel_total_vendido: volVendaOutros, // Volume de FIIs
                tributavel_total_lucro: lucroOutros + lucroOpcoes, 
                tributavel_total_imposto: impostoOutros + impostoOpcoes
            });
        }

        res.json({ bens, proventos, vendas });
        
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

module.exports = router;