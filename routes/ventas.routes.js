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
        await db.promise().beginTransaction();

        // Insertar la venta principal
        const [ventaResult] = await db.promise().query(
            "INSERT INTO ventas (user_id, customer_id, total, earned_points) VALUES (?, ?, ?, ?)",
            [user_id, customer_id, total, earned_points]
        );
        const sale_id = ventaResult.insertId;

        let totalEarnedPoints = 0; // Para recalcular el total de puntos

        // Procesar cada producto
        for (const product of products) {
            // Consultar el stock actual del producto
            const [stockResult] = await db.promise().query(
                "SELECT quantity FROM productos WHERE id = ?",
                [product.product_id]
            );

            if (!stockResult.length) {
                await db.promise().rollback();
                return res.status(400).json({ error: `Producto con ID ${product.product_id} no encontrado.` });
            }

            const stockDisponible = stockResult[0].quantity;

            // Verificar si hay suficiente stock
            if (product.quantity > stockDisponible) {
                await db.promise().rollback();
                return res.status(400).json({ error: `Stock insuficiente para el producto ${product.product_id}. Disponible: ${stockDisponible}, solicitado: ${product.quantity}.` });
            }

            // Calcular puntos por cada producto (1 punto por cada 30 LPS en el subtotal)
            const productEarnedPoints = Math.floor(product.subtotal / 30);
            totalEarnedPoints += productEarnedPoints;

            // Insertar el detalle de la venta
            await db.promise().query(
                "INSERT INTO ventas_detalle (sale_id, product_id, quantity, subtotal, earned_points) VALUES (?, ?, ?, ?, ?)",
                [sale_id, product.product_id, product.quantity, product.subtotal, productEarnedPoints]
            );

            // Actualizar el stock del producto
            await db.promise().query(
                "UPDATE productos SET quantity = quantity - ? WHERE id = ?",
                [product.quantity, product.product_id]
            );
        }

        // Actualizar los puntos ganados en la tabla `ventas`
        await db.promise().query(
            "UPDATE ventas SET earned_points = ? WHERE id = ?",
            [totalEarnedPoints, sale_id]
        );

        // Registrar los puntos en historial_puntos si aplica
        if (totalEarnedPoints > 0 && customer_id !== null) {
            await db.promise().query(
                "INSERT INTO historial_puntos (customer_id, sale_id, points, type) VALUES (?, ?, ?, 'earned')",
                [customer_id, sale_id, totalEarnedPoints]
            );

            // Actualizar los puntos acumulados del cliente
            await db.promise().query(
                "UPDATE clientes SET accumulated_points = accumulated_points + ? WHERE id = ?",
                [totalEarnedPoints, customer_id]
            );
        }

        await db.promise().commit();
        res.json({ message: "Venta registrada con éxito" });
    } catch (error) {
        await db.promise().rollback();
        console.error("Error en el registro de venta:", error);
        res.status(500).json({ error: "Error al registrar la venta" });
    }
});
// Ruta para cargar las ventas
router.get('/', (req, res) => {
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
        `
    db.query(query, (err, results) => {
        if (err) {
            res.status(500).send('Error al obtener las ventas');
        } else {
            res.status(200).json(results);
        }
    })
});

//Obteniendo la factura del cliente
    // GET /ventas/:id
    router.get('/:id', async (req, res) => {
        const { id } = req.params;

        try {
            // Obtener venta y datos del cliente y usuario
            const [venta] = await db.promise().query(`
            SELECT v.id, v.total, v.sale_date, u.username, 
                   CONCAT(c.first_name, ' ', c.last_name) AS customer
            FROM ventas v
            JOIN usuarios u ON v.user_id = u.id
            LEFT JOIN clientes c ON v.customer_id = c.id
            WHERE v.id = ?
        `, [id]);

            if (!venta.length) return res.status(404).json({ error: 'Venta no encontrada' });

            // Obtener detalle de productos
            const [detalle] = await db.promise().query(`
            SELECT p.name, vd.quantity, (vd.subtotal / vd.quantity) AS precio_unitario, vd.subtotal
            FROM ventas_detalle vd
            JOIN productos p ON vd.product_id = p.id
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