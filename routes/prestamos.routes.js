const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { crearAsiento } = require('../helpers/contabilidad');

// ========================
// Genera la tabla de amortización con cuota fija. Si hay cargos
// "primera_cuota", se suman SOLO al monto de la cuota #1 (charges_portion),
// dejando el resto de cuotas iguales.
// ========================
function generarCuotas(principal, interestRateAnual, termMonths, monthlyPayment, disbursementDate, firstInstallmentCharges = 0) {
    const monthlyRate = interestRateAnual / 100 / 12;
    let saldo = principal;
    const cuotas = [];

    for (let i = 1; i <= termMonths; i++) {
        const dueDate = new Date(disbursementDate);
        dueDate.setMonth(dueDate.getMonth() + i);

        let interestPortion = parseFloat((saldo * monthlyRate).toFixed(2));
        let principalPortion = parseFloat((monthlyPayment - interestPortion).toFixed(2));
        let amount = monthlyPayment;

        const esUltima = i === termMonths || principalPortion >= saldo;

        if (esUltima) {
            principalPortion = parseFloat(saldo.toFixed(2));
            amount = monthlyPayment;
            interestPortion = parseFloat((amount - principalPortion).toFixed(2));
            saldo = 0;
        } else {
            saldo = parseFloat((saldo - principalPortion).toFixed(2));
        }

        const chargesPortion = i === 1 ? parseFloat((firstInstallmentCharges || 0).toFixed(2)) : 0;
        if (chargesPortion > 0) amount = parseFloat((amount + chargesPortion).toFixed(2));

        cuotas.push({
            number: i,
            due_date: dueDate.toISOString().split('T')[0],
            amount,
            interest_portion: interestPortion,
            principal_portion: principalPortion,
            charges_portion: chargesPortion
        });

        if (saldo <= 0) break;
    }

    return cuotas;
}

// ========================
// Resuelve contra qué cuenta contable/fuente vive la deuda de un
// préstamo: "Préstamos por Pagar" (2105) para préstamos tradicionales,
// o la cuenta de la tarjeta/fuente vinculada para extrafinanciamientos.
// ========================
async function resolveDebtAccount(connection, prestamo) {
    if (prestamo.loan_type === 'extrafinanciamiento' && prestamo.linked_financing_source_id) {
        const [rows] = await connection.query(`
            SELECT ff.id, ff.name, ff.current_balance, ff.credit_limit, cc.code AS account_code
            FROM fuentes_financiamiento ff
            INNER JOIN cuentas_contables cc ON ff.account_id = cc.id
            WHERE ff.id = ? FOR UPDATE
        `, [prestamo.linked_financing_source_id]);

        if (!rows.length) throw new Error('Fuente de financiamiento vinculada no encontrada.');

        return { code: rows[0].account_code, isExtrafinanciamiento: true, source: rows[0] };
    }

    return { code: '2105', isExtrafinanciamiento: false, source: null };
}

// ========================
// GET /prestamos/fuentes-financiamiento
// Fuentes activas disponibles para vincular un extrafinanciamiento
// ========================
router.get('/fuentes-financiamiento', async (req, res) => {
    try {
        const [results] = await db.query(
            `SELECT id, name, type, current_balance, credit_limit 
             FROM fuentes_financiamiento 
             WHERE status = 'active' 
             ORDER BY name ASC`
        );
        res.json(results);
    } catch (err) {
        console.error('Error al obtener fuentes de financiamiento:', err);
        res.status(500).json({ error: 'Error al obtener fuentes de financiamiento' });
    }
});

// ========================
// GET /prestamos
// ========================
router.get('/', async (req, res) => {
    try {
        const [results] = await db.query(`
            SELECT p.*, 
                ff.name AS linked_financing_source_name,
                (SELECT COUNT(*) FROM cuotas_prestamo WHERE prestamo_id = p.id AND status != 'paid') AS pending_installments,
                (SELECT COALESCE(SUM(amount - paid_amount), 0) FROM cuotas_prestamo WHERE prestamo_id = p.id) AS balance,
                (SELECT COUNT(*) FROM cuotas_prestamo WHERE prestamo_id = p.id AND paid_amount > 0) AS payments_made
            FROM prestamos p
            LEFT JOIN fuentes_financiamiento ff ON p.linked_financing_source_id = ff.id
            ORDER BY p.registration_date DESC
        `);
        res.json(results);
    } catch (error) {
        console.error("❌ Error al obtener préstamos:", error);
        res.status(500).json({ error: "Error al obtener los préstamos" });
    }
});

