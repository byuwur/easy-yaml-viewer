/*
 * File: __tests__/rendering.cjs
 * Desc: YAML library contracts using local renderer assets; playground checks live in playground.cjs.
 */

// --- DEPENDENCIES ---
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium, firefox, webkit } = require("playwright");
const browserEngine = process.env.BROWSER_ENGINE || "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(browserEngine), "Unsupported BROWSER_ENGINE");
const browserType = { chromium, firefox, webkit }[browserEngine];
// Browser channels and executable overrides apply only to Chromium.
const launchBrowser = () =>
  browserType.launch(
    browserEngine === "chromium"
      ? {
          channel: process.env.BROWSER_CHANNEL || undefined,
          executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined
        }
      : {}
  );

// --- THEME FIXTURES ---
// Caller-provided legacy stylesheets reuse the canonical palettes without distribution files.
const legacyThemeCSS = (theme) => {
  const css = require("node:fs").readFileSync(path.join(__dirname, "../yaml.css"), "utf8");
  const section = css.split(`/* --- ${theme.toUpperCase()} --- */`)[1];
  return `.byYAMLdocument {${section.match(/\{([\s\S]*?)\}/)[1]}}`;
};

// --- STANDALONE RENDERER ---
test("YAML standalone browser contracts", async (t) => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = [],
      requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith("http://viewer.test/")) requests.push(request.url());
    });
    // This generated host exercises the library without reading the playground's index.html.
    await page.route("http://viewer.test/**", (route) => {
      const filename = new URL(route.request().url()).pathname.slice(1);
      if (/^yaml\.(light|dark)\.css$/.test(filename)) return route.fulfill({ body: legacyThemeCSS(filename.includes(".dark.css") ? "dark" : "light"), contentType: "text/css" });
      if (!filename || filename === "fixture.html")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="yaml.css"><script src="yaml.js"></script><div id="viewer" data-theme="light"></div>'
        });
      return route.fulfill({ path: path.join(__dirname, "..", filename), contentType: filename.endsWith(".css") ? "text/css" : "text/javascript" });
    });
    await page.goto("http://viewer.test/fixture.html");
    await page.evaluate(
      async ({ source, second, options }) => {
        await byYAMLviewer(document.getElementById("viewer"), source, options).ready;
      },
      {
        source: "defaults: &defaults\n  active: true\n  retries: 3\nservice:\n  <<: *defaults\n  name: easy-yaml-viewer\n  tags: [small, standalone]\n  notes: |\n    Keep things simple.\n    Make them useful.\n",
        options: { fontSizeControls: true, collapsed: false, search: true, copyValues: true }
      }
    );
    await page.waitForFunction(() => document.getElementById("viewer")?.getAttribute("aria-busy") !== "true" && typeof window.byYAMLviewer === "function");
    await page.evaluate(() => {
      window.root = document.getElementById("viewer");
      window.copies = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value) => copies.push(value) } });
    });
    await t.test("themes, copy, font size, and responsive controls", async () => {
      assert.equal(await page.locator("#viewer [role=alert]:visible").count(), 0);
      await page.locator(".byVIEWcopy").click();
      assert.equal(await page.evaluate(() => typeof copies.at(-1)), "string");
      await page.getByRole("button", { name: "Switch to dark theme" }).click();
      await page.waitForFunction(() => getComputedStyle(root).backgroundColor === "rgb(39, 40, 34)");
      await page.getByRole("button", { name: "Increase text size" }).click();
      assert.equal(await page.evaluate(() => root.style.fontSize), "1.125rem");
      await page.setViewportSize({ width: 320, height: 640 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.setViewportSize({ width: 1100, height: 800 });
      await page.getByRole("button", { name: "Reset text size" }).click();
    });
    await t.test("clipboard denial is reported", async () => {
      await page.evaluate(() => {
        navigator.clipboard.writeText = async () => {
          throw new Error("denied");
        };
      });
      await page.locator(".byVIEWcopy").click();
      assert.equal(await page.locator(".byVIEWcopy").textContent(), "Failed");
      await page.evaluate(() => {
        navigator.clipboard.writeText = async (value) => copies.push(value);
      });
    });

    await t.test("real parser supports types, block scalars, aliases, merges, and documents", async () => {
      const result = await page.evaluate(() => {
        const docs = byYAMLviewer.parse('base: &base {enabled: true, retries: 3}\ncopy: *base\nmerged: {<<: *base, name: viewer}\ntext: |\n  first\n  second\n---\n[null, false, 0, "001", .nan]');
        return {
          map: docs[0] instanceof Map,
          alias: docs[0].get("base") === docs[0].get("copy"),
          merge: docs[0].get("merged").get("enabled"),
          block: docs[0].get("text"),
          types: docs[1].slice(0, 4),
          nan: Number.isNaN(docs[1][4]),
          empty: byYAMLviewer.parse("").length
        };
      });
      assert.deepEqual(result, { map: true, alias: true, merge: true, block: "first\nsecond\n", types: [null, false, 0, "001"], nan: true, empty: 0 });
    });
    await t.test("complex keys and cyclic aliases are represented without expansion", async () => {
      const result = await page.evaluate(async () => {
        const docs = byYAMLviewer.parse("? [a, b]\n: {value: 1}\ncycle: &self [*self]");
        const complex = [...docs[0].keys()].find(Array.isArray);
        const cycle = docs[0].get("cycle");
        const view = byYAMLviewer(root, "? [a, b]\n: {value: 1}\ncycle: &self [*self]", { search: true, copyValues: true, expandCollapse: true });
        await view.ready;
        return {
          key: complex.join(","),
          value: docs[0].get(complex).get("value"),
          cycle: cycle[0] === cycle,
          text: root.querySelector(".byYAMLtree").textContent,
          count: root.querySelectorAll(".byYAMLnode").length
        };
      });
      assert.equal(result.key, "a,b");
      assert.equal(result.value, 1);
      assert.equal(result.cycle, true);
      assert.match(result.text, /complex key/);
      assert.match(result.text, /reference/);
      assert.ok(result.count < 20);
      await page.locator(".byYAMLheader button").first().click();
      assert.equal(
        await page.evaluate(() => {
          const parsed = byYAMLviewer.parse(copies.at(-1))[0];
          return parsed.get("cycle")[0] === parsed.get("cycle");
        }),
        true
      );
      await page.getByRole("searchbox", { name: "Search YAML" }).fill("reference");
      await page.waitForFunction(() => document.querySelectorAll(".byYAMLnode").length === 3);
      assert.match(await page.locator(".byYAMLtree").textContent(), /reference #/);
    });
    await t.test("collapse, search, source copy, and exact multiline value copying", async () => {
      await page.evaluate(async () => {
        window.yamlSource = "branch:\n  needle: |\n    a\n    b\nother: hidden";
        await byYAMLviewer(root, yamlSource, { search: true, copyValues: true, expandCollapse: true, collapsed: true }).ready;
      });
      assert.equal(await page.locator("details[open]").count(), 0);
      await page.getByRole("button", { name: "Expand all YAML nodes" }).click();
      await page
        .locator(".byYAMLheader")
        .filter({ has: page.locator(".byYAMLkey", { hasText: '"needle"' }) })
        .getByRole("button", { name: "Copy YAML value", exact: true })
        .click();
      assert.equal(await page.evaluate(() => copies.at(-1)), "a\nb\n");
      await page.locator(".byVIEWcopy").click();
      assert.equal(await page.evaluate(() => copies.at(-1) === yamlSource), true);
      await page.getByRole("searchbox", { name: "Search YAML" }).fill("needle");
      await page.waitForFunction(() => document.querySelectorAll(".byYAMLnode").length === 3);
      assert.equal(await page.locator("details[open]").count(), 2);
      assert.doesNotMatch(await page.locator(".byYAMLtree").textContent(), /hidden/);
    });
    await t.test("malformed input, duplicate/unsafe tags, limits, and prototype keys", async () => {
      const result = await page.evaluate(async () => {
        const bad = [];
        for (const source of ["a: [unclosed", "a: 1\na: 2", 'x: !!js/function "function(){window.injected=1}"', "a: ".repeat(110) + "1", "a: &x [1]\nb: [" + Array(1001).fill("*x").join(",") + "]"])
          bad.push(await byYAMLviewer(root, source).ready);
        const safe = byYAMLviewer.parse("__proto__: {polluted: true}\nconstructor: x")[0];
        await byYAMLviewer(root, 'x: "<img src=x onerror=window.injected=1>"').ready;
        return { bad, prototype: safe.get("__proto__").get("polluted"), polluted: Boolean({}.polluted), safe: !root.querySelector("img") && !window.injected };
      });
      assert.deepEqual(result, { bad: [false, false, false, false, false], prototype: true, polluted: false, safe: true });
    });
    await t.test("container copying, large documents, cancellation, and private parser scope", async () => {
      const result = await page.evaluate(async () => {
        const large = `items:\n${Array.from({ length: 2500 }, (_, i) => `  - {id: ${i}, value: item}`).join("\n")}`;
        let tick = false;
        setTimeout(() => {
          tick = true;
        }, 0);
        const view = byYAMLviewer(root, large, { collapsed: true });
        const ready = await view.ready;
        const count = root.querySelectorAll(".byYAMLnode").length;
        const old = byYAMLviewer(root, large),
          current = byYAMLviewer(root, "name: new", { copyValues: true });
        const cancelled = await old.ready;
        await current.ready;
        root.querySelector("summary button").click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const containerCopied = copies.at(-1).includes("name: new");
        old.destroy();
        const preserved = root.textContent.includes("new");
        current.destroy();
        return { tick, ready, count, cancelled, preserved, containerCopied, disposed: root.childNodes.length === 0, global: typeof window.jsyaml };
      });
      assert.deepEqual(result, { tick: true, ready: true, count: 7502, cancelled: false, preserved: true, containerCopied: true, disposed: true, global: "undefined" });
    });

    await t.test("duplicate loading and source independence", async () => {
      await page.evaluate(() => {
        window.original = byYAMLviewer;
      });
      await page.addScriptTag({ path: path.join(__dirname, "../yaml.js") });
      assert.equal(await page.evaluate(() => original === byYAMLviewer), true);
      assert.deepEqual(requests, []);
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
  }
});

// --- CONTAINER THEMES ---
test("container themes are scoped, independent, and compatible with legacy links", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.setContent('<div id="outside" class="dark">Host</div><div id="first" data-theme="dark"></div><div id="second" class="light"></div><div id="third"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../yaml.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../yaml.js") });
    await page.evaluate(
      async (args) => {
        window.renderTheme = async (element) => {
          const controller = window.byYAMLviewer(element, ...args.slice(0, 1), { ...args[1], animations: false });
          if (controller?.ready) await controller.ready;
        };
        for (const id of ["first", "second", "third"]) await renderTheme(document.getElementById(id));
      },
      ["message: Local theme"]
    );
    const color = (id) => page.locator("#" + id).evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.equal(await color("first"), "rgb(39, 40, 34)");
    assert.equal(await color("second"), "rgb(250, 250, 245)");
    assert.equal(await page.locator("#outside").evaluate((element) => getComputedStyle(element).getPropertyValue("--by-view-muted")), "");
    assert.equal(await page.locator("#first .byVIEWtoolbar").evaluate((element) => getComputedStyle(element).getPropertyValue("--by-view-muted").trim()), "#75715e");
    await page.locator("#first .byVIEWthemeToggle").click();
    assert.equal(await page.locator("#first").getAttribute("data-theme"), "light");
    assert.equal(await color("second"), "rgb(250, 250, 245)");
    await page.locator("#second .byVIEWthemeToggle").click();
    assert.equal(
      await page
        .locator("#second")
        .getAttribute("class")
        .then((classes) => classes.split(/\s+/).includes("dark")),
      true
    );
    assert.equal(await page.locator("#second").getAttribute("data-theme"), null);
    assert.equal(await color("second"), "rgb(39, 40, 34)");
    await page.evaluate(async () => {
      const second = document.getElementById("second");
      second.dataset.theme = "light";
      await renderTheme(second);
    });
    assert.equal(await color("second"), "rgb(250, 250, 245)");
    await page.evaluate(() => {
      const first = document.getElementById("first");
      first.style.setProperty("--by-view-bg", "#123456");
    });
    assert.equal(await color("first"), "rgb(18, 52, 86)");
    assert.equal(await color("second"), "rgb(250, 250, 245)");
    await page.evaluate(() => document.getElementById("first").style.removeProperty("--by-view-bg"));
    assert.equal(requests.length, 0, "Container theme changes must not fetch stylesheets");

    await page.route("https://legacy.test/**", (route) => route.fulfill({ body: legacyThemeCSS(route.request().url().includes(".dark.css") ? "dark" : "light"), contentType: "text/css" }));
    await page.evaluate(async () => {
      const second = document.getElementById("second");
      second.removeAttribute("data-theme");
      second.classList.remove("light", "dark");
      await new Promise((resolve, reject) => {
        const link = document.createElement("link");
        link.id = "byVIEWtheme";
        link.rel = "stylesheet";
        link.href = "https://legacy.test/yaml.light.css?cache=1#theme";
        link.onload = resolve;
        link.onerror = reject;
        document.head.appendChild(link);
      });
      await renderTheme(second);
      await renderTheme(document.getElementById("third"));
    });
    await page.locator("#second .byVIEWthemeToggle").click();
    await page.waitForFunction(() => getComputedStyle(document.getElementById("second")).backgroundColor === "rgb(39, 40, 34)");
    assert.equal(await color("third"), "rgb(39, 40, 34)");
    assert.equal(await color("first"), "rgb(250, 250, 245)");
    assert.equal(await page.locator("#first .byVIEWthemeToggle").getAttribute("aria-label"), "Switch to dark theme");
    assert.equal(await page.locator("#byVIEWtheme").getAttribute("href"), "https://legacy.test/yaml.dark.css?cache=1#theme");
    await page.evaluate(async () => {
      document.getElementById("byVIEWtheme").remove();
      await renderTheme(document.getElementById("second"));
    });
    await page.locator("#second .byVIEWthemeToggle").click();
    assert.equal(await page.locator("#second").getAttribute("data-theme"), "dark");
    assert.equal(await color("third"), "rgb(250, 250, 245)");
  } finally {
    await browser.close();
  }
});

// --- PALETTES AND CONTRAST ---
test("named palettes retain mode, isolate custom CSS, and meet High Contrast targets", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const warnings = [];
    page.on("console", (message) => {
      if (message.type() === "warning" && message.text().includes("yaml.themes.css")) warnings.push(message.text());
    });
    await page.setContent('<div id="outside">Host</div><div id="viewer"></div><div id="other" data-theme="dark"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../yaml.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../yaml.js") });
    await page.evaluate(
      async (args) => {
        window.renderPalette = async (id) => {
          const controller = window.byYAMLviewer(document.getElementById(id), ...args.slice(0, 1), { ...args[1], animations: false });
          if (controller?.ready) await controller.ready;
        };
        await renderPalette("viewer");
        await renderPalette("other");
      },
      ["name: Theme\nactive: true"]
    );
    const root = page.locator("#viewer");
    const background = () => root.evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.equal(await background(), "rgb(250, 250, 245)", "Default remains Monokai Light");
    for (const [palette, colors] of Object.entries({
      monokai: ["rgb(250, 250, 245)", "rgb(39, 40, 34)"],
      github: ["rgb(255, 255, 255)", "rgb(13, 17, 23)"],
      solarized: ["rgb(253, 246, 227)", "rgb(0, 43, 54)"],
      "high-contrast": ["rgb(255, 255, 255)", "rgb(0, 0, 0)"]
    })) {
      await root.evaluate((element, palette) => {
        element.dataset.theme = palette;
        element.classList.remove("light", "dark");
      }, palette);
      assert.equal(await background(), colors[0], palette);
      await root.locator(".byVIEWthemeToggle").click();
      assert.equal(await root.getAttribute("data-theme"), palette);
      assert.equal(await background(), colors[1], palette);
      await page.evaluate(() => renderPalette("viewer"));
      assert.equal(await background(), colors[1], "Rendering preserves the palette and mode");
      await root.locator(".byVIEWthemeToggle").click();
      assert.equal(await background(), colors[0]);
    }
    assert.equal(warnings.length, 0, "Core palettes need no optional pack");
    await root.evaluate((element) => {
      element.dataset.theme = "dracula";
    });
    await page.evaluate(() => renderPalette("viewer"));
    assert.match(warnings[0], /yaml\.themes\.css/);
    await page.evaluate(() => renderPalette("viewer"));
    assert.equal(warnings.length, 1, "Repeated renders do not repeat a missing-pack warning");
    await root.evaluate((element) => {
      element.dataset.theme = "custom-user";
    });
    await page.evaluate(() => renderPalette("viewer"));
    assert.equal(warnings.length, 1, "Custom CSS names are supported without a pack");
    await page.addStyleTag({ path: path.join(__dirname, "../yaml.themes.css") });
    await root.evaluate((element) => {
      element.dataset.theme = "bubblegum";
    });
    await page.evaluate(() => renderPalette("viewer"));
    assert.equal(warnings.length, 1, "Loaded packs do not warn for other presets");
    const paletteSelect = require("node:fs")
      .readFileSync(path.join(__dirname, "../index.html"), "utf8")
      .match(/<select id="preview-palette"[\s\S]*?<\/select>/)[0];
    const paletteNames = [...paletteSelect.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]).filter((name) => name !== "custom");
    assert.equal(paletteNames.length, 48);
    assert.equal(new Set(paletteNames).size, 48);
    const readme = require("node:fs").readFileSync(path.join(__dirname, "../README.md"), "utf8");
    for (const name of paletteNames) assert.match(readme, new RegExp("\\|\\s*`" + name + "`\\s*\\|"), `${name} must be documented`);
    const failures = await root.evaluate((element, names) => {
      const luminance = (value) => {
        const channels = value.startsWith("#")
          ? value
              .slice(1)
              .match(/../g)
              .map((part) => parseInt(part, 16))
          : value
              .match(/[\d.]+/g)
              .slice(0, 3)
              .map(Number);
        const linear = channels.map((channel) => channel / 255).map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      };
      const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
      const failures = [];
      for (const name of names.filter((name) => !["monokai", "github", "solarized", "high-contrast"].includes(name))) {
        element.dataset.theme = name;
        for (const mode of ["light", "dark"]) {
          element.classList.toggle("dark", mode === "dark");
          element.classList.toggle("light", mode === "light");
          const style = getComputedStyle(element);
          const variables = [...style].map((name) => [name, style.getPropertyValue(name).trim()]).filter(([, value]) => /^#[\da-f]{6}$/i.test(value));
          const backgrounds = [style.backgroundColor, ...variables.filter(([name]) => /-(?:alt|code-bg|add|remove)$/.test(name)).map(([, value]) => value)];
          const textColors = [["text", style.color], ...variables.filter(([name]) => /-(?:text|secondary|accent|string|literal|error|warn|info|debug|comment|keyword|number|property|tag|link|quote|toggle|placeholder|muted)$/.test(name))];
          for (const [property, value] of textColors) {
            if (backgrounds.some((background) => contrast(value, background) < 4.5)) failures.push(`${name} ${mode} ${property}`);
          }
          const border = variables.find(([name]) => /^--by-(?:view|json|md)-border$/.test(name))?.[1];
          if (border && contrast(border, style.backgroundColor) < 3) failures.push(`${name} ${mode} border`);
        }
      }
      element.dataset.theme = "high-contrast";
      return failures;
    }, paletteNames);
    assert.deepEqual(failures, [], "New palettes must keep text and control boundaries readable in both modes");
    for (const mode of ["light", "dark"]) {
      await root.evaluate((element, mode) => {
        element.classList.toggle("dark", mode === "dark");
        element.classList.toggle("light", mode === "light");
      }, mode);
      await root.locator(".byVIEWcopy").focus();
      const measurements = await root.evaluate((element) => {
        const style = getComputedStyle(element);
        const luminance = (color) => {
          const channels = color.startsWith("#")
            ? color
                .slice(1)
                .match(/../g)
                .map((part) => parseInt(part, 16))
            : color
                .match(/[\d.]+/g)
                .slice(0, 3)
                .map(Number);
          const values = channels.map((channel) => channel / 255).map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
          return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
        };
        const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
        const variables = [...style].filter((property) => property.startsWith("--by-")).map((property) => [property, style.getPropertyValue(property).trim()]);
        const backgrounds = [style.backgroundColor, ...variables.filter(([property]) => /-(?:alt|code-bg|add|remove)$/.test(property)).map(([, value]) => value)];
        const text = variables.filter(([property, value]) => /^#[0-9a-f]{6}$/i.test(value) && !/-(?:bg|border|alt|add|remove)$/.test(property));
        const button = getComputedStyle(element.querySelector(".byVIEWcopy"));
        return {
          text: text.flatMap(([property, value]) => backgrounds.map((bg) => ({ property, ratio: contrast(value, bg) }))),
          border: contrast(button.borderTopColor, style.backgroundColor),
          focus: contrast(button.outlineColor, style.backgroundColor),
          outline: parseFloat(button.outlineWidth)
        };
      });
      assert.ok(measurements.text.length >= 5);
      for (const { property, ratio } of measurements.text) assert.ok(ratio >= 7, mode + " " + property + ": " + ratio.toFixed(2));
      assert.ok(measurements.border >= 3);
      assert.ok(measurements.focus >= 3 && measurements.outline >= 2);
    }
    await root.evaluate((element) => {
      element.classList.add("light", "dark");
      element.dataset.theme = "github";
    });
    assert.equal(await background(), "rgb(13, 17, 23)", "Dark wins when both classes exist");
    await root.evaluate((element) => {
      element.dataset.theme = "light";
    });
    assert.equal(await background(), "rgb(250, 250, 245)", "Legacy mode aliases override classes");
    await page.addStyleTag({ content: '.byYAMLdocument.light[data-theme="custom-ocean"] { --by-view-bg: #f3f8fc; } .byYAMLdocument.dark[data-theme="custom-ocean"] { --by-view-bg: #102a43; }' });
    await root.evaluate((element) => {
      element.dataset.theme = "custom-ocean";
      element.classList.remove("light", "dark");
    });
    await page.route("https://legacy.test/**", (route) => route.fulfill({ body: "", contentType: "text/css" }));
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const link = document.createElement("link");
          link.id = "byVIEWtheme";
          link.rel = "stylesheet";
          link.href = "https://legacy.test/yaml.dark.css?cache=1#theme";
          link.onload = resolve;
          document.head.appendChild(link);
        })
    );
    await page.evaluate(() => renderPalette("viewer"));
    assert.equal(await background(), "rgb(250, 250, 245)", "An unclassified custom palette starts in Light");
    await root.locator(".byVIEWthemeToggle").click();
    assert.equal(await background(), "rgb(16, 42, 67)");
    assert.equal(await root.getAttribute("data-theme"), "custom-ocean");
    assert.equal(await page.locator("#byVIEWtheme").getAttribute("href"), "https://legacy.test/yaml.dark.css?cache=1#theme");
    assert.equal(await page.locator("#other").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(39, 40, 34)");
    assert.equal(await page.locator("#outside").evaluate((element) => getComputedStyle(element).getPropertyValue("--by-view-muted")), "");
  } finally {
    await browser.close();
  }
});

