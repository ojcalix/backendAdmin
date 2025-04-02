const express = require('express');
const router = express.Router();
const db = require('../config/db'); // Importa la conexión correctamente

//ruta para obtener todos los proveedores
router.get('/', (req, res) => {
    const query = 'SELECT id, name, address, phone, email, registration_date FROM proveedores'

    db.query(query, (err, results) => {
        if (err) {
            res.status(500).send('Error al cargar proveedores');
        } else {
            res.status(200).json(results);
        }
    });
});

//Ruta para insertar un proveedor
router.post('/', (req, res) => {
    const { name, address, phone, email } = req.body;

    const query = 'INSERT INTO proveedores (name, address, phone, email) VALUES (?, ?, ?, ?)';

    db.query(query, [name, address, phone, email], (err, result) => {
        if (err) {
            res.status(500).send('Error al ingresar proveedor');
        } else {
            res.status(201).json({ message: 'Proveedor agregado correctamente', proveedorId: result.insertId });
        }
    });

});

//Ruta para obtener un usuario por ID
router.get('/:id', (req, res) => {
    const supplierId = req.params.id;

    const query = 'SELECT id, name, address, phone, email FROM proveedores WHERE id = ?';

    db.query(query, [supplierId], (err, results) => {
        if (err) {
            res.status(500).send('Error al obtener el usuario');
        } else if (results.length === 0) {
            res.status(404).send('Supplier no encontrado')
        } else {
            res.status(200).json(results[0]);
        }
    });
});

//Ruta para actualizar un proveedor 
router.put('/:id', (req, res) => {
    const supplierId = req.params.id;

    const { name, address, phone, email } = req.body;

    let query = 'UPDATE proveedores SET name = ?, address = ?, phone = ?, email = ?';

    const params = [name, address, phone, email];

    query += ' WHERE id = ?';
    params.push(supplierId);

    db.query(query, params, (err, result) => {
        if (err) {
            res.status(500).send('Error al actualizar supplier');
        } else {
            res.status(200).json({ success: true, mesage: 'Usuario actualizado correctamente' });
        }
    });
});

//RUTA PARA ELIMINAR UN USUARIO
router.delete('/:id', async (req, res) => {
    const supplierId = req.params.id;
    const query = 'DELETE FROM proveedores WHERE id = ?'

    db.query(query, [supplierId], (err, result) => {
        if (err) {
            res.status(500).send('Error al eliminar usuario');
        } else {
            res.status(200).json({ success: true, message: 'Usuario eliminado correctamente.' });
        }
    })
})

module.exports = router;