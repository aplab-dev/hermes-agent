/**
 * THE BOARD — one LLM call at a time on a pan/zoom canvas, with the session's calls as a strip to
 * step through (◀ ▶, ← →, or click a cell). The call is laid out as one tall column: the wire prompt
 * top → bottom, then the model's thinking and output. Everything is expanded by default; the level
 * toolbar folds components by kind — system / user / assistant / tool results / thinking / output —
 * to "half" (a preview with an expand toggle) or "collapsed" (one line each), or all at once.
 * Messages byte-identical to the previous call carry a "same as prev" tag; the rest is highlighted.
 * Pan by drag / two-finger scroll, zoom by pinch / ⌘-wheel / ±, `0` fits width, `9` fits all. Text
 * stays real DOM: selectable, searchable at any zoom.
 */
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import type { ApiRequestFull } from '@/api/requests'
import { Codicon } from '@/components/ui/codicon'
import { compactNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

import {
  ALL_FULL,
  CallResponse,
  type Copy,
  fmtCost,
  fmtSecs,
  fmtTime,
  type Kind,
  KINDS,
  type Level,
  type Levels,
  MessageCard,
  withLevel
} from './cards'

const COL_WIDTH = 920
const PAD = 32
const MIN_SCALE = 0.1
const MAX_SCALE = 2.5
const LEVEL_ORDER: Level[] = ['full', 'half', 'min']

interface View {
  x: number
  y: number
  s: number
}

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

function levelLabel(level: Level, t: Copy): string {
  return level === 'full' ? t.levelFull : level === 'half' ? t.levelHalf : t.levelMin
}

function LevelToolbar({ levels, onChange, t }: { levels: Levels; onChange: (next: Levels) => void; t: Copy }) {
  const cycle = (kind: Kind) => {
    const next = LEVEL_ORDER[(LEVEL_ORDER.indexOf(levels[kind]) + 1) % LEVEL_ORDER.length]
    onChange({ ...levels, [kind]: next })
  }

  return (
    <div className="flex flex-wrap items-center gap-1 text-[0.6875rem]">
      <span className="text-(--ui-text-tertiary)">{t.all}:</span>
      {LEVEL_ORDER.map(level => (
        <button
          className={cn(
            'rounded border px-1.5 py-0.5',
            KINDS.every(k => levels[k] === level)
              ? 'border-primary/60 bg-primary/15 text-foreground'
              : 'border-(--ui-stroke-tertiary) text-(--ui-text-tertiary) hover:text-foreground'
          )}
          key={level}
          onClick={() => onChange(withLevel(level))}
          type="button"
        >
          {levelLabel(level, t)}
        </button>
      ))}
      <span className="mx-1 text-(--ui-stroke-secondary)">|</span>
      {KINDS.map(kind => (
        <button
          className={cn(
            'rounded border px-1.5 py-0.5',
            levels[kind] === 'full' && 'border-(--ui-stroke-tertiary) text-foreground',
            levels[kind] === 'half' && 'border-amber-500/50 bg-amber-500/10 text-foreground',
            levels[kind] === 'min' &&
              'border-(--ui-stroke-tertiary) bg-(--ui-control-hover-background) text-(--ui-text-tertiary) line-through'
          )}
          key={kind}
          onClick={() => cycle(kind)}
          title={`${t.kinds[kind]}: ${levelLabel(levels[kind], t)}`}
          type="button"
        >
          {t.kinds[kind]}
          <span className="ml-1 font-mono text-(--ui-text-quaternary)">
            {levels[kind] === 'full' ? '■' : levels[kind] === 'half' ? '◧' : '▭'}
          </span>
        </button>
      ))}
    </div>
  )
}

function CallStrip({
  calls,
  selectedId,
  onSelect,
  t
}: {
  calls: ApiRequestFull[]
  selectedId: null | number
  onSelect: (id: number) => void
  t: Copy
}) {
  const idx = calls.findIndex(c => c.id === selectedId)

  const go = (delta: number) => {
    const next = calls[Math.min(calls.length - 1, Math.max(0, idx + delta))]

    if (next) {
      onSelect(next.id)
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <button
        className="rounded p-1 hover:bg-accent disabled:opacity-30"
        disabled={idx <= 0}
        onClick={() => go(-1)}
        title={t.prev}
        type="button"
      >
        <Codicon name="chevron-left" size="0.8rem" />
      </button>
      <div className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto">
        {calls.map((c, i) => {
          const prompt = c.prompt_tokens ?? 0
          const hit = prompt > 0 && c.cache_read_tokens ? Math.round((c.cache_read_tokens / prompt) * 100) : null

          return (
            <button
              className={cn(
                'shrink-0 rounded border px-1.5 py-0.5 text-left font-mono text-[0.625rem] leading-tight tabular-nums',
                c.id === selectedId ? 'border-primary/60 bg-primary/15' : 'border-(--ui-stroke-tertiary) hover:bg-accent',
                c.status === 'error' && 'border-destructive/50'
              )}
              key={c.id}
              onClick={() => onSelect(c.id)}
              title={`#${i + 1} · ${fmtTime(c.started_at)} · ${compactNumber(prompt)}↑ ${compactNumber(c.output_tokens ?? 0)}↓ · ${fmtSecs(c.started_at, c.ended_at)} · ${fmtCost(c.cost_usd)}`}
              type="button"
            >
              <div>#{i + 1}</div>
              <div className="text-(--ui-text-tertiary)">
                {compactNumber(prompt)}
                {hit !== null ? `·${hit}%` : ''}
              </div>
            </button>
          )
        })}
      </div>
      <button
        className="rounded p-1 hover:bg-accent disabled:opacity-30"
        disabled={idx < 0 || idx >= calls.length - 1}
        onClick={() => go(1)}
        title={t.next}
        type="button"
      >
        <Codicon name="chevron-right" size="0.8rem" />
      </button>
    </div>
  )
}

function CallColumn({ call, index, levels, t }: { call: ApiRequestFull; index: number; levels: Levels; t: Copy }) {
  const messages = call.request?.messages ?? []
  const shared = Math.min(call.prefix_shared_msgs ?? 0, messages.length)
  const prompt = call.prompt_tokens ?? 0
  const cached = call.cache_read_tokens ?? 0
  const hit = prompt > 0 ? Math.round((cached / prompt) * 100) : null

  const cacheablePct =
    call.request_chars && call.prefix_shared_chars ? Math.round((call.prefix_shared_chars / call.request_chars) * 100) : null

  return (
    <div
      className="absolute top-0 flex flex-col gap-2 rounded-lg border border-(--ui-stroke-tertiary) bg-background p-4 shadow-sm"
      data-call-column={call.id}
      onPointerDown={e => e.stopPropagation()}
      style={{ left: PAD, width: COL_WIDTH }}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[1rem] font-semibold">#{index + 1}</span>
        <span className="text-[0.75rem] text-(--ui-text-tertiary)">{fmtTime(call.started_at)}</span>
        <span className="font-mono text-[0.75rem] tabular-nums text-(--ui-text-tertiary)">
          {call.model} · {compactNumber(prompt)}↑ · {compactNumber(call.output_tokens ?? 0)}↓ ·{' '}
          {fmtSecs(call.started_at, call.ended_at)}
          {call.first_chunk_at && call.started_at ? ` · ${t.ttfb} ${(call.first_chunk_at - call.started_at).toFixed(1)}s` : ''}
        </span>
        <span className="ml-auto font-mono text-[0.875rem] tabular-nums">
          {call.status === 'error' ? <span className="text-destructive">{t.err}</span> : fmtCost(call.cost_usd)}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem]">
        <span>
          <span className="text-(--ui-text-tertiary)">{t.cacheable}: </span>
          <span className="font-mono tabular-nums">
            {shared}/{messages.length} msgs · {compactNumber(call.prefix_shared_chars ?? 0)} {t.chars}
            {cacheablePct !== null && ` (${cacheablePct}%)`}
          </span>
        </span>
        <span>
          <span className="text-(--ui-text-tertiary)">{t.cacheHit}: </span>
          <span className={cn('font-mono tabular-nums', hit !== null && hit >= 50 && 'text-emerald-600 dark:text-emerald-400')}>
            {call.prompt_tokens === null
              ? t.noUsage
              : `${compactNumber(cached)} / ${compactNumber(prompt)} tok${hit !== null ? ` (${hit}%)` : ''}`}
          </span>
        </span>
        <span className="text-(--ui-text-tertiary)">
          {call.tool_count ?? 0} {t.tools}
          {call.request?.tools?.length ? `: ${call.request.tools.join(', ')}` : ''}
        </span>
      </div>

      <h3 className="mt-1 text-[0.8125rem] font-semibold">{t.request}</h3>
      <div className="flex flex-col gap-1.5">
        {messages.map((m, i) => (
          <div className="relative" key={i}>
            {shared > 0 && i < shared && (
              <span className="absolute top-1 right-2 z-10 rounded bg-(--ui-control-hover-background) px-1 text-[0.5625rem] uppercase tracking-wide text-(--ui-text-quaternary)">
                {t.same}
              </span>
            )}
            <MessageCard index={i} isNew={shared > 0 && i >= shared} levels={levels} msg={m} t={t} />
          </div>
        ))}
      </div>

      <div className="mt-2 border-t border-dashed border-(--ui-stroke-secondary) pt-2">
        <CallResponse call={call} levels={levels} t={t} />
      </div>
    </div>
  )
}

export function CallsBoard({
  calls,
  selectedId,
  onSelect,
  t
}: {
  calls: ApiRequestFull[]
  selectedId: null | number
  onSelect: (id: number) => void
  t: Copy
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ s: 0.8, x: PAD, y: PAD })
  const [levels, setLevels] = useState<Levels>(ALL_FULL)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const idx = calls.findIndex(c => c.id === selectedId)
  const call = idx >= 0 ? calls[idx] : calls[calls.length - 1]

  const contentSize = useCallback(() => {
    const col = contentRef.current?.querySelector<HTMLElement>('[data-call-column]')

    return { height: (col?.offsetHeight ?? 600) + PAD * 2, width: COL_WIDTH + PAD * 2 }
  }, [])

  /** Fit the column's WIDTH to the viewport (readable), scrolled to the top. */
  const fitWidth = useCallback(() => {
    const vp = viewportRef.current

    if (!vp) {
      return
    }

    const s = clampScale(Math.min((vp.clientWidth - 16) / (COL_WIDTH + PAD * 2), 1))
    setView({ s, x: (vp.clientWidth - (COL_WIDTH + PAD * 2) * s) / 2, y: 8 })
  }, [])

  /** Fit the WHOLE call (height included) — the bird's-eye view. */
  const fitAll = useCallback(() => {
    const vp = viewportRef.current

    if (!vp) {
      return
    }

    const { width, height } = contentSize()
    const s = clampScale(Math.min(vp.clientWidth / width, vp.clientHeight / height, 1))
    setView({ s, x: (vp.clientWidth - width * s) / 2, y: 8 })
  }, [contentSize])

  // A new call selected: back to the top at readable width (levels are kept).
  useLayoutEffect(() => {
    fitWidth()
  }, [fitWidth, call?.id])

  // Wheel: pinch / ⌘ / ctrl → zoom around the cursor; plain two-finger scroll → pan.
  useEffect(() => {
    const vp = viewportRef.current

    if (!vp) {
      return
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const v = viewRef.current

      if (e.ctrlKey || e.metaKey) {
        const rect = vp.getBoundingClientRect()
        const px = e.clientX - rect.left
        const py = e.clientY - rect.top
        const factor = Math.exp(-e.deltaY * 0.004)
        const s = clampScale(v.s * factor)
        const k = s / v.s
        setView({ s, x: px - (px - v.x) * k, y: py - (py - v.y) * k })
      } else {
        setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })
      }
    }

    vp.addEventListener('wheel', onWheel, { passive: false })

    return () => vp.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) {
      return
    }

    drag.current = { vx: view.x, vy: view.y, x: e.clientX, y: e.clientY }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current

    if (!d) {
      return
    }

    setView(v => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }))
  }

  const endDrag = () => {
    drag.current = null
  }

  const zoomBy = useCallback((factor: number) => {
    const vp = viewportRef.current
    const v = viewRef.current

    if (!vp) {
      return
    }

    const px = vp.clientWidth / 2
    const py = vp.clientHeight / 2
    const s = clampScale(v.s * factor)
    const k = s / v.s
    setView({ s, x: px - (px - v.x) * k, y: py - (py - v.y) * k })
  }, [])

  // Keys while the board has focus: ← → step calls, ± zoom, 0 fit width, 9 fit all.
  useEffect(() => {
    const vp = viewportRef.current

    if (!vp) {
      return
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /^(input|textarea)$/i.test(e.target.tagName)) {
        return
      }

      if (e.key === 'ArrowLeft' && idx > 0) {
        onSelect(calls[idx - 1].id)
      } else if (e.key === 'ArrowRight' && idx >= 0 && idx < calls.length - 1) {
        onSelect(calls[idx + 1].id)
      } else if (e.key === '+' || e.key === '=') {
        zoomBy(1.25)
      } else if (e.key === '-') {
        zoomBy(0.8)
      } else if (e.key === '0') {
        fitWidth()
      } else if (e.key === '9') {
        fitAll()
      } else {
        return
      }

      e.preventDefault()
    }

    vp.addEventListener('keydown', onKey)

    return () => vp.removeEventListener('keydown', onKey)
  }, [calls, idx, onSelect, zoomBy, fitWidth, fitAll])

  const transform: CSSProperties = useMemo(
    () => ({ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transformOrigin: '0 0' }),
    [view]
  )

  if (!call) {
    return null
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-1.5 border-b border-(--ui-stroke-tertiary) px-3 py-1.5">
        <CallStrip calls={calls} onSelect={onSelect} selectedId={call.id} t={t} />
        <LevelToolbar levels={levels} onChange={setLevels} t={t} />
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          className="absolute inset-0 cursor-grab touch-none select-none overflow-hidden bg-[radial-gradient(circle,var(--ui-stroke-tertiary)_1px,transparent_1px)] [background-size:24px_24px] outline-none active:cursor-grabbing"
          onPointerCancel={endDrag}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          ref={viewportRef}
          tabIndex={0}
        >
          <div className="absolute top-0 left-0 select-text will-change-transform" ref={contentRef} style={transform}>
            <CallColumn call={call} index={idx >= 0 ? idx : calls.length - 1} key={call.id} levels={levels} t={t} />
          </div>
        </div>

        <div className="absolute right-3 bottom-3 flex items-center gap-1 rounded-md border border-(--ui-stroke-tertiary) bg-background/90 p-1 text-[0.75rem] shadow-sm backdrop-blur">
          <button className="rounded px-1.5 py-0.5 hover:bg-accent" onClick={() => zoomBy(0.8)} title="−" type="button">
            <Codicon name="zoom-out" size="0.8rem" />
          </button>
          <span className="w-10 text-center font-mono tabular-nums">{Math.round(view.s * 100)}%</span>
          <button className="rounded px-1.5 py-0.5 hover:bg-accent" onClick={() => zoomBy(1.25)} title="+" type="button">
            <Codicon name="zoom-in" size="0.8rem" />
          </button>
          <button className="rounded px-1.5 py-0.5 hover:bg-accent" onClick={fitWidth} title="0" type="button">
            <Codicon name="screen-normal" size="0.8rem" />
          </button>
          <button className="rounded px-1.5 py-0.5 hover:bg-accent" onClick={fitAll} title="9" type="button">
            <Codicon name="screen-full" size="0.8rem" />
          </button>
          <span className="ml-1 pr-1 text-(--ui-text-quaternary)">{t.boardHint}</span>
        </div>
      </div>
    </div>
  )
}
