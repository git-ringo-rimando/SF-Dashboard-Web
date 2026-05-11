const puppeteer = require("puppeteer");
const store = require("./src/lib/store");

async function debug() {
  const creds = store.loadCredentials();
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  
  // Navigate directly to the ticket URL
  const url = "https://sfsupport.dataon.com/app/ticket/forms/TCK2512-1070015";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  
  console.log("Final URL:", page.url());
  console.log("Has password input:", !!(await page.$('input[type="password"]')));
  console.log("Page title:", await page.title());
  const bodySnippet = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log("Body snippet:", bodySnippet);
  
  await browser.close();
}

debug().catch(console.error);
