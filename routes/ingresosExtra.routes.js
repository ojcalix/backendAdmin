const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { crearAsiento } = require('../helpers/contabilidad');

// ========================
// GET /ingresos-extra
// ========================
router.get('/', async (req, res) => {
    const { origin, date_from, date_to } = req.query;

    try {
        let query = `
            SELECT 
                ie.id,
                ie.concept,
                ie.amount,
                ie.payment_method,
                ie.is_system,
                ie.date,
                u.username
            FROM ingresos_extra ie
            INNER JOIN usuarios u ON ie.user_id = u.id
            WHERE 1 = 1
        `;

        const params = [];

        if (origin === 'manual') {
            query += ` AND ie.is_system = FALSE`;
        } else if (origin === 'system') {
            query += ` AND ie.is_system = TRUE`;
        }

        if (date_from) {
            query += ` AND DATE(ie.date) >= ?`;
            params.push(date_from);
        }

        if (date_to) {
            query += ` AND DATE(ie.date) <= ?`;
            params.push(date_to);
        }

        query += ` ORDER BY ie.date DESC`;

        const [results] = await db.query(query, params);
        res.json(results);

    } catch (error) {
        console.error("❌ Error al obtener ingresos extra:", error);
        res.status(500).json({ error: "Error al obtener ingresos extra" });
    }
});

// ========================
// POST /ingresos-extra
// ========================
router.post('/', async (req, res) => {
    const { concept, amount, payment_method, bank_id, user_id } = req.body;

    if (!concept || !amount || amount <= 0 || !user_id) {
        return res.status(400).json({ error: "Datos incompletos o monto inválido." });
    }

    const validMethods = ['cash', 'bank'];
    if (!validMethods.includes(payment_method)) {
        return res.status(400).json({ error: "Método de pago inválido." });
    }

    if (payment_method === 'bank' && !bank_id) {
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
                return res.status(400).json({ error: "Debes abrir tu caja antes de registrar ingresos en efectivo." });
            }

            cajaAbierta = cajaResult[0];
        }

        if (payment_method === 'bank') {
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

        const [incomeResult] = await connection.query(
            `INSERT INTO ingresos_extra (concept, amount, payment_method, caja_id, bank_id, user_id, is_system) 
             VALUES (?, ?, ?, ?, ?, ?, FALSE)`,
            [concept, amount, payment_method, cajaAbierta ? cajaAbierta.id : null, bankAccount ? bank_id : null, user_id]
        );

        if (cajaAbierta) {
            await connection.query(
                `INSERT INTO movimientos_caja (caja_id, type, concept, amount, reference_type, reference_id) 
                 VALUES (?, 'income', ?, ?, 'otro', ?)`,
                [cajaAbierta.id, concept, amount, incomeResult.insertId]
            );
        }

        if (bankAccount) {
            await connection.query(
                `INSERT INTO movimientos_bancarios (bank_id, type, amount, concept, reference_type, reference_id) 
                 VALUES (?, 'deposit', ?, ?, 'otro', ?)`,
                [bank_id, amount, concept, incomeResult.insertId]
            );

            await connection.query(
                "UPDATE bancos SET current_balance = current_balance + ? WHERE id = ?",
                [amount, bank_id]
            );
        }

        const cuentaDestino = payment_method === 'cash' ? '1101' : '1102';

        await crearAsiento(connection, {
            description: `Ingreso extra: ${concept}`,
            reference_type: 'ingreso_extra',
            reference_id: incomeResult.insertId,
            user_id,
            lines: [
                { code: cuentaDestino, debit: amount },
                { code: '4102', credit: amount }
            ]
        });

        await connection.commit();
        res.json({ message: "Ingreso registrado con éxito", income_id: incomeResult.insertId });

    } catch (error) {
        await connection.rollback();
        console.error("❌ Error al registrar el ingreso:", error);
        res.status(500).json({ error: "Error al registrar el ingreso" });
    } finally {
        connection.release();
    }
});

module.exports = router;