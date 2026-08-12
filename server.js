// ==========================================
// CARGAR VARIABLES DE ENTORNO
// ==========================================
require('dotenv').config();


// ==========================================
// IMPORTAR MÓDULOS
// ==========================================
const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const sharp = require('sharp');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');


// ==========================================
// CONFIGURACIÓN DE EXPRESS
// ==========================================
const app = express();

const PORT = process.env.PORT || 3000;


// ==========================================
// CONEXIÓN A BASE DE DATOS
// ==========================================
const db = require('./config/db');


// ==========================================
// CLAVE JWT
// ==========================================
const SECRET_KEY = 'secreto_super_seguro';


// ==========================================
// MULTER
// ==========================================
const storage = multer.memoryStorage();

const upload = multer({
    storage
});


// ==========================================
// CORS
// ==========================================
app.use(cors({
    origin: 'https://vansueglamhn.com',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false
}));


// Responder correctamente a las peticiones OPTIONS
app.options('*', cors());


// ==========================================
// MIDDLEWARE
// ==========================================
app.use(bodyParser.json());


// ==========================================
// RUTAS
// ==========================================

const loginRoutes = require('./routes/login.routes');
app.use('/login', loginRoutes);

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

const productosRoutes = require('./routes/productos.routes');
app.use('/productos', productosRoutes);

const clientesRoutes = require('./routes/clientes.routes');
app.use('/clientes', clientesRoutes);

const generosRoutes = require('./routes/generos.routes');
app.use('/generos', generosRoutes);

const producto_proveedorRouter = require('./routes/producto_proveedor.routes');
app.use('/producto_proveedor', producto_proveedorRouter);

const cuentasPorCobrarRoutes = require('./routes/cuentasPorCobrar.routes');
app.use('/cuentas-por-cobrar', cuentasPorCobrarRoutes);

const cajaRoutes = require('./routes/caja.routes');
app.use('/caja', cajaRoutes);

const gastosRoutes = require('./routes/gastos.routes');
app.use('/gastos', gastosRoutes);

const cuentasPorPagarRoutes = require('./routes/cuentasPorPagar.routes');
app.use('/cuentas-por-pagar', cuentasPorPagarRoutes);

const bancosRoutes = require('./routes/bancos.routes');
app.use('/bancos', bancosRoutes);

const ingresosExtraRoutes = require('./routes/ingresosExtra.routes');
app.use('/ingresos-extra', ingresosExtraRoutes);

const contabilidadRoutes = require('./routes/contabilidad.routes');
app.use('/contabilidad', contabilidadRoutes);

const dashboardRoutes = require('./routes/dashboard.routes');
app.use('/dashboard', dashboardRoutes);


// ==========================================
// PING
// ==========================================
app.get('/ping', (req, res) => {
    res.status(200).json({
        message: 'pong'
    });
});


// ==========================================
// ARCHIVOS ESTÁTICOS
// ==========================================
app.use(
    '/uploads',
    express.static(path.join(__dirname, 'uploads'))
);


// ==========================================
// INICIAR SERVIDOR
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(
        `Servidor corriendo en http://0.0.0.0:${PORT}`
    );
});