// ========================
// GET /prestamos/:id
// ========================
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const [prestamo] = await db.query(`
            SELECT p.*, ff.name AS linked_financing_source_name
            FROM prestamos p
            LEFT JOIN fuentes_financiamiento ff ON p.linked_financing_source_id = ff.id
            WHERE p.id = ?
        `, [id]);
        if (!prestamo.length) return res.status(404).json({ error: 'Préstamo no encontrado' });

        const [cargos] = await db.query('SELECT * FROM cargos_prestamo WHERE prestamo_id = ?', [id]);
        const [cuotas] = await db.query('SELECT * FROM cuotas_prestamo WHERE prestamo_id = ? ORDER BY number ASC', [id]);
        const [abonos] = await db.query('SELECT * FROM abonos_capital_prestamo WHERE prestamo_id = ? ORDER BY payment_date DESC', [id]);

        const [paymentCheck] = await db.query(
            `SELECT COUNT(*) AS count FROM cuotas_prestamo WHERE prestamo_id = ? AND paid_amount > 0`,
            [id]
        );

        res.json({ prestamo: prestamo[0], cargos, cuotas, abonos, has_payments: paymentCheck[0].count > 0 });

    } catch (error) {
        console.error("❌ Error al obtener el préstamo:", error);
        res.status(500).json({ error: "Error al obtener el préstamo" });
    }
});

