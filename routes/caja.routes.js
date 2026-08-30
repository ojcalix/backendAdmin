const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { crearAsiento } = require('../helpers/contabilidad');

// ========================
// GET /caja/actual?user_id=X
// ========================
router.get('/actual', async (req, res) => {
    const { user_id } = req.query;

    if (!user_id) {
        return res.status(400).json({ error: "Falta el user_id." });
    }

    try {
        const [cajaResult] = await db.query(
            "SELECT * FROM cajas WHERE user_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1",
            [user_id]
        );

        if (!cajaResult.length) {
            return res.json({ caja: null });
        }

        const caja = cajaResult[0];

        const [movements] = await db.query(
            "SELECT * FROM movimientos_caja WHERE caja_id = ? ORDER BY date ASC",
            [caja.id]
        );

        const total_income = movements
            .filter(m => m.type === 'income')
            .reduce((sum, m) => sum + parseFloat(m.amount), 0);

        const total_expense = movements
            .filter(m => m.type === 'expense')
            .reduce((sum, m) => sum + parseFloat(m.amount), 0);

        res.json({ caja, movements, total_income, total_expense });

    } catch (error) {
        console.error("❌ Error al obtener caja actual:", error);
        res.status(500).json({ error: "Error al obtener el estado de la caja" });
    }
});

// ========================
// POST /caja/abrir
// Si es la PRIMERA caja que este usuario abre en toda la vida del
// sistema (no tiene ninguna caja previa, abierta o cerrada), el monto
// inicial se reconoce automáticamente en la contabilidad como el
// efectivo que el negocio ya tenía antes de empezar a usar Vansue.
// Cualquier apertura posterior es solo continuidad operativa (lo que
// quedó ayer) y NO genera un asiento nuevo — ya está contabilizado.
// ========================
router.post('/abrir', async (req, res) => {
    const { user_id, opening_amount } = req.body;

    if (!user_id || opening_amount === undefined || opening_amount < 0) {
        return res.status(400).json({ error: "Datos incompletos o monto inválido." });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [existing] = await connection.query(
            "SELECT id FROM cajas WHERE user_id = ? AND status = 'open'",
            [user_id]
        );

        if (existing.length) {
            await connection.rollback();
            return res.status(400).json({ error: "Ya tienes una caja abierta. Ciérrala antes de abrir otra." });
        }

        // ✅ ¿Es la primera caja de este usuario en toda la historia?
        const [anyPreviousCaja] = await connection.query(
            "SELECT id FROM cajas WHERE user_id = ? LIMIT 1",
            [user_id]
        );
        const esPrimeraCaja = anyPreviousCaja.length === 0;

        const [result] = await connection.query(
            "INSERT INTO cajas (user_id, opening_amount, status) VALUES (?, ?, 'open')",
            [user_id, opening_amount]
        );

        if (esPrimeraCaja && parseFloat(opening_amount) > 0) {
            await crearAsiento(connection, {
                description: `Apertura de caja #${result.insertId}: reconocimiento de saldo inicial de efectivo`,
                reference_type: 'apertura_caja',
                reference_id: result.insertId,
                user_id,
                lines: [
                    { code: '1101', debit: opening_amount },
                    { code: '3101', credit: opening_amount }
                ]
            });
        }

        await connection.commit();
        res.json({ message: "Caja abierta con éxito", caja_id: result.insertId });

    } catch (error) {
        await connection.rollback();
        console.error("❌ Error al abrir caja:", error);
        res.status(500).json({ error: "Error al abrir la caja" });
    } finally {
        connection.release();
    }
});

