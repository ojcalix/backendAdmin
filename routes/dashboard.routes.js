const express = require('express');
const router = express.Router();
const pool = require('../config/db'); // Asegúrate de tener configurada tu conexión a MySQL

// ========================
// GET /dashboard/ventas-hoy
// Total vendido y cantidad de ventas del día actual
// ========================
router.get('/ventas-hoy', async (req, res) => {
    try {
        const [results] = await pool.query(
            `SELECT 
                COALESCE(SUM(total), 0) AS total,
                COUNT(*) AS count
             FROM ventas
             WHERE DATE(sale_date) = CURDATE()`
        );

        res.json({
            total: results[0].total,
            count: results[0].count
        });

    } catch (error) {
        console.error('❌ Error al obtener ventas de hoy:', error);
        res.status(500).json({ error: 'Error al obtener ventas de hoy' });
    }
});

// ========================
// GET /dashboard/cuentas-pendientes
// Totales de cuentas por cobrar y por pagar (pending/partial)
// ========================
router.get('/cuentas-pendientes', async (req, res) => {
    try {
        const [receivables] = await pool.query(
            `SELECT 
                COALESCE(SUM(pending_amount), 0) AS total,
                COUNT(*) AS count
             FROM ventas
             WHERE payment_status IN ('pending', 'partial')`
        );

        const [payables] = await pool.query(
            `SELECT 
                COALESCE(SUM(pending_amount), 0) AS total,
                COUNT(*) AS count
             FROM compras
             WHERE payment_status IN ('pending', 'partial')`
        );

        res.json({
            receivables_total: receivables[0].total,
            receivables_count: receivables[0].count,
            payables_total: payables[0].total,
            payables_count: payables[0].count
        });

    } catch (error) {
        console.error('❌ Error al obtener cuentas pendientes:', error);
        res.status(500).json({ error: 'Error al obtener cuentas pendientes' });
    }
});

// ========================
// GET /dashboard/stock-bajo?threshold=5
// Productos con cantidad igual o menor al umbral
// ========================
router.get('/stock-bajo', async (req, res) => {
    const threshold = parseInt(req.query.threshold) || 5;

    try {
        const [results] = await pool.query(
            `SELECT id, name, quantity
             FROM productos
             WHERE status = 'active' AND quantity <= ?
             ORDER BY quantity ASC`,
            [threshold]
        );

        res.json(results);

    } catch (error) {
        console.error('❌ Error al obtener stock bajo:', error);
        res.status(500).json({ error: 'Error al obtener stock bajo' });
    }
});

// ========================
// GET /dashboard/top-productos?limit=5
// Productos más vendidos del mes actual, por cantidad
// ========================
router.get('/top-productos', async (req, res) => {
    const limit = parseInt(req.query.limit) || 5;

    try {
        const [results] = await pool.query(
            `SELECT 
                p.name AS product_name,
                SUM(vd.quantity) AS total_quantity,
                SUM(vd.subtotal) AS total_amount
             FROM ventas_detalle vd
             INNER JOIN ventas v ON vd.sale_id = v.id
             INNER JOIN productos p ON vd.product_id = p.id
             WHERE MONTH(v.sale_date) = MONTH(CURDATE())
               AND YEAR(v.sale_date) = YEAR(CURDATE())
             GROUP BY vd.product_id, p.name
             ORDER BY total_quantity DESC
             LIMIT ?`,
            [limit]
        );

        res.json(results);

    } catch (error) {
        console.error('❌ Error al obtener productos más vendidos:', error);
        res.status(500).json({ error: 'Error al obtener productos más vendidos' });
    }
});

module.exports = router;