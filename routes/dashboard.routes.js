const express = require('express');
const router = express.Router();
const pool = require('../config/db'); // Asegúrate de tener configurada tu conexión a MySQL

// 📊 1. Ventas por día
router.get('/ventas-por-dia', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT DATE(sale_date) AS fecha, SUM(total) AS total 
             FROM ventas GROUP BY fecha ORDER BY fecha DESC LIMIT 7;`
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo ventas por día' });
    }
});

// 📊 2. Productos más vendidos
router.get('/productos-mas-vendidos', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT p.name, SUM(vd.quantity) AS cantidad 
             FROM ventas_detalle vd 
             JOIN productos p ON vd.product_id = p.id 
             GROUP BY p.id ORDER BY cantidad DESC LIMIT 5;`
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo productos más vendidos' });
    }
});

// 📊 3. Clientes que más compran
router.get('/clientes-top', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT c.first_name, c.last_name, SUM(v.total) AS total_compras 
             FROM ventas v 
             JOIN clientes c ON v.customer_id = c.id 
             GROUP BY c.id ORDER BY total_compras DESC LIMIT 5;`
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo los clientes top' });
    }
});

// 📊 4. Ganancias totales
router.get('/ganancias', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT SUM(total) AS ganancias_totales FROM ventas;`
        );
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo ganancias totales' });
    }
});

// 📊 5. Últimas ventas
router.get('/ultimas-ventas', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT v.id, p.name AS producto, vd.subtotal AS precio, v.sale_date AS fecha 
             FROM ventas v 
             JOIN ventas_detalle vd ON v.id = vd.sale_id 
             JOIN productos p ON vd.product_id = p.id 
             ORDER BY v.sale_date DESC LIMIT 5;`
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo las últimas ventas' });
    }
});

module.exports = router;
