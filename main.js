const { app, BrowserWindow, BrowserView, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { OpenAI } = require('openai');

const isDev = process.env.NODE_ENV === 'development';

// ─── Load .env ────────────────────────────────────────────────────────────────
// Parse .env manually — no dotenv dependency needed
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes if present
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch (_) {
    // .env not present — silently continue
  }
})();

let mainWindow;
let browserView;
let openaiClient = null;
let apiKey = '';
let agentAbortController = null; // used to stop a running agent task

// Auto-initialize OpenAI client from environment if key is available
if (process.env.OPENAI_KEY) {
  apiKey = process.env.OPENAI_KEY;
  openaiClient = new OpenAI({ apiKey });
}

// Layout state
let sidebarOpen = true;
let modalOpen = false;

const SIDEBAR_WIDTH = 380;
const TOOLBAR_HEIGHT = 56;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeUrl(url) {
  const u = (url || '').trim();
  if (!u) return 'https://www.google.com';
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  if (u.includes('.') && !u.includes(' ')) return 'https://' + u;
  return `https://www.google.com/search?q=${encodeURIComponent(u)}`;
}

function canGoBack(wc) {
  try { return wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(); }
  catch (_) { return false; }
}
function canGoForward(wc) {
  try { return wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(); }
  catch (_) { return false; }
}
function goBack(wc) {
  try { if (wc.navigationHistory) wc.navigationHistory.goBack(); else wc.goBack(); } catch (_) {}
}
function goForward(wc) {
  try { if (wc.navigationHistory) wc.navigationHistory.goForward(); else wc.goForward(); } catch (_) {}
}

function updateBrowserViewBounds() {
  if (!mainWindow || !browserView) return;
  const [width, height] = mainWindow.getContentSize();
  if (modalOpen) {
    browserView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: 1, height: 1 });
    return;
  }
  const usedSidebarWidth = sidebarOpen ? SIDEBAR_WIDTH : 0;
  browserView.setBounds({
    x: 0,
    y: TOOLBAR_HEIGHT,
    width: Math.max(1, width - usedSidebarWidth),
    height: Math.max(1, height - TOOLBAR_HEIGHT),
  });
}

// Wait for page to finish loading
function waitForPageLoad(timeout = 8000) {
  return new Promise((resolve) => {
    if (browserView.webContents.isLoading()) {
      const onStop = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        browserView.webContents.removeListener('did-stop-loading', onStop);
        resolve();
      }, timeout);
      browserView.webContents.once('did-stop-loading', onStop);
    } else {
      resolve();
    }
  });
}

// Rich DOM snapshot — what the agent actually uses to reason
async function getDOMSnapshot() {
  const wc = browserView?.webContents;
  if (!wc) return { url: '', title: '', pageText: '', interactive: [], inputFields: [], error: 'No BrowserView' };

  // ── Health check: detect dead/white/crashed pages ──────────────────────────
  try {
    const health = await wc.executeJavaScript(`
      (function() {
        const body = document.body;
        if (!body) return { alive: false, reason: 'no-body' };
        const html = body.innerHTML || '';
        if (html.length < 20) return { alive: false, reason: 'empty-body', len: html.length };
        if (body.children.length === 0) return { alive: false, reason: 'no-children' };
        return { alive: true };
      })()
    `);

    if (!health.alive) {
      // Try reloading the page to recover
      console.error('Page appears dead/crashed (' + health.reason + '), reloading...');
      wc.reload();
      await waitForPageLoad(10000);
      await new Promise(r => setTimeout(r, 500));

      // Re-check after reload
      const recheck = await wc.executeJavaScript(`
        (function() {
          const body = document.body;
          if (!body || (body.innerHTML || '').length < 20) return false;
          return true;
        })()
      `);
      if (!recheck) {
        return {
          url: wc.getURL(),
          title: '',
          pageText: '',
          interactive: [],
          inputFields: [],
          error: 'Page is blank/crashed even after reload',
          reloaded: true,
        };
      }
    }
  } catch (healthErr) {
    // Health check itself failed — page is very dead
    try {
      wc.reload();
      await waitForPageLoad(10000);
      await new Promise(r => setTimeout(r, 500));
    } catch (_) {}
    return {
      url: wc.getURL(),
      title: '',
      pageText: '',
      interactive: [],
      inputFields: [],
      error: 'Health check failed: ' + healthErr.message,
      reloaded: true,
    };
  }

  // ── Full snapshot ──────────────────────────────────────────────────────────
  try {
    return await wc.executeJavaScript(`
      (function() {
        function getSelector(el) {
          if (el.id) return '#' + CSS.escape(el.id);
          if (el.getAttribute('data-testid')) return '[data-testid="' + el.getAttribute('data-testid') + '"]';
          if (el.getAttribute('name')) return el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]';
          if (el.getAttribute('placeholder')) return el.tagName.toLowerCase() + '[placeholder="' + el.getAttribute('placeholder').replace(/"/g,'') + '"]';
          if (el.getAttribute('aria-label')) return '[aria-label="' + el.getAttribute('aria-label').replace(/"/g,'') + '"]';
          if (el.getAttribute('role') === 'searchbox' || el.getAttribute('role') === 'textbox') return '[role="' + el.getAttribute('role') + '"]';
          if (el.getAttribute('type')) return el.tagName.toLowerCase() + '[type="' + el.getAttribute('type') + '"]';
          const cls = Array.from(el.classList).slice(0,2).join('.');
          return cls ? el.tagName.toLowerCase() + '.' + cls : el.tagName.toLowerCase();
        }

        function isVisible(el) {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.top > -300 && r.top < window.innerHeight + 300;
        }

        // All interactive elements — with dedup counter for selector collisions
        const interactive = [];
        const selectorCounts = {};
        document.querySelectorAll(
          'a[href], button, input:not([type="hidden"]), textarea, select,' +
          '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"],' +
          '[role="searchbox"], [role="textbox"], [role="combobox"],' +
          '[tabindex]:not([tabindex="-1"]), label, [onclick], [contenteditable="true"]'
        ).forEach(el => {
          if (!isVisible(el)) return;
          let sel = getSelector(el);
          // Deduplicate: if selector already seen, append :nth-of-type or index
          if (selectorCounts[sel] !== undefined) {
            selectorCounts[sel]++;
            sel = sel + ':eq(' + selectorCounts[sel] + ')';
          } else {
            selectorCounts[sel] = 0;
          }
          const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\\s+/g,' ').substring(0,100);
          if (!text && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable) return;
          interactive.push({
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            selector: sel,
            text,
            href: el.href || null,
            value: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el.value : null,
            checked: (el.type === 'checkbox' || el.type === 'radio') ? el.checked : null,
            disabled: el.disabled || false,
            dataDate: el.getAttribute('data-date') || null,
            dataTestid: el.getAttribute('data-testid') || null,
          });
        });

        // Dedicated list of all focusable input fields (helps agent find search boxes)
        const inputFields = Array.from(document.querySelectorAll(
          'input[type="search"], input[type="text"], input:not([type]), textarea,' +
          '[role="searchbox"], [role="textbox"], [contenteditable="true"]'
        )).filter(isVisible).map(el => ({
          selector: getSelector(el),
          placeholder: el.placeholder || el.getAttribute('aria-label') || '',
          tag: el.tagName.toLowerCase(),
        }));

        // Clean page text
        const clone = document.body.cloneNode(true);
        clone.querySelectorAll('script,style,noscript,svg,img,header,footer,nav,[role="banner"],[role="navigation"]').forEach(e=>e.remove());
        const pageText = clone.innerText.replace(/\\n{3,}/g,'\\n\\n').trim().substring(0, 12000);

        // Detect open calendar pickers — provide compact summary of available dates
        // This helps the agent use select_date without needing to see every calendar cell
        let calendarInfo = null;
        const dateCells = document.querySelectorAll('[data-date]');
        if (dateCells.length > 5) {
          const dates = [];
          const months = new Set();
          dateCells.forEach(cell => {
            const d = cell.getAttribute('data-date');
            const disabled = cell.getAttribute('aria-disabled') === 'true';
            if (d) {
              dates.push({ date: d, disabled });
              const parts = d.split('-');
              if (parts.length >= 2) months.add(parts[0] + '-' + parts[1]);
            }
          });
          calendarInfo = {
            type: 'calendar-picker-open',
            monthsVisible: Array.from(months).sort(),
            dateCount: dates.length,
            firstDate: dates[0]?.date,
            lastDate: dates[dates.length - 1]?.date,
            hint: 'Use select_date({date:"YYYY-MM-DD"}) to pick a date. The calendar is open and has date cells with data-date attributes.',
          };
        }

        return {
          url: window.location.href,
          title: document.title,
          pageText,
          interactive: interactive.slice(0, 150),
          inputFields,
          calendarInfo,
          scrollY: window.scrollY,
          pageHeight: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight,
        };
      })()
    `);
  } catch (e) {
    return { url: wc.getURL(), title: '', pageText: '', interactive: [], inputFields: [], error: e.message };
  }
}

// Human-in-the-loop: pause agent and ask user a question
// Returns a Promise that resolves with the user's answer
const pendingUserQuestions = new Map();
let questionIdCounter = 0;

function askUser(question, options = null) {
  return new Promise((resolve) => {
    const id = ++questionIdCounter;
    pendingUserQuestions.set(id, resolve);
    mainWindow.webContents.send('agent:ask-user', { id, question, options });
  });
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f0f0f',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    icon: path.join(__dirname, 'build/icons/256x256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  browserView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.addBrowserView(browserView);
  updateBrowserViewBounds();

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'dist', 'index.html'));
  }

  browserView.webContents.loadURL('https://www.google.com');

  browserView.webContents.on('did-start-loading', () => {
    mainWindow.webContents.send('browser:loading', true);
  });
  browserView.webContents.on('did-stop-loading', () => {
    mainWindow.webContents.send('browser:loading', false);
    mainWindow.webContents.send('browser:url-changed', browserView.webContents.getURL());
    mainWindow.webContents.send('browser:title-changed', browserView.webContents.getTitle());
    mainWindow.webContents.send('browser:nav-state', {
      canGoBack: canGoBack(browserView.webContents),
      canGoForward: canGoForward(browserView.webContents),
    });
  });
  browserView.webContents.on('did-navigate', (_, url) => {
    mainWindow.webContents.send('browser:url-changed', url);
    mainWindow.webContents.send('browser:nav-state', {
      canGoBack: canGoBack(browserView.webContents),
      canGoForward: canGoForward(browserView.webContents),
    });
  });
  browserView.webContents.on('did-navigate-in-page', (_, url) => {
    mainWindow.webContents.send('browser:url-changed', url);
    mainWindow.webContents.send('browser:nav-state', {
      canGoBack: canGoBack(browserView.webContents),
      canGoForward: canGoForward(browserView.webContents),
    });
  });
  browserView.webContents.on('page-title-updated', (_, title) => {
    mainWindow.webContents.send('browser:title-changed', title);
  });
  browserView.webContents.on('page-favicon-updated', (_, favicons) => {
    if (favicons.length > 0) mainWindow.webContents.send('browser:favicon-changed', favicons[0]);
  });

  // Inject console log capture buffer into every new page
  browserView.webContents.on('did-finish-load', () => {
    browserView.webContents.executeJavaScript(`
      (function() {
        if (window.__nanobrowse_console_patched) return;
        window.__nanobrowse_console_patched = true;
        window.__nanobrowse_console_logs = [];
        const MAX_LOGS = 200;
        const levels = ['log', 'info', 'warn', 'error', 'debug'];
        levels.forEach(function(level) {
          const orig = console[level].bind(console);
          console[level] = function() {
            orig.apply(console, arguments);
            const entry = {
              level: level,
              args: Array.from(arguments).map(function(a) {
                try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch(_) { return String(a); }
              }),
              timestamp: new Date().toISOString(),
            };
            window.__nanobrowse_console_logs.push(entry);
            if (window.__nanobrowse_console_logs.length > MAX_LOGS) {
              window.__nanobrowse_console_logs.shift();
            }
          };
        });
      })();
    `).catch(() => {}); // silently ignore if page navigated away
  });
  browserView.webContents.setWindowOpenHandler(({ url }) => {
    browserView.webContents.loadURL(url);
    return { action: 'deny' };
  });
  mainWindow.on('resize', updateBrowserViewBounds);
}

// ─── IPC: Layout ──────────────────────────────────────────────────────────────

ipcMain.on('browser:set-sidebar', (_, open) => { sidebarOpen = open; updateBrowserViewBounds(); });
ipcMain.on('browser:set-modal', (_, open) => { modalOpen = open; updateBrowserViewBounds(); });

