import path from "path"

// The Super Voice daemon: HTTP/1.1 + JSON over a Unix domain socket, every
// route under /v1. Speech to text and text to speech are its two features:
// each one's own routes are under /v1/stt and /v1/tts, and what the daemon has
// once — auth, events, status — is at /v1. One token serves both features, so
// it carries the scopes of both, and both clients keep it in one file.
// See ../../../../../super-stt/docs/protocol/ for the wire reference.

/** What dictation needs (`transcribe`, the microphone's bands) and speech (`speak`, `playback_events`). */
export const SCOPES = ["transcribe", "speak", "status", "audio_visualization", "playback_events"]

export const APP_NAME = "opencode"

/** The `Host` the daemon is addressed by. It ignores it over the socket, but a request needs one. */
export const HOST = "voice.local"

export const PREFIX = "/v1"

export type Session = {
  token: string
  scopes: string[]
  expires?: string
}

/** One feature's part of `GET /v1/status`. */
export type FeatureStatus = {
  device: string
  model_loaded: boolean
  current_model?: string
  busy: boolean
}

/** `GET /v1/status`: each feature's model and device, and whether it is at work. */
export type Status = {
  stt: FeatureStatus
  tts: FeatureStatus
}

/** How a feature's client builds its error from a code and an HTTP status. */
export type MakeError = (message: string, code: string, status: number) => Error

export function socketPath() {
  if (process.env.SUPER_VOICE_HTTP_SOCKET) return process.env.SUPER_VOICE_HTTP_SOCKET
  if (!process.env.XDG_RUNTIME_DIR) return undefined
  return path.join(process.env.XDG_RUNTIME_DIR, "voice", "super-voice-http.sock")
}

/**
 * Whether the daemon is taking connections. The socket file is no answer: a
 * daemon that crashed leaves it behind. Connects and hangs up without a
 * request, because every request counts toward the daemon's per-client quota
 * and interactive mode asks this every few seconds.
 */
export async function available(socket: string) {
  return Bun.connect({ unix: socket, socket: { data() {} } }).then(
    (connection) => {
      connection.end()
      return true
    },
    () => false,
  )
}

export function url(endpoint: string) {
  return `http://${HOST}${PREFIX}${endpoint}`
}

async function fail(response: Response, make: MakeError) {
  // Error envelope: { status, error_code?, message, data? }. error_code is the
  // stable identifier; the auth guards carry theirs in data.reason.
  const body = (await response.json().catch(() => undefined)) as
    | { error_code?: string; message?: string; data?: { reason?: string } }
    | undefined
  const code = body?.error_code ?? body?.message ?? `http_${response.status}`
  const reason = body?.data?.reason
  return make(body?.message ?? `request failed (${response.status})`, reason ?? code, response.status)
}

export async function send(
  socket: string,
  method: string,
  endpoint: string,
  make: MakeError,
  options?: { token?: string; body?: unknown; accept?: string; signal?: AbortSignal },
) {
  const response = await fetch(url(endpoint), {
    unix: socket,
    method,
    signal: options?.signal,
    headers: {
      ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options?.accept ? { Accept: options.accept } : {}),
    },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  }).catch((error) => {
    throw make(`cannot reach the Super Voice daemon: ${error.message}`, "daemon_unreachable", 0)
  })
  if (!response.ok) throw await fail(response, make)
  return response
}

/**
 * Trigger the consent popup and mint a session token. The daemon binds the
 * token to the calling binary, so a token minted here stops working if the
 * opencode executable changes (`exe_changed`).
 */
export async function authorize(socket: string, version: string, make: MakeError): Promise<Session> {
  const response = await send(socket, "POST", "/auth/request", make, {
    body: { app_name: APP_NAME, scopes: SCOPES, version },
  })
  const body = (await response.json()) as { session_token: string; scopes?: string[]; expires_at?: string }
  return { token: body.session_token, scopes: body.scopes ?? SCOPES, expires: body.expires_at }
}

/**
 * Whether a stored session still covers what this build asks for. A token minted
 * by an older build carries the scopes of its day, and a topic or route added
 * since would be refused with `scope_denied` rather than anything the user
 * could act on.
 */
export function satisfies(session: Session) {
  return SCOPES.every((scope) => session.scopes.includes(scope))
}

/** Probe token validity without spawning a consent popup. */
export async function valid(socket: string, token: string) {
  const response = await fetch(url("/auth/status"), {
    unix: socket,
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => undefined)
  return response?.ok === true
}

export async function status(socket: string, token: string, make: MakeError) {
  const response = await send(socket, "GET", "/status", make, { token })
  return (await response.json()) as Status
}

/**
 * Minimal SSE reader: yields one frame per blank-line-delimited block and drops
 * the comment frames (`: stream-open`, `: keepalive`) the daemon writes to hold
 * the connection open through silent phases.
 */
export async function* frames(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const release = () => reader.cancel().catch(() => undefined)
  signal?.addEventListener("abort", release, { once: true })

  let buffer = ""
  while (true) {
    const chunk = await reader.read().catch(() => undefined)
    if (!chunk || chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(buffer)
      if (!boundary) break
      const block = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const frame = block.split(/\r?\n/).reduce(
        (acc, line) => {
          if (line.startsWith(":")) return acc
          if (line.startsWith("event:")) return { ...acc, event: line.slice(6).trim() }
          if (line.startsWith("data:")) return { ...acc, data: acc.data + line.slice(5).trim() }
          return acc
        },
        { event: "", data: "" },
      )
      if (frame.event) yield frame
    }
  }
  signal?.removeEventListener("abort", release)
}
