const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const db = require('../config/db');
const bcrypt = require('bcryptjs');

// Obtener todos los usuarios
router.get('/', auth, async (req, res) => {
    try {
        const [results] = await db.query('SELECT id, username, email, role FROM usuarios');
        res.status(200).json(results);
    } catch (err) {
        console.error('Error al obtener usuarios:', err);
        res.status(500).send('Error al obtener los usuarios');
    }
});

// Agregar un nuevo usuario
router.post('/', auth, async (req, res) => {
    const { username, email, password, role } = req.body;

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await db.query(
            'INSERT INTO usuarios (username, email, password, role) VALUES (?, ?, ?, ?)',
            [username, email, hashedPassword, role]
        );
        res.status(201).json({ message: 'Usuario agregado correctamente', userId: result.insertId });
    } catch (err) {
        console.error('Error al agregar usuario:', err);
        res.status(500).send('Error al agregar usuario');
    }
});

// Obtener usuario por ID
router.get('/:id', async (req, res) => {
    const userId = req.params.id;
    try {
        const [results] = await db.query(
            'SELECT id, username, email, role FROM usuarios WHERE id = ?',
            [userId]
        );
        if (results.length === 0) {
            return res.status(404).send('Usuario no encontrado');
        }
        res.status(200).json(results[0]);
    } catch (err) {
        console.error('Error al obtener usuario:', err);
        res.status(500).send('Error al obtener el usuario');
    }
});

// Actualizar usuario
router.put('/:id', async (req, res) => {
    const userId = req.params.id;
    const { username, email, role, password } = req.body;

    try {
        let query = 'UPDATE usuarios SET username = ?, email = ?, role = ?';
        const params = [username, email, role];

        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            query += ', password = ?';
            params.push(hashedPassword);
        }

        query += ' WHERE id = ?';
        params.push(userId);

        await db.query(query, params);

        res.status(200).json({ success: true, message: 'Usuario actualizado correctamente' });
    } catch (err) {
        console.error('Error al actualizar usuario:', err);
        res.status(500).send('Error al actualizar el usuario');
    }
});

// Eliminar usuario
router.delete('/:id', async (req, res) => {
    const userId = req.params.id;
    try {
        await db.query('DELETE FROM usuarios WHERE id = ?', [userId]);
        res.status(200).json({ success: true, message: 'Usuario eliminado correctamente' });
    } catch (err) {
        console.error('Error al eliminar usuario:', err);
        res.status(500).send('Error al eliminar usuario');
    }
});

module.exports = router;
