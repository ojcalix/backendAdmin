const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { crearAsiento } = require('../helpers/contabilidad');

// ========================
// POST /compras
// ========================
router.post('/', async (req, res) => {
    const {
        supplier_id,
        user_id,
        payment_type,
        payment_status,
        payment_method,
        bank_id,
        purchase_price,
        paid_amount,
        pending_amount,
        products
    } = req.body;

    if (!supplier_id || !user_id || !products || !products.length) {
        return res.status(400).json({ error: "Datos incompletos." });
    }

    const validPaymentTypes = ['cash', 'credit', 'mixed'];
    if (!validPaymentTypes.includes(payment_type)) {
        return res.status(400).json({ error: "Forma de pago inválida." });
    }

    // Normalizado desde el inicio: misma técnica que en ventas.js, así la
    // verificación de caja/banco y el INSERT final usan siempre el mismo valor.
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

        // ✅ Caja abierta: OBLIGATORIA para cualquier compra, sin importar el
        // método de pago — misma lógica que en ventas.js. Representa la
        // sesión de trabajo del usuario, no solo el efectivo.
        const [cajaResult] = await connection.query(
            "SELECT id, opening_amount FROM cajas WHERE user_id = ? AND status = 'open' LIMIT 1 FOR UPDATE",
            [user_id]
        );

        if (!cajaResult.length) {
            await connection.rollback();
            return res.status(400).json({ error: "Debes abrir tu caja antes de registrar compras." });
        }

        cajaAbierta = cajaResult[0];

        // ✅ Efectivo: además de exigir caja abierta, se valida que haya
        // saldo suficiente en caja para pagar esta compra.
        if (entraDinero && normalizedPaymentMethod === 'cash') {
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

            if (parseFloat(paid_amount) > availableCash) {
                await connection.rollback();
                return res.status(400).json({
                    error: `Saldo insuficiente en caja. Disponible: L. ${availableCash.toFixed(2)}`
                });
            }
        }

        // ✅ Transferencia/tarjeta: se bloquea la fila del banco (FOR UPDATE)
        // y se valida saldo suficiente antes de continuar.
        if (entraDinero && (normalizedPaymentMethod === 'transfer' || normalizedPaymentMethod === 'card')) {
            const [bankResult] = await connection.query(
                "SELECT id, current_balance FROM bancos WHERE id = ? AND status = 'active' FOR UPDATE",
                [bank_id]
            );

            if (!bankResult.length) {
                await connection.rollback();
                return res.status(404).json({ error: "Cuenta bancaria no encontrada o inactiva." });
            }

            bankAccount = bankResult[0];

            if (parseFloat(paid_amount) > parseFloat(bankAccount.current_balance)) {
                await connection.rollback();
                return res.status(400).json({
                    error: `Saldo insuficiente en el banco. Disponible: L. ${parseFloat(bankAccount.current_balance).toFixed(2)}`
                });
            }
        }

        // ✅ Insertar compra
        const [compraResult] = await connection.query(
            `INSERT INTO compras 
                (supplier_id, user_id, payment_type, payment_status, payment_method, bank_id, purchase_price, paid_amount, pending_amount) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [supplier_id, user_id, payment_type, payment_status, normalizedPaymentMethod, bank_id || null, purchase_price, paid_amount, pending_amount]
        );
        const purchase_id = compraResult.insertId;

        // ✅ Movimiento de caja solo si el dinero salió en efectivo
        if (entraDinero && normalizedPaymentMethod === 'cash') {
            const concept = payment_type === 'cash'
                ? `Compra #${purchase_id} (contado)`
                : `Compra #${purchase_id} (abono inicial - mixto)`;

            await connection.query(
                `INSERT INTO movimientos_caja (caja_id, type, concept, amount, reference_type, reference_id) 
                 VALUES (?, 'expense', ?, ?, 'compra', ?)`,
                [cajaAbierta.id, concept, paid_amount, purchase_id]
            );
        }

        // ✅ Movimiento bancario si el pago fue transferencia/tarjeta
        if (bankAccount) {
            const concept = payment_type === 'cash'
                ? `Compra #${purchase_id} (contado)`
                : `Compra #${purchase_id} (abono inicial - mixto)`;

            await connection.query(
                `INSERT INTO movimientos_bancarios (bank_id, type, amount, concept, reference_type, reference_id) 
                 VALUES (?, 'transfer_out', ?, ?, 'compra', ?)`,
                [bank_id, paid_amount, concept, purchase_id]
            );

            await connection.query(
                "UPDATE bancos SET current_balance = current_balance - ? WHERE id = ?",
                [paid_amount, bank_id]
            );
        }

        // ✅ Detalle de la compra — ahora por variante, no por "tono"
        for (const product of products) {
            const { product_id, variant_id, quantity, purchase_price: linePrice } = product;

            if (!variant_id) {
                await connection.rollback();
                return res.status(400).json({ error: `Falta la variante para el producto (ID: ${product_id})` });
            }

            const [variantExists] = await connection.query(
                "SELECT id FROM variantes WHERE id = ? AND product_id = ? FOR UPDATE",
                [variant_id, product_id]
            );

            if (!variantExists.length) {
                await connection.rollback();
                return res.status(400).json({ error: `Variante no encontrada (ID: ${variant_id})` });
            }

            await connection.query(
                `INSERT INTO detalle_compras (purchase_id, product_id, variant_id, quantity, purchase_price) 
                 VALUES (?, ?, ?, ?, ?)`,
                [purchase_id, product_id, variant_id, quantity, linePrice]
            );

            await connection.query(
                "UPDATE variantes SET quantity = quantity + ? WHERE id = ?",
                [quantity, variant_id]
            );
        }

        // ✅ Generar asiento contable
        const cuentaDinero = normalizedPaymentMethod === 'cash' ? '1101' : '1102';

        const lines = [{ code: '1104', debit: purchase_price }];

        if (paid_amount > 0) {
            lines.push({ code: cuentaDinero, credit: paid_amount });
        }
        if (pending_amount > 0) {
            lines.push({ code: '2101', credit: pending_amount });
        }

        await crearAsiento(connection, {
            description: `Compra #${purchase_id}`,
            reference_type: 'compra',
            reference_id: purchase_id,
            user_id,
            lines
        });

        await connection.commit();
        res.json({ message: "Compra registrada con éxito", purchase_id });

    } catch (error) {
        await connection.rollback();
        console.error("❌ Error al registrar la compra:", error);
        res.status(500).json({ error: "Error al registrar la compra" });
    } finally {
        connection.release();
    }
});

