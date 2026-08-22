const express = require('express');
const router = express.Router();
const db = require('../config/db');

// ========================
// GET /contabilidad/cuentas
// Lista el plan de cuentas completo
// ========================
router.get('/cuentas', async (req, res) => {
    try {
        const [results] = await db.query(
            "SELECT * FROM cuentas_contables ORDER BY code ASC"
        );
        res.json(results);
    } catch (error) {
        console.error("❌ Error al obtener plan de cuentas:", error);
        res.status(500).json({ error: "Error al obtener el plan de cuentas" });
    }
});

// ========================
// GET /contabilidad/resumen-pasivos
// Total de deuda del negocio, sin importar la fuente:
// proveedores (compras pendientes/parciales) + fuentes de
// financiamiento (tarjetas, propietario, otro) con saldo activo.
// ========================
router.get('/resumen-pasivos', async (req, res) => {
    try {
        const [proveedores] = await db.query(`
            SELECT 
                c.id AS purchase_id,
                p.name AS supplier_name,
                c.purchase_date,
                c.purchase_price,
                c.paid_amount,
                c.pending_amount,
                c.payment_status
            FROM compras c
            INNER JOIN proveedores p ON c.supplier_id = p.id
            WHERE c.payment_status IN ('pending', 'partial')
            ORDER BY c.purchase_date DESC
        `);

        const [financiamiento] = await db.query(`
            SELECT 
                ff.id AS source_id,
                ff.name AS source_name,
                ff.type,
                ff.current_balance,
                ff.credit_limit
            FROM fuentes_financiamiento ff
            WHERE ff.status = 'active' AND ff.current_balance > 0
            ORDER BY ff.current_balance DESC
        `);

        const deuda_proveedores = proveedores.reduce((sum, p) => sum + parseFloat(p.pending_amount), 0);
        const deuda_financiamiento = financiamiento.reduce((sum, f) => sum + parseFloat(f.current_balance), 0);
        const deuda_total = deuda_proveedores + deuda_financiamiento;

        res.json({
            deuda_proveedores,
            deuda_financiamiento,
            deuda_total,
            proveedores,
            financiamiento
        });

    } catch (error) {
        console.error("❌ Error al generar resumen de pasivos:", error);
        res.status(500).json({ error: "Error al generar el resumen de pasivos" });
    }
});

// ========================
// GET /contabilidad/libro-diario
// Lista los asientos contables, con su total (suma de débitos), filtrable
// ========================
router.get('/libro-diario', async (req, res) => {
    const { date_from, date_to, reference_type } = req.query;

    try {
        let query = `
            SELECT 
                ac.id,
                ac.entry_date,
                ac.description,
                ac.reference_type,
                ac.reference_id,
                u.username,
                (SELECT COALESCE(SUM(debit), 0) FROM asientos_detalle WHERE entry_id = ac.id) AS total
            FROM asientos_contables ac
            INNER JOIN usuarios u ON ac.user_id = u.id
            WHERE 1 = 1
        `;

        const params = [];

        if (date_from) {
            query += ` AND DATE(ac.entry_date) >= ?`;
            params.push(date_from);
        }

        if (date_to) {
            query += ` AND DATE(ac.entry_date) <= ?`;
            params.push(date_to);
        }

        if (reference_type) {
            query += ` AND ac.reference_type = ?`;
            params.push(reference_type);
        }

        query += ` ORDER BY ac.entry_date DESC`;

        const [results] = await db.query(query, params);
        res.json(results);

    } catch (error) {
        console.error("❌ Error al obtener libro diario:", error);
        res.status(500).json({ error: "Error al obtener el libro diario" });
    }
});

// ========================
// GET /contabilidad/libro-diario/:id
// Detalle de un asiento específico con sus líneas
// ========================
router.get('/libro-diario/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const [entryResult] = await db.query(
            "SELECT * FROM asientos_contables WHERE id = ?",
            [id]
        );

        if (!entryResult.length) {
            return res.status(404).json({ error: "Asiento no encontrado." });
        }

        const [lines] = await db.query(
            `SELECT 
                ad.debit,
                ad.credit,
                ad.description,
                cc.code AS account_code,
                cc.name AS account_name
             FROM asientos_detalle ad
             INNER JOIN cuentas_contables cc ON ad.account_id = cc.id
             WHERE ad.entry_id = ?
             ORDER BY ad.id ASC`,
            [id]
        );

        res.json({ entry: entryResult[0], lines });

    } catch (error) {
        console.error("❌ Error al obtener detalle del asiento:", error);
        res.status(500).json({ error: "Error al obtener el detalle del asiento" });
    }
});

