// Importar las librerías necesarias
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const app = express();
const port = process.env.PORT || 3000;

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

// --------------------------------------------------------------------------
// --- Endpoints de la API ---
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

    try {
        const checkUser = await pool.query(
            'SELECT * FROM usuarios WHERE correo = $1 OR cedula = $2', [correo, cedula]
        );
        if (checkUser.rows.length > 0) {
            return res.status(409).json({ message: 'El correo o la cédula ya están registrados.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(contrasena, salt);

        await pool.query(
            `INSERT INTO usuarios (nombres, apellidos, cedula, correo, contrasena, telefono, direccion, provincia, ciudad, cedula_recomendador)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [nombres, apellidos, cedula, correo, hashedPassword, telefono, direccion, provincia, ciudad, cedula_recomendador]
        );

        res.status(201).json({ message: 'Registro exitoso. Ahora puedes iniciar sesión.' });
    } catch (err) {
        console.error('Error al registrar usuario:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 2. Endpoint para el inicio de sesión
app.post('/api/login', async (req, res) => {
    const { correo, contrasena } = req.body;
    try {
        const user = await pool.query(
            'SELECT id, nombres, apellidos, contrasena, rol FROM usuarios WHERE correo = $1', [correo]
        );
        if (user.rows.length === 0) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        const foundUser = user.rows[0];

        const isMatch = await bcrypt.compare(contrasena, foundUser.contrasena);
        if (!isMatch) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }
        
        res.status(200).json({
            message: 'Inicio de sesión exitoso.',
            rol: foundUser.rol,
            user: {
                id: foundUser.id,
                nombres: foundUser.nombres,
                apellidos: foundUser.apellidos
            }
        });

    } catch (err) {
        console.error('Error al iniciar sesión:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 3. Endpoint para obtener los datos del cliente
app.get('/api/cliente/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const datosCliente = await pool.query(
            'SELECT nombres, apellidos, saldo_actual, cedula_recomendador, correo FROM usuarios WHERE id = $1', [id]
        );
        const historialMovimientos = await pool.query(
            'SELECT tipo, monto, fecha, estado, motivo FROM movimientos WHERE usuario_id = $1 ORDER BY fecha DESC', [id]
        );
        const historialCreditos = await pool.query(
            'SELECT monto_solicitado, monto_total_a_pagar, fecha_vencimiento, estado FROM creditos WHERE usuario_id = $1 ORDER BY fecha_solicitud DESC', [id]
        );
        const totalCreditos = await pool.query(
            'SELECT SUM(monto_solicitado) AS total FROM creditos WHERE usuario_id = $1 AND estado = \'aprobado\'', [id]
        );

        if (datosCliente.rows.length === 0) {
            return res.status(404).json({ message: 'Cliente no encontrado.' });
        }
        
        res.status(200).json({
            cliente: datosCliente.rows[0],
            movimientos: historialMovimientos.rows,
            creditos: historialCreditos.rows,
            total_creditos: totalCreditos.rows[0].total || 0
        });

    } catch (err) {
        console.error('Error al obtener datos del cliente:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 4. Endpoint para enviar solicitudes (depósito, retiro, crédito)
app.post('/api/solicitud', async (req, res) => {
    const { usuario_id, tipo, monto, banco, cuenta, plazo } = req.body;
    try {
        // Validación básica
        if (!usuario_id || !tipo || isNaN(monto) || monto <= 0) {
            return res.status(400).json({ message: 'Datos de solicitud incompletos o inválidos.' });
        }

        if (tipo === 'deposito' || tipo === 'retiro') {
            await pool.query(
                'INSERT INTO movimientos (usuario_id, tipo, monto, estado, banco, cuenta) VALUES ($1, $2, $3, \'pendiente\', $4, $5)',
                [usuario_id, tipo, monto, banco || null, cuenta || null]
            );
        } else if (tipo === 'credito') {
            const interes = 10.00;
            const montoTotal = monto + (monto * (interes / 100));
            const fechaVencimiento = new Date();
            fechaVencimiento.setDate(fechaVencimiento.getDate() + parseInt(plazo));

            await pool.query(
                `INSERT INTO creditos (usuario_id, monto_solicitado, plazo_dias, interes, monto_total_a_pagar, fecha_vencimiento, estado)
                 VALUES ($1, $2, $3, $4, $5, $6, 'pendiente')`,
                [usuario_id, monto, plazo, interes, montoTotal, fechaVencimiento]
            );
        }

        res.status(201).json({ message: `Solicitud de ${tipo} enviada con éxito. Espera la aprobación del administrador.` });

    } catch (err) {
        console.error('Error al procesar la solicitud:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 5. Endpoint para el panel de administrador
app.get('/api/admin/dashboard', async (req, res) => {
    try {
        const [
            usuarios,
            solicitudesDeposito,
            solicitudesRetiro,
            solicitudesCredito,
            capitalBanco
        ] = await Promise.all([
            pool.query('SELECT COUNT(*) AS total_usuarios FROM usuarios'),
            pool.query('SELECT m.*, u.nombres, u.apellidos, u.cedula FROM movimientos m INNER JOIN usuarios u ON m.usuario_id = u.id WHERE m.estado = \'pendiente\' AND m.tipo = \'deposito\' ORDER BY m.fecha DESC'),
            pool.query('SELECT m.*, u.nombres, u.apellidos, u.cedula FROM movimientos m INNER JOIN usuarios u ON m.usuario_id = u.id WHERE m.estado = \'pendiente\' AND m.tipo = \'retiro\' ORDER BY m.fecha DESC'),
            pool.query('SELECT c.*, u.nombres, u.apellidos, u.cedula FROM creditos c INNER JOIN usuarios u ON c.usuario_id = u.id WHERE c.estado = \'pendiente\' ORDER BY c.fecha_solicitud DESC'),
            pool.query('SELECT capital FROM capital_banco LIMIT 1')
        ]);

        res.status(200).json({
            total_usuarios: usuarios.rows[0].total_usuarios,
            solicitudes_deposito: solicitudesDeposito.rows,
            solicitudes_retiro: solicitudesRetiro.rows,
            solicitudes_credito: solicitudesCredito.rows,
            capital_banco: capitalBanco.rows[0].capital || 0
        });

    } catch (err) {
        console.error('Error al obtener datos del dashboard del admin:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});


// 6. Endpoint para gestionar transacciones (aprobar/rechazar)
app.post('/api/admin/transaccion/:tipo/:id', async (req, res) => {
    const { tipo, id } = req.params;
    const { accion } = req.body;
    try {
        await pool.query('BEGIN');

        if (accion === 'aprobar') {
            if (tipo === 'deposito') {
                const deposito = await pool.query('SELECT * FROM movimientos WHERE id = $1', [id]);
                if (deposito.rows.length === 0) throw new Error('Depósito no encontrado.');
                await pool.query('UPDATE usuarios SET saldo_actual = saldo_actual + $1 WHERE id = $2', [deposito.rows[0].monto, deposito.rows[0].usuario_id]);
                await pool.query('UPDATE movimientos SET estado = \'aprobado\' WHERE id = $1', [id]);
            } else if (tipo === 'retiro') {
                const retiro = await pool.query('SELECT * FROM movimientos WHERE id = $1', [id]);
                if (retiro.rows.length === 0) throw new Error('Retiro no encontrado.');
                await pool.query('UPDATE usuarios SET saldo_actual = saldo_actual - $1 WHERE id = $2', [retiro.rows[0].monto, retiro.rows[0].usuario_id]);
                await pool.query('UPDATE movimientos SET estado = \'aprobado\' WHERE id = $1', [id]);
            } else if (tipo === 'credito') {
                const credito = await pool.query('SELECT * FROM creditos WHERE id = $1', [id]);
                if (credito.rows.length === 0) throw new Error('Crédito no encontrado.');
                await pool.query('UPDATE usuarios SET saldo_actual = saldo_actual + $1 WHERE id = $2', [credito.rows[0].monto_solicitado, credito.rows[0].usuario_id]);
                await pool.query('UPDATE creditos SET estado = \'aprobado\' WHERE id = $1', [id]);
                await pool.query('UPDATE capital_banco SET capital = capital - $1', [credito.rows[0].monto_solicitado]);
                await pool.query('INSERT INTO historial_capital (monto_cambio, motivo) VALUES ($1, $2)', [-credito.rows[0].monto_solicitado, 'Préstamo de crédito']);
            }
        } else if (accion === 'rechazar') {
            if (tipo === 'deposito' || tipo === 'retiro') {
                await pool.query('UPDATE movimientos SET estado = \'rechazado\' WHERE id = $1', [id]);
            } else if (tipo === 'credito') {
                await pool.query('UPDATE creditos SET estado = \'rechazado\' WHERE id = $1', [id]);
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

// 7. Endpoint para gestionar capital del banco
app.post('/api/admin/capital', async (req, res) => {
    const { accion, monto, motivo } = req.body;

    try {
        if (accion === 'agregar') {
            await pool.query('UPDATE capital_banco SET capital = capital + $1', [monto]);
            await pool.query('INSERT INTO historial_capital (monto_cambio, motivo) VALUES ($1, $2)', [monto, motivo]);
        } else if (accion === 'reducir') {
            await pool.query('UPDATE capital_banco SET capital = capital - $1', [monto]);
            await pool.query('INSERT INTO historial_capital (monto_cambio, motivo) VALUES ($1, $2)', [-monto, motivo]);
        } else {
            return res.status(400).json({ message: 'Acción inválida.' });
        }
        res.status(200).json({ message: 'Capital del banco actualizado con éxito.' });
    } catch (err) {
        console.error('Error al gestionar capital:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 8. Endpoint para obtener el historial del capital
app.get('/api/admin/capital/historial', async (req, res) => {
    try {
        const historial = await pool.query(
            'SELECT fecha, monto_cambio, motivo FROM historial_capital ORDER BY fecha DESC LIMIT 30'
        );
        res.status(200).json(historial.rows);
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