const express = require('express');
const router = express.Router();
const path = require('path');
const sharp = require('sharp');
const multer = require('multer');
const fs = require('fs');
const db = require('../config/db'); // Ajusta esta ruta según tu estructura

// Configuración de multer (almacenamiento en memoria)
const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post('/', upload.single('productImage'), async (req, res) => {
    try {
        const {
            barcode, productName, productBrand, productCategory,
            productSubCategory, productDescription, salePrice, productQuantity
        } = req.body;

        let imagePath = null;

        if (req.file) {
            const sanitizedProductName = productName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
            const uniqueName = `${sanitizedProductName}_${Date.now()}.webp`;
            const outputPath = path.join(__dirname, '..', 'uploads', uniqueName);

            await sharp(req.file.buffer)
                .resize(400, 400, { fit: 'inside' }) // puedes ajustar a 300x300 si lo deseas
                .webp({ quality: 60 }) // puedes bajar a 50 o incluso 40 para aún menos peso
                .toFile(outputPath);

            const serverUrl = `${req.protocol}://${req.get('host')}`;
            imagePath = `${serverUrl}/uploads/${uniqueName}`;
        }

        const sql = `
        INSERT INTO productos 
        (barcode, name, brand, description, category_id, subcategory_id, sale_price, quantity, image) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.query(sql, [
            barcode, productName, productBrand, productDescription,
            productCategory, productSubCategory, salePrice, productQuantity, imagePath
        ], (err) => {
            if (err) {
                console.error('Error al agregar el producto:', err);
                return res.status(500).send('Error al agregar el producto');
            }
            res.send('Producto agregado correctamente');
        });

    } catch (error) {
        console.error('Error procesando la imagen:', error);
        res.status(500).send('Error procesando la imagen');
    }
});

// Ruta para cargar todos los productos desde la base de datos
router.get('/', (req, res) => {
    const serverUrl = `${req.protocol}://${req.get('host')}`; // Obtener la URL dinámica

    const query = `
    SELECT 
        productos.id AS productId,
        productos.barcode AS barCode,          
        productos.name AS productName,      
        productos.brand AS productBrand,    
        productos.description AS productDescription, 
        categorias.name AS productCategory,
        productos.sale_price AS salePrice,  
        productos.quantity AS productQuantity, 
        productos.image AS productImage,  
        productos.registration_date AS createdAt 
    FROM productos
    LEFT JOIN categorias ON productos.category_id = categorias.id
    ORDER BY productos.registration_date DESC;
`;

    db.query(query, [serverUrl], (err, results) => {
        if (err) {
            console.error('Error al cargar los productos:', err);
            return res.status(500).send('Error al cargar los productos');
        }
        res.status(200).json(results);
    });
});

//Ruta para obtener los productos
router.get('/:id', (req, res) => {
    const productId = req.params.id;
    const serverUrl = `${req.protocol}://${req.get('host')}`;

    const query = `
        SELECT 
            id AS productId, barcode, name AS productName, brand AS productBrand, 
            description AS productDescription, category_id, sale_price AS salePrice, 
            quantity AS productQuantity, image AS productImage
        FROM productos 
        WHERE id = ?
    `;

    db.query(query, [productId], (err, results) => {
        if (err) {
            console.error('Error al obtener el producto:', err);
            return res.status(500).send('Error al obtener el producto');
        }
        if (results.length === 0) {
            return res.status(404).send('Producto no encontrado');
        }
        res.status(200).json(results[0]);
    });
});

// Backend: Ruta para actualizar un producto
router.put('/:id', upload.single('image'), async (req, res) => {
    const productId = req.params.id;
    const {
        id,
        barcode,
        name,
        brand,
        description,
        category_id,
        sale_price,
        quantity
    } = req.body;

    const serverUrl = `${req.protocol}://${req.get('host')}`;

    const selectImageSql = 'SELECT image FROM productos WHERE id = ?';
    db.query(selectImageSql, [productId], async (err, result) => {
        if (err) {
            console.error('Error al obtener la imagen actual:', err);
            return res.status(500).json({ error: 'Error en la base de datos' });
        }

        let imagePath = (result.length > 0) ? result[0].image : null;

        // Si se sube una nueva imagen
        if (req.file) {
            // Eliminar imagen anterior del sistema de archivos
            if (imagePath && imagePath.includes('/uploads/')) {
                const oldImageName = imagePath.split('/uploads/')[1];
                const oldImagePath = path.join(__dirname, '..', 'uploads', oldImageName);
                fs.unlink(oldImagePath, (unlinkErr) => {
                    if (unlinkErr) {
                        console.warn('No se pudo eliminar la imagen anterior:', unlinkErr.message);
                    } else {
                        console.log('Imagen anterior eliminada:', oldImagePath);
                    }
                });
            }

            // Procesar nueva imagen
            const sanitizedProductName = name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
            const uniqueName = `${sanitizedProductName}_${Date.now()}.webp`;
            const outputPath = path.join(__dirname, '..', 'uploads', uniqueName);

            try {
                await sharp(req.file.buffer)
                    .resize(400, 400, { fit: 'inside' })
                    .webp({ quality: 60 })
                    .toFile(outputPath);

                imagePath = `${serverUrl}/uploads/${uniqueName}`;
            } catch (err) {
                console.error('Error procesando la nueva imagen:', err);
                return res.status(500).json({ error: 'Error procesando la imagen' });
            }
        }

        const updateSql = `
            UPDATE productos SET 
                id = ?, 
                barcode = ?, 
                name = ?, 
                brand = ?, 
                description = ?, 
                category_id = ?, 
                sale_price = ?, 
                quantity = ?, 
                image = ?
            WHERE id = ?
        `;

        db.query(updateSql, [
            id || productId,
            barcode, name, brand, description, category_id,
            sale_price, quantity, imagePath,
            productId
        ], (err) => {
            if (err) {
                console.error('Error al actualizar el producto:', err);
                return res.status(500).json({ error: 'Error al actualizar el producto' });
            }
            res.json({ message: 'Producto actualizado correctamente' });
        });
    });
});

//Ruta para eliminar un product0
router.delete('/:id', async (req, res) => {
    const productId = req.params.id;
    const query = 'DELETE FROM productos WHERE id = ?';

    db.query(query, [productId], (err, result) => {
        if (err) {
            res.status(500).send('Error al eliminar el producto');
        } else {
            res.status(200).json({ success: true, message: 'Producto eliminada correctamente' });
        }
    })
})

//Cargar la imagen del producto a la tabla de compras, para la visualizacion del producto que se esta comprando
router.get('/', (req, res) => {
    const query = `SELECT id AS productId, name AS productName, sale_price AS salePrice, quantity AS productQuantity, image AS productImage FROM productos ORDER BY id DESC`;
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error al obtener productos:', err);
            res.status(500).send('Error al obtener productos');
        } else {
            res.status(200).json(results);
        }
    });
});

router.post('/', upload.single('productImage'), (req, res) => {
    const { productId, productName, salePrice, productQuantity } = req.body;
    const imagePath = req.file ? req.file.filename : null;
    const sql = `INSERT INTO productos (id, name, sale_price, quantity, image) VALUES (?, ?, ?, ?, ?)`;
    db.query(sql, [productId, productName, salePrice, productQuantity, imagePath], (err) => {
        if (err) {
            console.error('Error al agregar producto:', err);
            res.status(500).send('Error al agregar producto');
        } else {
            res.send('Producto agregado correctamente');
        }
    });
});

module.exports = router;

