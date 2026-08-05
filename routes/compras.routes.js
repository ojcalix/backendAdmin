const express = require('express');
const router = express.Router();
const db = require('../config/db'); // Importa la conexión correctamente
const { route } = require('./productos.routes');

// Ruta para hacer el insert de compra de productos
// Ruta para hacer el insert de compra de productos
router.post('/', async (req, res) => {
    const { supplier_id, user_id, purchase_price, products } = req.body;

    try {
        console.log("🛠 DEBUG DATOS DE COMPRA:");
        console.log("Proveedor:", supplier_id);
        console.log("Usuario:", user_id);
        console.log("Precio total:", purchase_price);
        console.log("Productos recibidos:", JSON.stringify(products, null, 2));

        await db.beginTransaction();

        // Insertar compra
        const [compraResult] = await db.query(
            `INSERT INTO compras (supplier_id, user_id, purchase_price) VALUES (?, ?, ?)`,
            [supplier_id, user_id, purchase_price]
        );
        const purchase_id = compraResult.insertId;
        console.log("✅ Compra insertada con ID:", purchase_id);

        // Insertar detalle de compra y actualizar stock
        for (const product of products) {
            const toneIdValue = (product.tone_id !== null && product.tone_id !== "" && !isNaN(product.tone_id))
                ? parseInt(product.tone_id)
                : null;

            await db.query(
                `INSERT INTO detalle_compras
        (purchase_id,product_id,quantity,purchase_price,tone_id)
        VALUES (?,?,?,?,?)`,
                [
                    purchase_id,
                    product.product_id,
                    product.quantity,
                    product.purchase_price,
                    toneIdValue
                ]
            );

            if (toneIdValue !== null) {

                await db.query(
                    `UPDATE tonos
            SET quantity=quantity+?
            WHERE id=?`,
                    [product.quantity, toneIdValue]
                );

                await db.query(
                    `UPDATE productos
            SET quantity=(
                SELECT COALESCE(SUM(quantity),0)
                FROM tonos
                WHERE product_id=?
            )
            WHERE id=?`,
                    [product.product_id, product.product_id]
                );

            } else {

                await db.query(
                    `UPDATE productos
            SET quantity=quantity+?
            WHERE id=?`,
                    [product.quantity, product.product_id]
                );

            }
        }

        await db.commit();
        res.json({ message: "Compra realizada con éxito" });

    } catch (error) {
        await db.rollback();
        console.error("❌ Error al registrar la compra:", error);
        res.status(500).json({ error: "Error al registrar la compra" });
    }
});


router.get('/', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.id,
                p.name AS proveedor,
                u.username AS usuario,
                c.purchase_price,
                c.purchase_date
            FROM compras c 
            JOIN proveedores p ON c.supplier_id = p.id
            JOIN usuarios u ON c.user_id = u.id
            ORDER BY purchase_date DESC
        `;

        const [results] = await db.query(query);
        res.status(200).json(results);
    } catch (err) {
        console.error('Error al obtener compras:', err);
        res.status(500).send('El servidor tiene problemas para obtener las compras');
    }
});

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

router.get('/:productId/:supplierId', async (req, res) => {
    try {
        const { productId, supplierId } = req.params;

        const [rows] = await db.query(`
            SELECT
                pp.purchase_price AS purchasePrice,
                p.sale_price AS salePrice
            FROM producto_proveedor pp
            INNER JOIN productos p
                ON p.id=pp.product_id
            WHERE pp.product_id=?
            AND pp.supplier_id=?
            LIMIT 1
        `, [productId, supplierId]);

        if (rows.length === 0) {
            return res.status(404).json({
                message: "Este producto no tiene precio de compra registrado para este proveedor."
            });
        }

        res.json(rows[0]);

    } catch (err) {
        console.error("Error al obtener precios:", err);
        res.status(500).json({
            message: "Error al obtener los precios."
        });
    }
});


module.exports = router;