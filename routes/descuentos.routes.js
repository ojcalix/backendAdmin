const express = require('express');
const router = express.Router();
const db = require('../config/db');

// ========================
// GET /descuentos/tipos
// ========================
router.get('/tipos', async (req, res) => {
    try {
        const [results] = await db.query(
            "SELECT * FROM tipos_descuento ORDER BY name ASC"
        );
        res.json(results);
    } catch (error) {
        console.error('❌ Error al obtener tipos de descuento:', error);
        res.status(500).json({ error: 'Error al obtener tipos de descuento' });
    }
});

// ========================
// POST /descuentos/tipos
// ========================
router.post('/tipos', async (req, res) => {
    const { name, description, max_percentage, requires_authorization } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'El nombre es obligatorio.' });
    }

    try {
        const [result] = await db.query(
            `INSERT INTO tipos_descuento (name, description, max_percentage, requires_authorization) 
             VALUES (?, ?, ?, ?)`,
            [name, description || null, max_percentage || null, !!requires_authorization]
        );
        res.status(201).json({ message: 'Tipo de descuento creado', id: result.insertId });
    } catch (error) {
        console.error('❌ Error al crear tipo de descuento:', error);
        res.status(500).json({ error: 'Error al crear el tipo de descuento' });
    }
});

// ========================
// PUT /descuentos/tipos/:id
// ========================
router.put('/tipos/:id', async (req, res) => {
    const { id } = req.params;
    const { name, description, max_percentage, requires_authorization, status } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'El nombre es obligatorio.' });
    }

    try {
        await db.query(
            `UPDATE tipos_descuento 
             SET name=?, description=?, max_percentage=?, requires_authorization=?, status=? 
             WHERE id=?`,
            [name, description || null, max_percentage || null, !!requires_authorization, status || 'active', id]
        );
        res.json({ message: 'Tipo de descuento actualizado' });
    } catch (error) {
        console.error('❌ Error al actualizar tipo de descuento:', error);
        res.status(500).json({ error: 'Error al actualizar el tipo de descuento' });
    }
});

// ========================
// DELETE /descuentos/tipos/:id
// (Se desactiva en vez de borrar, para no romper el historial de ventas
// que ya referencian este tipo de descuento)
// ========================
router.delete('/tipos/:id', async (req, res) => {
    try {
        await db.query("UPDATE tipos_descuento SET status = 'inactive' WHERE id = ?", [req.params.id]);
        res.json({ message: 'Tipo de descuento desactivado' });
    } catch (error) {
        console.error('❌ Error al desactivar tipo de descuento:', error);
        res.status(500).json({ error: 'Error al desactivar el tipo de descuento' });
    }
});

// ========================
// GET /descuentos/cliente/:customerId
// Devuelve el descuento permanente ACTIVO y vigente de un cliente
// (si tiene varios activos, se usa el de mayor porcentaje).
// ========================
router.get('/cliente/:customerId', async (req, res) => {
    try {
        const { customerId } = req.params;

        const [results] = await db.query(`
            SELECT cd.*, td.name AS discount_type_name, td.requires_authorization
            FROM clientes_descuentos cd
            INNER JOIN tipos_descuento td ON cd.discount_type_id = td.id
            WHERE cd.customer_id = ? 
              AND cd.status = 'active'
              AND (cd.valid_from IS NULL OR cd.valid_from <= CURDATE())
              AND (cd.valid_until IS NULL OR cd.valid_until >= CURDATE())
            ORDER BY cd.percentage DESC
            LIMIT 1
        `, [customerId]);

        res.json(results.length ? results[0] : null);

    } catch (error) {
        console.error('❌ Error al obtener el descuento del cliente:', error);
        res.status(500).json({ error: 'Error al obtener el descuento del cliente' });
    }
});

// ========================
// GET /descuentos/cliente/:customerId/historial
// Todos los descuentos (activos e inactivos) asignados a ese cliente
// ========================
router.get('/cliente/:customerId/historial', async (req, res) => {
    try {
        const { customerId } = req.params;

        const [results] = await db.query(`
            SELECT cd.*, td.name AS discount_type_name, u.username
            FROM clientes_descuentos cd
            INNER JOIN tipos_descuento td ON cd.discount_type_id = td.id
            INNER JOIN usuarios u ON cd.user_id = u.id
            WHERE cd.customer_id = ?
            ORDER BY cd.registration_date DESC
        `, [customerId]);

        res.json(results);

    } catch (error) {
        console.error('❌ Error al obtener el historial de descuentos:', error);
        res.status(500).json({ error: 'Error al obtener el historial de descuentos' });
    }
});

// ========================
// POST /descuentos/cliente
// Asigna un descuento permanente a un cliente
// ========================
router.post('/cliente', async (req, res) => {
    const { customer_id, discount_type_id, percentage, valid_from, valid_until, notes, user_id } = req.body;

    if (!customer_id || !discount_type_id || !percentage || !user_id) {
        return res.status(400).json({ error: 'Cliente, tipo de descuento, porcentaje y usuario son obligatorios.' });
    }

    try {
        const [typeRows] = await db.query('SELECT max_percentage FROM tipos_descuento WHERE id = ?', [discount_type_id]);
        if (!typeRows.length) {
            return res.status(404).json({ error: 'Tipo de descuento no encontrado.' });
        }

        const maxPct = typeRows[0].max_percentage;
        if (maxPct !== null && parseFloat(percentage) > parseFloat(maxPct)) {
            return res.status(400).json({ error: `El porcentaje excede el máximo permitido para este tipo (${maxPct}%).` });
        }

        const [result] = await db.query(
            `INSERT INTO clientes_descuentos (customer_id, discount_type_id, percentage, valid_from, valid_until, notes, user_id) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [customer_id, discount_type_id, percentage, valid_from || null, valid_until || null, notes || null, user_id]
        );

        res.status(201).json({ message: 'Descuento asignado al cliente', id: result.insertId });

    } catch (error) {
        console.error('❌ Error al asignar descuento al cliente:', error);
        res.status(500).json({ error: 'Error al asignar el descuento al cliente' });
    }
});

// ========================
// PUT /descuentos/cliente/:id/estado
// Activar/desactivar un descuento de cliente
// ========================
router.put('/cliente/:id/estado', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'inactive'].includes(status)) {
        return res.status(400).json({ error: 'Estado inválido.' });
    }

    try {
        await db.query('UPDATE clientes_descuentos SET status = ? WHERE id = ?', [status, id]);
        res.json({ message: 'Estado actualizado' });
    } catch (error) {
        console.error('❌ Error al actualizar el estado del descuento:', error);
        res.status(500).json({ error: 'Error al actualizar el estado del descuento' });
    }
});

module.exports = router;