// --- CONTROLS AND CLIPBOARD FEEDBACK ---
test("viewer defaults, optional tools, and copy feedback", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 720 }, reducedMotion: "reduce" });
    await page.setContent('<div id="viewer"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../yaml.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../yaml.js") });
    await page.evaluate(
      (args) => {
        window.renderUI = async (options = {}) => {
          const result = byYAMLviewer(document.getElementById("viewer"), ...args, options);
          await result?.ready;
        };
      },
      ["needle: value\nbranch: [1, 2]"]
    );
    await page.evaluate(() => renderUI());
    assert.equal(await page.locator(".byVIEWcontrols button").count(), 5);
    assert.equal(await page.locator(".byVIEWfontSizes").count(), 1);
    assert.equal(await page.locator(".byVIEWactions :is(input, select, button):visible").count(), 0);
    assert.equal(await page.locator(".byVIEWstatus:visible").count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const controlsPosition of ["top", "bottom"]) {
      for (const toolbar of [true, false]) {
        const edges = await page.evaluate(
          async (options) => {
            await renderUI(options);
            const host = document.getElementById("viewer");
            const bounds = host.getBoundingClientRect();
            const style = getComputedStyle(host);
            const panel = host.querySelector(".byVIEWpanel").getBoundingClientRect();
            const first = host.firstElementChild,
              last = host.lastElementChild;
            const topToolbar = first.classList.contains("byVIEWtoolbar");
            const bottomToolbar = last.classList.contains("byVIEWtoolbar");
            const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
            return [
              ((topToolbar ? first.getBoundingClientRect().top : panel.top) - bounds.top - parseFloat(style.borderTopWidth)) / rem,
              (bounds.bottom - parseFloat(style.borderBottomWidth) - (bottomToolbar ? last.getBoundingClientRect().bottom : panel.bottom)) / rem
            ];
          },
          { controlsPosition, toolbar }
        );
        const expected = [toolbar && controlsPosition === "top" ? 0 : 0.75, toolbar && controlsPosition === "bottom" ? 0 : 0.75];
        assert.ok(
          edges.every((edge, index) => Math.abs(edge - expected[index]) < 0.01),
          `${controlsPosition}, toolbar=${toolbar}: ${edges}`
        );
      }
    }
    await page.evaluate(() => renderUI({ displayContainer: false, statusBar: true }));
    assert.equal(await page.locator(".byVIEWstatus:visible").count(), 0);
    assert.equal(await page.locator(".byVIEWpanel").evaluate((panel) => parseFloat(getComputedStyle(panel).borderTopWidth)), 0);
    assert.match(await page.locator(".byVIEWcontent").textContent(), /needle/);
    await page.evaluate(() => renderUI({ displayContainer: true, statusBar: false }));
    assert.equal(await page.locator(".byVIEWstatus:visible").count(), 0);
    assert.ok(await page.locator(".byVIEWpanel").evaluate((panel) => parseFloat(getComputedStyle(panel).borderTopWidth) > 0));
    await page.evaluate(() => renderUI());
    await page.evaluate(() => renderUI({ fontSizeControls: false, statusBar: false }));
    assert.equal(await page.locator(".byVIEWfontSizes").count(), 0);
    assert.equal(await page.locator(".byVIEWstatus:visible").count(), 0);
    await page.evaluate(() => renderUI());
    await page.evaluate(() => renderUI({ controlsSize: "invalid" }));
    assert.equal(await page.locator(".byVIEWtoolbar").getAttribute("data-size"), "regular");
    for (const scale of [1, 1.5]) {
      for (const controlsSize of ["xs", "small", "regular", "large", "xl"]) {
        for (const font of ["ui-monospace, monospace", "Georgia, serif"]) {
          for (const mode of ["light", "dark"]) {
            const errors = await page.evaluate(
              async ({ scale, controlsSize, font, mode }) => {
                document.documentElement.style.fontSize = `${scale}rem`;
                const host = document.getElementById("viewer");
                host.dataset.theme = mode;
                host.style.setProperty("--by-view-controls-font", font);
                await renderUI({ controlsSize });
                const button = host.querySelector(".byVIEWthemeToggle");
                const rect = button.getBoundingClientRect();
                const style = getComputedStyle(button),
                  thumb = getComputedStyle(button, "::after");
                const innerWidth = rect.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
                const innerHeight = rect.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
                const position = (value, extent) => (value.endsWith("%") ? (parseFloat(value) * extent) / 100 : parseFloat(value));
                const transform = new DOMMatrixReadOnly(thumb.transform);
                const centerX = rect.left + parseFloat(style.borderLeftWidth) + position(thumb.left, innerWidth) + transform.m41 + parseFloat(thumb.width) / 2;
                const centerY = rect.top + parseFloat(style.borderTopWidth) + position(thumb.top, innerHeight) + transform.m42 + parseFloat(thumb.height) / 2;
                const icons = [...button.querySelectorAll("svg")];
                const icon = icons[mode === "dark" ? 1 : 0].getBoundingClientRect();
                const toolbarSize = parseFloat(getComputedStyle(host.querySelector(".byVIEWtoolbar")).fontSize);
                const expectedSize = { xs: 0.5, small: 0.7, regular: 0.875, large: 1, xl: 1.25 }[controlsSize] * parseFloat(getComputedStyle(document.documentElement).fontSize);
                return [Math.abs(centerX - icon.x - icon.width / 2), Math.abs(centerY - icon.y - icon.height / 2), Math.abs(centerY - rect.y - rect.height / 2), Math.abs(toolbarSize - expectedSize)];
              },
              { scale, controlsSize, font, mode }
            );
            assert.ok(
              errors.every((error) => error < 0.06),
              `${scale} ${controlsSize} ${font} ${mode}: ${errors}`
            );
          }
        }
      }
    }
    await page.evaluate(async () => {
      document.documentElement.style.fontSize = "";
      document.getElementById("viewer").style.removeProperty("--by-view-controls-font");
      await renderUI();
    });
    for (const mode of ["light", "dark"]) {
      await page.locator("#viewer").evaluate((element, mode) => {
        element.dataset.theme = mode;
      }, mode);
      await page.evaluate(() => renderUI({ toolbar: false, controlsPosition: "bottom", sorting: false, pagination: false, collapsible: false, details: false, lineNumbers: false, loadMore: false }));
      assert.equal(await page.locator("#viewer :is(button, input, select, summary):visible").count(), 0);
      assert.equal(await page.locator(".byVIEWtoolbar").count(), 0);
      assert.equal(await page.locator("#viewer").evaluate((element) => element.classList.contains("byVIEWbottom")), false);
      assert.match(await page.locator("#viewer").textContent(), /needle/);
    }
    await page.evaluate(() => renderUI({ expandCollapse: true, collapsible: false, collapsed: true }));
    assert.equal(await page.locator("summary").count(), 0);
    assert.equal(await page.getByRole("button", { name: /all YAML nodes/ }).count(), 0);
    assert.match(await page.locator("#viewer").textContent(), /needle/);
    await page.evaluate(() => renderUI({ credits: false }));
    assert.equal(await page.locator(".byVIEWinfo").count(), 0);
    assert.equal(await page.locator(".byVIEWcontrols button").count(), 5);
    await page.evaluate(() => renderUI({ credits: false, themeToggle: false, fontSizeControls: false, copyButton: false }));
    assert.equal(await page.locator(".byVIEWtoolbar").count(), 0);
    await page.evaluate((options) => renderUI({ fontSizeControls: true, ...options }), { search: true, copyValues: true, expandCollapse: true, statusBar: true });
    assert.equal(await page.locator(".byVIEWfontSize").count(), 3);
    assert.equal(await page.locator(".byVIEWpanel > .byVIEWstatus:visible").count(), 1);
    assert.ok(await page.locator(".byVIEWpanel > .byVIEWstatus").evaluate((status) => parseFloat(getComputedStyle(status).borderBottomWidth) > 0));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("Denied");
          }
        }
      });
    });
    await page.locator(".byVIEWcopy").click();
    await page.mouse.move(0, 0);
    await page.locator(".byVIEWcopy").evaluate((element) => element.blur());
    assert.equal(await page.locator(".byVIEWcopy").getAttribute("data-state"), "error");
    assert.equal(await page.locator(".byVIEWcopy").textContent(), "Failed");
    await page.evaluate(() => {
      navigator.clipboard.writeText = async (value) => {
        window.copiedSource = value;
      };
    });
    await page.locator(".byVIEWcopy").click();
    assert.equal(await page.locator(".byVIEWcopy").getAttribute("data-state"), "success");
    assert.match(await page.evaluate(() => copiedSource), /needle/);
  } finally {
    await browser.close();
  }
});

