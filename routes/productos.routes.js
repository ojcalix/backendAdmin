const express = require('express');
const router = express.Router();
const path = require('path');
const sharp = require('sharp');
const multer = require('multer');
const db = require('../config/db'); // Ajusta esta ruta según tu estructura

// Configuración de multer (almacenamiento en memoria)
const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post('/', upload.single('productImage'), async (req, res) => {
    try {
        const {
            productId, productName, productBrand, productCategory,
            productSubCategory, productDescription, productSupplier,
            purchasePrice, salePrice, productQuantity
        } = req.body;

        let imagePath = null;

        if (req.file) {
            // Nombre único para la imagen
            const uniqueName = `product_${Date.now()}.jpg`;
            const outputPath = path.join(__dirname, '..', 'uploads', uniqueName);

            // Guardar la imagen en la carpeta 'uploads'
            await sharp(req.file.buffer)
                .resize(500, 500, { fit: 'inside' })
                .toFormat('jpeg', { quality: 80 })
                .toFile(outputPath);

            // Generar URL dinámica usando el host y protocolo actuales
            const serverUrl = `${req.protocol}://${req.get('host')}`;
            imagePath = `${serverUrl}/uploads/${uniqueName}`;
        }

        // SQL para insertar el producto en la base de datos
        const sql = `
        INSERT INTO productos 
        (id, name, brand, description, supplier_id, category_id, subcategory_id, purchase_price, sale_price, quantity, image) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.query(sql, [
            productId, productName, productBrand, productDescription, productSupplier,
            productCategory, productSubCategory, purchasePrice, salePrice, productQuantity, imagePath
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
        productos.name AS productName,      
        productos.brand AS productBrand,    
        productos.description AS productDescription, 
        categorias.name AS productCategory, 
        proveedores.name AS productSupplier, 
        productos.purchase_price AS purchasePrice, 
        productos.sale_price AS salePrice,  
        productos.quantity AS productQuantity, 
        productos.image AS productImage,  
        productos.registration_date AS createdAt 
    FROM productos
    LEFT JOIN categorias ON productos.category_id = categorias.id
    LEFT JOIN proveedores ON productos.supplier_id = proveedores.id
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
            id AS productId, name AS productName, brand AS productBrand, 
            description AS productDescription, supplier_id, category_id, 
            purchase_price AS purchasePrice, sale_price AS salePrice, 
            quantity AS productQuantity, 
            CONCAT(?, '/uploads/', image) AS productImage -- Agregar URL completa
        FROM productos 
        WHERE id = ?
    `;

    db.query(query, [serverUrl, productId], (err, results) => {
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
        name,
        brand,
        description,
        supplier_id,
        category_id,
        purchase_price,
        sale_price,
        quantity
    } = req.body;

    const serverUrl = `${req.protocol}://${req.get('host')}`;

    // Consultar la imagen actual antes de actualizar
    const selectImageSql = 'SELECT image FROM productos WHERE id = ?';
    db.query(selectImageSql, [productId], async (err, result) => {
        if (err) {
            console.error('Error al obtener la imagen actual:', err);
            return res.status(500).json({ error: 'Error en la base de datos' });
        }

        let imagePath = (result.length > 0) ? result[0].image : null;

        // Si se sube una nueva imagen, reemplazar la existente
        if (req.file) {
            const uniqueName = `product_${Date.now()}.jpg`;
            const outputPath = path.join(__dirname, '..', 'uploads', uniqueName);

            await sharp(req.file.buffer)
                .resize(500, 500, { fit: 'inside' })
                .toFormat('jpeg', { quality: 80 })
                .toFile(outputPath);

            imagePath = uniqueName; // Solo guardamos el nombre del archivo
        }

        // Construir la URL completa de la imagen
        const imageUrl = imagePath ? `${serverUrl}/uploads/${imagePath}` : null;

        // Ahora sí, actualizar el producto
        const updateSql = `
            UPDATE productos SET 
            id = ?, name = ?, brand = ?, description = ?, 
            supplier_id = ?, category_id = ?, purchase_price = ?, 
            sale_price = ?, quantity = ?, image = ?
            WHERE id = ?
        `;

        db.query(updateSql, [
            id || productId,
            name, brand, description, supplier_id, category_id,
            purchase_price, sale_price, quantity, imageUrl,
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

