const express = require('express');
const router = express.Router();
const sharp = require('sharp');
const multer = require('multer');
const { Readable } = require('stream');
const cloudinary = require('../config/cloudinary');
const db = require('../config/db');

const storage = multer.memoryStorage();
const upload = multer({ storage });

function bufferToStream(buffer) {
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    return stream;
}

// ========================
// Slug seguro para Cloudinary: quita acentos/diacríticos y cualquier
// carácter que no sea letra, número, guión o guión bajo. Antes solo se
// reemplazaban espacios, así que un nombre con tilde o símbolo (ej.
// "Édition", "50 ml!") producía un public_id inválido y Cloudinary
// rechazaba el upload.
// ========================
function slugify(text) {
    const base = (text || 'item')
        .toString()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos: á->a, ñ->n, etc.
        .replace(/[^a-zA-Z0-9\s_-]/g, '')                  // quita cualquier símbolo no permitido
        .trim()
        .replace(/\s+/g, '_')
        .toLowerCase();

    return base || 'item'; // por si el nombre queda vacío tras sanear (ej. era solo emojis)
}

async function uploadToCloudinary(buffer, folder, publicId, size = 400, quality = 60) {
    const resized = await sharp(buffer).resize(size, size).webp({ quality }).toBuffer();
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder, public_id: publicId, resource_type: 'image' },
            (err, result) => err ? reject(err) : resolve(result)
        );
        bufferToStream(resized).pipe(stream);
    });
}

// ========================
// Borra de Cloudinary las imágenes ya subidas cuando algo falla después
// (best-effort: si la limpieza misma falla, solo se registra en consola,
// nunca se lanza el error hacia el cliente).
// ========================
async function cleanupUploads(publicIds) {
    for (const publicId of publicIds) {
        try {
            await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
        } catch (cleanupError) {
            console.error(`⚠️ No se pudo limpiar la imagen huérfana ${publicId}:`, cleanupError.message);
        }
    }
}

function arrify(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

// ========================
// Helper: dado un array de productos base (con productId), agrega
// sus variantes activas. Cada variante trae su propia imagen si existe,
// o hereda la imagen "principal" del producto como respaldo (fallback).
// También calcula minPrice/maxPrice/variantCount/productQuantity
// a partir de esas variantes, y expone productImage (imagen principal
// del producto, puede ser null si el producto no tiene imagen propia).
// ========================
async function attachVariantsToProducts(products) {
    if (!products.length) return products;

    const productIds = products.map(p => p.productId);

    const [productMainImages] = await db.query(
        `SELECT product_id, image FROM productos_imagenes WHERE product_id IN (?) AND type = 'principal'`,
        [productIds]
    );
    const productMainImageMap = {};
    productMainImages.forEach(img => { productMainImageMap[img.product_id] = img.image; });

    const [variants] = await db.query(`
        SELECT id, product_id, variant_name, sale_price, quantity, barcode, status
        FROM variantes
        WHERE product_id IN (?) AND status = 'active'
        ORDER BY variant_name ASC
    `, [productIds]);

    let variantImageMap = {};
    if (variants.length) {
        const variantIds = variants.map(v => v.id);
        const [variantImages] = await db.query(
            `SELECT variant_id, image FROM variantes_imagenes WHERE variant_id IN (?) AND type = 'principal'`,
            [variantIds]
        );
        variantImages.forEach(img => { variantImageMap[img.variant_id] = img.image; });
    }

    return products.map(p => {
        const productVariants = variants
            .filter(v => v.product_id === p.productId)
            .map(v => ({
                ...v,
                image: variantImageMap[v.id] || productMainImageMap[p.productId] || null
            }));

        const prices = productVariants.map(v => parseFloat(v.sale_price));
        const totalQuantity = productVariants.reduce((sum, v) => sum + (v.quantity || 0), 0);

        return {
            ...p,
            productImage: productMainImageMap[p.productId] || null,
            minPrice: prices.length ? Math.min(...prices) : 0,
            maxPrice: prices.length ? Math.max(...prices) : 0,
            variantCount: productVariants.length,
            productQuantity: totalQuantity,
            variants: productVariants
        };
    });
}

// ========================
// GET /productos?page=&limit=
// ========================
router.get('/', async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.max(parseInt(req.query.limit) || 5, 1);
        const offset = (page - 1) * limit;

        const [totalResult] = await db.query('SELECT COUNT(*) AS total FROM productos');
        const total = totalResult[0].total;
        const totalPages = Math.ceil(total / limit);

        const [products] = await db.query(`
            SELECT
                p.id AS productId,
                p.name AS productName,
                p.brand AS productBrand,
                p.description AS productDescription,
                c.name AS productCategory,
                p.registration_date AS createdAt
            FROM productos p
            LEFT JOIN categorias c ON c.id = p.category_id
            ORDER BY p.registration_date DESC
            LIMIT ? OFFSET ?
        `, [limit, offset]);

        const productsWithVariants = await attachVariantsToProducts(products);

        res.status(200).json({ products: productsWithVariants, currentPage: page, totalPages, totalItems: total, limit });

    } catch (err) {
        console.error('Error al obtener productos:', err);
        res.status(500).json({ message: 'Error al obtener productos' });
    }
});

