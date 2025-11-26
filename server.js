// server.js
import express from 'express'
import puppeteer from 'puppeteer'
import path from 'path'
import { fileURLToPath } from 'url'

// 修复 __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const DIST_PATH = path.resolve(__dirname, 'dist')
const SPA_INDEX = path.join(DIST_PATH, 'index.html')

// 常见搜索引擎爬虫
const isBot = (ua = '') =>
    /Googlebot|Bingbot|Slurp|DuckDuckBot|Baiduspider|YandexBot/i.test(ua)

// 缓存设置
const CACHE_TTL = 6 * 60 * 60 * 1000 // 6小时
const cache = {}

// 渲染锁，防止高并发重复渲染
const renderingLocks = {}

// 全局浏览器实例
let browser = null

const launchBrowser = async () => {
    if (!browser) {
        browser = await puppeteer.launch({
            executablePath: '/snap/bin/chromium',
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--single-process',
                '--no-zygote'
            ]
        })
    }
}

// 创建新的 page，并拦截不必要资源
const createPage = async (ua) => {
    const page = await browser.newPage()
    await page.setUserAgent(ua)
    await page.setExtraHTTPHeaders({
        'X-CDN-SECRET': 'aB9xYz3QpLmN7KcVwRtE2oJdFgT5HsWu'
    })

    await page.setRequestInterception(true)
    page.on('request', req => {
        const url = req.url()
        const type = req.resourceType()
        if (type === 'image' || type === 'media' || type === 'font') {
            req.abort()
        } else {
            req.continue()
        }
    })

    return page
}

app.use(async (req, res, next) => {
    const ua = req.headers['user-agent'] || ''
    const pathUrl = req.originalUrl

    // 非爬虫直接返回 SPA
    if (!isBot(ua)) {
        return res.sendFile(SPA_INDEX)
    }

    // 如果缓存有效，直接返回
    if (cache[pathUrl] && cache[pathUrl].expire > Date.now()) {
        return res.send(cache[pathUrl].html)
    }

    // 如果正在渲染，等待渲染完成
    if (renderingLocks[pathUrl]) {
        await renderingLocks[pathUrl]
        if (cache[pathUrl] && cache[pathUrl].expire > Date.now()) {
            return res.send(cache[pathUrl].html)
        }
    }

    // 开始渲染并锁住
    renderingLocks[pathUrl] = (async () => {
        try {
            await launchBrowser()
            const page = await createPage(ua)

            const targetUrl = `https://original2.miraii.cn${pathUrl}`

            // networkidle2 更快
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })

            await page.waitForFunction('window.__PRERENDER_READY__ === true', { timeout: 10000 })

            const html = await page.content()

            await page.close()

            // 存入缓存
            cache[pathUrl] = {
                html,
                expire: Date.now() + CACHE_TTL
            }

            res.send(html)
        } catch (err) {
            console.error(`[Puppeteer] Render failed for ${pathUrl}`, err)
            res.status(500).send('Render failed')
        } finally {
            delete renderingLocks[pathUrl]
        }
    })()
})

app.listen(29953, () => {
    console.log('SEO Proxy running on http://localhost:29953')
})

// 退出时关闭浏览器
process.on('exit', async () => {
    if (browser) await browser.close()
})
process.on('SIGINT', async () => {
    if (browser) await browser.close()
    process.exit()
})
process.on('SIGTERM', async () => {
    if (browser) await browser.close()
    process.exit()
})
