const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { crearAsiento } = require('../helpers/contabilidad');

// ========================
// GET /cuentas-por-cobrar
// ========================
router.get('/', async (req, res) => {
    const { status, search } = req.query;

    try {
        let query = `
            SELECT 
                v.id,
                v.customer_id,
                CONCAT(c.first_name, ' ', c.last_name) AS customer_name,
                v.sale_date,
                v.total,
                v.paid_amount,
                v.pending_amount,
                v.payment_status
            FROM ventas v
            INNER JOIN clientes c ON v.customer_id = c.id
            WHERE v.payment_status IN ('pending', 'partial')
        `;

        const params = [];

        if (status) {
            query += ` AND v.payment_status = ?`;
            params.push(status);
        }

        if (search) {
            query += ` AND (c.first_name LIKE ? OR c.last_name LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }

        query += ` ORDER BY v.sale_date DESC`;

        const [results] = await db.query(query, params);
        res.json(results);

    } catch (error) {
        console.error("❌ Error al obtener cuentas por cobrar:", error);
        res.status(500).json({ error: "Error al obtener cuentas por cobrar" });
    }
});

// ========================
// GET /cuentas-por-cobrar/:sale_id/historial
// ========================
router.get('/:sale_id/historial', async (req, res) => {
    const { sale_id } = req.params;

    try {
        const [results] = await db.query(
            `SELECT 
                p.id,
                p.amount,
                p.payment_method,
                p.payment_date,
                p.notes,
                u.username
             FROM pagos_credito p
             INNER JOIN usuarios u ON p.user_id = u.id
             WHERE p.sale_id = ?
             ORDER BY p.payment_date ASC`,
            [sale_id]
        );

        res.json(results);

    } catch (error) {
        console.error("❌ Error al obtener historial de pagos:", error);
        res.status(500).json({ error: "Error al obtener historial de pagos" });
    }
});

// ========================
// POST /cuentas-por-cobrar/pago
// ========================
router.post('/pago', async (req, res) => {
    const { sale_id, customer_id, user_id, amount, payment_method, bank_id, notes } = req.body;

    if (!sale_id || !customer_id || !user_id || !amount || amount <= 0) {
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
                "SELECT id FROM cajas WHERE user_id = ? AND status = 'open' LIMIT 1",
                [user_id]
            );

            if (!cajaResult.length) {
                await connection.rollback();
                return res.status(400).json({ error: "Debes abrir tu caja antes de registrar abonos en efectivo." });
            }

            cajaAbierta = cajaResult[0];
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
        }

        const [ventaResult] = await connection.query(
            "SELECT total, paid_amount, pending_amount, payment_status FROM ventas WHERE id = ? FOR UPDATE",
            [sale_id]
        );

        if (!ventaResult.length) {
            await connection.rollback();
            return res.status(404).json({ error: "Venta no encontrada." });
        }

        const venta = ventaResult[0];

        if (parseFloat(amount) > parseFloat(venta.pending_amount)) {
            await connection.rollback();
            return res.status(400).json({ error: "El monto excede el saldo pendiente." });
        }

        const newPaidAmount = parseFloat(venta.paid_amount) + parseFloat(amount);
        const newPendingAmount = parseFloat(venta.pending_amount) - parseFloat(amount);
        const newStatus = newPendingAmount <= 0 ? 'paid' : 'partial';

        const [pagoResult] = await connection.query(
            `INSERT INTO pagos_credito (sale_id, customer_id, user_id, amount, payment_method, notes) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [sale_id, customer_id, user_id, amount, payment_method, notes || null]
        );

        if (cajaAbierta) {
            await connection.query(
                `INSERT INTO movimientos_caja (caja_id, type, concept, amount, reference_type, reference_id) 
                 VALUES (?, 'income', ?, ?, 'pago_credito', ?)`,
                [cajaAbierta.id, `Abono a factura #${sale_id}`, amount, pagoResult.insertId]
            );
        }

        if (bankAccount) {
            await connection.query(
                `INSERT INTO movimientos_bancarios (bank_id, type, amount, concept, reference_type, reference_id) 
                 VALUES (?, 'transfer_in', ?, ?, 'pago_credito', ?)`,
                [bank_id, amount, `Abono a factura #${sale_id}`, pagoResult.insertId]
            );

            await connection.query(
                "UPDATE bancos SET current_balance = current_balance + ? WHERE id = ?",
                [amount, bank_id]
            );
        }

        await connection.query(
            `UPDATE ventas 
             SET paid_amount = ?, pending_amount = ?, payment_status = ? 
             WHERE id = ?`,
            [newPaidAmount, newPendingAmount, newStatus, sale_id]
        );

        const cuentaDestino = payment_method === 'cash' ? '1101' : '1102';

        await crearAsiento(connection, {
            description: `Abono a factura #${sale_id}`,
            reference_type: 'pago_credito',
            reference_id: pagoResult.insertId,
            user_id,
            lines: [
                { code: cuentaDestino, debit: amount },
                { code: '1103', credit: amount }
            ]
        });

        await connection.commit();
        res.json({
            message: "Abono registrado con éxito",
            new_status: newStatus,
            pending_amount: newPendingAmount
        });

    } catch (error) {
        await connection.rollback();
        console.error("❌ Error al registrar el abono:", error);
        res.status(500).json({ error: "Error al registrar el abono" });
    } finally {
        connection.release();
    }
});

module.exports = router;