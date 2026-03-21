const express = require('express');
const router = express.Router();
const db = require('../database');

// ============================================================================
// 1. LISTAR TODOS OS CONTRATOS ATIVOS
// ============================================================================
router.get('/', (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM Loans WHERE status != 'deleted' ORDER BY status, start_date DESC").all();
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 2. CRIAR NOVO CONTRATO DE DÍVIDA (Com parcelas pagas e prestação real)
// ============================================================================
router.post('/', (req, res) => {
    const { description, total_principal, interest_rate, installments_total, installments_paid, monthly_payment, start_date, is_payroll_deductible } = req.body;
    try {
        db.prepare(`
            INSERT INTO Loans (description, total_principal, interest_rate, installments_total, installments_paid, monthly_payment, start_date, is_payroll_deductible) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(description, total_principal, interest_rate, installments_total, installments_paid || 0, monthly_payment || 0, start_date, is_payroll_deductible ? 1 : 0);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 3. EDITAR CONTRATO EXISTENTE
// ============================================================================
router.put('/:id', (req, res) => {
    const { description, total_principal, interest_rate, installments_total, installments_paid, monthly_payment } = req.body;
    try {
        db.prepare(`
            UPDATE Loans SET 
                description = ?, total_principal = ?, interest_rate = ?, 
                installments_total = ?, installments_paid = ?, monthly_payment = ?
            WHERE id = ?
        `).run(description, total_principal, interest_rate, installments_total, installments_paid, monthly_payment || 0, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 4. EXCLUIR CONTRATO
// ============================================================================
router.delete('/:id', (req, res) => {
    try { 
        db.prepare("DELETE FROM Loans WHERE id = ?").run(req.params.id); 
        res.json({ success: true }); 
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 5. MOTOR DE AMORTIZAÇÃO / PAGAMENTO
// ============================================================================
router.post('/amortizar', (req, res) => {
    const { loan_id, quantidade_parcelas, antecipar } = req.body;
    try {
        const loan = db.prepare("SELECT * FROM Loans WHERE id = ?").get(loan_id);
        if (!loan) return res.status(404).json({ error: "Contrato não encontrado." });
        
        const parcelasRestantes = loan.installments_total - loan.installments_paid;
        const parcelasParaPagar = Math.min(quantidade_parcelas, parcelasRestantes);
        
        if (parcelasParaPagar <= 0) return res.status(400).json({ error: "Este contrato já está liquidado." });

        const jurosMensalDecimal = loan.interest_rate / 100;
        
        let valorPago = 0;
        let jurosPoupados = 0;

        if (antecipar) {
            // Pagamento Antecipado: O utilizador amortiza o principal puro. 
            // Estimativa conservadora baseada na prestação menos os juros do mês.
            const jurosDaParcelaEstimados = loan.total_principal * jurosMensalDecimal; 
            const amortizacaoPura = loan.monthly_payment > jurosDaParcelaEstimados 
                                    ? (loan.monthly_payment - jurosDaParcelaEstimados) 
                                    : (loan.total_principal / loan.installments_total);
            
            valorPago = amortizacaoPura * parcelasParaPagar;
            jurosPoupados = (loan.monthly_payment - amortizacaoPura) * parcelasParaPagar; 
        } else {
            // Pagamento Normal: O utilizador paga a prestação contratada
            valorPago = loan.monthly_payment * parcelasParaPagar;
            jurosPoupados = 0;
        }

        const novasParcelasPagas = loan.installments_paid + parcelasParaPagar;
        const novoStatus = novasParcelasPagas >= loan.installments_total ? 'quitted' : 'active';

        const transaction = db.transaction(() => {
            db.prepare("UPDATE Loans SET installments_paid = ?, status = ? WHERE id = ?").run(novasParcelasPagas, novoStatus, loan_id);
            
            db.prepare(`
                INSERT INTO EquityHistory (loan_id, type, amount, quantity, interest_saved, date) 
                VALUES (?, 'loan_payment', ?, ?, ?, ?)
            `).run(loan_id, valorPago, parcelasParaPagar, jurosPoupados, new Date().toISOString().split('T')[0]);
        });
        
        transaction();

        res.json({ 
            success: true, 
            pago: valorPago, 
            poupado: jurosPoupados, 
            quantidade: parcelasParaPagar,
            quitado: novoStatus === 'quitted'
        });

    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;