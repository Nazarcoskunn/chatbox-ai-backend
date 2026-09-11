import { Router } from 'express'
import { authMiddleware, adminMiddleware } from '../middleware/auth.js'
import { query } from '../config/database.js'

const router = Router()

router.get('/',async (req,res) => {
    try{
        const result = await query(
            'SELECT id, name, created_at from areas ORDER BY created_at ASC'
        )
        res.json({ areas: result.rows})
    } catch(err){
        res.status(500).json({ error : " Alanlar getirilemedi"})
    }

})

// Yeni alan ekle (sadece admin)
router.post('/', authMiddleware, adminMiddleware, async (req, res) => {
  const { name } = req.body

  if (!name || name.trim().length === 0) {
    return res.status(400).json({ error: 'Alan adı gerekli' })
  }

  try {
    const result = await query(
      'INSERT INTO areas (name) VALUES ($1) RETURNING *',
      [name.trim()]
    )
    res.json({ area: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Alan eklenemedi' })
  }
})

// Alan sil (sadece admin)
router.delete('/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await query('DELETE FROM areas WHERE id = $1', [req.params.id])
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Alan silinemedi' })
  }
})

export default router
