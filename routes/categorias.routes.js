const express = require('express');
const router = express.Router();
const db = require('../config/db');

// ================================
// GET TODAS LAS CATEGORÍAS
// ================================
router.get('/', async (req, res) => {
    try {
        const [results] = await db.query(
            'SELECT id, name, description, parent_id FROM categorias'
        );
        res.json(results);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al obtener categorías');
    }
});

// ================================
// CREAR CATEGORÍA
// ================================
router.post('/', async (req, res) => {
    const { categoryname, categorydescription, parent_id } = req.body;

    if (!categoryname) {
        return res.status(400).json({ error: 'El nombre de la categoría es obligatorio.' });
    }

    try {
        const [result] = await db.query(
            `INSERT INTO categorias (name, description, parent_id) VALUES (?, ?, ?)`,
            [categoryname, categorydescription, parent_id || null]
        );

        const [verify] = await db.query(
            'SELECT * FROM categorias WHERE id = ?',
            [result.insertId]
        );

        res.status(201).json({
            success: true,
            data: verify
        });

    } catch (err) {
        console.error(err);
        res.status(500).send(err);
    }
});

// ================================
// GET POR ID
// ================================
router.get('/:id', async (req, res) => {
    const id = req.params.id;

    try {
        const [results] = await db.query(
            `SELECT id, name, description, parent_id FROM categorias WHERE id = ?`,
            [id]
        );

        if (results.length === 0) {
            return res.status(404).send('Categoría no encontrada');
        }

        res.json(results[0]);

    } catch (err) {
        console.error(err);
        res.status(500).send('Error al obtener categoría');
    }
});

// ================================
// ACTUALIZAR
// ================================
router.put('/:id', async (req, res) => {
    const id = req.params.id;
    const { name, description, parent_id } = req.body;

    try {
        // ❌ evitar que sea su propio padre
        if (parent_id && parent_id == id) {
            return res.status(400).json({
                error: 'Una categoría no puede ser su propio padre'
            });
        }

        // validar que el padre exista
        if (parent_id) {
            const [parent] = await db.query(
                'SELECT id FROM categorias WHERE id = ?',
                [parent_id]
            );

            if (parent.length === 0) {
                return res.status(400).json({
                    error: 'Categoría padre no válida'
                });
            }
        }

        await db.query(
            `UPDATE categorias
     SET
        name = ?,
        description = ?,
        parent_id = ?
     WHERE id = ?`,
            [
                name,
                description,
                parent_id || null,
                id
            ]
        );

        res.json({
            success: true,
            message: 'Categoría actualizada'
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Error al actualizar categoría');
    }
});

// ================================
// ELIMINAR
// ================================
router.delete('/:id', async (req, res) => {
    const id = req.params.id;

    try {
        await db.query('DELETE FROM categorias WHERE id = ?', [id]);

        res.json({
            success: true,
            message: 'Categoría eliminada'
        });

    } catch (err) {
        // ✅ Detectar si el error es por productos o subcategorías dependientes
        if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
            return res.status(400).json({
                error: 'No se puede eliminar esta categoría porque tiene productos o subcategorías asociadas.'
            });
        }

        console.error(err);
        res.status(500).send('Error al eliminar categoría');
    }
});

module.exports = router;