// --- DOCUMENT AND CONTENT SURFACES ---
test("document and content backgrounds stay independent through theme and toolbar changes", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort());
    await page.setContent('<div id="viewer" data-theme="light"></div><div id="neighbor" data-theme="light"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../yaml.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../yaml.js") });
    await page.evaluate(async () => {
      for (const id of ["viewer", "neighbor"]) {
        const result = byYAMLviewer(document.getElementById(id), "ready: true");
        await result?.ready;
      }
    });
    const root = page.locator("#viewer");
    const neighbor = await page.locator("#neighbor").evaluate((element) => getComputedStyle(element).backgroundColor);
    await root.evaluate((element) => {
      element.style.setProperty("--by-view-document-bg", "transparent");
      element.style.setProperty("--by-view-container-bg", "#123456");
    });
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#viewer .byVIEWcopy")).backgroundColor === "rgb(18, 52, 86)");
    for (const changeMode of [false, true]) {
      if (changeMode) await root.locator(".byVIEWthemeToggle").click();
      // The document fade can finish after the independently styled copy control.
      await root.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      assert.match(await root.evaluate((element) => getComputedStyle(element).backgroundColor), /^rgba\([^)]*, 0\)$/);
      assert.equal(await root.locator(".byVIEWpanel").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(18, 52, 86)");
      assert.equal(
        await root
          .locator(".byVIEWcopy")
          .first()
          .evaluate((element) => getComputedStyle(element).backgroundColor),
        "rgb(18, 52, 86)"
      );
      assert.equal(await root.locator(".byVIEWtoolbar").evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
    }
    assert.equal(await page.locator("#neighbor").evaluate((element) => getComputedStyle(element).backgroundColor), neighbor);
    await root.evaluate((element) => element.style.removeProperty("--by-view-container-bg"));
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#viewer .byVIEWcopy")).backgroundColor === "rgb(39, 40, 34)");
    assert.notEqual(
      await root
        .locator(".byVIEWcopy")
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      "rgba(0, 0, 0, 0)"
    );
  } finally {
    await browser.close();
  }
});