// ========================
// GET /productos/todos
// ========================
router.get('/todos', async (req, res) => {
    try {
        const [results] = await db.query(`
            SELECT
                p.id AS productId,
                p.name AS productName,
                p.brand AS productBrand,
                p.description AS productDescription,
                c.name AS productCategory,
                MIN(v.sale_price) AS minPrice,
                MAX(v.sale_price) AS maxPrice,
                COALESCE(SUM(v.quantity), 0) AS productQuantity,
                COUNT(v.id) AS variantCount,
                (SELECT image FROM productos_imagenes WHERE product_id = p.id AND type = 'principal' LIMIT 1) AS productImage,
                p.registration_date AS createdAt
            FROM productos p
            LEFT JOIN categorias c ON c.id = p.category_id
            LEFT JOIN variantes v ON v.product_id = p.id AND v.status = 'active'
            GROUP BY p.id
            ORDER BY p.name ASC
        `);
        res.status(200).json(results);
    } catch (err) {
        console.error("Error al obtener productos:", err);
        res.status(500).send("Error al obtener productos");
    }
});

// ========================
// GET /productos/buscar/:termino
// ========================
router.get('/buscar/:termino', async (req, res) => {
    const { termino } = req.params;

    try {
        const [products] = await db.query(`
            SELECT DISTINCT
                p.id AS productId,
                p.name AS productName,
                p.brand AS productBrand,
                p.description AS productDescription,
                c.name AS productCategory,
                p.registration_date AS createdAt
            FROM productos p
            LEFT JOIN categorias c ON c.id = p.category_id
            WHERE p.name LIKE ? OR p.id = ? OR EXISTS (
                SELECT 1 FROM variantes v3 WHERE v3.product_id = p.id AND v3.barcode = ?
            )
            ORDER BY p.name ASC
        `, [`%${termino}%`, termino, termino]);

        const productsWithVariants = await attachVariantsToProducts(products);
        res.json(productsWithVariants);

    } catch (error) {
        console.error('Error en la búsqueda:', error);
        res.status(500).json({ message: 'Error en la búsqueda', error });
    }
});

// ========================
// GET /productos/proveedor/:supplierId
// ========================
router.get('/proveedor/:supplierId', async (req, res) => {
    try {
        const { supplierId } = req.params;

        const [products] = await db.query(`
            SELECT DISTINCT
                p.id AS productId,
                p.name AS productName,
                p.brand AS productBrand,
                p.description AS productDescription,
                c.name AS productCategory,
                (SELECT image FROM productos_imagenes WHERE product_id = p.id AND type = 'principal' LIMIT 1) AS productImage,
                COALESCE((SELECT SUM(quantity) FROM variantes WHERE product_id = p.id AND status = 'active'), 0) AS productQuantity
            FROM producto_proveedor pp
            INNER JOIN productos p ON p.id = pp.product_id
            LEFT JOIN categorias c ON c.id = p.category_id
            WHERE pp.supplier_id = ?
            ORDER BY p.name ASC
        `, [supplierId]);

        res.json(products);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al obtener los productos del proveedor.' });
    }
});