// ========================
// POST /caja/cerrar
// ========================
router.post('/cerrar', async (req, res) => {
    const { caja_id, closing_amount } = req.body;

    if (!caja_id || closing_amount === undefined || closing_amount < 0) {
        return res.status(400).json({ error: "Datos incompletos o monto inválido." });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [cajaResult] = await connection.query(
            "SELECT * FROM cajas WHERE id = ? AND status = 'open' FOR UPDATE",
            [caja_id]
        );

        if (!cajaResult.length) {
            await connection.rollback();
            return res.status(404).json({ error: "Caja no encontrada o ya está cerrada." });
        }

        const caja = cajaResult[0];

        const [movements] = await connection.query(
            "SELECT type, amount FROM movimientos_caja WHERE caja_id = ?",
            [caja_id]
        );

        const total_income = movements
            .filter(m => m.type === 'income')
            .reduce((sum, m) => sum + parseFloat(m.amount), 0);

        const total_expense = movements
            .filter(m => m.type === 'expense')
            .reduce((sum, m) => sum + parseFloat(m.amount), 0);

        const expected_amount = parseFloat(caja.opening_amount) + total_income - total_expense;
        const difference = parseFloat(closing_amount) - expected_amount;

        await connection.query(
            `UPDATE cajas 
             SET closing_amount = ?, expected_amount = ?, difference = ?, status = 'closed', closed_at = NOW() 
             WHERE id = ?`,
            [closing_amount, expected_amount, difference, caja_id]
        );

        if (difference !== 0) {
            if (difference < 0) {
                const [categoryResult] = await connection.query(
                    "SELECT id FROM categorias_gastos WHERE name = 'Faltante de Caja' LIMIT 1"
                );

                if (categoryResult.length) {
                    const [gastoInsert] = await connection.query(
                        `INSERT INTO gastos (category_id, concept, amount, payment_method, caja_id, user_id) 
                         VALUES (?, ?, ?, 'cash', ?, ?)`,
                        [
                            categoryResult[0].id,
                            `Faltante de caja al cierre #${caja_id}`,
                            Math.abs(difference),
                            caja_id,
                            caja.user_id
                        ]
                    );

                    await crearAsiento(connection, {
                        description: `Faltante de caja al cierre #${caja_id}`,
                        reference_type: 'ajuste',
                        reference_id: gastoInsert.insertId,
                        user_id: caja.user_id,
                        lines: [
                            { code: '6101', debit: Math.abs(difference) },
                            { code: '1101', credit: Math.abs(difference) }
                        ]
                    });
                }
            } else {
                const [ingresoInsert] = await connection.query(
                    `INSERT INTO ingresos_extra (concept, amount, payment_method, caja_id, user_id, is_system) 
                     VALUES (?, ?, 'cash', ?, ?, TRUE)`,
                    [
                        `Sobrante de caja al cierre #${caja_id}`,
                        difference,
                        caja_id,
                        caja.user_id
                    ]
                );

                await crearAsiento(connection, {
                    description: `Sobrante de caja al cierre #${caja_id}`,
                    reference_type: 'ajuste',
                    reference_id: ingresoInsert.insertId,
                    user_id: caja.user_id,
                    lines: [
                        { code: '1101', debit: difference },
                        { code: '4102', credit: difference }
                    ]
                });
            }
        }

        await connection.commit();
        res.json({
            message: "Caja cerrada con éxito",
            expected_amount,
            difference
        });

    } catch (error) {
        await connection.rollback();
        console.error("❌ Error al cerrar caja:", error);
        res.status(500).json({ error: "Error al cerrar la caja" });
    } finally {
        connection.release();
    }
});

// ========================
// GET /caja/ultimo-cierre?user_id=X
// ========================
router.get('/ultimo-cierre', async (req, res) => {
    const { user_id } = req.query;

    if (!user_id) {
        return res.status(400).json({ error: "Falta el user_id." });
    }

    try {
        const [result] = await db.query(
            `SELECT closing_amount, closed_at FROM cajas 
             WHERE user_id = ? AND status = 'closed' 
             ORDER BY closed_at DESC LIMIT 1`,
            [user_id]
        );

        if (!result.length) {
            return res.json({ last_closing: null });
        }

        res.json({ last_closing: result[0].closing_amount, closed_at: result[0].closed_at });

    } catch (error) {
        console.error("❌ Error al obtener último cierre:", error);
        res.status(500).json({ error: "Error al obtener el último cierre" });
    }
});

module.exports = router;