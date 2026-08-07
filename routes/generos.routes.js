const express = require('express');
const router = express.Router();
const db = require('../config/db');

// ================================
// OBTENER GÉNEROS
// ================================
router.get('/', async (req, res) => {

    try {

        const [rows] = await db.query(`
            SELECT id, name
            FROM generos
            ORDER BY id
        `);

        res.json(rows);

    } catch (error) {

        console.error(error);
        res.status(500).json({
            message: 'Error al obtener géneros'
        });

    }

});

module.exports = router;