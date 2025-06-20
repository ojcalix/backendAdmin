const express = require('express');
const router = express.Router();
const db = require('../config/db'); // Importa la conexión correctamente
const { route } = require('./productos.routes');

//Ruta para hacer el insert de compra de productos
router.post('/', (req, res) => {
    const { supplier_id, user_id, purchase_price, products } = req.body;

    db.beginTransaction(async (err) => {
        if (err) {
            res.status(500).json({ error: "Error al iniciar la transaccion" });
            return;
        };

        try {
            // Insertar la venta en la tabla `compras`
            const [compraResult] = await db.promise().query(
                "INSERT INTO compras (supplier_id, user_id, purchase_price) VALUES (?, ?, ?)",
                [supplier_id, user_id, purchase_price]
            );

            // Obtener el ID de la compra recién insertada
            const purchase_id = compraResult.insertId;

            //Recorre todos los productos comprados
            for (const product of products) {
                //Insertar el producto en la tabla compras_detalle
                await db.promise().query(
                    "INSERT INTO detalle_compras(purchase_id, product_id, quantity, purchase_price) VALUES (?, ?, ?, ?)",
                    [purchase_id, product.product_id, product.quantity, product.purchase_price]
                );

                //Sumar la cantidad en el stock del producto
                await db.promise().query(
                    "UPDATE productos SET quantity = quantity + ? WHERE id = ?",
                    [product.quantity, product.product_id]
                );
            }

            //Confirmar la transaccion si todo salio bien
            db.commit();
            res.json({ message: "Compra realizada con exito" });
        } catch (error) {
            // Si hay un error, cancelar todos los cambios en la base de datos
            db.rollback();
            console.error("Error al registrar la comopra:", error);
            res.status(500).json({ error: "Error al registrar la venta" });
        }
    });
});

//Ruta para obtener las compras
router.get('/', (req, res) => {
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

    db.query(query, (err, result) => {
        if(err){
            res.status(500).send('El servidor tiene problemas para obtener las compras');
        }else{
            res.status(200).send(result);
        }
    });
});

//Buscar proveedor por nombre
router.get('/buscar/:term', (req, res) => {
    const term = `%${req.params.term}%`;
    const query = `
        SELECT id, name, phone
        FROM proveedores
        WHERE name LIKE ?
        LIMIT 50
    `;

    db.query(query, [term], (err, results) => {
        if(err){
            res.status(500).send('Error al buscar el proveedor');
        }else{
            res.status(200).json(results);
        }
    });
});

module.exports = router;