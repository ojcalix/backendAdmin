const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise'); // Usamos mysql2 con promesas

// Configurar la conexión a la base de datos
const db = mysql.createPool({
    host: 'maglev.proxy.rlwy.net', // Dirección del servidor de la base de datos (local en este caso)
    port: 55731,
    user: 'root', // Usuario de MySQL (debe ser tu usuario configurado)
    password: 'xrkMadiTIXlGgprYcljxwqusaScdPXHH', // Contraseña para el usuario de MySQL
    database: 'vansue', // Nombre de la base de datos donde se almacenarán los datos
});

async function insertarUsuario() {
    const username = 'ojcalix';
    const password = 'Shekelo2025'; // La contraseña en texto plano
    const email = 'ojcalix@outlook.es'; // Valor para el campo email
    const role = 'Administrador'; // Valor para el campo role

    // Cifrar la contraseña con bcrypt
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insertar en la base de datos
    await db.query('INSERT INTO usuarios (username, password, email, role) VALUES (?, ?, ?, ?)', [username, hashedPassword, email, role]);

    console.log('Usuario insertado con contraseña cifrada');
    process.exit(); // Termina el script
}

// Ejecutar la función
insertarUsuario().catch(err => console.error('Error:', err));
