/**
 * THE BOARD — a Miro-style infinite canvas of one session's LLM calls. Every API call is a column
 * (left → right = time); inside a column the wire prompt is stacked top → bottom, then the model's
 * thinking and output. Messages byte-identical to the previous call (the cacheable prefix) are
 * drawn as thin ghost bars, so the prompt's growth — what each call actually added — is the shape
 * you see. Pan with a two-finger scroll / drag on the background, zoom with pinch / ⌘-wheel / ± keys,
 * `0` fits everything. Text stays real DOM: selectable, foldable, searchable at any zoom.
 */
import { type CSSProperties, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { ApiRequestFull, WireMessage } from '@/api/requests'
import { Codicon } from '@/components/ui/codicon'
import { compactNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

import { CallResponse, type Copy, fmtCost, fmtSecs, fmtTime, MessageCard, wireText } from './cards'

const COL_WIDTH = 560
const COL_GAP = 48
const PAD = 40
const MIN_SCALE = 0.08
const MAX_SCALE = 2.5

interface View {
  x: number
  y: number
  s: number
}

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

function GhostBar({ msg, index, chars }: { msg: WireMessage; index: number; chars: number }) {
  const role = msg.role || '?'

  return (
    <div
      className="flex h-5 items-center gap-2 rounded-sm border-l-[3px] border-l-(--ui-stroke-secondary) bg-(--ui-control-hover-background) px-2 text-[0.625rem] uppercase tracking-wide text-(--ui-text-quaternary)"
      title={wireText(msg.content).slice(0, 200)}
    >
      <span className="font-semibold">{role}</span>
      {msg.tool_calls?.length ? <span className="normal-case">{msg.tool_calls.map(t => t.function?.name).join(', ')}</span> : null}
      <span className="ml-auto font-mono normal-case tabular-nums">
        #{index + 1} · {compactNumber(chars)}
      </span>
    </div>
  )
}

function CallColumn({
  call,
  index,
  selected,
  onSelect,
  t
}: {
  call: ApiRequestFull
  index: number
  selected: boolean
  onSelect: () => void
  t: Copy
}) {
  const messages = call.request?.messages ?? []
  const shared = Math.min(call.prefix_shared_msgs ?? 0, messages.length)
  const prompt = call.prompt_tokens ?? 0
  const cached = call.cache_read_tokens ?? 0
  const hit = prompt > 0 ? Math.round((cached / prompt) * 100) : null
  const [expandPrefix, setExpandPrefix] = useState(false)

  return (
    <div
      className={cn(
        'absolute top-0 flex flex-col gap-2 rounded-lg border bg-background p-3 shadow-sm',
        selected ? 'border-primary/60 ring-2 ring-primary/30' : 'border-(--ui-stroke-tertiary)'
      )}
      data-call-column={call.id}
      onPointerDown={e => e.stopPropagation()}
      style={{ left: PAD + index * (COL_WIDTH + COL_GAP), width: COL_WIDTH }}
    >
      <button className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-left" onClick={onSelect} type="button">
        <span className="font-mono text-[0.875rem] font-semibold">#{index + 1}</span>
        <span className="text-[0.6875rem] text-(--ui-text-tertiary)">{fmtTime(call.started_at)}</span>
        <span className="font-mono text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)">
          {compactNumber(prompt)}↑{hit !== null ? ` (${hit}% ${t.cached})` : ''} · {compactNumber(call.output_tokens ?? 0)}↓ ·{' '}
          {fmtSecs(call.started_at, call.ended_at)}
        </span>
        <span className="ml-auto font-mono text-[0.75rem] tabular-nums">
          {call.status === 'error' ? <span className="text-destructive">{t.err}</span> : fmtCost(call.cost_usd)}
        </span>
      </button>
      <div className="text-[0.6875rem] text-(--ui-text-tertiary)">
        {call.model} · {messages.length} msgs · {call.finish_reason ?? call.status}
        {shared > 0 && (
          <>
            {' · '}
            <button className="underline-offset-2 hover:underline" onClick={() => setExpandPrefix(v => !v)} type="button">
              {t.prefixNote(shared, call.prefix_shared_chars ?? 0)}
            </button>
          </>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        {messages.map((m, i) => {
          const isShared = i < shared

          if (isShared && !expandPrefix) {
            return <GhostBar chars={wireText(m.content).length} index={i} key={i} msg={m} />
          }

          return (
            <div className={cn(isShared && 'opacity-60')} key={i}>
              <MessageCard index={i} isNew={shared > 0 && !isShared} msg={m} t={t} />
            </div>
          )
        })}
      </div>

      <div className="mt-1 border-t border-dashed border-(--ui-stroke-secondary) pt-2">
        <CallResponse call={call} t={t} />
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
  const [view, setView] = useState<View>({ s: 0.5, x: PAD, y: PAD })
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view

  const contentSize = useCallback(() => {
    const el = contentRef.current
    // Columns are absolutely positioned: width from the column count, height from the tallest one.
    const width = PAD * 2 + calls.length * (COL_WIDTH + COL_GAP)
    let height = 0

    if (el) {
      for (const col of el.querySelectorAll<HTMLElement>('[data-call-column]')) {
        height = Math.max(height, col.offsetHeight)
      }
    }

    return { height: height + PAD * 2, width }
  }, [calls.length])

  const fit = useCallback(() => {
    const vp = viewportRef.current

    if (!vp) {
      return
    }

    const { width, height } = contentSize()
    const s = clampScale(Math.min(vp.clientWidth / width, vp.clientHeight / height, 1))
    setView({ s, x: (vp.clientWidth - width * s) / 2, y: 8 })
  }, [contentSize])

  // Center the selected column at a readable zoom (keeps the current zoom if it is readable already).
  const focusColumn = useCallback(
    (id: number) => {
      const vp = viewportRef.current
      const idx = calls.findIndex(c => c.id === id)

      if (!vp || idx < 0) {
        return
      }

      const s = Math.max(viewRef.current.s, 0.6)
      const colX = PAD + idx * (COL_WIDTH + COL_GAP)
      setView({ s, x: (vp.clientWidth - COL_WIDTH * s) / 2 - colX * s, y: 8 })
    },
    [calls]
  )

  useLayoutEffect(() => {
    // First paint: fit the whole session, then glide onto the selected call.
    fit()

    if (selectedId !== null) {
      focusColumn(selectedId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial placement only
  }, [calls.length])

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

  const zoomBy = (factor: number) => {
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
  }

  // ± / 0 while the board is hovered or focused.
  useEffect(() => {
    const vp = viewportRef.current

    if (!vp) {
      return
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /^(input|textarea)$/i.test(e.target.tagName)) {
        return
      }

      if (e.key === '+' || e.key === '=') {
        zoomBy(1.25)
      } else if (e.key === '-') {
        zoomBy(0.8)
      } else if (e.key === '0') {
        fit()
      }
    }

    vp.addEventListener('keydown', onKey)

    return () => vp.removeEventListener('keydown', onKey)
     
  }, [fit])

  const transform: CSSProperties = useMemo(
    () => ({ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transformOrigin: '0 0' }),
    [view]
  )

  return (
    <div className="relative h-full min-h-0 w-full">
      <div
        className="absolute inset-0 cursor-grab touch-none select-none overflow-hidden bg-[radial-gradient(circle,var(--ui-stroke-tertiary)_1px,transparent_1px)] [background-size:24px_24px] active:cursor-grabbing"
        onPointerCancel={endDrag}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        ref={viewportRef}
        tabIndex={0}
      >
        <div className="absolute top-0 left-0 select-text will-change-transform" ref={contentRef} style={transform}>
          {calls.map((call, i) => (
            <CallColumn call={call} index={i} key={call.id} onSelect={() => { onSelect(call.id); focusColumn(call.id) }} selected={call.id === selectedId} t={t} />
          ))}
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
        <button className="rounded px-1.5 py-0.5 hover:bg-accent" onClick={fit} title="0" type="button">
          <Codicon name="screen-full" size="0.8rem" />
        </button>
        <span className="ml-1 pr-1 text-(--ui-text-quaternary)">{t.boardHint}</span>
      </div>
    </div>
  )
}
