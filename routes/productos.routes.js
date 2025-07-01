const express = require('express');
const router = express.Router();
const path = require('path');
const sharp = require('sharp');
const multer = require('multer');
const fs = require('fs');
const { Readable } = require('stream');
const cloudinary = require('../config/cloudinary');
const streamifier = require('streamifier');
const db = require('../config/db'); // Ajusta esta ruta según tu estructura

// Configuración de multer (almacenamiento en memoria)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Convierte un buffer a un stream legible
function bufferToStream(buffer) {
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    return stream;
}

router.post('/', upload.fields([
    { name: 'productImage', maxCount: 1 },
    { name: 'toneImages', maxCount: 20 }
]), async (req, res) => {
    try {
        const {
            barcode, productName, productBrand, productCategory,
            productSubCategory, productDescription, salePrice, productQuantity
        } = req.body;

        let imagePath = null;

        // Guardar imagen principal
        const productImageFile = req.files?.productImage?.[0];

        if (productImageFile) {
            const resizedImageBuffer = await sharp(productImageFile.buffer)
                .resize(400, 400, { fit: 'inside' })
                .webp({ quality: 60 })
                .toBuffer();

            const publicId = `${productName.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}`;

            const uploadResult = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    {
                        folder: 'productos',
                        public_id: publicId,
                        resource_type: 'image',
                    },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                bufferToStream(resizedImageBuffer).pipe(stream);
            });

            imagePath = uploadResult.secure_url;
        }

        // Insertar producto
        const insertSql = `
            INSERT INTO productos 
            (barcode, name, brand, description, category_id, subcategory_id, sale_price, quantity, image) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.query(insertSql, [
            barcode, productName, productBrand, productDescription,
            productCategory, productSubCategory, salePrice, productQuantity, imagePath
        ], async (err, result) => {
            if (err) {
                console.error('Error al insertar producto:', err);
                return res.status(500).send('Error al agregar el producto');
            }

            const productId = result.insertId;

            // Procesar tonos si existen
            const toneNames = Array.isArray(req.body.toneNames)
                ? req.body.toneNames
                : req.body.toneNames ? [req.body.toneNames] : [];

            const toneImages = req.files?.toneImages || [];

            if (toneNames.length && toneImages.length) {
                for (let i = 0; i < toneNames.length; i++) {
                    const toneName = toneNames[i];
                    const imageFile = toneImages[i];

                    if (!toneName || !imageFile) continue;

                    const toneBuffer = await sharp(imageFile.buffer)
                        .resize(300, 300)
                        .webp({ quality: 60 })
                        .toBuffer();

                    const tonePublicId = `${productName.replace(/\s+/g, '_').toLowerCase()}/${toneName.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}`;

                    const uploadToneResult = await new Promise((resolve, reject) => {
                        const stream = cloudinary.uploader.upload_stream(
                            {
                                folder: 'tonos',
                                public_id: tonePublicId,
                                resource_type: 'image',
                            },
                            (error, result) => {
                                if (error) reject(error);
                                else resolve(result);
                            }
                        );
                        bufferToStream(toneBuffer).pipe(stream);
                    });

                    const insertToneSql = `
                        INSERT INTO tonos (product_id, tone_name, image)
                        VALUES (?, ?, ?)
                    `;
                    db.query(insertToneSql, [productId, toneName, uploadToneResult.secure_url], (toneErr) => {
                        if (toneErr) {
                            console.error(`Error al insertar tono "${toneName}":`, toneErr);
                        }
                    });
                }
            }

            res.send('Producto y tonos agregados correctamente');
        });

    } catch (error) {
        console.error('Error procesando el producto o los tonos:', error);
        res.status(500).send('Error interno al procesar el producto');
    }
});



// Ruta para cargar todos los productos desde la base de datos
router.get('/', (req, res) => {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit) || 5, 1);
    const offset = (page - 1) * limit;

    // 1️⃣ Total de productos
    const totalQuery = 'SELECT COUNT(*) AS total FROM productos';
    db.query(totalQuery, (err, totalResult) => {
        if (err) {
            console.error('Error al contar productos:', err);
            return res.status(500).json({ message: 'Error al contar productos' });
        }

        const total = totalResult[0].total;
        const totalPages = Math.ceil(total / limit);

        // 2️⃣ Productos paginados
        const productQuery = `
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
            ORDER BY productos.registration_date DESC
            LIMIT ? OFFSET ?
        `;

        db.query(productQuery, [limit, offset], (err, productResults) => {
            if (err) {
                console.error('Error al obtener productos paginados:', err);
                return res.status(500).json({ message: 'Error al obtener productos' });
            }

            res.status(200).json({
                products: productResults,
                currentPage: page,
                totalPages,
                totalItems: total,
                limit
            });
        });
    });
});
//Cargar la imagen del producto a la tabla de compras, para la visualizacion del producto que se esta comprando
router.get('/todos', (req, res) => {
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
        ORDER BY productos.id DESC
    `;

    db.query(query, (err, results) => {
        if (err) {
            console.error('Error al obtener productos:', err);
            res.status(500).send('Error al obtener productos');
        } else {
            res.status(200).json(results);
        }
    });
});