// ========================
// POST /prestamos
// Soporta:
// - loan_type: 'prestamo' (deuda va a 2105) o 'extrafinanciamiento'
//   (deuda va contra la fuente/tarjeta vinculada, linked_financing_source_id)
// - Comisión/cargos con 3 formas de cobro:
//     descontada  → reduce lo depositado
//     aparte      → se paga ahora, por separado, con su propia fuente
//     primera_cuota → NO se cobra ahora; se suma al monto de la cuota #1
// ========================
router.post('/', async (req, res) => {
    const {
        lender_name, loan_type, linked_financing_source_id,
        principal_amount, interest_rate, term_months, monthly_payment,
        commission_type, commission_amount, disbursement_method, bank_id,
        disbursement_date, user_id, notes, cargos,
        aparte_payment_method, aparte_bank_id
    } = req.body;

    if (!lender_name || !principal_amount || !interest_rate || !term_months || !monthly_payment || !disbursement_date || !user_id) {
        return res.status(400).json({ error: "Faltan datos obligatorios del préstamo." });
    }

    const normalizedLoanType = loan_type === 'extrafinanciamiento' ? 'extrafinanciamiento' : 'prestamo';

    if (normalizedLoanType === 'extrafinanciamiento' && !linked_financing_source_id) {
        return res.status(400).json({ error: "Debe seleccionar la tarjeta/fuente de financiamiento del extrafinanciamiento." });
    }

    const validCommissionTypes = ['descontada', 'aparte', 'primera_cuota', 'ninguna'];
    if (!validCommissionTypes.includes(commission_type)) {
        return res.status(400).json({ error: "Tipo de comisión inválido." });
    }

    if (disbursement_method === 'bank' && !bank_id) {
        return res.status(400).json({ error: "Debe seleccionar una cuenta bancaria." });
    }

    const cargosList = Array.isArray(cargos) ? cargos : [];
    const commissionAmt = commission_type !== 'ninguna' ? (parseFloat(commission_amount) || 0) : 0;

    const commissionDescontada = commission_type === 'descontada' ? commissionAmt : 0;
    const commissionAparte = commission_type === 'aparte' ? commissionAmt : 0;
    const commissionPrimeraCuota = commission_type === 'primera_cuota' ? commissionAmt : 0;

    const cargosDescontados = cargosList.filter(c => (c.charge_type || 'descontado') === 'descontado');
    const cargosAparte = cargosList.filter(c => c.charge_type === 'aparte');
    const cargosPrimeraCuota = cargosList.filter(c => c.charge_type === 'primera_cuota');

    const totalDescontado = commissionDescontada + cargosDescontados.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
    const totalAparte = commissionAparte + cargosAparte.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
    const totalPrimeraCuota = commissionPrimeraCuota + cargosPrimeraCuota.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);

    const netReceived = parseFloat(principal_amount) - totalDescontado;

    if (netReceived < 0) {
        return res.status(400).json({ error: "Los cargos descontados no pueden ser mayores al monto del préstamo." });
    }

    if (totalAparte > 0) {
        if (!aparte_payment_method) {
            return res.status(400).json({ error: "Debe indicar cómo pagará los cargos que van aparte." });
        }
        if ((aparte_payment_method === 'transfer' || aparte_payment_method === 'card') && !aparte_bank_id) {
            return res.status(400).json({ error: "Debe seleccionar una cuenta bancaria para pagar los cargos aparte." });
        }
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // ---- Fondos del DESEMBOLSO ----
        let cajaAbierta = null;
        let bankAccount = null;

        if (disbursement_method === 'cash') {
            const [cajaResult] = await connection.query(
                "SELECT id FROM cajas WHERE user_id = ? AND status = 'open' LIMIT 1",
                [user_id]
            );
            if (!cajaResult.length) {
                await connection.rollback();
                return res.status(400).json({ error: "Debes abrir tu caja para recibir el desembolso en efectivo." });
            }
            cajaAbierta = cajaResult[0];
        } else {
            const [bankResult] = await connection.query(
                "SELECT id, current_balance FROM bancos WHERE id = ? AND status = 'active' FOR UPDATE",
                [bank_id]
            );
            if (!bankResult.length) {
                await connection.rollback();
                return res.status(404).json({ error: "Cuenta bancaria no encontrada o inactiva." });
            }
            bankAccount = bankResult[0];
        }

        // ---- Fondos para pagar cargos "aparte" ----
        let aparteCajaAbierta = null;
        let aparteBankAccount = null;

        if (totalAparte > 0) {
            if (aparte_payment_method === 'cash') {
                const [cajaResult] = await connection.query(
                    "SELECT id, opening_amount FROM cajas WHERE user_id = ? AND status = 'open' LIMIT 1 FOR UPDATE",
                    [user_id]
                );
                if (!cajaResult.length) {
                    await connection.rollback();
                    return res.status(400).json({ error: "Debes abrir tu caja para pagar los cargos aparte en efectivo." });
                }
                aparteCajaAbierta = cajaResult[0];

                const [movResult] = await connection.query(
                    `SELECT 
                        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
                        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense
                     FROM movimientos_caja WHERE caja_id = ?`,
                    [aparteCajaAbierta.id]
                );
                const availableCash = parseFloat(aparteCajaAbierta.opening_amount)
                    + parseFloat(movResult[0].total_income)
                    - parseFloat(movResult[0].total_expense);

                if (totalAparte > availableCash) {
                    await connection.rollback();
                    return res.status(400).json({ error: `Saldo insuficiente en caja para pagar los cargos aparte. Disponible: L. ${availableCash.toFixed(2)}` });
                }
            } else if (aparte_payment_method === 'transfer' || aparte_payment_method === 'card') {
                const [bankResult] = await connection.query(
                    "SELECT id, current_balance FROM bancos WHERE id = ? AND status = 'active' FOR UPDATE",
                    [aparte_bank_id]
                );
                if (!bankResult.length) {
                    await connection.rollback();
                    return res.status(404).json({ error: "Cuenta bancaria (cargos aparte) no encontrada o inactiva." });
                }
                aparteBankAccount = bankResult[0];

                if (totalAparte > parseFloat(aparteBankAccount.current_balance)) {
                    await connection.rollback();
                    return res.status(400).json({ error: `Saldo insuficiente en el banco para pagar los cargos aparte. Disponible: L. ${parseFloat(aparteBankAccount.current_balance).toFixed(2)}` });
                }
            }
        }

        // ---- Resolver la cuenta/fuente donde vive la deuda ----
        const debtAccount = await resolveDebtAccount(connection, {
            loan_type: normalizedLoanType,
            linked_financing_source_id: linked_financing_source_id || null
        });

        const debtIncrease = parseFloat(principal_amount) + totalPrimeraCuota;

        if (debtAccount.isExtrafinanciamiento && debtAccount.source.credit_limit !== null) {
            const nuevoSaldo = parseFloat(debtAccount.source.current_balance) + debtIncrease;
            if (nuevoSaldo > parseFloat(debtAccount.source.credit_limit)) {
                await connection.rollback();
                return res.status(400).json({
                    error: `Esta operación excede el límite de crédito de "${debtAccount.source.name}".`
                });
            }
        }

        const [prestamoResult] = await connection.query(
            `INSERT INTO prestamos 
                (lender_name, loan_type, linked_financing_source_id, principal_amount, interest_rate, term_months, monthly_payment, 
                 commission_type, commission_amount, disbursement_method, bank_id, disbursement_date, user_id, notes) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [lender_name, normalizedLoanType, linked_financing_source_id || null, principal_amount, interest_rate, term_months, monthly_payment,
                commission_type, commissionAmt, disbursement_method, bank_id || null, disbursement_date, user_id, notes || null]
        );

        const prestamoId = prestamoResult.insertId;

        for (const cargo of cargosList) {
            await connection.query(
                `INSERT INTO cargos_prestamo (prestamo_id, concept, amount, charge_type) VALUES (?, ?, ?, ?)`,
                [prestamoId, cargo.concept, cargo.amount, cargo.charge_type || 'descontado']
            );
        }

        const cuotas = generarCuotas(
            parseFloat(principal_amount), parseFloat(interest_rate), parseInt(term_months),
            parseFloat(monthly_payment), disbursement_date, totalPrimeraCuota
        );

        for (const cuota of cuotas) {
            await connection.query(
                `INSERT INTO cuotas_prestamo (prestamo_id, number, due_date, amount, interest_portion, principal_portion, charges_portion) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [prestamoId, cuota.number, cuota.due_date, cuota.amount, cuota.interest_portion, cuota.principal_portion, cuota.charges_portion]
            );
        }

        // ---- Movimiento del DESEMBOLSO (siempre entra caja/banco, sin importar el tipo) ----
        if (cajaAbierta) {
            await connection.query(
                `INSERT INTO movimientos_caja (caja_id, type, concept, amount, reference_type, reference_id) 
                 VALUES (?, 'income', ?, ?, 'otro', ?)`,
                [cajaAbierta.id, `Desembolso ${normalizedLoanType === 'extrafinanciamiento' ? 'extrafinanciamiento' : 'préstamo'}: ${lender_name}`, netReceived, prestamoId]
            );
        }

        if (bankAccount) {
            await connection.query(
                `INSERT INTO movimientos_bancarios (bank_id, type, amount, concept, reference_type, reference_id) 
                 VALUES (?, 'deposit', ?, ?, 'otro', ?)`,
                [bank_id, netReceived, `Desembolso ${normalizedLoanType === 'extrafinanciamiento' ? 'extrafinanciamiento' : 'préstamo'}: ${lender_name}`, prestamoId]
            );
            await connection.query(
                "UPDATE bancos SET current_balance = current_balance + ? WHERE id = ?",
                [netReceived, bank_id]
            );
        }

        // ---- Si es extrafinanciamiento, la deuda también sube el saldo de la tarjeta ----
        if (debtAccount.isExtrafinanciamiento) {
            await connection.query(
                "UPDATE fuentes_financiamiento SET current_balance = current_balance + ? WHERE id = ?",
                [debtIncrease, linked_financing_source_id]
            );

            await connection.query(
                `INSERT INTO movimientos_financiamiento (financing_source_id, type, amount, concept, reference_type, reference_id) 
                 VALUES (?, 'charge', ?, ?, 'ajuste', ?)`,
                [linked_financing_source_id, debtIncrease, `Extrafinanciamiento otorgado: ${lender_name}`, prestamoId]
            );
        }

        // ---- Asiento principal: dinero recibido + deuda generada ----
        const cuentaDinero = disbursement_method === 'cash' ? '1101' : '1102';
        const lines = [{ code: cuentaDinero, debit: netReceived }];

        if (totalDescontado > 0) {
            lines.push({ code: '6104', debit: totalDescontado });
        }
        if (totalPrimeraCuota > 0) {
            lines.push({ code: '6104', debit: totalPrimeraCuota, description: 'Cargos incluidos en la primera cuota' });
        }

        lines.push({ code: debtAccount.code, credit: debtIncrease });

        await crearAsiento(connection, {
            description: `${normalizedLoanType === 'extrafinanciamiento' ? 'Extrafinanciamiento' : 'Préstamo'} recibido de ${lender_name}`,
            reference_type: 'ajuste',
            reference_id: prestamoId,
            user_id,
            lines
        });

        // ---- Pago INMEDIATO de los cargos "aparte" ----
        if (totalAparte > 0) {
            const concept = `Pago de cargos aparte - ${lender_name}`;

            if (aparteCajaAbierta) {
                await connection.query(
                    `INSERT INTO movimientos_caja (caja_id, type, concept, amount, reference_type, reference_id) 
                     VALUES (?, 'expense', ?, ?, 'otro', ?)`,
                    [aparteCajaAbierta.id, concept, totalAparte, prestamoId]
                );
            }

            if (aparteBankAccount) {
                await connection.query(
                    `INSERT INTO movimientos_bancarios (bank_id, type, amount, concept, reference_type, reference_id) 
                     VALUES (?, 'transfer_out', ?, ?, 'otro', ?)`,
                    [aparte_bank_id, totalAparte, concept, prestamoId]
                );
                await connection.query(
                    "UPDATE bancos SET current_balance = current_balance - ? WHERE id = ?",
                    [totalAparte, aparte_bank_id]
                );
            }

            const cuentaOrigenAparte = aparte_payment_method === 'cash' ? '1101' : '1102';

            await crearAsiento(connection, {
                description: concept,
                reference_type: 'ajuste',
                reference_id: prestamoId,
                user_id,
                lines: [
                    { code: '6104', debit: totalAparte },
                    { code: cuentaOrigenAparte, credit: totalAparte }
                ]
            });
        }

        await connection.commit();
        res.json({
            message: `${normalizedLoanType === 'extrafinanciamiento' ? 'Extrafinanciamiento' : 'Préstamo'} registrado con éxito`,
            prestamo_id: prestamoId,
            net_received: netReceived,
            total_aparte_pagado: totalAparte,
            total_primera_cuota: totalPrimeraCuota
        });

    } catch (error) {
        await connection.rollback();
        console.error("❌ Error al registrar el préstamo:", error);
        res.status(500).json({ error: error.message || "Error al registrar el préstamo" });
    } finally {
        connection.release();
    }
});

