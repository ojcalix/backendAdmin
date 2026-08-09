const express = require('express');
const router = express.Router();
const db = require('../config/db');

// ========================
// GET /bancos
// Lista todas las cuentas bancarias
// ========================
router.get('/', async (req, res) => {
    try {
        const [results] = await db.query(
            "SELECT * FROM bancos ORDER BY bank_name ASC"
        );
        res.json(results);
    } catch (error) {
        console.error("❌ Error al obtener bancos:", error);
        res.status(500).json({ error: "Error al obtener las cuentas bancarias" });
    }
});

// ========================
// POST /bancos
// Crea una nueva cuenta bancaria con saldo inicial
// ========================
router.post('/', async (req, res) => {
    const { bank_name, account_number, account_alias, initial_balance } = req.body;

    if (!bank_name || !account_number) {
        return res.status(400).json({ error: "Banco y número de cuenta son obligatorios." });
    }

    try {
        const [result] = await db.query(
            `INSERT INTO bancos (bank_name, account_number, account_alias, current_balance) 
             VALUES (?, ?, ?, ?)`,
            [bank_name, account_number, account_alias || null, initial_balance || 0]
        );

        res.json({ message: "Cuenta bancaria agregada con éxito", bank_id: result.insertId });

    } catch (error) {
        console.error("❌ Error al agregar cuenta bancaria:", error);
        res.status(500).json({ error: "Error al agregar la cuenta bancaria" });
    }
});

// ========================
// PUT /bancos/:id/estado
// Activa o desactiva una cuenta bancaria
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
            "UPDATE bancos SET status = ? WHERE id = ?",
            [status, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Cuenta bancaria no encontrada." });
        }

        res.json({ message: "Estado actualizado con éxito" });

    } catch (error) {
        console.error("❌ Error al actualizar estado:", error);
        res.status(500).json({ error: "Error al actualizar el estado de la cuenta" });
    }
});

// ========================
// GET /bancos/:id/movimientos
// Lista los movimientos de una cuenta bancaria
// ========================
router.get('/:id/movimientos', async (req, res) => {
    const { id } = req.params;

    try {
        const [results] = await db.query(
            "SELECT * FROM movimientos_bancarios WHERE bank_id = ? ORDER BY date DESC",
            [id]
        );
        res.json(results);

    } catch (error) {
        console.error("❌ Error al obtener movimientos bancarios:", error);
        res.status(500).json({ error: "Error al obtener los movimientos" });
    }
});

// ========================
// POST /bancos/movimiento-manual
// Registra un depósito o retiro manual, validando saldo si es retiro
// ========================
router.post('/movimiento-manual', async (req, res) => {
    const { bank_id, type, amount, concept, affects_caja, user_id } = req.body;

    if (!bank_id || !amount || amount <= 0 || !concept) {
        return res.status(400).json({ error: "Datos incompletos o monto inválido." });
    }

    if (!['deposit', 'withdrawal'].includes(type)) {
        return res.status(400).json({ error: "Tipo de movimiento inválido." });
    }

    if (!user_id) {
        return res.status(400).json({ error: "Falta el usuario que registra el movimiento." });
    }

    try {
        await db.beginTransaction();

        const [bankResult] = await db.query(
            "SELECT * FROM bancos WHERE id = ? AND status = 'active' FOR UPDATE",
            [bank_id]
        );

        if (!bankResult.length) {
            await db.rollback();
            return res.status(404).json({ error: "Cuenta bancaria no encontrada o inactiva." });
        }

        const bank = bankResult[0];

        if (type === 'withdrawal' && parseFloat(amount) > parseFloat(bank.current_balance)) {
            await db.rollback();
            return res.status(400).json({
                error: `Saldo insuficiente en el banco. Disponible: L. ${parseFloat(bank.current_balance).toFixed(2)}`
            });
        }

        let cajaAbierta = null;

        if (affects_caja) {
            const [cajaResult] = await db.query(
                "SELECT id, opening_amount FROM cajas WHERE user_id = ? AND status = 'open' LIMIT 1 FOR UPDATE",
                [user_id]
            );

            if (!cajaResult.length) {
                await db.rollback();
                return res.status(400).json({ error: "Debes abrir tu caja para vincular este movimiento con el efectivo." });
            }

            cajaAbierta = cajaResult[0];

            if (type === 'deposit') {
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
                        error: `Saldo insuficiente en caja para depositar. Disponible: L. ${availableCash.toFixed(2)}`
                    });
                }
            }
        }

        // ✅ Insertar el movimiento bancario
        const [movBancoResult] = await db.query(
            `INSERT INTO movimientos_bancarios (bank_id, type, amount, concept, reference_type) 
             VALUES (?, ?, ?, ?, 'otro')`,
            [bank_id, type, amount, concept]
        );

        // ✅ Insertar el movimiento espejo en caja, si aplica
        if (cajaAbierta) {
            const cajaType = type === 'deposit' ? 'expense' : 'income';
            const cajaConcept = type === 'deposit'
                ? `Depósito a banco: ${concept}`
                : `Retiro de banco: ${concept}`;

            await db.query(
                `INSERT INTO movimientos_caja (caja_id, type, concept, amount, reference_type, reference_id) 
                 VALUES (?, ?, ?, ?, 'otro', ?)`,
                [cajaAbierta.id, cajaType, cajaConcept, amount, movBancoResult.insertId]
            );
        }

        // ✅ Actualizar el saldo de la cuenta bancaria
        const newBalance = type === 'deposit'
            ? parseFloat(bank.current_balance) + parseFloat(amount)
            : parseFloat(bank.current_balance) - parseFloat(amount);

        await db.query(
            "UPDATE bancos SET current_balance = ? WHERE id = ?",
            [newBalance, bank_id]
        );

        // ✅ Generar asiento contable
        if (affects_caja) {
            // Dinero se mueve entre Caja y Bancos (traspaso interno)
            await crearAsiento(db, {
                description: type === 'deposit' ? `Depósito externo: ${concept}` : `Retiro externo: ${concept}`,
                reference_type: 'ajuste',
                reference_id: movBancoResult.insertId,
                user_id,
                lines: type === 'deposit'
                    ? [{ code: '1102', debit: amount }, { code: '3101', credit: amount }]
                    : [{ code: '3101', debit: amount }, { code: '1102', credit: amount }]
            });
        } else {
            // Dinero externo entra/sale directo del banco (no tocó caja) → contra Capital Social
            await crearAsiento(db, {
                description: type === 'deposit' ? `Depósito externo: ${concept}` : `Retiro externo: ${concept}`,
                reference_type: 'ajuste',
                reference_id: movBancoResult.insertId,
                user_id: user_id || bank.id, // fallback por si no viene user_id cuando no afecta caja
                lines: type === 'deposit'
                    ? [{ code: '1102', debit: amount }, { code: '3101', credit: amount }]
                    : [{ code: '3101', debit: amount }, { code: '1102', credit: amount }]
            });
        }

        await db.commit();
        res.json({ message: "Movimiento registrado con éxito", new_balance: newBalance });

    } catch (error) {
        await db.rollback();
        console.error("❌ Error al registrar movimiento manual:", error);
        res.status(500).json({ error: "Error al registrar el movimiento" });
    }
});

module.exports = router;