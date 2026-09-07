const express = require('express');
const router = express.Router();
const db = require('../config/db');

// ========================
// GET /proveedores
// ========================
router.get('/', async (req, res) => {
    try {
        const [results] = await db.query(
            `SELECT id, name, contact_name, address, city, state, country, 
                    phone, phone_secondary, email, notes, registration_date 
             FROM proveedores
             ORDER BY name ASC`
        );
        res.status(200).json(results);
    } catch (err) {
        console.error('Error al cargar proveedores:', err);
        res.status(500).send('Error al cargar proveedores');
    }
});

// ========================
// POST /proveedores
// ========================
router.post('/', async (req, res) => {
    const {
        name, contact_name, address, city, state, country,
        phone, phone_secondary, email, notes
    } = req.body;

    if (!name || !phone) {
        return res.status(400).json({ error: 'Nombre y teléfono son obligatorios.' });
    }

    try {
        const [result] = await db.query(
            `INSERT INTO proveedores 
                (name, contact_name, address, city, state, country, phone, phone_secondary, email, notes) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                name,
                contact_name || null,
                address || null,
                city || null,
                state || null,
                country || 'Honduras',
                phone,
                phone_secondary || null,
                email || null,
                notes || null
            ]
        );

        res.status(201).json({
            message: 'Proveedor agregado correctamente',
            proveedorId: result.insertId
        });
    } catch (err) {
        console.error('Error al ingresar proveedor:', err);
        res.status(500).send('Error al ingresar proveedor');
    }
});

// ========================
// GET /proveedores/:id
// ========================
router.get('/:id', async (req, res) => {
    const supplierId = req.params.id;

    try {
        const [results] = await db.query(
            `SELECT id, name, contact_name, address, city, state, country, 
                    phone, phone_secondary, email, notes 
             FROM proveedores WHERE id = ?`,
            [supplierId]
        );

        if (results.length === 0) {
            return res.status(404).send('Proveedor no encontrado');
        }

        res.status(200).json(results[0]);
    } catch (err) {
        console.error('Error al obtener proveedor:', err);
        res.status(500).send('Error al obtener proveedor');
    }
});

// ========================
// PUT /proveedores/:id
// ========================
router.put('/:id', async (req, res) => {
    const supplierId = req.params.id;
    const {
        name, contact_name, address, city, state, country,
        phone, phone_secondary, email, notes
    } = req.body;

    if (!name || !phone) {
        return res.status(400).json({ error: 'Nombre y teléfono son obligatorios.' });
    }

    try {
        await db.query(
            `UPDATE proveedores
             SET name = ?, contact_name = ?, address = ?, city = ?, state = ?, 
                 country = ?, phone = ?, phone_secondary = ?, email = ?, notes = ?
             WHERE id = ?`,
            [
                name,
                contact_name || null,
                address || null,
                city || null,
                state || null,
                country || 'Honduras',
                phone,
                phone_secondary || null,
                email || null,
                notes || null,
                supplierId
            ]
        );

        res.status(200).json({
            success: true,
            message: 'Proveedor actualizado correctamente'
        });
    } catch (err) {
        console.error('Error al actualizar proveedor:', err);
        res.status(500).send('Error al actualizar proveedor');
    }
});

// ========================
// DELETE /proveedores/:id
// ========================
router.delete('/:id', async (req, res) => {
    const supplierId = req.params.id;

    try {
        await db.query('DELETE FROM proveedores WHERE id = ?', [supplierId]);

        res.status(200).json({
            success: true,
            message: 'Proveedor eliminado correctamente'
        });
    } catch (err) {
        console.error('Error al eliminar proveedor:', err);

        if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
            return res.status(400).json({
                error: 'No se puede eliminar este proveedor porque tiene compras o precios asociados.'
            });
        }

        res.status(500).send('Error al eliminar proveedor');
    }
});

module.exports = router;