// Import necessary libraries
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const app = express();
const port = process.env.PORT || 3000;

// Middleware to process JSON requests
app.use(express.json());

// Database connection configuration
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Middleware to serve static files from the 'public' folder
app.use(express.static('public'));

// --------------------------------------------------------------------------
// --- API Endpoints ---
// --------------------------------------------------------------------------

// 1. Endpoint for client registration
app.post('/api/registro', async (req, res) => {
    const {
        nombres,
        apellidos,
        cedula,
        correo,
        contrasena,
        telefono,
        direccion,
        provincia,
        ciudad,
        cedula_recomendador
    } = req.body;

    try {
        const checkUser = await pool.query(
            'SELECT * FROM users WHERE email = $1 OR id_number = $2', [correo, cedula]
        );
        if (checkUser.rows.length > 0) {
            return res.status(409).json({ message: 'El correo o la cédula ya están registrados.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(contrasena, salt);

        await pool.query(
            `INSERT INTO users (first_name, last_name, id_number, email, password_hash, phone, address, province, city, referrer_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [nombres, apellidos, cedula, correo, hashedPassword, telefono, direccion, provincia, ciudad, cedula_recomendador]
        );

        res.status(201).json({ message: 'Registro exitoso. Ahora puedes iniciar sesión.' });
    } catch (err) {
        console.error('Error al registrar usuario:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 2. Endpoint for login
app.post('/api/login', async (req, res) => {
    const { correo, contrasena } = req.body;
    try {
        const user = await pool.query(
            'SELECT id, first_name, last_name, password_hash, role FROM users WHERE email = $1', [correo]
        );
        if (user.rows.length === 0) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        const foundUser = user.rows[0];

        const isMatch = await bcrypt.compare(contrasena, foundUser.password_hash);
        if (!isMatch) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }
        
        res.status(200).json({
            message: 'Inicio de sesión exitoso.',
            role: foundUser.role,
            user: {
                id: foundUser.id,
                nombres: foundUser.first_name,
                apellidos: foundUser.last_name
            }
        });

    } catch (err) {
        console.error('Error al iniciar sesión:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 3. Endpoint to get client data
app.get('/api/cliente/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const clientData = await pool.query(
            'SELECT first_name, last_name, balance, referrer_id, email FROM users WHERE id = $1', [id]
        );
        const transactionHistory = await pool.query(
            'SELECT transaction_type, amount, created_at, status FROM transactions WHERE sender_id = $1 OR receiver_id = $1 ORDER BY created_at DESC', [id]
        );
        const loanHistory = await pool.query(
            'SELECT amount, total_amount_to_pay, end_date, status FROM loans WHERE user_id = $1 ORDER BY start_date DESC', [id]
        );
        const totalLoans = await pool.query(
            'SELECT SUM(amount) AS total FROM loans WHERE user_id = $1 AND status = \'approved\'', [id]
        );

        if (clientData.rows.length === 0) {
            return res.status(404).json({ message: 'Cliente no encontrado.' });
        }
        
        res.status(200).json({
            cliente: clientData.rows[0],
            movimientos: transactionHistory.rows,
            creditos: loanHistory.rows,
            total_creditos: totalLoans.rows[0].total || 0
        });

    } catch (err) {
        console.error('Error al obtener datos del cliente:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 4. Endpoint to send requests (deposit, withdrawal, loan)
app.post('/api/solicitud', async (req, res) => {
    const { usuario_id, tipo, monto, banco, cuenta, plazo } = req.body;
    try {
        // Basic validation
        if (!usuario_id || !tipo || isNaN(monto) || monto <= 0) {
            return res.status(400).json({ message: 'Datos de solicitud incompletos o inválidos.' });
        }

        if (tipo === 'deposito' || tipo === 'retiro') {
            await pool.query(
                `INSERT INTO transactions (user_id, amount, transaction_type, status, bank, account) 
                 VALUES ($1, $2, $3, 'pending', $4, $5)`,
                [usuario_id, monto, tipo, banco || null, cuenta || null]
            );
        } else if (tipo === 'credito') {
            const interest = 10.00;
            const totalAmount = monto + (monto * (interest / 100));
            const endDate = new Date();
            endDate.setDate(endDate.getDate() + parseInt(plazo));

            await pool.query(
                `INSERT INTO loan_requests (user_id, amount, loan_term_days, interest_rate, status)
                 VALUES ($1, $2, $3, $4, 'pending')`,
                [usuario_id, monto, plazo, interest]
            );
        }

        res.status(201).json({ message: `Solicitud de ${tipo} enviada con éxito. Espera la aprobación del administrador.` });

    } catch (err) {
        console.error('Error al procesar la solicitud:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 5. Endpoint for the admin dashboard
app.get('/api/admin/dashboard', async (req, res) => {
    try {
        const [
            users,
            depositRequests,
            withdrawalRequests,
            loanRequests,
            bankCapital
        ] = await Promise.all([
            pool.query('SELECT COUNT(*) AS total_users FROM users'),
            pool.query('SELECT t.*, u.first_name, u.last_name, u.id_number FROM transactions t INNER JOIN users u ON t.user_id = u.id WHERE t.status = \'pending\' AND t.transaction_type = \'deposito\' ORDER BY t.created_at DESC'),
            pool.query('SELECT t.*, u.first_name, u.last_name, u.id_number FROM transactions t INNER JOIN users u ON t.user_id = u.id WHERE t.status = \'pending\' AND t.transaction_type = \'retiro\' ORDER BY t.created_at DESC'),
            pool.query('SELECT l.*, u.first_name, u.last_name, u.id_number FROM loan_requests l INNER JOIN users u ON l.user_id = u.id WHERE l.status = \'pending\' ORDER BY l.created_at DESC'),
            pool.query('SELECT capital FROM bank_data LIMIT 1')
        ]);

        res.status(200).json({
            total_usuarios: users.rows[0].total_users,
            solicitudes_deposito: depositRequests.rows,
            solicitudes_retiro: withdrawalRequests.rows,
            solicitudes_credito: loanRequests.rows,
            capital_banco: bankCapital.rows[0].capital || 0
        });

    } catch (err) {
        console.error('Error al obtener datos del dashboard del admin:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});


// 6. Endpoint to manage transactions (approve/reject)
app.post('/api/admin/transaccion/:tipo/:id', async (req, res) => {
    const { tipo, id } = req.params;
    const { accion } = req.body;
    try {
        await pool.query('BEGIN');

        if (accion === 'aprobar') {
            if (tipo === 'deposito') {
                const deposit = await pool.query('SELECT * FROM transactions WHERE id = $1', [id]);
                if (deposit.rows.length === 0) throw new Error('Depósito no encontrado.');
                await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [deposit.rows[0].amount, deposit.rows[0].user_id]);
                await pool.query('UPDATE transactions SET status = \'approved\' WHERE id = $1', [id]);
            } else if (tipo === 'retiro') {
                const withdrawal = await pool.query('SELECT * FROM transactions WHERE id = $1', [id]);
                if (withdrawal.rows.length === 0) throw new Error('Retiro no encontrado.');
                await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [withdrawal.rows[0].amount, withdrawal.rows[0].user_id]);
                await pool.query('UPDATE transactions SET status = \'approved\' WHERE id = $1', [id]);
            } else if (tipo === 'credito') {
                const loanRequest = await pool.query('SELECT * FROM loan_requests WHERE id = $1', [id]);
                if (loanRequest.rows.length === 0) throw new Error('Crédito no encontrado.');

                const { user_id, amount, loan_term_days, interest_rate, created_at } = loanRequest.rows[0];

                const totalAmountToPay = amount + (amount * (interest_rate / 100));
                const endDate = new Date(created_at);
                endDate.setDate(endDate.getDate() + parseInt(loan_term_days));

                // Insert into the loans table (active loans)
                await pool.query(
                    `INSERT INTO loans (user_id, amount, interest_rate, start_date, end_date, total_amount_to_pay)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [user_id, amount, interest_rate, created_at, endDate, totalAmountToPay]
                );

                await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, user_id]);
                await pool.query('UPDATE loan_requests SET status = \'approved\' WHERE id = $1', [id]);
                await pool.query('UPDATE bank_data SET capital = capital - $1', [amount]);
                await pool.query('INSERT INTO capital_history (amount, description) VALUES ($1, $2)', [-amount, 'Préstamo de crédito']);
            }
        } else if (accion === 'rechazar') {
            if (tipo === 'deposito' || tipo === 'retiro') {
                await pool.query('UPDATE transactions SET status = \'rejected\' WHERE id = $1', [id]);
            } else if (tipo === 'credito') {
                await pool.query('UPDATE loan_requests SET status = \'rejected\' WHERE id = $1', [id]);
            }
        }

        await pool.query('COMMIT');
        res.status(200).json({ message: `Transacción de ${tipo} ${accion}da con éxito.` });

    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('Error al gestionar transacción:', err);
        res.status(500).json({ message: 'Error interno del servidor. ' + err.message });
    }
});


