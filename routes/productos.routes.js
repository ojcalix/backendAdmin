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
                // imagen propia de la variante > imagen principal del producto > null
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
// Lista variantes activas. La imagen mostrada es la propia de la variante
// si existe, o la imagen principal del producto como respaldo.
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
// Detalle completo: imágenes del producto (con ids, para editar/eliminar)
// y variantes con SUS PROPIAS imágenes (overrides, sin fallback aquí,
// para que el formulario de edición sepa qué es propio de la variante).
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
// Crea el producto, sus imágenes por defecto (OPCIONALES — principal,
// hover y extra: úsalas solo cuando todas las variantes deben verse
// igual, ej. tonos de maquillaje) y sus variantes (con imagen OPCIONAL,
// para cuando la variante debe verse distinta al producto, ej. tamaños
// de perfume, donde normalmente NO se sube imagen de producto y en su
// lugar cada variante trae la suya).
//
// Campos: productName, productBrand, category_id, gender_id, productDescription
// Archivos producto (opcionales): mainImage, hoverImage, extraImages (múltiples)
// variants = JSON.stringify([{ index, variant_name, sale_price, quantity, barcode }])
// Archivos por variante (opcionales): variantMain_{index}, variantHover_{index}, variantExtra_{index}
// ========================
router.post('/', upload.any(), async (req, res) => {
    const connection = await db.getConnection();

    try {
        const { productName, productBrand, category_id, gender_id, productDescription } = req.body;
        const variants = req.body.variants ? JSON.parse(req.body.variants) : [];

        if (!productName || !category_id) {
            connection.release();
            return res.status(400).json({ message: "Nombre y categoría son obligatorios." });
        }

        if (!variants.length) {
            connection.release();
            return res.status(400).json({ message: "Debe agregar al menos una variante." });
        }

        // Las imágenes del producto (principal/hover/extra) son OPCIONALES.
        // Úsalas cuando todas las variantes comparten la misma imagen
        // (ej. tonos de maquillaje). Si cada variante necesita su propia
        // foto (ej. tamaños de perfume), déjalas vacías y sube la imagen
        // directamente en cada variante.
        const mainFile = req.files.find(f => f.fieldname === 'mainImage');
        const hoverFile = req.files.find(f => f.fieldname === 'hoverImage');

        await connection.beginTransaction();

        const [insertResult] = await connection.query(
            `INSERT INTO productos (name, brand, description, category_id, gender_id) VALUES (?, ?, ?, ?, ?)`,
            [productName, productBrand, productDescription, category_id, gender_id || null]
        );

        const productId = insertResult.insertId;
        const productSlug = productName.replace(/\s+/g, '_').toLowerCase();

        // ---- Imágenes del producto (por defecto, opcionales) ----
        if (mainFile) {
            const mainUpload = await uploadToCloudinary(mainFile.buffer, 'vansue/productos', `${productSlug}_main_${Date.now()}`, 400, 60);
            await connection.query(
                `INSERT INTO productos_imagenes (product_id, image, type) VALUES (?, ?, 'principal')`,
                [productId, mainUpload.secure_url]
            );
        }

        if (hoverFile) {
            const hoverUpload = await uploadToCloudinary(hoverFile.buffer, 'vansue/productos_hover', `${productSlug}_hover_${Date.now()}`, 400, 60);
            await connection.query(
                `INSERT INTO productos_imagenes (product_id, image, type) VALUES (?, ?, 'hover')`,
                [productId, hoverUpload.secure_url]
            );
        }

        const productExtraFiles = req.files.filter(f => f.fieldname === 'extraImages');
        for (let i = 0; i < productExtraFiles.length; i++) {
            const extraUpload = await uploadToCloudinary(productExtraFiles[i].buffer, 'vansue/productos_extra', `${productSlug}_extra_${Date.now()}_${i}`, 600, 70);
            await connection.query(
                `INSERT INTO productos_imagenes (product_id, image, type) VALUES (?, ?, 'extra')`,
                [productId, extraUpload.secure_url]
            );
        }

        // ---- Variantes (imágenes OPCIONALES) ----
        for (const variant of variants) {
            const [variantResult] = await connection.query(
                `INSERT INTO variantes (product_id, variant_name, sale_price, quantity, barcode) 
                 VALUES (?, ?, ?, ?, ?)`,
                [productId, variant.variant_name, variant.sale_price, variant.quantity || 0, variant.barcode || null]
            );

            const variantId = variantResult.insertId;
            const variantSlug = `${productSlug}_${variant.variant_name}`.replace(/\s+/g, '_').toLowerCase();

            const vMain = req.files.find(f => f.fieldname === `variantMain_${variant.index}`);
            if (vMain) {
                const up = await uploadToCloudinary(vMain.buffer, 'vansue/variantes', `${variantSlug}_main_${Date.now()}`, 400, 60);
                await connection.query(
                    `INSERT INTO variantes_imagenes (variant_id, image, type) VALUES (?, ?, 'principal')`,
                    [variantId, up.secure_url]
                );
            }

            const vHover = req.files.find(f => f.fieldname === `variantHover_${variant.index}`);
            if (vHover) {
                const up = await uploadToCloudinary(vHover.buffer, 'vansue/variantes_hover', `${variantSlug}_hover_${Date.now()}`, 400, 60);
                await connection.query(
                    `INSERT INTO variantes_imagenes (variant_id, image, type) VALUES (?, ?, 'hover')`,
                    [variantId, up.secure_url]
                );
            }

            const vExtras = req.files.filter(f => f.fieldname === `variantExtra_${variant.index}`);
            for (let i = 0; i < vExtras.length; i++) {
                const up = await uploadToCloudinary(vExtras[i].buffer, 'vansue/variantes_extra', `${variantSlug}_extra_${Date.now()}_${i}`, 600, 70);
                await connection.query(
                    `INSERT INTO variantes_imagenes (variant_id, image, type) VALUES (?, ?, 'extra')`,
                    [variantId, up.secure_url]
                );
            }
        }

        await connection.commit();
        res.status(201).json({ message: 'Producto y variantes registrados correctamente', productId });

    } catch (err) {
        await connection.rollback();
        console.error('Error al registrar producto:', err);
        res.status(500).json({ message: 'Error al registrar el producto' });
    } finally {
        connection.release();
    }
});