// ========================
// GET /contabilidad/balance-general?date=YYYY-MM-DD
// ========================
router.get('/balance-general', async (req, res) => {
    const { date } = req.query;

    if (!date) {
        return res.status(400).json({ error: "Debe especificar una fecha." });
    }

    try {
        const [balances] = await db.query(
            `SELECT 
                cc.id, cc.code, cc.name, cc.type, cc.nature,
                COALESCE(SUM(ad.debit), 0) AS total_debit,
                COALESCE(SUM(ad.credit), 0) AS total_credit
             FROM cuentas_contables cc
             LEFT JOIN asientos_detalle ad ON ad.account_id = cc.id
             LEFT JOIN asientos_contables ac ON ac.id = ad.entry_id AND DATE(ac.entry_date) <= ?
             WHERE cc.type IN ('activo', 'pasivo', 'patrimonio')
             GROUP BY cc.id`,
            [date]
        );

        const withBalance = balances.map(a => ({
            ...a,
            balance: a.nature === 'deudora'
                ? parseFloat(a.total_debit) - parseFloat(a.total_credit)
                : parseFloat(a.total_credit) - parseFloat(a.total_debit)
        })).filter(a => Math.abs(a.balance) > 0.001);

        const activo = withBalance.filter(a => a.type === 'activo');
        const pasivo = withBalance.filter(a => a.type === 'pasivo');
        const patrimonio = withBalance.filter(a => a.type === 'patrimonio');

        const total_activo = activo.reduce((sum, a) => sum + a.balance, 0);
        const total_pasivo = pasivo.reduce((sum, a) => sum + a.balance, 0);
        const total_patrimonio_registrado = patrimonio.reduce((sum, a) => sum + a.balance, 0);

        const [resultados] = await db.query(
            `SELECT 
                cc.type,
                COALESCE(SUM(ad.credit), 0) AS total_credit,
                COALESCE(SUM(ad.debit), 0) AS total_debit
             FROM cuentas_contables cc
             LEFT JOIN asientos_detalle ad ON ad.account_id = cc.id
             LEFT JOIN asientos_contables ac ON ac.id = ad.entry_id AND DATE(ac.entry_date) <= ?
             WHERE cc.type IN ('ingreso', 'costo', 'gasto')
             GROUP BY cc.type`,
            [date]
        );

        let ingresos = 0, costos = 0, gastos = 0;
        resultados.forEach(r => {
            if (r.type === 'ingreso') ingresos = parseFloat(r.total_credit) - parseFloat(r.total_debit);
            if (r.type === 'costo') costos = parseFloat(r.total_debit) - parseFloat(r.total_credit);
            if (r.type === 'gasto') gastos = parseFloat(r.total_debit) - parseFloat(r.total_credit);
        });

        const utilidad_acumulada = ingresos - costos - gastos;
        const total_patrimonio = total_patrimonio_registrado + utilidad_acumulada;

        res.json({
            activo, pasivo, patrimonio,
            total_activo, total_pasivo, total_patrimonio,
            utilidad_acumulada
        });

    } catch (error) {
        console.error("❌ Error al generar balance general:", error);
        res.status(500).json({ error: "Error al generar el balance general" });
    }
});

// ========================
// GET /contabilidad/estado-resultados?date_from=X&date_to=Y
// ========================
router.get('/estado-resultados', async (req, res) => {
    const { date_from, date_to } = req.query;

    if (!date_from || !date_to) {
        return res.status(400).json({ error: "Debe especificar el rango de fechas." });
    }

    try {
        const [results] = await db.query(
            `SELECT 
                cc.id, cc.code, cc.name, cc.type, cc.nature,
                COALESCE(SUM(ad.debit), 0) AS total_debit,
                COALESCE(SUM(ad.credit), 0) AS total_credit
             FROM cuentas_contables cc
             LEFT JOIN asientos_detalle ad ON ad.account_id = cc.id
             LEFT JOIN asientos_contables ac ON ac.id = ad.entry_id 
                AND DATE(ac.entry_date) BETWEEN ? AND ?
             WHERE cc.type IN ('ingreso', 'costo', 'gasto')
             GROUP BY cc.id`,
            [date_from, date_to]
        );

        const withBalance = results.map(a => ({
            ...a,
            balance: a.nature === 'deudora'
                ? parseFloat(a.total_debit) - parseFloat(a.total_credit)
                : parseFloat(a.total_credit) - parseFloat(a.total_debit)
        })).filter(a => Math.abs(a.balance) > 0.001);

        const ingresos = withBalance.filter(a => a.type === 'ingreso');
        const costos = withBalance.filter(a => a.type === 'costo');
        const gastos = withBalance.filter(a => a.type === 'gasto');

        const total_ingresos = ingresos.reduce((sum, a) => sum + a.balance, 0);
        const total_costos = costos.reduce((sum, a) => sum + a.balance, 0);
        const total_gastos = gastos.reduce((sum, a) => sum + a.balance, 0);

        const utilidad_bruta = total_ingresos - total_costos;
        const utilidad_neta = utilidad_bruta - total_gastos;

        res.json({
            ingresos, costos, gastos,
            total_ingresos, total_costos, total_gastos,
            utilidad_bruta, utilidad_neta
        });

    } catch (error) {
        console.error("❌ Error al generar estado de resultados:", error);
        res.status(500).json({ error: "Error al generar el estado de resultados" });
    }
});

module.exports = router;