// --- INTERACTION MOTION ---
test("animation options preserve initial visibility and override system motion preferences", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.route("https://cdn.jsdelivr.net/**", (route) => (route.request().url().endsWith("fontawesome.min.css") ? route.fulfill({ body: "", contentType: "text/css" }) : route.abort()));
    await page.setContent('<div id="motion-viewer" data-theme="light"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../yaml.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../yaml.js") });
    await page.evaluate(() => {
      window.renderMotion = async (animations, appearAnimation = false) => {
        window.motionController = byYAMLviewer(document.getElementById("motion-viewer"), "ready: true", { animations, appearAnimation });
        await motionController?.ready;
      };
    });
    await page.evaluate(() => renderMotion());
    const root = page.locator("#motion-viewer");
    assert.equal(await root.evaluate((element) => element.classList.contains("byVIEWmotion")), true);
    assert.equal(await root.evaluate((element) => getComputedStyle(element).opacity), "1");
    assert.equal(await root.evaluate((element) => element.getAnimations({ subtree: true }).length), 0, "Initial content does not animate");
    assert.equal(
      await root
        .locator("button")
        .first()
        .evaluate((element) => getComputedStyle(element).transitionDuration.split(",")[0]),
      "0.18s"
    );
    // Disclosure size/exit motion progressively enhances engines supporting intrinsic-size transitions.
    if (await page.evaluate(() => CSS.supports("interpolate-size", "allow-keywords"))) {
      const disclosure = await root.evaluateHandle((element) => {
        const details = document.createElement("details");
        details.id = "motion-disclosure";
        details.innerHTML = "<summary>Details</summary><p>Already available content</p>";
        element.append(details);
        getComputedStyle(details, "::details-content").blockSize;
        return details;
      });
      await disclosure.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForFunction(() => getComputedStyle(document.getElementById("motion-disclosure"), "::details-content").opacity === "0");
      const opening = await disclosure.evaluate(async (details) => {
        details.open = true;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return Number(getComputedStyle(details, "::details-content").opacity);
      });
      assert.ok(opening > 0 && opening < 1, "A deliberate disclosure eases in even with reduced motion requested");
      await page.waitForFunction(() => getComputedStyle(document.getElementById("motion-disclosure"), "::details-content").opacity === "1");
      await disclosure.evaluate((details) => {
        details.open = false;
      });
      await page.waitForFunction(() => getComputedStyle(document.getElementById("motion-disclosure"), "::details-content").opacity === "0");
      assert.equal(await disclosure.evaluate((details) => details.open), false);
    } else {
      await root.evaluate((element) => {
        const details = document.createElement("details");
        details.id = "fallback-disclosure";
        details.innerHTML = "<summary>Details</summary><p>Available content</p>";
        element.append(details);
      });
      await page.locator("#fallback-disclosure summary").click();
      await page.locator("#fallback-disclosure p").waitFor({ state: "visible" });
      await page.locator("#fallback-disclosure summary").click();
      await page.locator("#fallback-disclosure p").waitFor({ state: "hidden" });
    }
    await page.evaluate(() => renderMotion(false));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.equal(await root.evaluate((element) => element.classList.contains("byVIEWmotion")), false);
    assert.equal(
      await root
        .locator("button")
        .first()
        .evaluate((element) => getComputedStyle(element).transitionDuration),
      "0s"
    );
    assert.equal(await root.evaluate((element) => element.getAnimations({ subtree: true }).length), 0);
    await page.emulateMedia({ media: "screen", reducedMotion: "reduce" });
    await page.evaluate(() => renderMotion(true));
    await page.waitForFunction(() => document.getElementById("motion-viewer").classList.contains("byVIEWready"));
    const fade = await root.evaluate((element) => {
      const before = getComputedStyle(element).backgroundColor;
      element.querySelector('[aria-label^="Switch to"]').click();
      const transition = element.getAnimations().find((animation) => animation.transitionProperty === "background-color");
      if (!transition) return { active: false };
      transition.pause();
      transition.currentTime = 90;
      const middle = getComputedStyle(element).backgroundColor;
      transition.finish();
      return { active: true, before, middle, after: getComputedStyle(element).backgroundColor, fontTransition: getComputedStyle(element).transitionProperty.includes("font-size") };
    });
    assert.equal(fade.active, true, "Theme backgrounds fade after the first paint");
    assert.notEqual(fade.middle, fade.before);
    assert.notEqual(fade.middle, fade.after);
    assert.equal(fade.fontTransition, false);
    await root.evaluate((element) => {
      element.dataset.theme = "high-contrast";
    });
    assert.equal(await root.evaluate((element) => element.getAnimations().filter((animation) => animation.transitionProperty === "background-color").length), 0);
    const entrance = await page.evaluate(async () => {
      await renderMotion(true, true);
      const element = document.getElementById("motion-viewer");
      const animation = element.getAnimations().find((animation) => animation.animationName === "byVIEWappear");
      if (!animation) return { active: false };
      animation.pause();
      animation.currentTime = 90;
      return { active: true, opacity: Number(getComputedStyle(element).opacity), content: element.textContent.length };
    });
    assert.equal(entrance.active, true, "Entrance motion is explicit even when the system requests reduced motion");
    assert.ok(entrance.opacity > 0 && entrance.opacity < 1);
    assert.ok(entrance.content > 0, "Rendering completes without waiting for the animation");
    await page.evaluate(() => renderMotion(false, true));
    assert.equal(await root.evaluate((element) => element.getAnimations({ subtree: true }).length), 0, "Animations off overrides the requested entrance");
  } finally {
    await browser.close();
  }
});

