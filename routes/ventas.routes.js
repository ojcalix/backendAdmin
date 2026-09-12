const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { crearAsiento, reversarAsiento } = require('../helpers/contabilidad');

// ========================
// POST /ventas
// ========================
router.post('/', async (req, res) => {
    const {
        user_id,
        customer_id,
        payment_type,
        payment_status,
        payment_method,
        bank_id,
        total,
        paid_amount,
        pending_amount,
        earned_points,
        products
    } = req.body;

    if (!user_id || !products.length) {
        return res.status(400).json({ error: "Datos incompletos." });
    }

    const validPaymentTypes = ['cash', 'credit', 'mixed'];
    if (!validPaymentTypes.includes(payment_type)) {
        return res.status(400).json({ error: "Forma de pago inválida." });
    }

    if ((payment_type === 'credit' || payment_type === 'mixed') && !customer_id) {
        return res.status(400).json({ error: "Las ventas a crédito o mixtas requieren un cliente." });
    }

    const entraDinero = (payment_type === 'cash' || payment_type === 'mixed') && paid_amount > 0;

    if (entraDinero) {
        const validMethods = ['cash', 'transfer', 'card'];
        if (!validMethods.includes(payment_method)) {
            return res.status(400).json({ error: "Método de pago inválido." });
        }
        if ((payment_method === 'transfer' || payment_method === 'card') && !bank_id) {
            return res.status(400).json({ error: "Debe seleccionar una cuenta bancaria." });
        }
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        let cajaAbierta = null;
        let bankAccount = null;

        if (entraDinero && payment_method === 'cash') {
            const [cajaResult] = await connection.query(
                "SELECT id FROM cajas WHERE user_id = ? AND status = 'open' LIMIT 1",
                [user_id]
            );

            if (!cajaResult.length) {
                await connection.rollback();
                return res.status(400).json({ error: "Debes abrir tu caja antes de registrar ventas en efectivo." });
            }

            cajaAbierta = cajaResult[0];
        }

        if (entraDinero && (payment_method === 'transfer' || payment_method === 'card')) {
            const [bankResult] = await connection.query(
                "SELECT id FROM bancos WHERE id = ? AND status = 'active'",
                [bank_id]
            );

            if (!bankResult.length) {
                await connection.rollback();
                return res.status(404).json({ error: "Cuenta bancaria no encontrada o inactiva." });
            }

            bankAccount = bankResult[0];
        }

        const [ventaResult] = await connection.query(
            `INSERT INTO ventas 
                (user_id, customer_id, payment_type, payment_status, payment_method, bank_id, total, paid_amount, pending_amount, earned_points) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [user_id, customer_id, payment_type, payment_status, payment_method || 'cash', bank_id || null, total, paid_amount, pending_amount, earned_points]
        );
        const sale_id = ventaResult.insertId;

        if (cajaAbierta) {
            const concept = payment_type === 'cash'
                ? `Venta #${sale_id} (contado)`
                : `Venta #${sale_id} (abono inicial - mixto)`;

            await connection.query(
                `INSERT INTO movimientos_caja (caja_id, type, concept, amount, reference_type, reference_id) 
                 VALUES (?, 'income', ?, ?, 'venta', ?)`,
                [cajaAbierta.id, concept, paid_amount, sale_id]
            );
        }

        if (bankAccount) {
            const concept = payment_type === 'cash'
                ? `Venta #${sale_id} (contado)`
                : `Venta #${sale_id} (abono inicial - mixto)`;

            await connection.query(
                `INSERT INTO movimientos_bancarios (bank_id, type, amount, concept, reference_type, reference_id) 
                 VALUES (?, 'transfer_in', ?, ?, 'venta', ?)`,
                [bank_id, paid_amount, concept, sale_id]
            );

            await connection.query(
                "UPDATE bancos SET current_balance = current_balance + ? WHERE id = ?",
                [paid_amount, bank_id]
            );
        }

        let totalEarnedPoints = 0;
        let totalCost = 0;

        for (const product of products) {
            const { product_id, variant_id, quantity, subtotal } = product;

            const [variantStockResult] = await connection.query(
                "SELECT quantity FROM variantes WHERE id = ? FOR UPDATE",
                [variant_id]
            );

            if (!variantStockResult.length || quantity > variantStockResult[0].quantity) {
                await connection.rollback();
                return res.status(400).json({ error: `Stock insuficiente o variante no encontrada (ID: ${variant_id})` });
            }

            await connection.query(
                "UPDATE variantes SET quantity = quantity - ? WHERE id = ?",
                [quantity, variant_id]
            );

            const [costRows] = await connection.query(
                `SELECT purchase_price FROM detalle_compras WHERE variant_id = ? ORDER BY id DESC LIMIT 1`,
                [variant_id]
            );
            const costoUnitario = costRows.length ? parseFloat(costRows[0].purchase_price) : 0;
            totalCost += costoUnitario * quantity;

            const puntos = Math.floor(subtotal / 30);
            totalEarnedPoints += puntos;

            await connection.query(
                "INSERT INTO ventas_detalle (sale_id, product_id, variant_id, quantity, subtotal, earned_points) VALUES (?, ?, ?, ?, ?, ?)",
                [sale_id, product_id, variant_id, quantity, subtotal, puntos]
            );
        }

        await connection.query(
            "UPDATE ventas SET earned_points = ? WHERE id = ?",
            [totalEarnedPoints, sale_id]
        );

        if (totalEarnedPoints > 0 && customer_id !== null) {
            await connection.query(
                "INSERT INTO historial_puntos (customer_id, sale_id, points, type) VALUES (?, ?, ?, 'earned')",
                [customer_id, sale_id, totalEarnedPoints]
            );

            await connection.query(
                "UPDATE clientes SET accumulated_points = accumulated_points + ? WHERE id = ?",
                [totalEarnedPoints, customer_id]
            );
        }

        const cuentaDinero = payment_method === 'cash' ? '1101' : '1102';
        const lines = [{ code: '4101', credit: total }];

        if (paid_amount > 0) {
            lines.push({ code: cuentaDinero, debit: paid_amount });
        }
        if (pending_amount > 0) {
            lines.push({ code: '1103', debit: pending_amount });
        }
        if (totalCost > 0) {
            lines.push({ code: '5101', debit: totalCost });
            lines.push({ code: '1104', credit: totalCost });
        }

        await crearAsiento(connection, {
            description: `Venta #${sale_id}`,
            reference_type: 'venta',
            reference_id: sale_id,
            user_id,
            lines
        });

        await connection.commit();
        res.json({ message: "Venta registrada con éxito", sale_id });

    } catch (error) {
        await connection.rollback();
        console.error("❌ Error en el registro de venta:", error);
        res.status(500).json({ error: "Error al registrar la venta" });
    } finally {
        connection.release();
    }
});

