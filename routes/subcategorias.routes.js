const express = require('express');
const router = express.Router();
const db = require('../config/db');

router.post('/', (req, res) => {
    const {category_id, name, description} = req.body;

    const query = 'INSERT INTO subcategorias (category_id, name, description) VALUES (?, ?, ?)';

    db.query(query, [category_id, name, description], (err, result) => {
        if(err){
            res.status(500).send('Error al ingresar una sub categoria');
        }else{
            res.status(200).json({ message: 'Sub Categoria agregada correctamente', subcategoriaId: result.insertId});
        }
    });
});

router.get('/', (req, res) => {
    const query = 'SELECT id, category_id, name, description, registration_date FROM subcategorias'

    db.query(query, (err, results) => {
        if(err){
            res.status(500).send('Error al obtener las subcategorias')
        }else{
            res.status(200).json(results);
        }
    });
});

module.exports = router;