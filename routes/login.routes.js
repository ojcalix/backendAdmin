const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken'); // Importamos JWT
const bcrypt = require('bcryptjs'); // Importamos bcrypt
const db = require('../config/db');
const SECRET_KEY = 'secreto_super_seguro'; // Declarar la clave secreta aquí

router.post('/', (req, res) => {
    const { username, password } = req.body;

    const query = 'SELECT * FROM usuarios WHERE username = ?';
    db.query(query, [username], async (err, results) => {
        if (err) {
            return res.status(500).send('Error en el servidor');
        }
        if (results.length === 0) {
            return res.status(401).json({ success: false, message: 'Usuario no encontrado' });
        }

        const user = results[0];

        // Comparar la contraseña ingresada con la almacenada
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
        }

        // Generar un token JWT con la información del usuario
        const token = jwt.sign({ userId: user.id, role: user.role }, SECRET_KEY, { expiresIn: '1h' });

        res.status(200).json({ success: true, message: 'Inicio de sesión exitoso', token });
    });
});

module.exports = router;
