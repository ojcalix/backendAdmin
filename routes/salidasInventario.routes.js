const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { crearAsiento } = require('../helpers/contabilidad');

// ========================
// POST /salidas-inventario
// Registra la salida de una unidad de inventario como regalo/muestra,
// sin pasar por ventas. Requiere autorización de un Administrador
// (misma mecánica que los descuentos con requires_authorization).
// ========================
router.post('/', async (req, res) => {
    const { variant_id, product_id, quantity, customer_id, reason, user_id, authorized_by, authorized_password } = req.body;

    if (!variant_id || !product_id || !quantity || quantity <= 0 || !reason || !user_id) {
        return res.status(400).json({ error: "Datos incompletos o cantidad inválida." });
    }

    if (!authorized_by) {
        return res.status(400).json({ error: "Esta operación requiere autorización de un administrador." });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // Verificar que authorized_by sea efectivamente un Administrador
        const [adminCheck] = await connection.query(
            "SELECT id, role FROM usuarios WHERE id = ?",
            [authorized_by]
        );

        if (!adminCheck.length || adminCheck[0].role !== 'Administrador') {
            await connection.rollback();
            return res.status(403).json({ error: "El usuario autorizador no es un administrador válido." });
        }

        const [variantResult] = await connection.query(
            "SELECT quantity FROM variantes WHERE id = ? AND product_id = ? FOR UPDATE",
            [variant_id, product_id]
        );

        if (!variantResult.length) {
            await connection.rollback();
            return res.status(404).json({ error: "Variante no encontrada." });
        }

        if (quantity > variantResult[0].quantity) {
            await connection.rollback();
            return res.status(400).json({ error: "Stock insuficiente para esta salida." });
        }

        if (customer_id) {
            const [customerExists] = await connection.query(
                "SELECT id FROM clientes WHERE id = ?",
                [customer_id]
            );
            if (!customerExists.length) {
                await connection.rollback();
                return res.status(404).json({ error: "Cliente no encontrado." });
            }
        }

        // Costo unitario: mismo patrón que usa ventas.routes.js — el
        // precio de compra más reciente de esa variante
        const [costRows] = await connection.query(
            `SELECT purchase_price FROM detalle_compras WHERE variant_id = ? ORDER BY id DESC LIMIT 1`,
            [variant_id]
        );
        const unitCost = costRows.length ? parseFloat(costRows[0].purchase_price) : 0;
        const totalCost = parseFloat((unitCost * quantity).toFixed(2));

        await connection.query(
            "UPDATE variantes SET quantity = quantity - ? WHERE id = ?",
            [quantity, variant_id]
        );

        const [salidaResult] = await connection.query(
            `INSERT INTO salidas_inventario 
                (variant_id, product_id, quantity, unit_cost, total_cost, customer_id, reason, user_id, requires_authorization, authorized_by) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?)`,
            [variant_id, product_id, quantity, unitCost, totalCost, customer_id || null, reason, user_id, authorized_by]
        );

        if (totalCost > 0) {
            await crearAsiento(connection, {
                description: `Salida de inventario (regalo/muestra): ${reason}`,
                reference_type: 'salida_inventario',
                reference_id: salidaResult.insertId,
                user_id,
                total: totalCost,
                lines: [
                    { code: '6105', debit: totalCost },
                    { code: '1104', credit: totalCost }
                ]
            });
        }

        await connection.commit();
        res.json({ message: "Salida de inventario registrada con éxito", id: salidaResult.insertId, total_cost: totalCost });

    } catch (error) {
        await connection.rollback();
        console.error("❌ Error al registrar salida de inventario:", error);
        res.status(500).json({ error: "Error al registrar la salida de inventario" });
    } finally {
        connection.release();
    }
});

// ========================
// GET /salidas-inventario
// ========================
router.get('/', async (req, res) => {
    try {
        const [results] = await db.query(`
            SELECT 
                si.id, si.quantity, si.unit_cost, si.total_cost, si.reason, si.date,
                p.name AS product_name,
                v.variant_name,
                CONCAT(c.first_name, ' ', c.last_name) AS customer_name,
                u.username AS registrado_por,
                au.username AS autorizado_por
            FROM salidas_inventario si
            JOIN productos p ON si.product_id = p.id
            JOIN variantes v ON si.variant_id = v.id
            LEFT JOIN clientes c ON si.customer_id = c.id
            JOIN usuarios u ON si.user_id = u.id
            LEFT JOIN usuarios au ON si.authorized_by = au.id
            ORDER BY si.date DESC
        `);
        res.json(results);
    } catch (error) {
        console.error("❌ Error al obtener salidas de inventario:", error);
        res.status(500).json({ error: "Error al obtener las salidas de inventario" });
    }
});

module.exports = router;