import { Router } from 'express'
import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
dotenv.config()

const router = Router()

router.post('/admin-login', (req, res) => {
  const { pin } = req.body

  console.log('Gelen PIN:', pin)
  console.log('ENV PIN:', process.env.ADMIN_PIN)

  if (!pin) {
    return res.status(400).json({ error: 'PIN gerekli' })
  }

  if (pin !== process.env.ADMIN_PIN) {
    return res.status(401).json({ error: 'Hatalı PIN' })
  }

  const token = jwt.sign(
    { role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  )

  res.json({ token, role: 'admin' })
})

export default router