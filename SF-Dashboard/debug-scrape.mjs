import puppeteer from "puppeteer";

const [,, username, password] = process.argv;
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });

await page.goto("https://sfsupport.dataon.com", { waitUntil: "networkidle2", timeout: 60000 });
await new Promise(r => setTimeout(r, 2000));

// Login
const userField = await page.$('input[type="text"].ui-inputtext') ?? await page.$('input[type="text"]');
const passField = await page.$('input[type="password"]');
await userField.click({ clickCount: 3 });
await userField.type(username, { delay: 40 });
await passField.click({ clickCount: 3 });
await passField.type(password, { delay: 40 });
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find(b => b.textContent?.trim().toLowerCase() === "sign in");
  btn?.click();
});

await Promise.race([
  page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
  page.waitForNetworkIdle({ idleTime: 1500, timeout: 30000 }),
]).catch(() => {});
await new Promise(r => setTimeout(r, 3000));

console.log("Logged in. URL:", page.url());

// Extract everything useful
const data = await page.evaluate(() => {
  // Nav links
  const navLinks = [...document.querySelectorAll("a, [routerlink]")].map(el => ({
    text: el.textContent?.trim().slice(0, 40),
    href: el.getAttribute("href") || el.getAttribute("routerlink"),
  })).filter(l => l.text && l.href);

  // Stat/count cards
  const cards = [...document.querySelectorAll(".card, .p-card, .ui-card, [class*='widget'], [class*='summary']")].map(c => ({
    title: c.querySelector("h1,h2,h3,h4,h5,span.title,.title")?.textContent?.trim(),
    value: c.querySelector("[class*='count'],[class*='value'],[class*='num'],h1,h2")?.textContent?.trim(),
    html: c.innerHTML.slice(0, 200),
  }));

  // Tables
  const tables = [...document.querySelectorAll("table, .ui-datatable, .p-datatable")].map(t => {
    const headers = [...t.querySelectorAll("thead th, .ui-datatable-thead th")].map(th => th.textContent?.trim());
    const rows = [...t.querySelectorAll("tbody tr")].slice(0, 5).map(tr =>
      [...tr.querySelectorAll("td")].map(td => td.textContent?.trim())
    );
    return { headers, rows, rowCount: t.querySelectorAll("tbody tr").length };
  });

  // All visible text sections
  const sections = [...document.querySelectorAll("p-panel, .ui-panel, p-card, .ui-card, .card")].map(s => ({
    class: s.className.slice(0, 60),
    text: s.textContent?.trim().slice(0, 150),
  }));

  return { navLinks, cards, tables, sections };
});

console.log("\n--- NAV LINKS ---");
data.navLinks.slice(0, 20).forEach(l => console.log(l.href, "|", l.text));

console.log("\n--- CARDS/WIDGETS ---");
data.cards.slice(0, 20).forEach((c, i) => console.log(i, c.title, "|", c.value, "\n  HTML:", c.html?.slice(0,100)));

console.log("\n--- TABLES ---");
data.tables.forEach((t, i) => {
  console.log(`Table ${i}: headers=${JSON.stringify(t.headers)}, rows=${t.rowCount}`);
  t.rows.slice(0, 3).forEach(r => console.log("  row:", JSON.stringify(r)));
});

console.log("\n--- SECTIONS ---");
data.sections.slice(0, 10).forEach(s => console.log(s.class, "\n  ", s.text));

// Screenshot
const buf = await page.screenshot({ fullPage: false });
import { writeFileSync } from "fs";
writeFileSync("D:/Claude/SF Dashboard/debug-screenshot.png", buf);
console.log("\nScreenshot saved to debug-screenshot.png");

await browser.close();
