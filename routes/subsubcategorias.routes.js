const express = require('express');
const router = express.Router();
const db = require('../config/db');

router.get('/', async (req, res) => {
    try {
        const [results] = await db.query(
            'SELECT id, subcategory_id, name, description, registration_date FROM sub_subcategorias'
        );
        res.status(200).json(results);
    } catch (error) {
        console.error('Error al obtener subcategorías:', err);
        res.status(500).send('Error al obtener las subcategorías');
    }
});

router.post('/', async (req, res) => {
    const { subcategory_id, name, description } = req.body;

    try {
        const [result] = await db.query(
            'INSERT INTO sub_subcategorias (subcategory_id, name, description) VALUES (?, ?, ?)',
            [subcategory_id, name, description]
        );

        res.status(201).json({ 
            success: true,
            message: 'Sub Subcategoría agregada correctamente',
            subsubcategoriaId: result.insertId 
        });
    } catch (err) {
        console.error('Error al agregar sub subcategoría:', err);
        res.status(500).send('Error al ingresar una sub subcategoría');
    }
});

module.exports = router;