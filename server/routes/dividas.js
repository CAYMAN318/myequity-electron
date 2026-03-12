const express = require('express');
const router = express.Router();
const db = require('../database');

/**
 * Cálculo Tabela Price (Amortização Francesa)
 * PV: Valor Presente, i: Taxa Mensal (decimal), n: Prazo
 */
function calcularParcelaPrice(principal, taxaMensal, parcelas) {
    if (!taxaMensal || taxaMensal === 0) return principal / parcelas;
    const i = taxaMensal / 100;
    const n = parcelas;
    const pmt = principal * (i * Math.pow(1 + i, n)) / (Math.pow(1 + i, n) - 1);
    return pmt;
}

/**
 * Cálculo de Valor Presente (Para Amortização)
 * Traz uma parcela futura para o valor de hoje, descontando os juros.
 */
function calcularValorPresente(valorParcela, taxaMensal, mesesAntecipados) {
    if (!taxaMensal || taxaMensal === 0) return valorParcela;
    const i = taxaMensal / 100;
    // Fórmula: VP = VF / (1 + i)^n
    return valorParcela / Math.pow(1 + i, mesesAntecipados);
}

/**
 * Sincronização Cronológica de Parcelas
 */
const sincronizarParcelas = (loan) => {
    if (loan.status !== 'active' || !loan.is_payroll_deductible || !loan.start_date) return 0;
    
    const hoje = new Date();
    const dataInicio = new Date(loan.start_date);
    
    const mesesPassados = (hoje.getFullYear() - dataInicio.getFullYear()) * 12 + (hoje.getMonth() - dataInicio.getMonth());
    
    if (mesesPassados > loan.installments_paid) {
        return Math.min(mesesPassados - loan.installments_paid, loan.installments_total - loan.installments_paid);
    }
    return 0;
};

// GET: Listar e Sincronizar
router.get('/', (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM Loans").all();
        
        db.transaction(() => {
            rows.forEach(loan => {
                const pendentes = sincronizarParcelas(loan);
                if (pendentes > 0) {
                    const valorParcela = loan.monthly_payment > 0 ? loan.monthly_payment : calcularParcelaPrice(loan.total_principal, loan.interest_rate, loan.installments_total);
                    
                    db.prepare("UPDATE Loans SET installments_paid = installments_paid + ? WHERE id = ?").run(pendentes, loan.id);
                    
                    db.prepare("INSERT INTO EquityHistory (loan_id, type, amount, date) VALUES (?, 'monthly_payment', ?, datetime('now'))")
                      .run(loan.id, valorParcela * pendentes);
                }
            });
        })();
        
        res.json(db.prepare("SELECT * FROM Loans").all());
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// POST: Criar Novo Empréstimo
router.post('/', (req, res) => {
    const { 
        description, total_principal, interest_rate, installments_total, 
        installments_paid, monthly_payment, start_date, is_payroll_deductible 
    } = req.body;

    try {
        const pmtFinal = monthly_payment || calcularParcelaPrice(total_principal, interest_rate, installments_total);

        db.prepare(`
            INSERT INTO Loans (description, total_principal, interest_rate, installments_total, installments_paid, monthly_payment, start_date, is_payroll_deductible)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            description, total_principal, interest_rate, installments_total, 
            installments_paid || 0, pmtFinal, start_date, is_payroll_deductible ? 1 : 0
        );
        res.status(201).json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// POST: Amortizar (Cálculo de Desconto Real)
router.post('/amortizar', (req, res) => {
    const { loanId, quantity } = req.body;
    try {
        const loan = db.prepare("SELECT * FROM Loans WHERE id = ?").get(loanId);
        if (!loan) return res.status(404).json({ error: "Contrato não encontrado" });

        const parcelasRestantes = loan.installments_total - loan.installments_paid;
        const nAmortizar = Math.min(quantity, parcelasRestantes);
        
        let valorTotalDesembolsado = 0;
        let totalJurosPoupados = 0;

        // Calculamos o Valor Presente de cada parcela que está sendo antecipada (de trás para frente)
        for (let i = 0; i < nAmortizar; i++) {
            const mesesAntecipacao = parcelasRestantes - i; 
            const valorParcelaCheia = loan.monthly_payment;
            
            // Calculamos quanto essa parcela vale hoje retirando os juros
            const valorComDesconto = calcularValorPresente(valorParcelaCheia, loan.interest_rate, mesesAntecipacao);
            
            valorTotalDesembolsado += valorComDesconto;
            totalJurosPoupados += (valorParcelaCheia - valorComDesconto);
        }

        db.transaction(() => {
            db.prepare("UPDATE Loans SET installments_paid = installments_paid + ? WHERE id = ?").run(nAmortizar, loanId);
            
            // Registra o desembolso e o lucro (juros poupados)
            db.prepare(`
                INSERT INTO EquityHistory (loan_id, type, amount, interest_saved, date) 
                VALUES (?, 'amortization', ?, ?, datetime('now'))
            `).run(loanId, valorTotalDesembolsado, totalJurosPoupados);
        })();

        res.json({ 
            success: true, 
            pago: valorTotalDesembolsado, 
            poupado: totalJurosPoupados,
            quantidade: nAmortizar 
        });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// PUT: Editar Empréstimo
router.put('/:id', (req, res) => {
    const { 
        description, total_principal, interest_rate, installments_total, 
        installments_paid, monthly_payment, start_date, is_payroll_deductible, status 
    } = req.body;

    try {
        db.prepare(`
            UPDATE Loans SET 
                description = ?, total_principal = ?, interest_rate = ?, 
                installments_total = ?, installments_paid = ?, 
                monthly_payment = ?, start_date = ?, is_payroll_deductible = ?, status = ?
            WHERE id = ?
        `).run(
            description, total_principal, interest_rate, installments_total, 
            installments_paid, monthly_payment, start_date, 
            is_payroll_deductible ? 1 : 0, status || 'active', req.params.id
        );
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// DELETE: Remover
router.delete('/:id', (req, res) => {
    try {
        db.prepare("DELETE FROM Loans WHERE id = ?").run(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;