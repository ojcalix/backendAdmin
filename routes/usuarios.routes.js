const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth'); // Importamos el middleware
const db = require('../config/db'); // Importa la conexión correctamente
const bcrypt = require('bcryptjs');


// Ruta para obtener todos los usuarios
router.get('/', auth, (req, res) => {
    const query = 'SELECT id, username, email, role FROM usuarios';

    db.query(query, (err, results) => {
        if (err) {
            res.status(500).send('Error al obtener los usuarios');
        } else {
            res.status(200).json(results);
        }
    });
});

// Ruta para agregar un nuevo usuario
router.post('/', auth, async (req, res) => {
    const { username, email, password, role } = req.body;

    try {
        const hashedPassword = await bcrypt.hash(password, 10); // Encripta la contraseña

        const query = 'INSERT INTO usuarios (username, email, password, role) VALUES (?, ?, ?, ?)';
        db.query(query, [username, email, hashedPassword, role], (err, result) => {
            if (err) {
                res.status(500).send('Error al agregar usuario');
            } else {
                res.status(201).json({ message: 'Usuario agregado correctamente', userId: result.insertId });
            }
        });
    } catch (error) {
        res.status(500).send('Error al encriptar la contraseña');
    }
});

// Ruta para obtener un usuario por su ID
router.get('/:id', (req, res) => {
    const userId = req.params.id;
    const query = 'SELECT id, username, email, role FROM usuarios WHERE id = ?';

    db.query(query, [userId], (err, results) => {
        if (err) {
            res.status(500).send('Error al obtener el usuario');
        } else if (results.length === 0) {
            res.status(404).send('Usuario no encontrado');
        } else {
            res.status(200).json(results[0]);
        }
    });
});

// Ruta para actualizar un usuario
router.put('/:id', async (req, res) => {
    const userId = req.params.id;
    const { username, email, role, password } = req.body;

    let query = 'UPDATE usuarios SET username = ?, email = ?, role = ?';
    const params = [username, email, role];

    if (password) {
        try {
            const hashedPassword = await bcrypt.hash(password, 10); // Hashear la contraseña
            query += ', password = ?';
            params.push(hashedPassword);
        } catch (err) {
            return res.status(500).json({ success: false, message: 'Error al hashear la contraseña' });
        }
    }

    query += ' WHERE id = ?';
    params.push(userId);

    db.query(query, params, (err, result) => {
        if (err) {
            res.status(500).send('Error al actualizar el usuario');
        } else {
            res.status(200).json({ success: true, message: 'Usuario actualizado correctamente' });
        }
    });
});

// Ruta para eliminar usuario
router.delete('/:id', (req, res) => {
    const userId = req.params.id;
    const query = 'DELETE FROM usuarios WHERE id = ?';

    db.query(query, [userId], (err, result) => {
        if (err) {
            res.status(500).send('Error al eliminar usuario');
        } else {
            res.status(200).json({ success: true, message: 'Usuario eliminado correctamente' });
        }
    });
});

module.exports = router;
