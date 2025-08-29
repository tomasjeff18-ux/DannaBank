// Importar las librerías necesarias
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'); // Importar JWT para la autenticación

const app = express();
const port = process.env.PORT || 3000;
const jwtSecret = 'mi_secreto_super_secreto'; // DEBE SER UNA VARIABLE DE ENTORNO EN PRODUCCIÓN

// Middleware para procesar JSON en las peticiones
app.use(express.json());

// Configuración de la conexión a la base de datos
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Middleware para servir los archivos estáticos desde la carpeta 'public'
app.use(express.static('public'));

// Middleware para verificar el token JWT
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) {
        return res.sendStatus(401).json({ message: 'No se proporcionó un token de autenticación.' });
    }

    jwt.verify(token, jwtSecret, (err, user) => {
        if (err) {
            return res.sendStatus(403).json({ message: 'Token inválido.' });
        }
        req.user = user;
        next();
    });
};

// --------------------------------------------------------------------------
// --- Endpoints de la API ---\
// --------------------------------------------------------------------------

// 1. Endpoint para el registro de clientes
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

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Validar que la cédula del recomendador exista si se proporciona
        if (cedula_recomendador) {
            const recomendador = await client.query('SELECT id FROM users WHERE cedula = $1 AND role = $2', [cedula_recomendador, 'cliente']);
            if (recomendador.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'La cédula del recomendador no es válida.' });
            }
        }

        const checkUser = await client.query(
            'SELECT * FROM users WHERE correo = $1 OR cedula = $2', [correo, cedula]
        );
        if (checkUser.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'El correo o la cédula ya están registrados.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(contrasena, salt);

        const newUserQuery = `
            INSERT INTO users (
                nombres,
                apellidos,
                cedula,
                correo,
                contrasena,
                telefono,
                direccion,
                provincia,
                ciudad,
                cedula_recomendador,
                role
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *;
        `;
        const newUser = await client.query(newUserQuery, [
            nombres,
            apellidos,
            cedula,
            correo,
            hashedPassword,
            telefono,
            direccion,
            provincia,
            ciudad,
            cedula_recomendador,
            'cliente'
        ]);

        // Crear una cuenta de banco para el nuevo usuario
        await client.query('INSERT INTO cuentas (user_id) VALUES ($1)', [newUser.rows[0].id]);

        await client.query('COMMIT');
        res.status(201).json({ message: 'Registro exitoso. Ahora puedes iniciar sesión.' });
    } catch (err) {
        console.error('Error al registrar usuario:', err);
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Error interno del servidor.' });
    } finally {
        client.release();
    }
});

