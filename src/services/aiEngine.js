import dotenv from 'dotenv'
import { query } from '../config/database.js'
import * as cheerio from 'cheerio'
import { Agent, fetch as undiciFetch } from 'undici'

dotenv.config({ override: true })

const OLLAMA_URL =
  process.env.OLLAMA_URL || 'http://127.0.0.1:11434'

const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL || 'qwen3:8b'

const MAX_DOCUMENT_CHARACTERS = 12000
const MAX_FILE_CHARACTERS = 8000
const MAX_HISTORY_MESSAGES = 6
const MAX_WEBSITE_CHARACTERS = 3000
const MAX_WEB_RESULT_CHARACTERS = 5000

const WEB_SEARCH_MARKER = '__WEB_SEARCH__'

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
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }

    const html = await res.text()
    const $ = cheerio.load(html)

    $(
      'script, style, nav, footer, iframe, img, svg, noscript'
    ).remove()

    const text = $('body')
      .text()
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_WEBSITE_CHARACTERS)

    console.log(
      '[Scraper] Çıkarılan metin:',
      text.length,
      'karakter'
    )

    return text
  } catch (err) {
    console.error('[Scraper] Hata:', err.message)
    return ''
  }
}

async function webSearch(queryText) {
  try {
    console.log('[WebSearch] Aranıyor:', queryText)

    const url =
      `https://api.duckduckgo.com/?q=${encodeURIComponent(queryText)}` +
      '&format=json&no_html=1&skip_disambig=1'

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }

    const data = await res.json()
    const results = []

    if (data.AbstractText) {
      results.push(data.AbstractText)
    }

    if (Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics.slice(0, 4)) {
        if (topic?.Text) {
          results.push(topic.Text)
        }

        if (Array.isArray(topic?.Topics)) {
          for (const subTopic of topic.Topics.slice(0, 2)) {
            if (subTopic?.Text) {
              results.push(subTopic.Text)
            }
          }
        }
      }
    }

    if (results.length === 0) {
      console.log('[WebSearch] Sonuç bulunamadı.')
      return ''
    }

    const resultText = results
      .slice(0, 5)
      .join('\n\n')
      .slice(0, MAX_WEB_RESULT_CHARACTERS)

    console.log(
      '[WebSearch] Sonuç bulundu:',
      resultText.length,
      'karakter'
    )

    return resultText
  } catch (err) {
    console.error('[WebSearch] Hata:', err.message)
    return ''
  }
}

async function getAreaDocuments(areaId) {
  try {
    let result

    if (areaId) {
      result = await query(
        `SELECT
           d.filename,
           d.content,
           a.name AS area_name
         FROM documents d
         JOIN areas a ON d.area_id = a.id
         WHERE d.area_id = $1
         ORDER BY d.created_at DESC`,
        [Number(areaId)]
      )
    } else {
      result = await query(
        `SELECT
           d.filename,
           d.content,
           a.name AS area_name
         FROM documents d
         JOIN areas a ON d.area_id = a.id
         ORDER BY a.name, d.created_at DESC`
      )
    }

    if (result.rows.length === 0) {
      return ''
    }

    return result.rows
      .map((doc) => {
        const areaName = String(
          doc.area_name ?? ''
        ).trim()

        const filename = String(
          doc.filename ?? ''
        ).trim()

        const content = String(
          doc.content ?? ''
        ).trim()

        return `[${areaName} - ${filename}]\n${content}`
      })
      .join('\n\n---\n\n')
  } catch (error) {
    console.error(
      '[AIEngine] Doküman çekme hatası:',
      error.message
    )

    return ''
  }
}

