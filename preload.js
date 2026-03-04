const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Browser navigation
  navigate: (url) => ipcRenderer.send('browser:navigate', url),
  goBack: () => ipcRenderer.send('browser:go-back'),
  goForward: () => ipcRenderer.send('browser:go-forward'),
  reload: () => ipcRenderer.send('browser:reload'),
  stop: () => ipcRenderer.send('browser:stop'),
  getUrl: () => ipcRenderer.invoke('browser:get-url'),
  getTitle: () => ipcRenderer.invoke('browser:get-title'),

  // Browser events
  onLoading: (cb) => ipcRenderer.on('browser:loading', (_, v) => cb(v)),
  onUrlChanged: (cb) => ipcRenderer.on('browser:url-changed', (_, v) => cb(v)),
  onTitleChanged: (cb) => ipcRenderer.on('browser:title-changed', (_, v) => cb(v)),
  onFaviconChanged: (cb) => ipcRenderer.on('browser:favicon-changed', (_, v) => cb(v)),
  onNavState: (cb) => ipcRenderer.on('browser:nav-state', (_, v) => cb(v)),

  // API Key
  setApiKey: (key) => ipcRenderer.send('set-api-key', key),
  getApiKey: () => ipcRenderer.invoke('get-api-key'),

  // Chat / Agent
  sendChat: (payload) => ipcRenderer.invoke('chat:send', payload),
  stopAgent: () => ipcRenderer.send('agent:stop'),

  // Agent real-time events
  onToolCall: (cb) => ipcRenderer.on('agent:tool-call', (_, v) => cb(v)),
  onToolResult: (cb) => ipcRenderer.on('agent:tool-result', (_, v) => cb(v)),
  onProgress: (cb) => ipcRenderer.on('agent:progress', (_, v) => cb(v)),
  onScreenshot: (cb) => ipcRenderer.on('agent:screenshot', (_, v) => cb(v)),
  onThinking: (cb) => ipcRenderer.on('agent:thinking', (_, v) => cb(v)),

  // Human-in-the-loop: agent asks user for input
  onAskUser: (cb) => ipcRenderer.on('agent:ask-user', (_, v) => cb(v)),
  sendUserAnswer: (id, answer) => ipcRenderer.send('agent:user-answer', { id, answer }),

  // Layout state — tell main process about sidebar/modal so BrowserView bounds stay correct
  setSidebar: (open) => ipcRenderer.send('browser:set-sidebar', open),
  setModal: (open) => ipcRenderer.send('browser:set-modal', open),

  // Cleanup
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
