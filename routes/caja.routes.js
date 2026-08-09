const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { crearAsiento } = require('../helpers/contabilidad');

// ========================
// GET /caja/actual?user_id=X
// Devuelve la caja abierta del usuario (si existe), sus totales y movimientos
// ========================
router.get('/actual', async (req, res) => {
    const { user_id } = req.query;

    if (!user_id) {
        return res.status(400).json({ error: "Falta el user_id." });
    }

    try {
        // ✅ Buscar caja abierta de este usuario
        const [cajaResult] = await db.query(
            "SELECT * FROM cajas WHERE user_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1",
            [user_id]
        );

        if (!cajaResult.length) {
            return res.json({ caja: null });
        }

        const caja = cajaResult[0];

        // ✅ Obtener movimientos de esa caja
        const [movements] = await db.query(
            "SELECT * FROM movimientos_caja WHERE caja_id = ? ORDER BY date ASC",
            [caja.id]
        );

        // ✅ Calcular totales de ingresos y egresos
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
// Abre una nueva caja para un usuario (si no tiene ya una abierta)
// ========================
router.post('/abrir', async (req, res) => {
    const { user_id, opening_amount } = req.body;

    if (!user_id || opening_amount === undefined || opening_amount < 0) {
        return res.status(400).json({ error: "Datos incompletos o monto inválido." });
    }

    try {
        // ✅ Verificar que no tenga ya una caja abierta
        const [existing] = await db.query(
            "SELECT id FROM cajas WHERE user_id = ? AND status = 'open'",
            [user_id]
        );

        if (existing.length) {
            return res.status(400).json({ error: "Ya tienes una caja abierta. Ciérrala antes de abrir otra." });
        }

        const [result] = await db.query(
            "INSERT INTO cajas (user_id, opening_amount, status) VALUES (?, ?, 'open')",
            [user_id, opening_amount]
        );

        res.json({ message: "Caja abierta con éxito", caja_id: result.insertId });

    } catch (error) {
        console.error("❌ Error al abrir caja:", error);
        res.status(500).json({ error: "Error al abrir la caja" });
    }
});

// ========================
// POST /caja/cerrar
// Cierra una caja, calcula diferencia y genera ajuste automático si aplica
// ========================
router.post('/cerrar', async (req, res) => {
    const { caja_id, closing_amount } = req.body;

    if (!caja_id || closing_amount === undefined || closing_amount < 0) {
        return res.status(400).json({ error: "Datos incompletos o monto inválido." });
    }

    try {
        await db.beginTransaction();

        // ✅ Verificar que la caja exista y esté abierta
        const [cajaResult] = await db.query(
            "SELECT * FROM cajas WHERE id = ? AND status = 'open' FOR UPDATE",
            [caja_id]
        );

        if (!cajaResult.length) {
            await db.rollback();
            return res.status(404).json({ error: "Caja no encontrada o ya está cerrada." });
        }

        const caja = cajaResult[0];

        // ✅ Recalcular ingresos y egresos desde la base de datos
        const [movements] = await db.query(
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

        // ✅ Actualizar la caja
        await db.query(
            `UPDATE cajas 
             SET closing_amount = ?, expected_amount = ?, difference = ?, status = 'closed', closed_at = NOW() 
             WHERE id = ?`,
            [closing_amount, expected_amount, difference, caja_id]
        );

        // ✅ Generar ajuste automático si hay diferencia
        if (difference !== 0) {
            if (difference < 0) {
                // Faltante → se registra como gasto
                const [categoryResult] = await db.query(
                    "SELECT id FROM categorias_gastos WHERE name = 'Faltante de Caja' LIMIT 1"
                );

                if (categoryResult.length) {
                    const [gastoInsert] = await db.query(
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

                    // ✅ Asiento contable del faltante
                    await crearAsiento(db, {
                        description: `Faltante de caja al cierre #${caja_id}`,
                        reference_type: 'ajuste',
                        reference_id: gastoInsert.insertId,
                        user_id: caja.user_id,
                        lines: [
                            { code: '6101', debit: Math.abs(difference) }, // Gastos Generales
                            { code: '1101', credit: Math.abs(difference) } // Caja
                        ]
                    });
                }
            } else {
                // Sobrante → se registra como ingreso extra
                const [ingresoInsert] = await db.query(
                    `INSERT INTO ingresos_extra (concept, amount, payment_method, caja_id, user_id, is_system) 
                     VALUES (?, ?, 'cash', ?, ?, TRUE)`,
                    [
                        `Sobrante de caja al cierre #${caja_id}`,
                        difference,
                        caja_id,
                        caja.user_id
                    ]
                );

                // ✅ Asiento contable del sobrante
                await crearAsiento(db, {
                    description: `Sobrante de caja al cierre #${caja_id}`,
                    reference_type: 'ajuste',
                    reference_id: ingresoInsert.insertId,
                    user_id: caja.user_id,
                    lines: [
                        { code: '1101', debit: difference },  // Caja
                        { code: '4102', credit: difference }  // Otros Ingresos
                    ]
                });
            }
        }

        await db.commit();
        res.json({
            message: "Caja cerrada con éxito",
            expected_amount,
            difference
        });

    } catch (error) {
        await db.rollback();
        console.error("❌ Error al cerrar caja:", error);
        res.status(500).json({ error: "Error al cerrar la caja" });
    }
});

// ========================
// GET /caja/ultimo-cierre?user_id=X
// Devuelve el monto del último cierre de este usuario, si existe
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