// ─── IPC: Browser Controls ────────────────────────────────────────────────────

ipcMain.on('browser:navigate', (_, url) => browserView.webContents.loadURL(normalizeUrl(url)));
ipcMain.on('browser:go-back', () => goBack(browserView.webContents));
ipcMain.on('browser:go-forward', () => goForward(browserView.webContents));
ipcMain.on('browser:reload', () => browserView.webContents.reload());
ipcMain.on('browser:stop', () => browserView.webContents.stop());
ipcMain.handle('browser:get-url', () => browserView.webContents.getURL());
ipcMain.handle('browser:get-title', () => browserView.webContents.getTitle());

// ─── IPC: API Key ─────────────────────────────────────────────────────────────

ipcMain.on('set-api-key', (_, key) => {
  apiKey = key;
  openaiClient = new OpenAI({ apiKey: key });
});
ipcMain.handle('get-api-key', () => apiKey ? '••••••••' + apiKey.slice(-4) : '');

// ─── IPC: User answers agent questions ───────────────────────────────────────

ipcMain.on('agent:user-answer', (_, { id, answer }) => {
  const resolve = pendingUserQuestions.get(id);
  if (resolve) {
    pendingUserQuestions.delete(id);
    resolve(answer);
  }
});

// ─── IPC: Stop agent ──────────────────────────────────────────────────────────

