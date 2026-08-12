// ============================================
// Configuración inicial
// ============================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');

const db = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// Multer (subida de archivos en memoria)
// NOTA: si productos.routes.js ya declara su propio
// multer/sharp internamente, esto puede sobrar aquí.
// Revísalo y bórralo si no se usa en este archivo.
// ============================================
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ============================================
// CORS — allowlist por variable de entorno
// En Railway: Variables → FRONTEND_URL=https://vansueglamhn.com
// (separa varios orígenes con coma si necesitas más de uno)
// ============================================
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5500').split(',');

app.use(cors({
    origin: function (origin, callback) {
        // origin es undefined en peticiones sin navegador (curl, Postman)
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('No permitido por CORS: ' + origin));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(bodyParser.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ============================================
// Rutas
// ============================================
const routes = [
    { path: '/login', file: './routes/login.routes' },
    { path: '/usuarios', file: './routes/usuarios.routes' },
    { path: '/proveedores', file: './routes/proveedores.routes' },
    { path: '/categorias', file: './routes/categorias.routes' },
    { path: '/compras', file: './routes/compras.routes' },
    { path: '/ventas', file: './routes/ventas.routes' },
    { path: '/productos', file: './routes/productos.routes' },
    { path: '/clientes', file: './routes/clientes.routes' },
    { path: '/generos', file: './routes/generos.routes' },
    { path: '/producto_proveedor', file: './routes/producto_proveedor.routes' },
    { path: '/cuentas-por-cobrar', file: './routes/cuentasPorCobrar.routes' },
    { path: '/caja', file: './routes/caja.routes' },
    { path: '/gastos', file: './routes/gastos.routes' },
    { path: '/cuentas-por-pagar', file: './routes/cuentasPorPagar.routes' },
    { path: '/bancos', file: './routes/bancos.routes' },
    { path: '/ingresos-extra', file: './routes/ingresosExtra.routes' },
    { path: '/contabilidad', file: './routes/contabilidad.routes' },
    { path: '/dashboard', file: './routes/dashboard.routes' },
];

routes.forEach(({ path: routePath, file }) => {
    app.use(routePath, require(file));
});

// Endpoint de salud (para UptimeRobot, sin lógica pesada)
app.get('/ping', (req, res) => {
    res.status(200).json({ message: 'pong' });
});

// ============================================
// 404 — ruta no encontrada
// ============================================
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Ruta no encontrada' });
});

// ============================================
// Manejador de errores global
// Así CUALQUIER error (CORS rechazado, fallo de BD, etc.)
// responde con las cabeceras correctas en vez de que
// el navegador lo confunda con un fallo de CORS.
// ============================================
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
});

// ============================================
// Arranque del servidor
// ============================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en http://0.0.0.0:${PORT}`);
});