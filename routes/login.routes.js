const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../config/db');

// ⚠️ Ver nota abajo sobre esta clave
const SECRET_KEY = process.env.JWT_SECRET || 'secreto_super_seguro';

// ========================
// POST /login
// ========================
router.post('/', async (req, res) => {
    const { username, password } = req.body;

    try {
        const [results] = await db.query(
            'SELECT * FROM usuarios WHERE username = ?',
            [username]
        );

        if (results.length === 0) {
            return res.status(401).json({ success: false, message: 'Usuario no encontrado' });
        }

        const user = results[0];

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
        }

        const token = jwt.sign(
            { userId: user.id, role: user.role },
            SECRET_KEY,
            { expiresIn: '1h' }
        );

        res.status(200).json({
            success: true,
            message: 'Inicio de sesión exitoso',
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role
            }
        });

    } catch (err) {
        console.error('Error en el login:', err);
        res.status(500).send('Error en el servidor');
    }
});

module.exports = router;