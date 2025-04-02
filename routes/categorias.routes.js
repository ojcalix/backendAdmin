const express = require('express');
const router = express.Router();
const db = require('../config/db'); // Importa la conexión correctamente

// //RUTA PARA CARGAR CATEGORIAS
router.get('/', (req, res) => {
    const query = 'SELECT id, name, description FROM categorias';

    db.query(query, (err, results) => {
        if (err) {
            res.status(500).send('Error al obtener categorias');
        } else {
            res.status(200).json(results);
        }
    });
});

//RURA PARA AGREGAR UNA NUEVA CATEGORIA
router.post('/', (req, res) => {
    const { categoryname, categorydescription } = req.body;

    const query = 'INSERT INTO categorias (name, description) VALUES (?, ?)'

    db.query(query, [categoryname, categorydescription], (err, result) => {
        if (err) {
            res.status(500).send('Error al agregar la categoria');
        } else {
            res.status(201).json({ message: 'Categoria agregada correctamente,', categoryId: result.insertId });
        }
    });
});

//RUTA PARA OBTENER UNA CATEGORIA POR SU ID
router.get('/:id', (req, res) => {
    const categoryId = req.params.id;
    const query = 'SELECT id, name, description FROM categorias WHERE id = ?';

    db.query(query, [categoryId], (err, results) => {
        if (err) {
            res.status(200).send('Error al obtener categoria');
        } else if (results.length === 0) {
            res.status(404).send('Categoria no encontrada');
        } else {
            res.status(200).json(results[0]);
        }
    });
});

router.put('/:id', (req, res) => {
    const categoryId = req.params.id;
    const { name, description } = req.body;

    let query = 'UPDATE categorias SET name = ?, description = ?';

    const params = [name, description];

    query += ' WHERE id = ?';
    params.push(categoryId);

    db.query(query, params, (err, result) => {
        if (err) {
            res.status(500).send('Error al actualizar categoria');
        } else {
            res.status(200).json({ success: true, mesage: 'Categoria actualizada correctamente' })
        }
    })
})

router.delete('/:id', async (req, res) => {
    const categoryId = req.params.id;
    const query = 'DELETE FROM categorias WHERE id = ?';

    db.query(query, [categoryId], (err, result) => {
        if (err) {
            res.status(500).send('Error al eliminar categoria');
        } else {
            res.status(200).json({ success: true, message: 'Categoria eliminado correctamente' });
        }
    })
})
module.exports = router;