// ========================
// PUT /productos/:id
// Actualiza datos del producto, sus imágenes por defecto (reemplaza
// principal/hover si se sube una nueva, agrega extras) y sus variantes.
//
// Campos extra: deleteProductImageIds (extras del producto a borrar),
// deleteVariantImageIds (overrides de variante a borrar/revertir al
// producto), deleteVariantIds (variantes completas a borrar)
// ========================
router.put('/:id', upload.any(), async (req, res) => {
    const connection = await db.getConnection();

    try {
        const productId = req.params.id;
        const { productName, productBrand, category_id, gender_id, productDescription } = req.body;
        const variants = req.body.variants ? JSON.parse(req.body.variants) : [];

        const deleteVariantIds = arrify(req.body.deleteVariantIds);
        const deleteProductImageIds = arrify(req.body.deleteProductImageIds);
        const deleteVariantImageIds = arrify(req.body.deleteVariantImageIds);

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

        const productSlug = productName.replace(/\s+/g, '_').toLowerCase();

        // ---- Reemplazo opcional de imágenes del producto ----
        const mainFile = req.files.find(f => f.fieldname === 'mainImage');
        if (mainFile) {
            await connection.query(`DELETE FROM productos_imagenes WHERE product_id=? AND type='principal'`, [productId]);
            const up = await uploadToCloudinary(mainFile.buffer, 'vansue/productos', `${productSlug}_main_${Date.now()}`, 400, 60);
            await connection.query(`INSERT INTO productos_imagenes (product_id, image, type) VALUES (?, ?, 'principal')`, [productId, up.secure_url]);
        }

        const hoverFile = req.files.find(f => f.fieldname === 'hoverImage');
        if (hoverFile) {
            await connection.query(`DELETE FROM productos_imagenes WHERE product_id=? AND type='hover'`, [productId]);
            const up = await uploadToCloudinary(hoverFile.buffer, 'vansue/productos_hover', `${productSlug}_hover_${Date.now()}`, 400, 60);
            await connection.query(`INSERT INTO productos_imagenes (product_id, image, type) VALUES (?, ?, 'hover')`, [productId, up.secure_url]);
        }

        const productExtraFiles = req.files.filter(f => f.fieldname === 'extraImages');
        for (let i = 0; i < productExtraFiles.length; i++) {
            const up = await uploadToCloudinary(productExtraFiles[i].buffer, 'vansue/productos_extra', `${productSlug}_extra_${Date.now()}_${i}`, 600, 70);
            await connection.query(`INSERT INTO productos_imagenes (product_id, image, type) VALUES (?, ?, 'extra')`, [productId, up.secure_url]);
        }

        // ---- Variantes ----
        for (const variant of variants) {
            let variantId = variant.id;
            const variantSlug = `${productSlug}_${variant.variant_name}`.replace(/\s+/g, '_').toLowerCase();

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

            const vMain = req.files.find(f => f.fieldname === `variantMain_${variant.index}`);
            if (vMain) {
                await connection.query(`DELETE FROM variantes_imagenes WHERE variant_id=? AND type='principal'`, [variantId]);
                const up = await uploadToCloudinary(vMain.buffer, 'vansue/variantes', `${variantSlug}_main_${Date.now()}`, 400, 60);
                await connection.query(`INSERT INTO variantes_imagenes (variant_id, image, type) VALUES (?, ?, 'principal')`, [variantId, up.secure_url]);
            }

            const vHover = req.files.find(f => f.fieldname === `variantHover_${variant.index}`);
            if (vHover) {
                await connection.query(`DELETE FROM variantes_imagenes WHERE variant_id=? AND type='hover'`, [variantId]);
                const up = await uploadToCloudinary(vHover.buffer, 'vansue/variantes_hover', `${variantSlug}_hover_${Date.now()}`, 400, 60);
                await connection.query(`INSERT INTO variantes_imagenes (variant_id, image, type) VALUES (?, ?, 'hover')`, [variantId, up.secure_url]);
            }

            const vExtras = req.files.filter(f => f.fieldname === `variantExtra_${variant.index}`);
            for (let i = 0; i < vExtras.length; i++) {
                const up = await uploadToCloudinary(vExtras[i].buffer, 'vansue/variantes_extra', `${variantSlug}_extra_${Date.now()}_${i}`, 600, 70);
                await connection.query(`INSERT INTO variantes_imagenes (variant_id, image, type) VALUES (?, ?, 'extra')`, [variantId, up.secure_url]);
            }
        }

        await connection.commit();
        res.status(200).send("Producto actualizado correctamente");

    } catch (err) {
        await connection.rollback();
        console.error(err);
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