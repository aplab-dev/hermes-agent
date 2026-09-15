/**
 * LLM calls of one session (request_log plugin): the list of API calls on the left, and on the right
 * the selected call as one long canvas — every message exactly as it went on the wire, then the
 * model's thinking, then its output. Messages shared with the previous call (the cacheable prefix)
 * fold into one bar so the eye lands on what was NEW for this call.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ChevronDown, ChevronRight } from "lucide-react";

import { fetchJSON } from "@/lib/api";
import { Markdown } from "@/components/Markdown";
import { Button } from "@nous-research/ui/ui/components/button";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { useI18n } from "@/i18n";
import { usePageHeader } from "@/contexts/usePageHeader";

export interface ApiRequestRow {
  id: number;
  api_request_id: string;
  session_id: string;
  turn_id: string | null;
  call_no: number | null;
  started_at: number | null;
  ended_at: number | null;
  first_chunk_at: number | null;
  model: string | null;
  provider: string | null;
  api_mode: string | null;
  finish_reason: string | null;
  status: "pending" | "ok" | "error";
  error: string | null;
  prompt_tokens: number | null;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: number | null;
  cost_status: string | null;
  request_chars: number | null;
  message_count: number | null;
  tool_count: number | null;
  prefix_shared_msgs: number | null;
  prefix_shared_chars: number | null;
}

interface WireMessage {
  role: string;
  content?: unknown;
  reasoning_content?: string;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
  name?: string;
}

interface ApiRequestFull extends ApiRequestRow {
  request: { messages: WireMessage[]; tools: string[]; extra: Record<string, unknown> } | null;
  response: {
    content: string | unknown[] | null;
    reasoning: string;
    tool_calls: { id?: string; name?: string; arguments?: string }[];
  } | null;
}

const STR = {
  en: {
    title: "LLM calls",
    back: "Back to sessions",
    empty: "No calls logged for this session. Enable the plugin: plugins.enabled: [observability/request_log].",
    calls: "calls",
    prompt: "prompt",
    cached: "cached",
    out: "out",
    thinking: "Thinking",
    output: "Output",
    request: "Request — what went on the wire",
    response: "Response",
    sharedBar: (n: number, chars: number) => `${n} messages identical to the previous call (cacheable prefix, ${fmtK(chars)} chars)`,
    showShared: "Show shared prefix",
    hideShared: "Fold shared prefix",
    newSince: "new since previous call",
    tools: "tools",
    system: "system prompt",
    chars: "chars",
    latency: "latency",
    ttfb: "first token",
    cacheHit: "served from cache by provider",
    cacheable: "identical to previous call",
    noUsage: "no usage reported",
    err: "error",
    pending: "pending",
    toolCalls: "Tool calls",
    extra: "request parameters",
  },
  ru: {
    title: "Вызовы LLM",
    back: "К сессиям",
    empty: "Для этой сессии вызовы не записаны. Включи плагин: plugins.enabled: [observability/request_log].",
    calls: "вызовов",
    prompt: "prompt",
    cached: "из кэша",
    out: "ответ",
    thinking: "Thinking",
    output: "Ответ модели",
    request: "Запрос — ровно то, что ушло в модель",
    response: "Ответ",
    sharedBar: (n: number, chars: number) => `${n} сообщений совпадают с прошлым вызовом (кэшируемый префикс, ${fmtK(chars)} символов)`,
    showShared: "Показать общий префикс",
    hideShared: "Свернуть общий префикс",
    newSince: "новое с прошлого вызова",
    tools: "тулов",
    system: "системный промпт",
    chars: "символов",
    latency: "время",
    ttfb: "первый токен",
    cacheHit: "провайдер отдал из кэша",
    cacheable: "совпало с прошлым вызовом",
    noUsage: "usage не пришёл",
    err: "ошибка",
    pending: "в работе",
    toolCalls: "Вызовы тулов",
    extra: "параметры запроса",
  },
} as const;

function fmtK(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v === 0) return "$0";
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(3)}`;
}

function fmtSecs(a: number | null, b: number | null): string {
  if (!a || !b) return "—";
  return `${(b - a).toFixed(1)}s`;
}

function fmtTime(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
          if (p.type === "image_url") return "[image]";
          return JSON.stringify(p);
        }
        return String(part);
      })
      .join("\n");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content, null, 2);
}

function prettyMaybeJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

/** Tool results wrapped in Hermes' untrusted envelope: keep the envelope visible but pretty-print the payload. */
function unwrapUntrusted(text: string): { envelope: string | null; body: string } {
  const m = text.match(/^\s*<untrusted_tool_result\b[^>]*>\s*/);
  if (!m) return { envelope: null, body: text };
  const end = text.lastIndexOf("</untrusted_tool_result>");
  const inner = text.slice(m[0].length, end > 0 ? end : undefined).trim();
  const split = inner.indexOf("\n\n");
  return {
    envelope: split >= 0 ? inner.slice(0, split) : "",
    body: split >= 0 ? inner.slice(split + 2).trim() : inner,
  };
}

