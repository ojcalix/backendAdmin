const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { crearAsiento } = require('../helpers/contabilidad');

// ========================
// GET /fuentes_financiamiento
// ========================
router.get('/', async (req, res) => {
    try {
        const [results] = await db.query(`
            SELECT ff.*, cc.code AS account_code, cc.name AS account_name
            FROM fuentes_financiamiento ff
            JOIN cuentas_contables cc ON ff.account_id = cc.id
            ORDER BY ff.name ASC
        `);
        res.json(results);
    } catch (error) {
        console.error("❌ Error al obtener fuentes de financiamiento:", error);
        res.status(500).json({ error: "Error al obtener las fuentes de financiamiento" });
    }
});

// ========================
// POST /fuentes_financiamiento
// Si initial_balance > 0, genera el asiento: Debe Capital Social / Haber la
// cuenta de esta fuente — para que la deuda quede respaldada en el Balance.
// ========================
router.post('/', async (req, res) => {
    const { name, type, account_id, credit_limit, initial_balance, user_id } = req.body;

    const validTypes = ['tarjeta_credito', 'propietario', 'otro'];

    if (!name || !type || !account_id) {
        return res.status(400).json({ error: "Nombre, tipo y cuenta contable son obligatorios." });
    }

    if (!validTypes.includes(type)) {
        return res.status(400).json({ error: "Tipo de fuente inválido." });
    }

    const balance = parseFloat(initial_balance) || 0;

    if (balance > 0 && !user_id) {
        return res.status(400).json({ error: "Falta el usuario para registrar la deuda inicial." });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [result] = await connection.query(
            `INSERT INTO fuentes_financiamiento (name, type, account_id, credit_limit, current_balance) 
             VALUES (?, ?, ?, ?, ?)`,
            [name, type, account_id, credit_limit || null, balance]
        );

        const sourceId = result.insertId;

        // ✅ Si ya arranca con deuda, respaldarla con un asiento
        if (balance > 0) {
            const [accountRow] = await connection.query(
                'SELECT code FROM cuentas_contables WHERE id = ?',
                [account_id]
            );

            await crearAsiento(connection, {
                description: `Deuda inicial de "${name}"`,
                reference_type: 'ajuste',
                reference_id: sourceId,
                user_id,
                lines: [
                    { code: '3101', debit: balance },       // Capital Social
                    { code: accountRow[0].code, credit: balance } // Cuenta de esta fuente
                ]
            });
        }

        await connection.commit();
        res.json({ message: "Fuente de financiamiento agregada con éxito", id: sourceId });

    } catch (error) {
        await connection.rollback();
        console.error("❌ Error al agregar fuente de financiamiento:", error);
        res.status(500).json({ error: "Error al agregar la fuente de financiamiento" });
    } finally {
        connection.release();
    }
});

// ========================
// PUT /fuentes_financiamiento/:id/estado
// ========================
router.put('/:id/estado', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    const validStatus = ['active', 'inactive'];
    if (!validStatus.includes(status)) {
        return res.status(400).json({ error: "Estado inválido." });
    }

    try {
        const [result] = await db.query(
            "UPDATE fuentes_financiamiento SET status = ? WHERE id = ?",
            [status, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Fuente de financiamiento no encontrada." });
        }

        res.json({ message: "Estado actualizado con éxito" });

    } catch (error) {
        console.error("❌ Error al actualizar estado:", error);
        res.status(500).json({ error: "Error al actualizar el estado" });
    }
});

// ========================
// GET /fuentes_financiamiento/:id/movimientos
// ========================
router.get('/:id/movimientos', async (req, res) => {
    const { id } = req.params;

    try {
        const [results] = await db.query(
            "SELECT * FROM movimientos_financiamiento WHERE financing_source_id = ? ORDER BY date DESC",
            [id]
        );
        res.json(results);

    } catch (error) {
        console.error("❌ Error al obtener movimientos:", error);
        res.status(500).json({ error: "Error al obtener los movimientos" });
    }
});

