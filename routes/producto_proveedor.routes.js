const express = require('express');
const router = express.Router();
const db = require('../config/db');

// ========================
// POST /producto_proveedor
// Asocia un producto (o una variante específica de ese producto) con un
// proveedor y su precio de compra.
//
// variant_id es OPCIONAL:
//   - NULL  -> el precio aplica a TODAS las variantes del producto con
//              este proveedor (ej. maquillaje: el proveedor cobra lo
//              mismo por cualquier tono, se registra una sola vez).
//   - valor -> el precio aplica SOLO a esa variante (ej. perfume: cada
//              tamaño tiene su propio precio de compra con el proveedor).
// ========================
router.post('/', async (req, res) => {
    const { product_id, supplier_id, purchase_price, variant_id } = req.body;

    if (!product_id || !supplier_id || !purchase_price) {
        return res.status(400).json({ message: 'Producto, proveedor y precio son obligatorios.' });
    }

    const variantIdValue = (variant_id !== undefined && variant_id !== null && variant_id !== '')
        ? variant_id
        : null;

    try {
        // Si se especificó una variante, confirmar que en verdad pertenece a ese producto
        if (variantIdValue !== null) {
            const [variantCheck] = await db.query(
                `SELECT id FROM variantes WHERE id = ? AND product_id = ?`,
                [variantIdValue, product_id]
            );
            if (!variantCheck.length) {
                return res.status(400).json({ message: 'La variante seleccionada no pertenece a este producto.' });
            }
        }

        // ✅ Verificar si ya existe la combinación. Se usa el operador
        // NULL-safe (<=>) porque en MySQL "NULL = NULL" no es verdadero,
        // y aquí NULL representa "precio global" — sin esto se podría
        // registrar el precio global del mismo producto/proveedor varias veces.
        const [existing] = await db.query(
            `SELECT id FROM producto_proveedor 
             WHERE product_id = ? AND supplier_id = ? AND variant_id <=> ? 
             LIMIT 1`,
            [product_id, supplier_id, variantIdValue]
        );

        if (existing.length > 0) {
            return res.status(409).json({
                message: variantIdValue
                    ? 'Esta variante ya tiene un precio registrado con este proveedor.'
                    : 'Este producto ya tiene un precio global registrado con este proveedor.'
            });
        }

        const [result] = await db.query(
            `INSERT INTO producto_proveedor (product_id, supplier_id, variant_id, purchase_price) VALUES (?, ?, ?, ?)`,
            [product_id, supplier_id, variantIdValue, purchase_price]
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
// Lista todos los registros (producto completo o variante puntual) con
// su proveedor y precio. "variante" viene null cuando el precio es global.
// ========================
router.get('/', async (req, res) => {
    try {
        const query = `
            SELECT
                pp.id,
                p.name AS producto,
                pr.name AS proveedor,
                pp.purchase_price,
                pp.variant_id,
                v.variant_name AS variante
            FROM producto_proveedor AS pp
            JOIN productos p ON pp.product_id = p.id
            JOIN proveedores pr ON pp.supplier_id = pr.id
            LEFT JOIN variantes v ON pp.variant_id = v.id
            ORDER BY p.name ASC, v.variant_name ASC
        `;
        const [results] = await db.query(query);
        res.json(results);
    } catch (err) {
        console.error('Error al obtener los productos con proveedores:', err);
        res.status(500).send('Error al obtener los productos con proveedores en el backend');
    }
});

// ========================
// GET /producto_proveedor/detalle/:productId/:supplierId?variant_id=
// Precio de compra (y venta, si se indica variante) para un producto-
// proveedor específico. Si se pasa variant_id, busca primero el precio
// DE ESA VARIANTE; si no existe uno propio, cae al precio global del
// producto (variant_id NULL) — así maquillaje sigue funcionando con un
// solo registro aunque el llamado incluya variant_id.
// ========================
router.get('/detalle/:productId/:supplierId', async (req, res) => {
    try {
        const { productId, supplierId } = req.params;
        const { variant_id } = req.query;

        let purchaseRow = null;

        if (variant_id) {
            const [specific] = await db.query(
                `SELECT purchase_price AS purchasePrice
                 FROM producto_proveedor
                 WHERE product_id = ? AND supplier_id = ? AND variant_id = ?
                 LIMIT 1`,
                [productId, supplierId, variant_id]
            );
            if (specific.length) purchaseRow = specific[0];
        }

        if (!purchaseRow) {
            const [general] = await db.query(
                `SELECT purchase_price AS purchasePrice
                 FROM producto_proveedor
                 WHERE product_id = ? AND supplier_id = ? AND variant_id IS NULL
                 LIMIT 1`,
                [productId, supplierId]
            );
            if (general.length) purchaseRow = general[0];
        }

        if (!purchaseRow) {
            return res.status(404).send('No se encontraron precios para ese producto y proveedor');
        }

        let salePrice = null;
        if (variant_id) {
            const [variantSale] = await db.query(
                `SELECT sale_price FROM variantes WHERE id = ?`,
                [variant_id]
            );
            salePrice = variantSale.length ? variantSale[0].sale_price : null;
        }

        res.status(200).json({ purchasePrice: purchaseRow.purchasePrice, salePrice });

    } catch (err) {
        console.error('Error al obtener precios:', err);
        res.status(500).send('Error al obtener precios');
    }
});

// ========================
// DELETE /producto_proveedor/:id
// ========================
router.delete('/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM producto_proveedor WHERE id = ?', [req.params.id]);
        res.status(200).json({ success: true, message: 'Registro eliminado correctamente' });
    } catch (err) {
        console.error('Error al eliminar el registro producto-proveedor:', err);
        res.status(500).json({ message: 'Error al eliminar el registro' });
    }
});

module.exports = router;