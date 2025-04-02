const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise'); // Usamos mysql2 con promesas

// Configurar la conexión a la base de datos
const db = mysql.createPool({
    host: 'ojcalix.mysql.database.azure.com', // Dirección del servidor de la base de datos (local en este caso)
    user: 'ojcalix', // Usuario de MySQL (debe ser tu usuario configurado)
    password: 'Shekelo2025', // Contraseña para el usuario de MySQL
    database: 'vansue', // Nombre de la base de datos donde se almacenarán los datos
});

async function insertarUsuario() {
    const username = 'avpagoaga';
    const password = '1234'; // La contraseña en texto plano
    const email = 'avpagoaga@outlook.es'; // Valor para el campo email
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
