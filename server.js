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

    // The request body and variables still use Spanish names, which is okay.
    // We'll translate them for the database query.
    const firstName = nombres;
    const lastName = apellidos;
    const idNumber = cedula;
    const email = correo;
    const password = contrasena;
    const phone = telefono;
    const address = direccion;
    const province = provincia;
    const city = ciudad;
    const referrerId = cedula_recomendador;

    try {
        const checkUser = await pool.query(
            'SELECT * FROM users WHERE email = $1 OR id_number = $2', [email, idNumber]
        );
        if (checkUser.rows.length > 0) {
            return res.status(409).json({ message: 'The email or ID number is already registered.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        await pool.query(
            `INSERT INTO users (first_name, last_name, id_number, email, password_hash, phone, address, province, city, referrer_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [firstName, lastName, idNumber, email, hashedPassword, phone, address, province, city, referrerId]
        );

        res.status(201).json({ message: 'Registration successful. You can now log in.' });
    } catch (err) {
        console.error('Error registering user:', err);
        res.status(500).json({ message: 'Internal server error.' });
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
            return res.status(401).json({ message: 'Invalid credentials.' });
        }

        const foundUser = user.rows[0];

        const isMatch = await bcrypt.compare(contrasena, foundUser.password_hash);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials.' });
        }
        
        res.status(200).json({
            message: 'Login successful.',
            role: foundUser.role,
            user: {
                id: foundUser.id,
                first_name: foundUser.first_name,
                last_name: foundUser.last_name
            }
        });

    } catch (err) {
        console.error('Error logging in:', err);
        res.status(500).json({ message: 'Internal server error.' });
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
            'SELECT type, amount, created_at FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', [id]
        );
        const loanHistory = await pool.query(
            'SELECT amount, total_amount_to_pay, end_date, status FROM loans WHERE user_id = $1 ORDER BY start_date DESC', [id]
        );
        const totalLoans = await pool.query(
            'SELECT SUM(amount) AS total FROM loans WHERE user_id = $1 AND status = \'approved\'', [id]
        );

        if (clientData.rows.length === 0) {
            return res.status(404).json({ message: 'Client not found.' });
        }
        
        res.status(200).json({
            client: clientData.rows[0],
            transactions: transactionHistory.rows,
            loans: loanHistory.rows,
            total_loans: totalLoans.rows[0].total || 0
        });

    } catch (err) {
        console.error('Error getting client data:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// 4. Endpoint to send requests (deposit, withdrawal, loan)
app.post('/api/solicitud', async (req, res) => {
    const { user_id, type, amount, bank, account, term } = req.body;
    try {
        // Basic validation
        if (!user_id || !type || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ message: 'Incomplete or invalid request data.' });
        }

        if (type === 'deposit' || type === 'withdrawal') {
            await pool.query(
                'INSERT INTO transactions (user_id, type, amount, status, bank, account) VALUES ($1, $2, $3, \'pending\', $4, $5)',
                [user_id, type, amount, bank || null, account || null]
            );
        } else if (type === 'loan') {
            const interest = 10.00;
            const totalAmount = amount + (amount * (interest / 100));
            const endDate = new Date();
            endDate.setDate(endDate.getDate() + parseInt(term));

            await pool.query(
                `INSERT INTO loans (user_id, amount, term_days, interest_rate, total_amount_to_pay, end_date, status)
                 VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
                [user_id, amount, term, interest, totalAmount, endDate]
            );
        }

        res.status(201).json({ message: `Request for ${type} sent successfully. Awaiting administrator approval.` });

    } catch (err) {
        console.error('Error processing request:', err);
        res.status(500).json({ message: 'Internal server error.' });
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
            pool.query('SELECT t.*, u.first_name, u.last_name, u.id_number FROM transactions t INNER JOIN users u ON t.user_id = u.id WHERE t.status = \'pending\' AND t.type = \'deposit\' ORDER BY t.created_at DESC'),
            pool.query('SELECT t.*, u.first_name, u.last_name, u.id_number FROM transactions t INNER JOIN users u ON t.user_id = u.id WHERE t.status = \'pending\' AND t.type = \'withdrawal\' ORDER BY t.created_at DESC'),
            pool.query('SELECT l.*, u.first_name, u.last_name, u.id_number FROM loans l INNER JOIN users u ON l.user_id = u.id WHERE l.status = \'pending\' ORDER BY l.created_at DESC'),
            pool.query('SELECT capital FROM bank_data LIMIT 1')
        ]);

        res.status(200).json({
            total_users: users.rows[0].total_users,
            deposit_requests: depositRequests.rows,
            withdrawal_requests: withdrawalRequests.rows,
            loan_requests: loanRequests.rows,
            bank_capital: bankCapital.rows[0].capital || 0
        });

    } catch (err) {
        console.error('Error getting admin dashboard data:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});


// 6. Endpoint to manage transactions (approve/reject)
app.post('/api/admin/transaccion/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const { action } = req.body;
    try {
        await pool.query('BEGIN');

        if (action === 'approve') {
            if (type === 'deposit') {
                const deposit = await pool.query('SELECT * FROM transactions WHERE id = $1', [id]);
                if (deposit.rows.length === 0) throw new Error('Deposit not found.');
                await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [deposit.rows[0].amount, deposit.rows[0].user_id]);
                await pool.query('UPDATE transactions SET status = \'approved\' WHERE id = $1', [id]);
            } else if (type === 'withdrawal') {
                const withdrawal = await pool.query('SELECT * FROM transactions WHERE id = $1', [id]);
                if (withdrawal.rows.length === 0) throw new Error('Withdrawal not found.');
                await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [withdrawal.rows[0].amount, withdrawal.rows[0].user_id]);
                await pool.query('UPDATE transactions SET status = \'approved\' WHERE id = $1', [id]);
            } else if (type === 'loan') {
                const loan = await pool.query('SELECT * FROM loans WHERE id = $1', [id]);
                if (loan.rows.length === 0) throw new Error('Loan not found.');
                await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [loan.rows[0].amount, loan.rows[0].user_id]);
                await pool.query('UPDATE loans SET status = \'approved\' WHERE id = $1', [id]);
                await pool.query('UPDATE bank_data SET capital = capital - $1', [loan.rows[0].amount]);
                await pool.query('INSERT INTO capital_history (amount, description) VALUES ($1, $2)', [-loan.rows[0].amount, 'Loan granted']);
            }
        } else if (action === 'reject') {
            if (type === 'deposit' || type === 'withdrawal') {
                await pool.query('UPDATE transactions SET status = \'rejected\' WHERE id = $1', [id]);
            } else if (type === 'loan') {
                await pool.query('UPDATE loans SET status = \'rejected\' WHERE id = $1', [id]);
            }
        }

        await pool.query('COMMIT');
        res.status(200).json({ message: `Transaction of ${type} ${action}d successfully.` });

    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('Error managing transaction:', err);
        res.status(500).json({ message: 'Internal server error. ' + err.message });
    }
});

