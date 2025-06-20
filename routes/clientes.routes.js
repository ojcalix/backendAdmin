const express = require('express');
const router = express.Router();
const db = require('../config/db');

// Obtener todos los clientes
router.get('/', (req, res) => {
    const query = 'SELECT id, first_name, last_name, email, phone, accumulated_points, registration_date FROM clientes';

    db.query(query, (err, results) => {
        if (err) {
            res.status(500).send('Error retrieving customers');
        } else {
            res.status(200).json(results);
        }
    });
});

// Buscar clientes por nombre o apellido (para el modal)
router.get('/buscar/:term', (req, res) => {
    const term = `%${req.params.term}%`;
    const query = `
        SELECT id, first_name, last_name, phone
        FROM clientes
        WHERE first_name LIKE ? OR last_name LIKE ?
        LIMIT 50
    `;

    db.query(query, [term, term], (err, results) => {
        if (err) {
            res.status(500).send('Error al buscar clientes');
        } else {
            res.status(200).json(results);
        }
    });
});

// Obtener un cliente por ID
router.get('/:id', (req, res) => {
    const customerId = req.params.id;
    const query = 'SELECT id, first_name, last_name, email, phone FROM clientes WHERE id = ?';

    db.query(query, [customerId], (err, results) => {
        if (err) {
            res.status(500).send('Error al obtener cliente');
        } else if (results.length === 0) {
            res.status(404).send('Cliente no encontrado');
        } else {
            res.status(200).json(results[0]);
        }
    });
});

// Agregar un nuevo cliente
router.post('/', (req, res) => {
    const { first_name, last_name, email, phone } = req.body;
    const query = 'INSERT INTO clientes (first_name, last_name, email, phone) VALUES (?, ?, ?, ?)';

    db.query(query, [first_name, last_name, email, phone], (err, results) => {
        if (err) {
            console.error("Error en la consulta SQL:", err);
            return res.status(500).send('Error al agregar cliente');
        }
        res.status(200).json({ message: 'Cliente agregado correctamente', customerId: results.insertId });
    });
});

// Actualizar cliente
router.put('/:id', (req, res) => {
    const customerId = req.params.id;
    const { first_name, last_name, email, phone } = req.body;
    const query = 'UPDATE clientes SET first_name = ?, last_name = ?, email = ?, phone = ? WHERE id = ?';

    db.query(query, [first_name, last_name, email, phone, customerId], (err, results) => {
        if (err) {
            res.status(500).send('Error al actualizar el cliente');
        } else {
            res.status(200).json({ success: true, message: 'Cliente actualizado correctamente' });
        }
    });
});

module.exports = router;
