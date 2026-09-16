/**
 * LLM CALLS — one session's API requests as a canvas, beside the chat. Left: the list of calls
 * (tokens, prefix-cache hit, latency, cost). Right: the selected call as one long scrollable column —
 * every message exactly as it went on the wire, the prefix shared with the previous call folded into
 * one bar, new messages highlighted, then the model's thinking, then its output.
 *
 * Data: the request_log plugin (HERMES_HOME/requests.db) through /api/requests/*. The session comes
 * from `$callsSessionId` (set by whoever opens the page: the per-reply cost badge, the session menu)
 * and falls back to the active chat session.
 */
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect, useMemo, useState } from 'react'

import { type ApiRequestFull, listSessionRequestsFull } from '@/api/requests'
import { useI18n } from '@/i18n'
import { compactNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { openRouteTile } from '@/store/route-tiles'
import { $activeSessionId } from '@/store/session'

import { CALLS_ROUTE } from '../routes'

import { CallsBoard } from './board'
import { CallCanvas, COPY, fmtCost, fmtSecs, fmtTime } from './cards'

/** Session whose calls the page shows; null = follow the active chat session. */
export const $callsSessionId = atom<null | string>(null)
/** 1-based index (session order) of the call to select on open — the per-reply badge passes the
 *  reply's last call; consumed once. */
export const $callsFocusIndex = atom<null | number>(null)

/** Open the calls canvas beside the chat for `sessionId`, focused on call #`index` (session order). */
export function openCallsCanvas(sessionId: string, index?: number): void {
  $callsSessionId.set(sessionId)
  $callsFocusIndex.set(index ?? null)
  openRouteTile(CALLS_ROUTE)
}

export function CallsView() {
  const { locale } = useI18n()
  const t = COPY[locale === 'ru' ? 'ru' : 'en']
  const pinned = useStore($callsSessionId)
  const active = useStore($activeSessionId)
  const sessionId = pinned ?? active
  const [calls, setCalls] = useState<ApiRequestFull[] | null>(null)
  const [stats, setStats] = useState<Record<string, null | number>>({})
  const [selectedId, setSelectedId] = useState<null | number>(null)
  const [mode, setMode] = useState<'board' | 'list'>('board')
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    if (!sessionId) {
      return
    }

    let cancelled = false
    setCalls(null)
    setSelectedId(null)
    setError(null)

    listSessionRequestsFull(sessionId)
      .then(data => {
        if (cancelled) {
          return
        }

        setCalls(data.requests)
        setStats(data.stats ?? {})

        const focus = $callsFocusIndex.get()
        $callsFocusIndex.set(null)
        const target = focus !== null ? data.requests[focus - 1] : undefined
        setSelectedId(target?.id ?? data.requests[data.requests.length - 1]?.id ?? null)
      })
      .catch(e => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
        }
      })

    return () => {
      cancelled = true
    }
  }, [sessionId])

  const totals = useMemo(() => {
    const prompt = Number(stats.prompt ?? 0)
    const cached = Number(stats.cached ?? 0)

    return {
      n: Number(stats.n ?? calls?.length ?? 0),
      prompt,
      hit: prompt > 0 ? Math.round((cached / prompt) * 100) : null,
      out: Number(stats.out ?? 0),
      cost: Number(stats.cost ?? 0),
      secs: Number(stats.secs ?? 0)
    }
  }, [stats, calls])

  const selected = calls?.find(c => c.id === selectedId) ?? null

  if (!sessionId) {
    return <div className="grid h-full place-items-center p-6 text-[0.8125rem] text-(--ui-text-tertiary)">{t.noSession}</div>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-(--ui-stroke-tertiary) px-3 py-2 text-[0.75rem] text-(--ui-text-tertiary)">
        <span className="font-semibold text-foreground">{t.title}</span>
        <span className="font-mono">{sessionId}</span>
        {calls && calls.length > 0 && (
          <span className="font-mono tabular-nums">
            {totals.n} {t.calls} · {t.prompt} {compactNumber(totals.prompt)}
            {totals.hit !== null && ` (${totals.hit}% ${t.cached})`} · {t.out} {compactNumber(totals.out)} · {fmtCost(totals.cost)} ·{' '}
            {totals.secs.toFixed(0)}s
          </span>
        )}
        <div className="ml-auto flex overflow-hidden rounded-md border border-(--ui-stroke-tertiary)">
          {(['board', 'list'] as const).map(m => (
            <button
              className={cn('px-2 py-0.5', mode === m ? 'bg-primary/15 text-foreground' : 'hover:bg-accent')}
              key={m}
              onClick={() => setMode(m)}
              type="button"
            >
              {m === 'board' ? t.board : t.list}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="p-3 text-[0.8125rem] text-destructive">{error}</p>}
      {calls === null && !error && <div className="p-6 text-[0.8125rem] text-(--ui-text-tertiary)">…</div>}
      {calls && calls.length === 0 && <p className="p-6 text-[0.8125rem] text-(--ui-text-tertiary)">{t.empty}</p>}

      {calls && calls.length > 0 && mode === 'board' && (
        <div className="min-h-0 flex-1">
          <CallsBoard calls={calls} onSelect={setSelectedId} selectedId={selectedId} t={t} />
        </div>
      )}

      {calls && calls.length > 0 && mode === 'list' && (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(11rem,15rem)_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto border-r border-(--ui-stroke-tertiary)">
            {calls.map(r => {
              const prompt = r.prompt_tokens ?? 0
              const hit = prompt > 0 && r.cache_read_tokens ? Math.round((r.cache_read_tokens / prompt) * 100) : null

              return (
                <button
                  className={cn(
                    'block w-full border-b border-(--ui-stroke-tertiary) px-3 py-2 text-left text-[0.75rem] hover:bg-(--ui-control-hover-background)',
                    r.id === selectedId && 'bg-primary/10'
                  )}
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  type="button"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold">#{r.call_no ?? r.id}</span>
                    <span className="text-(--ui-text-tertiary)">{fmtTime(r.started_at)}</span>
                    <span className="ml-auto font-mono tabular-nums">
                      {r.status === 'error' ? <span className="text-destructive">{t.err}</span> : fmtCost(r.cost_usd)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)">
                    <span>
                      {compactNumber(r.prompt_tokens ?? 0)}↑{hit !== null ? ` (${hit}%)` : ''}
                    </span>
                    <span>{compactNumber(r.output_tokens ?? 0)}↓</span>
                    <span>{fmtSecs(r.started_at, r.ended_at)}</span>
                    <span>{r.finish_reason ?? (r.status === 'pending' ? t.pending : '')}</span>
                  </div>
                </button>
              )
            })}
          </div>
          <div className="min-h-0 overflow-y-auto p-3">
            {selected ? <CallCanvas call={selected} t={t} /> : <div className="p-3 text-(--ui-text-tertiary)">…</div>}
          </div>
        </div>
      )}
    </div>
  )
}
