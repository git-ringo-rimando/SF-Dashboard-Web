import puppeteer from "puppeteer";
import { writeFileSync } from "fs";

const [,, username, password] = process.argv;
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });

// Login
await page.goto("https://sfsupport.dataon.com", { waitUntil: "networkidle2", timeout: 60000 });
await new Promise(r => setTimeout(r, 2000));
const userField = await page.$('input[type="text"].ui-inputtext') ?? await page.$('input[type="text"]');
const passField = await page.$('input[type="password"]');
await userField.click({ clickCount: 3 }); await userField.type(username, { delay: 40 });
await passField.click({ clickCount: 3 }); await passField.type(password, { delay: 40 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find(b => b.textContent?.trim().toLowerCase() === "sign in")?.click();
});
await Promise.race([
  page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
  page.waitForNetworkIdle({ idleTime: 1500, timeout: 30000 }),
]).catch(() => {});
await new Promise(r => setTimeout(r, 2000));
console.log("Logged in:", page.url());

// --- Partner Dashboard ---
await page.goto("https://sfsupport.dataon.com/app/partner-dashboard", { waitUntil: "networkidle2", timeout: 30000 });
await new Promise(r => setTimeout(r, 4000));
const dashBuf = await page.screenshot({ fullPage: true });
writeFileSync("D:/Claude/SF Dashboard/debug-partner-dashboard.png", dashBuf);
console.log("Partner dashboard screenshot saved");

const dashData = await page.evaluate(() => {
  const text = document.body.innerText;
  const cards = [...document.querySelectorAll(".card, .ui-card, p-card, [class*='widget'], [class*='summary'], .col-12, .col-6, .col-4, .col-3")].map(c => ({
    class: c.className.slice(0, 80),
    text: c.textContent?.trim().slice(0, 200),
  })).filter(c => c.text && c.text.length > 2 && c.text.length < 200);
  const tables = [...document.querySelectorAll("table, .ui-datatable, .p-datatable")].map(t => ({
    headers: [...t.querySelectorAll("thead th")].map(th => th.textContent?.trim()),
    rows: [...t.querySelectorAll("tbody tr")].slice(0, 5).map(tr =>
      [...tr.querySelectorAll("td")].map(td => td.textContent?.trim())
    ),
    count: t.querySelectorAll("tbody tr").length,
  }));
  return { text: text.slice(0, 1000), cards: cards.slice(0, 30), tables };
});
console.log("\n=== PARTNER DASHBOARD ===");
console.log("Page text:", dashData.text);
console.log("Tables:", JSON.stringify(dashData.tables, null, 2));

// --- Ticket Statistic ---
await page.goto("https://sfsupport.dataon.com/app/ticket/statistic", { waitUntil: "networkidle2", timeout: 30000 });
await new Promise(r => setTimeout(r, 4000));
const statBuf = await page.screenshot({ fullPage: true });
writeFileSync("D:/Claude/SF Dashboard/debug-statistic.png", statBuf);
console.log("\nStatistic screenshot saved");

const statData = await page.evaluate(() => {
  const tables = [...document.querySelectorAll("table, .ui-datatable, .p-datatable")].map(t => ({
    headers: [...t.querySelectorAll("thead th")].map(th => th.textContent?.trim()),
    rows: [...t.querySelectorAll("tbody tr")].slice(0, 10).map(tr =>
      [...tr.querySelectorAll("td")].map(td => td.textContent?.trim())
    ),
    count: t.querySelectorAll("tbody tr").length,
  }));
  return { text: document.body.innerText.slice(0, 1000), tables };
});
console.log("\n=== TICKET STATISTIC ===");
console.log("Page text:", statData.text);
console.log("Tables:", JSON.stringify(statData.tables, null, 2));

// --- Ticket List (full) ---
await page.goto("https://sfsupport.dataon.com/app/ticket/list", { waitUntil: "networkidle2", timeout: 30000 });
await new Promise(r => setTimeout(r, 4000));
const listData = await page.evaluate(() => {
  const tables = [...document.querySelectorAll("table, .ui-datatable, .p-datatable")].map(t => ({
    headers: [...t.querySelectorAll("thead th")].map(th => th.textContent?.trim()),
    rows: [...t.querySelectorAll("tbody tr")].slice(0, 20).map(tr =>
      [...tr.querySelectorAll("td")].map(td => td.textContent?.trim().slice(0, 50))
    ),
    count: t.querySelectorAll("tbody tr").length,
  }));
  return { tables };
});
console.log("\n=== TICKET LIST ===");
console.log("Tables:", JSON.stringify(listData.tables, null, 2));

await browser.close();