// 7. Endpoint to manage bank capital
app.post('/api/admin/capital', async (req, res) => {
    const { accion, monto, motivo } = req.body;

    try {
        if (accion === 'agregar') {
            await pool.query('UPDATE bank_data SET capital = capital + $1', [monto]);
            await pool.query('INSERT INTO capital_history (amount, description) VALUES ($1, $2)', [monto, motivo]);
        } else if (accion === 'reducir') {
            await pool.query('UPDATE bank_data SET capital = capital - $1', [monto]);
            await pool.query('INSERT INTO capital_history (amount, description) VALUES ($1, $2)', [-monto, motivo]);
        } else {
            return res.status(400).json({ message: 'Acción inválida.' });
        }
        res.status(200).json({ message: 'Capital del banco actualizado con éxito.' });
    } catch (err) {
        console.error('Error al gestionar capital:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 8. Endpoint to get capital history
app.get('/api/admin/capital/historial', async (req, res) => {
    try {
        const history = await pool.query(
            'SELECT created_at, amount, description FROM capital_history ORDER BY created_at DESC LIMIT 30'
        );
        res.status(200).json(history.rows);
    } catch (err) {
        console.error('Error al obtener el historial de capital:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// --------------------------------------------------------------------------
// --- Iniciar el Servidor (ESTA LÍNEA DEBE IR AL FINAL) ---
// --------------------------------------------------------------------------

app.listen(port, () => {
    console.log(`Servidor Danna Bank escuchando en el puerto ${port}`);
});
