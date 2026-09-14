/**
 * Document view for a `read_file` result: CSV/TSV as a table, XLSX as one table
 * per sheet, Markdown as Markdown, everything else as text. The tool returns
 * `N|…` line-number prefixes for the model's benefit; they are stripped here.
 */
import { useMemo, useState } from 'react'
import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { cn } from '@/lib/utils'

export type DocumentKind = 'csv' | 'markdown' | 'text' | 'tsv' | 'xlsx'

const MAX_ROWS = 200
const SHEET_RE = /^#\s*──\s*Sheet:\s*(.+?)\s*──/

export function stripLineNumbers(content: string): string {
  return content
    .split('\n')
    .map((line) => line.replace(/^\d+\|/, ''))
    .join('\n')
}

export function documentKindForPath(path: string | undefined, content: string): DocumentKind {
  const ext = (path ?? '').toLowerCase().split('.').pop() ?? ''
  if (ext === 'csv') return 'csv'
  if (ext === 'tsv') return 'tsv'
  if (ext === 'xlsx' || ext === 'xls' || ext === 'ods' || SHEET_RE.test(content)) return 'xlsx'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  return 'text'
}

export function splitDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    const cells: string[] = []
    let cur = ''
    let inQuotes = false
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]
      if (inQuotes) {
        if (ch === '"' && raw[i + 1] === '"') {
          cur += '"'
          i++
        } else if (ch === '"') inQuotes = false
        else cur += ch
      } else if (ch === '"') inQuotes = true
      else if (ch === delimiter) {
        cells.push(cur)
        cur = ''
      } else cur += ch
    }
    cells.push(cur)
    rows.push(cells)
  }
  return rows
}

const NUMERIC_RE = /^-?\d[\d ,]*([.,]\d+)?%?$/

function DataTable({ rows, caption }: { caption?: string; rows: string[][] }) {
  const [showAll, setShowAll] = useState(false)
  if (rows.length === 0) return null
  const [header, ...body] = rows
  const visible = showAll ? body : body.slice(0, MAX_ROWS)
  return (
    <div className="mt-1 max-w-full overflow-x-auto">
      {caption && <div className="mb-1 font-mono text-[0.65rem] text-(--ui-text-tertiary)">{caption}</div>}
      <table className="min-w-full border-collapse text-[0.7rem]">
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={i} className="border border-current/15 bg-current/5 px-2 py-1 text-left font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((r, ri) => (
            <tr key={ri} className="odd:bg-current/[0.03]">
              {header.map((_, ci) => (
                <td
                  key={ci}
                  className={cn('border border-current/15 px-2 py-1 font-mono', NUMERIC_RE.test((r[ci] ?? '').trim()) && 'text-right tabular-nums')}
                >
                  {r[ci] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-1 text-[0.65rem] text-(--ui-text-tertiary)">
        {body.length.toLocaleString()} rows
        {body.length > MAX_ROWS && (
          <button type="button" className="ml-2 underline" onClick={() => setShowAll(!showAll)}>
            {showAll ? `show first ${MAX_ROWS}` : 'show all'}
          </button>
        )}
      </div>
    </div>
  )
}

export function DocumentDetail({ content, path }: { content: string; path?: string }) {
  const [raw, setRaw] = useState(false)
  const text = useMemo(() => stripLineNumbers(content), [content])
  const kind = documentKindForPath(path, text)
  const name = (path ?? '').split('/').pop() || 'document'

  const sheets = useMemo(() => {
    if (kind !== 'xlsx') return []
    const out: { lines: string[]; name: string }[] = []
    for (const line of text.split('\n')) {
      const m = line.match(SHEET_RE)
      if (m) out.push({ lines: [], name: m[1] })
      else {
        if (out.length === 0) out.push({ lines: [], name: '' })
        out[out.length - 1].lines.push(line)
      }
    }
    return out
  }, [kind, text])

  let body: React.ReactNode
  if (raw || kind === 'text') {
    body = <pre className="mt-1 max-h-72 overflow-auto font-mono text-[0.7rem] leading-relaxed whitespace-pre-wrap wrap-anywhere">{text}</pre>
  } else if (kind === 'csv' || kind === 'tsv') {
    body = <DataTable rows={splitDelimited(text, kind === 'csv' ? ',' : '\t')} />
  } else if (kind === 'xlsx') {
    body = (
      <div className="max-h-72 overflow-auto">
        {sheets.map((s, i) => (
          <DataTable key={i} caption={s.name ? `Sheet: ${s.name}` : undefined} rows={splitDelimited(s.lines.join('\n'), '\t')} />
        ))}
      </div>
    )
  } else {
    body = (
      <div className="mt-1 max-h-72 overflow-auto">
        <CompactMarkdown text={text} />
      </div>
    )
  }

  return (
    <div className="max-w-full text-xs text-(--ui-text-secondary)" data-document-kind={kind}>
      <div className="flex items-center gap-2 text-[0.65rem] text-(--ui-text-tertiary)">
        <span className="font-mono">{name}</span>
        <span className="uppercase">{kind}</span>
        {kind !== 'text' && (
          <button type="button" className="ml-auto underline" onClick={() => setRaw(!raw)}>
            {raw ? 'rendered' : 'raw'}
          </button>
        )}
      </div>
      {body}
    </div>
  )
}

/** The document text of a `read_file` result, or null when the result is not a successful read. */
export function readFileDocument(result: unknown): string | null {
  let rec: unknown = result
  if (typeof rec === 'string') {
    try {
      rec = JSON.parse(rec)
    } catch {
      return null
    }
  }
  if (!rec || typeof rec !== 'object') return null
  const r = rec as { content?: unknown; error?: unknown }
  if (r.error || typeof r.content !== 'string') return null
  return r.content
}
