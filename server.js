// Importa los módulos necesarios
const express = require('express'); // Framework para crear y manejar servidores web
const mysql = require('mysql2'); // Librería para conectarse y realizar consultas a MySQL
const bodyParser = require('body-parser'); // Middleware para procesar datos JSON en las solicitudes
const cors = require('cors'); // Middleware para permitir solicitudes desde otros dominios
const multer = require('multer');
const path = require('path');
const sharp = require('sharp');
const fs = require('fs');
// Configura la aplicación Express
const app = express(); // Crea una aplicación Express
const PORT = 3000; // Define el puerto en el que el servidor estará escuchando
const db = require('./config/db'); // Importa la conexión
const jwt = require('jsonwebtoken'); // Importamos JWT
const bcrypt = require('bcryptjs'); // Importamos bcrypt
const SECRET_KEY = 'secreto_super_seguro'; // Declarar la clave secreta aquí

// Aplica middleware global
// Habilitar CORS
app.use(cors({
    origin: 'http://127.0.0.1:5501', // Especifica el origen de tu frontend
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json()); // Convierte automáticamente el cuerpo de las solicitudes a JSON

const usuariosRoutes = require('./routes/usuarios.routes');
app.use('/usuarios', usuariosRoutes);

const proveedoresRoutes = require('./routes/proveedores.routes');
app.use('/proveedores', proveedoresRoutes);

const categoriasRoutes = require('./routes/categorias.routes');
app.use('/categorias', categoriasRoutes);

const comprasRoutes = require('./routes/compras.routes');
app.use('/compras', comprasRoutes);

const ventasRoutes = require('./routes/ventas.routes');
app.use('/ventas', ventasRoutes);

const clientesRoutes = require('./routes/clientes.routes');
const { request } = require('http');
app.use('/clientes', clientesRoutes);


// Ruta para manejar el inicio de sesión
// app.post define una ruta para manejar solicitudes POST
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    const query = 'SELECT * FROM usuarios WHERE username = ?';
    db.query(query, [username], async (err, results) => {
        if (err) {
            return res.status(500).send('Error en el servidor');
        }
        if (results.length === 0) {
            return res.status(401).json({ success: false, message: 'Usuario no encontrado' });
        }

        const user = results[0];

        // Comparar la contraseña ingresada con la almacenada
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
        }

        // Generar un token JWT con la información del usuario
        const token = jwt.sign({ userId: user.id, role: user.role }, SECRET_KEY, { expiresIn: '1h' });

        res.status(200).json({ success: true, message: 'Inicio de sesión exitoso', token });
    });
});
// Servir archivos estáticos de la carpeta 'uploads'
// Esto le dice a Express que cualquier archivo que esté en la carpeta 'uploads'
// se puede acceder desde una URL que comience con '/uploads'.
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
// 'path.join(__dirname, '../uploads')' asegura que la ruta esté correctamente construida, 
// apuntando a la carpeta 'uploads' en la ubicación correcta, sin importar el sistema operativo.

// Configuración de multer para el manejo de archivos subidos
const storage = multer.memoryStorage();

// Aquí se configura multer con la opción 'storage' que hemos definido
const upload = multer({ storage });

// Ruta para agregar productos a la base de datos
// 'upload.single('productImage')' es el middleware que maneja la carga de una imagen de un solo archivo
// y la guarda en la carpeta 'uploads'. El campo del formulario se llama 'productImage'.
// Ruta para agregar productos
app.post('/api/productos', upload.single('productImage'), async (req, res) => {
    try {
        const {
            productId, productName, productBrand, productCategory,
            productSubCategory, productDescription, productSupplier,
            purchasePrice, salePrice, productQuantity
        } = req.body;

        let imagePath = null;

        if (req.file) {
            // Ruta donde se guardará la imagen optimizada
            const uniqueName = `product_${Date.now()}.jpg`; // Nombre único para la imagen
            const outputPath = path.join(__dirname, '../uploads', uniqueName);

            // Procesar y convertir la imagen a JPEG optimizado
            await sharp(req.file.buffer)
                .resize(500, 500, { fit: 'inside' }) // Redimensionar a un máximo de 500x500px
                .toFormat('jpeg', { quality: 80 })  // Convertir a JPEG con calidad del 80%
                .toFile(outputPath);

            imagePath = uniqueName; // Guardar el nombre del archivo en la BD
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
                res.status(500).send('Error al agregar el producto');
            } else {
                res.send('Producto agregado correctamente');
            }
        });

    } catch (error) {
        console.error('Error procesando la imagen:', error);
        res.status(500).send('Error procesando la imagen');
    }
});