// 2. Endpoint para el inicio de sesión
app.post('/api/login', async (req, res) => {
    const { correo, contrasena } = req.body;

    try {
        const user = await pool.query('SELECT * FROM users WHERE correo = $1', [correo]);
        if (user.rows.length === 0) {
            return res.status(400).json({ message: 'Correo o contraseña incorrectos.' });
        }

        const isMatch = await bcrypt.compare(contrasena, user.rows[0].contrasena);
        if (!isMatch) {
            return res.status(400).json({ message: 'Correo o contraseña incorrectos.' });
        }

        const payload = {
            id: user.rows[0].id,
            email: user.rows[0].correo,
            role: user.rows[0].role
        };
        const token = jwt.sign(payload, jwtSecret, { expiresIn: '1h' });

        res.status(200).json({
            message: 'Inicio de sesión exitoso.',
            token,
            user: {
                id: user.rows[0].id,
                nombres: user.rows[0].nombres,
                role: user.rows[0].role
            }
        });
    } catch (err) {
        console.error('Error al iniciar sesión:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 3. Endpoint para obtener datos del cliente
app.get('/api/cliente/datos', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    if (req.user.role !== 'cliente') {
        return res.status(403).json({ message: 'Acceso denegado.' });
    }

    try {
        const cliente = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        const cuenta = await pool.query('SELECT * FROM cuentas WHERE user_id = $1', [userId]);
        const transacciones = await pool.query('SELECT * FROM transactions WHERE sender_id = $1 OR receiver_id = $1 ORDER BY created_at DESC', [userId]);
        const creditos = await pool.query('SELECT * FROM creditos WHERE user_id = $1 ORDER BY created_at DESC', [userId]);

        res.status(200).json({
            cliente: cliente.rows[0],
            cuenta: cuenta.rows[0],
            transacciones: transacciones.rows,
            creditos: creditos.rows
        });
    } catch (err) {
        console.error('Error al obtener datos del cliente:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 4. Endpoint para transferencias
app.post('/api/transferencia', authenticateToken, async (req, res) => {
    const { receiverCedula, amount } = req.body;
    const senderId = req.user.id;
    const client = await pool.connect();

    try {
        if (req.user.role !== 'cliente') {
            return res.status(403).json({ message: 'Acceso denegado.' });
        }

        await client.query('BEGIN');

        const senderAccount = await client.query('SELECT * FROM cuentas WHERE user_id = $1 FOR UPDATE', [senderId]);
        if (senderAccount.rows[0].balance < amount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Saldo insuficiente.' });
        }

        const receiverUser = await client.query('SELECT id FROM users WHERE cedula = $1', [receiverCedula]);
        if (receiverUser.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'El destinatario no existe.' });
        }
        const receiverId = receiverUser.rows[0].id;

        await client.query('UPDATE cuentas SET balance = balance - $1 WHERE user_id = $2', [amount, senderId]);
        await client.query('UPDATE cuentas SET balance = balance + $1 WHERE user_id = $2', [amount, receiverId]);
        await client.query('INSERT INTO transactions (sender_id, receiver_id, amount, transaction_type) VALUES ($1, $2, $3, $4)', [senderId, receiverId, amount, 'transferencia']);

        await client.query('COMMIT');
        res.status(200).json({ message: 'Transferencia realizada con éxito.' });
    } catch (err) {
        console.error('Error al realizar transferencia:', err);
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Error interno del servidor.' });
    } finally {
        client.release();
    }
});

// 5. Endpoint para solicitudes (depósito, retiro, crédito)
app.post('/api/solicitud', authenticateToken, async (req, res) => {
    const { tipo, monto, banco, cuenta, plazo } = req.body;
    const userId = req.user.id;
    if (req.user.role !== 'cliente') {
        return res.status(403).json({ message: 'Acceso denegado.' });
    }

    try {
        switch (tipo) {
            case 'deposito':
            case 'retiro':
                await pool.query('INSERT INTO withdrawal_requests (user_id, amount, status, bank, account_number) VALUES ($1, $2, $3, $4, $5)',
                    [userId, monto, 'pending', banco, cuenta]);
                break;
            case 'credito':
                await pool.query('INSERT INTO credit_requests (user_id, amount, status, plazo) VALUES ($1, $2, $3, $4)',
                    [userId, monto, 'pending', plazo]);
                break;
            default:
                return res.status(400).json({ message: 'Tipo de solicitud inválido.' });
        }
        res.status(201).json({ message: 'Solicitud enviada con éxito.' });
    } catch (err) {
        console.error('Error al enviar solicitud:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 6. Endpoint para obtener datos del administrador
app.get('/api/admin/datos', authenticateToken, async (req, res) => {
    if (req.user.role !== 'administrador') {
        return res.status(403).json({ message: 'Acceso denegado.' });
    }

    try {
        const solicitudes = await pool.query('SELECT * FROM credit_requests WHERE status = $1 ORDER BY created_at DESC', ['pending']);
        const retiros = await pool.query('SELECT * FROM withdrawal_requests WHERE status = $1 ORDER BY created_at DESC', ['pending']);
        const capital = await pool.query('SELECT capital FROM capital_banco WHERE id = 1');
        const usuarios = await pool.query('SELECT id, nombres, apellidos, cedula, correo, role FROM users'); // Corregido: 'rol' a 'role'

        res.status(200).json({
            solicitudes: solicitudes.rows,
            retiros: retiros.rows,
            capital: capital.rows[0].capital,
            usuarios: usuarios.rows
        });
    } catch (err) {
        console.error('Error al obtener datos del administrador:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 7. Endpoint para gestionar capital
app.post('/api/admin/capital', authenticateToken, async (req, res) => {
    if (req.user.role !== 'administrador') {
        return res.status(403).json({ message: 'Acceso denegado.' });
    }

    const { accion, monto, motivo } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const currentCapital = await client.query('SELECT capital FROM capital_banco WHERE id = 1 FOR UPDATE');
        const capitalValue = parseFloat(currentCapital.rows[0].capital);

        if (accion === 'aumentar') {
            await client.query('UPDATE capital_banco SET capital = capital + $1 WHERE id = 1', [monto]);
            await client.query('INSERT INTO capital_history (amount, transaction_type, description) VALUES ($1, $2, $3)', [monto, 'aumento', motivo]);
        } else if (accion === 'reducir') {
            if (capitalValue < monto) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'No se puede reducir el capital por debajo de 0.' });
            }
            await client.query('UPDATE capital_banco SET capital = capital - $1 WHERE id = 1', [monto]);
            await client.query('INSERT INTO capital_history (amount, transaction_type, description) VALUES ($1, $2, $3)', [-monto, 'reduccion', motivo]);
        } else {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Acción inválida.' });
        }
        await client.query('COMMIT');
        res.status(200).json({ message: 'Capital del banco actualizado con éxito.' });
    } catch (err) {
        console.error('Error al gestionar capital:', err);
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Error interno del servidor.' });
    } finally {
        client.release();
    }
});

// 8. Endpoint para aprobar solicitudes de crédito
app.post('/api/admin/aprobar_credito', authenticateToken, async (req, res) => {
    if (req.user.role !== 'administrador') {
        return res.status(403).json({ message: 'Acceso denegado.' });
    }
    const { solicitudId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const solicitud = await client.query('SELECT * FROM credit_requests WHERE id = $1 FOR UPDATE', [solicitudId]);
        if (solicitud.rows.length === 0 || solicitud.rows[0].status !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Solicitud no válida o ya procesada.' });
        }
        const { user_id, amount, plazo } = solicitud.rows[0];

        // Actualizar el saldo de la cuenta del usuario
        await client.query('UPDATE cuentas SET balance = balance + $1 WHERE user_id = $2', [amount, user_id]);
        // Insertar un nuevo crédito
        await client.query('INSERT INTO creditos (user_id, monto, plazo, estado) VALUES ($1, $2, $3, $4)', [user_id, amount, plazo, 'active']);
        // Marcar la solicitud como aprobada
        await client.query('UPDATE credit_requests SET status = $1 WHERE id = $2', ['approved', solicitudId]);

        await client.query('COMMIT');
        res.status(200).json({ message: 'Crédito aprobado con éxito.' });
    } catch (err) {
        console.error('Error al aprobar crédito:', err);
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Error interno del servidor.' });
    } finally {
        client.release();
    }
});

// 9. Endpoint para obtener el historial del capital
app.get('/api/admin/capital/historial', authenticateToken, async (req, res) => {
    if (req.user.role !== 'administrador') {
        return res.status(403).json({ message: 'Acceso denegado.' });
    }
    try {
        const historial = await pool.query(
            'SELECT created_at, amount, transaction_type, description FROM capital_history ORDER BY created_at DESC LIMIT 30'
        );
        res.status(200).json(historial.rows);
    } catch (err) {
        console.error('Error al obtener el historial de capital:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// --------------------------------------------------------------------------
// --- Iniciar el Servidor (ESTA LÍNEA DEBE IR AL FINAL) ---\
// --------------------------------------------------------------------------

app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
});
