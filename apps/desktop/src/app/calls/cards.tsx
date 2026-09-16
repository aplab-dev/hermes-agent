/**
 * Building blocks shared by the calls list view and the board: message cards exactly as they went on
 * the wire, the response block (thinking → output → tool calls), formatting helpers and the copy table.
 */
import { type ReactNode, useState } from 'react'

import type { ApiRequestFull, WireMessage } from '@/api/requests'
import { MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { Codicon } from '@/components/ui/codicon'
import { compactNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

export function fmtCost(v: null | number | undefined): string {
  if (v === null || v === undefined) {
    return '—'
  }

  if (v === 0) {
    return '$0'
  }

  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(3)}`
}

export function fmtSecs(a: null | number, b: null | number): string {
  return a && b ? `${(b - a).toFixed(1)}s` : '—'
}

export function fmtTime(ts: null | number): string {
  return ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''
}

export function wireText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') {
          return part
        }

        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>

          if (typeof p.text === 'string') {
            return p.text
          }

          return p.type === 'image_url' ? '[image]' : JSON.stringify(p)
        }

        return String(part)
      })
      .join('\n')
  }

  return content === null || content === undefined ? '' : JSON.stringify(content, null, 2)
}

function prettyMaybeJson(text: string): string {
  const trimmed = text.trim()

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return text
  }

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return text
  }
}

/** Hermes' untrusted envelope around fetched content: show it as a one-line note, pretty-print the payload. */
function unwrapUntrusted(text: string): { envelope: null | string; body: string } {
  const m = text.match(/^\s*<untrusted_tool_result\b[^>]*>\s*/)

  if (!m) {
    return { envelope: null, body: text }
  }

  const end = text.lastIndexOf('</untrusted_tool_result>')
  const inner = text.slice(m[0].length, end > 0 ? end : undefined).trim()
  const split = inner.indexOf('\n\n')

  return { envelope: split >= 0 ? inner.slice(0, split) : '', body: split >= 0 ? inner.slice(split + 2).trim() : inner }
}

const ROLE_CLASS: Record<string, string> = {
  assistant: 'border-l-emerald-500/70 bg-emerald-500/5',
  developer: 'border-l-(--ui-text-quaternary) bg-(--ui-control-hover-background)',
  system: 'border-l-(--ui-text-quaternary) bg-(--ui-control-hover-background)',
  tool: 'border-l-amber-500/70 bg-amber-500/5',
  user: 'border-l-primary bg-primary/5'
}

function Fold({
  title,
  meta,
  defaultOpen,
  children
}: {
  title: ReactNode
  meta?: ReactNode
  defaultOpen: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div>
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-[0.75rem] text-(--ui-text-tertiary) hover:text-foreground"
        onClick={() => setOpen(v => !v)}
        type="button"
      >
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} size="0.75rem" />
        <span className="font-medium">{title}</span>
        {meta && <span className="ml-auto shrink-0 font-mono text-[0.6875rem] tabular-nums">{meta}</span>}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  )
}

function LongText({ text, mono, maxChars = 4000 }: { text: string; mono?: boolean; maxChars?: number }) {
  const [full, setFull] = useState(false)
  const shown = full || text.length <= maxChars ? text : text.slice(0, maxChars)

  return (
    <div>
      <pre
        className={cn(
          'whitespace-pre-wrap break-words text-[0.75rem] leading-relaxed text-foreground/90',
          mono ? 'font-mono' : 'font-sans'
        )}
      >
        {shown}
        {!full && text.length > maxChars && '…'}
      </pre>
      {text.length > maxChars && (
        <button className="mt-1 text-[0.75rem] text-primary hover:underline" onClick={() => setFull(v => !v)} type="button">
          {full ? '▲' : `▼ +${compactNumber(text.length - maxChars)}`}
        </button>
      )}
    </div>
  )
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="text-[0.8125rem]">
      <MarkdownTextContent isRunning={false} text={text} />
    </div>
  )
}

function ToolCallCard({ name, args }: { name?: string; args?: string }) {
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[0.75rem]">
      <span className="font-mono font-medium text-amber-600 dark:text-amber-400">{name}</span>
      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[0.6875rem] text-foreground/80">
        {prettyMaybeJson(args ?? '')}
      </pre>
    </div>
  )
}

export function MessageCard({ msg, index, isNew, t }: { msg: WireMessage; index: number; isNew: boolean; t: Copy }) {
  const role = msg.role || '?'
  const text = wireText(msg.content)
  const isSystem = role === 'system' || role === 'developer'
  const isTool = role === 'tool'

  return (
    <div
      className={cn(
        'rounded-md border-l-[3px] px-3 py-2',
        ROLE_CLASS[role] ?? 'border-l-(--ui-stroke-secondary) bg-(--ui-control-hover-background)',
        isNew && 'ring-1 ring-primary/40'
      )}
    >
      <div className="mb-1 flex items-center gap-2 text-[0.625rem] uppercase tracking-wide text-(--ui-text-tertiary)">
        <span className="font-semibold">{role}</span>
        {msg.name && <span className="font-mono normal-case">{msg.name}</span>}
        {msg.tool_call_id && <span className="font-mono normal-case">{msg.tool_call_id}</span>}
        <span className="ml-auto font-mono normal-case tabular-nums">
          #{index + 1} · {compactNumber(text.length)} {t.chars}
        </span>
        {isNew && <span className="rounded bg-primary/15 px-1.5 py-0.5 normal-case text-primary">{t.newSince}</span>}
      </div>

      {isSystem ? (
        <Fold defaultOpen={false} meta={`${compactNumber(text.length)} ${t.chars}`} title={t.system}>
          <LongText maxChars={6000} mono text={text} />
        </Fold>
      ) : isTool ? (
        <ToolResult text={text} />
      ) : (
        <>
          {msg.reasoning_content?.trim() && (
            <Fold defaultOpen={false} meta={`${compactNumber(msg.reasoning_content.length)} ${t.chars}`} title={t.thinking}>
              <LongText text={msg.reasoning_content} />
            </Fold>
          )}
          {text && <Markdown text={text} />}
          {msg.tool_calls && msg.tool_calls.length > 0 && (
            <div className="mt-2 space-y-1">
              {msg.tool_calls.map((tc, i) => (
                <ToolCallCard args={tc.function?.arguments} key={tc.id ?? i} name={tc.function?.name} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ToolResult({ text }: { text: string }) {
  const { envelope, body } = unwrapUntrusted(text)

  return (
    <div className="space-y-1">
      {envelope !== null && (
        <div className="text-[0.6875rem] italic text-(--ui-text-tertiary)">⟨untrusted_tool_result⟩ {envelope.slice(0, 140)}…</div>
      )}
      <LongText maxChars={3000} mono text={prettyMaybeJson(body)} />
    </div>
  )
}

export function CallCanvas({ call, t }: { call: ApiRequestFull; t: Copy }) {
  const [showShared, setShowShared] = useState(false)
  const messages = call.request?.messages ?? []
  const shared = Math.min(call.prefix_shared_msgs ?? 0, messages.length)
  const folded = shared > 1 && !showShared
  const visible = folded ? messages.slice(shared) : messages
  const prompt = call.prompt_tokens ?? 0
  const cached = call.cache_read_tokens ?? 0
  const hitPct = prompt > 0 ? Math.round((cached / prompt) * 100) : null

  const cacheablePct =
    call.request_chars && call.prefix_shared_chars ? Math.round((call.prefix_shared_chars / call.request_chars) * 100) : null

  const outText = wireText(call.response?.content ?? '')

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-control-hover-background) px-3 py-2 text-[0.75rem]">
        <span>
          <span className="text-(--ui-text-tertiary)">{t.cacheable}: </span>
          <span className="font-mono tabular-nums">
            {call.prefix_shared_msgs ?? 0}/{call.message_count ?? messages.length} msgs · {compactNumber(call.prefix_shared_chars ?? 0)} {t.chars}
            {cacheablePct !== null && ` (${cacheablePct}%)`}
          </span>
        </span>
        <span>
          <span className="text-(--ui-text-tertiary)">{t.cacheHit}: </span>
          <span className={cn('font-mono tabular-nums', hitPct !== null && hitPct >= 50 && 'text-emerald-600 dark:text-emerald-400')}>
            {call.prompt_tokens === null
              ? t.noUsage
              : `${compactNumber(cached)} / ${compactNumber(prompt)} tok${hitPct !== null ? ` (${hitPct}%)` : ''}`}
          </span>
        </span>
        <span>
          <span className="text-(--ui-text-tertiary)">{t.latency}: </span>
          <span className="font-mono tabular-nums">
            {fmtSecs(call.started_at, call.ended_at)}
            {call.first_chunk_at && call.started_at ? ` · ${t.ttfb} ${(call.first_chunk_at - call.started_at).toFixed(1)}s` : ''}
          </span>
        </span>
        <span className="ml-auto font-mono tabular-nums">{fmtCost(call.cost_usd)}</span>
      </div>

      <h3 className="text-[0.8125rem] font-semibold">{t.request}</h3>
      <div className="text-[0.75rem] text-(--ui-text-tertiary)">
        {call.model} · {messages.length} msgs · {call.tool_count ?? 0} {t.tools}
        {call.request?.tools?.length ? `: ${call.request.tools.join(', ')}` : ''}
        {call.request?.extra && Object.keys(call.request.extra).length > 0 && (
          <Fold defaultOpen={false} title={t.extra}>
            <pre className="whitespace-pre-wrap break-words font-mono text-[0.6875rem]">{JSON.stringify(call.request.extra, null, 2)}</pre>
          </Fold>
        )}
      </div>

      {shared > 1 && (
        <button
          className="flex w-full items-center gap-2 rounded-md border border-dashed border-(--ui-stroke-secondary) bg-(--ui-control-hover-background) px-3 py-2 text-left text-[0.75rem] text-(--ui-text-tertiary) hover:text-foreground"
          onClick={() => setShowShared(v => !v)}
          type="button"
        >
          <Codicon name={folded ? 'chevron-right' : 'chevron-down'} size="0.75rem" />
          {folded ? `${t.sharedBar(shared, call.prefix_shared_chars ?? 0)} — ${t.showShared}` : t.hideShared}
        </button>
      )}

      <div className="space-y-2">
        {visible.map((m, i) => {
          const index = folded ? shared + i : i

          return <MessageCard index={index} isNew={shared > 0 && index >= shared} key={index} msg={m} t={t} />
        })}
      </div>

      <CallResponse call={call} t={t} />
    </div>
  )
}

/** Thinking → output → tool calls of one call. */
export function CallResponse({ call, t }: { call: ApiRequestFull; t: Copy }) {
  const outText = wireText(call.response?.content ?? '')

  return (
    <div className="space-y-3">
      <h3 className="pt-1 text-[0.8125rem] font-semibold">
        {t.response}{' '}
        <span className="font-normal text-(--ui-text-tertiary)">
          · {compactNumber(call.output_tokens ?? 0)} tok
          {call.reasoning_tokens ? ` (${compactNumber(call.reasoning_tokens)} thinking)` : ''} · {call.finish_reason ?? call.status}
        </span>
      </h3>
      {call.status === 'error' && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[0.75rem] text-destructive">
          {call.error}
        </div>
      )}
      {call.response?.reasoning && (
        <div className="rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-control-hover-background) px-3 py-2">
          <Fold defaultOpen meta={`${compactNumber(call.response.reasoning.length)} ${t.chars}`} title={t.thinking}>
            <LongText maxChars={8000} text={call.response.reasoning} />
          </Fold>
        </div>
      )}
      {outText && (
        <div className="rounded-md border-l-[3px] border-l-emerald-500/70 bg-emerald-500/5 px-3 py-2">
          <div className="mb-1 text-[0.625rem] uppercase tracking-wide text-(--ui-text-tertiary)">{t.output}</div>
          <Markdown text={outText} />
        </div>
      )}
      {call.response?.tool_calls && call.response.tool_calls.length > 0 && (
        <div className="space-y-1">
          <div className="text-[0.625rem] uppercase tracking-wide text-(--ui-text-tertiary)">{t.toolCalls}</div>
          {call.response.tool_calls.map((tc, i) => (
            <ToolCallCard args={tc.arguments} key={tc.id ?? i} name={tc.name} />
          ))}
        </div>
      )}
    </div>
  )
}

export interface Copy {
  title: string
  empty: string
  noSession: string
  calls: string
  prompt: string
  cached: string
  out: string
  thinking: string
  output: string
  request: string
  response: string
  sharedBar: (n: number, chars: number) => string
  showShared: string
  hideShared: string
  newSince: string
  tools: string
  system: string
  chars: string
  latency: string
  ttfb: string
  cacheHit: string
  cacheable: string
  noUsage: string
  err: string
  pending: string
  toolCalls: string
  extra: string
  board: string
  list: string
  boardHint: string
  prefixNote: (n: number, chars: number) => string
}

export const COPY: Record<'en' | 'ru', Copy> = {
  en: {
    title: 'LLM calls',
    empty: 'No calls logged for this session yet (plugin observability/request_log records every API call from now on).',
    noSession: 'Open a session to see its LLM calls.',
    calls: 'calls',
    prompt: 'prompt',
    cached: 'cached',
    out: 'out',
    thinking: 'Thinking',
    output: 'Output',
    request: 'Request — exactly what went to the model',
    response: 'Response',
    sharedBar: (n, chars) => `${n} messages identical to the previous call (cacheable prefix, ${compactNumber(chars)} chars)`,
    showShared: 'show',
    hideShared: 'Fold the shared prefix',
    newSince: 'new since previous call',
    tools: 'tools',
    system: 'system prompt',
    chars: 'chars',
    latency: 'latency',
    ttfb: 'first token',
    cacheHit: 'served from cache by the provider',
    cacheable: 'identical to previous call',
    noUsage: 'no usage reported',
    err: 'error',
    pending: 'pending',
    toolCalls: 'Tool calls',
    extra: 'request parameters',
    board: 'Board',
    list: 'List',
    boardHint: 'drag · scroll = pan · ⌘/pinch = zoom · 0 = fit',
    prefixNote: (n, chars) => `${n} msgs / ${compactNumber(chars)} chars same as previous call`
  },
  ru: {
    title: 'Вызовы LLM',
    empty: 'Для этой сессии вызовы ещё не записаны (плагин observability/request_log пишет каждый вызов с этого момента).',
    noSession: 'Открой сессию, чтобы увидеть её вызовы LLM.',
    calls: 'вызовов',
    prompt: 'prompt',
    cached: 'из кэша',
    out: 'ответ',
    thinking: 'Thinking',
    output: 'Ответ модели',
    request: 'Запрос — ровно то, что ушло в модель',
    response: 'Ответ',
    sharedBar: (n, chars) => `${n} сообщений совпадают с прошлым вызовом (кэшируемый префикс, ${compactNumber(chars)} символов)`,
    showShared: 'показать',
    hideShared: 'Свернуть общий префикс',
    newSince: 'новое с прошлого вызова',
    tools: 'тулов',
    system: 'системный промпт',
    chars: 'символов',
    latency: 'время',
    ttfb: 'первый токен',
    cacheHit: 'провайдер отдал из кэша',
    cacheable: 'совпало с прошлым вызовом',
    noUsage: 'usage не пришёл',
    err: 'ошибка',
    pending: 'в работе',
    toolCalls: 'Вызовы тулов',
    extra: 'параметры запроса',
    board: 'Доска',
    list: 'Список',
    boardHint: 'тянуть · скролл = панорама · ⌘/щипок = зум · 0 = вписать',
    prefixNote: (n, chars) => `${n} сообщ. / ${compactNumber(chars)} симв. как в прошлом вызове`
  }
}

