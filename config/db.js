const mysql = require('mysql2');


// Configuración de la conexión a la base de datos MySQL
const db = mysql.createConnection({
    host: process.env.MYSQLHOST,
    port: process.env.MYSQLPORT,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE
}).promise();

// Establece la conexión a la base de datos
db.connect((err) => {
    if (err) {
        // Si ocurre un error en la conexión, lo muestra en la consola
        console.error('Error al conectar a la base de datos:', err);
    } else {
        // Si la conexión es exitosa, lo indica en la consola
        console.log('Conexión exitosa a la base de datos MySQL');
    }
});
module.exports = db;