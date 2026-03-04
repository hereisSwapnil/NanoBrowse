import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Send, Bot, User, Loader2, Globe, MousePointerClick,
  FileText, Camera, AlertCircle, ChevronDown, ChevronRight,
  Sparkles, Trash2, Key, ArrowUpRight, Type, Keyboard,
  List, Clock, RotateCcw, Eye, CheckCircle2, XCircle,
  MessageSquare, Zap, Square, ArrowLeft, ArrowRight, Image, MousePointer2,
  ScrollText, BarChart2, HelpCircle, Play, Search, Terminal, Accessibility, GripVertical, BookMarked,
  Brain, ClipboardList, CalendarDays,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import iconUrl from '../assets/icon.png'

// ─── Tool metadata ─────────────────────────────────────────────────────────────

const TOOL_META = {
  navigate: { icon: Globe, color: '#818cf8', label: (a) => `Navigate → ${a?.url ? truncate(a.url, 40) : '...'}` },
  get_dom_snapshot: { icon: ScrollText, color: '#a78bfa', label: () => 'Reading DOM snapshot' },
  click: { icon: MousePointerClick, color: '#fb923c', label: (a) => `Click: ${truncate(a?.description || a?.selector, 36)}` },
  type_text: { icon: Type, color: '#34d399', label: (a) => `Type "${truncate(a?.text, 30)}"` },
  fill: { icon: Keyboard, color: '#34d399', label: (a) => `Fill "${truncate(a?.value, 30)}"` },
  press_key: { icon: Keyboard, color: '#fbbf24', label: (a) => `Key: ${a?.key || '?'}` },
  select_option: { icon: List, color: '#60a5fa', label: (a) => `Select "${truncate(a?.value, 30)}"` },
  scroll: { icon: ArrowUpRight, color: '#94a3b8', label: (a) => `Scroll ${a?.direction || 'down'}` },
  wait: { icon: Clock, color: '#94a3b8', label: (a) => a?.for_load ? 'Waiting for page load' : `Wait ${a?.ms || 1000}ms` },
  wait_for_selector: { icon: Clock, color: '#60a5fa', label: (a) => `Waiting for: ${truncate(a?.selector || a?.url_contains, 34)}` },
  dismiss_overlay: { icon: XCircle, color: '#f87171', label: (a) => `Dismissing ${a?.hint || 'overlay'}` },
  screenshot: { icon: Camera, color: '#f472b6', label: () => 'Taking screenshot' },
  ask_user: { icon: MessageSquare, color: '#fbbf24', label: () => 'Asking you...' },
  report_progress: { icon: BarChart2, color: '#818cf8', label: (a) => truncate(a?.message, 42) },
  hover: { icon: MousePointer2, color: '#94a3b8', label: (a) => `Hover: ${truncate(a?.selector, 36)}` },
  go_back: { icon: ArrowLeft, color: '#94a3b8', label: () => 'Going back' },
  go_forward: { icon: ArrowRight, color: '#94a3b8', label: () => 'Going forward' },
  search_web: { icon: Search, color: '#38bdf8', label: (a) => `Search: ${truncate(a?.query, 36)}` },
  get_console_logs: { icon: Terminal, color: '#a3e635', label: () => 'Reading console logs' },
  get_aria_snapshot: { icon: Accessibility, color: '#c084fc', label: () => 'Reading ARIA snapshot' },
  drag: { icon: GripVertical, color: '#fb923c', label: (a) => `Drag → ${truncate(a?.target_selector, 30)}` },
  learn_site_hint: { icon: BookMarked, color: '#34d399', label: (a) => `Learned: ${truncate(a?.hint, 40)}` },
  probe_form: { icon: ClipboardList, color: '#a78bfa', label: () => 'Analyzing form fields' },
  select_date: { icon: CalendarDays, color: '#fb923c', label: (a) => `Select date: ${a?.date || '?'}` },
}

function truncate(str, len = 40) {
  if (!str) return '...'
  return str.length > len ? str.slice(0, len) + '…' : str
}

