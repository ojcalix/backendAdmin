const jwt = require('jsonwebtoken');
const SECRET_KEY = 'secreto_super_seguro'; // Mismo secreto usado en login

module.exports = (req, res, next) => {
    const token = req.headers['authorization'];

    if (!token) {
        return res.status(403).json({ success: false, message: 'Token requerido' });
    }

    jwt.verify(token, SECRET_KEY, (err, decoded) => {
        if (err) {
            return res.status(401).json({ success: false, message: 'Token inválido' });
        }
        req.user = decoded; // Guarda la info del usuario en `req.user`
        next();
    });
};
