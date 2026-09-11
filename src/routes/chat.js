import { Router } from 'express'
import { processMessage } from '../services/aiEngine.js'
import { query } from '../config/database.js'
import { v4 as uuidv4 } from 'uuid'

const router = Router()

// Mesaj gönder
router.post('/', async (req, res) => {
  const { message, sessionId, areaId, fileContent, pageUrl } = req.body

  if (!message?.trim()) {
    return res.status(400).json({ error: 'Mesaj gerekli' })
  }

  const sid = sessionId || uuidv4()

  try {
    const result = await processMessage({
      message,
      sessionId: sid,
      areaId,
      fileContent,
      pageUrl,
    })

    res.json({
      reply: result.reply,
      sessionId: sid,
    })
  } catch (err) {
    console.error('[Chat] Hata:', err)
    res.status(500).json({ error: 'AI bağlantı hatası', detail: err.message })
  }
})

// Sohbet geçmişini getir
router.get('/history', async (_req, res) => {
  try {
    const result = await query(`
      SELECT session_id, MIN(content) AS preview, MIN(created_at) AS created_at
      FROM conversations
      WHERE role = 'user'
      GROUP BY session_id
      ORDER BY MIN(created_at) DESC
      LIMIT 20
    `)
    res.json({ history: result.rows })
  } catch (err) {
    console.error('[Chat] Geçmiş getirme hatası:', err)
    res.status(500).json({ error: 'Geçmiş getirilemedi' })
  }
})

// Belirli sohbetin mesajlarını getir
router.get('/history/:sessionId', async (req, res) => {
  try {
    const result = await query(
      `SELECT role, content, created_at FROM conversations
       WHERE session_id = $1 ORDER BY created_at ASC`,
      [req.params.sessionId]
    )
    res.json({ messages: result.rows })
  } catch (err) {
    console.error('[Chat] Mesaj getirme hatası:', err)
    res.status(500).json({ error: 'Mesajlar getirilemedi' })
  }
})

// Sohbet sil
router.delete('/history/:sessionId', async (req, res) => {
  try {
    await query('DELETE FROM conversations WHERE session_id = $1', [req.params.sessionId])
    res.json({ success: true })
  } catch (err) {
    console.error('[Chat] Sohbet silme hatası:', err)
    res.status(500).json({ error: 'Sohbet silinemedi' })
  }
})

export default router