// ========================
// PUT /prestamos/:id
// (loan_type y linked_financing_source_id NO se editan aquí — se fijan
// al crear el préstamo, ya que cambiarlos después movería deuda entre
// cuentas contables distintas de forma retroactiva)
// ========================
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { lender_name, notes, disbursement_date, interest_rate, monthly_payment, term_months } = req.body;

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [prestamoRows] = await connection.query('SELECT * FROM prestamos WHERE id = ? FOR UPDATE', [id]);
        if (!prestamoRows.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Préstamo no encontrado' });
        }
        const prestamo = prestamoRows[0];

        const [paymentCheck] = await connection.query(
            `SELECT COUNT(*) AS count FROM cuotas_prestamo WHERE prestamo_id = ? AND paid_amount > 0`,
            [id]
        );
        const hasPayments = paymentCheck[0].count > 0;

        const wantsFinancialChange =
            (interest_rate !== undefined && parseFloat(interest_rate) !== parseFloat(prestamo.interest_rate)) ||
            (monthly_payment !== undefined && parseFloat(monthly_payment) !== parseFloat(prestamo.monthly_payment)) ||
            (term_months !== undefined && parseInt(term_months) !== parseInt(prestamo.term_months));

        if (wantsFinancialChange && hasPayments) {
            await connection.rollback();
            return res.status(400).json({
                error: 'No se pueden modificar tasa, cuota o plazo porque ya existen pagos registrados. Si necesitas reducir la deuda, usa "Abono a Capital".'
            });
        }

        const newLenderName = lender_name !== undefined ? lender_name : prestamo.lender_name;
        const newNotes = notes !== undefined ? notes : prestamo.notes;
        const newDisbursementDate = disbursement_date !== undefined ? disbursement_date : prestamo.disbursement_date;
        const newInterestRate = interest_rate !== undefined ? parseFloat(interest_rate) : parseFloat(prestamo.interest_rate);
        const newMonthlyPayment = monthly_payment !== undefined ? parseFloat(monthly_payment) : parseFloat(prestamo.monthly_payment);
        const newTermMonths = term_months !== undefined ? parseInt(term_months) : parseInt(prestamo.term_months);

        await connection.query(
            `UPDATE prestamos SET lender_name=?, notes=?, disbursement_date=?, interest_rate=?, monthly_payment=?, term_months=? WHERE id=?`,
            [newLenderName, newNotes, newDisbursementDate, newInterestRate, newMonthlyPayment, newTermMonths, id]
        );

        if (wantsFinancialChange && !hasPayments) {
            // Conserva los cargos "primera_cuota" que ya existían al regenerar
            const [cargosPrimeraCuota] = await connection.query(
                `SELECT COALESCE(SUM(amount), 0) AS total FROM cargos_prestamo WHERE prestamo_id = ? AND charge_type = 'primera_cuota'`,
                [id]
            );
            const totalPrimeraCuota = parseFloat(cargosPrimeraCuota[0].total) || 0;

            await connection.query(`DELETE FROM cuotas_prestamo WHERE prestamo_id = ?`, [id]);

            const cuotas = generarCuotas(
                parseFloat(prestamo.principal_amount), newInterestRate, newTermMonths, newMonthlyPayment, newDisbursementDate, totalPrimeraCuota
            );

            for (const cuota of cuotas) {
                await connection.query(
                    `INSERT INTO cuotas_prestamo (prestamo_id, number, due_date, amount, interest_portion, principal_portion, charges_portion) 
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [id, cuota.number, cuota.due_date, cuota.amount, cuota.interest_portion, cuota.principal_portion, cuota.charges_portion]
                );
            }
        }

        await connection.commit();
        res.json({ message: 'Préstamo actualizado correctamente', schedule_regenerated: wantsFinancialChange && !hasPayments });

    } catch (error) {
        await connection.rollback();
        console.error('❌ Error al actualizar el préstamo:', error);
        res.status(500).json({ error: 'Error al actualizar el préstamo' });
    } finally {
        connection.release();
    }
});

// ========================
// POST /prestamos/pago
// El abono se reparte en 3 partes: interés, capital y cargos (cargos
// solo existen en la cuota #1, si aplica). Todo lo que reduce capital
// o cargos reduce la MISMA cuenta/fuente de deuda (2105, o la tarjeta
// vinculada si es extrafinanciamiento).
// ========================
router.post('/pago', async (req, res) => {
    const { cuota_id, amount, payment_method, bank_id, user_id, notes } = req.body;

    if (!cuota_id || !amount || amount <= 0 || !user_id) {
        return res.status(400).json({ error: "Datos incompletos o monto inválido." });
    }

    const validMethods = ['cash', 'transfer', 'card'];
    if (!validMethods.includes(payment_method)) {
        return res.status(400).json({ error: "Método de pago inválido." });
    }

    if ((payment_method === 'transfer' || payment_method === 'card') && !bank_id) {
        return res.status(400).json({ error: "Debe seleccionar una cuenta bancaria." });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [cuotaResult] = await connection.query(
            'SELECT * FROM cuotas_prestamo WHERE id = ? FOR UPDATE',
            [cuota_id]
        );

        if (!cuotaResult.length) {
            await connection.rollback();
            return res.status(404).json({ error: "Cuota no encontrada." });
        }

        const cuota = cuotaResult[0];
        const remainingTotal = parseFloat(cuota.amount) - parseFloat(cuota.paid_amount);

        if (parseFloat(amount) > remainingTotal + 0.01) {
            await connection.rollback();
            return res.status(400).json({
                error: `El monto excede el saldo de esta cuota (L. ${remainingTotal.toFixed(2)}). Si quieres pagar de más para abonar a capital, usa la opción "Abono a Capital".`
            });
        }

        const remainingInterest = parseFloat(cuota.interest_portion) - parseFloat(cuota.interest_paid);
        const remainingPrincipal = parseFloat(cuota.principal_portion) - parseFloat(cuota.principal_paid);
        const remainingCharges = parseFloat(cuota.charges_portion || 0) - parseFloat(cuota.charges_paid || 0);

        let interestThis, principalThis, chargesThis;

        if (parseFloat(amount) >= remainingTotal - 0.01) {
            interestThis = remainingInterest;
            chargesThis = remainingCharges;
            principalThis = remainingPrincipal;
        } else {
            const ratio = parseFloat(amount) / remainingTotal;
            interestThis = parseFloat((remainingInterest * ratio).toFixed(2));
            chargesThis = parseFloat((remainingCharges * ratio).toFixed(2));
            principalThis = parseFloat((parseFloat(amount) - interestThis - chargesThis).toFixed(2));
        }

        const [prestamoRow] = await connection.query('SELECT * FROM prestamos WHERE id = ?', [cuota.prestamo_id]);
        const prestamo = prestamoRow[0];
        const debtAccount = await resolveDebtAccount(connection, prestamo);

        let cajaAbierta = null;
        let bankAccount = null;

        if (payment_method === 'cash') {
            const [cajaResult] = await connection.query(
                "SELECT id, opening_amount FROM cajas WHERE user_id = ? AND status = 'open' LIMIT 1 FOR UPDATE",
                [user_id]
            );
            if (!cajaResult.length) {
                await connection.rollback();
                return res.status(400).json({ error: "Debes abrir tu caja antes de pagar en efectivo." });
            }
            cajaAbierta = cajaResult[0];

            const [movResult] = await connection.query(
                `SELECT 
                    COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
                    COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense
                 FROM movimientos_caja WHERE caja_id = ?`,
                [cajaAbierta.id]
            );
            const availableCash = parseFloat(cajaAbierta.opening_amount)
                + parseFloat(movResult[0].total_income)
                - parseFloat(movResult[0].total_expense);

            if (parseFloat(amount) > availableCash) {
                await connection.rollback();
                return res.status(400).json({ error: `Saldo insuficiente en caja. Disponible: L. ${availableCash.toFixed(2)}` });
            }
        } else {
            const [bankResult] = await connection.query(
                "SELECT id, current_balance FROM bancos WHERE id = ? AND status = 'active' FOR UPDATE",
                [bank_id]
            );
            if (!bankResult.length) {
                await connection.rollback();
                return res.status(404).json({ error: "Cuenta bancaria no encontrada o inactiva." });
            }
            bankAccount = bankResult[0];

            if (parseFloat(amount) > parseFloat(bankAccount.current_balance)) {
                await connection.rollback();
                return res.status(400).json({ error: `Saldo insuficiente en el banco. Disponible: L. ${parseFloat(bankAccount.current_balance).toFixed(2)}` });
            }
        }

        const newPaidAmount = parseFloat(cuota.paid_amount) + parseFloat(amount);
        const newInterestPaid = parseFloat(cuota.interest_paid) + interestThis;
        const newPrincipalPaid = parseFloat(cuota.principal_paid) + principalThis;
        const newChargesPaid = parseFloat(cuota.charges_paid || 0) + chargesThis;
        const newStatus = newPaidAmount >= parseFloat(cuota.amount) - 0.01 ? 'paid' : 'partial';

        await connection.query(
            `UPDATE cuotas_prestamo 
             SET paid_amount = ?, interest_paid = ?, principal_paid = ?, charges_paid = ?, status = ? 
             WHERE id = ?`,
            [newPaidAmount, newInterestPaid, newPrincipalPaid, newChargesPaid, newStatus, cuota_id]
        );

        const [pagoResult] = await connection.query(
            `INSERT INTO pagos_prestamo (prestamo_id, cuota_id, user_id, amount, interest_paid, principal_paid, charges_paid, payment_method, bank_id, notes) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [cuota.prestamo_id, cuota_id, user_id, amount, interestThis, principalThis, chargesThis, payment_method, bank_id || null, notes || null]
        );

        const concept = `Cuota #${cuota.number} - ${prestamo.lender_name}`;

        if (cajaAbierta) {
            await connection.query(
                `INSERT INTO movimientos_caja (caja_id, type, concept, amount, reference_type, reference_id) 
                 VALUES (?, 'expense', ?, ?, 'otro', ?)`,
                [cajaAbierta.id, concept, amount, pagoResult.insertId]
            );
        }

        if (bankAccount) {
            await connection.query(
                `INSERT INTO movimientos_bancarios (bank_id, type, amount, concept, reference_type, reference_id) 
                 VALUES (?, 'transfer_out', ?, ?, 'otro', ?)`,
                [bank_id, amount, concept, pagoResult.insertId]
            );
            await connection.query(
                "UPDATE bancos SET current_balance = current_balance - ? WHERE id = ?",
                [amount, bank_id]
            );
        }

        const debtReduction = principalThis + chargesThis;

        if (debtAccount.isExtrafinanciamiento && debtReduction > 0) {
            await connection.query(
                "UPDATE fuentes_financiamiento SET current_balance = current_balance - ? WHERE id = ?",
                [debtReduction, prestamo.linked_financing_source_id]
            );
            await connection.query(
                `INSERT INTO movimientos_financiamiento (financing_source_id, type, amount, concept, reference_type, reference_id) 
                 VALUES (?, 'payment', ?, ?, 'ajuste', ?)`,
                [prestamo.linked_financing_source_id, debtReduction, concept, pagoResult.insertId]
            );
        }

        const cuentaOrigen = payment_method === 'cash' ? '1101' : '1102';
        const lines = [];

        if (debtReduction > 0) lines.push({ code: debtAccount.code, debit: debtReduction });
        if (interestThis > 0) lines.push({ code: '6103', debit: interestThis });
        lines.push({ code: cuentaOrigen, credit: parseFloat(amount) });

        await crearAsiento(connection, {
            description: concept,
            reference_type: 'ajuste',
            reference_id: pagoResult.insertId,
            user_id,
            lines
        });

        const [pendingCheck] = await connection.query(
            `SELECT COUNT(*) AS pending FROM cuotas_prestamo WHERE prestamo_id = ? AND status != 'paid'`,
            [cuota.prestamo_id]
        );

        if (pendingCheck[0].pending === 0) {
            await connection.query(`UPDATE prestamos SET status = 'paid' WHERE id = ?`, [cuota.prestamo_id]);
        }

        await connection.commit();
        res.json({ message: "Pago registrado con éxito" });

    } catch (error) {
        await connection.rollback();
        console.error("❌ Error al registrar el pago:", error);
        res.status(500).json({ error: error.message || "Error al registrar el pago" });
    } finally {
        connection.release();
    }
});