// ========================
// GET /productos/:id/variantes
// ========================
router.get('/:id/variantes', async (req, res) => {
    try {
        const { id } = req.params;

        const [productImgRows] = await db.query(
            `SELECT image FROM productos_imagenes WHERE product_id = ? AND type = 'principal' LIMIT 1`,
            [id]
        );
        const productMainImage = productImgRows[0]?.image || null;

        const [variants] = await db.query(`
            SELECT v.id, v.product_id, v.variant_name, v.sale_price, v.quantity, v.barcode, v.status,
                   p.name AS productName, c.name AS productCategory
            FROM variantes v
            INNER JOIN productos p ON p.id = v.product_id
            LEFT JOIN categorias c ON c.id = p.category_id
            WHERE v.product_id = ? AND v.status = 'active'
            ORDER BY v.variant_name ASC
        `, [id]);

        if (!variants.length) return res.json([]);

        const variantIds = variants.map(v => v.id);
        const [images] = await db.query(
            `SELECT variant_id, image, type FROM variantes_imagenes WHERE variant_id IN (?)`,
            [variantIds]
        );

        const result = variants.map(v => {
            const ownImage = images.find(img => img.variant_id === v.id && img.type === 'principal')?.image;
            return { ...v, image: ownImage || productMainImage };
        });

        res.json(result);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error al obtener las variantes." });
    }
});

// ========================
// GET /productos/:id
// ========================
router.get('/:id', async (req, res) => {
    try {
        const productId = req.params.id;

        const [products] = await db.query(`
            SELECT p.id AS productId, p.name AS productName, p.brand AS productBrand,
                   p.description AS productDescription, p.category_id, p.gender_id, p.status
            FROM productos p WHERE p.id = ?
        `, [productId]);

        if (products.length === 0) return res.status(404).send("Producto no encontrado");

        const product = products[0];

        const [productImgs] = await db.query(
            `SELECT id, image, type FROM productos_imagenes WHERE product_id = ?`,
            [productId]
        );

        const productImages = {
            principal: productImgs.find(i => i.type === 'principal') || null,
            hover: productImgs.find(i => i.type === 'hover') || null,
            extra: productImgs.filter(i => i.type === 'extra')
        };

        const [variants] = await db.query(
            `SELECT id, variant_name, sale_price, quantity, barcode, status 
             FROM variantes WHERE product_id = ? ORDER BY id ASC`,
            [productId]
        );

        let variantsWithImages = [];

        if (variants.length) {
            const variantIds = variants.map(v => v.id);
            const [images] = await db.query(
                `SELECT variant_id, id, image, type FROM variantes_imagenes WHERE variant_id IN (?)`,
                [variantIds]
            );

            variantsWithImages = variants.map(v => ({
                ...v,
                principalImage: images.find(i => i.variant_id === v.id && i.type === 'principal') || null,
                hoverImage: images.find(i => i.variant_id === v.id && i.type === 'hover') || null,
                extraImages: images.filter(i => i.variant_id === v.id && i.type === 'extra')
            }));
        }

        res.json({ ...product, productImages, variants: variantsWithImages });

    } catch (err) {
        console.error(err);
        res.status(500).send("Error al obtener el producto");
    }
});

