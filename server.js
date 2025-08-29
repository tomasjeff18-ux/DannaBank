// Import necessary libraries
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Middleware to process JSON requests
app.use(express.json());
app.use(cors());

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

// 1. Client Registration Endpoint
app.post('/api/register', async (req, res) => {
    const {
        firstName,
        lastName,
        idCard,
        email,
        password,
        phone,
        address,
        province,
        city,
        referrerIdCard
    } = req.body;

    try {
        const checkUser = await pool.query(
            'SELECT * FROM users WHERE email = $1 OR id_card = $2', [email, idCard]
        );

        if (checkUser.rows.length > 0) {
            return res.status(409).json({ message: 'The email or ID card is already registered. You will be redirected to the login form.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newUserUUID = uuidv4();

        // Register the user with a 'pending' status
        await pool.query(
            'INSERT INTO users(id, first_name, last_name, id_card, email, password, phone, address, province, city, referrer_id_card, role, status, current_balance) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
            [newUserUUID, firstName, lastName, idCard, email, hashedPassword, phone, address, province, city, referrerIdCard, 'client', 'pending', 0]
        );

        res.status(201).json({ message: 'Registration request sent successfully. Wait for admin approval.' });

    } catch (err) {
        console.error('Error registering client:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// 2. Login Endpoint
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = userResult.rows[0];

        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials.' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials.' });
        }

        if (user.status !== 'active') {
            return res.status(403).json({ message: 'Your account is not active. Wait for admin approval.' });
        }

        // Return the user and role
        res.status(200).json({
            message: 'Login successful.',
            role: user.role,
            user: {
                id: user.id,
                firstName: user.first_name,
                lastName: user.last_name,
                currentBalance: user.current_balance
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// 3. Client Panel Data Endpoint
app.get('/api/client/data/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const userResult = await pool.query('SELECT first_name, last_name, current_balance FROM users WHERE id = $1 AND role = $2 AND status = $3', [userId, 'client', 'active']);
        const user = userResult.rows[0];

        if (!user) {
            return res.status(404).json({ message: 'User not found or not active.' });
        }

        const movementsResult = await pool.query('SELECT transaction_type, amount, created_at FROM transactions WHERE sender_id = $1 OR receiver_id = $1 ORDER BY created_at DESC LIMIT 10', [userId]);

        const creditResult = await pool.query('SELECT * FROM credits WHERE user_id = $1 AND status = $2', [userId, 'approved']);
        const activeCredit = creditResult.rows[0];

        res.status(200).json({
            user,
            movements: movementsResult.rows,
            activeCredit
        });
    } catch (err) {
        console.error('Error fetching client data:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// 4. Request Endpoint (Withdrawal, Deposit, Credit)
app.post('/api/client/request', async (req, res) => {
    const { userId, type, amount, bank, accountNumber, termInDays } = req.body;
    try {
        const userResult = await pool.query('SELECT current_balance FROM users WHERE id = $1', [userId]);
        const user = userResult.rows[0];

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        if (type === 'withdrawal') {
            if (user.current_balance < amount) {
                return res.status(400).json({ message: 'Insufficient funds for withdrawal.' });
            }
            await pool.query('INSERT INTO withdrawal_requests (user_id, amount, bank, account_number) VALUES ($1, $2, $3, $4)', [userId, amount, bank, accountNumber]);
        } else if (type === 'credit') {
            const activeCredit = await pool.query('SELECT * FROM credits WHERE user_id = $1 AND status = $2', [userId, 'approved']);
            if (activeCredit.rows.length > 0) {
                return res.status(400).json({ message: 'You already have an active credit.' });
            }
            if (amount > 50 || termInDays > 30) {
                return res.status(400).json({ message: 'Credit amount cannot exceed $50 and term cannot exceed 30 days.' });
            }
            await pool.query('INSERT INTO credit_requests (user_id, amount, term_in_days, status) VALUES ($1, $2, $3, $4)', [userId, amount, termInDays, 'pending']);
        } else if (type === 'deposit') {
            await pool.query('INSERT INTO deposit_requests (user_id, amount, bank) VALUES ($1, $2, $3)', [userId, amount, bank]);
        } else {
            return res.status(400).json({ message: 'Invalid request type.' });
        }
        res.status(201).json({ message: 'Request sent successfully. Waiting for admin approval.' });
    } catch (err) {
        console.error('Error sending request:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// 5. Admin Panel Data Endpoint
app.get('/api/admin/data', async (req, res) => {
    try {
        // Bank Capital
        const capitalResult = await pool.query('SELECT capital FROM bank_capital WHERE id = 1');
        const bankCapital = capitalResult.rows[0].capital;

        // Total money lent
        const lentMoneyResult = await pool.query('SELECT SUM(total_amount_due) FROM credits WHERE status = $1', ['approved']);
        const lentMoney = lentMoneyResult.rows[0].sum || 0;

        // Total client balance
        const clientCapitalResult = await pool.query('SELECT SUM(current_balance) FROM users WHERE role = $1 AND status = $2', ['client', 'active']);
        const clientCapital = clientCapitalResult.rows[0].sum || 0;

        // Capital history for graph
        const capitalHistoryResult = await pool.query('SELECT amount, created_at FROM capital_history ORDER BY created_at DESC LIMIT 30');
        const capitalHistory = capitalHistoryResult.rows;

        // Pending requests
        const pendingUsers = await pool.query('SELECT * FROM users WHERE status = $1', ['pending']);
        const pendingWithdrawals = await pool.query('SELECT * FROM withdrawal_requests WHERE status = $1', ['pending']);
        const pendingCredits = await pool.query('SELECT * FROM credit_requests WHERE status = $1', ['pending']);
        const pendingDeposits = await pool.query('SELECT * FROM deposit_requests WHERE status = $1', ['pending']);

        // Debtor clients
        const debtorClients = await pool.query('SELECT * FROM users WHERE id IN (SELECT user_id FROM credits WHERE status = $1 AND due_date < NOW())', ['approved']);
        const closeToDueClients = await pool.query('SELECT * FROM users WHERE id IN (SELECT user_id FROM credits WHERE status = $1 AND due_date < NOW() + INTERVAL \'7 days\' AND due_date > NOW())', ['approved']);

        res.status(200).json({
            bankCapital,
            lentMoney,
            clientCapital,
            capitalHistory,
            pendingUsers: pendingUsers.rows,
            pendingWithdrawals: pendingWithdrawals.rows,
            pendingCredits: pendingCredits.rows,
            pendingDeposits: pendingDeposits.rows,
            debtorClients: debtorClients.rows,
            closeToDueClients: closeToDueClients.rows
        });

    } catch (err) {
        console.error('Error fetching admin data:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// 6. Manage Admin Capital Endpoint
app.post('/api/admin/capital', async (req, res) => {
    const { action, amount, reason } = req.body;
    try {
        if (action === 'add') {
            await pool.query('UPDATE bank_capital SET capital = capital + $1 WHERE id = 1', [amount]);
            await pool.query('INSERT INTO capital_history (amount, transaction_type, description) VALUES ($1, $2, $3)', [amount, 'add', reason]);
        } else if (action === 'reduce') {
            await pool.query('UPDATE bank_capital SET capital = capital - $1 WHERE id = 1', [amount]);
            await pool.query('INSERT INTO capital_history (amount, transaction_type, description) VALUES ($1, $2, $3)', [-amount, 'reduce', reason]);
        } else {
            return res.status(400).json({ message: 'Invalid action.' });
        }
        res.status(200).json({ message: 'Bank capital updated successfully.' });
    } catch (err) {
        console.error('Error managing capital:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// 7. Admin Action Endpoint (Approve/Reject)
app.post('/api/admin/action', async (req, res) => {
    const { type, id, action } = req.body;
    try {
        if (type === 'user') {
            if (action === 'approve') {
                await pool.query('UPDATE users SET status = $1, current_balance = $2 WHERE id = $3', ['active', 1.00, id]);
                // Add initial $1 transaction
                const adminId = 'your-admin-id'; // You need to set a static admin ID
                await pool.query('INSERT INTO transactions (sender_id, receiver_id, amount, transaction_type) VALUES ($1, $2, $3, $4)', [adminId, id, 1.00, 'deposit']);
            } else if (action === 'reject') {
                await pool.query('DELETE FROM users WHERE id = $1', [id]);
            }
        } else if (type === 'withdrawal') {
            if (action === 'approve') {
                const withdrawal = await pool.query('SELECT * FROM withdrawal_requests WHERE id = $1', [id]);
                const withdrawalData = withdrawal.rows[0];
                await pool.query('UPDATE withdrawal_requests SET status = $1 WHERE id = $2', ['approved', id]);
                await pool.query('UPDATE users SET current_balance = current_balance - $1 WHERE id = $2', [withdrawalData.amount, withdrawalData.user_id]);
                await pool.query('INSERT INTO transactions (sender_id, receiver_id, amount, transaction_type) VALUES ($1, $2, $3, $4)', [withdrawalData.user_id, 'your-admin-id', withdrawalData.amount, 'withdrawal']);
            } else if (action === 'reject') {
                await pool.query('UPDATE withdrawal_requests SET status = $1 WHERE id = $2', ['rejected', id]);
            }
        } else if (type === 'credit') {
            if (action === 'approve') {
                const credit = await pool.query('SELECT * FROM credit_requests WHERE id = $1', [id]);
                const creditData = credit.rows[0];
                const totalAmountDue = creditData.amount * 1.10;
                const dueDate = new Date();
                dueDate.setDate(dueDate.getDate() + creditData.term_in_days);
                await pool.query('UPDATE credit_requests SET status = $1 WHERE id = $2', ['approved', id]);
                await pool.query('INSERT INTO credits (user_id, amount, total_amount_due, term_in_days, due_date, status) VALUES ($1, $2, $3, $4, $5, $6)', [creditData.user_id, creditData.amount, totalAmountDue, creditData.term_in_days, dueDate, 'approved']);
                await pool.query('UPDATE users SET current_balance = current_balance + $1 WHERE id = $2', [creditData.amount, creditData.user_id]);
                await pool.query('UPDATE bank_capital SET capital = capital - $1 WHERE id = 1', [creditData.amount]);
                await pool.query('INSERT INTO transactions (sender_id, receiver_id, amount, transaction_type) VALUES ($1, $2, $3, $4)', ['your-admin-id', creditData.user_id, creditData.amount, 'credit']);
            } else if (action === 'reject') {
                await pool.query('UPDATE credit_requests SET status = $1 WHERE id = $2', ['rejected', id]);
            }
        } else if (type === 'deposit') {
            if (action === 'approve') {
                const deposit = await pool.query('SELECT * FROM deposit_requests WHERE id = $1', [id]);
                const depositData = deposit.rows[0];
                const activeCredit = await pool.query('SELECT * FROM credits WHERE user_id = $1 AND status = $2', [depositData.user_id, 'approved']);
                if (activeCredit.rows.length > 0) {
                    const credit = activeCredit.rows[0];
                    const newTotalDue = credit.total_amount_due - depositData.amount;
                    await pool.query('UPDATE credits SET total_amount_due = $1 WHERE id = $2', [newTotalDue, credit.id]);
                } else {
                    await pool.query('UPDATE users SET current_balance = current_balance + $1 WHERE id = $2', [depositData.amount, depositData.user_id]);
                }
                await pool.query('UPDATE bank_capital SET capital = capital + $1 WHERE id = 1', [depositData.amount]);
                await pool.query('UPDATE deposit_requests SET status = $1 WHERE id = $2', ['approved', id]);
                await pool.query('INSERT INTO transactions (sender_id, receiver_id, amount, transaction_type) VALUES ($1, $2, $3, $4)', [depositData.user_id, 'your-admin-id', depositData.amount, 'deposit']);
            } else if (action === 'reject') {
                await pool.query('UPDATE deposit_requests SET status = $1 WHERE id = $2', ['rejected', id]);
            }
        } else {
            return res.status(400).json({ message: 'Invalid action type.' });
        }
        res.status(200).json({ message: `Request successfully ${action}ed.` });
    } catch (err) {
        console.error('Error with admin action:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// 8. Admin Client Management Endpoint
app.get('/api/admin/clients', async (req, res) => {
    try {
        const clients = await pool.query('SELECT id, first_name, last_name, id_card, email, phone, address, province, city, current_balance FROM users WHERE role = $1 AND status = $2', ['client', 'active']);
        res.status(200).json(clients.rows);
    } catch (err) {
        console.error('Error fetching client list for admin:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// 9. Admin Search Client Endpoint
app.get('/api/admin/clients/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const client = await pool.query('SELECT id, first_name, last_name, id_card, email, phone, address, province, city, current_balance FROM users WHERE id = $1', [id]);
        if (!client.rows.length) {
            return res.status(404).json({ message: 'Client not found.' });
        }
        res.status(200).json(client.rows[0]);
    } catch (err) {
        console.error('Error fetching single client data:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// 10. Admin Update Client Endpoint
app.put('/api/admin/clients/:id', async (req, res) => {
    const { id } = req.params;
    const { firstName, lastName, idCard, email, phone, address, province, city, currentBalance } = req.body;
    try {
        await pool.query(
            'UPDATE users SET first_name = $1, last_name = $2, id_card = $3, email = $4, phone = $5, address = $6, province = $7, city = $8, current_balance = $9 WHERE id = $10',
            [firstName, lastName, idCard, email, phone, address, province, city, currentBalance, id]
        );
        res.status(200).json({ message: 'Client information updated successfully.' });
    } catch (err) {
        console.error('Error updating client data:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// --------------------------------------------------------------------------
// --- Start the Server ---
// --------------------------------------------------------------------------

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
