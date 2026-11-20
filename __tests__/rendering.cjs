/*
 * File: __tests__/rendering.cjs
 * Desc: Bounded, offline checks for the public YAML renderer contract.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium, firefox, webkit } = require("playwright");
const engine = process.env.BROWSER_ENGINE || "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(engine), "Unsupported BROWSER_ENGINE");

test("YAML library", { timeout: 30000 }, async (t) => {
  const browser = await { chromium, firefox, webkit }[engine].launch({
    timeout: 10000,
    ...(engine === "chromium" ? { channel: process.env.BROWSER_CHANNEL, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {})
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Load authored files directly; CDN availability is not part of this contract.
  await page.route("**/*", (route) => route.abort());
  // ===== BROWSER FIXTURE =====
  await page.setContent('<!doctype html><meta charset="UTF-8"><div id="viewer"></div>');
  await page.addStyleTag({ path: path.join(__dirname, "../yaml.css") });
  await page.addScriptTag({ path: path.join(__dirname, "../yaml.js") });
  await page.evaluate(() => {
    window.root = document.getElementById("viewer");
  });

  // ===== RENDERING BEHAVIOR =====
  await t.test("parses typed values and aliases and renders the tree", async () => {
    const result = await page.evaluate(async () => {
      const source = "base: &base {enabled: true, retries: 3}\ncopy: *base\ntext: |\n  first\n  second\n";
      const doc = byYAMLviewer.parse(source)[0];
      const ready = await byYAMLviewer(root, source, { animations: false }).ready;
      return {
        ready,
        alias: doc.get("base") === doc.get("copy"),
        enabled: doc.get("base").get("enabled"),
        text: doc.get("text")
      };
    });
    assert.deepEqual(result, { ready: true, alias: true, enabled: true, text: "first\nsecond\n" });
    assert.match(await page.locator(".byYAMLtree").textContent(), /retries/);
  });

  await t.test("rejects malformed YAML and executable tags and keeps text inert", async () => {
    const result = await page.evaluate(async () => {
      const malformed = await byYAMLviewer(root, "a: [unclosed").ready;
      const tag = await byYAMLviewer(root, 'x: !!js/function "function(){window.injected=1}"').ready;
      await byYAMLviewer(root, 'x: "<img src=x onerror=window.injected=1>"').ready;
      return {
        malformed,
        tag,
        images: root.querySelectorAll("img").length,
        injected: Boolean(window.injected)
      };
    });
    assert.deepEqual(result, { malformed: false, tag: false, images: 0, injected: false });
  });

  await t.test("replacement and disposal respect the current instance", async () => {
    const result = await page.evaluate(async () => {
      const old = byYAMLviewer(root, "name: old");
      await old.ready;
      const current = byYAMLviewer(root, "name: current");
      const ready = await current.ready;
      old.destroy();
      const preserved = root.textContent.includes("current");
      current.destroy();
      return { ready, preserved, empty: root.childNodes.length === 0 };
    });
    assert.deepEqual(result, { ready: true, preserved: true, empty: true });
  });

  assert.deepEqual(errors, [], "No uncaught browser errors");
});