// ========================
// POST /productos
// FLUJO CORREGIDO (evita quemar IDs de MySQL con fallos de Cloudinary):
//
//   1. Validar datos (nombre, categoría, al menos 1 variante) → si falla,
//      responde de una vez, sin tocar MySQL ni Cloudinary.
//   2. Subir TODAS las imágenes a Cloudinary primero, con un slug seguro.
//      Si cualquier subida falla, se limpian las que sí se subieron y se
//      responde el error — MySQL nunca se toca, ningún AUTO_INCREMENT
//      se pierde.
//   3. Solo si el paso 2 fue 100% exitoso, se abre la transacción y se
//      insertan producto, imágenes (ya con su URL) y variantes.
//   4. Si algo falla en este paso (raro), se hace ROLLBACK en MySQL y se
//      intenta borrar las imágenes ya subidas a Cloudinary, para no
//      dejar archivos huérfanos.
// ========================
router.post('/', upload.any(), async (req, res) => {
    const { productName, productBrand, category_id, gender_id, productDescription } = req.body;
    const variants = req.body.variants ? JSON.parse(req.body.variants) : [];

    // --- Paso 1: validar antes de tocar cualquier servicio externo ---
    if (!productName || !category_id) {
        return res.status(400).json({ message: "Nombre y categoría son obligatorios." });
    }

    if (!variants.length) {
        return res.status(400).json({ message: "Debe agregar al menos una variante." });
    }

    for (const v of variants) {
        if (!v.variant_name || v.sale_price === undefined || v.sale_price === null || v.sale_price === '') {
            return res.status(400).json({ message: "Cada variante necesita nombre y precio de venta." });
        }
    }

    const productSlug = slugify(productName);
    const uploadedPublicIds = []; // para limpieza si algo falla después

    let productMainUpload = null;
    let productHoverUpload = null;
    const productExtraUploads = [];
    const variantUploads = {}; // { [index]: { main, hover, extras: [] } }

    // --- Paso 2: subir TODAS las imágenes antes de tocar MySQL ---
    try {
        const mainFile = req.files.find(f => f.fieldname === 'mainImage');
        if (mainFile) {
            productMainUpload = await uploadToCloudinary(mainFile.buffer, 'vansue/productos', `${productSlug}_main_${Date.now()}`, 400, 60);
            uploadedPublicIds.push(productMainUpload.public_id);
        }

        const hoverFile = req.files.find(f => f.fieldname === 'hoverImage');
        if (hoverFile) {
            productHoverUpload = await uploadToCloudinary(hoverFile.buffer, 'vansue/productos_hover', `${productSlug}_hover_${Date.now()}`, 400, 60);
            uploadedPublicIds.push(productHoverUpload.public_id);
        }

        const productExtraFiles = req.files.filter(f => f.fieldname === 'extraImages');
        for (let i = 0; i < productExtraFiles.length; i++) {
            const up = await uploadToCloudinary(productExtraFiles[i].buffer, 'vansue/productos_extra', `${productSlug}_extra_${Date.now()}_${i}`, 600, 70);
            uploadedPublicIds.push(up.public_id);
            productExtraUploads.push(up);
        }

        for (const variant of variants) {
            const variantSlug = `${productSlug}_${slugify(variant.variant_name)}`;
            variantUploads[variant.index] = { main: null, hover: null, extras: [] };

            const vMain = req.files.find(f => f.fieldname === `variantMain_${variant.index}`);
            if (vMain) {
                const up = await uploadToCloudinary(vMain.buffer, 'vansue/variantes', `${variantSlug}_main_${Date.now()}`, 400, 60);
                uploadedPublicIds.push(up.public_id);
                variantUploads[variant.index].main = up;
            }

            const vHover = req.files.find(f => f.fieldname === `variantHover_${variant.index}`);
            if (vHover) {
                const up = await uploadToCloudinary(vHover.buffer, 'vansue/variantes_hover', `${variantSlug}_hover_${Date.now()}`, 400, 60);
                uploadedPublicIds.push(up.public_id);
                variantUploads[variant.index].hover = up;
            }

            const vExtras = req.files.filter(f => f.fieldname === `variantExtra_${variant.index}`);
            for (let i = 0; i < vExtras.length; i++) {
                const up = await uploadToCloudinary(vExtras[i].buffer, 'vansue/variantes_extra', `${variantSlug}_extra_${Date.now()}_${i}`, 600, 70);
                uploadedPublicIds.push(up.public_id);
                variantUploads[variant.index].extras.push(up);
            }
        }

    } catch (uploadError) {
        console.error('❌ Error al subir imágenes a Cloudinary:', uploadError);
        await cleanupUploads(uploadedPublicIds);
        return res.status(500).json({ message: `Error al subir imágenes: ${uploadError.message}` });
    }

    // --- Paso 3: todas las imágenes están arriba; ahora sí, MySQL ---
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [insertResult] = await connection.query(
            `INSERT INTO productos (name, brand, description, category_id, gender_id) VALUES (?, ?, ?, ?, ?)`,
            [productName, productBrand, productDescription, category_id, gender_id || null]
        );

        const productId = insertResult.insertId;

        if (productMainUpload) {
            await connection.query(
                `INSERT INTO productos_imagenes (product_id, image, type) VALUES (?, ?, 'principal')`,
                [productId, productMainUpload.secure_url]
            );
        }

        if (productHoverUpload) {
            await connection.query(
                `INSERT INTO productos_imagenes (product_id, image, type) VALUES (?, ?, 'hover')`,
                [productId, productHoverUpload.secure_url]
            );
        }

        for (const up of productExtraUploads) {
            await connection.query(
                `INSERT INTO productos_imagenes (product_id, image, type) VALUES (?, ?, 'extra')`,
                [productId, up.secure_url]
            );
        }

        for (const variant of variants) {
            const [variantResult] = await connection.query(
                `INSERT INTO variantes (product_id, variant_name, sale_price, quantity, barcode) 
                 VALUES (?, ?, ?, ?, ?)`,
                [productId, variant.variant_name, variant.sale_price, variant.quantity || 0, variant.barcode || null]
            );

            const variantId = variantResult.insertId;
            const uploads = variantUploads[variant.index];

            if (uploads.main) {
                await connection.query(
                    `INSERT INTO variantes_imagenes (variant_id, image, type) VALUES (?, ?, 'principal')`,
                    [variantId, uploads.main.secure_url]
                );
            }

            if (uploads.hover) {
                await connection.query(
                    `INSERT INTO variantes_imagenes (variant_id, image, type) VALUES (?, ?, 'hover')`,
                    [variantId, uploads.hover.secure_url]
                );
            }

            for (const up of uploads.extras) {
                await connection.query(
                    `INSERT INTO variantes_imagenes (variant_id, image, type) VALUES (?, ?, 'extra')`,
                    [variantId, up.secure_url]
                );
            }
        }

        await connection.commit();
        res.status(201).json({ message: 'Producto y variantes registrados correctamente', productId });

    } catch (dbError) {
        await connection.rollback();
        console.error('❌ Error al registrar producto en la base de datos:', dbError);
        // Las imágenes ya están en Cloudinary pero el producto no se guardó: limpiamos para no dejar huérfanos.
        await cleanupUploads(uploadedPublicIds);
        res.status(500).json({ message: 'Error al registrar el producto' });
    } finally {
        connection.release();
    }
});

