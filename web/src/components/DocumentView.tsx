/** Renders a ``read_file`` result as the document it is: CSV/TSV as a table, XLSX as one table per
 *  sheet, Markdown as Markdown, anything else as text. Line-number prefixes (``12|…``) are stripped. */
import { useState } from "react";
import { Markdown } from "@/components/Markdown";

export type DocumentKind = "csv" | "tsv" | "xlsx" | "markdown" | "text";

const MAX_ROWS = 200;

export function stripLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\d+\|/, ""))
    .join("\n");
}

export function documentKindForPath(path: string | undefined, content: string): DocumentKind {
  const ext = (path ?? "").toLowerCase().split(".").pop() ?? "";
  if (ext === "csv") return "csv";
  if (ext === "tsv") return "tsv";
  if (ext === "xlsx" || ext === "xls" || ext === "ods" || content.includes("# ── Sheet:")) return "xlsx";
  if (ext === "md" || ext === "markdown") return "markdown";
  return "text";
}

function splitDelimited(text: string, delimiter: string): string[][] {
  // Minimal RFC-4180-ish split: handles quoted cells with embedded delimiters/quotes.
  const rows: string[][] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const cells: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inQuotes) {
        if (ch === '"' && raw[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else cur += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === delimiter) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

function DataTable({ rows, caption }: { rows: string[][]; caption?: string }) {
  const [showAll, setShowAll] = useState(false);
  if (rows.length === 0) return null;
  const [header, ...body] = rows;
  const visible = showAll ? body : body.slice(0, MAX_ROWS);
  const numeric = (v: string) => /^-?\d[\d ,]*([.,]\d+)?%?$/.test(v.trim());
  return (
    <div className="mt-2 overflow-x-auto">
      {caption && <div className="mb-1 font-mono-ui text-xs text-warning/70">{caption}</div>}
      <table className="min-w-full border-collapse text-xs">
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={i} className="border border-border bg-muted/40 px-2 py-1 text-left font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((r, ri) => (
            <tr key={ri} className="odd:bg-muted/10">
              {header.map((_, ci) => (
                <td key={ci} className={`border border-border px-2 py-1 font-mono-ui ${numeric(r[ci] ?? "") ? "text-right tabular-nums" : ""}`}>{r[ci] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-1 text-xs text-text-tertiary">
        {body.length.toLocaleString()} rows
        {body.length > MAX_ROWS && (
          <button type="button" className="ml-2 text-warning hover:underline" onClick={() => setShowAll(!showAll)}>
            {showAll ? "show first " + MAX_ROWS : "show all"}
          </button>
        )}
      </div>
    </div>
  );
}

export function DocumentView({ path, content }: { path?: string; content: string }) {
  const [raw, setRaw] = useState(false);
  const text = stripLineNumbers(content);
  const kind = documentKindForPath(path, text);
  const name = (path ?? "").split("/").pop();

  let body: React.ReactNode;
  if (raw) {
    body = <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{text}</pre>;
  } else if (kind === "csv" || kind === "tsv") {
    body = <DataTable rows={splitDelimited(text, kind === "csv" ? "," : "\t")} />;
  } else if (kind === "xlsx") {
    // ``# ── Sheet: NAME ──`` separates sheets; each sheet is TSV.
    const sheets: Array<{ name: string; lines: string[] }> = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^#\s*──\s*Sheet:\s*(.+?)\s*──/);
      if (m) sheets.push({ name: m[1], lines: [] });
      else (sheets[sheets.length - 1] ?? (sheets.push({ name: "", lines: [] }), sheets[0])).lines.push(line);
    }
    body = (
      <div>
        {sheets.map((s, i) => (
          <DataTable key={i} rows={splitDelimited(s.lines.join("\n"), "\t")} caption={s.name ? `Sheet: ${s.name}` : undefined} />
        ))}
      </div>
    );
  } else if (kind === "markdown") {
    body = <div className="mt-2 text-sm"><Markdown content={text} /></div>;
  } else {
    body = <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{text}</pre>;
  }

  return (
    <div className="mt-1 border border-border/60 p-2" data-document-kind={kind}>
      <div className="flex items-center gap-2 text-xs text-text-tertiary">
        <span className="font-mono-ui">{name ?? "document"}</span>
        <span className="uppercase">{kind}</span>
        <button type="button" className="ml-auto text-warning hover:underline" onClick={() => setRaw(!raw)}>
          {raw ? "rendered" : "raw"}
        </button>
      </div>
      {body}
    </div>
  );
}