async function getConversationHistory(sessionId) {
  if (!sessionId) {
    return []
  }

  try {
    const result = await query(
      `SELECT role, content
       FROM conversations
       WHERE session_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [sessionId, MAX_HISTORY_MESSAGES]
    )

    return result.rows.reverse()
  } catch (error) {
    console.error(
      '[AIEngine] Geçmiş çekme hatası:',
      error.message
    )

    return []
  }
}

async function saveMessage(
  sessionId,
  role,
  content
) {
  if (!sessionId || !content) {
    return
  }

  try {
    await query(
      `INSERT INTO conversations
       (session_id, role, content)
       VALUES ($1, $2, $3)`,
      [sessionId, role, content]
    )
  } catch (error) {
    console.error(
      '[AIEngine] Mesaj kaydetme hatası:',
      error.message
    )
  }
}

async function callOllama(messages) {
  const controller = new AbortController()

  const timeout = setTimeout(() => {
    controller.abort()
  }, 600000)

  try {
    const body = {
      model: OLLAMA_MODEL,
      messages,
      stream: false,
      think: false,
      keep_alive: '30m',
      options: {
        temperature: 0.2,
        num_ctx: 2048,
        num_predict: 180,
      },
    }

    const response = await undiciFetch(
      `${OLLAMA_URL}/api/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify(body),
        dispatcher: ollamaAgent,
      }
    )

    clearTimeout(timeout)

    if (!response.ok) {
      const errorText = await response.text()

      throw new Error(
        `Ollama hatası ${response.status}: ${errorText}`
      )
    }

    return await response.json()
  } catch (err) {
    clearTimeout(timeout)
    throw err
  }
}

function cleanReply(content) {
  return String(content ?? '')
    .replace(
      /<think>[\s\S]*?<\/think>/gi,
      ''
    )
    .trim()
}

function removeWebSearchMarker(reply) {
  return String(reply ?? '')
    .replaceAll(WEB_SEARCH_MARKER, '')
    .trim()
}

function shouldUseWebSearch(reply) {
  const text = String(reply ?? '')
    .toLocaleLowerCase('tr-TR')
    .trim()

  if (!text) {
    return true
  }

  if (
    text.includes(
      WEB_SEARCH_MARKER.toLocaleLowerCase('tr-TR')
    )
  ) {
    return true
  }

  const fallbackPhrases = [
    'yerel kaynaklarda bulunmamaktadır',
    'yerel kaynaklarda bulunmuyor',
    'yerel kaynaklarda bilgi yok',
    'yerel kaynaklarda yeterli bilgi yok',
    'bilgi tabanında bulunmamaktadır',
    'bilgi tabanında bulunmuyor',
    'bilgi tabanında bilgi yok',
    'güncel bilgi bulunmamaktadır',
    'güncel bilgi bulunmuyor',
    'güncel döviz kuru bilgisi',
    'cevap veremem',
    'bilgiye ulaşamıyorum',
    'bilgiye ulaşamadım',
    'yeterli bilgi yok',
    'yeterli bilgi bulunamadı',
    'bilgi bulamadım',
    'bilmiyorum',
    'maalesef',
    'üzgünüm',
  ]

  return fallbackPhrases.some((phrase) =>
    text.includes(phrase)
  )
}