// 7. Endpoint to manage bank capital
app.post('/api/admin/capital', async (req, res) => {
    const { action, amount, description } = req.body;

    try {
        if (action === 'add') {
            await pool.query('UPDATE bank_data SET capital = capital + $1', [amount]);
            await pool.query('INSERT INTO capital_history (amount, description) VALUES ($1, $2)', [amount, description]);
        } else if (action === 'reduce') {
            await pool.query('UPDATE bank_data SET capital = capital - $1', [amount]);
            await pool.query('INSERT INTO capital_history (amount, description) VALUES ($1, $2)', [-amount, description]);
        } else {
            return res.status(400).json({ message: 'Invalid action.' });
        }
        res.status(200).json({ message: 'Bank capital updated successfully.' });
    } catch (err) {
        console.error('Error managing capital:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// 8. Endpoint to get capital history
app.get('/api/admin/capital/history', async (req, res) => {
    try {
        const history = await pool.query(
            'SELECT created_at, amount, description FROM capital_history ORDER BY created_at DESC LIMIT 30'
        );
        res.status(200).json(history.rows);
    } catch (err) {
        console.error('Error getting capital history:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// --------------------------------------------------------------------------
// --- Start the Server (THIS LINE MUST GO AT THE END) ---
// --------------------------------------------------------------------------

app.listen(port, () => {
    console.log(`Danna Bank server listening on port ${port}`);
});
