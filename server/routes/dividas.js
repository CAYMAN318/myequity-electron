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
        db.transaction(() => {
            // 1. Cria o contrato principal
            const result = db.prepare(`
                INSERT INTO Loans (description, total_principal, interest_rate, installments_total, installments_paid, monthly_payment, start_date, is_payroll_deductible) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(description, total_principal, interest_rate, installments_total, installments_paid || 0, monthly_payment || 0, start_date, is_payroll_deductible ? 1 : 0);
            
            // 2. Se já tem parcelas pagas, gera um "Saldo Inicial" no extrato com o valor amortizado puro
            if (installments_paid > 0) {
                const amortizacaoPura = total_principal / installments_total;
                db.prepare(`
                    INSERT INTO EquityHistory (loan_id, type, amount, quantity, date)
                    VALUES (?, 'initial_balance', ?, ?, ?)
                `).run(result.lastInsertRowid, amortizacaoPura * installments_paid, installments_paid, start_date);
            }
        })();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 3. EDITAR CONTRATO EXISTENTE
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
// 4. EXCLUIR CONTRATO (Soft Delete e limpa histórico)
// ============================================================================
router.delete('/:id', (req, res) => {
    try {
        db.transaction(() => {
            db.prepare("UPDATE Loans SET status = 'deleted' WHERE id = ?").run(req.params.id);
            db.prepare("DELETE FROM EquityHistory WHERE loan_id = ?").run(req.params.id);
        })();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 5. AMORTIZAR PARCELA (LÓGICA CORRIGIDA COM A MATEMÁTICA PURA)
// ============================================================================
router.post('/amortize', (req, res) => {
    const { loan_id, quantity, is_early_payment } = req.body;
    
    try {
        let amountPago = 0;
        let jurosPoupado = 0;
        
        db.transaction(() => {
            const loan = db.prepare("SELECT * FROM Loans WHERE id = ?").get(loan_id);
            if (!loan) throw new Error("Contrato não encontrado.");

            // FÓRMULA CORRETA: O valor puro da parcela da dívida (Principal ÷ Total de Parcelas)
            const amortizacaoPura = loan.total_principal / loan.installments_total;

            if (is_early_payment) {
                // Ao antecipar, você paga APENAS a amortização pura (sem os juros).
                amountPago = amortizacaoPura * quantity; 
                
                // O que você teria que pagar de verdade se não antecipasse:
                const valorComJuros = loan.monthly_payment * quantity; 
                
                // A economia é a diferença:
                jurosPoupado = Math.max(0, valorComJuros - amountPago); 
            } else {
                // Pagamento normal da prestação cheia (inclui os juros do mês)
                amountPago = loan.monthly_payment * quantity;
                jurosPoupado = 0;
            }

            // Registra o pagamento no histórico (Extrato)
            db.prepare(`
                INSERT INTO EquityHistory (loan_id, type, amount, quantity, interest_saved, date)
                VALUES (?, 'loan_payment', ?, ?, ?, date('now', 'localtime'))
            `).run(loan_id, amountPago, quantity, jurosPoupado);

            // Atualiza as parcelas pagas no contrato
            const novasPagas = loan.installments_paid + quantity;
            const novoStatus = novasPagas >= loan.installments_total ? 'quitted' : 'active';

            db.prepare("UPDATE Loans SET installments_paid = ?, status = ? WHERE id = ?").run(novasPagas, novoStatus, loan_id);
        })();

        // Devolve os dados certinhos para a tela avisar o usuário
        res.json({ pago: amountPago, poupado: jurosPoupado, quantidade: quantity });

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
        db.transaction(() => {
            const historyItem = db.prepare("SELECT * FROM EquityHistory WHERE id = ?").get(req.params.id);
            if (!historyItem) throw new Error("Registro não encontrado.");

            if (historyItem.type === 'loan_payment' || historyItem.type === 'initial_balance') {
                db.prepare(`
                    UPDATE Loans 
                    SET installments_paid = MAX(0, installments_paid - ?),
                        status = 'active'
                    WHERE id = ?
                `).run(historyItem.quantity || 1, historyItem.loan_id);
            }

            db.prepare("DELETE FROM EquityHistory WHERE id = ?").run(req.params.id);
        })();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;