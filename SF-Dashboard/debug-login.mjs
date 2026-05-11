import puppeteer from "puppeteer";

const [,, username, password] = process.argv;
if (!username || !password) {
  console.error("Usage: node debug-login.mjs <username> <password>");
  process.exit(1);
}

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });

console.log("Navigating...");
await page.goto("https://sfsupport.dataon.com", { waitUntil: "networkidle2", timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));

// Fill username
const userField =
  await page.$('input[type="text"].ui-inputtext') ??
  await page.$('input[type="text"]');
const passField = await page.$('input[type="password"]');

if (!userField || !passField) {
  console.error("Could not find fields:", { userField: !!userField, passField: !!passField });
  await browser.close(); process.exit(1);
}

await userField.click({ clickCount: 3 });
await userField.type(username, { delay: 40 });
await passField.click({ clickCount: 3 });
await passField.type(password, { delay: 40 });
console.log("Fields filled. Clicking Sign In...");

const clicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find(b =>
    b.textContent?.trim().toLowerCase() === "sign in"
  );
  if (btn) { btn.click(); return true; }
  return false;
});
console.log("Button clicked:", clicked);

await Promise.race([
  page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
  page.waitForNetworkIdle({ idleTime: 1500, timeout: 30000 }),
]).catch(() => {});
await new Promise(r => setTimeout(r, 3000));

const result = await page.evaluate(() => ({
  url: window.location.href,
  hasPasswordField: !!document.querySelector('input[type="password"]'),
  bodySnippet: document.body.innerText.slice(0, 300),
}));

console.log("\nAfter login:");
console.log("URL:", result.url);
console.log("Still on login page:", result.hasPasswordField);
console.log("Page text:", result.bodySnippet);

await browser.close();
