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
    origin: '*', // Permite solicitudes desde cualquier origen
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
// Middleware para servir archivos estáticos
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configuración de multer (almacenamiento en memoria)
const storage = multer.memoryStorage();
const upload = multer({ storage });

app.post('/api/productos', upload.single('productImage'), async (req, res) => {
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
            const outputPath = path.join(__dirname, 'uploads', uniqueName);

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
app.get('/api/productos', (req, res) => {
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
app.get('/api/productos/:id', (req, res) => {
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
app.put('/api/productos/:id', upload.single('image'), async (req, res) => {
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
            const outputPath = path.join(__dirname, 'uploads', uniqueName);

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