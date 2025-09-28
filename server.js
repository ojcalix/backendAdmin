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
// Configuración de multer (almacenamiento en memoria)
const storage = multer.memoryStorage();
const upload = multer({ storage });
require('dotenv').config();

// Aplica middleware global
// Habilitar CORS
app.use(cors({
    origin: '*', // Permite solicitudes desde cualquier origen
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json()); // Convierte automáticamente el cuerpo de las solicitudes a JSON

const loginRoutes = require('./routes/login.routes');
app.use('/login', loginRoutes);

const usuariosRoutes = require('./routes/usuarios.routes');
app.use('/usuarios', usuariosRoutes);

const proveedoresRoutes = require('./routes/proveedores.routes');
app.use('/proveedores', proveedoresRoutes);

const categoriasRoutes = require('./routes/categorias.routes');
app.use('/categorias', categoriasRoutes);

const subCategoriasRoutes = require('./routes/subcategorias.routes');
app.use('/subcategorias', subCategoriasRoutes);

const subSubCategoriasRoutes = require('./routes/subsubcategorias.routes');
app.use('/subsubcategorias', subSubCategoriasRoutes);

const comprasRoutes = require('./routes/compras.routes');
app.use('/compras', comprasRoutes);

const ventasRoutes = require('./routes/ventas.routes');
app.use('/ventas', ventasRoutes);

const productosRoutes = require('./routes/productos.routes');
app.use('/productos', productosRoutes);

const clientesRoutes = require('./routes/clientes.routes');
//const { request } = require('http');
app.use('/clientes', clientesRoutes);

const producto_proveedorRouter = require('./routes/producto_proveedor.routes');
app.use('/producto_proveedor', producto_proveedorRouter);
//para que UptimeRobot no dispare funciones pesadas en el API
app.get('/ping', (req, res) => {
  res.status(200).json({ message: 'pong' });
});

// Ruta para manejar el inicio de sesión
// app.post define una ruta para manejar solicitudes POST

// Servir archivos estáticos de la carpeta 'uploads'
// Esto le dice a Express que cualquier archivo que esté en la carpeta 'uploads'
// Middleware para servir archivos estáticos
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Inicia el servidor en el puerto definido
// app.listen escucha las solicitudes en el puerto indicado desde todas las interfaces de red
app.listen(PORT, '0.0.0.0', () => {
    // Indica en la consola que el servidor está corriendo
    console.log(`Servidor corriendo en http://0.0.0.0:${PORT}`);
});
