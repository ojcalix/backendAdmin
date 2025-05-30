const express = require('express');
const router = express.Router();
const db = require('../config/db'); // Importa la conexión correctamente

//Ruta para insertar un producto con su proveedor
router.post('/', (req, res) => {
    const { product_id, supplier_id, purchase_price } = req.body;
    
    const query = 'INSERT INTO producto_proveedor (product_id, supplier_id, purchase_price) VALUES (?, ?, ?)';

    db.query(query, [product_id, supplier_id, purchase_price], (err, result) => {
        if(err){
            res.status(500).send('Error al ingresar el producto con su proveedor');
        }else{
            res.status(201).json({ message: 'Producto con su proveedor agregado correctamente', product_supplierId: result.insertId})
        }
    });
});

// Obtener todos los productos con sus proveedores y precios
router.get('/', (req, res) => {
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

    db.query(query, (err, results) =>{
        if (err){
            console.error('Error al obtener los productos con proveedores:', err);
            res.status(500).send('Error al obtener los productos con proveedores en el backend');
        }else{
            res.json(results);
        }
    });
});

// GET /producto_proveedor/detalle/:productId/:supplierId
router.get('/detalle/:productId/:supplierId', (req, res) => {
    const { productId, supplierId } = req.params;

    const query = `
        SELECT 
            pp.purchase_price AS purchasePrice,
            p.sale_price AS salePrice
        FROM producto_proveedor pp
        JOIN productos p ON pp.product_id = p.id
        WHERE pp.product_id = ? AND pp.supplier_id = ?
    `;

    db.query(query, [productId, supplierId], (err, results) => {
        if (err) {
            console.error('Error al obtener precios:', err);
            return res.status(500).send('Error al obtener precios');
        }

        if (results.length === 0) {
            return res.status(404).send('No se encontraron precios para ese producto y proveedor');
        }

        res.status(200).json(results[0]);
    });
});


module.exports = router;