const express = require('express');
const router = express.Router();
const db = require('../database');

// ============================================================================
// FUNÇÃO MÁQUINA DO TEMPO (IRPF)
// Calcula a posição exata e o Preço Médio de um ativo até uma data de corte.
// ============================================================================
function calcularEstadoAteData(asset_id, dataLimite, dbInstance) {
    const history = dbInstance.prepare("SELECT * FROM EquityHistory WHERE asset_id = ? AND date <= ? ORDER BY date ASC, id ASC").all(asset_id, dataLimite);
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
// 1. ROTA PADRÃO DE DADOS DOS GRÁFICOS
// ============================================================================
router.get('/', (req, res) => {
    try {
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
        console.error("Erro na rota de relatórios:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// 2. ROTA ASSISTENTE DE IRPF (O NOVO MÓDULO)
// ============================================================================
router.get('/irpf/:ano', (req, res) => {
    const ano = req.params.ano;
    const dataCorte = `${ano}-12-31`;

    try {
        // ABA 1: Bens e Direitos (Posição em 31/12)
        const todosAtivos = db.prepare("SELECT id, name, type, razao_social, cnpj, corretora FROM Assets").all();
        const bens = [];

        todosAtivos.forEach(ativo => {
            const estadoFinal = calcularEstadoAteData(ativo.id, dataCorte, db);
            if (estadoFinal.quantidade > 0) {
                bens.push({
                    ...ativo,
                    quantidade: estadoFinal.quantidade,
                    precoMedio: estadoFinal.precoMedio,
                    totalInvestido: estadoFinal.quantidade * estadoFinal.precoMedio
                });
            }
        });
        
        // Ordena do maior valor investido para o menor
        bens.sort((a, b) => b.totalInvestido - a.totalInvestido);

        // ABA 2: Proventos (Rendimentos Isentos e Tributáveis no Ano)
        const proventos = db.prepare(`
            SELECT A.name, A.type, A.razao_social, A.cnpj, A.corretora, SUM(EH.amount) as total_recebido
            FROM EquityHistory EH
            JOIN Assets A ON EH.asset_id = A.id
            WHERE EH.type = 'dividend' AND strftime('%Y', EH.date) = ?
            GROUP BY EH.asset_id
            ORDER BY total_recebido DESC
        `).all(ano);

        // ABA 3: Ganhos de Capital (Vendas Mês a Mês)
        const vendas = [];
        const mesesNomes = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
        
        for (let i = 1; i <= 12; i++) {
            const mesStr = i.toString().padStart(2, '0');
            const resumoMes = db.prepare(`
                SELECT SUM(amount) as total_vendido, SUM(lucro) as total_lucro, SUM(tax_due) as total_imposto
                FROM EquityHistory
                WHERE type = 'withdrawal' AND strftime('%Y', date) = ? AND strftime('%m', date) = ?
            `).get(ano, mesStr);

            vendas.push({
                mesNumero: i,
                mesNome: mesesNomes[i - 1],
                total_vendido: resumoMes.total_vendido || 0,
                total_lucro: resumoMes.total_lucro || 0,
                total_imposto: resumoMes.total_imposto || 0
            });
        }

        res.json({ bens, proventos, vendas });

    } catch (err) {
        console.error("Erro ao gerar dados do IRPF:", err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;