function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ─── ToolCallBadge ─────────────────────────────────────────────────────────────

function ToolCallBadge({ tool }) {
  const [expanded, setExpanded] = useState(false)
  const meta = TOOL_META[tool.name] || { icon: Sparkles, color: '#818cf8', label: () => tool.name }
  const Icon = meta.icon
  const label = meta.label(tool.args)
  const hasResult = !!tool.result
  const resultOk = hasResult && (tool.result?.success !== false && !tool.result?.error)

  return (
    <div
      onClick={() => hasResult && setExpanded(e => !e)}
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: `1px solid rgba(255,255,255,0.08)`,
        borderRadius: 8,
        padding: '5px 10px',
        fontSize: 12,
        marginBottom: 3,
        cursor: hasResult ? 'pointer' : 'default',
        transition: 'background 0.1s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Icon size={12} color={meta.color} style={{ flexShrink: 0 }} />
        <span style={{ color: 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        {hasResult && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, marginLeft: 4, flexShrink: 0 }}>
            {resultOk
              ? <CheckCircle2 size={11} color="#4ade80" />
              : <XCircle size={11} color="#f87171" />}
            {expanded
              ? <ChevronDown size={11} color="var(--text-muted)" />
              : <ChevronRight size={11} color="var(--text-muted)" />}
          </span>
        )}
        {!hasResult && (
          <Loader2 size={11} color={meta.color} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
        )}
      </div>

      {expanded && tool.result && (
        <div style={{
          marginTop: 6, padding: '7px 9px',
          background: 'rgba(0,0,0,0.35)', borderRadius: 6,
          fontFamily: 'monospace', fontSize: 11,
          color: 'var(--text-secondary)',
          maxHeight: 140, overflowY: 'auto',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}>
          {typeof tool.result === 'object'
            ? JSON.stringify(tool.result, null, 2).slice(0, 800)
            : String(tool.result).slice(0, 800)}
        </div>
      )}
    </div>
  )
}

// ─── ProgressBar ──────────────────────────────────────────────────────────────

function ProgressBar({ step, total, message }) {
  const pct = total > 0 ? Math.min(100, Math.round((step / total) * 100)) : null

  return (
    <div style={{
      background: 'rgba(99,102,241,0.08)',
      border: '1px solid rgba(99,102,241,0.2)',
      borderRadius: 8,
      padding: '7px 10px',
      marginBottom: 4,
      fontSize: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: pct !== null ? 5 : 0 }}>
        <Zap size={11} color="var(--accent)" style={{ flexShrink: 0 }} />
        <span style={{ color: 'var(--text-secondary)', flex: 1 }}>{message}</span>
        {pct !== null && (
          <span style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 11 }}>
            {step}/{total}
          </span>
        )}
      </div>
      {pct !== null && (
        <div style={{
          height: 3, background: 'rgba(255,255,255,0.08)',
          borderRadius: 99, overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', width: pct + '%',
            background: 'var(--accent)',
            borderRadius: 99,
            transition: 'width 0.4s ease',
          }} />
        </div>
      )}
    </div>
  )
}

// ─── AskUserCard ──────────────────────────────────────────────────────────────
// Inline card rendered in the chat when agent pauses to ask the user something