// ========================
// GET /compras
// ========================
router.get('/', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.id,
                p.name AS proveedor,
                u.username AS usuario,
                c.purchase_price,
                c.payment_status,
                c.purchase_date
            FROM compras c 
            JOIN proveedores p ON c.supplier_id = p.id
            JOIN usuarios u ON c.user_id = u.id
            ORDER BY c.purchase_date DESC
        `;

        const [results] = await db.query(query);
        res.status(200).json(results);
    } catch (err) {
        console.error('Error al obtener compras:', err);
        res.status(500).send('El servidor tiene problemas para obtener las compras');
    }
});

// ========================
// GET /compras/:id
// Detalle de una compra, con producto + variante
// ========================
router.get('/:id(\\d+)', async (req, res) => {
    try {
        const { id } = req.params;

        const [compra] = await db.query(`
            SELECT c.id, c.purchase_price, c.purchase_date, u.username, pr.name AS proveedor
            FROM compras c
            JOIN usuarios u ON c.user_id = u.id
            JOIN proveedores pr ON c.supplier_id = pr.id
            WHERE c.id = ?
        `, [id]);

        if (!compra.length) return res.status(404).json({ error: 'Compra no encontrada' });

        const [detalle] = await db.query(`
            SELECT 
                p.name AS product_name,
                p.brand,
                v.variant_name,
                dc.quantity,
                dc.purchase_price,
                (dc.quantity * dc.purchase_price) AS subtotal
            FROM detalle_compras dc
            JOIN productos p ON dc.product_id = p.id
            LEFT JOIN variantes v ON dc.variant_id = v.id
            WHERE dc.purchase_id = ?
        `, [id]);

        res.json({ compra: compra[0], productos: detalle });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al obtener la compra' });
    }
});

// ========================
// GET /compras/buscar/:term
// Búsqueda de proveedores (el nombre del endpoint se mantiene por
// compatibilidad con el frontend existente)
// ========================
router.get('/buscar/:term', async (req, res) => {
    try {
        const term = `%${req.params.term}%`;
        const query = `
            SELECT id, name, phone
            FROM proveedores
            WHERE name LIKE ?
            LIMIT 50
        `;

        const [results] = await db.query(query, [term]);
        res.status(200).json(results);
    } catch (err) {
        console.error('Error al buscar el proveedor:', err);
        res.status(500).send('Error al buscar el proveedor');
    }
});

// ========================
// GET /compras/:productId/:supplierId/:variantId
// Precio de compra (por proveedor) y precio de venta de una variante.
// Primero busca un precio propio de ESA variante (perfumería: cada
// tamaño con su propio precio). Si no existe, cae al precio GLOBAL del
// producto con variant_id NULL (maquillaje: mismo precio para todos los
// tonos, registrado una sola vez) — misma lógica que
// producto_proveedor.js /detalle/:productId/:supplierId.
// ========================
router.get('/:productId/:supplierId/:variantId', async (req, res) => {
    try {
        const { productId, supplierId, variantId } = req.params;

        const [specific] = await db.query(
            `SELECT purchase_price AS purchasePrice
             FROM producto_proveedor
             WHERE product_id = ? AND supplier_id = ? AND variant_id = ?
             LIMIT 1`,
            [productId, supplierId, variantId]
        );

        let purchaseRow = specific.length ? specific[0] : null;

        if (!purchaseRow) {
            const [general] = await db.query(
                `SELECT purchase_price AS purchasePrice
                 FROM producto_proveedor
                 WHERE product_id = ? AND supplier_id = ? AND variant_id IS NULL
                 LIMIT 1`,
                [productId, supplierId]
            );
            purchaseRow = general.length ? general[0] : null;
        }

        if (!purchaseRow) {
            return res.status(404).json({
                message: "Este producto no tiene precio de compra registrado para este proveedor."
            });
        }

        const [variantSale] = await db.query(
            `SELECT sale_price FROM variantes WHERE id = ?`,
            [variantId]
        );

        if (!variantSale.length) {
            return res.status(404).json({ message: "Variante no encontrada." });
        }

        res.json({ purchasePrice: purchaseRow.purchasePrice, salePrice: variantSale[0].sale_price });

    } catch (err) {
        console.error("Error al obtener precios:", err);
        res.status(500).json({ message: "Error al obtener los precios." });
    }
});

module.exports = router;

module.exports = router;