// Ruta para cargar todos los productos desde la base de datos
app.get('/api/productos', (req, res) => {
    const query = `
    SELECT 
productos.id AS productId,          -- ID del producto
    productos.name AS productName,      -- Nombre del producto
    productos.brand AS productBrand,    -- Marca del producto
    productos.description AS productDescription, -- Descripción del producto
    categorias.name AS productCategory, -- Nombre de la categoría del producto
    proveedores.name AS productSupplier, -- Nombre del proveedor
    productos.purchase_price AS purchasePrice, -- Precio de compra
    productos.sale_price AS salePrice,  -- Precio de venta
    productos.quantity AS productQuantity, -- Cantidad disponible
    productos.image AS productImage,    -- Ruta de la imagen
    productos.registration_date AS createdAt -- Fecha de registro
FROM productos
LEFT JOIN categorias ON productos.category_id = categorias.id
LEFT JOIN proveedores ON productos.supplier_id = proveedores.id
ORDER BY productos.registration_date DESC; -- Ordena por la fecha de registro del producto (de más reciente a más antiguo)
    `;

    db.query(query, (err, results) => {
        if (err) {
            console.error('Error al cargar los productos:', err);
            res.status(500).send('Error al cargar los productos');
        } else {
            res.status(200).json(results);
        }
    });
});
//Ruta para obtener los productos
app.get('/api/productos/:id', (req, res) => {
    const productId = req.params.id;

    const query = `
        SELECT id AS productId, name AS productName, brand AS productBrand, 
               description AS productDescription, supplier_id, category_id, 
               purchase_price AS purchasePrice, sale_price AS salePrice, 
               quantity AS productQuantity, image AS productImage 
        FROM productos 
        WHERE id = ?
    `;

    db.query(query, [productId], (err, results) => {
        if (err) {
            console.error('Error al obtener el producto:', err);
            res.status(500).send('Error al obtener el producto');
        } else if (results.length === 0) {
            res.status(404).send('Producto no encontrado');
        } else {
            res.status(200).json(results[0]);
        }
    });
});

// Backend: Ruta para actualizar un producto
app.put('/api/productos/:id', upload.single('image'), (req, res) => {
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

    // Consultar la imagen actual antes de actualizar
    const selectImageSql = 'SELECT image FROM productos WHERE id = ?';
    db.query(selectImageSql, [productId], (err, result) => {
        if (err) {
            console.error('Error al obtener la imagen actual:', err);
            return res.status(500).json({ error: 'Error en la base de datos' });
        }

        let imagePath = (result.length > 0) ? result[0].image : null;

        // Si se sube una nueva imagen, reemplazar la existente
        if (req.file) {
            imagePath = req.file.path;
        }

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
            purchase_price, sale_price, quantity, imagePath,
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
app.delete('/api/productos/:id', async (req, res) => {
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


//
app.get('/productos/ap', (req, res) => {
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

app.post('/productos/ap', upload.single('productImage'), (req, res) => {
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

app.get('/ultimos-10-dias', (req, res) => {
    const query = `
    SELECT DATE(sale_date) AS fecha, SUM(total) AS total FROM ventas
    WHERE sale_date >= CURDATE() - INTERVAL 10 DAY
    GROUP BY DATE(sale_date)
    ORDER BY fecha ASC;
    `

    db.query(query, (err, result) => {
        if (err) {
            console.error("Error en la consulta SQL:", err);
            res.status(500).send('Error al obtener las ventas de los ultimos 10 dias');
        } else {
            res.status(200).json(result);
        }
    });
});

app.get('/ultimos-12-meses', (req, res) => {
    const query = `
    SELECT DATE_FORMAT(sale_date, '%Y-%m') AS mes, SUM(total) AS total
    FROM ventas
    WHERE sale_date >= CURDATE() - INTERVAL 12 MONTH
    GROUP BY mes
    ORDER BY mes ASC;
`;

    db.query(query, (err, result) => {
        if(err){
            res.status(500).send('Error al obtener las ventas de los ultimos 12 meses');
        }else{
            res.status(200).json(result);
        }
    })
})

app.get('/subcategorias', (req, res) => {
    const query = 'SELECT id, category_id, name, description, registration_date FROM subcategorias'

    db.query(query, (err, result) => {
        if(err){
            res.status(500).send('Error al cargar las categorias desde el servidor');
        }else{
            res.status(200).json(result);
        }
    });
});

// Inicia el servidor en el puerto definido
// app.listen escucha las solicitudes en el puerto indicado
app.listen(PORT, () => {
    // Indica en la consola que el servidor está corriendo
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});