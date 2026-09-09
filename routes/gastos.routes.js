const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { crearAsiento } = require('../helpers/contabilidad');

// ========================
// GET /gastos/categorias
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
// GET /gastos/compras-disponibles/:term
// Busca compras (por ID o nombre de proveedor) para vincular un gasto,
// ej. un envío que se paga después de recibir el producto.
// ========================
router.get('/compras-disponibles/:term', async (req, res) => {
    try {
        const { term } = req.params;

        const [results] = await db.query(`
            SELECT 
                c.id,
                COALESCE(p.name, 'Apertura de Inventario') AS proveedor,
                c.purchase_price,
                c.purchase_date
            FROM compras c
            LEFT JOIN proveedores p ON c.supplier_id = p.id
            WHERE c.id = ? OR p.name LIKE ?
            ORDER BY c.purchase_date DESC
            LIMIT 20
        `, [isNaN(term) ? 0 : term, `%${term}%`]);

        res.json(results);

    } catch (error) {
        console.error("❌ Error al buscar compras:", error);
        res.status(500).json({ error: "Error al buscar compras" });
    }
});

// ========================
// GET /gastos
// Incluye purchase_id y, si aplica, el proveedor de la compra vinculada.
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
                g.purchase_id,
                cg.name AS category_name,
                u.username,
                p.name AS linked_purchase_supplier
            FROM gastos g
            INNER JOIN categorias_gastos cg ON g.category_id = cg.id
            INNER JOIN usuarios u ON g.user_id = u.id
            LEFT JOIN compras c ON g.purchase_id = c.id
            LEFT JOIN proveedores p ON c.supplier_id = p.id
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
// purchase_id es opcional: cuando se envía, el gasto queda vinculado a
// esa compra (ej. envío pagado después de recibir el producto) y su
// asiento contable va a Gastos de Compras (6102) en vez del genérico
// Gastos Generales (6101), para mantener separado el costo logístico
// de compras del resto de gastos operativos.
// ========================
router.post('/', async (req, res) => {
    const { category_id, concept, amount, payment_method, bank_id, user_id, purchase_id } = req.body;

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

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        let cajaAbierta = null;
        let bankAccount = null;

        if (purchase_id) {
            const [purchaseExists] = await connection.query(
                "SELECT id FROM compras WHERE id = ?",
                [purchase_id]
            );

            if (!purchaseExists.length) {
                await connection.rollback();
                return res.status(404).json({ error: "La compra que intenta vincular no existe." });
            }
        }

        if (payment_method === 'cash') {
            const [cajaResult] = await connection.query(
                "SELECT id, opening_amount FROM cajas WHERE user_id = ? AND status = 'open' LIMIT 1 FOR UPDATE",
                [user_id]
            );

            if (!cajaResult.length) {
                await connection.rollback();
                return res.status(400).json({ error: "Debes abrir tu caja antes de registrar gastos en efectivo." });
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

        if (payment_method === 'bank') {
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

        const [gastoResult] = await connection.query(
            `INSERT INTO gastos (category_id, concept, amount, payment_method, caja_id, bank_id, user_id, purchase_id) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [category_id, concept, amount, payment_method, cajaAbierta ? cajaAbierta.id : null, bankAccount ? bank_id : null, user_id, purchase_id || null]
        );

        if (cajaAbierta) {
            await connection.query(
                `INSERT INTO movimientos_caja (caja_id, type, concept, amount, reference_type, reference_id) 
                 VALUES (?, 'expense', ?, ?, 'gasto', ?)`,
                [cajaAbierta.id, concept, amount, gastoResult.insertId]
            );
        }

        if (bankAccount) {
            await connection.query(
                `INSERT INTO movimientos_bancarios (bank_id, type, amount, concept, reference_type, reference_id) 
                 VALUES (?, 'transfer_out', ?, ?, 'gasto', ?)`,
                [bank_id, amount, concept, gastoResult.insertId]
            );

            await connection.query(
                "UPDATE bancos SET current_balance = current_balance - ? WHERE id = ?",
                [amount, bank_id]
            );
        }

        const cuentaOrigen = payment_method === 'cash' ? '1101' : '1102';
        const cuentaGasto = purchase_id ? '6102' : '6101';

        await crearAsiento(connection, {
            description: purchase_id ? `Gasto: ${concept} (vinculado a Compra #${purchase_id})` : `Gasto: ${concept}`,
            reference_type: 'gasto',
            reference_id: gastoResult.insertId,
            user_id,
            lines: [
                { code: cuentaGasto, debit: amount },
                { code: cuentaOrigen, credit: amount }
            ]
        });

        await connection.commit();
        res.json({ message: "Gasto registrado con éxito", gasto_id: gastoResult.insertId });

    } catch (error) {
        await connection.rollback();
        console.error("❌ Error al registrar el gasto:", error);
        res.status(500).json({ error: "Error al registrar el gasto" });
    } finally {
        connection.release();
    }
});

module.exports = router;