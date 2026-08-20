const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { crearAsiento } = require('../helpers/contabilidad');

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
        products
    } = req.body;

    if (!user_id || !products || !products.length) {
        return res.status(400).json({ error: "Datos incompletos." });
    }

    const validPaymentTypes = ['cash', 'credit', 'mixed'];
    if (!validPaymentTypes.includes(payment_type)) {
        return res.status(400).json({ error: "Forma de pago inválida." });
    }

    if ((payment_type === 'credit' || payment_type === 'mixed') && !customer_id) {
        return res.status(400).json({ error: "Las ventas a crédito o mixtas requieren un cliente." });
    }

    // Normalizado desde el inicio: así la verificación de caja/banco y el
    // INSERT final siempre usan exactamente el mismo valor, sin posibilidad
    // de que diverjan (mismo criterio que compras.js).
    const normalizedPaymentMethod = payment_method || 'cash';

    const entraDinero = (payment_type === 'cash' || payment_type === 'mixed') && paid_amount > 0;

    if (entraDinero) {
        const validMethods = ['cash', 'transfer', 'card'];
        if (!validMethods.includes(normalizedPaymentMethod)) {
            return res.status(400).json({ error: "Método de pago inválido." });
        }
        if ((normalizedPaymentMethod === 'transfer' || normalizedPaymentMethod === 'card') && !bank_id) {
            return res.status(400).json({ error: "Debe seleccionar una cuenta bancaria." });
        }
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        let cajaAbierta = null;
        let bankAccount = null;

        // ✅ Caja abierta: OBLIGATORIA para cualquier venta, sin importar el
        // método de pago. Representa la sesión de trabajo del usuario, no
        // solo el efectivo. Se bloquea la fila (FOR UPDATE) para que si otra
        // petición la cierra al mismo tiempo, esta venta no se cuele leyendo
        // un estado "abierta" que ya no es válido.
        const [cajaResult] = await connection.query(
            "SELECT id FROM cajas WHERE user_id = ? AND status = 'open' LIMIT 1 FOR UPDATE",
            [user_id]
        );

        if (!cajaResult.length) {
            await connection.rollback();
            return res.status(400).json({ error: "Debes abrir tu caja antes de registrar ventas." });
        }

        cajaAbierta = cajaResult[0];

        // ✅ Transferencia/tarjeta: además de la caja abierta, se bloquea la
        // fila del banco (FOR UPDATE) por el mismo motivo — evita
        // condiciones de carrera con otras operaciones sobre esa cuenta.
        if (entraDinero && (normalizedPaymentMethod === 'transfer' || normalizedPaymentMethod === 'card')) {
            const [bankResult] = await connection.query(
                "SELECT id FROM bancos WHERE id = ? AND status = 'active' FOR UPDATE",
                [bank_id]
            );

            if (!bankResult.length) {
                await connection.rollback();
                return res.status(404).json({ error: "Cuenta bancaria no encontrada o inactiva." });
            }

            bankAccount = bankResult[0];
        }

        // ✅ Insertar venta (earned_points se actualiza después, según lo que gane cada línea)
        const [ventaResult] = await connection.query(
            `INSERT INTO ventas 
                (user_id, customer_id, payment_type, payment_status, payment_method, bank_id, total, paid_amount, pending_amount, earned_points) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            [user_id, customer_id, payment_type, payment_status, normalizedPaymentMethod, bank_id || null, total, paid_amount, pending_amount]
        );
        const sale_id = ventaResult.insertId;

        // ✅ Registrar movimiento de caja solo si el dinero entró en efectivo
        if (entraDinero && normalizedPaymentMethod === 'cash') {
            const concept = payment_type === 'cash'
                ? `Venta #${sale_id} (contado)`
                : `Venta #${sale_id} (abono inicial - mixto)`;

            await connection.query(
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

        for (const product of products) {
            const { product_id, variant_id, quantity, subtotal } = product;

            if (!variant_id) {
                await connection.rollback();
                return res.status(400).json({ error: `Falta la variante para el producto (ID: ${product_id})` });
            }

            const [variantStockResult] = await connection.query(
                "SELECT quantity FROM variantes WHERE id = ? AND product_id = ? FOR UPDATE",
                [variant_id, product_id]
            );

            if (!variantStockResult.length || quantity > variantStockResult[0].quantity) {
                await connection.rollback();
                return res.status(400).json({ error: `Stock insuficiente o variante no encontrada (ID: ${variant_id})` });
            }

            await connection.query(
                "UPDATE variantes SET quantity = quantity - ? WHERE id = ?",
                [quantity, variant_id]
            );

            // 🔒 Los puntos solo se calculan y acumulan en ventas de CONTADO
            let puntos = 0;
            if (payment_type === 'cash') {
                puntos = Math.floor(subtotal / 30);
                totalEarnedPoints += puntos;
            }

            await connection.query(
                "INSERT INTO ventas_detalle (sale_id, product_id, variant_id, quantity, subtotal, earned_points) VALUES (?, ?, ?, ?, ?, ?)",
                [sale_id, product_id, variant_id, quantity, subtotal, puntos]
            );
        }

        await connection.query(
            "UPDATE ventas SET earned_points = ? WHERE id = ?",
            [totalEarnedPoints, sale_id]
        );

        // 🔒 El historial de puntos y la acumulación del cliente solo aplican en ventas de contado
        if (payment_type === 'cash' && totalEarnedPoints > 0 && customer_id !== null) {
            await connection.query(
                "INSERT INTO historial_puntos (customer_id, sale_id, points, type) VALUES (?, ?, ?, 'earned')",
                [customer_id, sale_id, totalEarnedPoints]
            );

            await connection.query(
                "UPDATE clientes SET accumulated_points = accumulated_points + ? WHERE id = ?",
                [totalEarnedPoints, customer_id]
            );
        }

        // ✅ Generar asiento contable
        const cuentaDinero = normalizedPaymentMethod === 'cash' ? '1101' : '1102';

        const lines = [{ code: '4101', credit: total }];

        if (paid_amount > 0) {
            lines.push({ code: cuentaDinero, debit: paid_amount });
        }
        if (pending_amount > 0) {
            lines.push({ code: '1103', debit: pending_amount });
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

// ========================
// GET /ventas/:id
// ========================
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