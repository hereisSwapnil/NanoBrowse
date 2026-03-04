import { useState, useRef } from 'react'
import {
  ArrowLeft, ArrowRight, RotateCw, X, Shield, ShieldOff,
  SidebarClose, SidebarOpen, Settings, Search,
  Home
} from 'lucide-react'

const styles = {
  toolbar: {
    height: 'var(--toolbar-height)',
    background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 12px',
    WebkitAppRegion: 'drag',
    flexShrink: 0,
    userSelect: 'none',
  },
  btn: {
    width: 32,
    height: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    color: 'var(--text-secondary)',
    transition: 'background 0.15s, color 0.15s',
    WebkitAppRegion: 'no-drag',
    flexShrink: 0,
  },
  btnHover: {
    background: 'var(--bg-hover)',
    color: 'var(--text-primary)',
  },
  btnDisabled: {
    opacity: 0.3,
    cursor: 'not-allowed',
  },
  urlBar: {
    flex: 1,
    height: 34,
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 12px',
    WebkitAppRegion: 'no-drag',
    transition: 'border-color 0.15s',
  },
  urlInput: {
    flex: 1,
    background: 'none',
    border: 'none',
    outline: 'none',
    color: 'var(--text-primary)',
    fontSize: 13,
    minWidth: 0,
  },
  trafficLightSpacer: {
    width: 70,
    flexShrink: 0,
  },
}

export default function Toolbar({
  url, loading,
  canGoBack, canGoForward,
  sidebarOpen,
  onNavigate, onBack, onForward, onReload,
  onToggleSidebar, onOpenSettings,
}) {
  const [editVal, setEditVal] = useState('')
  const [focused, setFocused] = useState(false)
  const [hoveredBtn, setHoveredBtn] = useState(null)
  const inputRef = useRef(null)

  // When focused, show user's edit; when blurred, show the prop directly
  const displayedUrl = focused ? editVal : (url || '')

  const handleSubmit = (e) => {
    e.preventDefault()
    onNavigate(editVal)
    inputRef.current?.blur()
    setFocused(false)
  }

  const isHttps = url?.startsWith('https://')

  const iconBtn = (id, icon, onClick, disabled = false, title = '') => (
    <button
      key={id}
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles.btn,
        ...(hoveredBtn === id && !disabled ? styles.btnHover : {}),
        ...(disabled ? styles.btnDisabled : {}),
      }}
      onMouseEnter={() => !disabled && setHoveredBtn(id)}
      onMouseLeave={() => setHoveredBtn(null)}
    >
      {icon}
    </button>
  )

  return (
    <div style={styles.toolbar}>
      {/* macOS traffic light spacer */}
      <div style={styles.trafficLightSpacer} />

      {/* Nav buttons */}
      {iconBtn('back', <ArrowLeft size={16} />, onBack, !canGoBack, 'Back')}
      {iconBtn('fwd', <ArrowRight size={16} />, onForward, !canGoForward, 'Forward')}
      {iconBtn(
        'reload',
        loading ? <X size={15} /> : <RotateCw size={15} />,
        onReload,
        false,
        loading ? 'Stop' : 'Reload'
      )}
      {iconBtn('home', <Home size={15} />, () => onNavigate('https://www.google.com'), false, 'Home')}

      {/* URL Bar */}
      <form onSubmit={handleSubmit} style={{ flex: 1, display: 'flex', WebkitAppRegion: 'no-drag' }}>
        <div style={{
          ...styles.urlBar,
          borderColor: focused ? 'var(--accent)' : 'var(--border)',
        }}>
          {/* Security icon */}
          {isHttps
            ? <Shield size={13} color="var(--success)" style={{ flexShrink: 0 }} />
            : <ShieldOff size={13} color="var(--text-muted)" style={{ flexShrink: 0 }} />
          }
          <input
            ref={inputRef}
            style={styles.urlInput}
            value={displayedUrl}
            onChange={(e) => setEditVal(e.target.value)}
            onFocus={() => {
              setEditVal(url || '')
              setFocused(true)
              setTimeout(() => inputRef.current?.select(), 0)
            }}
            onBlur={() => {
              setFocused(false)
            }}
            spellCheck={false}
            autoComplete="off"
            placeholder="Search or enter URL..."
          />
          {loading && (
            <div style={{
              width: 14, height: 14, flexShrink: 0,
              border: '2px solid var(--border-light)',
              borderTopColor: 'var(--accent)',
              borderRadius: '50%',
              animation: 'spin 0.7s linear infinite',
            }} />
          )}
        </div>
      </form>

      {/* Sidebar toggle */}
      {iconBtn(
        'sidebar',
        sidebarOpen ? <SidebarClose size={16} /> : <SidebarOpen size={16} />,
        onToggleSidebar,
        false,
        sidebarOpen ? 'Hide AI Sidebar' : 'Show AI Sidebar'
      )}

      {/* Settings */}
      {iconBtn('settings', <Settings size={15} />, onOpenSettings, false, 'Settings')}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
