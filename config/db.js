const mysql = require('mysql2');
// Configuración de la conexión a la base de datos MySQL
const db = mysql.createConnection({
    host: 'ojcalix.mysql.database.azure.com', // Dirección del servidor de la base de datos (local en este caso)
    user: 'ojcalix', // Usuario de MySQL (debe ser tu usuario configurado)
    password: 'Shekelo2025', // Contraseña para el usuario de MySQL
    database: 'vansue', // Nombre de la base de datos donde se almacenarán los datos
});

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