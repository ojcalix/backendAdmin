const express = require('express');
const router = express.Router();
const db = require('../config/db');

// ========================
// GET /clientes
// Obtener todos los clientes
// ========================
router.get('/', async (req, res) => {
    try {
        const [results] = await db.query('SELECT * FROM clientes');
        res.status(200).json(results);
    } catch (err) {
        console.error('Error retrieving customers:', err);
        res.status(500).send('Error retrieving customers');
    }
});

// ========================
// GET /clientes/buscar/:term
// Buscar clientes por nombre o apellido (para el modal)
// ========================
router.get('/buscar/:term', async (req, res) => {
    const term = `%${req.params.term}%`;
    const query = `
        SELECT id, first_name, last_name, phone
        FROM clientes
        WHERE first_name LIKE ? OR last_name LIKE ?
        LIMIT 50
    `;

    try {
        const [results] = await db.query(query, [term, term]);
        res.status(200).json(results);
    } catch (err) {
        console.error('Error al buscar clientes:', err);
        res.status(500).send('Error al buscar clientes');
    }
});

// ========================
// GET /clientes/:id
// Obtener un cliente por ID
// ========================
router.get('/:id', async (req, res) => {
    const customerId = req.params.id;

    try {
        const [results] = await db.query(
            'SELECT id, first_name, last_name, email, phone FROM clientes WHERE id = ?',
            [customerId]
        );

        if (results.length === 0) {
            return res.status(404).send('Cliente no encontrado');
        }

        res.status(200).json(results[0]);

    } catch (err) {
        console.error('Error al obtener cliente:', err);
        res.status(500).send('Error al obtener cliente');
    }
});

// ========================
// POST /clientes
// Agregar un nuevo cliente
// ========================
router.post('/', async (req, res) => {
    let { first_name, last_name, email, phone } = req.body;

    // ✅ CORREGIDO: antes era "email && email.trim() === ''", pero un
    // string vacío ('') ya es falso por sí mismo, así que ese "&&" nunca
    // dejaba pasar a comprobar el trim(). Con "!email ||" cubrimos tanto
    // el caso de string vacío como el de solo espacios en blanco.
    if (!email || email.trim() === '') {
        email = null;
    } else {
        email = email.trim();
    }

    try {
        const [results] = await db.query(
            'INSERT INTO clientes (first_name, last_name, email, phone) VALUES (?, ?, ?, ?)',
            [first_name, last_name, email, phone]
        );

        res.status(200).json({ message: 'Cliente agregado correctamente', customerId: results.insertId });

    } catch (err) {
        console.error('Error en la consulta SQL:', err);

        // ✅ Mensaje más claro si el correo ya existe (para futuros casos reales de duplicado)
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Ya existe un cliente registrado con ese correo.' });
        }

        res.status(500).send('Error al agregar cliente');
    }
});

// ========================
// PUT /clientes/:id
// Actualizar cliente
// ========================
router.put('/:id', async (req, res) => {
    const customerId = req.params.id;
    let { first_name, last_name, email, phone } = req.body;

    // ✅ Misma corrección aquí, para que editar un cliente y borrarle
    // el correo tampoco choque con el mismo bug.
    if (!email || email.trim() === '') {
        email = null;
    } else {
        email = email.trim();
    }

    try {
        await db.query(
            'UPDATE clientes SET first_name = ?, last_name = ?, email = ?, phone = ? WHERE id = ?',
            [first_name, last_name, email, phone, customerId]
        );

        res.status(200).json({ success: true, message: 'Cliente actualizado correctamente' });

    } catch (err) {
        console.error('Error al actualizar el cliente:', err);

        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Ya existe un cliente registrado con ese correo.' });
        }

        res.status(500).send('Error al actualizar el cliente');
    }
});

module.exports = router;