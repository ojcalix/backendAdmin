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

// Red de seguridad: una promesa rechazada sin .catch() en cualquier
// parte del código (no solo en db.js) por defecto tumba el proceso
// en Node 15+. Esto lo registra en el log en vez de matar el server.
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

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
// CORS — allowlist fija en código (para tu escala actual
// esto es más confiable que depender de una variable de
// entorno que hay que recordar configurar en Railway).
// Si algún día agregas más dominios, súmalos a este array.
// ============================================
const allowedOrigins = [
    'https://vansueglamhn.com',
    'https://www.vansueglamhn.com',
    ...(process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : []),
];

// Live Server (y herramientas similares) usan un puerto distinto cada vez
// que abres un proyecto — en vez de listar puertos fijos, se permite
// cualquier puerto de localhost/127.0.0.1 durante desarrollo.
const isLocalOrigin = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

app.use(cors({
    origin: function (origin, callback) {
        // origin es undefined en peticiones sin navegador (curl, Postman)
        if (!origin || allowedOrigins.includes(origin) || isLocalOrigin(origin)) {
            callback(null, true);
        } else {
            console.warn('Origin bloqueado por CORS:', origin);
            callback(new Error('No permitido por CORS: ' + origin));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(bodyParser.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Logger mínimo — así el log de Railway muestra cada petición
// que SÍ llega al servidor, incluyendo los preflight OPTIONS.
app.use((req, res, next) => {
    console.log(`${req.method} ${req.originalUrl} — origin: ${req.headers.origin || 'sin origin'}`);
    next();
});

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