// --- INITIAL APPEARANCE ---
test("appearance options override markup and preserve independent viewer state", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.route("https://cdn.jsdelivr.net/**", (route) => route.fulfill({ body: "", contentType: "text/css" }));
    await page.setContent('<style>html{font-size:20px}</style><div id="appearance" class="host light" data-theme="light"></div><div id="neighbor" class="dark" data-theme="monokai" style="font-size:2rem">Neighbor</div>');

    await page.addStyleTag({ path: path.join(__dirname, "../yaml.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../yaml.js") });
    await page.evaluate(() => {
      window.appearanceTarget = document.getElementById("appearance");
      window.renderAppearance = async (options = {}) => {
        window.appearanceInstance = byYAMLviewer(appearanceTarget, "answer: 42", options);
        await appearanceInstance?.ready;
      };
    });
    const neighbor = await page.locator("#neighbor").evaluate((element) => element.outerHTML);
    await page.evaluate(() => renderAppearance({ theme: "dark", palette: "github", fontSize: 1.5, animations: false }));
    assert.deepEqual(
      await page
        .locator("#appearance")
        .evaluate((element) => [element.classList.contains("host"), element.classList.contains("dark"), element.classList.contains("light"), element.dataset.theme, element.style.fontSize, getComputedStyle(element).fontSize]),
      [true, true, false, "github", "1.5rem", "30px"]
    );
    const controls = page.locator("#appearance .byVIEWthemeToggle");
    assert.equal(await controls.getAttribute("aria-label"), "Switch to light theme");
    await controls.click();
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.classList.contains("light"), element.dataset.theme, element.style.fontSize]), [true, "github", "1.5rem"]);
    const buttonSize = await controls.evaluate((element) => getComputedStyle(element).fontSize);
    await page.getByRole("button", { name: "Increase text size", exact: true }).click();
    await page.evaluate(() => renderAppearance());
    assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), "1.625rem");
    await page.getByRole("button", { name: "Reset text size", exact: true }).click();
    assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), "1.5rem");
    assert.equal(await controls.evaluate((element) => getComputedStyle(element).fontSize), buttonSize);
    await page.evaluate(() => renderAppearance({ fontSize: 1.25 }));
    assert.equal(await page.locator("#appearance").evaluate((element) => getComputedStyle(element).fontSize), "25px");
    await page.getByRole("button", { name: "Increase text size", exact: true }).click();
    await page.getByRole("button", { name: "Reset text size", exact: true }).click();
    assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), "1.25rem");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "24px";
    });
    assert.equal(await page.locator("#appearance").evaluate((element) => getComputedStyle(element).fontSize), "30px", "The multiplier follows root text-size changes");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    for (const [fontSize, expected] of [
      ["1.25rem", 25],
      ["1.25em", 25],
      ["20px", 20],
      ["125%", 25],
      ["1px", 10],
      ["100px", 60],
      ["4em", 60]
    ]) {
      await page.evaluate((fontSize) => renderAppearance({ fontSize }), fontSize);
      assert.equal(await page.locator("#appearance").evaluate((element) => parseFloat(getComputedStyle(element).fontSize)), expected, fontSize);
      const preset = await page.locator("#appearance").evaluate((element) => [element.style.fontSize, element.dataset.byViewDefaultFontSize]);
      assert.equal(preset[0], preset[1]);
      await page.getByRole("button", { name: expected === 60 ? "Decrease text size" : "Increase text size", exact: true }).click();
      await page.getByRole("button", { name: "Reset text size", exact: true }).click();
      assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), preset[0]);
    }
    await page.evaluate(() => {
      document.body.style.fontSize = "1.5rem";
      return renderAppearance({ fontSize: "1em" });
    });
    assert.equal(await page.locator("#appearance").evaluate((element) => getComputedStyle(element).fontSize), "30px", "em remains relative to the parent");
    await page.evaluate(() => {
      document.body.style.fontSize = "";
      document.documentElement.style.fontSize = "24px";
      return renderAppearance({ fontSize: "100px" });
    });
    assert.equal(await page.locator("#appearance").evaluate((element) => getComputedStyle(element).fontSize), "72px", "CSS values retain the rem limit when the root size changes");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    for (const [requested, expected] of [
      [-1, 0.5],
      [0, 0.5],
      [0.25, 0.5],
      [0.5, 0.5],
      [3, 3],
      [4, 3]
    ]) {
      await page.evaluate((fontSize) => renderAppearance({ fontSize }), requested);
      assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), `${expected}rem`);
      assert.equal(await page.locator("#appearance").evaluate((element) => element.dataset.byViewDefaultFontSize), `${expected}rem`);
      assert.equal(await page.getByRole("button", { name: "Decrease text size", exact: true }).isDisabled(), expected === 0.5);
      assert.equal(await page.getByRole("button", { name: "Increase text size", exact: true }).isDisabled(), expected === 3);
      await page.getByRole("button", { name: expected === 3 ? "Decrease text size" : "Increase text size", exact: true }).click();
      await page.getByRole("button", { name: "Reset text size", exact: true }).click();
      assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), `${expected}rem`);
    }
    await page.evaluate(() => {
      appearanceTarget.dataset.theme = "dark";
      appearanceTarget.classList.remove("dark");
      appearanceTarget.classList.add("light");
      return renderAppearance({ palette: "high-contrast", toolbar: false });
    });
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.dataset.theme, element.classList.contains("dark"), getComputedStyle(element).colorScheme]), ["high-contrast", true, "dark"]);
    await page.evaluate(() => {
      appearanceTarget.dataset.theme = "dark";
      return renderAppearance({ theme: "light", toolbar: false });
    });
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.dataset.theme, element.classList.contains("dark"), element.classList.contains("light")]), ["light", false, true]);
    await page.evaluate(() => renderAppearance({ theme: "dark", palette: "custom-ocean", fontSize: 1.125, toolbar: false }));
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.dataset.theme, element.classList.contains("dark"), element.style.fontSize]), ["custom-ocean", true, "1.125rem"]);
    const preserved = await page.locator("#appearance").evaluate((element) => [element.className, element.dataset.theme, element.style.fontSize]);
    await page.evaluate(() => renderAppearance());
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.className, element.dataset.theme, element.style.fontSize]), preserved);
    await page.evaluate(() => renderAppearance({ theme: null, palette: null, fontSize: null }));
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.className, element.dataset.theme, element.style.fontSize]), preserved, "Blank exported appearance fields retain the container settings");
    // Invalid options must leave the current document intact rather than partially reinitializing it.
    for (const options of [
      { theme: "sepia" },
      { palette: "dark" },
      { palette: "bad name" },
      { fontSize: NaN },
      { fontSize: Infinity },
      { fontSize: "wrong" },
      { fontSize: "inherit" },
      { fontSize: true },
      { theme: "light", palette: "github", fontSize: "1.25" }
    ]) {
      const before = await page.locator("#appearance").evaluate((element) => element.outerHTML);
      const name = await page.evaluate(async (options) => {
        try {
          await renderAppearance(options);
        } catch (error) {
          return error.name;
        }
      }, options);
      assert.equal(name, "RangeError");
      assert.equal(await page.locator("#appearance").evaluate((element) => element.outerHTML), before, "Invalid appearance must not replace the current document");
    }

    assert.equal(await page.locator("#neighbor").evaluate((element) => element.outerHTML), neighbor);
  } finally {
    await browser.close();
  }
});

