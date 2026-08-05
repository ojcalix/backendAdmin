const express = require('express');
const router = express.Router();
const db = require('../config/db'); // conexión mysql2/promise

// Ruta para insertar un producto con su proveedor
router.post('/', async (req, res) => {
    try {
        const { product_id, supplier_id, purchase_price } = req.body;

        // 1️⃣ Verificar si ya existe la combinación
        const checkQuery = `
            SELECT id 
            FROM producto_proveedor 
            WHERE product_id = ? AND supplier_id = ?
            LIMIT 1
        `;

        const [existing] = await db.query(checkQuery, [product_id, supplier_id]);

        if (existing.length > 0) {
            return res.status(409).json({
                message: 'Este producto ya está asociado a este proveedor'
            });
        }

        // 2️⃣ Insertar si no existe
        const insertQuery = `
            INSERT INTO producto_proveedor (product_id, supplier_id, purchase_price)
            VALUES (?, ?, ?)
        `;

        const [result] = await db.query(insertQuery, [
            product_id,
            supplier_id,
            purchase_price
        ]);

        res.status(201).json({
            message: 'Producto con su proveedor agregado correctamente',
            product_supplierId: result.insertId
        });

    } catch (err) {
        console.error('Error al ingresar el producto con su proveedor:', err);
        res.status(500).json({
            message: 'Error interno del servidor'
        });
    }
});


// Obtener todos los productos con sus proveedores y precios
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

// GET /producto_proveedor/detalle/:productId/:supplierId
router.get('/detalle/:productId/:supplierId', async (req, res) => {
    try {
        const { productId, supplierId } = req.params;
        const query = `
            SELECT 
                pp.purchase_price AS purchasePrice,
                p.sale_price AS salePrice
            FROM producto_proveedor pp
            JOIN productos p ON pp.product_id = p.id
            WHERE pp.product_id = ? AND pp.supplier_id = ?
        `;
        const [results] = await db.query(query, [productId, supplierId]);
        
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
