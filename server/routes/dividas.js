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
// 2. CRIAR NOVO CONTRATO DE DÍVIDA (Com Reconciliação Inicial no Extrato)
// ============================================================================
router.post('/', (req, res) => {
    const { description, total_principal, interest_rate, installments_total, installments_paid, monthly_payment, start_date, is_payroll_deductible } = req.body;
    
    try {
        const insertTransaction = db.transaction(() => {
            // 1. Cria o contrato principal
            const result = db.prepare(`
                INSERT INTO Loans (description, total_principal, interest_rate, installments_total, installments_paid, monthly_payment, start_date, is_payroll_deductible) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(description, total_principal, interest_rate, installments_total, installments_paid || 0, monthly_payment || 0, start_date, is_payroll_deductible ? 1 : 0);
            
            const newLoanId = result.lastInsertRowid;

            // 2. Se o usuário já informou que pagou parcelas, cria uma linha consolidada no Extrato
            if (installments_paid > 0 && monthly_payment > 0) {
                const valorConsolidado = installments_paid * monthly_payment;
                
                db.prepare(`
                    INSERT INTO EquityHistory (loan_id, type, amount, quantity, interest_saved, date) 
                    VALUES (?, 'initial_balance', ?, ?, 0, ?)
                `).run(newLoanId, valorConsolidado, installments_paid, start_date);
            }
        });

        insertTransaction();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 3. ATUALIZAR CONTRATO EXISTENTE
// ============================================================================
router.put('/:id', (req, res) => {
    const { description, total_principal, interest_rate, installments_total, installments_paid, monthly_payment, start_date, is_payroll_deductible } = req.body;
    try {
        db.prepare(`
            UPDATE Loans 
            SET description = ?, total_principal = ?, interest_rate = ?, installments_total = ?, installments_paid = ?, monthly_payment = ?, start_date = ?, is_payroll_deductible = ?
            WHERE id = ?
        `).run(description, total_principal, interest_rate, installments_total, installments_paid, monthly_payment, start_date, is_payroll_deductible ? 1 : 0, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 4. EXCLUIR CONTRATO E SEU HISTÓRICO (Delete Real)
// ============================================================================
router.delete('/:id', (req, res) => {
    try {
        // Agora também limpa o histórico associado para não deixar lixo no banco
        db.transaction(() => {
            db.prepare("DELETE FROM EquityHistory WHERE loan_id = ?").run(req.params.id);
            db.prepare("DELETE FROM Loans WHERE id = ?").run(req.params.id);
        })();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 5. REGISTRAR PAGAMENTO / AMORTIZAÇÃO (Calcula Abatimento de Juros)
// ============================================================================
router.post('/amortize', (req, res) => {
    const { loan_id, quantity, is_early_payment } = req.body;
    
    try {
        const loan = db.prepare("SELECT * FROM Loans WHERE id = ?").get(loan_id);
        if (!loan) return res.status(404).json({ error: "Contrato não encontrado." });

        const parcelasParaPagar = parseInt(quantity) || 1;
        let valorPago = 0;
        let jurosPoupados = 0;

        if (is_early_payment) {
            const numeroDeParcelasEstimados = loan.monthly_payment > 0 
                                            ? Math.floor(loan.total_principal / loan.monthly_payment) 
                                            : loan.installments_total;
            
            const amortizacaoPura = numeroDeParcelasEstimados > 0 
                                    ? (loan.total_principal / numeroDeParcelasEstimados) 
                                    : (loan.total_principal / loan.installments_total);
            
            valorPago = amortizacaoPura * parcelasParaPagar;
            jurosPoupados = (loan.monthly_payment - amortizacaoPura) * parcelasParaPagar; 
        } else {
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

// ============================================================================
// 6. EXTRATO HISTÓRICO DE PAGAMENTOS
// ============================================================================
router.get('/history/:id', (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM EquityHistory WHERE loan_id = ? ORDER BY date DESC, id DESC").all(req.params.id);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 7. EXCLUIR ITEM DO HISTÓRICO (ESTORNO DE PAGAMENTO)
// ============================================================================
router.delete('/history/:id', (req, res) => {
    try {
        const historyItem = db.prepare("SELECT * FROM EquityHistory WHERE id = ?").get(req.params.id);
        if (!historyItem) return res.status(404).json({ error: "Registro não encontrado." });

        if (historyItem.type === 'loan_payment' || historyItem.type === 'initial_balance') {
            db.prepare(`
                UPDATE Loans 
                SET installments_paid = MAX(0, installments_paid - ?),
                    status = 'active'
                WHERE id = ?
            `).run(historyItem.quantity || 1, historyItem.loan_id);
        }

        db.prepare("DELETE FROM EquityHistory WHERE id = ?").run(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;