// ========================
// PUT /productos/:id
// Mismo principio: subir imágenes nuevas primero, y solo si todo sale
// bien, aplicar los cambios en MySQL. Así una variante nueva agregada
// durante una edición tampoco quema su ID si Cloudinary falla.
// ========================
router.put('/:id', upload.any(), async (req, res) => {
    const productId = req.params.id;
    const { productName, productBrand, category_id, gender_id, productDescription } = req.body;
    const variants = req.body.variants ? JSON.parse(req.body.variants) : [];

    const deleteVariantIds = arrify(req.body.deleteVariantIds);
    const deleteProductImageIds = arrify(req.body.deleteProductImageIds);
    const deleteVariantImageIds = arrify(req.body.deleteVariantImageIds);

    if (!productName || !category_id) {
        return res.status(400).json({ message: "Nombre y categoría son obligatorios." });
    }

    const productSlug = slugify(productName);
    const uploadedPublicIds = [];

    let productMainUpload = null;
    let productHoverUpload = null;
    const productExtraUploads = [];
    const variantUploads = {};

    // --- Subir imágenes nuevas primero ---
    try {
        const mainFile = req.files.find(f => f.fieldname === 'mainImage');
        if (mainFile) {
            productMainUpload = await uploadToCloudinary(mainFile.buffer, 'vansue/productos', `${productSlug}_main_${Date.now()}`, 400, 60);
            uploadedPublicIds.push(productMainUpload.public_id);
        }

        const hoverFile = req.files.find(f => f.fieldname === 'hoverImage');
        if (hoverFile) {
            productHoverUpload = await uploadToCloudinary(hoverFile.buffer, 'vansue/productos_hover', `${productSlug}_hover_${Date.now()}`, 400, 60);
            uploadedPublicIds.push(productHoverUpload.public_id);
        }

        const productExtraFiles = req.files.filter(f => f.fieldname === 'extraImages');
        for (let i = 0; i < productExtraFiles.length; i++) {
            const up = await uploadToCloudinary(productExtraFiles[i].buffer, 'vansue/productos_extra', `${productSlug}_extra_${Date.now()}_${i}`, 600, 70);
            uploadedPublicIds.push(up.public_id);
            productExtraUploads.push(up);
        }

        for (const variant of variants) {
            const variantSlug = `${productSlug}_${slugify(variant.variant_name)}`;
            variantUploads[variant.index] = { main: null, hover: null, extras: [] };

            const vMain = req.files.find(f => f.fieldname === `variantMain_${variant.index}`);
            if (vMain) {
                const up = await uploadToCloudinary(vMain.buffer, 'vansue/variantes', `${variantSlug}_main_${Date.now()}`, 400, 60);
                uploadedPublicIds.push(up.public_id);
                variantUploads[variant.index].main = up;
            }

            const vHover = req.files.find(f => f.fieldname === `variantHover_${variant.index}`);
            if (vHover) {
                const up = await uploadToCloudinary(vHover.buffer, 'vansue/variantes_hover', `${variantSlug}_hover_${Date.now()}`, 400, 60);
                uploadedPublicIds.push(up.public_id);
                variantUploads[variant.index].hover = up;
            }

            const vExtras = req.files.filter(f => f.fieldname === `variantExtra_${variant.index}`);
            for (let i = 0; i < vExtras.length; i++) {
                const up = await uploadToCloudinary(vExtras[i].buffer, 'vansue/variantes_extra', `${variantSlug}_extra_${Date.now()}_${i}`, 600, 70);
                uploadedPublicIds.push(up.public_id);
                variantUploads[variant.index].extras.push(up);
            }
        }

    } catch (uploadError) {
        console.error('❌ Error al subir imágenes a Cloudinary:', uploadError);
        await cleanupUploads(uploadedPublicIds);
        return res.status(500).json({ message: `Error al subir imágenes: ${uploadError.message}` });
    }

    // --- Ahora sí, aplicar cambios en MySQL ---
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        await connection.query(
            `UPDATE productos SET name=?, brand=?, description=?, category_id=?, gender_id=? WHERE id=?`,
            [productName, productBrand, productDescription, category_id, gender_id || null, productId]
        );

        if (deleteVariantIds.length) {
            await connection.query(`DELETE FROM variantes WHERE id IN (?)`, [deleteVariantIds]);
        }

        if (deleteProductImageIds.length) {
            await connection.query(`DELETE FROM productos_imagenes WHERE id IN (?) AND product_id = ?`, [deleteProductImageIds, productId]);
        }

        if (deleteVariantImageIds.length) {
            await connection.query(`DELETE FROM variantes_imagenes WHERE id IN (?)`, [deleteVariantImageIds]);
        }

        if (productMainUpload) {
            await connection.query(`DELETE FROM productos_imagenes WHERE product_id=? AND type='principal'`, [productId]);
            await connection.query(`INSERT INTO productos_imagenes (product_id, image, type) VALUES (?, ?, 'principal')`, [productId, productMainUpload.secure_url]);
        }

        if (productHoverUpload) {
            await connection.query(`DELETE FROM productos_imagenes WHERE product_id=? AND type='hover'`, [productId]);
            await connection.query(`INSERT INTO productos_imagenes (product_id, image, type) VALUES (?, ?, 'hover')`, [productId, productHoverUpload.secure_url]);
        }

        for (const up of productExtraUploads) {
            await connection.query(`INSERT INTO productos_imagenes (product_id, image, type) VALUES (?, ?, 'extra')`, [productId, up.secure_url]);
        }

        for (const variant of variants) {
            let variantId = variant.id;

            if (variantId) {
                await connection.query(
                    `UPDATE variantes SET variant_name=?, sale_price=?, quantity=?, barcode=? WHERE id=?`,
                    [variant.variant_name, variant.sale_price, variant.quantity || 0, variant.barcode || null, variantId]
                );
            } else {
                const [variantResult] = await connection.query(
                    `INSERT INTO variantes (product_id, variant_name, sale_price, quantity, barcode) 
                     VALUES (?, ?, ?, ?, ?)`,
                    [productId, variant.variant_name, variant.sale_price, variant.quantity || 0, variant.barcode || null]
                );
                variantId = variantResult.insertId;
            }

            const uploads = variantUploads[variant.index];

            if (uploads.main) {
                await connection.query(`DELETE FROM variantes_imagenes WHERE variant_id=? AND type='principal'`, [variantId]);
                await connection.query(`INSERT INTO variantes_imagenes (variant_id, image, type) VALUES (?, ?, 'principal')`, [variantId, uploads.main.secure_url]);
            }

            if (uploads.hover) {
                await connection.query(`DELETE FROM variantes_imagenes WHERE variant_id=? AND type='hover'`, [variantId]);
                await connection.query(`INSERT INTO variantes_imagenes (variant_id, image, type) VALUES (?, ?, 'hover')`, [variantId, uploads.hover.secure_url]);
            }

            for (const up of uploads.extras) {
                await connection.query(`INSERT INTO variantes_imagenes (variant_id, image, type) VALUES (?, ?, 'extra')`, [variantId, up.secure_url]);
            }
        }

        await connection.commit();
        res.status(200).send("Producto actualizado correctamente");

    } catch (dbError) {
        await connection.rollback();
        console.error('❌ Error al actualizar producto en la base de datos:', dbError);
        await cleanupUploads(uploadedPublicIds);
        res.status(500).send("Error al actualizar el producto");
    } finally {
        connection.release();
    }
});

// ========================
// DELETE /productos/:id
// ========================
router.delete('/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM productos WHERE id = ?', [req.params.id]);
        res.status(200).json({ success: true, message: 'Producto eliminado correctamente' });
    } catch (err) {
        console.error('Error al eliminar el producto:', err);
        res.status(500).send('Error al eliminar el producto');
    }
});

module.exports = router;