ipcMain.on('agent:stop', () => {
  if (agentAbortController) {
    agentAbortController.abort();
    agentAbortController = null;
  }
  // Resolve any pending user questions so the loop unblocks
  for (const [id, resolve] of pendingUserQuestions.entries()) {
    resolve('__STOPPED__');
    pendingUserQuestions.delete(id);
  }
});

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate the browser to a URL or perform a Google search. Use full URLs for known sites.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL (https://...) or search query' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_dom_snapshot',
      description: 'Get a full snapshot of the current page: URL, title, visible text, and ALL interactive elements (buttons, inputs, links, etc.) with their CSS selectors. Use this before clicking or filling anything to find the right selectors.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click an element by CSS selector. Always call get_dom_snapshot first to get the correct selector.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of element to click' },
          description: { type: 'string', description: 'Human-readable description of what you are clicking' },
        },
        required: ['selector', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: 'Focus an input and type text into it (simulates real keystrokes, works with React/Vue controlled inputs). If the selector points to a custom widget (div/span), it will automatically click the widget first to reveal the underlying input, then type. Use this for search boxes, autocomplete fields, OTP fields, and dynamic inputs. Do NOT use for date pickers — those require calendar interaction.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the input/textarea' },
          text: { type: 'string', description: 'Text to type' },
          clear_first: { type: 'boolean', description: 'Whether to clear existing value first (default true)' },
        },
        required: ['selector', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fill',
      description: 'Set the value of an input field directly (faster than type_text, good for forms with plain HTML inputs).',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the input' },
          value: { type: 'string', description: 'Value to set' },
        },
        required: ['selector', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description: 'Press a keyboard key on the currently focused element (e.g. Enter, Tab, Escape, ArrowDown).',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name: Enter, Tab, Escape, ArrowDown, ArrowUp, Space, Backspace, etc.' },
          selector: { type: 'string', description: 'Optional: CSS selector to focus before pressing key' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_option',
      description: 'Select an option in a <select> dropdown element.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the <select>' },
          value: { type: 'string', description: 'Option value or visible text to select' },
        },
        required: ['selector', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Scroll the page or a specific element to reveal more content.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
          amount: { type: 'number', description: 'Pixels to scroll (ignored for top/bottom)' },
          selector: { type: 'string', description: 'Optional: scroll a specific element instead of the page' },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: 'Wait for the page to finish loading or for a number of milliseconds.',
      parameters: {
        type: 'object',
        properties: {
          ms: { type: 'number', description: 'Milliseconds to wait (max 5000)' },
          for_load: { type: 'boolean', description: 'If true, wait until page stops loading' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Take a screenshot and analyze it visually. Use this when DOM snapshot is not enough to understand the page state, or to verify an action worked.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why you are taking this screenshot' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Pause and ask the user for information you need to continue (e.g. login credentials, OTP, address, payment info, confirmation to proceed). ALWAYS use this before performing irreversible actions like placing orders or making payments.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Clear question to ask the user' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of choices to present as quick-reply buttons',
          },
          field_hints: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                key: { type: 'string' },
                sensitive: { type: 'boolean' },
              },
            },
            description: 'If collecting structured data (e.g. name + phone), list the fields here',
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'report_progress',
      description: 'Send a real-time status update to the user about what step of the task you are on. Use this frequently so the user knows what is happening.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Short status message (e.g. "Searching for chips on Blinkit...")' },
          step: { type: 'number', description: 'Current step number' },
          total_steps: { type: 'number', description: 'Estimated total steps' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hover',
      description: 'Hover over an element (triggers hover menus, tooltips, dropdowns).',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of element to hover' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'go_back',
      description: 'Navigate back to the previous page in browser history.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for_selector',
      description: 'Wait (poll) until a CSS selector appears in the DOM, or until a URL pattern matches. Use this after navigation or clicking to wait for dynamic content to load (e.g. search results, modals, overlays).',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to wait for' },
          url_contains: { type: 'string', description: 'Wait until the current URL contains this string' },
          timeout_ms: { type: 'number', description: 'Max time to wait in ms (default 8000)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dismiss_overlay',
      description: 'Automatically detect and dismiss common overlays: cookie banners, location prompts, login popups, notification prompts, age-gate modals. Tries multiple strategies. Use this when an overlay is blocking the page.',
      parameters: {
        type: 'object',
        properties: {
          hint: { type: 'string', description: 'Optional hint about what kind of overlay (e.g. "location", "cookie", "login")' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Search Google and return structured results (title, url, snippet) WITHOUT navigating the browser. Use this when you need to gather information from multiple sources quickly, or when you want to search without losing the current page. Returns up to 10 results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'go_forward',
      description: 'Navigate forward to the next page in browser history.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_console_logs',
      description: 'Retrieve the browser console logs from the current page. Useful for debugging JavaScript errors, understanding what a page is doing, or reading log output from web apps.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_aria_snapshot',
      description: 'Get an ARIA accessibility tree snapshot of the current page as structured YAML. This is a semantic, role-based view of the page (headings, buttons, links, inputs, landmarks) — lighter than a full DOM snapshot and excellent for understanding page structure, reading content, and locating interactive elements by their accessible name.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'drag',
      description: 'Drag an element from one position to another on the page. Useful for reordering lists, moving sliders, or any drag-and-drop interaction.',
      parameters: {
        type: 'object',
        properties: {
          source_selector: { type: 'string', description: 'CSS selector of the element to drag from' },
          target_selector: { type: 'string', description: 'CSS selector of the element to drag onto' },
        },
        required: ['source_selector', 'target_selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'learn_site_hint',
      description: 'Save a discovered selector pattern or navigation hint for the current site so it can be reused later in this session. Call this when you find a working selector or URL pattern on an unfamiliar site (e.g. the search input selector, how pagination works, how to dismiss a specific overlay). The hint is stored per domain and injected automatically into future prompts for the same site.',
      parameters: {
        type: 'object',
        properties: {
          hint: { type: 'string', description: 'Short, reusable hint describing the pattern (e.g. "search input: #q → press Enter → wait url contains /search?q=")' },
        },
        required: ['hint'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'probe_form',
      description: 'Analyze a form on the current page and return a structured description of every field: its label, element type (plain input, custom widget, date picker, select, autocomplete, etc.), current value, and the recommended interaction strategy. Use this on any unfamiliar site before filling in a multi-field form (search forms, booking forms, checkout, etc.) so you know the correct interaction pattern for each field without guessing.',
      parameters: {
        type: 'object',
        properties: {
          form_selector: { type: 'string', description: 'Optional CSS selector to scope the analysis to a specific form or container. If omitted, analyzes the most prominent form on the page.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_date',
      description: 'Select a date in a calendar-based date picker widget (Booking.com, MakeMyTrip, Airbnb, etc.). This handles the full interaction: opens the calendar if needed, navigates to the correct month, and clicks the date cell. Use this for any date field that is NOT a plain <input type="date"> — i.e., custom calendar popups, grid-based pickers, button-based date selectors. Provide the date in YYYY-MM-DD format.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Target date in YYYY-MM-DD format (e.g. "2026-03-15")' },
          trigger_selector: { type: 'string', description: 'CSS selector of the button/element that opens the calendar. If omitted, assumes the calendar is already open.' },
          calendar_container: { type: 'string', description: 'Optional CSS selector of the calendar container to scope the search (e.g. "[data-testid=searchbox-datepicker]").' },
        },
        required: ['date'],
      },
    },
  },
];

// ─── Tool executor ────────────────────────────────────────────────────────────

async function executeTool(name, args, sendEvent) {
  const wc = browserView.webContents;
  sendEvent('agent:tool-call', { name, args });

  try {
    switch (name) {

      case 'navigate': {
        const url = normalizeUrl(args.url);

        // Classify network errors to give the model actionable guidance
        function classifyNavError(errMsg) {
          const msg = (errMsg || '').toLowerCase();
          if (msg.includes('ssl') || msg.includes('cert') || msg.includes('handshake'))
            return { category: 'SSL_ERROR', advice: 'SSL/TLS handshake failed. The site may block Electron or have certificate issues. SKIP this site and move to the next one.' };
          if (msg.includes('err_connection_reset') || msg.includes('net_error -101'))
            return { category: 'CONNECTION_RESET', advice: 'Connection was reset by the server. The site may be unreachable. SKIP this site and move to the next one.' };
          if (msg.includes('err_connection_refused') || msg.includes('err_connection_timed_out'))
            return { category: 'CONNECTION_FAILED', advice: 'Could not connect to the server. SKIP this site and try an alternative or move on.' };
          if (msg.includes('err_name_not_resolved') || msg.includes('dns'))
            return { category: 'DNS_ERROR', advice: 'Domain name could not be resolved. Check the URL spelling or SKIP this site.' };
          if (msg.includes('err_too_many_redirects'))
            return { category: 'REDIRECT_LOOP', advice: 'Too many redirects. The site may require cookies/auth. SKIP this site.' };
          if (msg.includes('err_aborted'))
            return { category: 'ABORTED', advice: 'Navigation was aborted (possibly by the site itself). Try once more or SKIP.' };
          if (msg.includes('timeout'))
            return { category: 'TIMEOUT', advice: 'Page load timed out. The site may be very slow. Try once more or SKIP.' };
          return { category: 'UNKNOWN', advice: 'Navigation failed. Try once more with a different URL or SKIP this site.' };
        }

        // Race loadURL against a hard timeout to prevent indefinite SSL hangs
        const NAV_TIMEOUT = 15000; // 15s hard cap per attempt
        let loadError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          loadError = null;
          try {
            await Promise.race([
              (async () => {
                await wc.loadURL(url);
                await waitForPageLoad(10000);
                await new Promise(r => setTimeout(r, 900)); // let SPA JS render
              })(),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Navigation timed out after ' + NAV_TIMEOUT + 'ms')), NAV_TIMEOUT)
              ),
            ]);
            break;
          } catch (e) {
            loadError = e.message;
            // On first attempt, only retry for potentially transient errors
            if (attempt === 0) {
              const { category } = classifyNavError(loadError);
              // Don't retry SSL/DNS errors — they won't resolve on retry
              if (category === 'SSL_ERROR' || category === 'DNS_ERROR') break;
              await new Promise(r => setTimeout(r, 1500));
            }
          }
        }
        if (loadError) {
          const { category, advice } = classifyNavError(loadError);
          return {
            success: false,
            error: loadError,
            errorCategory: category,
            advice,
            url,
          };
        }
        const finalUrl = wc.getURL();
        const finalTitle = wc.getTitle();
        return { success: true, url: finalUrl, title: finalTitle };
      }

      case 'get_dom_snapshot': {
        const snap = await getDOMSnapshot();
        return snap;
      }

      case 'click': {
        const urlBefore = wc.getURL();
        const result = await wc.executeJavaScript(`
          (function() {
            const sel = ${JSON.stringify(args.selector)};
            const desc = ${JSON.stringify(args.description || '')}.toLowerCase();
            let el = null;

            function isVis(e) {
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            }

            // 1. Direct selector
            if (sel) { try { el = document.querySelector(sel); } catch(e) {} }

            // 2. Text-based fallback across all interactive elements (including radio/checkbox/input)
            if (!el && desc) {
              const candidates = document.querySelectorAll(
                'a,button,[role="button"],[role="link"],[role="tab"],[role="menuitem"],' +
                'label,div[onclick],span[onclick],' +
                'input[type="radio"],input[type="checkbox"],input[type="submit"],input[type="button"]'
              );
              for (const e of candidates) {
                const t = (e.innerText || e.getAttribute('aria-label') || e.getAttribute('title') || e.value || '').toLowerCase().trim();
                if (t && t.includes(desc)) { el = e; break; }
              }
            }

            // 3. Label-for-input fallback — if selector looks like an input id, try its <label>
            if (!el && sel) {
              const idMatch = sel.match(/^#(.+)$/);
              if (idMatch) {
                const inputEl = document.getElementById(idMatch[1]);
                if (inputEl) {
                  el = inputEl;
                } else {
                  // Try label[for="id"]
                  const lbl = document.querySelector('label[for="' + CSS.escape(idMatch[1]) + '"]');
                  if (lbl && isVis(lbl)) el = lbl;
                }
              }
            }

            // 4. Partial selector fallback (e.g. 'input[type="radio"]' -> 'input')
            if (!el && sel) {
              try {
                // Extract tag: strip leading # or . then split on attribute/class/pseudo selectors
                const cleaned = sel.replace(/^[#.]/, '');
                const tag = cleaned.split(/[\[\.#:\s]/)[0];
                if (tag) {
                  const candidates = document.querySelectorAll(tag);
                  el = Array.from(candidates).find(e => isVis(e));
                }
              } catch(e) {}
            }

            if (!el) return { success: false, error: 'Element not found: ' + sel + ' / ' + desc };

            el.scrollIntoView({ behavior: 'instant', block: 'center' });

            // For radio/checkbox inputs, clicking the associated label is more reliable
            const isCheckable = el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox');
            if (isCheckable) {
              // Try clicking via label first — it toggles the input AND fires React onChange
              const labelEl = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
              if (labelEl) {
                labelEl.scrollIntoView({ behavior: 'instant', block: 'center' });
                labelEl.click();
              } else {
                // Direct click on the input
                el.click();
              }
              return {
                success: true,
                text: (el.getAttribute('aria-label') || el.name || el.value || el.id || el.tagName).trim().substring(0, 80),
                tag: el.tagName,
                checked: el.checked,
                href: null,
              };
            }

            el.focus();

            // Dispatch full mouse event sequence for SPAs
            ['mousedown','mouseup','click'].forEach(type => {
              el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });

            return {
              success: true,
              text: (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).trim().substring(0, 80),
              tag: el.tagName,
              href: el.href || null,
            };
          })()
        `);

        if (!result.success) return result;

        // Wait for any navigation or SPA route change
        await new Promise(r => setTimeout(r, 700));
        if (wc.isLoading()) await waitForPageLoad(10000);
        await new Promise(r => setTimeout(r, 600));

        // Report whether URL changed (useful for agent context)
        const urlAfter = wc.getURL();
        return { ...result, urlChanged: urlAfter !== urlBefore, currentUrl: urlAfter };
      }

      case 'type_text': {
        const clearFirst = args.clear_first !== false;
        const text = args.text || '';
        const selector = args.selector || '';

        // Strategy 1: find by selector
        // Strategy 2: use document.activeElement if it's an input
        // Strategy 3: find first visible text/search input on page
        // Strategy 4: contenteditable
        let focusResult;
        try {
          focusResult = await wc.executeJavaScript(`
            (function() {
              function tryFocus(el) {
                if (!el) return false;
                try {
                  el.scrollIntoView({ behavior: 'instant', block: 'center' });
                  el.focus();
                  if (${clearFirst}) {
                    if (el.isContentEditable) {
                      el.innerHTML = '';
                    } else {
                      // Detect date/color/range inputs — don't clear via setter (crashes React-Datepicker etc.)
                      const elType = (el.getAttribute('type') || '').toLowerCase();
                      const isSpecialInput = ['date','datetime-local','time','month','week','color','range','file'].includes(elType);
                      if (!isSpecialInput) {
                        try {
                          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
                                         Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                          if (setter) setter.call(el, ''); else el.value = '';
                          el.dispatchEvent(new Event('input', { bubbles: true }));
                        } catch (_) { /* swallow — some custom inputs throw */ }
                      }
                    }
                  }
                  return true;
                } catch(e) { return false; }
              }

              const sel = ${JSON.stringify(selector)};
              let el = null;

              // 1. Exact selector
              if (sel) { try { el = document.querySelector(sel); } catch(e) {} }

              // If the element is a custom widget (not a real input), click to open it first
              if (el) {
                const tag = el.tagName.toUpperCase();
                const isRealInput = tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
                const role = (el.getAttribute('role') || '').toLowerCase();
                const isInputRole = role === 'textbox' || role === 'searchbox' || role === 'combobox';
                if (!isRealInput && !isInputRole) {
                  el.scrollIntoView({ behavior: 'instant', block: 'center' });
                  el.click();
                  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                  return { success: false, retry: true, reason: 'custom-widget-clicked', widgetTag: tag };
                }
              }

              if (el && tryFocus(el)) {
                const elType = (el.getAttribute('type') || '').toLowerCase();
                return { success: true, strategy: 'selector', tag: el.tagName, inputType: elType };
              }

              // 2. Active element (user may have clicked a search bar)
              const active = document.activeElement;
              if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
                if (tryFocus(active)) return { success: true, strategy: 'activeElement', tag: active.tagName };
              }

              // 3. Visible search/text input (also check textarea)
              const inputs = Array.from(document.querySelectorAll(
                'input[type="search"], input[type="text"], input:not([type]), textarea, [role="searchbox"], [role="textbox"], [role="combobox"]'
              )).filter(e => {
                const r = e.getBoundingClientRect();
                return r.width > 20 && r.height > 10 && r.top >= 0 && r.top < window.innerHeight;
              });
              if (inputs.length > 0 && tryFocus(inputs[0]))
                return { success: true, strategy: 'firstVisible', tag: inputs[0].tagName, selector: inputs[0].id ? '#'+inputs[0].id : inputs[0].className.split(' ')[0] };

              // 4. contenteditable
              const ce = Array.from(document.querySelectorAll('[contenteditable="true"]'))
                .find(e => { const r = e.getBoundingClientRect(); return r.width > 20 && r.top >= 0; });
              if (ce && tryFocus(ce)) return { success: true, strategy: 'contenteditable' };

              return { success: false, error: 'No focusable input found for selector: ' + sel };
            })()
          `);
        } catch (e) {
          return { success: false, error: 'Focus script failed: ' + e.message.substring(0, 100) };
        }

        if (!focusResult.success) {
          // If a custom widget was clicked, wait for SPA re-render then retry focus discovery
          if (focusResult.retry) {
            await new Promise(r => setTimeout(r, 700));
            const retryFocus = await wc.executeJavaScript(`
              (function() {
                // Try activeElement first (widget may have focused a real input)
                const active = document.activeElement;
                if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
                  active.scrollIntoView({ behavior: 'instant', block: 'center' });
                  active.focus();
                  return { success: true, strategy: 'widget-revealed-active', tag: active.tagName };
                }
                // Scan for newly visible inputs
                const inp = Array.from(document.querySelectorAll(
                  'input[type="search"],input[type="text"],input:not([type]),textarea,[role="searchbox"],[role="textbox"],[role="combobox"]'
                )).find(e => { const r = e.getBoundingClientRect(); return r.width > 10 && r.height > 5 && r.top >= 0 && r.top < window.innerHeight; });
                if (inp) {
                  inp.scrollIntoView({ behavior: 'instant', block: 'center' });
                  inp.focus();
                  return { success: true, strategy: 'widget-revealed-scan', tag: inp.tagName };
                }
                return { success: false, error: 'No input revealed after widget click' };
              })()
            `);
            if (!retryFocus.success) return retryFocus;
            // Continue with keystrokes using the newly focused element
          } else {
            // Strategy 5: click the nearest search form/wrapper to open/reveal input, then retry
            const clickedWrapper = await wc.executeJavaScript(`
              (function() {
                const wrappers = Array.from(document.querySelectorAll(
                  '[role="search"], form, [class*="search" i], [class*="SearchBar" i], [id*="search" i], [aria-label*="search" i]'
                )).filter(e => {
                  const r = e.getBoundingClientRect();
                  return r.width > 20 && r.height > 5 && r.top >= 0 && r.top < window.innerHeight;
                });
                if (wrappers.length > 0) {
                  wrappers[0].click();
                  return true;
                }
                return false;
              })()
            `);

            if (clickedWrapper) {
              await new Promise(r => setTimeout(r, 600));
              // Retry finding a focused input
              const active = await wc.executeJavaScript(`
                (function() {
                  const el = document.activeElement;
                  if (!el) return null;
                  const tag = el.tagName;
                  if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return { tag };
                  // also scan for any newly visible input
                  const inp = Array.from(document.querySelectorAll(
                    'input[type="search"],input[type="text"],input:not([type]),textarea,[role="searchbox"]'
                  )).find(e => { const r = e.getBoundingClientRect(); return r.width > 10 && r.top >= 0 && r.top < window.innerHeight; });
                  if (inp) { inp.focus(); return { tag: inp.tagName }; }
                  return null;
                })()
              `);
              if (!active) return { success: false, error: 'No input found even after clicking search wrapper' };
            } else {
              return focusResult; // original error
            }
          }
        }

        // Detect if focused element is a datepicker or other special widget that
        // should use native setter instead of keystrokes (keystrokes open popups/calendars)
        let useSetterOnly = false;
        try {
          useSetterOnly = await wc.executeJavaScript(`
            (function() {
              const el = document.activeElement;
              if (!el) return false;
              // Check for common datepicker indicators
              const cls = (el.className || '').toLowerCase();
              const id = (el.id || '').toLowerCase();
              const parentCls = (el.parentElement?.className || '').toLowerCase();
              const hasDatepickerClass = cls.includes('datepicker') || cls.includes('date-picker') ||
                cls.includes('react-datepicker') || parentCls.includes('datepicker') ||
                parentCls.includes('react-datepicker') || id.includes('date');
              // Check if a React-Datepicker popper exists or would open
              const hasReactDP = !!document.querySelector('.react-datepicker-wrapper') ||
                !!document.querySelector('.react-datepicker');
              // Check for aria/role hints
              const hasDateRole = el.getAttribute('aria-haspopup') === 'true' ||
                el.getAttribute('autocomplete') === 'off';
              // Native date-like input types
              const t = (el.getAttribute('type') || '').toLowerCase();
              const isNativeDate = ['date','datetime-local','time','month','week'].includes(t);
              return isNativeDate || (hasDatepickerClass && (hasReactDP || hasDateRole));
            })()
          `);
        } catch (_) {}

        if (useSetterOnly) {
          // For datepickers: use native setter directly, skip keystrokes entirely
          // This avoids opening calendar popups and other side effects
          try {
            await wc.executeJavaScript(`
              (function() {
                const el = document.activeElement;
                if (!el) return;
                try {
                  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
                                 Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                  if (setter) setter.call(el, ${JSON.stringify(text)});
                  else el.value = ${JSON.stringify(text)};
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                } catch(_) {}
                // Close any datepicker popup that may have opened on focus
                el.blur();
                // Re-dispatch change after blur to ensure React picks it up
                el.dispatchEvent(new Event('change', { bubbles: true }));
              })()
            `);
          } catch (_) {}
          // Press Escape to dismiss any remaining popup
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
          await new Promise(r => setTimeout(r, 300));
          return { success: true, typed: text, strategy: 'datepicker-setter' };
        }

        // Send actual keystrokes for React/Vue reactivity
        for (const char of text) {
          wc.sendInputEvent({ type: 'keyDown', keyCode: char });
          wc.sendInputEvent({ type: 'char', keyCode: char });
          wc.sendInputEvent({ type: 'keyUp', keyCode: char });
          await new Promise(r => setTimeout(r, 30));
        }

        // Also set value via native setter to guarantee React state update
        // - Skip for special inputs (date/color/range/file) where setter causes crashes
        // - When clear_first is false, append to existing value instead of overwriting
        try {
          await wc.executeJavaScript(`
            (function() {
              const el = document.activeElement;
              if (!el) return;
              if (el.isContentEditable) {
                el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)} }));
                return;
              }
              // Skip special input types that crash when value is set via native setter
              const elType = (el.getAttribute('type') || '').toLowerCase();
              const skip = ['date','datetime-local','time','month','week','color','range','file'].includes(elType);
              if (skip) return;
              try {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
                               Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                const clearFirst = ${clearFirst};
                const newValue = clearFirst ? ${JSON.stringify(text)} : (el.value || '') + ${JSON.stringify(text)};
                if (setter) setter.call(el, newValue);
                else el.value = newValue;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              } catch(_) { /* swallow setter errors on exotic inputs */ }
            })()
          `);
        } catch (_) { /* executeJavaScript itself can fail if page crashed */ }

        await new Promise(r => setTimeout(r, 200));
        return { success: true, typed: text, strategy: focusResult?.strategy || 'wrapper-click' };
      }

      case 'fill': {
        const result = await wc.executeJavaScript(`
          (function() {
            let el = null;
            try { el = document.querySelector(${JSON.stringify(args.selector)}); } catch(e) {}
            if (!el) return { success: false, error: 'Element not found: ' + ${JSON.stringify(args.selector)} };
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
            el.focus();
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
              Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
            if (nativeInputValueSetter && nativeInputValueSetter.set) {
              nativeInputValueSetter.set.call(el, ${JSON.stringify(args.value)});
            } else {
              el.value = ${JSON.stringify(args.value)};
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { success: true };
          })()
        `);
        return result;
      }

      case 'press_key': {
        if (args.selector) {
          await wc.executeJavaScript(`
            (function() {
              const el = document.querySelector(${JSON.stringify(args.selector)});
              if (el) { el.scrollIntoView({ behavior: 'instant', block: 'center' }); el.focus(); }
            })()
          `);
        }
        const keyMap = {
          'Enter': 'Return', 'return': 'Return', 'enter': 'Return',
          'Tab': 'Tab', 'tab': 'Tab',
          'Escape': 'Escape', 'escape': 'Escape', 'Esc': 'Escape',
          'ArrowDown': 'Down', 'ArrowUp': 'Up', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
          'Space': ' ', 'Backspace': 'BackSpace',
        };
        const key = keyMap[args.key] || args.key;

        // For Enter: also dispatch DOM KeyboardEvent on active element and try form.submit()
        // This is needed because sendInputEvent only fires at the OS/Chromium level;
        // if JS .focus() was used (not native click), Chromium's native focus may differ.
        if (key === 'Return') {
          await wc.executeJavaScript(`
            (function() {
              const el = document.activeElement;
              if (!el) return;
              // Dispatch keydown/keypress/keyup on the element
              ['keydown','keypress','keyup'].forEach(type => {
                el.dispatchEvent(new KeyboardEvent(type, {
                  key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                  bubbles: true, cancelable: true
                }));
              });
              // If inside a form, submit it
              const form = el.closest('form');
              if (form) {
                // Try clicking the submit button first (most reliable for React forms)
                const submitBtn = form.querySelector('[type="submit"], button:not([type="button"])');
                if (submitBtn) { submitBtn.click(); return; }
                // Otherwise dispatch a submit event (don't call form.submit() directly — it
                // bypasses event handlers and can cause synchronous navigation to blank pages)
                const submitted = form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                // Only use form.submit() as last resort, wrapped in try/catch
                if (submitted) {
                  try { form.submit(); } catch(_) {}
                }
              }
            })()
          `);
        }

        wc.sendInputEvent({ type: 'keyDown', keyCode: key });
        wc.sendInputEvent({ type: 'keyUp', keyCode: key });
        await new Promise(r => setTimeout(r, 600));
        if (wc.isLoading()) await waitForPageLoad(10000);
        return { success: true, key };
      }

      case 'select_option': {
        const result = await wc.executeJavaScript(`
          (function() {
            const el = document.querySelector(${JSON.stringify(args.selector)});
            if (!el || el.tagName !== 'SELECT') return { success: false, error: 'Select element not found' };
            const val = ${JSON.stringify(args.value)};
            // Try by value first, then by text
            let found = false;
            for (const opt of el.options) {
              if (opt.value === val || opt.text === val || opt.text.toLowerCase().includes(val.toLowerCase())) {
                el.value = opt.value;
                found = true;
                break;
              }
            }
            if (!found) return { success: false, error: 'Option not found: ' + val };
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { success: true };
          })()
        `);
        return result;
      }

      case 'scroll': {
        await wc.executeJavaScript(`
          (function() {
            const target = ${args.selector ? `document.querySelector(${JSON.stringify(args.selector)})` : 'window'};
            if (!target) return;
            const dir = ${JSON.stringify(args.direction)};
            if (dir === 'top') { window.scrollTo(0,0); return; }
            if (dir === 'bottom') { window.scrollTo(0, document.documentElement.scrollHeight); return; }
            const amt = ${args.amount || 500};
            if (target === window) {
              window.scrollBy(0, dir === 'up' ? -amt : amt);
            } else {
              target.scrollBy(0, dir === 'up' ? -amt : amt);
            }
          })()
        `);
        await new Promise(r => setTimeout(r, 300));
        return { success: true };
      }

      case 'wait': {
        if (args.for_load) {
          await waitForPageLoad(10000);
        } else {
          await new Promise(r => setTimeout(r, Math.min(args.ms || 1000, 5000)));
        }
        return { success: true, url: wc.getURL() };
      }

      case 'screenshot': {
        const image = await wc.capturePage();
        const dataUrl = image.toDataURL();
        sendEvent('agent:screenshot', { dataUrl });
        // Return just metadata (not the full base64 back to GPT — too large)
        return {
          success: true,
          dimensions: image.getSize(),
          url: wc.getURL(),
          title: wc.getTitle(),
          note: args.reason || 'Screenshot taken',
        };
      }

      case 'ask_user': {
        const answer = await askUser(args.question, args.options || null);
        return { success: true, answer };
      }

      case 'report_progress': {
        sendEvent('agent:progress', {
          message: args.message,
          step: args.step,
          total: args.total_steps,
        });
        return { success: true };
      }

      case 'hover': {
        await wc.executeJavaScript(`
          (function() {
            const el = document.querySelector(${JSON.stringify(args.selector)});
            if (!el) return;
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          })()
        `);
        await new Promise(r => setTimeout(r, 400));
        return { success: true };
      }

      case 'go_back': {
        goBack(wc);
        await waitForPageLoad(6000);
        await new Promise(r => setTimeout(r, 500));
        return { success: true, url: wc.getURL() };
      }

      case 'wait_for_selector': {
        const timeout = args.timeout_ms || 8000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
          if (args.url_contains && wc.getURL().includes(args.url_contains)) {
            // Wait for page to finish loading before returning
            if (wc.isLoading()) await waitForPageLoad(8000);
            await new Promise(r => setTimeout(r, 500));
            return { success: true, matched: 'url', url: wc.getURL() };
          }
          if (args.selector) {
            const found = await wc.executeJavaScript(`
              (function() {
                try {
                  const el = document.querySelector(${JSON.stringify(args.selector)});
                  if (!el) return false;
                  const r = el.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                } catch(e) { return false; }
              })()
            `);
            if (found) return { success: true, matched: 'selector', selector: args.selector };
          }
          await new Promise(r => setTimeout(r, 300));
        }
        // On timeout: include a diagnostic snapshot so the agent can adapt instead of blindly retrying
        let diagnostic = null;
        try {
          const snap = await getDOMSnapshot();
          diagnostic = {
            url: snap.url,
            title: snap.title,
            pageTextPreview: (snap.pageText || '').substring(0, 800),
            visibleButtonsAndLinks: (snap.interactive || [])
              .filter(e => e.tag === 'BUTTON' || e.tag === 'A' || e.type === 'submit')
              .slice(0, 20)
              .map(e => ({ tag: e.tag, text: e.text, selector: e.selector })),
          };
        } catch (_) {}
        return {
          success: false,
          error: `Timed out waiting for: ${args.selector || args.url_contains}`,
          diagnostic,
          hint: 'The selector or URL was not found within the timeout. Use the diagnostic snapshot to understand the current page state and adapt your approach — do not retry the same selector blindly.',
        };
      }

      case 'dismiss_overlay': {
        const hint = (args.hint || '').toLowerCase();
        const dismissed = await wc.executeJavaScript(`
          (function() {
            const dismissed = [];

            // Common dismiss button text patterns
            const dismissTexts = [
              'allow','accept','got it','ok','okay','close','dismiss','skip','no thanks',
              'continue','agree','i agree','accept all','allow all','enable location',
              'use my location','detect location','set location','not now','maybe later',
              'decline','deny','reject','cancel'
            ];

            // Specific hint patterns
            const hint = ${JSON.stringify(hint)};
            const prioritize = hint === 'location'
              ? ['allow','use my location','enable location','detect location','set location']
              : hint === 'cookie'
              ? ['accept','accept all','i agree','agree','got it']
              : hint === 'login'
              ? ['close','skip','not now','maybe later','continue as guest','x']
              : dismissTexts;

            // For login hint: try close/X icon buttons by selector first
            if (hint === 'login') {
              const closeSelectors = [
                '[data-testid="cross"]', '[data-testid="close"]',
                '.modalClose', '.modal-close', '.close-modal',
                '[class*="modalClose"]', '[class*="closeModal"]',
                '[class*="loginClose"]', '[class*="close-btn"]',
                '[aria-label="close"]', '[aria-label="Close"]',
                '[class*="popup"] [class*="close"]',
                '[class*="modal"] [class*="close"]',
                '[class*="overlay"] [class*="close"]',
              ];
              for (const sel of closeSelectors) {
                try {
                  const btn = document.querySelector(sel);
                  if (btn) {
                    const r = btn.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) {
                      btn.click();
                      dismissed.push({ text: sel, tag: btn.tagName });
                      break;
                    }
                  }
                } catch(_) {}
              }
            }

            if (dismissed.length > 0) return { success: true, dismissed };

            // Try buttons/links with matching text
            const allBtns = Array.from(document.querySelectorAll(
              'button, [role="button"], a, [role="link"], [role="dialog"] *, [class*="modal"] *, [class*="popup"] *, [class*="overlay"] *, [class*="banner"] *'
            )).filter(e => {
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < window.innerHeight;
            });

            for (const pattern of prioritize) {
              for (const btn of allBtns) {
                const t = (btn.innerText || btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase().trim();
                if (t === pattern || t.startsWith(pattern)) {
                  btn.click();
                  dismissed.push({ text: t, tag: btn.tagName });
                  break;
                }
              }
              if (dismissed.length > 0) break;
            }

            // Fallback: press Escape
            if (dismissed.length === 0) {
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
              dismissed.push({ text: 'Escape key', tag: 'document' });
            }

            return { success: true, dismissed };
          })()
        `);
        await new Promise(r => setTimeout(r, 500));
        return dismissed;
      }

      case 'search_web': {
        const query = encodeURIComponent(args.query || '');
        const searchUrl = `https://www.google.com/search?q=${query}&hl=en&num=10`;

        try {
          await wc.loadURL(searchUrl);
          await waitForPageLoad(10000);
          await new Promise(r => setTimeout(r, 600));

          const results = await wc.executeJavaScript(`
            (function() {
              const items = [];
              const seen = new Set();

              function add(title, url, snippet) {
                if (!url || seen.has(url)) return;
                // Skip Google-internal / ad URLs
                if (url.includes('google.com/search') || url.startsWith('https://webcache')) return;
                seen.add(url);
                items.push({ title: title.trim(), url, snippet: (snippet || '').trim().substring(0, 200) });
              }

              // Standard organic results
              document.querySelectorAll('div.g, div[data-sokoban-container], .tF2Cxc').forEach(el => {
                const a = el.querySelector('a[href]');
                const h3 = el.querySelector('h3');
                const snippet = el.querySelector('.VwiC3b, .yXK7lf, [data-sncf]');
                if (a && h3) add(h3.innerText, a.href, snippet ? snippet.innerText : '');
              });

              // Video carousel / YouTube cards (g-scrolling-carousel, video-result)
              document.querySelectorAll('a[href*="youtube.com/watch"]').forEach(a => {
                const title = a.querySelector('div[role="heading"], h3, [aria-label]')?.innerText ||
                              a.getAttribute('aria-label') || a.innerText || 'YouTube video';
                add(title, a.href, 'YouTube video');
              });

              // Knowledge panel / top stories that contain youtube links
              document.querySelectorAll('a[href]').forEach(a => {
                if (a.href.includes('youtube.com/watch') && !seen.has(a.href)) {
                  const title = a.innerText.trim() || a.getAttribute('aria-label') || 'YouTube video';
                  add(title, a.href, 'YouTube video');
                }
              });

              return items.slice(0, 12);
            })()
          `);

          return { success: true, query: args.query, results, note: 'These are snippets only. To read full content, navigate to each URL individually.' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      case 'go_forward': {
        goForward(wc);
        await waitForPageLoad(6000);
        await new Promise(r => setTimeout(r, 500));
        return { success: true, url: wc.getURL() };
      }

      case 'get_console_logs': {
        // Collect logs captured via JS-injected listener and any stored since page load
        const logs = await wc.executeJavaScript(`
          (function() {
            // Return any buffered logs we have stored on the window object
            return window.__nanobrowse_console_logs || [];
          })()
        `);
        if (logs.length === 0) {
          return { success: true, logs: [], note: 'No console logs captured. Logs are only buffered after the page has loaded with the listener active. Try refreshing or navigating first.' };
        }
        return { success: true, logs };
      }

      case 'get_aria_snapshot': {
        // Build an ARIA accessibility tree snapshot from the live page
        const snapshot = await wc.executeJavaScript(`
          (function() {
            function buildAriaTree(el, depth) {
              if (depth > 8) return null;
              const role = el.getAttribute('role') || el.tagName.toLowerCase();
              const name = (
                el.getAttribute('aria-label') ||
                el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.innerText ||
                el.getAttribute('title') ||
                el.getAttribute('placeholder') ||
                (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : null) ||
                (el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName === 'LABEL' ? el.innerText?.trim().replace(/\\s+/g,' ').substring(0,80) : null) ||
                (el.tagName === 'IMG' ? el.alt : null) ||
                null
              );
              const r = el.getBoundingClientRect();
              if (r.width === 0 && r.height === 0 && el.tagName !== 'BODY' && el.tagName !== 'MAIN') return null;

              const children = [];
              for (const child of el.children) {
                const c = buildAriaTree(child, depth + 1);
                if (c) children.push(c);
              }

              // Only include nodes with a meaningful role/name or with meaningful children
              const meaningfulRoles = new Set([
                'a','button','input','textarea','select','form','h1','h2','h3','h4','h5','h6',
                'nav','main','header','footer','aside','section','article','dialog','img',
                'list','listitem','table','tr','td','th','ul','ol','li',
                'banner','navigation','main','complementary','contentinfo','search','region',
                'tab','tablist','tabpanel','menuitem','menu','menubar','toolbar','tree','treeitem',
                'checkbox','radio','combobox','slider','spinbutton','textbox','searchbox',
                'link','heading','landmark'
              ]);

              if (!meaningfulRoles.has(role) && !name && children.length === 0) return null;

              return { role, name: name || undefined, children: children.length > 0 ? children : undefined };
            }

            function toYaml(node, indent) {
              if (!node) return '';
              let line = indent + '- ' + node.role;
              if (node.name) line += ' "' + node.name.replace(/"/g, '\\"') + '"';
              let result = line + '\\n';
              if (node.children) {
                for (const child of node.children) {
                  result += toYaml(child, indent + '  ');
                }
              }
              return result;
            }

            try {
              const tree = buildAriaTree(document.body, 0);
              return {
                url: window.location.href,
                title: document.title,
                yaml: tree ? toYaml(tree, '') : '(empty page)',
              };
            } catch(e) {
              return { url: window.location.href, title: document.title, yaml: '', error: e.message };
            }
          })()
        `);
        return {
          success: true,
          url: snapshot.url,
          title: snapshot.title,
          aria_snapshot: snapshot.yaml,
          error: snapshot.error || undefined,
        };
      }

      case 'drag': {
        const result = await wc.executeJavaScript(`
          (function() {
            const src = document.querySelector(${JSON.stringify(args.source_selector)});
            const tgt = document.querySelector(${JSON.stringify(args.target_selector)});
            if (!src) return { success: false, error: 'Source element not found: ' + ${JSON.stringify(args.source_selector)} };
            if (!tgt) return { success: false, error: 'Target element not found: ' + ${JSON.stringify(args.target_selector)} };

            src.scrollIntoView({ behavior: 'instant', block: 'center' });

            const srcRect = src.getBoundingClientRect();
            const tgtRect = tgt.getBoundingClientRect();

            const startX = srcRect.left + srcRect.width / 2;
            const startY = srcRect.top + srcRect.height / 2;
            const endX = tgtRect.left + tgtRect.width / 2;
            const endY = tgtRect.top + tgtRect.height / 2;

            function fireMouseEvent(el, type, clientX, clientY) {
              el.dispatchEvent(new MouseEvent(type, {
                bubbles: true, cancelable: true, view: window,
                clientX, clientY,
                dataTransfer: null,
              }));
            }
            function fireDragEvent(el, type, clientX, clientY) {
              el.dispatchEvent(new DragEvent(type, {
                bubbles: true, cancelable: true, view: window,
                clientX, clientY,
              }));
            }

            // Full drag event sequence
            fireDragEvent(src, 'dragstart', startX, startY);
            fireMouseEvent(src, 'mousedown', startX, startY);

            // Intermediate steps
            const steps = 5;
            for (let i = 1; i <= steps; i++) {
              const mx = startX + (endX - startX) * (i / steps);
              const my = startY + (endY - startY) * (i / steps);
              fireDragEvent(document.elementFromPoint(mx, my) || tgt, 'dragover', mx, my);
              fireMouseEvent(document.elementFromPoint(mx, my) || tgt, 'mousemove', mx, my);
            }

            fireDragEvent(tgt, 'dragenter', endX, endY);
            fireDragEvent(tgt, 'dragover', endX, endY);
            fireDragEvent(tgt, 'drop', endX, endY);
            fireDragEvent(src, 'dragend', endX, endY);
            fireMouseEvent(tgt, 'mouseup', endX, endY);

            return { success: true, from: ${JSON.stringify(args.source_selector)}, to: ${JSON.stringify(args.target_selector)} };
          })()
        `);
        await new Promise(r => setTimeout(r, 400));
        return result;
      }

      case 'learn_site_hint': {
        const currentUrl = wc.getURL();
        learnSiteHint(currentUrl, args.hint);
        const domain = getDomain(currentUrl);
        return { success: true, domain, hint: args.hint };
      }

      case 'probe_form': {
        const fields = await wc.executeJavaScript(`
          (function() {
            const scopeSel = ${JSON.stringify(args.form_selector || '')};
            let root = null;
            if (scopeSel) {
              try { root = document.querySelector(scopeSel); } catch(_) {}
            }
            // If no explicit scope, find the most prominent form or the main content area
            if (!root) {
              root = document.querySelector('form') ||
                     document.querySelector('main') ||
                     document.querySelector('[role="main"]') ||
                     document.body;
            }

            const fields = [];
            const seen = new Set();

            // Gather all interactive leaf elements within root
            const els = root.querySelectorAll(
              'input, textarea, select, [role="combobox"], [role="listbox"], ' +
              '[role="spinbutton"], [role="textbox"], [role="searchbox"], ' +
              '[contenteditable="true"], [class*="input"], [class*="field"], ' +
              '[class*="picker"], [class*="select"], [class*="dropdown"]'
            );

            for (const el of els) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              if (r.top < -100 || r.top > window.innerHeight + 100) continue;

              // Build a reliable selector
              let selector = '';
              if (el.id) selector = '#' + CSS.escape(el.id);
              else if (el.getAttribute('data-testid')) selector = '[data-testid="' + el.getAttribute('data-testid') + '"]';
              else if (el.name) selector = el.tagName.toLowerCase() + '[name="' + el.name + '"]';
              else if (el.getAttribute('placeholder')) selector = el.tagName.toLowerCase() + '[placeholder="' + el.getAttribute('placeholder').replace(/"/g, '\\"') + '"]';
              else if (el.getAttribute('aria-label')) selector = '[aria-label="' + el.getAttribute('aria-label').replace(/"/g, '\\"') + '"]';
              else {
                const classes = Array.from(el.classList).slice(0, 2).join('.');
                selector = el.tagName.toLowerCase() + (classes ? '.' + classes : '');
              }

              if (seen.has(selector)) continue;
              seen.add(selector);

              // Detect field type and recommend interaction strategy
              const tag = el.tagName.toLowerCase();
              const type = (el.getAttribute('type') || '').toLowerCase();
              const role = (el.getAttribute('role') || '').toLowerCase();
              const placeholder = el.getAttribute('placeholder') || '';
              const ariaLabel = el.getAttribute('aria-label') || '';
              const classStr = el.className || '';
              const currentValue = el.value || el.innerText || el.getAttribute('aria-valuenow') || '';

              // Find associated label text
              let labelText = '';
              if (el.id) {
                const lbl = document.querySelector('label[for="' + el.id + '"]');
                if (lbl) labelText = lbl.innerText.trim();
              }
              if (!labelText) {
                // Look for nearby label-like ancestor text
                let parent = el.parentElement;
                for (let i = 0; i < 4 && parent; i++) {
                  const parentText = (parent.innerText || '').trim().split('\\n')[0].substring(0, 60);
                  if (parentText && parentText.length < 60 && !parentText.includes('\\n')) {
                    labelText = parentText;
                    break;
                  }
                  parent = parent.parentElement;
                }
              }

              let fieldType = 'unknown';
              let strategy = '';

              if (tag === 'select') {
                fieldType = 'select';
                strategy = 'Use select_option({selector, value}) with the option value or text.';
              } else if (type === 'date' || type === 'datetime-local' || type === 'month') {
                fieldType = 'native-date-input';
                strategy = 'Use fill({selector, value:"YYYY-MM-DD"}) to set the date value directly.';
              } else if (
                classStr.match(/date|calendar|picker/i) ||
                role === 'spinbutton' ||
                el.getAttribute('readonly') === '' || el.getAttribute('readonly') === 'readonly'
              ) {
                fieldType = 'custom-date-picker';
                strategy = 'Use select_date({date:"YYYY-MM-DD", trigger_selector:"<selector>"}) to open the calendar and pick the date. Do NOT type into date pickers.';
              } else if (
                role === 'combobox' || role === 'listbox' || role === 'searchbox' ||
                classStr.match(/autocomplete|autosuggest|typeahead|combo/i) ||
                el.getAttribute('autocomplete') === 'off'
              ) {
                fieldType = 'autocomplete-widget';
                strategy = 'Click the widget first, then type_text to trigger suggestions, wait 800ms, then click the first suggestion from the dropdown list.';
              } else if (tag === 'input' && (type === 'text' || type === 'search' || type === '')) {
                fieldType = 'text-input';
                strategy = 'Use type_text({selector, text}) directly.';
              } else if (tag === 'textarea') {
                fieldType = 'textarea';
                strategy = 'Use type_text({selector, text}) directly.';
              } else if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
                fieldType = 'contenteditable';
                strategy = 'Click to focus, then type_text({selector, text}).';
              } else if (tag === 'div' || tag === 'span') {
                fieldType = 'custom-widget';
                strategy = 'Click to activate/open, then observe the resulting DOM change and interact with the revealed input.';
              }

              fields.push({
                selector,
                labelText: labelText.trim(),
                placeholder,
                ariaLabel,
                tag,
                type: type || tag,
                role,
                fieldType,
                currentValue: currentValue.substring(0, 100),
                strategy,
                rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
              });

              if (fields.length >= 30) break;
            }

            return fields;
          })()
        `);

        return {
          success: true,
          fieldCount: fields.length,
          fields,
          hint: 'Use the "strategy" field for each form field to determine the correct interaction approach. For custom-date-picker fields, never type — click and navigate the calendar. For autocomplete-widget fields, always click first then type and wait for suggestions.',
        };
      }

      case 'select_date': {
        const targetDate = args.date; // YYYY-MM-DD
        const triggerSelector = args.trigger_selector || '';
        const containerSelector = args.calendar_container || '';

        // Validate date format
        const dateMatch = targetDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!dateMatch) {
          return { success: false, error: 'Invalid date format. Use YYYY-MM-DD (e.g. "2026-03-15").' };
        }
        const targetYear = parseInt(dateMatch[1]);
        const targetMonth = parseInt(dateMatch[2]); // 1-based
        const targetDay = parseInt(dateMatch[3]);

        // Step 1: Click trigger to open calendar if provided
        if (triggerSelector) {
          try {
            await wc.executeJavaScript(`
              (function() {
                let el = null;
                try { el = document.querySelector(${JSON.stringify(triggerSelector)}); } catch(e) {}
                if (el) { el.scrollIntoView({ behavior: 'instant', block: 'center' }); el.click(); }
              })()
            `);
            await new Promise(r => setTimeout(r, 800)); // Wait for calendar to open
          } catch (_) {}
        }

        // Step 2: Try to find and click the date cell directly
        // Strategy A: data-date attribute (Booking.com, many modern pickers)
        // Strategy B: aria-label containing the date text
        // Strategy C: td/span with matching day number in the correct month grid
        const MAX_MONTH_NAV = 14; // Max month navigations to prevent infinite loops
        let found = false;
        let navCount = 0;

        while (!found && navCount <= MAX_MONTH_NAV) {
          // Try to find and click the target date cell
          const clickResult = await wc.executeJavaScript(`
            (function() {
              const targetDate = ${JSON.stringify(targetDate)};
              const targetDay = ${targetDay};
              const targetMonth = ${targetMonth};
              const targetYear = ${targetYear};
              const containerSel = ${JSON.stringify(containerSelector)};

              const scope = containerSel
                ? (document.querySelector(containerSel) || document)
                : document;

              // Strategy A: data-date attribute (exact match like "2026-03-15")
              let cell = scope.querySelector('[data-date="' + targetDate + '"]');
              if (cell) {
                cell.scrollIntoView({ behavior: 'instant', block: 'center' });
                cell.click();
                return { found: true, strategy: 'data-date', label: cell.getAttribute('aria-label') || cell.innerText };
              }

              // Strategy B: aria-label containing the full date (e.g. "Sa 7 March 2026")
              const monthNames = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
              const monthName = monthNames[targetMonth - 1];
              // Match patterns like "7 March 2026", "March 7, 2026", "7 Mar 2026", "Mar 7, 2026"
              const shortMonth = monthName.substring(0, 3);
              const labelPatterns = [
                targetDay + ' ' + monthName + ' ' + targetYear,
                targetDay + ' ' + shortMonth + ' ' + targetYear,
                monthName + ' ' + targetDay + ', ' + targetYear,
                monthName + ' ' + targetDay + ' ' + targetYear,
                shortMonth + ' ' + targetDay + ', ' + targetYear,
              ];

              const allButtons = scope.querySelectorAll('[role="button"], button, [role="gridcell"] *, td *');
              for (const btn of allButtons) {
                const label = (btn.getAttribute('aria-label') || '').trim();
                if (!label) continue;
                for (const pattern of labelPatterns) {
                  if (label.includes(pattern)) {
                    btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                    btn.click();
                    return { found: true, strategy: 'aria-label', label };
                  }
                }
              }

              // Strategy C: data-value attribute (some pickers use data-value="YYYY-MM-DD" or data-day="15")
              const dataValueCell = scope.querySelector('[data-value="' + targetDate + '"]') ||
                scope.querySelector('[data-day="' + targetDay + '"][data-month="' + (targetMonth - 1) + '"]') ||
                scope.querySelector('[data-day="' + targetDay + '"][data-month="' + targetMonth + '"]');
              if (dataValueCell) {
                dataValueCell.scrollIntoView({ behavior: 'instant', block: 'center' });
                dataValueCell.click();
                return { found: true, strategy: 'data-value', label: dataValueCell.innerText };
              }

              // Not found — detect current month displayed in calendar for navigation
              // Look for month/year heading text like "March 2026", "April 2026"
              const headings = scope.querySelectorAll('h1,h2,h3,h4,h5,h6,[class*="month"],[class*="header"],[class*="title"]');
              let currentMonth = null;
              let currentYear = null;
              for (const h of headings) {
                const text = (h.innerText || '').trim();
                for (let m = 0; m < 12; m++) {
                  if (text.includes(monthNames[m])) {
                    currentMonth = m + 1;
                    const yearMatch = text.match(/(20\\d{2})/);
                    if (yearMatch) currentYear = parseInt(yearMatch[1]);
                    break;
                  }
                }
                if (currentMonth) break;
              }

              return {
                found: false,
                currentMonth,
                currentYear,
                targetMonth,
                targetYear,
              };
            })()
          `);

          if (clickResult.found) {
            found = true;
            return {
              success: true,
              date: targetDate,
              strategy: clickResult.strategy,
              clickedLabel: clickResult.label,
            };
          }

          // Need to navigate months — determine direction
          if (navCount >= MAX_MONTH_NAV) break;

          const curMonth = clickResult.currentMonth;
          const curYear = clickResult.currentYear;

          if (!curMonth || !curYear) {
            // Can't detect current month — try clicking next as a guess
            const clicked = await wc.executeJavaScript(`
              (function() {
                const containerSel = ${JSON.stringify(containerSelector)};
                const scope = containerSel
                  ? (document.querySelector(containerSel) || document)
                  : document;

                // Look for next/prev month buttons
                const nextLabels = ['Next month','next','Next','Forward','>','chevron_right','→'];
                const buttons = scope.querySelectorAll('button, [role="button"]');
                for (const btn of buttons) {
                  const label = (btn.getAttribute('aria-label') || btn.innerText || '').trim();
                  for (const nl of nextLabels) {
                    if (label.toLowerCase().includes(nl.toLowerCase())) {
                      btn.click();
                      return { clicked: 'next', label };
                    }
                  }
                }
                return { clicked: null };
              })()
            `);
            if (!clicked.clicked) {
              return {
                success: false,
                error: 'Could not find date cell or month navigation buttons. Calendar may not be open or uses an unsupported format.',
                date: targetDate,
              };
            }
            await new Promise(r => setTimeout(r, 500));
            navCount++;
            continue;
          }

          // Calculate direction: forward or backward
          const curTotal = curYear * 12 + curMonth;
          const targetTotal = targetYear * 12 + targetMonth;

          if (curTotal === targetTotal) {
            // Right month but date cell not found — unusual
            return {
              success: false,
              error: 'Calendar shows the correct month (' + curMonth + '/' + curYear + ') but date cell for day ' + targetDay + ' was not found. The date may be disabled or unavailable.',
              date: targetDate,
            };
          }

          const direction = targetTotal > curTotal ? 'next' : 'prev';
          const dirLabels = direction === 'next'
            ? ['Next month','next','Next','Forward','>','chevron_right','→']
            : ['Previous month','previous','prev','Previous','Back','<','chevron_left','←'];

          const navResult = await wc.executeJavaScript(`
            (function() {
              const containerSel = ${JSON.stringify(containerSelector)};
              const scope = containerSel
                ? (document.querySelector(containerSel) || document)
                : document;

              const labels = ${JSON.stringify(dirLabels)};
              const buttons = scope.querySelectorAll('button, [role="button"]');
              for (const btn of buttons) {
                const label = (btn.getAttribute('aria-label') || btn.innerText || '').trim();
                for (const dl of labels) {
                  if (label.toLowerCase().includes(dl.toLowerCase())) {
                    btn.click();
                    return { clicked: true, label };
                  }
                }
              }
              return { clicked: false };
            })()
          `);

          if (!navResult.clicked) {
            return {
              success: false,
              error: 'Could not find "' + direction + '" month navigation button. Calendar uses unsupported navigation.',
              date: targetDate,
              currentMonth: curMonth,
              currentYear: curYear,
            };
          }

          await new Promise(r => setTimeout(r, 500));
          navCount++;
        }

        return {
          success: false,
          error: 'Could not find date ' + targetDate + ' after ' + navCount + ' month navigations. The date may be too far in the future/past or the calendar is not responding.',
          date: targetDate,
        };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Token-efficient compression utilities ───────────────────────────────────

// Compress DOM snapshot to only include task-relevant data
function compressSnapshot(snap, taskHint) {
  if (!snap || snap.error) return snap;

  const hint = (taskHint || '').toLowerCase();

  // Shorter page text — only first 4000 chars instead of 12000
  const pageText = (snap.pageText || '').substring(0, 4000);

  // Filter interactive elements to only the most relevant ones
  let interactive = snap.interactive || [];
  if (interactive.length > 40) {
    // Prioritize: inputs, buttons, links with text, elements matching hint
    const scored = interactive.map(el => {
      let score = 0;
      if (el.tag === 'input' || el.tag === 'textarea') score += 10;
      if (el.tag === 'button' || el.type === 'submit') score += 8;
      if (el.tag === 'a' && el.text) score += 5;
      if (el.tag === 'select') score += 7;
      if (hint && el.text && el.text.toLowerCase().includes(hint)) score += 15;
      if (hint && el.selector && el.selector.toLowerCase().includes(hint)) score += 12;
      if (el.disabled) score -= 5;
      return { ...el, _score: score };
    });
    scored.sort((a, b) => b._score - a._score);
    interactive = scored.slice(0, 50).map(({ _score, ...rest }) => rest);
  }

  // Strip rect data from elements (saves ~30% tokens on large snapshots)
  interactive = interactive.map(({ rect, ...rest }) => rest);

  return {
    url: snap.url,
    title: snap.title,
    pageText,
    interactive,
    inputFields: (snap.inputFields || []).slice(0, 8),
    scroll: snap.pageHeight > snap.viewportHeight
      ? `${snap.scrollY}/${snap.pageHeight}` : null,
  };
}

// Compress tool results to reduce token bloat
function compressToolResult(name, result) {
  if (!result) return result;

  switch (name) {
    case 'get_dom_snapshot':
      // Already handled by compressSnapshot
      return result;

    case 'get_aria_snapshot': {
      // Truncate YAML to 3000 chars
      const yaml = (result.aria_snapshot || '').substring(0, 3000);
      return { success: true, url: result.url, title: result.title, aria_snapshot: yaml };
    }

    case 'search_web': {
      // Trim snippets and limit results
      const results = (result.results || []).slice(0, 8).map(r => ({
        title: r.title,
        url: r.url,
        snippet: (r.snippet || '').substring(0, 120),
      }));
      return { success: true, query: result.query, results };
    }

    case 'click':
    case 'type_text':
    case 'fill':
    case 'press_key':
    case 'scroll':
    case 'hover':
    case 'wait':
    case 'select_date':
      // Minimal success/fail response
      return {
        success: result.success !== false,
        ...(result.error ? { error: result.error } : {}),
        ...(result.urlChanged ? { urlChanged: true, currentUrl: result.currentUrl } : {}),
        ...(result.typed ? { typed: result.typed } : {}),
        ...(result.date ? { date: result.date } : {}),
        ...(result.strategy ? { strategy: result.strategy } : {}),
        ...(result.clickedLabel ? { clickedLabel: result.clickedLabel } : {}),
      };

    case 'navigate':
      return {
        success: result.success !== false,
        url: result.url,
        ...(result.title ? { title: result.title } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.errorCategory ? { errorCategory: result.errorCategory } : {}),
        ...(result.advice ? { advice: result.advice } : {}),
      };

    case 'screenshot':
      return { success: true, url: result.url, note: result.note };

    case 'wait_for_selector': {
      if (result.success) return { success: true, matched: result.matched };
      // On failure, keep diagnostic but compress it
      const diag = result.diagnostic;
      return {
        success: false,
        error: result.error,
        diagnostic: diag ? {
          url: diag.url,
          title: diag.title,
          pageTextPreview: (diag.pageTextPreview || '').substring(0, 400),
          visibleElements: (diag.visibleButtonsAndLinks || []).slice(0, 10),
        } : null,
        hint: result.hint,
      };
    }

    case 'probe_form':
      // Keep fields but strip rects
      return {
        success: true,
        fieldCount: result.fieldCount,
        fields: (result.fields || []).map(({ rect, ...rest }) => rest),
        hint: result.hint,
      };

    case 'get_console_logs':
      // Limit logs
      return {
        success: true,
        logs: (result.logs || []).slice(-30),
      };

    default:
      return result;
  }
}

// Summarize conversation history to reduce token usage
// Keeps the system message, last N messages, and summarizes the middle
function summarizeHistory(messages, maxMessages) {
  if (messages.length <= maxMessages) return messages;

  const systemMsg = messages[0]; // system prompt
  const recentCount = Math.floor(maxMessages * 0.7);
  const recent = messages.slice(-recentCount);

  // Summarize the middle section
  const middle = messages.slice(1, -recentCount);
  let summaryParts = [];

  for (const msg of middle) {
    if (msg.role === 'assistant' && msg.content) {
      // Extract key info from assistant messages
      const shortened = msg.content.substring(0, 100);
      summaryParts.push(`Agent: ${shortened}`);
    } else if (msg.role === 'tool') {
      // Just note the tool was called
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed.error) {
          summaryParts.push(`Tool error: ${parsed.error.substring(0, 60)}`);
        }
        // Skip successful tool results in summary — they're stale
      } catch (_) {}
    }
    // Skip user messages in middle (already captured in context)
  }

  const summaryText = summaryParts.length > 0
    ? `[Earlier in this conversation: ${summaryParts.slice(0, 8).join('. ')}]`
    : '[Earlier actions omitted for brevity]';

  return [
    systemMsg,
    { role: 'user', content: summaryText },
    { role: 'assistant', content: 'Understood, continuing from where we left off.' },
    ...recent,
  ];
}

// Estimate token count (rough: 1 token ≈ 4 chars)
function estimateTokens(messages) {
  let chars = 0;
  for (const msg of messages) {
    chars += (msg.content || '').length;
  }
  return Math.ceil(chars / 4);
}

// ─── System prompt ────────────────────────────────────────────────────────────

// ── Layer 1: Core — compact, structured for think-plan-act-reflect loop ──────
const CORE_PROMPT = `You are NanoBrowse AI — an autonomous web agent in a real Chromium browser.

## LOOP: THINK → PLAN → ACT → REFLECT
Every turn, follow this cycle internally:
1. THINK: What is the user's goal? What do I know? What's on screen now?
2. PLAN: What are the remaining steps? Which strategy fits?
3. ACT: Execute 1-3 tools per turn. Prefer the minimum needed but always pair navigate with a snapshot.
4. REFLECT: Did it work? Should I adjust? Is the goal met? If yes, respond with final answer.

## STRATEGY SELECTION
Before your first action, classify the task:
- DIRECT: Answerable from current page content → read page, respond. No tools needed beyond maybe get_dom_snapshot.
- SEARCH: Need info from the web → search_web, read snippets, navigate if needed.
- BROWSE: Need to interact with a specific site → navigate, snapshot, click/type.
- MULTI_STEP: Complex task requiring multiple sites/actions → break into sub-goals, tackle sequentially.

## TOOLS
navigate, get_dom_snapshot, get_aria_snapshot, probe_form, click, type_text, fill, press_key, scroll, select_option, select_date, hover, drag, screenshot, wait, wait_for_selector, dismiss_overlay, ask_user, report_progress, go_back, go_forward, get_console_logs, search_web, learn_site_hint

## EFFICIENCY RULES
- Use get_aria_snapshot for understanding page structure (fast, small). Use get_dom_snapshot only when you need exact selectors for click/fill.
- Do NOT call get_dom_snapshot before every action — only when selectors are stale or unknown.
- Batch related logic: if you need to type then press Enter, do both in one turn.
- After navigation, wait briefly then snapshot — don't snapshot, then wait, then snapshot again.
- Stop as soon as you have enough info to answer. Don't over-browse.

## CRITICAL: ONE PAGE AT A TIME
This is a single-tab browser. When you navigate() to a new URL, the PREVIOUS page is GONE FOREVER.
- ALWAYS read/extract all needed info from the current page BEFORE navigating away.
- For multi-site tasks: navigate → get_dom_snapshot (or get_aria_snapshot) → extract info → THEN navigate to next site.
- NEVER navigate to multiple sites first then try to read them — you can only read the LAST page you navigated to.
- If you navigate away without reading, that data is lost and you must navigate back to get it.

## INTERACTION RULES
- get_dom_snapshot before first click/fill on a new page
- report_progress at major milestones only (not every click)
- ask_user before irreversible actions (orders/payments) and for credentials
- After URL-changing action: snapshot before next action
- ONE tab — visit sites sequentially. Read each site before moving to the next.
- Product matching: read ALL titles before clicking. Never click result #1 blindly.
- DATES: resolve relative dates to exact calendar dates before any date field
- FORMS on unknown sites: probe_form() first

## FORM FILLING
- Text inputs: use type_text with the field's selector
- Date pickers (calendar popups, Booking.com, MakeMyTrip, Airbnb, any site with a calendar grid):
  → Use select_date({date:"YYYY-MM-DD", trigger_selector:"...", calendar_container:"..."})
  → trigger_selector: the button/element that opens the calendar (e.g. [data-testid="searchbox-dates-container"])
  → If the DOM snapshot shows calendarInfo with type "calendar-picker-open", the calendar is already open — omit trigger_selector
  → select_date handles month navigation automatically
  → NEVER use type_text or fill on calendar date pickers — they break the widget
- Native <input type="date">: use fill({selector, value:"YYYY-MM-DD"}) — this is the ONLY date field where fill works
- Radio buttons/checkboxes: use click on the LABEL element (label[for="inputId"]), not the input itself
- Select dropdowns: use select_option for native <select>. For custom dropdowns (React-Select, MUI): click to open → wait → click the option
- React-Select/autocomplete inputs: click the container first, then type_text into the revealed input, then click/press_key to select option
- If a field fails: DO NOT retry the same approach. Try fill instead of type_text, click label instead of input, or skip and move on
- NEVER re-navigate to the same URL to "start over" — fix the specific failing field instead

## OVERLAYS
dismiss_overlay immediately if blocking. Location popups: dismiss_overlay({hint:"location"}). Login walls: ask_user.

## SEARCH_WEB
Returns snippets only. To read full content, navigate to each URL. search_web stays on Google results page.
Reddit: search_web({query:"site:reddit.com <topic>"}). YouTube: search_web({query:"<topic> youtube"}).

## RECOVERY (escalate in order)
1. screenshot 2. dismiss_overlay 3. Try common selectors 4. click+type_text 5. Tab focus 6. navigate homepage 7. ask_user after 3 failures
- On wait_for_selector timeout: READ the diagnostic field, adapt. Never retry blindly.

## NETWORK FAILURES
- If navigate() returns success:false with an errorCategory (SSL_ERROR, CONNECTION_RESET, DNS_ERROR, etc.), READ the "advice" field.
- NEVER retry a site that failed with SSL_ERROR or DNS_ERROR — these will NOT resolve on retry.
- For multi-site tasks: if a site is unreachable, SKIP it immediately, note it as "unreachable" in your final answer, and move to the next site.
- Do NOT waste iterations retrying broken sites. Move forward and deliver results from the sites that worked.

## LEARNING
Call learn_site_hint when you discover working patterns on unfamiliar sites.

## OUTPUT
Final answers: be concise and informative. If the task involved finding data (prices, info), present it clearly in your response.`;

// ── Layer 2: Site configs (dynamic, only matching site injected) ──────────────
// Kept compact — each hint is one concise paragraph to minimize tokens
const SITE_CONFIGS = [
  { match: /amazon\./, name: 'Amazon',
    hints: 'Search: #twotabsearchtextbox → type → Enter → wait url_contains "s?k=". Read ALL titles — #1 is often sponsored. Prices valid on s?k= or product pages.' },
  { match: /flipkart\.com/, name: 'Flipkart',
    hints: 'SPA. Click search bar first → type → Enter → wait url_contains "search?q=". Login popup: dismiss_overlay({hint:"login"}).' },
  { match: /croma\.com/, name: 'Croma',
    hints: 'Search URL uses searchB?q= NOT search?q=. After Enter: wait({for_load:true}).' },
  { match: /blinkit\.com/, name: 'Blinkit',
    hints: 'dismiss_overlay({hint:"location"}) first. Search bar is a LINK — click → wait /s/ URL → type_text.' },
  { match: /swiggy\.com/, name: 'Swiggy',
    hints: 'dismiss_overlay({hint:"location"}) first. Click search icon → type_text. Login: ask_user.' },
  { match: /zomato\.com/, name: 'Zomato',
    hints: 'dismiss_overlay({hint:"location"}) first. Search top bar. Login: dismiss or ask_user.' },
  { match: /zepto\.com/, name: 'Zepto',
    hints: 'dismiss_overlay({hint:"location"}) first. SPA search — click first, then type.' },
  { match: /reddit\.com/, name: 'Reddit',
    hints: 'Prefer search_web({query:"site:reddit.com <topic>"}). If navigating: click [role="search"], wait 600ms, type_text.' },
  { match: /linkedin\.com/, name: 'LinkedIn',
    hints: 'Search: .search-global-typeahead__input. Login wall: ask_user.' },
  { match: /makemytrip\.com/, name: 'MakeMyTrip',
    hints: `PRIMARY: Build direct URL — https://www.makemytrip.com/flights/search?tripType=O&itinerary=BOM-DEL-DD/MM/YYYY&paxType=A-1_C-0_I-0&cabinClass=E&sTime=1741000000&forwardFlowRequired=true
Codes: Mumbai=BOM Delhi=DEL BLR=Bangalore MAA=Chennai HYD=Hyderabad CCU=Kolkata PNQ=Pune AMD=Ahmedabad GOI=Goa JAI=Jaipur LKO=Lucknow COK=Kochi.
After navigate: wait 3s, dismiss_overlay({hint:"login"}), wait_for_selector listingCard/flightCard (20s timeout).
FALLBACK form: probe_form first. City fields are autocomplete — click widget → type_text → wait 1s → click suggestion. Date fields: use select_date({date:"YYYY-MM-DD", trigger_selector:"<date-field>"}) — never type dates.` },
  { match: /booking\.com/, name: 'Booking.com',
    hints: 'Search: [name="ss"]. Date picker: use select_date({date:"YYYY-MM-DD", trigger_selector:\'[data-testid="searchbox-dates-container"]\'}) — calendar has data-date attributes. dismiss_overlay for cookies. Guests: [data-testid="occupancy-config"].' },
  { match: /github\.com/, name: 'GitHub',
    hints: 'Search: [data-target="qbsearch-input.inputButton"] to open, then type.' },
  { match: /youtube\.com/, name: 'YouTube',
    hints: 'Search: input#search → Enter. Video titles: ytd-video-renderer h3.' },
  { match: /google\.com\/search/, name: 'Google Search',
    hints: 'Results: div.g > h3 (title), a[href] (link), .VwiC3b (snippet).' },
];

// Session scratchpad — agent-learned hints accumulated during current session
const sessionScratchpad = new Map(); // domain → hint string

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

function getSiteHints(url) {
  if (!url) return '';
  const parts = [];
  // Match against SITE_CONFIGS
  for (const cfg of SITE_CONFIGS) {
    if (cfg.match.test(url)) {
      parts.push(`[${cfg.name}] ${cfg.hints}`);
      break; // one site at a time
    }
  }
  // Append any scratchpad hints for this domain
  const domain = getDomain(url);
  if (domain && sessionScratchpad.has(domain)) {
    parts.push(`[Learned] ${sessionScratchpad.get(domain)}`);
  }
  return parts.join('\n');
}

// Call this from the agentic loop when the agent succeeds on a new site
function learnSiteHint(url, hint) {
  const domain = getDomain(url);
  if (!domain || !hint) return;
  const existing = sessionScratchpad.get(domain) || '';
  // Avoid duplicate hints
  if (!existing.includes(hint)) {
    sessionScratchpad.set(domain, existing ? existing + ' | ' + hint : hint);
  }
}

// ── Layer 3: Prompt assembly ──────────────────────────────────────────────────
function buildSystemPrompt(pageContext, taskHint) {
  const siteHints = getSiteHints(pageContext?.url);
  const siteSection = siteHints
    ? `## SITE HINTS\n${siteHints}`
    : '';

  // Compact page context — only URL + title + first 1500 chars
  const pageSection = pageContext
    ? `## PAGE\nURL: ${pageContext.url}\nTitle: ${pageContext.title}\nContent:\n${pageContext.pageText?.substring(0, 1500)}`
    : '';

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const dateSection = `## TODAY\n${dateStr}`;

  return [CORE_PROMPT, dateSection, siteSection, pageSection].filter(Boolean).join('\n\n');
}

// ─── IPC: Chat — Think-Plan-Act-Reflect Agentic Loop ─────────────────────────

ipcMain.handle('chat:send', async (event, { messages, includePageContext }) => {
  if (!openaiClient) {
    return { error: 'No API key set. Please add your OpenAI API key in settings.' };
  }

  agentAbortController = new AbortController();
  const { signal } = agentAbortController;

  const sendEvent = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  };

  try {
    // ── Phase 0: Gather initial context (lightweight) ─────────────────────
    let pageContext = null;
    if (includePageContext) {
      try {
        const snap = await getDOMSnapshot();
        pageContext = compressSnapshot(snap);
      } catch (_) {}
    }

    // Extract task hint from the latest user message for smarter compression
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const taskHint = lastUserMsg?.content?.substring(0, 100) || '';

    const systemMessage = { role: 'system', content: buildSystemPrompt(pageContext, taskHint) };
    const toolResults = [];
    let currentMessages = [systemMessage, ...messages];
    let finalResponse = '';
    let iterations = 0;
    const MAX_ITERATIONS = 30;

    // Token budget tracking
    const TOKEN_BUDGET = 90000; // ~90k tokens context window budget
    const SUMMARIZE_THRESHOLD = 50000; // Summarize history when estimated > 50k tokens

    // ── Failure tracking: prevent agent from repeating the same failing actions ──
    const failureLog = []; // Array of { tool, selector, error, iteration }
    const FAILURE_THRESHOLD = 2; // After 2 failures with same tool+selector, inject guidance
    const navigateLog = []; // Track navigate calls to detect re-navigation loops

    // ── Phase 1: Send to model with thinking instruction ──────────────────
    // The system prompt already instructs Think→Plan→Act→Reflect

    // Helper: track tool failures and return guidance message if pattern detected
    function trackToolResult(funcName, callArgs, rawResult, iteration) {
      // Track navigation calls to detect re-navigation loops
      if (funcName === 'navigate') {
        const url = callArgs.url || '';
        navigateLog.push({ url, iteration, success: rawResult?.success !== false });

        // Extract domain for domain-level failure detection
        let domain = '';
        try { domain = new URL(url).hostname; } catch (_) {}

        const sameUrlCount = navigateLog.filter(n => n.url === url).length;
        const sameDomainFailures = navigateLog.filter(
          n => { try { return new URL(n.url).hostname === domain; } catch (_) { return false; } }
        ).filter(n => !n.success);

        // Same exact URL navigated 2+ times
        if (sameUrlCount >= 2) {
          return `[SYSTEM] You have navigated to "${url}" ${sameUrlCount} times. ` +
            'STOP retrying this URL. Move on to the next site/task immediately. ' +
            'If this site is unreachable (SSL/connection error), it will NOT work on retry — SKIP IT.';
        }

        // Same domain failed 2+ times (even with different URLs/paths)
        if (sameDomainFailures.length >= 2) {
          return `[SYSTEM] Navigation to domain "${domain}" has failed ${sameDomainFailures.length} times. ` +
            'This domain appears to be unreachable from this browser. ' +
            'DO NOT try this domain again. SKIP it and continue with the remaining sites/tasks.';
        }

        // If this specific navigate failed, give immediate skip advice
        if (rawResult?.success === false && rawResult?.advice) {
          return `[SYSTEM] Navigation failed: ${rawResult.advice}`;
        }
      }

      const failed = rawResult?.success === false || rawResult?.error;
      if (!failed) return null;

      const key = funcName + ':' + (callArgs.selector || callArgs.url || '');
      failureLog.push({ tool: funcName, selector: callArgs.selector || '', error: rawResult?.error || '', iteration, key });

      // Count recent failures with same key
      const recentSameKey = failureLog.filter(f => f.key === key && f.iteration >= iteration - 3);
      if (recentSameKey.length >= FAILURE_THRESHOLD) {
        const guidance = `[SYSTEM] Tool "${funcName}" has failed ${recentSameKey.length} times with selector "${callArgs.selector || ''}". ` +
          `Errors: ${recentSameKey.map(f => f.error).filter(Boolean).join('; ')}. ` +
          'DO NOT repeat the same call. Try a DIFFERENT approach: use a different selector, try click on label instead of input, ' +
          'use fill instead of type_text for date pickers, use get_dom_snapshot or get_aria_snapshot to discover the correct selector, ' +
          'skip this field and move on, or use press_key Tab/ArrowDown to navigate.';
        return guidance;
      }

      // Check for general high failure rate (>50% of last 6 actions failed)
      const recentAll = failureLog.filter(f => f.iteration >= iteration - 5);
      if (recentAll.length >= 3) {
        return '[SYSTEM] Multiple recent tool failures detected. Consider: 1) Taking a screenshot to see the current page state, ' +
          '2) Getting a fresh DOM snapshot, 3) The page may have crashed — try navigating again, ' +
          '4) Use a completely different strategy for the remaining steps.';
      }

      return null;
    }

    while (iterations < MAX_ITERATIONS) {
      if (signal.aborted) {
        finalResponse = 'Task was stopped.';
        break;
      }

      iterations++;

      // ── Token management: summarize or bail if over budget ─────────────
      const estimatedTokens = estimateTokens(currentMessages);
      if (estimatedTokens > TOKEN_BUDGET) {
        // Hard cap: if even after potential summarization we'd be over, stop
        if (currentMessages.length <= 8) {
          finalResponse = 'I ran out of token budget for this conversation. Here is what I accomplished so far.';
          break;
        }
        sendEvent('agent:thinking', {
          phase: 'reflect',
          content: 'Conversation too large — aggressively compressing history...',
        });
        currentMessages = summarizeHistory(currentMessages, 6);
      } else if (estimatedTokens > SUMMARIZE_THRESHOLD && currentMessages.length > 8) {
        sendEvent('agent:thinking', {
          phase: 'reflect',
          content: 'Compressing conversation history to stay within token budget...',
        });
        currentMessages = summarizeHistory(currentMessages, 12);
      }

      // ── LLM call ──────────────────────────────────────────────────────
      const response = await openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: currentMessages,
        tools: TOOLS,
        tool_choice: 'auto',
        max_tokens: 4096,
        temperature: 0.2,
      });

      const message = response.choices[0].message;
      const finishReason = response.choices[0].finish_reason;

      // ── Extract thinking content & detect strategy/plan phases ──────────
      if (message.content && message.tool_calls && message.tool_calls.length > 0) {
        const text = message.content.substring(0, 300);
        // Detect strategy classification
        const strategyMatch = text.match(/\b(DIRECT|SEARCH|BROWSE|MULTI_STEP)\b/i);
        if (strategyMatch && iterations <= 2) {
          sendEvent('agent:thinking', {
            phase: 'plan',
            content: `Strategy: ${strategyMatch[1].toUpperCase()} — ${text.substring(0, 150)}`,
          });
        } else {
          sendEvent('agent:thinking', {
            phase: 'think',
            content: text.substring(0, 200),
          });
        }
      }

      // Emit iteration progress
      sendEvent('agent:thinking', {
        phase: 'status',
        content: `Step ${iterations}/${MAX_ITERATIONS}`,
      });

      if (message.tool_calls && message.tool_calls.length > 0) {
        // Normalize content:null to prevent 400 errors
        const safeMessage = {
          ...message,
          content: message.content ?? '',
        };
        currentMessages.push(safeMessage);

        // Classify tools: read-only tools can run in parallel
        const READ_ONLY_TOOLS = new Set([
          'get_dom_snapshot', 'get_aria_snapshot', 'screenshot',
          'get_console_logs', 'search_web', 'report_progress',
        ]);
        const allReadOnly = message.tool_calls.every(tc => READ_ONLY_TOOLS.has(tc.function.name));

        if (allReadOnly && message.tool_calls.length > 1) {
          // ── Parallel execution for read-only tool batches ────────────
          const results = await Promise.all(message.tool_calls.map(async (toolCall) => {
            if (signal.aborted) return { toolCall, rawResult: null, aborted: true };
            const funcName = toolCall.function.name;
            let args = {};
            try { args = JSON.parse(toolCall.function.arguments); } catch (_) {}
            const rawResult = await executeTool(funcName, args, sendEvent);
            return { toolCall, funcName, args, rawResult };
          }));

          const respondedIds = new Set();
          const deferredGuidance = []; // Collect guidance to inject AFTER all tool responses
          for (const { toolCall, funcName, args, rawResult, aborted } of results) {
            if (aborted || signal.aborted) {
              if (!respondedIds.has(toolCall.id)) {
                respondedIds.add(toolCall.id);
                currentMessages.push({
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  content: JSON.stringify({ skipped: true, reason: 'aborted' }),
                });
              }
              continue;
            }
            if (rawResult?.answer === '__STOPPED__') {
              finalResponse = 'Task was stopped.';
              respondedIds.add(toolCall.id);
              currentMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ skipped: true, reason: 'stopped' }),
              });
              agentAbortController?.abort();
              continue;
            }
            let compressedResult;
            if (funcName === 'get_dom_snapshot') {
              compressedResult = compressSnapshot(rawResult, taskHint);
            } else {
              compressedResult = compressToolResult(funcName, rawResult);
            }
            toolResults.push({ name: funcName, args, result: rawResult });
            sendEvent('agent:tool-result', { name: funcName, args, result: rawResult });
            respondedIds.add(toolCall.id);
            currentMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(compressedResult),
            });

            // Track failures — defer guidance until after all tool responses
            const guidance = trackToolResult(funcName, args, rawResult, iterations);
            if (guidance) {
              sendEvent('agent:thinking', { phase: 'reflect', content: 'Detected repeated failures — nudging agent to adapt.' });
              deferredGuidance.push(guidance);
            }
          }
          // Backfill any tool_calls that didn't get responses
          for (const tc of message.tool_calls) {
            if (!respondedIds.has(tc.id)) {
              currentMessages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify({ skipped: true, reason: 'not-executed' }),
              });
            }
          }
          // NOW inject deferred guidance after all tool responses are in place
          for (const g of deferredGuidance) {
            currentMessages.push({ role: 'system', content: g });
          }
        } else {
          // ── Sequential execution (default for mutating tools) ──────────
          const respondedIds = new Set();
          const deferredGuidance = []; // Collect guidance to inject AFTER all tool responses
          for (const toolCall of message.tool_calls) {
            if (signal.aborted) {
              respondedIds.add(toolCall.id);
              currentMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ skipped: true, reason: 'aborted' }),
              });
              continue;
            }

            try {
              const funcName = toolCall.function.name;
              let args = {};
              try { args = JSON.parse(toolCall.function.arguments); } catch (_) {}

              const rawResult = await executeTool(funcName, args, sendEvent);

              if (signal.aborted) {
                respondedIds.add(toolCall.id);
                currentMessages.push({
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  content: JSON.stringify(rawResult ? compressToolResult(funcName, rawResult) : { skipped: true, reason: 'aborted' }),
                });
                continue;
              }

              if (rawResult?.answer === '__STOPPED__') {
                finalResponse = 'Task was stopped.';
                respondedIds.add(toolCall.id);
                currentMessages.push({
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  content: JSON.stringify({ skipped: true, reason: 'stopped' }),
                });
                agentAbortController?.abort();
                continue;
              }

              let compressedResult;
              if (funcName === 'get_dom_snapshot') {
                compressedResult = compressSnapshot(rawResult, taskHint);
              } else {
                compressedResult = compressToolResult(funcName, rawResult);
              }

              // Auto-inject DOM snapshot after navigate when there are more
              // tool_calls queued.  Without this, if the model batches
              // navigate+navigate+navigate, each subsequent navigate overwrites
              // the page and the model never sees the earlier pages' content.
              if (funcName === 'navigate' && rawResult?.success) {
                const idx = message.tool_calls.indexOf(toolCall);
                const hasMore = idx < message.tool_calls.length - 1;
                if (hasMore) {
                  try {
                    sendEvent('agent:thinking', {
                      phase: 'status',
                      content: 'Auto-capturing page snapshot before next action…',
                    });
                    const autoSnap = await getDOMSnapshot();
                    const compressed = compressSnapshot(autoSnap, taskHint);
                    // Append snapshot to the navigate result so the model sees
                    // the page content in the same tool response
                    compressedResult = {
                      ...compressedResult,
                      autoSnapshot: compressed,
                      _note: 'Page snapshot auto-captured. READ this data before issuing further navigates.',
                    };
                  } catch (snapErr) {
                    console.error('Auto-snapshot after navigate failed:', snapErr.message);
                  }
                }
              }

              toolResults.push({ name: funcName, args, result: rawResult });
              sendEvent('agent:tool-result', { name: funcName, args, result: rawResult });

              respondedIds.add(toolCall.id);
              currentMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify(compressedResult),
              });

              // Track failures — defer guidance until after all tool responses
              const guidance = trackToolResult(funcName, args, rawResult, iterations);
              if (guidance) {
                sendEvent('agent:thinking', { phase: 'reflect', content: 'Detected repeated failures — nudging agent to adapt.' });
                deferredGuidance.push(guidance);
              }
            } catch (toolErr) {
              // Ensure this tool_call_id always gets a response even if something threw
              if (!respondedIds.has(toolCall.id)) {
                respondedIds.add(toolCall.id);
                currentMessages.push({
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  content: JSON.stringify({ success: false, error: toolErr.message || 'Internal error' }),
                });
              }
            }
          }
          // Backfill any tool_calls that didn't get responses
          for (const tc of message.tool_calls) {
            if (!respondedIds.has(tc.id)) {
              currentMessages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify({ skipped: true, reason: 'not-executed' }),
              });
            }
          }
          // NOW inject deferred guidance after all tool responses are in place
          for (const g of deferredGuidance) {
            currentMessages.push({ role: 'system', content: g });
          }
        }

        if (signal.aborted) break;
      } else {
        // ── Model returned final answer — task complete ─────────────────
        finalResponse = message.content || '';
        break;
      }

      if (finishReason === 'stop' && !message.tool_calls) {
        finalResponse = message.content || '';
        break;
      }
    }

    if (!finalResponse && iterations >= MAX_ITERATIONS) {
      finalResponse = 'I reached the maximum number of steps for this task. Here is what I accomplished so far.';
    }

    agentAbortController = null;
    return { response: finalResponse, toolResults };
  } catch (e) {
    agentAbortController = null;
    console.error('Chat error:', e);
    return { error: e.message };
  }
});

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
