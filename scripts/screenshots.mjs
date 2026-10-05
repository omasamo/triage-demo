// Captures the walkthrough screenshots from the web build (npm run build:web && node scripts/screenshots.mjs).
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(path.join(process.execPath, '../../lib/node_modules/playwright')); }

const root = path.resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  try { res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' }); res.end(await readFile(p)); }
  catch { res.writeHead(404); res.end(); }
}).listen(4173);

const out = process.argv[2] ?? 'docs/screenshots';
const theme = process.argv[3] ?? 'light';
const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: theme });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:4173/');
await page.waitForSelector('text=Good morning, Dana');
const clearToasts = async () => { for (const b of await page.$$('.toast button[aria-label=Dismiss]')) await b.click().catch(() => {}); };
const shot = async (name, keepToasts = false) => { if (!keepToasts) await clearToasts(); await page.waitForTimeout(350); await page.screenshot({ path: `${out}/${name}.png` }); console.log('shot', name); };
const nav = async label => { await page.click(`nav >> text=${label}`); await page.waitForTimeout(200); };

await shot('01-overview-start');
await page.click('text=Next email');                       // Acme escalation
await page.waitForSelector('.toast');
await shot('02-acme-email-arrives', true);
await page.click('.toast >> text=Open item');
await page.waitForSelector('.drawer');
await shot('03-why-it-ranks');
await page.keyboard.press('Escape');
for (let i = 0; i < 6; i++) { await page.click('text=Next email'); await page.waitForTimeout(250); }
await nav('Overview');
await shot('04-overview-after-emails');
await nav('Priority queue');
await shot('05-priority-queue');
await nav('Email signals');
await page.click('.mrow:has-text("Globex Billing")');
await shot('06-injection-blocked');
await page.click('.mrow:has-text("Henrik Dahl")');
await shot('07-email-signal');
await nav('Workload');
await shot('08-workload-handoffs');
await nav('Assistant');
await page.click('text=What is blocking the Acme go-live?');
await page.waitForSelector('.msg.assistant .meta');
await page.click('.suggestions >> text=Who is overloaded right now?');
await page.waitForTimeout(400);
await shot('09-assistant');
// Manager override
await page.fill('.search input', 'Hooli');
await page.waitForSelector('.search .results button');
await page.click('.search .results button >> nth=0');
await page.waitForSelector('.drawer');
await page.click('.drawer .seg >> text=P1');
await page.fill('.drawer textarea', 'Renewal call with Hooli CFO on Thursday; keep this visible.');
await page.click('.drawer >> text=Set P1');
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('.drawer-body').scrollTo(0, 0));
await shot('10-manager-override');
await page.keyboard.press('Escape');
await nav('Audit log');
await shot('11-audit-log');
await nav('Settings');
await shot('12-settings');
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
server.close();
