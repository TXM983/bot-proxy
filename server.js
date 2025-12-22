// server.js
import express from 'express'
import puppeteer from 'puppeteer'
import path from 'path'
import { fileURLToPath } from 'url'
import { minify } from 'html-minifier-terser'

/** * 打包命令 ncc build server.js -o dist-server --minify * @type {string} * @private */

// 修复 __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const DIST_PATH = path.resolve(__dirname, 'dist')
const SPA_INDEX = path.join(DIST_PATH, 'index.html')

// 缓存设置
const CACHE_TTL = 6 * 60 * 60 * 1000 // 6小时
const cache = {}

// 渲染锁，防止高并发重复渲染
const renderingLocks = {}

// 全局浏览器实例
let browser = null


const now = () => {
    const d = new Date()
    const pad = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const log = (...args) => {
    console.log(`[${now()}]`, ...args)
}

const error = (...args) => {
    console.error(`[${now()}]`, ...args)
}


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

// 定时重启浏览器
const BROWSER_RESTART_INTERVAL = 3 * 60 * 60 * 1000 // 6小时

const isRendering = () => Object.keys(renderingLocks).length > 0

setInterval(() => {
    (async () => {
        if (browser && !isRendering()) {
            log('[Puppeteer] Restarting browser to free memory...')
            try {
                await browser.close()
            } catch (err) {
                error('[Puppeteer] Error closing browser:', err)
            }
            browser = null
        }
    })()
}, BROWSER_RESTART_INTERVAL)

// 创建新的 page，并拦截不必要资源
const createPage = async () => {
    const page = await browser.newPage()
    await page.setExtraHTTPHeaders({
        'X-CDN-SECRET': 'aB9xYz3QpLmN7KcVwRtE2oJdFgT5HsWu',
    })

    await page.setRequestInterception(true)
    page.on('request', req => {
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
    const pathUrl = req.originalUrl
    const startTime = Date.now()

    log(`[SSR] Start: ${pathUrl}`)

    // 如果缓存有效，直接返回
    if (cache[pathUrl] && cache[pathUrl].expire > Date.now()) {
        log(`[SSR] Cache hit: ${pathUrl} | ${Date.now() - startTime}ms`)
        return res.send(cache[pathUrl].html)
    }

    // 如果正在渲染，等待渲染完成
    if (renderingLocks[pathUrl]) {
        await renderingLocks[pathUrl]
        if (cache[pathUrl] && cache[pathUrl].expire > Date.now()) {
            log(`[SSR] Lock wait + cache hit: ${pathUrl} | ${Date.now() - startTime}ms`)
            return res.send(cache[pathUrl].html)
        }
    }

    // 开始渲染并锁住
    renderingLocks[pathUrl] = (async () => {
        try {
            await launchBrowser()
            const page = await createPage()

            const targetUrl = `https://original2.miraii.cn${pathUrl}`

            await page.goto(targetUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            })

            await page.waitForFunction(
                'window.__PRERENDER_READY__ === true',
                { timeout: 20000 }
            )

            let html = await page.content()
            await page.close()

            html = await minify(html, {
                removeComments: true,
                collapseWhitespace: true,
                minifyJS: true,
                minifyCSS: true
            })

            // 存入缓存
            cache[pathUrl] = {
                html,
                expire: Date.now() + CACHE_TTL
            }

            log(`[SSR] Render success: ${pathUrl} | ${Date.now() - startTime}ms`)
            res.send(html)

        } catch (err) {
            error(
                `[SSR] Render failed: ${pathUrl} | ${Date.now() - startTime}ms`,
                err
            )
            res.status(500).send('Render failed')
        } finally {
            delete renderingLocks[pathUrl]
        }
    })()
})

app.listen(29953, () => {
    log('SEO Proxy running on http://localhost:29953')
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
