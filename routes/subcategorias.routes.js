const express = require('express');
const router = express.Router();
const db = require('../config/db');

// ================================
// RUTA PARA AGREGAR SUBCATEGORÍA
// ================================
router.post('/', async (req, res) => {
    const { category_id, name, description } = req.body;

    try {
        const [result] = await db.query(
            'INSERT INTO subcategorias (category_id, name, description) VALUES (?, ?, ?)',
            [category_id, name, description]
        );

        res.status(201).json({ 
            success: true,
            message: 'Subcategoría agregada correctamente',
            subcategoriaId: result.insertId 
        });
    } catch (err) {
        console.error('Error al agregar subcategoría:', err);
        res.status(500).send('Error al ingresar una subcategoría');
    }
});

// ================================
// RUTA PARA OBTENER TODAS LAS SUBCATEGORÍAS
// ================================
router.get('/', async (req, res) => {
    try {
        const [results] = await db.query(
            'SELECT id, category_id, name, description, registration_date FROM subcategorias'
        );
        res.status(200).json(results);
    } catch (err) {
        console.error('Error al obtener subcategorías:', err);
        res.status(500).send('Error al obtener las subcategorías');
    }
});

//Para modal de edicion
// Backend - Obtener subcategorías por categoría
router.get('/by-category/:categoryId', async (req, res) => {
    const { categoryId } = req.params;
    try {
        const [rows] = await db.query(
            'SELECT id, name FROM subcategorias WHERE category_id = ?',
            [categoryId]
        );
        res.json(rows);
    } catch (error) {
        console.error('Error al obtener subcategorías:', error);
        res.status(500).send('Error al obtener subcategorías');
    }
});

module.exports = router;
