import { useState } from 'react'
import { X, Key } from 'lucide-react'

export default function SettingsModal({ onSave, onClose, currentKey }) {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')

  const handleSave = () => {
    if (!key.trim()) {
      setError('Please enter an API key')
      return
    }
    if (!key.trim().startsWith('sk-')) {
      setError('OpenAI API keys start with "sk-"')
      return
    }
    onSave(key.trim())
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-light)',
        borderRadius: 14,
        padding: 28,
        width: 420,
        position: 'relative',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        {/* Close */}
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: 14, right: 14,
            color: 'var(--text-secondary)', padding: 4,
            borderRadius: 6, display: 'flex',
            transition: 'color 0.15s',
          }}
        >
          <X size={17} />
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'var(--accent-dim)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <Key size={17} color="var(--accent)" />
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>OpenAI API Key</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Required for the AI assistant</div>
          </div>
        </div>

        {currentKey && (
          <div style={{
            background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)',
            borderRadius: 8, padding: '8px 12px', marginBottom: 14,
            fontSize: 12, color: 'var(--success)',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span>✓</span> Current key: {currentKey}
          </div>
        )}

        <div style={{ marginBottom: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
          Enter your OpenAI API key (stored in memory only, never saved to disk)
        </div>

        <input
          type="password"
          placeholder="sk-..."
          value={key}
          onChange={(e) => { setKey(e.target.value); setError('') }}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          autoFocus
          style={{
            width: '100%', height: 40,
            background: 'var(--bg-tertiary)',
            border: `1px solid ${error ? 'var(--error)' : 'var(--border)'}`,
            borderRadius: 8, padding: '0 12px',
            color: 'var(--text-primary)', fontSize: 13,
            outline: 'none', marginBottom: error ? 6 : 16,
            transition: 'border-color 0.15s',
          }}
        />

        {error && (
          <div style={{ color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onClose}
            style={{
              flex: 1, height: 38, borderRadius: 8,
              background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
              fontSize: 13, fontWeight: 500, transition: 'background 0.15s',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            style={{
              flex: 2, height: 38, borderRadius: 8,
              background: 'var(--accent)', color: '#fff',
              fontSize: 13, fontWeight: 600,
              transition: 'background 0.15s',
            }}
          >
            Save API Key
          </button>
        </div>

        <div style={{ marginTop: 14, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
          Get your key at platform.openai.com → API Keys
        </div>
      </div>
    </div>
  )
}
