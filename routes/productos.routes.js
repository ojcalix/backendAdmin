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

// ================================
// RUTA PARA AGREGAR PRODUCTO
// ================================
// Ruta POST para registrar un producto nuevo, usando multer para recibir imágenes
router.post('/', upload.fields([
    { name: 'productImage', maxCount: 1 },      // Recibe un archivo con el nombre "productImage" (máximo 1)
    { name: 'toneImages', maxCount: 20 }        // Recibe archivos con el nombre "toneImages" (máximo 20 tonos)
]),
    async (req, res) => {
        try {
            // Extrae los valores enviados en el cuerpo de la solicitud
            const {
                productName,            // Nombre del producto
                productBrand,           // Marca del producto
                productCategory,        // ID de la categoría
                productSubCategory,     // ID de la subcategoría
                productDescription,     // Descripción del producto
                salePrice,              // Precio de venta
                productQuantity,        // Cantidad total (si no hay tonos)
                perfumeBarcode          // Código de barras (si es perfume)
            } = req.body;

            let imagePath = null; // Inicializa la variable para guardar la URL de la imagen del producto

            // === Cargar imagen principal del producto (si existe) ===
            const productImageFile = req.files?.productImage?.[0]; // Usa operador opcional para evitar error si no existe

            if (productImageFile) {
                // Redimensiona la imagen a 400x400 y la convierte a formato webp
                const resizedImageBuffer = await sharp(productImageFile.buffer)
                    .resize(400, 400)
                    .webp({ quality: 60 })   // Comprime la imagen al 60% de calidad
                    .toBuffer();             // Devuelve un buffer de la imagen

                // Genera un nombre único: "nombreproducto_timestamp"
                const publicId = `${productName.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}`;

                // Sube la imagen a Cloudinary usando stream
                const uploadResult = await new Promise((resolve, reject) => {
                    const stream = cloudinary.uploader.upload_stream({
                        folder: 'proyecto_copia/productos',  // Carpeta en Cloudinary
                        public_id: publicId,                 // Nombre del archivo en Cloudinary
                        resource_type: 'image',              // Tipo de recurso
                    }, (err, result) => err ? reject(err) : resolve(result)); // Callback con promesa

                    // Convierte el buffer en un stream y lo envía a Cloudinary
                    bufferToStream(resizedImageBuffer).pipe(stream);
                });

                imagePath = uploadResult.secure_url; // Guarda la URL segura de la imagen subida
            }

            // === Preparar tonos si existen ===
            const toneNames = Array.isArray(req.body.toneNames)
                ? req.body.toneNames               // Si ya es array, úsalo directamente
                : req.body.toneNames ? [req.body.toneNames] : []; // Si es string, conviértelo en array, si no existe, usa []

            // === Preparar datos de tonos si existen ===

            // toneQuantities: Cantidades por cada tono (ej. 3 unidades del tono "Rojo")
            // Este bloque garantiza que siempre sea un array, aunque solo se haya enviado un valor.
            // ¿Por qué? Porque si en el formulario solo se manda un valor, llega como string; si son varios, como array.
            const toneQuantities = Array.isArray(req.body.toneQuantities)  // ¿Ya viene como array?
                ? req.body.toneQuantities                                   // Sí: usar directamente.
                : req.body.toneQuantities                                   // No, pero ¿existe?
                    ? [req.body.toneQuantities]                             // Sí: envolverlo en un array con un solo elemento.
                    : [];                                                   // No existe: devolver un array vacío.

            // toneBarcodes: Códigos de barras para cada tono (opcional, puede no enviarse).
            // Mismo principio que con toneQuantities: aseguramos que sea un array sin importar si es uno o varios.
            const toneBarcodes = Array.isArray(req.body.toneBarcodes)      // ¿Ya es un array?
                ? req.body.toneBarcodes                                     // Sí: lo usamos tal como está.
                : req.body.toneBarcodes                                     // No, pero ¿existe al menos un valor?
                    ? [req.body.toneBarcodes]                               // Sí: lo convertimos en un array con un solo valor.
                    : [];                                                   // No: array vacío.


            const toneImages = req.files?.toneImages || []; // Lista de imágenes de tonos

            // === Determinar cantidad total del producto ===
            let quantity = 0;

            if (toneNames.length > 0) {
                // Si hay tonos, sumamos sus cantidades
                for (let i = 0; i < toneNames.length; i++) {
                    const toneQty = parseInt(toneQuantities[i]) || 0;
                    quantity += toneQty;
                }
            } else {
                // Si no hay tonos, usamos la cantidad general del producto
                quantity = parseInt(productQuantity) || 0;
            }

            // Si hay tonos, la cantidad total es 0 porque cada tono tiene su propia cantidad

            // === Insertar el producto en la base de datos ===
            const insertSql = `
            INSERT INTO productos 
            (name, brand, description, category_id, subcategory_id, sale_price, quantity, image) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;

            // Ejecuta la consulta SQL con los datos del producto
            const [insertResult] = await db.query(insertSql, [
                productName,            // nombre
                productBrand,           // marca
                productDescription,     // descripción
                productCategory,        // categoría ID
                productSubCategory,     // subcategoría ID
                salePrice,              // precio de venta
                quantity,               // cantidad general (0 si tiene tonos)
                imagePath               // URL de la imagen (puede ser null)
            ]);

            const productId = insertResult.insertId; // Obtiene el ID generado del producto

            // === Insertar código de barras si es perfume ===
            if (perfumeBarcode) {
                await db.query(
                    `INSERT INTO codigos_barras (barcode, product_id) VALUES (?, ?)`,
                    [perfumeBarcode, productId] // Inserta el código de barras y lo asocia al producto
                );
            }

            // === Recorrer cada tono para guardarlo ===
            for (let i = 0; i < toneNames.length; i++) {
                const toneName = toneNames[i];                       // Nombre del tono (ej. "Rojo Mate")
                const quantityTone = parseInt(toneQuantities[i]) || 0; // Cantidad del tono
                const toneBarcode = toneBarcodes[i];                 // Código de barras del tono (si tiene)
                const toneImageFile = toneImages[i];                 // Imagen del tono (archivo subido)

                // Si falta nombre o imagen, omitir este tono
                if (!toneName || !toneImageFile) continue;

                // Redimensiona imagen a 300x300 y convierte a webp
                const toneBuffer = await sharp(toneImageFile.buffer)
                    .resize(300, 300)
                    .webp({ quality: 60 })
                    .toBuffer();

                // Genera nombre único para la imagen del tono: "nombreproducto/tononombre_timestamp"
                const tonePublicId = `${productName.replace(/\s+/g, '_').toLowerCase()}/${toneName.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}`;

                // Sube la imagen del tono a Cloudinary
                const toneUpload = await new Promise((resolve, reject) => {
                    const stream = cloudinary.uploader.upload_stream({
                        folder: 'proyecto_copia/tonos',
                        public_id: tonePublicId,
                        resource_type: 'image',
                    }, (err, result) => err ? reject(err) : resolve(result));

                    bufferToStream(toneBuffer).pipe(stream); // Enviar imagen
                });

                // === Insertar tono en la base de datos ===
                const [toneResult] = await db.query(
                    `INSERT INTO tonos (product_id, tone_name, quantity, image) VALUES (?, ?, ?, ?)`,
                    [productId, toneName, quantityTone, toneUpload.secure_url]
                );

                const toneId = toneResult.insertId; // ID del nuevo tono

                // === Insertar código de barras del tono si existe ===
                if (toneBarcode) {
                    await db.query(
                        `INSERT INTO codigos_barras (barcode, product_id, tone_id) VALUES (?, ?, ?)`,
                        [toneBarcode, productId, toneId]
                    );
                }
            }

            // === Todo salió bien: enviar respuesta al cliente ===
            res.status(201).send('Producto y detalles registrados correctamente');

        } catch (err) {
            // Si ocurre un error, lo muestra en consola y responde con error
            console.error('Error al registrar producto:', err);
            res.status(500).send('Error al registrar el producto');
        }
    });
// ================================
// RUTA PARA CARGAR PRODUCTOS CON PAGINACIÓN
// ================================
// Ruta GET para obtener productos con paginación
router.get('/', async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page) || 1, 1); // Obtiene el número de página desde la URL o usa 1 como valor predeterminado
        const limit = Math.max(parseInt(req.query.limit) || 5, 1); // Obtiene el límite de productos por página o usa 5 como valor predeterminado
        const offset = (page - 1) * limit; // Calcula desde qué producto comenzar a traer datos

        const [totalResult] = await db.query('SELECT COUNT(*) AS total FROM productos'); // Consulta para contar el total de productos
        const total = totalResult[0].total; // Extrae el total de productos del resultado
        const totalPages = Math.ceil(total / limit); // Calcula cuántas páginas en total hay

        const [productResults] = await db.query(`
            SELECT 
                p.id AS productId,                                
                p.name AS productName,                            
                p.brand AS productBrand,                          
                p.description AS productDescription,              
                c.name AS productCategory,                  
                p.sale_price AS salePrice,                      
                COALESCE(SUM(t.quantity), p.quantity) AS productQuantity, -- Suma la cantidad de tonos si hay, si no usa la cantidad del producto
                p.image AS productImage,           
                p.registration_date AS createdAt       
            FROM productos p
            LEFT JOIN categorias c ON p.category_id = c.id       
            LEFT JOIN tonos t ON t.product_id = p.id              
            GROUP BY p.id                                        
            ORDER BY p.registration_date DESC                     
            LIMIT ? OFFSET ?                            
        `, [limit, offset]);

        res.status(200).json({                                     // Devuelve la respuesta en formato JSON con los productos y datos de paginación
            products: productResults,
            currentPage: page,
            totalPages,
            totalItems: total,
            limit
        });
    } catch (err) {
        console.error('Error al obtener productos:', err);         // Muestra en consola si ocurre un error
        res.status(500).json({ message: 'Error al obtener productos' }); // Devuelve un error 500 al cliente
    }
});
router.get('/todos', async (req, res) => {
    try {
        const query = `
            SELECT 
                p.id AS productId,
                GROUP_CONCAT(DISTINCT cb.barcode) AS barCodes, -- varios códigos separados por coma
                p.name AS productName,
                p.brand AS productBrand,
                p.description AS productDescription,
                c.name AS productCategory,
                p.sale_price AS salePrice,
                
                -- Sumar cantidad de tonos si existen, si no, usar la cantidad del producto
                COALESCE(
                    (SELECT SUM(t.quantity) FROM tonos t WHERE t.product_id = p.id),
                    p.quantity
                ) AS productQuantity,

                p.image AS productImage,
                p.registration_date AS createdAt
            FROM productos p
            LEFT JOIN categorias c ON p.category_id = c.id
            LEFT JOIN codigos_barras cb ON cb.product_id = p.id
            GROUP BY p.id
            ORDER BY p.id DESC
        `;

        const [results] = await db.query(query);
        res.status(200).json(results);
    } catch (err) {
        console.error('Error al obtener productos:', err);
        res.status(500).send('Error al obtener productos');
    }
});

router.get('/:id', async (req, res) => {
    try {
        const productId = req.params.id;

        // Obtener datos principales del producto
        const [productos] = await db.query(`
            SELECT 
                p.id AS productId,
                p.name AS productName,
                p.brand AS productBrand,
                p.description AS productDescription,
                p.category_id,
                p.subcategory_id,
                p.sale_price AS salePrice,
                p.quantity AS productQuantity,
                p.image AS productImage,
                s.name AS subcategoryName
            FROM productos p
            JOIN subcategorias s ON p.subcategory_id = s.id
            WHERE p.id = ?
        `, [productId]);

        if (productos.length === 0) {
            return res.status(404).send('Producto no encontrado');
        }

        const product = productos[0];

        // Si es un producto tipo perfume (Hombre/Mujer/Unisex), obtener código de barras único
        let barcode = null;
        const [barcodes] = await db.query(`
            SELECT barcode 
            FROM codigos_barras 
            WHERE product_id = ? AND tone_id IS NULL
            LIMIT 1
        `, [productId]);

        if (barcodes.length > 0) {
            barcode = barcodes[0].barcode;
        }

        // Si es un producto con tonos, obtener tonos
        let tones = [];
        if (['labiales', 'polvos', 'rimel', 'corrector', 'base'].includes(product.subcategoryName.toLowerCase())) {
            const [toneResults] = await db.query(`
                SELECT 
                    t.id, t.tone_name AS name, t.quantity,
                    cb.barcode, t.image, t.status
                FROM tonos t
                LEFT JOIN codigos_barras cb ON cb.tone_id = t.id
                WHERE t.product_id = ?
            `, [productId]);

            tones = toneResults;
        }

        res.status(200).json({
            ...product,
            barcode,
            tones
        });
    } catch (err) {
        console.error('Error al obtener el producto:', err);
        res.status(500).send('Error al obtener el producto');
    }
});

router.put('/:id', upload.any(), async (req, res) => {
    try {
        const productId = req.params.id;

        const {
            productName,
            productBrand,
            productCategory,
            productSubCategory,
            productDescription,
            salePrice,
            productQuantity,
            perfumeBarcode
        } = req.body;

        const tones = req.body.tones ? JSON.parse(req.body.tones) : [];

        const deleteToneIds = Array.isArray(req.body.deleteToneIds)
            ? req.body.deleteToneIds
            : req.body.deleteToneIds ? [req.body.deleteToneIds] : [];

        // === Imagen producto principal
        let imagePath = null;
        const [producto] = await db.query('SELECT image FROM productos WHERE id = ?', [productId]);
        if (producto.length > 0) imagePath = producto[0].image;

        const productImageFile = req.files.find(f => f.fieldname === 'productImage');
        if (productImageFile) {
            if (imagePath?.includes('res.cloudinary.com')) {
                const publicId = imagePath.split('/').pop().split('.')[0];
                await cloudinary.uploader.destroy(publicId).catch(() => { });
            }

            const resized = await sharp(productImageFile.buffer).resize(400, 400).webp({ quality: 60 }).toBuffer();
            const publicId = `${productName.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}`;
            const uploadResult = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream({
                    folder: 'proyecto_copia/productos',
                    public_id: publicId,
                    resource_type: 'image'
                }, (err, result) => err ? reject(err) : resolve(result));
                bufferToStream(resized).pipe(stream);
            });
            imagePath = uploadResult.secure_url;
        }

        // === Sumar cantidades de tonos si hay tonos
        let totalQuantity = 0;
        if (tones.length > 0) {
            for (let tone of tones) {
                const toneQuantity = parseInt(tone.quantity) || 0;
                totalQuantity += toneQuantity;
            }
        } else {
            totalQuantity = parseInt(productQuantity) || 0;
        }

        // === Actualizar producto con cantidad calculada
        await db.query(`
    UPDATE productos 
    SET name=?, brand=?, description=?, category_id=?, subcategory_id=?, sale_price=?, quantity=?, image=? 
    WHERE id=?
`, [productName, productBrand, productDescription, productCategory, productSubCategory, salePrice, totalQuantity, imagePath, productId]);


        // === Código de barras perfume
        await db.query('DELETE FROM codigos_barras WHERE product_id = ? AND tone_id IS NULL', [productId]);
        if (perfumeBarcode) {
            await db.query('INSERT INTO codigos_barras (barcode, product_id) VALUES (?, ?)', [perfumeBarcode, productId]);
        }

        // === Eliminar tonos
        if (deleteToneIds.length > 0) {
            await db.query('DELETE FROM tonos WHERE product_id=? AND id IN (?)', [productId, deleteToneIds]);
            await db.query('DELETE FROM codigos_barras WHERE product_id=? AND tone_id IN (?)', [productId, deleteToneIds]);
        }

        // === Procesar tonos
        for (let tone of tones) {
            const toneId = tone.id;
            const toneName = tone.name;
            const toneQuantity = parseInt(tone.quantity) || 0;
            const toneBarcode = tone.barcode;
            const toneStatus = tone.status || 'active';

            const imageField = `toneImage_${tone.imageIndex}`;
            const imageFile = req.files.find(f => f.fieldname === imageField);

            let toneImagePath = null;
            if (imageFile) {
                const toneBuffer = await sharp(imageFile.buffer).resize(300, 300).webp({ quality: 60 }).toBuffer();
                const tonePublicId = `${productName.replace(/\s+/g, '_').toLowerCase()}/${toneName.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}`;

                const upload = await new Promise((resolve, reject) => {
                    const stream = cloudinary.uploader.upload_stream({
                        folder: 'proyecto_copia/tonos',
                        public_id: tonePublicId,
                        resource_type: 'image'
                    }, (err, result) => err ? reject(err) : resolve(result));
                    bufferToStream(toneBuffer).pipe(stream);
                });

                toneImagePath = upload.secure_url;
            }

            if (toneId) {
                await db.query(`
                    UPDATE tonos 
                    SET tone_name=?, quantity=?, image=COALESCE(?, image), status=? 
                    WHERE id=? AND product_id=?
                `, [toneName, toneQuantity, toneImagePath, toneStatus, toneId, productId]);

                await db.query('DELETE FROM codigos_barras WHERE tone_id=?', [toneId]);
                if (toneBarcode) {
                    await db.query('INSERT INTO codigos_barras (barcode, product_id, tone_id) VALUES (?, ?, ?)', [toneBarcode, productId, toneId]);
                }
            } else {
                const [toneResult] = await db.query(`
                    INSERT INTO tonos (product_id, tone_name, quantity, image, status) 
                    VALUES (?, ?, ?, ?, ?)
                `, [productId, toneName, toneQuantity, toneImagePath, toneStatus]);

                const newToneId = toneResult.insertId;
                if (toneBarcode) {
                    await db.query('INSERT INTO codigos_barras (barcode, product_id, tone_id) VALUES (?, ?, ?)', [toneBarcode, productId, newToneId]);
                }
            }
        }

        res.status(200).send('Producto actualizado correctamente');

    } catch (err) {
        console.error('Error al actualizar producto:', err);
        res.status(500).send('Error al actualizar el producto');
    }
});

// ==============================
// Eliminar un producto
// ==============================
router.delete('/:id', async (req, res) => {
    try {
        const productId = req.params.id;
        const query = 'DELETE FROM productos WHERE id = ?';

        await db.query(query, [productId]);
        res.status(200).json({ success: true, message: 'Producto eliminado correctamente' });
    } catch (err) {
        console.error('Error al eliminar el producto:', err);
        res.status(500).send('Error al eliminar el producto');
    }
});

// ==============================
// Agregar un producto
// ==============================
router.post('/', upload.single('productImage'), async (req, res) => {
    try {
        const { productId, productName, salePrice, productQuantity } = req.body;
        const imagePath = req.file ? req.file.filename : null;

        const sql = `INSERT INTO productos (id, name, sale_price, quantity, image) VALUES (?, ?, ?, ?, ?)`;
        await db.query(sql, [productId, productName, salePrice, productQuantity, imagePath]);

        res.send('Producto agregado correctamente');
    } catch (err) {
        console.error('Error al agregar producto:', err);
        res.status(500).send('Error al agregar producto');
    }
});

// ==============================
// Buscar producto por id, código o nombre
// ==============================
// Buscar productos por término (nombre, código de barra o tono)
router.get('/buscar/:termino', async (req, res) => {
    const { termino } = req.params;

    try {
        let query, params;

        // Si el término es numérico, buscamos por ID o código de barra
        if (/^\d+$/.test(termino)) {
            query = `
                SELECT 
                    p.id AS productId,
                    p.name AS productName,
                    p.brand AS productBrand,
                    p.description AS productDescription,
                    p.sale_price AS salePrice,
                    p.registration_date AS createdAt,
                    c.name AS productCategory,
                    p.image AS productImage,
                    -- Cantidad total: si hay tonos, suma cantidades de tonos; si no, usa p.quantity
                    COALESCE(SUM(t.cantidad), p.quantity) AS productQuantity
                FROM productos p
                LEFT JOIN categorias c ON p.category_id = c.id
                LEFT JOIN tonos t ON p.id = t.producto_id
                LEFT JOIN codigos_barras cb ON cb.producto_id = p.id
                WHERE p.id = ? OR cb.barcode = ?
                GROUP BY p.id
                ORDER BY p.name
            `;
            params = [termino, termino];

        } else {
            // Si es texto, buscamos por nombre del producto (NO por tono aquí)
            query = `
                SELECT 
                    p.id AS productId,
                    p.name AS productName,
                    p.brand AS productBrand,
                    p.description AS productDescription,
                    p.sale_price AS salePrice,
                    p.registration_date AS createdAt,
                    c.name AS productCategory,
                    p.image AS productImage,
                    -- Cantidad calculada igual que en el caso anterior
                    COALESCE(SUM(t.quantity), p.quantity) AS productQuantity
                FROM productos p
                LEFT JOIN categorias c ON p.category_id = c.id
                LEFT JOIN tonos t ON p.id = t.product_id
                WHERE p.name LIKE ?
                GROUP BY p.id
                ORDER BY p.name
            `;
            params = [`%${termino}%`];
        }

        const [result] = await db.query(query, params);
        res.json(result);

    } catch (error) {
        console.error('Error en la búsqueda:', error);
        res.status(500).json({ message: 'Error en la búsqueda', error });
    }
});


// ==============================
// Buscar productos por nombre de tono
// ==============================
router.get('/tonos/:nombreTono', async (req, res) => {
    const { nombreTono } = req.params;

    try {
        const [result] = await db.query(`
    SELECT 
        p.id AS productId,
        p.name AS productName,
        p.brand AS productBrand,
        p.description AS productDescription,
        c.name AS productCategory,
        p.sale_price AS salePrice,
        t.quantity AS productQuantity,
        t.image AS productImage,
        t.tone_name,
        t.id AS tone_id,
        p.registration_date AS createdAt
    FROM tonos t
    INNER JOIN productos p ON t.product_id = p.id
    LEFT JOIN categorias c ON p.category_id = c.id
    WHERE t.tone_name LIKE ?
`, [`%${nombreTono}%`]);

        res.json(result);

    } catch (error) {
        console.error('Error al buscar por tono:', error);
        res.status(500).json({ message: 'Error interno al buscar por tono' });
    }
});



module.exports = router;

