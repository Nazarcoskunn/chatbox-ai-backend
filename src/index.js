import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import authRouter from './routes/auth.js'
import chatRouter from './routes/chat.js'
import documentsRouter from './routes/documents.js'
import areasRouter from './routes/areas.js'
import { testConnection } from './config/database.js'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

app.use('/api/auth', authRouter)
app.use('/api/chat', chatRouter)
app.use('/api/documents', documentsRouter)
app.use('/api/areas', areasRouter)

app.get('/health', (req, res) => {
  res.json({ status: 'ok', model: process.env.OLLAMA_MODEL })
})

async function start() {
  const dbOk = await testConnection()
  if (!dbOk) {
    console.error('❌ Veritabanı bağlantısı kurulamadı!')
  }

  // BACKENDLERİ BAGLAMAK İÇİN

app.get('/api/test-web-backend', async (_req, res) => {
  try {
    console.log('MAIN_API_URL:', process.env.MAIN_API_URL)

    const mainApiUrl = process.env.MAIN_API_URL

    if (!mainApiUrl) {
      return res.status(500).json({
        success: false,
        message: 'MAIN_API_URL .env dosyasından okunamadı.',
      })
    }

    const response = await fetch(`${mainApiUrl}/`)
    const data = await response.json()

    res.json({
      success: true,
      message: 'Web backend bağlantısı başarılı.',
      webBackendResponse: data,
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Web backend bağlantısı başarısız.',
      error: error.message,
    })
  }
})

app.get('/api/test-customers', async (_req, res) => {
  try {
    const response = await fetch(
      `${process.env.MAIN_API_URL}/api/customers`
    )

    if (!response.ok) {
      throw new Error(`Web backend ${response.status} hatası verdi.`)
    }

    const data = await response.json()

    res.json({
      success: true,
      message: 'Müşteri verileri başarıyla alındı.',
      data,
    })
  } catch (error) {
    console.error('Müşteri verisi çekme hatası:', error)

    res.status(500).json({
      success: false,
      message: 'Müşteri verileri alınamadı.',
      error: error.message,
    })
  }
})

  app.listen(PORT, () => {
    console.log(`🚀 Backend çalışıyor: http://localhost:${PORT}`)
    console.log(`🤖 Model: ${process.env.OLLAMA_MODEL}`)
  })
}


start()