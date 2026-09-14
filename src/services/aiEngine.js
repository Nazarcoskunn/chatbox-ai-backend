import dotenv from 'dotenv'
import { query } from '../config/database.js'
import * as cheerio from 'cheerio'
import { Agent, fetch as undiciFetch } from 'undici'

dotenv.config({ override: true })

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b'
const MAX_DOCUMENT_CHARACTERS = 20000
const MAX_FILE_CHARACTERS = 10000
const MAX_HISTORY_MESSAGES = 10

const ollamaAgent = new Agent({
  headersTimeout: 600000,
  bodyTimeout: 600000,
  connectTimeout: 30000,
})

console.log('[AIEngine] Ollama URL:', OLLAMA_URL)
console.log('[AIEngine] Ollama Model:', OLLAMA_MODEL)

async function scrapeWebsite(url) {
  try {
    console.log('[Scraper] Taranıyor:', url)
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    })
    const html = await res.text()
    const $ = cheerio.load(html)
    $('script, style, nav, footer, iframe, img, svg, noscript').remove()
    const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 5000)
    console.log('[Scraper] Çıkarılan metin:', text.length, 'karakter')
    return text
  } catch (err) {
    console.error('[Scraper] Hata:', err.message)
    return ''
  }
}

async function webSearch(query_text) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query_text)}&format=json&no_html=1&skip_disambig=1`
    const res = await fetch(url)
    const data = await res.json()
    const results = []
    if (data.AbstractText) results.push(data.AbstractText)
    if (data.RelatedTopics) {
      data.RelatedTopics.slice(0, 3).forEach(topic => {
        if (topic.Text) results.push(topic.Text)
      })
    }
    if (results.length === 0) return 'Web aramasında sonuç bulunamadı.'
    return results.join('\n\n')
  } catch (err) {
    console.error('[WebSearch] Hata:', err.message)
    return 'Web araması başarısız oldu.'
  }
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Bilgi tabanında cevap bulunamazsa internette arama yapar. Sadece gerektiğinde kullan.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Arama sorgusu' }
        },
        required: ['query']
      }
    }
  }
]

async function getAreaDocuments(areaId) {
  try {
    let result
    if (areaId) {
      result = await query(
        `SELECT d.filename, d.content, a.name AS area_name
         FROM documents d JOIN areas a ON d.area_id = a.id
         WHERE d.area_id = $1 ORDER BY d.created_at DESC`,
        [Number(areaId)]
      )
    } else {
      result = await query(
        `SELECT d.filename, d.content, a.name AS area_name
         FROM documents d JOIN areas a ON d.area_id = a.id
         ORDER BY a.name, d.created_at DESC`
      )
    }
    if (result.rows.length === 0) return ''
    return result.rows
      .map(doc => `[${doc.area_name} - ${doc.filename}]\n${String(doc.content ?? '')}`)
      .join('\n\n---\n\n')
  } catch (error) {
    console.error('[AIEngine] Doküman çekme hatası:', error.message)
    return ''
  }
}

async function getConversationHistory(sessionId) {
  if (!sessionId) return []
  try {
    const result = await query(
      `SELECT role, content FROM conversations
       WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [sessionId, MAX_HISTORY_MESSAGES]
    )
    return result.rows.reverse()
  } catch (error) {
    console.error('[AIEngine] Geçmiş çekme hatası:', error.message)
    return []
  }
}

async function saveMessage(sessionId, role, content) {
  if (!sessionId || !content) return
  try {
    await query(
      `INSERT INTO conversations (session_id, role, content) VALUES ($1, $2, $3)`,
      [sessionId, role, content]
    )
  } catch (error) {
    console.error('[AIEngine] Mesaj kaydetme hatası:', error.message)
  }
}

async function callOllama(messages, useTools = false) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 600000)

  try {
    const body = {
      model: OLLAMA_MODEL,
      messages,
      stream: false,
      think: false,
      keep_alive: '10m',
      options: {
        temperature: 0.3,
        num_ctx: 2048,
        num_predict: 150,
      },
    }

    if (useTools) body.tools = TOOLS

    const response = await undiciFetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(body),
      dispatcher: ollamaAgent,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Ollama hatası ${response.status}: ${errorText}`)
    }

    return await response.json()
  } catch (err) {
    clearTimeout(timeout)
    throw err
  }
}

export async function processMessage({ message, sessionId, areaId, fileContent, pageUrl }) {
  const normalizedMessage = String(message ?? '').trim()
  if (!normalizedMessage) throw new Error('Mesaj boş olamaz.')

  const allAreaDocuments = await getAreaDocuments(areaId)
  const areaDocuments = allAreaDocuments.slice(0, MAX_DOCUMENT_CHARACTERS)
  const uploadedFileContent = String(fileContent ?? '').slice(0, MAX_FILE_CHARACTERS)
  const history = await getConversationHistory(sessionId)

  let websiteContent = ''
  if (pageUrl) {
    websiteContent = await scrapeWebsite(pageUrl)
  }

  console.log('[AIEngine] Bilgi tabanı:', areaDocuments.length, 'karakter')
  console.log('[AIEngine] Yüklenen dosya:', uploadedFileContent.length, 'karakter')
  console.log('[AIEngine] Web sitesi:', websiteContent.length, 'karakter')
  console.log('[AIEngine] Geçmiş:', history.length, 'mesaj')

  let systemPrompt = `Sen bir kurumsal yapay zeka asistanısın. Her zaman Türkçe cevap ver.
SADECE son cevabı yaz, düşünce sürecini, adımları veya iç monologu ASLA yazma.
Direkt ve kısa cevap ver.
Kullanıcının sorularını önce aşağıdaki bilgi tabanına göre yanıtla.
Bilgi tabanında cevap bulamazsan web_search aracını kullanarak internette ara..`

  if (areaDocuments) {
    systemPrompt += `\n\n=== ŞİRKET BİLGİ TABANI ===\n${areaDocuments}`
  }

  if (websiteContent) {
    systemPrompt += `\n\n=== MEVCUT WEB SAYFASI İÇERİĞİ ===\n${websiteContent}`
  }

  if (uploadedFileContent) {
    systemPrompt += `\n\n=== KULLANICININ YÜKLEDİĞİ DOSYA ===\n${uploadedFileContent}`
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: normalizedMessage },
  ]

  let data = await callOllama(messages, false)

  if (data?.message?.tool_calls?.length > 0) {
    const toolCall = data.message.tool_calls[0]
    const toolName = toolCall.function.name
    const toolArgs = toolCall.function.arguments

    console.log(`[AIEngine] Tool çağrısı: ${toolName}`, toolArgs)

    let toolResult = ''
    if (toolName === 'web_search') {
      const searchQuery = typeof toolArgs === 'string'
        ? JSON.parse(toolArgs).query
        : toolArgs.query
      console.log('[AIEngine] Web arama:', searchQuery)
      toolResult = await webSearch(searchQuery)
    }

    const messagesWithTool = [
      ...messages,
      data.message,
      { role: 'tool', content: toolResult, name: toolName }
    ]

    data = await callOllama(messagesWithTool, false)
  }

  let reply = data?.message?.content?.trim()
reply = reply?.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  if (!reply) throw new Error('Ollama geçerli bir cevap üretmedi.')

  if (sessionId) {
    await saveMessage(sessionId, 'user', normalizedMessage)
    await saveMessage(sessionId, 'assistant', reply)
  }

  return { reply, sessionId }
}