// --- MOBILE, OFFLINE ASSETS, AND CSP ---
test("local assets render with a strict CSP and touch controls at mobile width", async () => {
  const browser = await launchBrowser();
  try {
    // Firefox supports the touch viewport, but Playwright does not support isMobile for that engine.
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      ...(browserEngine === "firefox" ? {} : { isMobile: true })
    });
    const externalRequests = [],
      violations = [],
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.exposeFunction("recordViolation", (directive) => violations.push(directive));
    await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (event) => window.recordViolation(event.effectiveDirective)));
    // Reject external requests so a missing local dependency cannot silently fall back to a CDN.
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://viewer.test") {
        externalRequests.push(url.href);
        return route.abort();
      }
      if (url.pathname === "/library.js" || url.pathname === "/library.css") {
        const extension = url.pathname.endsWith(".js") ? "js" : "css";
        return route.fulfill({ path: path.join(__dirname, `../yaml.${extension}`), contentType: extension === "js" ? "application/javascript" : "text/css" });
      }
      // An external initializer satisfies script-src 'self'; String.raw preserves the fixture's source escapes.
      if (url.pathname === "/init.js")
        return route.fulfill({
          contentType: "application/javascript",
          body: String.raw`
        const target = document.getElementById("viewer");
        const options = { theme: "light", animations: false, fontSize: 1.125 };
        byYAMLviewer(target, "message:\n  - 日本語\n  - deep: value", options);
      `
        });
      return route.fulfill({
        contentType: "text/html",
        headers: { "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'none'; img-src 'self'" },
        body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="library.css"><div id="viewer"></div><script src="library.js"></script><script src="init.js"></script>'
      });
    });
    await page.goto("https://viewer.test/");
    await page.waitForFunction(() => document.getElementById("viewer").textContent.includes("日本語"));
    const theme = page.getByRole("button", { name: /Switch to (dark|light) theme/ });
    // Check touch activation and native keyboard activation on the same named control.
    await theme.tap();
    assert.equal(await page.locator("#viewer").evaluate((element) => element.classList.contains("dark")), true);
    await theme.focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#viewer").evaluate((element) => element.classList.contains("light")), true);
    assert.equal(await page.locator("#viewer").evaluate((element) => getComputedStyle(element).fontSize), "18px");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(violations, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
