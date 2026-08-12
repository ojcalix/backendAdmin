const mysql = require('mysql2');

// Pool en vez de conexión única:
// - No se cae si una query individual falla (cada .query() maneja su propio error).
// - Soporta varias peticiones concurrentes (tus 2 computadoras consultando a la vez).
// - Se reconecta solo si Railway reinicia la base de datos.
const pool = mysql.createPool({
    host: process.env.MYSQLHOST,
    port: process.env.MYSQLPORT,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

const db = pool.promise();

// Prueba la conexión al arrancar. Con .then/.catch (no callback),
// así una promesa rechazada queda atrapada y NO tumba el proceso.
db.query('SELECT 1')
    .then(() => console.log('Conexión exitosa a la base de datos MySQL'))
    .catch((err) => console.error('Error al conectar a la base de datos:', err.message));

module.exports = db;