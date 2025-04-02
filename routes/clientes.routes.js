const express = require('express');
const router = express.Router();
const db = require('../config/db'); // Importa la conexión correctamente

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

// Agregar un nuevo cliente
router.post('/', (req, res) => {
    //console.log("Datos recibidos:", req.body); // Verifica si los datos llegan al backend

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

//Ruta para obtener un cliente por id
router.get('/:id', (req, res) => {
    const customerId = req.params.id;

    const query = 'SELECT id, first_name, last_name, email, phone FROM clientes WHERE id = ?';

    db.query(query, [customerId], (err, results) => {
        if(err){
            res.status(500).send('Error al obtener cliente');
        }else if (results === 0){
            res.status(404).send('Cliente no encontrado');
        }else{
            res.status(200).json(results[0]);
        }
    });
});

//Ruta para actualizar un nuevo cliente
router.put('/:id', (req, res) => {
    const customerId = req.params.id;

    const {first_name, last_name, email, phone} = req.body;
    const query = 'UPDATE clientes SET first_name = ?, last_name = ?, email = ?, phone = ? WHERE id = ?';

    const params = [first_name, last_name, email, phone];

    params.push(customerId);

    db.query(query, params, (err, results) => {
        if(err){
            res.status(500).send('Error al actualizar el cliente');
        }else{
            res.status(200).json({ success: true, message: 'Cliente actualizado correctamente'});
        }
    });
});
module.exports = router;