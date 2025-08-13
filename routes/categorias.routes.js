const express = require('express');
const router = express.Router();
const db = require('../config/db'); // Conexión con .promise()

// ================================
// RUTA PARA CARGAR CATEGORÍAS
// ================================
router.get('/', async (req, res) => {
    try {
        const [results] = await db.query('SELECT id, name, description FROM categorias');
        res.status(200).json(results);
    } catch (err) {
        console.error('Error al obtener categorías:', err);
        res.status(500).send('Error al obtener categorías');
    }
});

// ================================
// RUTA PARA AGREGAR UNA NUEVA CATEGORÍA
// ================================
router.post('/', async (req, res) => {
    const { categoryname, categorydescription } = req.body;

    try {
        const [result] = await db.query(
            'INSERT INTO categorias (name, description) VALUES (?, ?)',
            [categoryname, categorydescription]
        );
        res.status(201).json({ 
            success: true,
            message: 'Categoría agregada correctamente',
            categoryId: result.insertId 
        });
    } catch (err) {
        console.error('Error al agregar categoría:', err);
        res.status(500).send('Error al agregar la categoría');
    }
});

// ================================
// RUTA PARA OBTENER UNA CATEGORÍA POR ID
// ================================
router.get('/:id', async (req, res) => {
    const categoryId = req.params.id;

    try {
        const [results] = await db.query(
            'SELECT id, name, description FROM categorias WHERE id = ?',
            [categoryId]
        );

        if (results.length === 0) {
            return res.status(404).send('Categoría no encontrada');
        }

        res.status(200).json(results[0]);
    } catch (err) {
        console.error('Error al obtener categoría:', err);
        res.status(500).send('Error al obtener categoría');
    }
});

// ================================
// RUTA PARA ACTUALIZAR CATEGORÍA
// ================================
router.put('/:id', async (req, res) => {
    const categoryId = req.params.id;
    const { name, description } = req.body;

    try {
        await db.query(
            'UPDATE categorias SET name = ?, description = ? WHERE id = ?',
            [name, description, categoryId]
        );

        res.status(200).json({ 
            success: true,
            message: 'Categoría actualizada correctamente' 
        });
    } catch (err) {
        console.error('Error al actualizar categoría:', err);
        res.status(500).send('Error al actualizar categoría');
    }
});

// ================================
// RUTA PARA ELIMINAR CATEGORÍA
// ================================
router.delete('/:id', async (req, res) => {
    const categoryId = req.params.id;

    try {
        await db.query('DELETE FROM categorias WHERE id = ?', [categoryId]);
        res.status(200).json({ 
            success: true,
            message: 'Categoría eliminada correctamente' 
        });
    } catch (err) {
        console.error('Error al eliminar categoría:', err);
        res.status(500).send('Error al eliminar categoría');
    }
});

module.exports = router;
