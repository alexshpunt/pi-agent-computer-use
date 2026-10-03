import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type ElementHandle, type JSHandle, type Page } from "playwright-core";
import { browserLaunchOptions } from "./browser-launch.ts";
import { BrowserRefusal, type BrowserBackend, type BrowserSnapshot } from "./browser-session.ts";

interface Entry {
  page: Page; generation: number; observedGeneration?: number; observedGeometry?: string;
  elements: Map<string, ElementHandle<HTMLElement | SVGElement>>;
  overlay?: JSHandle<HTMLElement>;
}

/** Windows-only visible browser adapter. Creates its own profile and never connects to an existing browser. */
export class PlaywrightBrowser implements BrowserBackend {
  private context?: BrowserContext;
  private starting?: Promise<BrowserContext>;
  private profile?: string;
  private entries = new Map<string, Entry>();
  private closing = false;
  private readonly reportProfile?: (profile: string) => void;

  /** Report the exact newly created profile lease before launch, so the owner can clean up after disconnect. */
  constructor(reportProfile?: (profile: string) => void) { this.reportProfile = reportProfile; }

  private async launch(): Promise<BrowserContext> {
    if (process.platform !== "win32") throw new BrowserRefusal("Browser helper must run on Windows.");
    const candidates = [
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
    let executable: string | undefined;
    for (const candidate of candidates) {
      try { await access(candidate); executable = candidate; break; } catch { /* Try the other installed browser. */ }
    }
    if (!executable) throw new BrowserRefusal("No supported installed Windows Chrome/Edge found. No browser is installed automatically.");
    const root = path.join(tmpdir(), ".tmp");
    await mkdir(root, { recursive: true });
    this.profile = await mkdtemp(path.join(root, "pi-visible-browser-"));
    this.reportProfile?.(this.profile);
    try {
      const context = await chromium.launchPersistentContext(this.profile, browserLaunchOptions(executable, this.profile));
      context.setDefaultTimeout(4000);
      context.setDefaultNavigationTimeout(20_000);
      context.on("page", page => this.register(page));
      context.pages().forEach(page => this.register(page));
      return context;
    } catch (error) {
      await rm(this.profile, { recursive: true, force: true });
      this.profile = undefined;
      throw error;
    }
  }

  private register(page: Page): string {
    const existing = [...this.entries].find(([, entry]) => entry.page === page);
    if (existing) return existing[0];
    const id = randomUUID();
    const entry: Entry = { page, generation: 0, elements: new Map() };
    this.entries.set(id, entry);
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) { entry.generation++; entry.observedGeneration = undefined; }
    });
    page.on("close", () => this.entries.delete(id));
    page.on("dialog", dialog => { void dialog.dismiss().catch(() => undefined); });
    return id;
  }

  private current(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry || entry.page.isClosed() || !this.context?.browser()?.isConnected())
      throw new BrowserRefusal("Owned page or browser connection is gone.");
    return entry;
  }

  /** Open a new tab in the owned context, or its initial blank tab on first launch. */
  async open(url: string): Promise<string> {
    if (this.closing) throw new BrowserRefusal("Browser is shutting down.");
    const first = !this.context;
    if (!this.context) {
      this.starting = this.launch();
      try { this.context = await this.starting; } finally { this.starting = undefined; }
    }
    if (this.closing) throw new BrowserRefusal("Browser was cancelled during launch.");
    if (!this.context.browser()?.isConnected()) throw new BrowserRefusal("Browser disconnected. Close the owned session before opening another.");
    const page = first ? this.context.pages()[0] : await this.context.newPage();
    const id = this.register(page);
    await page.bringToFront();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return id;
  }

  /** Only pages belonging to the newly created context are discoverable. */
  async list() {
    return Promise.all([...this.entries].filter(([, entry]) => !entry.page.isClosed()).map(async ([id, entry]) =>
      ({ id, url: entry.page.url(), title: await entry.page.title() })));
  }

  /** Select the owned tab and capture bounded top-level DOM semantics plus real viewport PNG. */
  async observe(id: string, hintFor: (id: string) => string = id => id): Promise<BrowserSnapshot> {
    const entry = this.current(id);
    entry.observedGeneration = undefined;
    if (entry.overlay) {
      await entry.overlay.evaluate(node => node.remove()).catch(() => undefined);
      await entry.overlay.dispose().catch(() => undefined); entry.overlay = undefined;
    }
    for (const handle of entry.elements.values()) await handle.dispose().catch(() => undefined);
    entry.elements.clear();
    const page = entry.page;
    await page.bringToFront();
    const generation = entry.generation;
    // Bounded top-document heuristics, not site-specific selectors or a promise to find every widget.
    const candidates = await page.evaluateHandle(() => {
      const selector = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=textbox],[contenteditable=true],[onclick],[jsaction],[tabindex]';
      const visible = (node: Element) => {
        const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const nodes = [...document.body.querySelectorAll('*')].slice(0, 8000);
      const explicit = nodes.filter(node => node.matches(selector) && visible(node));
      const pointers = nodes.filter(node => visible(node) && getComputedStyle(node).cursor === 'pointer' && !node.closest(selector));
      const leaves = pointers.filter(node => !pointers.some(other => other !== node && node.contains(other)));
      return [...new Set([...explicit, ...leaves])].slice(0, 120);
    });
    const handles: ElementHandle<HTMLElement | SVGElement>[] = [];
    try {
      for (const property of (await candidates.getProperties()).values()) {
        const element = property.asElement();
        if (element) handles.push(element as ElementHandle<HTMLElement | SVGElement>);
        else await property.dispose();
      }
    } finally { await candidates.dispose(); }
    const elements: BrowserSnapshot['elements'] = [];
    const labels: { hint: string; x: number; y: number }[] = [];
    for (const handle of handles) {
      const data = await handle.evaluate(element => {
        const input = element as HTMLInputElement;
        const labels = 'labels' in input && input.labels ? [...input.labels].map(label => label.innerText).join(' ') : '';
        const labelled = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
        const tag = element.tagName.toLowerCase();
        const roles: Record<string, string> = { a: 'link', button: 'button', textarea: 'textbox', select: 'combobox', input: 'input' };
        const rect = element.getBoundingClientRect();
        return { role: element.getAttribute('role') ?? roles[tag] ?? tag,
          name: (element.getAttribute('aria-label') || labelled || labels || (element as HTMLElement).innerText || input.placeholder || element.getAttribute('title') || '').trim().slice(0, 300),
          ...(input.type !== 'password' && 'value' in element ? { value: String(input.value).slice(0, 1000) } : {}),
          x: Math.max(0, rect.left), y: Math.max(0, rect.top) };
      });
      const id = randomUUID(); entry.elements.set(id, handle);
      const { x, y, ...semantic } = data;
      elements.push({ id, ...semantic }); labels.push({ hint: hintFor(id), x, y });
    }
    const text = await page.locator('body').innerText();
    const title = await page.title(); const url = page.url();
    entry.overlay = await page.evaluateHandle(labels => {
      const root = document.createElement('div');
      root.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
      const shadow = root.attachShadow({ mode: 'closed' });
      for (const { hint, x, y } of labels) {
        const marker = document.createElement('span'); marker.textContent = hint;
        marker.style.cssText = 'position:absolute;pointer-events:none;background:#ffe66a;color:#111;border:1px solid #111;border-radius:3px;padding:1px 3px;font:bold 13px monospace;line-height:16px;';
        marker.style.left = x + 'px'; marker.style.top = y + 'px'; shadow.append(marker);
      }
      document.documentElement.append(root); return root;
    }, labels);
    const geometry = await this.geometry(page);
    const png = await page.screenshot({ type: 'png', scale: 'css', timeout: 10_000 });
    if (geometry !== await this.geometry(page)) throw new BrowserRefusal('Viewport changed during capture; observe again.');
    entry.observedGeometry = geometry;
    if (generation !== entry.generation || page.isClosed()) throw new BrowserRefusal('Page navigated during observation; read again.');
    if (png.length > 12_000_000) throw new BrowserRefusal('Viewport screenshot exceeds the bounded response size.');
    entry.observedGeneration = generation;
    return { url, title, text: text.slice(0, 16_000), elements, png: png.toString('base64'),
      screenshot: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) },
      browser: this.context?.browser()?.version(), truncated: text.length > 16_000 || handles.length === 120 };
  }

  private async geometry(page: Page): Promise<string> {
    const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, x: scrollX, y: scrollY,
      dpr: devicePixelRatio, scale: visualViewport?.scale, offsetX: visualViewport?.offsetLeft, offsetY: visualViewport?.offsetTop }));
    if (metrics.scale !== 1 || metrics.offsetX !== 0 || metrics.offsetY !== 0)
      throw new BrowserRefusal("Pinch-zoomed viewport is unsupported; restore it before observing.");
    return JSON.stringify(metrics);
  }

  /** Click an observed handle or screenshot point. Never inject global host input or model-supplied selectors. */
  async act(id: string, action: Record<string, unknown>): Promise<void> {
    const entry = this.current(id);
    if (entry.observedGeneration !== entry.generation) throw new BrowserRefusal("Document changed since observation.");
    const handle = entry.elements.get(String(action.element_id));
    const coordinates = action.action === "click" && typeof action.x === "number" && typeof action.y === "number";
    if (coordinates && entry.observedGeometry !== await this.geometry(entry.page))
      throw new BrowserRefusal("Viewport, scroll or zoom changed since the screenshot; observe again.");
    if (["click", "fill", "press"].includes(String(action.action)) && !coordinates) {
      if (!handle || !(await handle.evaluate(element => element.isConnected && element.ownerDocument === document)) || !(await handle.isVisible()))
        throw new BrowserRefusal("Observed element was removed or belongs to an old document.");
    }
    if (action.action === "scroll" || action.action === "navigate") entry.observedGeneration = undefined;
    switch (action.action) {
      case "click":
        if (coordinates) await entry.page.mouse.click(Number(action.x), Number(action.y));
        else await handle!.click();
        break;
      case "fill": await handle!.fill(String(action.text)); break;
      case "press": await handle!.press(String(action.key)); break;
      case "scroll": await entry.page.evaluate(delta => window.scrollBy(0, delta), Number(action.delta_y)); break;
      case "navigate": await entry.page.goto(String(action.url), { waitUntil: "domcontentloaded" }); break;
      default: throw new BrowserRefusal("Unsupported browser action.");
    }
  }

  /** Close only a known tab from the owned context. */
  async closeTab(id: string): Promise<void> { await this.current(id).page.close({ runBeforeUnload: false }); }

  /** Close the owned context (including an in-flight launch), then delete only its disposable profile. */
  async close(): Promise<void> {
    this.closing = true;
    // Keep closing=true on failure, so a later open cannot reuse an uncertain context/profile.
    const context = this.context ?? await this.starting?.catch(() => undefined);
    await context?.close();
    this.context = undefined;
    this.entries.clear();
    if (this.profile) { await rm(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); this.profile = undefined; }
    this.closing = false;
  }
}
