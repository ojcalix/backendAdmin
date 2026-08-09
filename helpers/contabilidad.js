const db = require('../config/db');

// Cache simple de cuentas por código, para no consultar la BD en cada asiento
let cuentasCache = null;

async function getCuentaId(code) {
    if (!cuentasCache) {
        const [rows] = await db.query("SELECT id, code FROM cuentas_contables");
        cuentasCache = {};
        rows.forEach(r => cuentasCache[r.code] = r.id);
    }
    if (!cuentasCache[code]) {
        throw new Error(`Cuenta contable con código ${code} no encontrada.`);
    }
    return cuentasCache[code];
}

/**
 * Crea un asiento contable con sus líneas.
 * @param {object} connection - conexión/transacción activa (db)
 * @param {object} params
 * @param {string} params.description
 * @param {string} params.reference_type
 * @param {number} params.reference_id
 * @param {number} params.user_id
 * @param {Array<{code: string, debit?: number, credit?: number}>} params.lines
 */
async function crearAsiento(connection, { description, reference_type, reference_id, user_id, lines }) {
    // ✅ Validar que cuadre (debe = haber)
    const totalDebit = lines.reduce((sum, l) => sum + (l.debit || 0), 0);
    const totalCredit = lines.reduce((sum, l) => sum + (l.credit || 0), 0);

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
        throw new Error(`Asiento descuadrado: debe ${totalDebit} vs haber ${totalCredit}`);
    }

    const [entryResult] = await connection.query(
        `INSERT INTO asientos_contables (description, reference_type, reference_id, user_id) 
         VALUES (?, ?, ?, ?)`,
        [description, reference_type, reference_id, user_id]
    );
    const entry_id = entryResult.insertId;

    for (const line of lines) {
        if (!line.debit && !line.credit) continue; // ignora líneas en 0

        const account_id = await getCuentaId(line.code);

        await connection.query(
            `INSERT INTO asientos_detalle (entry_id, account_id, debit, credit, description) 
             VALUES (?, ?, ?, ?, ?)`,
            [entry_id, account_id, line.debit || 0, line.credit || 0, line.description || null]
        );
    }

    return entry_id;
}

module.exports = { crearAsiento, getCuentaId };