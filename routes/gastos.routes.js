const express = require('express');
const router = express.Router();
const db = require('../config/db');

// ========================
// GET /gastos/categorias
// Lista las categorías de gastos disponibles
// ========================
router.get('/categorias', async (req, res) => {
    try {
        const [results] = await db.query(
            "SELECT id, name FROM categorias_gastos WHERE is_system = FALSE ORDER BY name ASC"
        );
        res.json(results);
    } catch (error) {
        console.error("❌ Error al obtener categorías de gastos:", error);
        res.status(500).json({ error: "Error al obtener categorías de gastos" });
    }
});

// ========================
// GET /gastos
// Lista gastos con filtros opcionales de categoría y rango de fechas
// ========================
router.get('/', async (req, res) => {
    const { category_id, date_from, date_to } = req.query;

    try {
        let query = `
            SELECT 
                g.id,
                g.concept,
                g.amount,
                g.payment_method,
                g.date,
                cg.name AS category_name,
                u.username
            FROM gastos g
            INNER JOIN categorias_gastos cg ON g.category_id = cg.id
            INNER JOIN usuarios u ON g.user_id = u.id
            WHERE 1 = 1
        `;

        const params = [];

        if (category_id) {
            query += ` AND g.category_id = ?`;
            params.push(category_id);
        }

        if (date_from) {
            query += ` AND DATE(g.date) >= ?`;
            params.push(date_from);
        }

        if (date_to) {
            query += ` AND DATE(g.date) <= ?`;
            params.push(date_to);
        }

        query += ` ORDER BY g.date DESC`;

        const [results] = await db.query(query, params);
        res.json(results);

    } catch (error) {
        console.error("❌ Error al obtener gastos:", error);
        res.status(500).json({ error: "Error al obtener gastos" });
    }
});

// ========================
// POST /gastos
// Registra un nuevo gasto. Si es efectivo, exige caja abierta y genera movimiento
// ========================
router.post('/', async (req, res) => {
    const { category_id, concept, amount, payment_method, bank_id, user_id } = req.body;

    if (!category_id || !concept || !amount || amount <= 0 || !user_id) {
        return res.status(400).json({ error: "Datos incompletos o monto inválido." });
    }

    const validMethods = ['cash', 'bank'];
    if (!validMethods.includes(payment_method)) {
        return res.status(400).json({ error: "Método de pago inválido." });
    }

    if (payment_method === 'bank' && !bank_id) {
        return res.status(400).json({ error: "Debe seleccionar una cuenta bancaria." });
    }

    try {
        await db.beginTransaction();

        let cajaAbierta = null;
        let bankAccount = null;

        if (payment_method === 'cash') {
            const [cajaResult] = await db.query(
                "SELECT id, opening_amount FROM cajas WHERE user_id = ? AND status = 'open' LIMIT 1 FOR UPDATE",
                [user_id]
            );

            if (!cajaResult.length) {
                await db.rollback();
                return res.status(400).json({ error: "Debes abrir tu caja antes de registrar gastos en efectivo." });
            }

            cajaAbierta = cajaResult[0];

            const [movResult] = await db.query(
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
                await db.rollback();
                return res.status(400).json({
                    error: `Saldo insuficiente en caja. Disponible: L. ${availableCash.toFixed(2)}`
                });
            }
        }

        if (payment_method === 'bank') {
            const [bankResult] = await db.query(
                "SELECT id, current_balance FROM bancos WHERE id = ? AND status = 'active' FOR UPDATE",
                [bank_id]
            );

            if (!bankResult.length) {
                await db.rollback();
                return res.status(404).json({ error: "Cuenta bancaria no encontrada o inactiva." });
            }

            bankAccount = bankResult[0];

            if (parseFloat(amount) > parseFloat(bankAccount.current_balance)) {
                await db.rollback();
                return res.status(400).json({
                    error: `Saldo insuficiente en el banco. Disponible: L. ${parseFloat(bankAccount.current_balance).toFixed(2)}`
                });
            }
        }

        const [gastoResult] = await db.query(
            `INSERT INTO gastos (category_id, concept, amount, payment_method, caja_id, bank_id, user_id) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [category_id, concept, amount, payment_method, cajaAbierta ? cajaAbierta.id : null, bankAccount ? bank_id : null, user_id]
        );

        if (cajaAbierta) {
            await db.query(
                `INSERT INTO movimientos_caja (caja_id, type, concept, amount, reference_type, reference_id) 
                 VALUES (?, 'expense', ?, ?, 'gasto', ?)`,
                [cajaAbierta.id, concept, amount, gastoResult.insertId]
            );
        }

        if (bankAccount) {
            await db.query(
                `INSERT INTO movimientos_bancarios (bank_id, type, amount, concept, reference_type, reference_id) 
                 VALUES (?, 'transfer_out', ?, ?, 'gasto', ?)`,
                [bank_id, amount, concept, gastoResult.insertId]
            );

            await db.query(
                "UPDATE bancos SET current_balance = current_balance - ? WHERE id = ?",
                [amount, bank_id]
            );
        }

        await db.commit();
        res.json({ message: "Gasto registrado con éxito", gasto_id: gastoResult.insertId });

    } catch (error) {
        await db.rollback();
        console.error("❌ Error al registrar el gasto:", error);
        res.status(500).json({ error: "Error al registrar el gasto" });
    }
});

module.exports = router;