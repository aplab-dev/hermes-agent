// LLM request log (request_log plugin): every API call of a session — the prompt exactly as it went
// on the wire, the reply (thinking / text / tool calls), token buckets incl. prefix-cache reads,
// latency and cost. Read-only; the backend routes live in hermes_cli/web_routers/requests_log.py.
import { hermesApi } from '@/api/client'

export interface ApiRequestRow {
  id: number
  api_request_id: string
  session_id: string
  turn_id: null | string
  call_no: null | number
  started_at: null | number
  ended_at: null | number
  first_chunk_at: null | number
  model: null | string
  provider: null | string
  api_mode: null | string
  finish_reason: null | string
  status: 'error' | 'ok' | 'pending'
  error: null | string
  prompt_tokens: null | number
  input_tokens: null | number
  cache_read_tokens: null | number
  cache_write_tokens: null | number
  output_tokens: null | number
  reasoning_tokens: null | number
  cost_usd: null | number
  cost_status: null | string
  request_chars: null | number
  message_count: null | number
  tool_count: null | number
  prefix_shared_msgs: null | number
  prefix_shared_chars: null | number
}

export interface WireMessage {
  role: string
  content?: unknown
  reasoning_content?: string
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
  tool_call_id?: string
  name?: string
}

export interface ApiRequestFull extends ApiRequestRow {
  request: null | { messages: WireMessage[]; tools: string[]; extra: Record<string, unknown> }
  response: null | {
    content: null | string | unknown[]
    reasoning: string
    tool_calls: { id?: string; name?: string; arguments?: string }[]
  }
}

export interface SessionRequestsResponse {
  requests: ApiRequestRow[]
  stats: Record<string, null | number>
}

export function listSessionRequests(sessionId: string): Promise<SessionRequestsResponse> {
  return hermesApi<SessionRequestsResponse>({ path: `/api/requests/${encodeURIComponent(sessionId)}` })
}

export function getSessionRequest(sessionId: string, id: number): Promise<ApiRequestFull> {
  return hermesApi<ApiRequestFull>({ path: `/api/requests/${encodeURIComponent(sessionId)}/${id}` })
}