// ========================
// POST /ventas/:id/cancelar
// Revierte stock, caja/banco, y genera el asiento contrario.
// La venta NUNCA se borra — queda marcada como 'cancelada' para
// mantener el historial completo.
// ========================
router.post('/:id/cancelar', async (req, res) => {
    const { id } = req.params;
    const { user_id, reason } = req.body;

    if (!user_id) {
        return res.status(400).json({ error: "Falta el usuario que cancela la venta." });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [ventaResult] = await connection.query(
            "SELECT * FROM ventas WHERE id = ? FOR UPDATE",
            [id]
        );

        if (!ventaResult.length) {
            await connection.rollback();
            return res.status(404).json({ error: "Venta no encontrada." });
        }

        const venta = ventaResult[0];

        if (venta.status === 'cancelada') {
            await connection.rollback();
            return res.status(400).json({ error: "Esta venta ya está cancelada." });
        }

        // ✅ Bloquear si ya hay abonos posteriores registrados
        const [abonos] = await connection.query(
            "SELECT COUNT(*) AS total FROM pagos_credito WHERE sale_id = ?",
            [id]
        );

        if (abonos[0].total > 0) {
            await connection.rollback();
            return res.status(400).json({
                error: "Esta venta ya tiene abonos registrados. Debes cancelar esos abonos primero."
            });
        }

        // ✅ Regresar el stock de cada variante vendida
        const [detalle] = await connection.query(
            "SELECT variant_id, quantity FROM ventas_detalle WHERE sale_id = ?",
            [id]
        );

        for (const item of detalle) {
            await connection.query(
                "UPDATE variantes SET quantity = quantity + ? WHERE id = ?",
                [item.quantity, item.variant_id]
            );
        }

        // ✅ Revertir efectivo (contra la caja ABIERTA HOY del usuario que cancela)
        if (venta.paid_amount > 0 && venta.payment_method === 'cash') {
            const [cajaResult] = await connection.query(
                "SELECT id FROM cajas WHERE user_id = ? AND status = 'open' LIMIT 1",
                [user_id]
            );

            if (!cajaResult.length) {
                await connection.rollback();
                return res.status(400).json({ error: "Debes abrir tu caja para poder cancelar una venta en efectivo (el reverso se registra en tu caja actual)." });
            }

            await connection.query(
                `INSERT INTO movimientos_caja (caja_id, type, concept, amount, reference_type, reference_id) 
                 VALUES (?, 'expense', ?, ?, 'venta', ?)`,
                [cajaResult[0].id, `Cancelación de venta #${id}`, venta.paid_amount, id]
            );
        }

        // ✅ Revertir banco
        if (venta.paid_amount > 0 && (venta.payment_method === 'transfer' || venta.payment_method === 'card')) {
            await connection.query(
                `INSERT INTO movimientos_bancarios (bank_id, type, amount, concept, reference_type, reference_id) 
                 VALUES (?, 'transfer_out', ?, ?, 'venta', ?)`,
                [venta.bank_id, venta.paid_amount, `Cancelación de venta #${id}`, id]
            );

            await connection.query(
                "UPDATE bancos SET current_balance = current_balance - ? WHERE id = ?",
                [venta.paid_amount, venta.bank_id]
            );
        }

        // ✅ Revertir puntos ganados, si el cliente los sigue teniendo
        if (venta.earned_points > 0 && venta.customer_id) {
            await connection.query(
                "UPDATE clientes SET accumulated_points = GREATEST(accumulated_points - ?, 0) WHERE id = ?",
                [venta.earned_points, venta.customer_id]
            );

            await connection.query(
                "INSERT INTO historial_puntos (customer_id, sale_id, points, type) VALUES (?, ?, ?, 'used')",
                [venta.customer_id, id, venta.earned_points]
            );
        }

        // ✅ Generar el asiento contrario exacto al original
        await reversarAsiento(connection, {
            reference_type: 'venta',
            original_reference_id: id,
            new_reference_id: id,
            description: `Reversión de Venta #${id}${reason ? ': ' + reason : ''}`,
            user_id
        });

        await connection.query(
            `UPDATE ventas 
             SET status = 'cancelada', cancelled_at = NOW(), cancelled_by = ?, cancel_reason = ? 
             WHERE id = ?`,
            [user_id, reason || null, id]
        );

        await connection.commit();
        res.json({ message: "Venta cancelada con éxito" });

    } catch (error) {
        await connection.rollback();
        console.error("❌ Error al cancelar la venta:", error);
        res.status(500).json({ error: "Error al cancelar la venta" });
    } finally {
        connection.release();
    }
});