const ROLE_STYLE: Record<string, string> = {
  system: "border-l-4 border-l-muted-foreground/40 bg-muted/30",
  developer: "border-l-4 border-l-muted-foreground/40 bg-muted/30",
  user: "border-l-4 border-l-primary bg-primary/5",
  assistant: "border-l-4 border-l-success bg-success/5",
  tool: "border-l-4 border-l-warning bg-warning/5",
};

function Collapsible({
  title,
  meta,
  defaultOpen,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="font-medium">{title}</span>
        {meta && <span className="ml-auto shrink-0 font-mono-ui">{meta}</span>}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

function LongText({ text, mono, maxChars = 4000 }: { text: string; mono?: boolean; maxChars?: number }) {
  const [full, setFull] = useState(false);
  const shown = full || text.length <= maxChars ? text : text.slice(0, maxChars);
  return (
    <div>
      <pre
        className={`whitespace-pre-wrap break-words text-xs leading-relaxed ${mono ? "font-mono" : "font-sans"} text-foreground/90`}
      >
        {shown}
        {!full && text.length > maxChars && "…"}
      </pre>
      {text.length > maxChars && (
        <button
          type="button"
          onClick={() => setFull((v) => !v)}
          className="mt-1 text-xs text-primary hover:underline"
        >
          {full ? "▲" : `▼ +${fmtK(text.length - maxChars)}`}
        </button>
      )}
    </div>
  );
}

function MessageCard({
  msg,
  index,
  isNew,
  s,
}: {
  msg: WireMessage;
  index: number;
  isNew: boolean;
  s: (typeof STR)["en"] | (typeof STR)["ru"];
}) {
  const role = msg.role || "?";
  const text = contentText(msg.content);
  const style = ROLE_STYLE[role] ?? "border-l-4 border-l-border bg-muted/20";
  const isSystem = role === "system" || role === "developer";
  const isTool = role === "tool";

  return (
    <div className={`rounded-sm px-4 py-3 ${style} ${isNew ? "ring-1 ring-primary/40" : ""}`} id={`msg-${index}`}>
      <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span className="font-semibold">{role}</span>
        {msg.name && <span className="font-mono-ui normal-case">{msg.name}</span>}
        {msg.tool_call_id && <span className="font-mono-ui normal-case">{msg.tool_call_id}</span>}
        <span className="ml-auto font-mono-ui normal-case">
          #{index + 1} · {fmtK(text.length)} {s.chars}
        </span>
        {isNew && <span className="rounded bg-primary/15 px-1.5 py-0.5 normal-case text-primary">{s.newSince}</span>}
      </div>

      {isSystem ? (
        <Collapsible title={s.system} meta={`${fmtK(text.length)} ${s.chars}`} defaultOpen={false}>
          <LongText text={text} mono maxChars={6000} />
        </Collapsible>
      ) : isTool ? (
        (() => {
          const { envelope, body } = unwrapUntrusted(text);
          return (
            <div className="space-y-1">
              {envelope !== null && (
                <div className="text-[11px] italic text-muted-foreground">⟨untrusted_tool_result⟩ {envelope.slice(0, 140)}…</div>
              )}
              <LongText text={prettyMaybeJson(body)} mono maxChars={3000} />
            </div>
          );
        })()
      ) : (
        <>
          {msg.reasoning_content && msg.reasoning_content.trim() && (
            <Collapsible title={s.thinking} meta={`${fmtK(msg.reasoning_content.length)} ${s.chars}`} defaultOpen={false}>
              <LongText text={msg.reasoning_content} />
            </Collapsible>
          )}
          {text && <Markdown content={text} />}
          {msg.tool_calls && msg.tool_calls.length > 0 && (
            <div className="mt-2 space-y-1">
              {msg.tool_calls.map((tc, i) => (
                <div key={tc.id ?? i} className="rounded border border-warning/30 bg-warning/5 px-2 py-1 text-xs">
                  <span className="font-mono-ui font-medium text-warning">{tc.function?.name}</span>
                  <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
                    {prettyMaybeJson(tc.function?.arguments ?? "")}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CallCanvas({
  call,
  s,
}: {
  call: ApiRequestFull;
  s: (typeof STR)["en"] | (typeof STR)["ru"];
}) {
  const [showShared, setShowShared] = useState(false);
  const messages = call.request?.messages ?? [];
  const shared = Math.min(call.prefix_shared_msgs ?? 0, messages.length);
  const foldable = shared > 1 && !showShared;
  const head = foldable ? messages.slice(0, shared) : [];
  const tail = foldable ? messages.slice(shared) : messages;
  const prompt = call.prompt_tokens ?? 0;
  const cached = call.cache_read_tokens ?? 0;
  const hitPct = prompt > 0 ? Math.round((cached / prompt) * 100) : null;
  const cacheablePct =
    call.request_chars && call.prefix_shared_chars ? Math.round((call.prefix_shared_chars / call.request_chars) * 100) : null;
  const outText = contentText(call.response?.content ?? "");

  return (
    <div className="space-y-4">
      {/* Cache line: what could have been cached vs what the provider says it served. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-sm border border-border bg-muted/20 px-3 py-2 text-xs">
        <span>
          <span className="text-muted-foreground">{s.cacheable}: </span>
          <span className="font-mono-ui">
            {call.prefix_shared_msgs ?? 0}/{call.message_count ?? messages.length} msgs · {fmtK(call.prefix_shared_chars)}{" "}
            {s.chars}
            {cacheablePct !== null && ` (${cacheablePct}%)`}
          </span>
        </span>
        <span>
          <span className="text-muted-foreground">{s.cacheHit}: </span>
          <span className={`font-mono-ui ${hitPct !== null && hitPct >= 50 ? "text-success" : ""}`}>
            {call.prompt_tokens === null ? s.noUsage : `${fmtK(cached)} / ${fmtK(prompt)} tok${hitPct !== null ? ` (${hitPct}%)` : ""}`}
          </span>
        </span>
        <span>
          <span className="text-muted-foreground">{s.latency}: </span>
          <span className="font-mono-ui">
            {fmtSecs(call.started_at, call.ended_at)}
            {call.first_chunk_at && call.started_at ? ` · ${s.ttfb} ${(call.first_chunk_at - call.started_at).toFixed(1)}s` : ""}
          </span>
        </span>
        <span className="ml-auto font-mono-ui">{fmtCost(call.cost_usd)}</span>
      </div>

      <h3 className="text-sm font-semibold text-foreground">{s.request}</h3>
      <div className="text-xs text-muted-foreground">
        {call.model} · {messages.length} msgs · {call.tool_count ?? 0} {s.tools}
        {call.request?.tools?.length ? `: ${call.request.tools.join(", ")}` : ""}
        {call.request?.extra && Object.keys(call.request.extra).length > 0 && (
          <Collapsible title={s.extra} defaultOpen={false}>
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">{JSON.stringify(call.request.extra, null, 2)}</pre>
          </Collapsible>
        )}
      </div>

      {foldable && (
        <button
          type="button"
          onClick={() => setShowShared(true)}
          className="flex w-full items-center gap-2 rounded-sm border border-dashed border-border bg-muted/30 px-4 py-2 text-left text-xs text-muted-foreground hover:bg-muted/50"
        >
          <ChevronRight className="h-3 w-3" />
          {s.sharedBar(head.length, call.prefix_shared_chars ?? 0)} — {s.showShared}
        </button>
      )}
      {!foldable && shared > 1 && (
        <button
          type="button"
          onClick={() => setShowShared(false)}
          className="flex w-full items-center gap-2 rounded-sm border border-dashed border-border bg-muted/30 px-4 py-2 text-left text-xs text-muted-foreground hover:bg-muted/50"
        >
          <ChevronDown className="h-3 w-3" />
          {s.hideShared}
        </button>
      )}

      <div className="space-y-2">
        {tail.map((m, i) => {
          const index = foldable ? shared + i : i;
          return <MessageCard key={index} msg={m} index={index} isNew={index >= shared && shared > 0} s={s} />;
        })}
      </div>

      <h3 className="pt-2 text-sm font-semibold text-foreground">
        {s.response}{" "}
        <span className="font-normal text-muted-foreground">
          · {fmtK(call.output_tokens)} tok
          {call.reasoning_tokens ? ` (${fmtK(call.reasoning_tokens)} thinking)` : ""} · {call.finish_reason ?? call.status}
        </span>
      </h3>
      {call.status === "error" && (
        <div className="rounded-sm border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
          {call.error}
        </div>
      )}
      {call.response?.reasoning && (
        <div className="rounded-sm border border-border bg-muted/20 px-4 py-3">
          <Collapsible title={s.thinking} meta={`${fmtK(call.response.reasoning.length)} ${s.chars}`} defaultOpen>
            <LongText text={call.response.reasoning} maxChars={8000} />
          </Collapsible>
        </div>
      )}
      {outText && (
        <div className="rounded-sm border-l-4 border-l-success bg-success/5 px-4 py-3">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{s.output}</div>
          <Markdown content={outText} />
        </div>
      )}
      {call.response?.tool_calls && call.response.tool_calls.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{s.toolCalls}</div>
          {call.response.tool_calls.map((tc, i) => (
            <div key={tc.id ?? i} className="rounded border border-warning/30 bg-warning/5 px-2 py-1 text-xs">
              <span className="font-mono-ui font-medium text-warning">{tc.name}</span>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
                {prettyMaybeJson(tc.arguments ?? "")}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RequestLogPage() {
  const { sessionId = "" } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { locale } = useI18n();
  const s = locale === "ru" ? STR.ru : STR.en;
  const [rows, setRows] = useState<ApiRequestRow[] | null>(null);
  const [stats, setStats] = useState<Record<string, number | null>>({});
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ApiRequestFull | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { setAfterTitle } = usePageHeader();
  useEffect(() => {
    setAfterTitle(<span className="font-mono-ui text-xs text-muted-foreground">{sessionId}</span>);
    return () => setAfterTitle(null);
  }, [setAfterTitle, sessionId]);

  const load = useCallback(async () => {
    try {
      const data = await fetchJSON<{ requests: ApiRequestRow[]; stats: Record<string, number | null> }>(
        `/api/requests/${encodeURIComponent(sessionId)}`,
      );
      setRows(data.requests);
      setStats(data.stats ?? {});
      setSelectedId((cur) => cur ?? data.requests[data.requests.length - 1]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selectedId === null) return;
    let cancelled = false;
    setDetail(null);
    fetchJSON<ApiRequestFull>(`/api/requests/${encodeURIComponent(sessionId)}/${selectedId}`)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, selectedId]);

  const totals = useMemo(() => {
    const prompt = Number(stats.prompt ?? 0);
    const cached = Number(stats.cached ?? 0);
    return {
      n: Number(stats.n ?? rows?.length ?? 0),
      prompt,
      cached,
      hit: prompt > 0 ? Math.round((cached / prompt) * 100) : null,
      out: Number(stats.out ?? 0),
      cost: Number(stats.cost ?? 0),
      secs: Number(stats.secs ?? 0),
    };
  }, [stats, rows]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <Button ghost size="sm" onClick={() => navigate("/sessions")}>
          ← {s.back}
        </Button>
        {rows && rows.length > 0 && (
          <span className="font-mono-ui">
            {totals.n} {s.calls} · {s.prompt} {fmtK(totals.prompt)} tok
            {totals.hit !== null && ` (${totals.hit}% ${s.cached})`} · {s.out} {fmtK(totals.out)} tok · {fmtCost(totals.cost)} ·{" "}
            {totals.secs.toFixed(0)}s
          </span>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {rows === null && !error && (
        <div className="flex items-center justify-center py-8">
          <Spinner className="text-xl text-primary" />
        </div>
      )}
      {rows && rows.length === 0 && <p className="py-6 text-sm text-muted-foreground">{s.empty}</p>}

      {rows && rows.length > 0 && (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto rounded-sm border border-border">
            {rows.map((r) => {
              const prompt = r.prompt_tokens ?? 0;
              const hit = prompt > 0 && r.cache_read_tokens ? Math.round((r.cache_read_tokens / prompt) * 100) : null;
              const active = r.id === selectedId;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={`block w-full border-b border-border px-3 py-2 text-left text-xs hover:bg-muted/40 ${
                    active ? "bg-primary/10" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono-ui font-semibold">#{r.call_no ?? r.id}</span>
                    <span className="text-muted-foreground">{fmtTime(r.started_at)}</span>
                    <span className="ml-auto font-mono-ui">
                      {r.status === "error" ? <span className="text-destructive">{s.err}</span> : fmtCost(r.cost_usd)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 font-mono-ui text-[11px] text-muted-foreground">
                    <span>{fmtK(r.prompt_tokens)}↑{hit !== null ? ` (${hit}%)` : ""}</span>
                    <span>{fmtK(r.output_tokens)}↓</span>
                    <span>{fmtSecs(r.started_at, r.ended_at)}</span>
                    <span>{r.finish_reason ?? (r.status === "pending" ? s.pending : "")}</span>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="min-h-0 overflow-y-auto pr-2">
            {detail ? (
              <CallCanvas call={detail} s={s} />
            ) : (
              <div className="flex items-center justify-center py-8">
                <Spinner className="text-xl text-primary" />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
