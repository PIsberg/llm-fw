import { chromium } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, '..', 'docs', 'images', 'ss-05-live-traffic.png')
const DASH = 'http://localhost:7731'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } })

await page.goto(DASH)
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(600)

// Click Live Traffic tab
await page.click('button.tab-btn:has-text("Live Traffic")')
await page.waitForTimeout(800) // let chart render

await page.screenshot({ path: OUT, fullPage: false })
console.log('Saved:', OUT)

await browser.close()
