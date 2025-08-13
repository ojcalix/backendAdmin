const express = require('express');
const router = express.Router();
const db = require('../config/db'); // conexión mysql2/promise

// Ruta para obtener todos los proveedores
router.get('/', async (req, res) => {
    try {
        const query = 'SELECT id, name, address, phone, email, registration_date FROM proveedores';
        const [results] = await db.query(query);
        res.status(200).json(results);
    } catch (err) {
        console.error('Error al cargar proveedores:', err);
        res.status(500).send('Error al cargar proveedores');
    }
});

// Ruta para insertar un proveedor
router.post('/', async (req, res) => {
    try {
        const { name, address, phone, email } = req.body;
        const query = 'INSERT INTO proveedores (name, address, phone, email) VALUES (?, ?, ?, ?)';
        
        const [result] = await db.query(query, [name, address, phone, email]);
        
        res.status(201).json({
            message: 'Proveedor agregado correctamente',
            proveedorId: result.insertId
        });
    } catch (err) {
        console.error('Error al ingresar proveedor:', err);
        res.status(500).send('Error al ingresar proveedor');
    }
});

// Ruta para obtener un proveedor por ID
router.get('/:id', async (req, res) => {
    try {
        const supplierId = req.params.id;
        const query = 'SELECT id, name, address, phone, email FROM proveedores WHERE id = ?';
        
        const [results] = await db.query(query, [supplierId]);
        
        if (results.length === 0) {
            return res.status(404).send('Proveedor no encontrado');
        }
        
        res.status(200).json(results[0]);
    } catch (err) {
        console.error('Error al obtener proveedor:', err);
        res.status(500).send('Error al obtener proveedor');
    }
});

// Ruta para actualizar un proveedor
router.put('/:id', async (req, res) => {
    try {
        const supplierId = req.params.id;
        const { name, address, phone, email } = req.body;
        
        const query = `
            UPDATE proveedores
            SET name = ?, address = ?, phone = ?, email = ?
            WHERE id = ?
        `;
        
        await db.query(query, [name, address, phone, email, supplierId]);
        
        res.status(200).json({
            success: true,
            message: 'Proveedor actualizado correctamente'
        });
    } catch (err) {
        console.error('Error al actualizar proveedor:', err);
        res.status(500).send('Error al actualizar proveedor');
    }
});

// Ruta para eliminar un proveedor
router.delete('/:id', async (req, res) => {
    try {
        const supplierId = req.params.id;
        const query = 'DELETE FROM proveedores WHERE id = ?';
        
        await db.query(query, [supplierId]);
        
        res.status(200).json({
            success: true,
            message: 'Proveedor eliminado correctamente'
        });
    } catch (err) {
        console.error('Error al eliminar proveedor:', err);
        res.status(500).send('Error al eliminar proveedor');
    }
});

module.exports = router;
