import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { pipeline } from 'stream/promises'

import { authMiddleware, adminMiddleware } from '../middleware/auth.js'
import { extractText } from '../services/documentParser.js'
import { query } from '../config/database.js'

const router = Router()
const fsPromises = fs.promises

// Uygulamanın hangi klasörden çalıştırıldığından bağımsız, mutlak yol.
const uploadDir = path.resolve(process.cwd(), 'uploads')

await fsPromises.mkdir(uploadDir, { recursive: true })

const allowedMimeTypes = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/webp',
])

const mimeTypesByExtension = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv; charset=utf-8',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, uploadDir)
  },

  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase()
    const uniqueFilename = `${Date.now()}-${crypto.randomUUID()}${extension}`

    callback(null, uniqueFilename)
  },
})

const upload = multer({
  storage,

  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },

  fileFilter: (_req, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return callback(new Error('Desteklenmeyen dosya tipi'))
    }

    callback(null, true)
  },
})

function isPositiveInteger(value) {
  return /^\d+$/.test(String(value)) && Number(value) > 0
}

async function fileExists(filePath) {
  try {
    await fsPromises.access(filePath)
    return true
  } catch {
    return false
  }
}

async function removeFile(filePath) {
  if (!filePath) return

  try {
    await fsPromises.unlink(filePath)
  } catch (error) {
    // Dosya zaten yoksa bunu hata olarak değerlendirmiyoruz.
    if (error.code !== 'ENOENT') {
      throw error
    }
  }
}

function getDownloadHeader(filename) {
  // Header kırılmalarını önlemek için tehlikeli karakterleri temizliyoruz.
  const safeFilename = filename
    .replace(/[\r\n"]/g, '')
    .replace(/[^\x20-\x7E]/g, '_')

  const encodedFilename = encodeURIComponent(filename)

  return `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`
}

// Doküman yükle
router.post(
  '/upload',
  authMiddleware,
  adminMiddleware,
  upload.single('file'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: 'Dosya gerekli',
      })
    }

    const filePath = req.file.path
    const { areaId } = req.body

    if (!isPositiveInteger(areaId)) {
      await removeFile(filePath)

      return res.status(400).json({
        error: 'Geçerli bir alan ID gönderilmelidir',
      })
    }

    const fileType = path
      .extname(req.file.originalname)
      .slice(1)
      .toLowerCase()

    try {
      console.log(
        `[Documents] Metin çıkarılıyor: ${req.file.originalname}`,
      )

      const extractedContent = await extractText(filePath, fileType)
      const content = String(extractedContent ?? '')

      const result = await query(
        `
          INSERT INTO documents (
            area_id,
            filename,
            content,
            file_type,
            file_path
          )
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, area_id, filename, file_type, file_path, created_at
        `,
        [
          Number(areaId),
          req.file.originalname,
          content,
          fileType,
          filePath,
        ],
      )

      console.log(
        `[Documents] Kaydedildi: ${req.file.originalname} → ${filePath}`,
      )

      return res.status(201).json({
        success: true,
        document: result.rows[0],
        contentLength: content.length,
      })
    } catch (error) {
      await removeFile(filePath)

      console.error('[Documents] Yükleme hatası:', error)

      return res.status(500).json({
        error: 'Doküman işlenemedi',
      })
    }
  },
)

// Alana ait dokümanları getir
router.get(
  '/area/:areaId',
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const { areaId } = req.params

    if (!isPositiveInteger(areaId)) {
      return res.status(400).json({
        error: 'Geçerli bir alan ID gönderilmelidir',
      })
    }

    try {
      const result = await query(
        `
          SELECT
            id,
            filename,
            file_type,
            created_at
          FROM documents
          WHERE area_id = $1
          ORDER BY created_at DESC
        `,
        [Number(areaId)],
      )

      return res.json({
        documents: result.rows,
      })
    } catch (error) {
      console.error('[Documents] Listeleme hatası:', error)

      return res.status(500).json({
        error: 'Dokümanlar getirilemedi',
      })
    }
  },
)

// Doküman indir
router.get(
  '/download/:id',
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const { id } = req.params

    if (!isPositiveInteger(id)) {
      return res.status(400).json({
        error: 'Geçerli bir doküman ID gönderilmelidir',
      })
    }

    try {
      const result = await query(
        `
          SELECT
            filename,
            content,
            file_type,
            file_path
          FROM documents
          WHERE id = $1
        `,
        [Number(id)],
      )

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Doküman bulunamadı',
        })
      }

      const document = result.rows[0]

      if (
        document.file_path &&
        await fileExists(document.file_path)
      ) {
        const contentType =
          mimeTypesByExtension[document.file_type] ??
          'application/octet-stream'

        res.setHeader('Content-Type', contentType)
        res.setHeader(
          'Content-Disposition',
          getDownloadHeader(document.filename),
        )

        await pipeline(
          fs.createReadStream(document.file_path),
          res,
        )

        return
      }

      // Orijinal dosya bulunamazsa çıkarılan metni indir.
      res.setHeader(
        'Content-Disposition',
        getDownloadHeader(`${document.filename}.txt`),
      )
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')

      return res.send(document.content ?? '')
    } catch (error) {
      console.error('[Documents] İndirme hatası:', error)

      if (res.headersSent) {
        return res.end()
      }

      return res.status(500).json({
        error: 'İndirme sırasında bir hata oluştu',
      })
    }
  },
)

// Doküman sil
router.delete(
  '/:id',
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const { id } = req.params

    if (!isPositiveInteger(id)) {
      return res.status(400).json({
        error: 'Geçerli bir doküman ID gönderilmelidir',
      })
    }

    try {
      const result = await query(
        `
          DELETE FROM documents
          WHERE id = $1
          RETURNING id, file_path
        `,
        [Number(id)],
      )

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Doküman bulunamadı',
        })
      }

      const deletedDocument = result.rows[0]

      try {
        await removeFile(deletedDocument.file_path)
      } catch (fileError) {
        // DB kaydı silindiği için kullanıcıya işlemi başarısız göstermiyoruz.
        // Ancak sunucuda kalan dosyanın daha sonra temizlenmesi gerekir.
        console.error(
          '[Documents] Fiziksel dosya silinemedi:',
          fileError,
        )
      }

      return res.json({
        success: true,
        message: 'Doküman silindi',
      })
    } catch (error) {
      console.error('[Documents] Silme hatası:', error)

      return res.status(500).json({
        error: 'Doküman silinemedi',
      })
    }
  },
)

// Multer hatalarını JSON olarak döndür.
router.use((error, _req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'Dosya boyutu en fazla 10 MB olabilir',
      })
    }

    return res.status(400).json({
      error: 'Dosya yükleme hatası',
    })
  }

  if (error?.message === 'Desteklenmeyen dosya tipi') {
    return res.status(415).json({
      error: error.message,
    })
  }

  return next(error)
})

// Geçici dosya yükle, metin çıkar, dosyayı sakla (DB'ye kaydetme)
router.post('/extract', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Dosya gerekli' })
  }

  const filePath = req.file.path
  const fileType = path.extname(req.file.originalname).replace('.', '').toLowerCase()

  try {
    const content = await extractText(filePath, fileType)
    fs.unlinkSync(filePath) // Geçici dosyayı sil
    res.json({ content, filename: req.file.originalname })
  } catch (err) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    res.status(500).json({ error: 'Metin çıkarılamadı', detail: err.message })
  }
})

export default router