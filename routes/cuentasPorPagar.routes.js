const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { crearAsiento } = require('../helpers/contabilidad');

// ========================
// GET /cuentas-por-pagar
// ========================
router.get('/', async (req, res) => {
    const { status, search } = req.query;

    try {
        let query = `
            SELECT 
                c.id,
                c.supplier_id,
                p.name AS supplier_name,
                c.purchase_date,
                c.purchase_price,
                c.paid_amount,
                c.pending_amount,
                c.payment_status
            FROM compras c
            INNER JOIN proveedores p ON c.supplier_id = p.id
            WHERE c.payment_status IN ('pending', 'partial')
        `;

        const params = [];

        if (status) {
            query += ` AND c.payment_status = ?`;
            params.push(status);
        }

        if (search) {
            query += ` AND p.name LIKE ?`;
            params.push(`%${search}%`);
        }

        query += ` ORDER BY c.purchase_date DESC`;

        const [results] = await db.query(query, params);
        res.json(results);

    } catch (error) {
        console.error("❌ Error al obtener cuentas por pagar:", error);
        res.status(500).json({ error: "Error al obtener cuentas por pagar" });
    }
});

// ========================
// GET /cuentas-por-pagar/:purchase_id/historial
// ========================
router.get('/:purchase_id/historial', async (req, res) => {
    const { purchase_id } = req.params;

    try {
        const [results] = await db.query(
            `SELECT 
                pp.id,
                pp.amount,
                pp.payment_method,
                pp.payment_date,
                pp.notes,
                u.username
             FROM pagos_proveedores pp
             INNER JOIN usuarios u ON pp.user_id = u.id
             WHERE pp.purchase_id = ?
             ORDER BY pp.payment_date ASC`,
            [purchase_id]
        );

        res.json(results);

    } catch (error) {
        console.error("❌ Error al obtener historial de pagos:", error);
        res.status(500).json({ error: "Error al obtener historial de pagos" });
    }
});

// ========================
// POST /cuentas-por-pagar/pago
// ========================
router.post('/pago', async (req, res) => {
    const { purchase_id, supplier_id, user_id, amount, payment_method, bank_id, notes } = req.body;

    if (!purchase_id || !supplier_id || !user_id || !amount || amount <= 0) {
        return res.status(400).json({ error: "Datos incompletos o monto inválido." });
    }

    const validMethods = ['cash', 'transfer', 'card', 'other'];
    if (!validMethods.includes(payment_method)) {
        return res.status(400).json({ error: "Método de pago inválido." });
    }

    if ((payment_method === 'transfer' || payment_method === 'card') && !bank_id) {
        return res.status(400).json({ error: "Debe seleccionar una cuenta bancaria." });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        let cajaAbierta = null;
        let bankAccount = null;

        if (payment_method === 'cash') {
            const [cajaResult] = await connection.query(
                "SELECT id, opening_amount FROM cajas WHERE user_id = ? AND status = 'open' LIMIT 1 FOR UPDATE",
                [user_id]
            );

            if (!cajaResult.length) {
                await connection.rollback();
                return res.status(400).json({ error: "Debes abrir tu caja antes de registrar pagos en efectivo." });
            }

            cajaAbierta = cajaResult[0];

            const [movResult] = await connection.query(
                `SELECT 
                    COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
                    COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense
                 FROM movimientos_caja WHERE caja_id = ?`,
                [cajaAbierta.id]
            );

            const availableCash = parseFloat(cajaAbierta.opening_amount)
                + parseFloat(movResult[0].total_income)
                - parseFloat(movResult[0].total_expense);

            if (parseFloat(amount) > availableCash) {
                await connection.rollback();
                return res.status(400).json({
                    error: `Saldo insuficiente en caja. Disponible: L. ${availableCash.toFixed(2)}`
                });
            }
        }

        if (payment_method === 'transfer' || payment_method === 'card') {
            const [bankResult] = await connection.query(
                "SELECT id, current_balance FROM bancos WHERE id = ? AND status = 'active' FOR UPDATE",
                [bank_id]
            );

            if (!bankResult.length) {
                await connection.rollback();
                return res.status(404).json({ error: "Cuenta bancaria no encontrada o inactiva." });
            }

            bankAccount = bankResult[0];

            if (parseFloat(amount) > parseFloat(bankAccount.current_balance)) {
                await connection.rollback();
                return res.status(400).json({
                    error: `Saldo insuficiente en el banco. Disponible: L. ${parseFloat(bankAccount.current_balance).toFixed(2)}`
                });
            }
        }

        const [compraResult] = await connection.query(
            "SELECT purchase_price, paid_amount, pending_amount, payment_status FROM compras WHERE id = ? FOR UPDATE",
            [purchase_id]
        );

        if (!compraResult.length) {
            await connection.rollback();
            return res.status(404).json({ error: "Compra no encontrada." });
        }

        const compra = compraResult[0];

        if (parseFloat(amount) > parseFloat(compra.pending_amount)) {
            await connection.rollback();
            return res.status(400).json({ error: "El monto excede el saldo pendiente." });
        }

        const newPaidAmount = parseFloat(compra.paid_amount) + parseFloat(amount);
        const newPendingAmount = parseFloat(compra.pending_amount) - parseFloat(amount);
        const newStatus = newPendingAmount <= 0 ? 'paid' : 'partial';

        const [pagoResult] = await connection.query(
            `INSERT INTO pagos_proveedores (purchase_id, supplier_id, user_id, amount, payment_method, notes) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [purchase_id, supplier_id, user_id, amount, payment_method, notes || null]
        );

        if (cajaAbierta) {
            await connection.query(
                `INSERT INTO movimientos_caja (caja_id, type, concept, amount, reference_type, reference_id) 
                 VALUES (?, 'expense', ?, ?, 'pago_proveedor', ?)`,
                [cajaAbierta.id, `Pago a proveedor - Compra #${purchase_id}`, amount, pagoResult.insertId]
            );
        }

        if (bankAccount) {
            await connection.query(
                `INSERT INTO movimientos_bancarios (bank_id, type, amount, concept, reference_type, reference_id) 
                 VALUES (?, 'transfer_out', ?, ?, 'pago_proveedor', ?)`,
                [bank_id, amount, `Pago a proveedor - Compra #${purchase_id}`, pagoResult.insertId]
            );

            await connection.query(
                "UPDATE bancos SET current_balance = current_balance - ? WHERE id = ?",
                [amount, bank_id]
            );
        }

        await connection.query(
            `UPDATE compras 
             SET paid_amount = ?, pending_amount = ?, payment_status = ? 
             WHERE id = ?`,
            [newPaidAmount, newPendingAmount, newStatus, purchase_id]
        );

        const cuentaOrigen = payment_method === 'cash' ? '1101' : '1102';

        await crearAsiento(connection, {
            description: `Pago a proveedor - Compra #${purchase_id}`,
            reference_type: 'pago_proveedor',
            reference_id: pagoResult.insertId,
            user_id,
            lines: [
                { code: '2101', debit: amount },
                { code: cuentaOrigen, credit: amount }
            ]
        });

        await connection.commit();
        res.json({
            message: "Pago registrado con éxito",
            new_status: newStatus,
            pending_amount: newPendingAmount
        });

    } catch (error) {
        await connection.rollback();
        console.error("❌ Error al registrar el pago:", error);
        res.status(500).json({ error: "Error al registrar el pago" });
    } finally {
        connection.release();
    }
});

module.exports = router;