const express = require('express');
const router = express.Router();
const db = require('../config/db');

// ========================
// POST /producto_proveedor
// Asocia un producto con un proveedor y su precio de compra
// ========================
router.post('/', async (req, res) => {
    const { product_id, supplier_id, purchase_price } = req.body;

    if (!product_id || !supplier_id || !purchase_price) {
        return res.status(400).json({ message: 'Producto, proveedor y precio son obligatorios.' });
    }

    try {
        // ✅ Verificar si ya existe la combinación
        const [existing] = await db.query(
            `SELECT id FROM producto_proveedor WHERE product_id = ? AND supplier_id = ? LIMIT 1`,
            [product_id, supplier_id]
        );

        if (existing.length > 0) {
            return res.status(409).json({
                message: 'Este producto ya está asociado a este proveedor'
            });
        }

        const [result] = await db.query(
            `INSERT INTO producto_proveedor (product_id, supplier_id, purchase_price) VALUES (?, ?, ?)`,
            [product_id, supplier_id, purchase_price]
        );

        res.status(201).json({
            message: 'Producto con su proveedor agregado correctamente',
            product_supplierId: result.insertId
        });

    } catch (err) {
        console.error('Error al ingresar el producto con su proveedor:', err);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

// ========================
// GET /producto_proveedor
// Lista todos los productos con sus proveedores y precios
// ========================
router.get('/', async (req, res) => {
    try {
        const query = `
            SELECT
                pp.id,
                p.name AS producto,
                pr.name AS proveedor,
                pp.purchase_price
            FROM producto_proveedor AS pp
            JOIN productos p ON pp.product_id = p.id
            JOIN proveedores pr ON pp.supplier_id = pr.id
        `;
        const [results] = await db.query(query);
        res.json(results);
    } catch (err) {
        console.error('Error al obtener los productos con proveedores:', err);
        res.status(500).send('Error al obtener los productos con proveedores en el backend');
    }
});

// ========================
// GET /producto_proveedor/detalle/:productId/:supplierId
// Precio de compra y venta para un producto-proveedor específico
// ========================
router.get('/detalle/:productId/:supplierId', async (req, res) => {
    try {
        const { productId, supplierId } = req.params;

        const [results] = await db.query(
            `SELECT 
                pp.purchase_price AS purchasePrice,
                p.sale_price AS salePrice
             FROM producto_proveedor pp
             JOIN productos p ON pp.product_id = p.id
             WHERE pp.product_id = ? AND pp.supplier_id = ?`,
            [productId, supplierId]
        );

        if (results.length === 0) {
            return res.status(404).send('No se encontraron precios para ese producto y proveedor');
        }

        res.status(200).json(results[0]);

    } catch (err) {
        console.error('Error al obtener precios:', err);
        res.status(500).send('Error al obtener precios');
    }
});

module.exports = router;