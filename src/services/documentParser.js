import fs from 'fs'
import path from 'path'
import mammoth from 'mammoth'
import xlsx from 'xlsx'
import officeParser from 'officeparser'
import Tesseract from 'tesseract.js'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

async function extractPdfText(filePath) {
  const data = new Uint8Array(fs.readFileSync(filePath))
  const pdf = await getDocument({ data }).promise
  let text = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    text += content.items.map(item => item.str).join(' ') + '\n'
  }
  return text
}

export async function extractText(filePath, fileType) {
  const ext = fileType.toLowerCase()

  try {
    if (ext === 'pdf') {
      return await extractPdfText(filePath)

    } else if (ext === 'docx' || ext === 'doc') {
      const result = await mammoth.extractRawText({ path: filePath })
      return result.value

    } else if (ext === 'xlsx' || ext === 'xls') {
      const workbook = xlsx.readFile(filePath)
      let text = ''
      workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName]
        const csv = xlsx.utils.sheet_to_csv(sheet)
        text += `\n[${sheetName}]\n${csv}`
      })
      return text

    } else if (ext === 'csv') {
      return fs.readFileSync(filePath, 'utf-8')

    } else if (ext === 'pptx' || ext === 'ppt') {
      return new Promise((resolve, reject) => {
        officeParser.parseOffice(filePath, (text, err) => {
          if (err) reject(err)
          else resolve(text)
        })
      })

    } else if (ext === 'txt') {
      return fs.readFileSync(filePath, 'utf-8')

    } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
      const result = await Tesseract.recognize(filePath, 'tur+eng')
      return result.data.text

    } else {
      throw new Error(`Desteklenmeyen dosya tipi: ${ext}`)
    }

  } catch (err) {
    console.error(`[DocumentParser] Metin çıkarma hatası (${ext}):`, err.message)
    throw err
  }
}