export async function processMessage({
  message,
  sessionId,
  areaId,
  fileContent,
  pageUrl,
}) {
  const normalizedMessage =
    String(message ?? '').trim()

  if (!normalizedMessage) {
    throw new Error('Mesaj boş olamaz.')
  }

  /*
   * 1. BİLGİ TABANI
   */
  const allAreaDocuments =
    await getAreaDocuments(areaId)

  const areaDocuments =
    allAreaDocuments.slice(
      0,
      MAX_DOCUMENT_CHARACTERS
    )

  /*
   * 2. YÜKLENEN DOSYA
   */
  const uploadedFileContent =
    String(fileContent ?? '')
      .trim()
      .slice(
        0,
        MAX_FILE_CHARACTERS
      )

  /*
   * SOHBET GEÇMİŞİ
   */
  const history =
    await getConversationHistory(
      sessionId
    )

  /*
   * 3. MEVCUT WEB SİTESİ
   */
  let websiteContent = ''

  if (pageUrl) {
    websiteContent =
      await scrapeWebsite(pageUrl)
  }

  console.log(
    '[AIEngine] Bilgi tabanı:',
    areaDocuments.length,
    'karakter'
  )

  console.log(
    '[AIEngine] Yüklenen dosya:',
    uploadedFileContent.length,
    'karakter'
  )

  console.log(
    '[AIEngine] Web sitesi:',
    websiteContent.length,
    'karakter'
  )

  console.log(
    '[AIEngine] Geçmiş:',
    history.length,
    'mesaj'
  )

  let systemPrompt = `
Sen Akkaş Group web sitesinde çalışan kurumsal yapay zeka asistanısın.

Her zaman Türkçe cevap ver.

KAYNAK ÖNCELİĞİ:

1. ŞİRKET BİLGİ TABANI
2. KULLANICININ YÜKLEDİĞİ DOSYA
3. MEVCUT WEB SAYFASI İÇERİĞİ

KURALLAR:

- Kullanıcının sorusuna her zaman faydalı bir cevap ver.
- "Üzgünüm", "bilmiyorum", "cevap veremem", "bilgi bulamadım", "yeterli bilgi yok" gibi kaçış ifadeleri kullanma.
- Önce şirket bilgi tabanını kullan.
- Bilgi tabanında kullanıcının sorusuyla ilgili bilgi varsa bu bilgileri anlamlandırarak cevap oluştur.
- Kullanıcının kullandığı kelimelerin kaynakta birebir geçmesi gerekmez.
- Bilgi tabanında yeterli bilgi yoksa yüklenen dosyayı kullan.
- Yüklenen dosyada yeterli bilgi yoksa mevcut web sayfası içeriğini kullan.
- Şirket bilgi tabanı diğer yerel kaynaklardan önceliklidir.
- Kaynaklarda olmayan kesin bilgileri uydurma.
- Kaynaklardan çıkarılabilecek en faydalı cevabı ver.
- Gerekiyorsa genel ama doğru bir çerçevede cevap ver.
- Kullanıcının sorusuna doğrudan cevap ver.
- Cevabı kısa, doğal, anlaşılır ve profesyonel tut.
- Gereksiz tekrar yapma.
- Düşünce sürecini veya iç monologunu gösterme.
- Sadece kullanıcıya gösterilecek nihai cevabı yaz.

WEB SEARCH KURALI:

Eğer şirket bilgi tabanı, yüklenen dosya ve mevcut web sayfası içeriği kullanıcının sorusunu güvenilir şekilde cevaplamak için yeterli değilse:

- Cevabın ilk satırına mutlaka şu teknik işareti ekle:

${WEB_SEARCH_MARKER}

- Ardından elindeki bilgilerle kısa ve faydalı bir taslak cevap oluştur.
- Teknik işareti açıklama.
- Güncel döviz kuru, fiyat, haber, hava durumu, güncel istatistik veya zamanla değişebilen bilgiler yerel kaynaklarda yoksa kesinlikle tahmin etme.
- Bu tür güncel sorularda mutlaka ${WEB_SEARCH_MARKER} işaretini kullan.

Bu teknik işaret kullanıcıya gösterilmeyecektir.
`.trim()

  if (areaDocuments) {
    systemPrompt += `

==================================================
1. ŞİRKET BİLGİ TABANI
==================================================

${areaDocuments}`
  }

  if (uploadedFileContent) {
    systemPrompt += `

==================================================
2. KULLANICININ YÜKLEDİĞİ DOSYA
==================================================

${uploadedFileContent}`
  }

  if (websiteContent) {
    systemPrompt += `

==================================================
3. MEVCUT WEB SAYFASI İÇERİĞİ
==================================================

${websiteContent}`
  }

  const messages = [
    {
      role: 'system',
      content: systemPrompt,
    },
    ...history,
    {
      role: 'user',
      content: normalizedMessage,
    },
  ]

  console.log(
    '[AIEngine] Yerel kaynaklardan cevap aranıyor...'
  )

  /*
   * İLK OLLAMA ÇAĞRISI
   */
  const data =
    await callOllama(messages)

  const rawReply =
    cleanReply(
      data?.message?.content
    )

  const shouldSearchWeb =
    shouldUseWebSearch(rawReply)

  let reply =
    removeWebSearchMarker(
      rawReply
    )

  /*
   * 4. WEB SEARCH
   */
  if (shouldSearchWeb) {
    console.log(
      '[AIEngine] Yerel kaynaklar yetersiz. Web search başlatılıyor.'
    )

    console.log(
      '[AIEngine] Web search sorgusu:',
      normalizedMessage
    )

    const webResult =
      await webSearch(
        normalizedMessage
      )

    if (webResult) {
      console.log(
        '[AIEngine] Web sonucu kullanılarak cevap geliştiriliyor...'
      )

      const webSystemPrompt = `
Sen Akkaş Group web sitesinde çalışan kurumsal yapay zeka asistanısın.

Her zaman Türkçe cevap ver.

Kullanıcının sorusu için web arama sonuçları bulundu.

Görevin:

- Kullanıcının sorusuna doğrudan cevap ver.
- Aşağıdaki web arama sonuçlarını kullan.
- Yerel cevapta faydalı bilgi varsa onu da dikkate al.
- Şirket bilgi tabanından gelen bilgiler varsa bunları öncelikli kabul et.
- Bilgi uydurma.
- Güncel değerleri tahmin etme.
- "Üzgünüm", "bilmiyorum", "cevap veremem", "bilgi bulamadım" gibi ifadeler kullanma.
- Cevabı kısa, net ve profesyonel tut.
- Gereksiz tekrar yapma.
- Düşünce sürecini gösterme.
- Sadece nihai cevabı yaz.

==================================================
YEREL KAYNAKLARDAN OLUŞTURULAN TASLAK
==================================================

${reply}

==================================================
WEB ARAMA SONUÇLARI
==================================================

${webResult}
`.trim()

      const webMessages = [
        {
          role: 'system',
          content:
            webSystemPrompt,
        },
        {
          role: 'user',
          content:
            normalizedMessage,
        },
      ]

      const webData =
        await callOllama(
          webMessages
        )

      const webReply =
        cleanReply(
          webData?.message?.content
        )

      if (webReply) {
        reply = webReply
      }
    } else {
      /*
       * Web search sonucu yoksa
       * model genel bilgisiyle cevap üretir.
       */
      console.log(
        '[AIEngine] Web search sonucu bulunamadı. Genel cevap üretilecek.'
      )

      const generalMessages = [
        {
          role: 'system',
          content: `
Sen yardımcı, bilgili ve profesyonel bir yapay zeka asistanısın.

Her zaman Türkçe cevap ver.

Kurallar:

- Kullanıcının sorusunu cevapsız bırakma.
- "Üzgünüm", "bilmiyorum", "cevap veremem", "bilgi bulamadım" veya "yeterli bilgi yok" deme.
- Genel bilginle kullanıcıya mümkün olan en faydalı cevabı ver.
- Güncel ve sürekli değişen bir sayısal bilgiyi doğrulayamıyorsan sayı uydurma.
- Güncel veri doğrulanamıyorsa bunun yerine kullanıcıya konuyu açıklayan faydalı ve doğru bir cevap ver.
- Tarih, kur, fiyat, hava durumu gibi güncel bilgileri tahmin etme.
- Cevabı kısa, net, doğal ve profesyonel tut.
- Gereksiz tekrar yapma.
- Düşünce sürecini gösterme.
- Sadece nihai cevabı yaz.
`.trim(),
        },
        {
          role: 'user',
          content:
            normalizedMessage,
        },
      ]

      const generalData =
        await callOllama(
          generalMessages
        )

      const generalReply =
        cleanReply(
          generalData?.message?.content
        )

      if (generalReply) {
        reply = generalReply
      }
    }
  }

  /*
   * SON KONTROL
   */
  reply =
    removeWebSearchMarker(
      reply
    )

  if (!reply) {
    reply =
      'Sorunuzla ilgili genel çerçevede yardımcı olabilirim. Daha ayrıntılı bir soru iletirseniz daha net bir yanıt verebilirim.'
  }

  /*
   * SOHBETİ KAYDET
   */
  if (sessionId) {
    await saveMessage(
      sessionId,
      'user',
      normalizedMessage
    )

    await saveMessage(
      sessionId,
      'assistant',
      reply
    )
  }

  return {
    reply,
    sessionId,
  }
}