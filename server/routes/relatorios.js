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
                // Deduz o valor investido proporcionalmente à quantidade vendida (Custo Médio)
                invested -= (invested / (qty + (h.quantity || 0))) * (h.quantity || 0);
            } else {
                // Se zerou a posição, zera o valor investido
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
        // --------------------------------------------------------------------
        // [AUTO-CURA]: Prevenção de "Ponto Cego" no gráfico.
        // Força o mês corrente do gráfico a bater exatamente com os centavos 
        // exibidos na tela de Investimentos, caso o usuário não tenha 
        // sincronizado manualmente hoje.
        // --------------------------------------------------------------------
        const ativosAtuais = db.prepare("SELECT id, current_balance, total_quantity FROM Assets").all();
        const hoje = new Date().toISOString().split('T')[0];
        
        db.transaction(() => {
            ativosAtuais.forEach(a => {
                // Verifica se já existe uma "fotografia" do ativo com a data de hoje
                const check = db.prepare("SELECT id FROM AssetSnapshots WHERE asset_id = ? AND date = ?").get(a.id, hoje);
                
                // Se não existir, tira uma fotografia silenciosa com o saldo em cache
                if (!check) {
                    const price = a.total_quantity > 0 ? (a.current_balance / a.total_quantity) : 0;
                    db.prepare(`
                        INSERT INTO AssetSnapshots (asset_id, date, quantity, price, total_value)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(a.id, hoje, a.total_quantity, price, a.current_balance);
                }
            });
        })();

        // --------------------------------------------------------------------
        // BUSCA DE DADOS PARA OS GRÁFICOS
        // --------------------------------------------------------------------
        
        // 1. Histórico de Aportes, Vendas e Dividendos
        const evolutionInvestments = db.prepare(`
            SELECT EH.date, EH.amount, EH.type, EH.asset_id, A.name as asset_name
            FROM EquityHistory EH 
            JOIN Assets A ON EH.asset_id = A.id
            WHERE EH.type IN ('contribution', 'withdrawal', 'dividend') 
            ORDER BY EH.date ASC
        `).all();

        // 2. Fotografias de Valorização (Marcação a Mercado)
        // O asset_id é exposto aqui para permitir a filtragem por ativo individual na tela
        const snapshots = db.prepare(`
            SELECT date, asset_id, total_value
            FROM AssetSnapshots
            ORDER BY date ASC
        `).all();

        // 3. Dívidas Ativas para o Gráfico de Passivos
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
// ============================================================================
router.get('/irpf/:ano', (req, res) => {
    const ano = req.params.ano; 
    const dataCorte = `${ano}-12-31`;

    try {
        // --------------------------------------------------------------------
        // ABA 1: BENS E DIREITOS (Posição estática no dia 31/12 do ano base)
        // --------------------------------------------------------------------
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
        
        // Ordena os bens do maior valor investido para o menor
        bens.sort((a, b) => b.totalInvestido - a.totalInvestido);

        // --------------------------------------------------------------------
        // ABA 2: PROVENTOS (Soma de Dividendos recebidos dentro do ano base)
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
        // ABA 3: VENDAS (Ganhos de Capital agrupados por mês de competência)
        // --------------------------------------------------------------------
        const vendas = [];
        const mesesNomes = [
            'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 
            'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
        ];
        
        for (let i = 1; i <= 12; i++) {
            const mesStr = i.toString().padStart(2, '0');
            
            // Soma o total vendido, o lucro/prejuízo alcançado e o IR devido daquele mês específico
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

        // Retorna todos os blocos formatados para o Modal de IRPF no Frontend
        res.json({ bens, proventos, vendas });
        
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

module.exports = router;