import { useState, useEffect, useCallback } from 'react'
import './index.css'
import Toolbar from './components/Toolbar'
import Sidebar from './components/Sidebar'
import SettingsModal from './components/SettingsModal'

function App() {
  const [displayUrl, setDisplayUrl] = useState('https://www.google.com')
  const [title, setTitle] = useState('NanoBrowse')
  const [_favicon, setFavicon] = useState(null)
  const [loading, setLoading] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [apiKey, setApiKey] = useState('')

  const api = window.electronAPI

  // Sync sidebar state to main process whenever it changes
  useEffect(() => {
    api?.setSidebar(sidebarOpen)
  }, [sidebarOpen])

  // Sync modal state to main process whenever it changes
  // This makes main collapse the BrowserView so the modal can receive clicks
  useEffect(() => {
    api?.setModal(showSettings)
  }, [showSettings])

  useEffect(() => {
    if (!api) return

    api.onLoading((v) => setLoading(v))
    api.onUrlChanged((v) => {
      setDisplayUrl(v)
    })
    api.onTitleChanged((v) => setTitle(v))
    api.onFaviconChanged((v) => setFavicon(v))
    api.onNavState((v) => {
      setCanGoBack(v.canGoBack)
      setCanGoForward(v.canGoForward)
    })

    // Load saved API key indicator
    api.getApiKey().then(k => setApiKey(k))

    // Tell main our initial sidebar state
    api.setSidebar(true)

    return () => {
      api.removeAllListeners('browser:loading')
      api.removeAllListeners('browser:url-changed')
      api.removeAllListeners('browser:title-changed')
      api.removeAllListeners('browser:favicon-changed')
      api.removeAllListeners('browser:nav-state')
    }
  }, [])

  const handleNavigate = useCallback((input) => {
    if (!api) return
    api.navigate(input)
  }, [])

  const handleSaveApiKey = useCallback((key) => {
    if (!api) return
    api.setApiKey(key)
    setApiKey(key ? '••••••••' + key.slice(-4) : '')
    setShowSettings(false)
  }, [])

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen(o => !o)
  }, [])

  const handleOpenSettings = useCallback(() => {
    setShowSettings(true)
  }, [])

  const handleCloseSettings = useCallback(() => {
    setShowSettings(false)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-primary)' }}>
      {/* Toolbar */}
      <Toolbar
        url={displayUrl}
        loading={loading}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        sidebarOpen={sidebarOpen}
        onNavigate={handleNavigate}
        onBack={() => api?.goBack()}
        onForward={() => api?.goForward()}
        onReload={() => loading ? api?.stop() : api?.reload()}
        onToggleSidebar={handleToggleSidebar}
        onOpenSettings={handleOpenSettings}
      />

      {/* Main area: browser + sidebar */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Browser area — BrowserView (native) fills this pixel region */}
        <div style={{ flex: 1, background: '#0f0f0f', minWidth: 0 }} />

        {/* Sidebar */}
        {sidebarOpen && (
          <Sidebar
            currentTitle={title}
            hasApiKey={!!apiKey}
            onOpenSettings={handleOpenSettings}
          />
        )}
      </div>

      {/* Settings Modal — renders above everything */}
      {showSettings && (
        <SettingsModal
          onSave={handleSaveApiKey}
          onClose={handleCloseSettings}
          currentKey={apiKey}
        />
      )}
    </div>
  )
}

export default App
