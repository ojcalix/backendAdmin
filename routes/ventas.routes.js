const express = require('express');
const router = express.Router();
const db = require('../config/db'); // Importa la conexión correctamente
const { crearAsiento } = require('../helpers/contabilidad');
// Ruta para agregar una nueva venta

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

    try {
        await db.beginTransaction();

        let cajaAbierta = null;
        let bankAccount = null;

        if (entraDinero && payment_method === 'cash') {
            const [cajaResult] = await db.query(
                "SELECT id FROM cajas WHERE user_id = ? AND status = 'open' LIMIT 1",
                [user_id]
            );

            if (!cajaResult.length) {
                await db.rollback();
                return res.status(400).json({ error: "Debes abrir tu caja antes de registrar ventas en efectivo." });
            }

            cajaAbierta = cajaResult[0];
        }

        if (entraDinero && (payment_method === 'transfer' || payment_method === 'card')) {
            const [bankResult] = await db.query(
                "SELECT id FROM bancos WHERE id = ? AND status = 'active'",
                [bank_id]
            );

            if (!bankResult.length) {
                await db.rollback();
                return res.status(404).json({ error: "Cuenta bancaria no encontrada o inactiva." });
            }

            bankAccount = bankResult[0];
        }

        // ✅ Insertar venta
        const [ventaResult] = await db.query(
            `INSERT INTO ventas 
                (user_id, customer_id, payment_type, payment_status, payment_method, bank_id, total, paid_amount, pending_amount, earned_points) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [user_id, customer_id, payment_type, payment_status, payment_method || 'cash', bank_id || null, total, paid_amount, pending_amount, earned_points]
        );
        const sale_id = ventaResult.insertId;

        // ✅ Registrar movimiento de caja si el pago fue en efectivo
        if (cajaAbierta) {
            const concept = payment_type === 'cash'
                ? `Venta #${sale_id} (contado)`
                : `Venta #${sale_id} (abono inicial - mixto)`;

            await db.query(
                `INSERT INTO movimientos_caja (caja_id, type, concept, amount, reference_type, reference_id) 
                 VALUES (?, 'income', ?, ?, 'venta', ?)`,
                [cajaAbierta.id, concept, paid_amount, sale_id]
            );
        }

        // ✅ Registrar movimiento bancario si el pago fue transferencia/tarjeta
        if (bankAccount) {
            const concept = payment_type === 'cash'
                ? `Venta #${sale_id} (contado)`
                : `Venta #${sale_id} (abono inicial - mixto)`;

            await db.query(
                `INSERT INTO movimientos_bancarios (bank_id, type, amount, concept, reference_type, reference_id) 
                 VALUES (?, 'transfer_in', ?, ?, 'venta', ?)`,
                [bank_id, paid_amount, concept, sale_id]
            );

            await db.query(
                "UPDATE bancos SET current_balance = current_balance + ? WHERE id = ?",
                [paid_amount, bank_id]
            );
        }

        let totalEarnedPoints = 0;

        for (const product of products) {
            const { product_id, tone_id, quantity, subtotal } = product;

            if (tone_id) {
                const [toneStockResult] = await db.query(
                    "SELECT quantity FROM tonos WHERE id = ?",
                    [tone_id]
                );

                if (!toneStockResult.length || quantity > toneStockResult[0].quantity) {
                    await db.rollback();
                    return res.status(400).json({ error: `Stock insuficiente o tono no encontrado (ID: ${tone_id})` });
                }

                await db.query(
                    "UPDATE tonos SET quantity = quantity - ? WHERE id = ?",
                    [quantity, tone_id]
                );
            }

            const [stockResult] = await db.query(
                "SELECT quantity FROM productos WHERE id = ?",
                [product_id]
            );

            if (!stockResult.length || quantity > stockResult[0].quantity) {
                await db.rollback();
                return res.status(400).json({ error: `Stock insuficiente o producto no encontrado (ID: ${product_id})` });
            }

            await db.query(
                "UPDATE productos SET quantity = quantity - ? WHERE id = ?",
                [quantity, product_id]
            );

            const puntos = Math.floor(subtotal / 30);
            totalEarnedPoints += puntos;

            await db.query(
                "INSERT INTO ventas_detalle (sale_id, product_id, tone_id, quantity, subtotal, earned_points) VALUES (?, ?, ?, ?, ?, ?)",
                [sale_id, product_id, tone_id, quantity, subtotal, puntos]
            );
        }

        await db.query(
            "UPDATE ventas SET earned_points = ? WHERE id = ?",
            [totalEarnedPoints, sale_id]
        );

        if (totalEarnedPoints > 0 && customer_id !== null) {
            await db.query(
                "INSERT INTO historial_puntos (customer_id, sale_id, points, type) VALUES (?, ?, ?, 'earned')",
                [customer_id, sale_id, totalEarnedPoints]
            );

            await db.query(
                "UPDATE clientes SET accumulated_points = accumulated_points + ? WHERE id = ?",
                [totalEarnedPoints, customer_id]
            );
        }

        // ✅ Generar asiento contable
        const cuentaDinero = payment_method === 'cash' ? '1101' : '1102'; // Caja o Bancos

        const lines = [{ code: '4101', credit: total }]; // Ventas

        if (paid_amount > 0) {
            lines.push({ code: cuentaDinero, debit: paid_amount });
        }
        if (pending_amount > 0) {
            lines.push({ code: '1103', debit: pending_amount }); // Cuentas por Cobrar
        }

        await crearAsiento(db, {
            description: `Venta #${sale_id}`,
            reference_type: 'venta',
            reference_id: sale_id,
            user_id,
            lines
        });

        await db.commit();
        res.json({ message: "Venta registrada con éxito", sale_id });

    } catch (error) {
        await db.rollback();
        console.error("❌ Error en el registro de venta:", error);
        res.status(500).json({ error: "Error al registrar la venta" });
    }
});

// Ruta para cargar las ventas
router.get('/', async (req, res) => {
    const query = `
        SELECT
            v.id AS id_venta,
            u.username AS usuario,
            CONCAT(c.first_name, ' ', c.last_name) AS cliente,
            v.total,
            v.earned_points,
            v.sale_date
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

//Obteniendo la factura del cliente
// GET /ventas/:id
router.get('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const [venta] = await db.query(`
            SELECT v.id, v.total, v.sale_date, u.username, 
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
        t.tone_name,
        vd.quantity,
        (vd.subtotal / vd.quantity) AS precio_unitario,
        vd.subtotal
    FROM ventas_detalle vd
    JOIN productos p ON vd.product_id = p.id
    LEFT JOIN tonos t ON vd.tone_id = t.id
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