const mysql = require('mysql2');

// Un solo archivo para los dos entornos, sin comentar/descomentar nada:
// - En Railway, esas 5 variables SIEMPRE existen (las inyecta la plataforma),
//   así que process.env.MYSQLHOST, etc. tienen valor real y se usan esas.
// - En tu máquina local, si tu .env no las define (o no tienes .env),
//   caen en el valor por defecto después del "||" — tu MySQL local.
const pool = mysql.createPool({
    host: process.env.MYSQLHOST || 'localhost',
    port: process.env.MYSQLPORT || 3306,
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || '',
    database: process.env.MYSQLDATABASE || 'vansue',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

const db = pool.promise();

// Prueba la conexión al arrancar. Con .then/.catch (no callback),
// así una promesa rechazada queda atrapada y NO tumba el proceso.
db.query('SELECT 1')
    .then(() => console.log(`Conexión exitosa a la base de datos: ${process.env.MYSQLDATABASE || 'vansue (local)'}`))
    .catch((err) => console.error('Error al conectar a la base de datos:', err.message));

module.exports = db;