// ========================
// GET /ventas
// ========================
router.get('/', async (req, res) => {
    const query = `
        SELECT
            v.id AS id_venta,
            u.username AS usuario,
            CONCAT(c.first_name, ' ', c.last_name) AS cliente,
            v.total,
            v.earned_points,
            v.sale_date,
            v.status
        FROM ventas v
        JOIN usuarios u ON v.user_id = u.id
        LEFT JOIN clientes c ON v.customer_id = c.id
        ORDER BY v.sale_date DESC
    `;

    try {
        const [results] = await db.query(query);
        res.status(200).json(results);
    } catch (err) {
        console.error('Error al obtener las ventas:', err);
        res.status(500).send('Error al obtener las ventas');
    }
});

// ========================
// GET /ventas/:id
// ========================
router.get('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const [venta] = await db.query(`
            SELECT v.id, v.total, v.sale_date, v.status, v.cancel_reason, u.username, 
                   CONCAT(c.first_name, ' ', c.last_name) AS customer
            FROM ventas v
            JOIN usuarios u ON v.user_id = u.id
            LEFT JOIN clientes c ON v.customer_id = c.id
            WHERE v.id = ?
        `, [id]);

        if (!venta.length) return res.status(404).json({ error: 'Venta no encontrada' });

        const [detalle] = await db.query(`
            SELECT 
                p.name AS product_name,
                p.brand,
                var.variant_name,
                vd.quantity,
                (vd.subtotal / vd.quantity) AS precio_unitario,
                vd.subtotal
            FROM ventas_detalle vd
            JOIN productos p ON vd.product_id = p.id
            LEFT JOIN variantes var ON vd.variant_id = var.id
            WHERE vd.sale_id = ?
        `, [id]);

        res.json({
            venta: venta[0],
            productos: detalle
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al obtener la venta' });
    }
});

module.exports = router;