function AskUserCard({ question, options, fieldHints, questionId, onAnswer }) {
  const [answer, setAnswer] = useState('')
  const [fields, setFields] = useState(() =>
    fieldHints ? Object.fromEntries(fieldHints.map(f => [f.key, ''])) : null
  )
  const [submitted, setSubmitted] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus()
  }, [])

  const submit = (val) => {
    if (submitted) return
    const finalAnswer = val !== undefined ? val : (fields
      ? JSON.stringify(fields)
      : answer.trim())
    if (!finalAnswer) return
    setSubmitted(true)
    onAnswer(questionId, finalAnswer)
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  }

  if (submitted) {
    return (
      <div style={{
        background: 'rgba(99,102,241,0.08)',
        border: '1px solid rgba(99,102,241,0.2)',
        borderRadius: 10, padding: '10px 12px',
        fontSize: 12, color: 'var(--text-muted)',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <CheckCircle2 size={13} color="#4ade80" />
        Answer sent — agent is continuing...
      </div>
    )
  }

  return (
    <div style={{
      background: 'rgba(251,191,36,0.07)',
      border: '1px solid rgba(251,191,36,0.25)',
      borderRadius: 12,
      padding: '12px 12px 10px',
      marginBottom: 4,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <HelpCircle size={13} color="#fbbf24" />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#fbbf24' }}>
          Agent needs your input
        </span>
      </div>

      {/* Question text */}
      <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5, marginBottom: 10 }}>
        {question}
      </div>

      {/* Quick-reply option buttons */}
      {options && options.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {options.map((opt, i) => (
            <button
              key={i}
              onClick={() => submit(opt)}
              style={{
                padding: '5px 11px',
                borderRadius: 20,
                background: 'rgba(251,191,36,0.12)',
                border: '1px solid rgba(251,191,36,0.35)',
                color: '#fde68a',
                fontSize: 12, cursor: 'pointer',
                transition: 'background 0.1s',
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {/* Structured field inputs */}
      {fields && fieldHints && fieldHints.map(f => (
        <div key={f.key} style={{ marginBottom: 7 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{f.label}</div>
          <input
            type={f.sensitive ? 'password' : 'text'}
            value={fields[f.key]}
            onChange={e => setFields(prev => ({ ...prev, [f.key]: e.target.value }))}
            onKeyDown={handleKey}
            placeholder={f.label}
            style={{
              width: '100%',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 7,
              padding: '6px 9px',
              color: 'var(--text-primary)',
              fontSize: 13,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>
      ))}

      {/* Free-text input (shown when no field_hints) */}
      {!fields && (
        <div style={{ display: 'flex', gap: 7 }}>
          <input
            ref={inputRef}
            value={answer}
            onChange={e => setAnswer(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Type your answer..."
            style={{
              flex: 1,
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 7,
              padding: '6px 9px',
              color: 'var(--text-primary)',
              fontSize: 13,
              outline: 'none',
            }}
          />
          <button
            onClick={() => submit()}
            disabled={!answer.trim()}
            style={{
              padding: '6px 12px',
              background: answer.trim() ? '#fbbf24' : 'rgba(255,255,255,0.06)',
              borderRadius: 7, cursor: answer.trim() ? 'pointer' : 'not-allowed',
              color: answer.trim() ? '#000' : 'var(--text-muted)',
              fontWeight: 600, fontSize: 12, flexShrink: 0,
              transition: 'all 0.15s',
            }}
          >
            Send
          </button>
        </div>
      )}

      {/* Submit button for structured fields */}
      {fields && (
        <button
          onClick={() => submit()}
          style={{
            marginTop: 4,
            padding: '7px 14px',
            background: '#fbbf24',
            borderRadius: 7, cursor: 'pointer',
            color: '#000', fontWeight: 600,
            fontSize: 12, width: '100%',
            transition: 'opacity 0.15s',
          }}
        >
          Submit
        </button>
      )}
    </div>
  )
}

// ─── ScreenshotPreview ────────────────────────────────────────────────────────

function ScreenshotPreview({ dataUrl }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div style={{ marginBottom: 4 }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'rgba(244,114,182,0.08)',
          border: '1px solid rgba(244,114,182,0.2)',
          borderRadius: 8, padding: '5px 10px',
          color: '#f472b6', fontSize: 12, cursor: 'pointer', width: '100%',
          textAlign: 'left',
        }}
      >
        <Image size={12} />
        <span style={{ flex: 1 }}>Screenshot captured</span>
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </button>
      {expanded && (
        <div style={{ marginTop: 4, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
          <img src={dataUrl} alt="Screenshot" style={{ width: '100%', display: 'block', borderRadius: 7 }} />
        </div>
      )}
    </div>
  )
}

// ─── ThinkingIndicator ────────────────────────────────────────────────────────

function ThinkingBubble({ content, phase }) {
  if (!content) return null
  const phaseLabels = {
    think: 'Thinking',
    plan: 'Planning',
    reflect: 'Reflecting',
  }
  const phaseColors = {
    think: '#818cf8',
    plan: '#38bdf8',
    reflect: '#a78bfa',
  }
  const label = phaseLabels[phase] || 'Thinking'
  const color = phaseColors[phase] || '#818cf8'

  return (
    <div style={{
      background: `${color}11`,
      border: `1px solid ${color}33`,
      borderRadius: 8,
      padding: '6px 10px',
      marginBottom: 4,
      fontSize: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Brain size={11} color={color} style={{ flexShrink: 0 }} />
        <span style={{ color, fontWeight: 600, fontSize: 11 }}>{label}</span>
      </div>
      <div style={{
        color: 'var(--text-secondary)', marginTop: 3,
        lineHeight: 1.4, fontSize: 11,
        overflow: 'hidden', textOverflow: 'ellipsis',
        display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
      }}>
        {content}
      </div>
    </div>
  )
}

function ThinkingIndicator({ currentTool, thinkingContent, scratchpad, agentStep }) {
  const [scratchpadOpen, setScratchpadOpen] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-start', marginBottom: 12 }}>
      {/* Step counter + scratchpad toggle */}
      {(agentStep || scratchpad.length > 0) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%',
        }}>
          {agentStep && (
            <span style={{
              fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace',
              background: 'var(--bg-hover)', padding: '2px 6px', borderRadius: 4,
            }}>
              {agentStep}
            </span>
          )}
          {scratchpad.length > 0 && (
            <button
              onClick={() => setScratchpadOpen(v => !v)}
              style={{
                fontSize: 10, color: 'var(--text-muted)', background: 'none',
                border: 'none', cursor: 'pointer', display: 'flex',
                alignItems: 'center', gap: 3, padding: '2px 4px',
              }}
            >
              <ClipboardList size={10} />
              {scratchpadOpen ? 'Hide' : 'Show'} log ({scratchpad.length})
            </button>
          )}
        </div>
      )}
      {/* Scratchpad log */}
      {scratchpadOpen && scratchpad.length > 0 && (
        <div style={{
          width: '100%', background: 'var(--bg-tertiary)',
          border: '1px solid var(--border)', borderRadius: 6,
          padding: '4px 6px', maxHeight: 120, overflowY: 'auto',
        }}>
          {scratchpad.map((entry, i) => {
            const phaseColors = { think: '#818cf8', plan: '#38bdf8', reflect: '#a78bfa' }
            const color = phaseColors[entry.phase] || '#818cf8'
            return (
              <div key={i} style={{
                fontSize: 10, lineHeight: 1.4, padding: '1px 0',
                borderBottom: i < scratchpad.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                <span style={{ color, fontWeight: 600 }}>
                  {entry.phase === 'think' ? 'T' : entry.phase === 'plan' ? 'P' : 'R'}
                </span>
                <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>
                  {entry.content?.substring(0, 80)}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {thinkingContent && (
        <ThinkingBubble content={thinkingContent.content} phase={thinkingContent.phase} />
      )}
      {currentTool && (
        <div style={{
          background: 'var(--accent-dim)',
          border: '1px solid rgba(99,102,241,0.2)',
          borderRadius: 8, padding: '5px 10px',
          fontSize: 12, color: 'var(--accent)',
          display: 'flex', alignItems: 'center', gap: 6,
          animation: 'pulse 1.5s ease-in-out infinite',
          maxWidth: '100%',
        }}>
          <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentTool}
          </span>
        </div>
      )}
      <div style={{
        background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
        borderRadius: '14px 14px 14px 4px', padding: '10px 14px',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{
            width: 6, height: 6, borderRadius: '50%',
            background: 'var(--text-muted)',
            animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
          }} />
        ))}
      </div>
    </div>
  )
}

// ─── ScratchpadSummary ─────────────────────────────────────────────────────────

function ScratchpadSummary({ entries }) {
  const [open, setOpen] = useState(false)
  if (!entries || entries.length === 0) return null

  const phaseColors = { think: '#818cf8', plan: '#38bdf8', reflect: '#a78bfa' }
  const phaseLabels = { think: 'Think', plan: 'Plan', reflect: 'Reflect' }

  return (
    <div style={{ width: '100%', marginBottom: 4 }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          fontSize: 10, color: 'var(--text-muted)', background: 'none',
          border: 'none', cursor: 'pointer', display: 'flex',
          alignItems: 'center', gap: 4, padding: '2px 0',
        }}
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <Brain size={10} />
        Agent reasoning ({entries.length} steps)
      </button>
      {open && (
        <div style={{
          background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '4px 6px', marginTop: 3,
          maxHeight: 140, overflowY: 'auto',
        }}>
          {entries.map((entry, i) => {
            const color = phaseColors[entry.phase] || '#818cf8'
            const label = phaseLabels[entry.phase] || entry.phase
            return (
              <div key={i} style={{
                fontSize: 10, lineHeight: 1.4, padding: '2px 0',
                borderBottom: i < entries.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                <span style={{ color, fontWeight: 600 }}>{label}</span>
                <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>
                  {entry.content?.substring(0, 100)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Message ──────────────────────────────────────────────────────────────────

function Message({ msg, onAnswer }) {
  const isUser = msg.role === 'user'
  const isError = msg.error

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 14, gap: 3,
    }}>

      {/* Progress events */}
      {msg.progressEvents && msg.progressEvents.map((p, i) => (
        <ProgressBar key={i} step={p.step} total={p.total} message={p.message} />
      ))}

      {/* Screenshots */}
      {msg.screenshots && msg.screenshots.map((s, i) => (
        <ScreenshotPreview key={i} dataUrl={s} />
      ))}

      {/* Tool calls */}
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div style={{ width: '100%', paddingBottom: 2 }}>
          {msg.toolCalls.map((tool, i) => <ToolCallBadge key={i} tool={tool} />)}
        </div>
      )}

      {/* Agent thinking scratchpad (collapsed by default) */}
      {msg.scratchpad && msg.scratchpad.length > 0 && (
        <ScratchpadSummary entries={msg.scratchpad} />
      )}

      {/* Ask-user card */}
      {msg.askUser && !isUser && (
        <div style={{ width: '100%' }}>
          <AskUserCard
            question={msg.askUser.question}
            options={msg.askUser.options}
            fieldHints={msg.askUser.field_hints}
            questionId={msg.askUser.id}
            onAnswer={onAnswer}
          />
        </div>
      )}

      {/* Bubble */}
      {msg.content && (
        <div style={{
          maxWidth: '92%',
          background: isUser
            ? 'var(--accent)'
            : isError ? 'rgba(239,68,68,0.1)' : 'var(--bg-tertiary)',
          border: isError
            ? '1px solid rgba(239,68,68,0.3)'
            : isUser ? 'none' : '1px solid var(--border)',
          borderRadius: isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
          padding: '10px 14px',
          color: isUser ? '#000000' : isError ? 'var(--error)' : 'var(--text-primary)',
          fontSize: 13, lineHeight: 1.6,
        }}>
          {isUser ? (
            <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
          ) : (
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
            </div>
          )}
        </div>
      )}

      {/* Timestamp */}
      <div style={{ fontSize: 10, color: 'var(--text-muted)', paddingInline: 4 }}>
        {msg.time}
      </div>
    </div>
  )
}

// ─── Quick actions ─────────────────────────────────────────────────────────────

const QUICK_ACTIONS = [
  { label: 'Summarize this page', icon: FileText },
  { label: 'Find all links on this page', icon: Globe },
  { label: 'Take a screenshot', icon: Camera },
  { label: 'Search for AI news', icon: Sparkles },
]

// ─── Sidebar ──────────────────────────────────────────────────────────────────

export default function Sidebar({ currentTitle, hasApiKey, onOpenSettings }) {
  const [messages, setMessages] = useState([{
    role: 'assistant',
    content: "Hi! I'm **NanoBrowse AI** — your agentic browser assistant.\n\nI can:\n- **Navigate** to any website or search the web\n- **Read** and summarize page content\n- **Click** buttons and **fill** forms on your behalf\n- **Complete multi-step tasks** autonomously (e.g. search, add to cart, checkout)\n\nWhat would you like to do?",
    time: now(),
  }])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [currentTool, setCurrentTool] = useState(null)
  const [thinkingContent, setThinkingContent] = useState(null)
  const [scratchpad, setScratchpad] = useState([])
  const scratchpadRef = useRef([])
  const [agentStep, setAgentStep] = useState(null)
  const [includeContext, setIncludeContext] = useState(true)
  // Live tool-call buffer while agent is running (shown inline)
  const liveToolsRef = useRef([])
  const liveProgressRef = useRef([])
  const liveScreenshotsRef = useRef([])
  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)
  const api = window.electronAPI

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // ── IPC listeners ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!api) return

    // Live tool-call display while agent runs
    api.onToolCall(({ name, args }) => {
      const meta = TOOL_META[name] || {}
      const labelFn = meta.label || (() => name)
      setCurrentTool(labelFn(args))
      liveToolsRef.current = [...liveToolsRef.current, { name, args, result: null }]
    })

    api.onToolResult(({ name, result }) => {
      liveToolsRef.current = liveToolsRef.current.map(t =>
        t.name === name && t.result === null ? { ...t, result } : t
      )
    })

    api.onProgress(({ message, step, total }) => {
      setCurrentTool(truncate(message, 50))
      liveProgressRef.current = [...liveProgressRef.current, { message, step, total }]
    })

    api.onScreenshot(({ dataUrl }) => {
      liveScreenshotsRef.current = [...liveScreenshotsRef.current, dataUrl]
    })

    api.onThinking(({ phase, content }) => {
      if (phase === 'status') {
        setAgentStep(content)
      } else {
        setThinkingContent({ phase, content })
        const entry = { phase, content, time: now() }
        scratchpadRef.current = [...scratchpadRef.current.slice(-9), entry]
        setScratchpad(scratchpadRef.current)
      }
    })

    // Agent pauses and asks user — inject an ask-user card into the chat
    api.onAskUser(({ id, question, options, field_hints }) => {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: null,
        askUser: { id, question, options, field_hints },
        time: now(),
      }])
      setCurrentTool(null)
    })

    return () => {
      api.removeAllListeners('agent:tool-call')
      api.removeAllListeners('agent:tool-result')
      api.removeAllListeners('agent:progress')
      api.removeAllListeners('agent:screenshot')
      api.removeAllListeners('agent:thinking')
      api.removeAllListeners('agent:ask-user')
    }
  }, [])

  // ── User answers agent question ────────────────────────────────────────────

  const handleAnswer = useCallback((id, answer) => {
    api?.sendUserAnswer(id, answer)
  }, [])

  // ── sendMessage ────────────────────────────────────────────────────────────

  const sendMessage = useCallback(async (text) => {
    const content = (text || input).trim()
    if (!content || loading) return
    if (!hasApiKey) { onOpenSettings(); return }

    setInput('')
    setLoading(true)
    setCurrentTool(null)
    setThinkingContent(null)
    setScratchpad([])
    scratchpadRef.current = []
    setAgentStep(null)
    liveToolsRef.current = []
    liveProgressRef.current = []
    liveScreenshotsRef.current = []

    const userMsg = { role: 'user', content, time: now() }
    setMessages(prev => [...prev, userMsg])

    const history = [...messages, userMsg]
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content != null && m.content !== '')
      .map(m => ({ role: m.role, content: m.content }))

    try {
      const result = await api?.sendChat({ messages: history, includePageContext: includeContext })

      setCurrentTool(null)
      setThinkingContent(null)
      setAgentStep(null)
      const capturedTools = [...liveToolsRef.current]
      const capturedProgress = [...liveProgressRef.current]
      const capturedScreenshots = [...liveScreenshotsRef.current]
      const capturedScratchpad = [...scratchpadRef.current]

      if (result?.error) {
        setMessages(prev => [...prev, {
          role: 'assistant', content: result.error,
          error: true, time: now(),
        }])
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: result.response,
          toolCalls: capturedTools,
          progressEvents: capturedProgress.length > 0 ? capturedProgress : undefined,
          screenshots: capturedScreenshots.length > 0 ? capturedScreenshots : undefined,
          scratchpad: capturedScratchpad.length > 0 ? capturedScratchpad : undefined,
          time: now(),
        }])
      }
    } catch (e) {
      setCurrentTool(null)
      setThinkingContent(null)
      setAgentStep(null)
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'An error occurred: ' + e.message,
        error: true, time: now(),
      }])
    }

    setLoading(false)
  }, [input, loading, messages, hasApiKey, includeContext])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  const stopAgent = () => {
    api?.stopAgent()
    setLoading(false)
    setCurrentTool(null)
    setThinkingContent(null)
    setAgentStep(null)
    setMessages(prev => [...prev, {
      role: 'assistant',
      content: 'Task stopped.',
      time: now(),
    }])
  }

  const clearMessages = () => {
    setMessages([{
      role: 'assistant',
      content: 'Chat cleared. How can I help you?',
      time: now(),
    }])
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{
      width: 'var(--sidebar-width)', flexShrink: 0,
      display: 'flex', flexDirection: 'column',
      borderLeft: '1px solid var(--border)',
      background: 'var(--bg-secondary)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      height: '100%',
    }}>

      {/* ── Header ── */}
      <div style={{
        padding: '13px 14px 11px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 9,
        flexShrink: 0,
      }}>
        <div style={{
          width: 28, height: 28, borderRadius: 7,
          background: 'var(--accent-dim)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
          overflow: 'hidden',
        }}>
          {/* <Bot size={15} color="var(--accent)" /> */}
          <img src={iconUrl} alt="NanoBrowse AI" style={{ width: '50px', height: '50px', objectFit: 'cover' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>NanoBrowse AI</div>
          <div style={{
            fontSize: 11, color: 'var(--text-muted)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {loading ? 'Working...' : (currentTitle || 'Ready')}
          </div>
        </div>

        {/* Stop button (visible while agent running) */}
        {loading && (
          <button
            onClick={stopAgent}
            title="Stop agent"
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 8px', borderRadius: 6,
              background: 'rgba(239,68,68,0.12)',
              border: '1px solid rgba(239,68,68,0.25)',
              color: '#f87171', fontSize: 11, cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <Square size={10} fill="#f87171" />
            Stop
          </button>
        )}

        {/* Clear button */}
        {!loading && (
          <button
            onClick={clearMessages}
            title="Clear chat"
            style={{ color: 'var(--text-muted)', padding: 4, borderRadius: 6, display: 'flex' }}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {/* ── No API key banner ── */}
      {!hasApiKey && (
        <button
          onClick={onOpenSettings}
          style={{
            margin: '10px 12px 0',
            padding: '10px 14px',
            background: 'rgba(99,102,241,0.08)',
            border: '1px solid rgba(99,102,241,0.22)',
            borderRadius: 10, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            textAlign: 'left',
          }}
        >
          <Key size={14} color="var(--accent)" />
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>Add OpenAI API Key</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Required to use the AI assistant</div>
          </div>
        </button>
      )}

      {/* ── Messages ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 13px' }}>
        {messages.map((msg, i) => (
          <Message key={i} msg={msg} onAnswer={handleAnswer} />
        ))}
        {loading && <ThinkingIndicator currentTool={currentTool} thinkingContent={thinkingContent} scratchpad={scratchpad} agentStep={agentStep} />}
        <div ref={messagesEndRef} />
      </div>

      {/* ── Quick actions (first open) ── */}
      {messages.length === 1 && !loading && (
        <div style={{ padding: '0 12px 8px', display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {QUICK_ACTIONS.map((action, i) => (
            <button
              key={i}
              onClick={() => sendMessage(action.label)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '5px 10px', borderRadius: 20,
                background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                color: 'var(--text-secondary)', fontSize: 11, cursor: 'pointer',
              }}
            >
              <action.icon size={11} />
              {action.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Context toggle ── */}
      <div style={{
        padding: '5px 13px',
        display: 'flex', alignItems: 'center', gap: 8,
        borderTop: '1px solid var(--border)', flexShrink: 0,
      }}>
        <button
          onClick={() => setIncludeContext(v => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            fontSize: 11, color: includeContext ? 'var(--accent)' : 'var(--text-muted)',
            padding: '3px 8px', borderRadius: 6,
            background: includeContext ? 'var(--accent-dim)' : 'transparent',
            border: `1px solid ${includeContext ? 'rgba(99,102,241,0.3)' : 'transparent'}`,
            transition: 'all 0.15s',
          }}
        >
          <Globe size={11} />
          {includeContext ? 'Page context: ON' : 'Page context: OFF'}
        </button>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          Shift+Enter for new line
        </div>
      </div>

      {/* ── Input ── */}
      <div style={{ padding: '8px 12px 13px', flexShrink: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'flex-end', gap: 8,
          background: 'var(--bg-tertiary)',
          border: '1px solid var(--border-light)',
          borderRadius: 12, padding: '8px 8px 8px 12px',
          transition: 'border-color 0.15s',
        }}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
            }}
            onKeyDown={handleKeyDown}
            placeholder={hasApiKey ? 'Ask anything or give a task...' : 'Add API key to start...'}
            disabled={loading || !hasApiKey}
            rows={1}
            style={{
              flex: 1, background: 'none', border: 'none', outline: 'none',
              color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.5,
              resize: 'none', maxHeight: 120, minHeight: 25, overflowY: 'auto',
            }}
          />
          <button
            onClick={() => sendMessage()}
            disabled={loading || !input.trim() || !hasApiKey}
            style={{
              width: 32, height: 32,
              background: loading || !input.trim() || !hasApiKey
                ? 'var(--bg-hover)' : 'var(--accent)',
              borderRadius: 8, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s',
              cursor: loading || !input.trim() || !hasApiKey ? 'not-allowed' : 'pointer',
            }}
          >
            {loading
              ? <Loader2 size={15} color="var(--text-muted)" style={{ animation: 'spin 1s linear infinite' }} />
              : <Send size={14} color={input.trim() && hasApiKey ? '#fff' : 'var(--text-muted)'} />}
          </button>
        </div>
      </div>

      {/* ── Global styles ── */}
      <style>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: scale(0.7); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .markdown-body p { margin: 0 0 8px 0; }
        .markdown-body p:last-child { margin-bottom: 0; }
        .markdown-body ul, .markdown-body ol { padding-left: 18px; margin: 6px 0; }
        .markdown-body li { margin: 2px 0; }
        .markdown-body code {
          background: rgba(255,255,255,0.08);
          padding: 1px 5px; border-radius: 4px;
          font-size: 12px; font-family: monospace;
        }
        .markdown-body pre {
          background: rgba(0,0,0,0.3); border-radius: 8px;
          padding: 10px; overflow-x: auto; margin: 8px 0;
        }
        .markdown-body pre code { background: none; padding: 0; }
        .markdown-body h1, .markdown-body h2, .markdown-body h3 {
          margin: 8px 0 4px 0; font-weight: 600;
        }
        .markdown-body a { color: var(--accent); text-decoration: none; }
        .markdown-body a:hover { text-decoration: underline; }
        .markdown-body blockquote {
          border-left: 3px solid var(--accent);
          padding-left: 10px; margin: 6px 0;
          color: var(--text-secondary);
        }
        .markdown-body hr { border: none; border-top: 1px solid var(--border); margin: 10px 0; }
        .markdown-body table { border-collapse: collapse; width: 100%; font-size: 12px; }
        .markdown-body th, .markdown-body td {
          border: 1px solid var(--border); padding: 4px 8px; text-align: left;
        }
        .markdown-body th { background: var(--bg-hover); }
      `}</style>
    </div>
  )
}
