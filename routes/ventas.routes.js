const express = require('express');
const router = express.Router();
const db = require('../config/db'); // Importa la conexión correctamente

// Ruta para agregar una nueva venta
router.post('/', async (req, res) => {
    const { user_id, customer_id, total, earned_points, products } = req.body;

    if (!user_id || !products.length) {
        return res.status(400).json({ error: "Datos incompletos." });
    }

    try {
        // ✅ Iniciar transacción
        await db.beginTransaction();

        // ✅ Insertar venta
        const [ventaResult] = await db.query(
            "INSERT INTO ventas (user_id, customer_id, total, earned_points) VALUES (?, ?, ?, ?)",
            [user_id, customer_id, total, earned_points]
        );
        const sale_id = ventaResult.insertId;

        let totalEarnedPoints = 0;

        for (const product of products) {
            const { product_id, tone_id, quantity, subtotal } = product;

            if (tone_id) {
                // ✅ Verificar stock en tonos
                const [toneStockResult] = await db.query(
                    "SELECT quantity FROM tonos WHERE id = ?",
                    [tone_id]
                );

                if (!toneStockResult.length || quantity > toneStockResult[0].quantity) {
                    await db.rollback();
                    return res.status(400).json({ error: `Stock insuficiente o tono no encontrado (ID: ${tone_id})` });
                }

                // ✅ Descontar stock en tonos
                await db.query(
                    "UPDATE tonos SET quantity = quantity - ? WHERE id = ?",
                    [quantity, tone_id]
                );
            }

            // ✅ Verificar stock en producto general
            const [stockResult] = await db.query(
                "SELECT quantity FROM productos WHERE id = ?",
                [product_id]
            );

            if (!stockResult.length || quantity > stockResult[0].quantity) {
                await db.rollback();
                return res.status(400).json({ error: `Stock insuficiente o producto no encontrado (ID: ${product_id})` });
            }

            // ✅ Descontar stock en producto general
            await db.query(
                "UPDATE productos SET quantity = quantity - ? WHERE id = ?",
                [quantity, product_id]
            );

            const puntos = Math.floor(subtotal / 30);
            totalEarnedPoints += puntos;

            // ✅ Insertar detalle de venta
            await db.query(
                "INSERT INTO ventas_detalle (sale_id, product_id, tone_id, quantity, subtotal, earned_points) VALUES (?, ?, ?, ?, ?, ?)",
                [sale_id, product_id, tone_id, quantity, subtotal, puntos]
            );
        }

        // ✅ Actualizar puntos ganados en la venta
        await db.query(
            "UPDATE ventas SET earned_points = ? WHERE id = ?",
            [totalEarnedPoints, sale_id]
        );

        // ✅ Registrar puntos ganados en historial y cliente
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

        await db.commit();
        res.json({ message: "Venta registrada con éxito" });

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