//Ruta para obtener los productos
router.get('/:id', (req, res) => {
    const productId = req.params.id;

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

    const selectImageSql = 'SELECT image FROM productos WHERE id = ?';
    db.query(selectImageSql, [productId], async (err, result) => {
        if (err) {
            console.error('Error al obtener la imagen actual:', err);
            return res.status(500).json({ error: 'Error en la base de datos' });
        }

        let imagePath = (result.length > 0) ? result[0].image : null;

        // Si se sube una nueva imagen
        if (req.file) {
            // Eliminar imagen anterior de Cloudinary si existe
            if (imagePath && imagePath.includes('res.cloudinary.com')) {
                const publicId = imagePath.split('/').pop().split('.')[0];
                try {
                    await cloudinary.uploader.destroy(publicId);
                    console.log('Imagen anterior eliminada de Cloudinary:', publicId);
                } catch (destroyErr) {
                    console.warn('No se pudo eliminar la imagen anterior en Cloudinary:', destroyErr.message);
                }
            }

            // Subir nueva imagen a Cloudinary
            const streamUpload = (reqFileBuffer) => {
                return new Promise((resolve, reject) => {
                    const stream = cloudinary.uploader.upload_stream(
                        {
                            folder: 'productos',
                            format: 'webp',
                            transformation: [{ width: 400, height: 400, crop: 'limit' }],
                        },
                        (error, result) => {
                            if (result) {
                                resolve(result.secure_url);
                            } else {
                                reject(error);
                            }
                        }
                    );
                    streamifier.createReadStream(reqFileBuffer).pipe(stream);
                });
            };

            try {
                imagePath = await streamUpload(req.file.buffer);
            } catch (uploadErr) {
                console.error('Error al subir imagen a Cloudinary:', uploadErr);
                return res.status(500).json({ error: 'Error subiendo la imagen' });
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

// routes/productos.js
// 🔍 Búsqueda por id, barcode o nombre
router.get('/buscar/:term', (req, res) => {
    const { term } = req.params;

    const sql = `
    SELECT 
        p.id AS productId,
        p.barcode AS barCode,
        p.name AS productName,
        p.brand AS productBrand,
        p.description AS productDescription,
        p.sale_price AS salePrice,
        p.quantity AS productQuantity,
        p.image AS productImage,
        p.registration_date AS createdAt,
        c.name AS productCategory
    FROM productos p
    LEFT JOIN categorias c ON p.category_id = c.id
    WHERE p.id = ? 
       OR p.barcode = ? 
       OR p.name LIKE ?
    ORDER BY p.name
    LIMIT 100
  `;

    db.query(sql, [term, term, `%${term}%`], (err, rows) => {
        if (err) {
            console.error('Error en la búsqueda:', err);
            return res.status(500).send('Error en la búsqueda');
        }
        res.status(200).json(rows);
    });
});

module.exports = router;