// ========================
// POST /fuentes_financiamiento/pago
// ========================
router.post('/pago', async (req, res) => {
    const { financing_source_id, amount, payment_method, bank_id, notes, user_id } = req.body;

    if (!financing_source_id || !amount || amount <= 0 || !user_id) {
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

        const [sourceResult] = await connection.query(
            "SELECT * FROM fuentes_financiamiento WHERE id = ? AND status = 'active' FOR UPDATE",
            [financing_source_id]
        );

        if (!sourceResult.length) {
            await connection.rollback();
            return res.status(404).json({ error: "Fuente de financiamiento no encontrada o inactiva." });
        }

        const source = sourceResult[0];

        if (parseFloat(amount) > parseFloat(source.current_balance)) {
            await connection.rollback();
            return res.status(400).json({
                error: `El monto excede la deuda actual. Deuda: L. ${parseFloat(source.current_balance).toFixed(2)}`
            });
        }

        let cajaAbierta = null;
        let bankAccount = null;

        if (payment_method === 'cash') {
            const [cajaResult] = await connection.query(
                "SELECT id, opening_amount FROM cajas WHERE user_id = ? AND status = 'open' LIMIT 1 FOR UPDATE",
                [user_id]
            );

            if (!cajaResult.length) {
                await connection.rollback();
                return res.status(400).json({ error: "Debes abrir tu caja para pagar en efectivo." });
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

        const [pagoResult] = await connection.query(
            `INSERT INTO pagos_financiamiento (financing_source_id, user_id, amount, payment_method, notes) 
             VALUES (?, ?, ?, ?, ?)`,
            [financing_source_id, user_id, amount, payment_method, notes || null]
        );

        const concept = `Pago a ${source.name}`;

        await connection.query(
            `INSERT INTO movimientos_financiamiento (financing_source_id, type, amount, concept, reference_type, reference_id) 
             VALUES (?, 'payment', ?, ?, 'pago_financiamiento', ?)`,
            [financing_source_id, amount, concept, pagoResult.insertId]
        );

        await connection.query(
            "UPDATE fuentes_financiamiento SET current_balance = current_balance - ? WHERE id = ?",
            [amount, financing_source_id]
        );

        if (cajaAbierta) {
            await connection.query(
                `INSERT INTO movimientos_caja (caja_id, type, concept, amount, reference_type, reference_id) 
                 VALUES (?, 'expense', ?, ?, 'otro', ?)`,
                [cajaAbierta.id, concept, amount, pagoResult.insertId]
            );
        }

        if (bankAccount) {
            await connection.query(
                `INSERT INTO movimientos_bancarios (bank_id, type, amount, concept, reference_type, reference_id) 
                 VALUES (?, 'transfer_out', ?, ?, 'otro', ?)`,
                [bank_id, amount, concept, pagoResult.insertId]
            );

            await connection.query(
                "UPDATE bancos SET current_balance = current_balance - ? WHERE id = ?",
                [amount, bank_id]
            );
        }

        const cuentaOrigen = payment_method === 'cash' ? '1101' : '1102';
        const [accountRow] = await connection.query(
            'SELECT code FROM cuentas_contables WHERE id = ?', [source.account_id]
        );

        await crearAsiento(connection, {
            description: concept,
            reference_type: 'pago_financiamiento',
            reference_id: pagoResult.insertId,
            user_id,
            lines: [
                { code: accountRow[0].code, debit: amount },
                { code: cuentaOrigen, credit: amount }
            ]
        });

        await connection.commit();
        res.json({ message: "Pago registrado con éxito" });

    } catch (error) {
        await connection.rollback();
        console.error("❌ Error al registrar pago:", error);
        res.status(500).json({ error: "Error al registrar el pago" });
    } finally {
        connection.release();
    }
});

module.exports = router;