// ========================
// POST /prestamos/:id/abono-capital
// (sin cambios de fondo — pero ahora resuelve la cuenta/fuente de
// deuda correcta según sea préstamo o extrafinanciamiento)
// ========================
router.post('/:id/abono-capital', async (req, res) => {
    const { id } = req.params;
    const { amount, payment_method, bank_id, user_id, notes } = req.body;

    if (!amount || amount <= 0 || !user_id) {
        return res.status(400).json({ error: "Monto inválido." });
    }

    const validMethods = ['cash', 'transfer', 'card'];
    if (!validMethods.includes(payment_method)) {
        return res.status(400).json({ error: "Método de pago inválido." });
    }

    if ((payment_method === 'transfer' || payment_method === 'card') && !bank_id) {
        return res.status(400).json({ error: "Debe seleccionar una cuenta bancaria." });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [prestamoRows] = await connection.query('SELECT * FROM prestamos WHERE id = ? FOR UPDATE', [id]);
        if (!prestamoRows.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Préstamo no encontrado' });
        }
        const prestamo = prestamoRows[0];
        const debtAccount = await resolveDebtAccount(connection, prestamo);

        const [cuotasPendientes] = await connection.query(
            `SELECT * FROM cuotas_prestamo WHERE prestamo_id = ? AND status != 'paid' ORDER BY number ASC FOR UPDATE`,
            [id]
        );

        if (!cuotasPendientes.length) {
            await connection.rollback();
            return res.status(400).json({ error: 'Este préstamo ya está completamente pagado.' });
        }

        const saldoCapitalActual = cuotasPendientes.reduce(
            (sum, c) => sum + (parseFloat(c.principal_portion) - parseFloat(c.principal_paid)), 0
        );

        if (parseFloat(amount) > saldoCapitalActual + 0.01) {
            await connection.rollback();
            return res.status(400).json({
                error: `El abono no puede ser mayor al saldo de capital pendiente: L. ${saldoCapitalActual.toFixed(2)}`
            });
        }

        let cajaAbierta = null;
        let bankAccount = null;

        if (payment_method === 'cash') {
            const [cajaResult] = await connection.query(
                "SELECT id, opening_amount FROM cajas WHERE user_id = ? AND status = 'open' LIMIT 1 FOR UPDATE",
                [user_id]
            );
            if (!cajaResult.length) {
                await connection.rollback();
                return res.status(400).json({ error: "Debes abrir tu caja antes de registrar el abono en efectivo." });
            }
            cajaAbierta = cajaResult[0];

            const [movResult] = await connection.query(
                `SELECT 
                    COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
                    COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense
                 FROM movimientos_caja WHERE caja_id = ?`,
                [cajaAbierta.id]
            );
            const availableCash = parseFloat(cajaAbierta.opening_amount)
                + parseFloat(movResult[0].total_income)
                - parseFloat(movResult[0].total_expense);

            if (parseFloat(amount) > availableCash) {
                await connection.rollback();
                return res.status(400).json({ error: `Saldo insuficiente en caja. Disponible: L. ${availableCash.toFixed(2)}` });
            }
        } else {
            const [bankResult] = await connection.query(
                "SELECT id, current_balance FROM bancos WHERE id = ? AND status = 'active' FOR UPDATE",
                [bank_id]
            );
            if (!bankResult.length) {
                await connection.rollback();
                return res.status(404).json({ error: "Cuenta bancaria no encontrada o inactiva." });
            }
            bankAccount = bankResult[0];

            if (parseFloat(amount) > parseFloat(bankAccount.current_balance)) {
                await connection.rollback();
                return res.status(400).json({ error: `Saldo insuficiente en el banco. Disponible: L. ${parseFloat(bankAccount.current_balance).toFixed(2)}` });
            }
        }

        const nuevoSaldoCapital = parseFloat((saldoCapitalActual - parseFloat(amount)).toFixed(2));
        const monthlyRate = parseFloat(prestamo.interest_rate) / 100 / 12;
        const monthlyPayment = parseFloat(prestamo.monthly_payment);

        let saldo = nuevoSaldoCapital;
        const cuotasFinalizadasAnticipadamente = [];

        for (const cuota of cuotasPendientes) {
            if (saldo <= 0.01) {
                cuotasFinalizadasAnticipadamente.push(cuota.id);
                continue;
            }

            let interestPortion = parseFloat((saldo * monthlyRate).toFixed(2));
            let principalPortion = parseFloat((monthlyPayment - interestPortion).toFixed(2));
            let amountCuota = monthlyPayment + parseFloat(cuota.charges_portion || 0);

            if (principalPortion >= saldo) {
                principalPortion = parseFloat(saldo.toFixed(2));
                interestPortion = parseFloat((monthlyPayment - principalPortion).toFixed(2));
                amountCuota = parseFloat((principalPortion + interestPortion + parseFloat(cuota.charges_portion || 0)).toFixed(2));
                saldo = 0;
            } else {
                saldo = parseFloat((saldo - principalPortion).toFixed(2));
            }

            await connection.query(
                `UPDATE cuotas_prestamo SET amount=?, interest_portion=?, principal_portion=? WHERE id=?`,
                [amountCuota, interestPortion, principalPortion, cuota.id]
            );
        }

        for (const cuotaId of cuotasFinalizadasAnticipadamente) {
            await connection.query(
                `UPDATE cuotas_prestamo SET amount=charges_portion, interest_portion=0, principal_portion=0, status=IF(charges_portion > charges_paid, status, 'paid') WHERE id=?`,
                [cuotaId]
            );
        }

        const [abonoResult] = await connection.query(
            `INSERT INTO abonos_capital_prestamo (prestamo_id, user_id, amount, payment_method, bank_id, notes) VALUES (?, ?, ?, ?, ?, ?)`,
            [id, user_id, amount, payment_method, bank_id || null, notes || null]
        );

        const concept = `Abono a capital - ${prestamo.lender_name}`;

        if (cajaAbierta) {
            await connection.query(
                `INSERT INTO movimientos_caja (caja_id, type, concept, amount, reference_type, reference_id) VALUES (?, 'expense', ?, ?, 'otro', ?)`,
                [cajaAbierta.id, concept, amount, abonoResult.insertId]
            );
        }

        if (bankAccount) {
            await connection.query(
                `INSERT INTO movimientos_bancarios (bank_id, type, amount, concept, reference_type, reference_id) VALUES (?, 'transfer_out', ?, ?, 'otro', ?)`,
                [bank_id, amount, concept, abonoResult.insertId]
            );
            await connection.query(`UPDATE bancos SET current_balance = current_balance - ? WHERE id = ?`, [amount, bank_id]);
        }

        if (debtAccount.isExtrafinanciamiento) {
            await connection.query(
                "UPDATE fuentes_financiamiento SET current_balance = current_balance - ? WHERE id = ?",
                [amount, prestamo.linked_financing_source_id]
            );
            await connection.query(
                `INSERT INTO movimientos_financiamiento (financing_source_id, type, amount, concept, reference_type, reference_id) 
                 VALUES (?, 'payment', ?, ?, 'ajuste', ?)`,
                [prestamo.linked_financing_source_id, amount, concept, abonoResult.insertId]
            );
        }

        const cuentaOrigen = payment_method === 'cash' ? '1101' : '1102';

        await crearAsiento(connection, {
            description: concept,
            reference_type: 'ajuste',
            reference_id: abonoResult.insertId,
            user_id,
            lines: [
                { code: debtAccount.code, debit: amount },
                { code: cuentaOrigen, credit: amount }
            ]
        });

        if (nuevoSaldoCapital <= 0.01) {
            await connection.query(`UPDATE prestamos SET status = 'paid' WHERE id = ?`, [id]);
        }

        await connection.commit();
        res.json({
            message: "Abono a capital registrado. El préstamo fue reamortizado.",
            nuevo_saldo_capital: nuevoSaldoCapital,
            cuotas_canceladas_anticipadamente: cuotasFinalizadasAnticipadamente.length
        });

    } catch (error) {
        await connection.rollback();
        console.error("❌ Error al registrar abono a capital:", error);
        res.status(500).json({ error: error.message || "Error al registrar el abono a capital" });
    } finally {
        connection.release();
    }
});

module.exports = router;