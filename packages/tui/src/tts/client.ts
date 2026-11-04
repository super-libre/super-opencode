import * as Daemon from "../voice/daemon"
import { open as openSocket, WebSocketError } from "./websocket"

// Client for Super Voice's text-to-speech feature: its routes are under
// /v1/tts, with a WebSocket for speaking text as it is generated. The
// transport, the token and the routes the daemon has once are ../voice/daemon's.

export { APP_NAME, SCOPES, available, satisfies, socketPath, valid } from "../voice/daemon"
export type { Session } from "../voice/daemon"

/** A `speaking_state` frame: whether the speakers are busy, and with whose utterance. */
export type Speaking = {
  speaking: boolean
  utterance?: string
}

/** Text to speech's part of `GET /v1/status`. */
export type Status = Daemon.FeatureStatus

export class TtsError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = "TtsError"
    this.code = code
    this.status = status
  }
}

const make: Daemon.MakeError = (message, code, status) => new TtsError(message, code, status)

function send(
  socket: string,
  method: string,
  endpoint: string,
  options?: { token?: string; body?: unknown; accept?: string; signal?: AbortSignal },
) {
  return Daemon.send(socket, method, endpoint, make, options)
}

export function authorize(socket: string, version: string) {
  return Daemon.authorize(socket, version, make)
}

/** Text to speech's model and device, and whether it is speaking. */
export async function status(socket: string, token: string): Promise<Status> {
  return (await Daemon.status(socket, token, make)).tts
}

/** Speak complete text. Newest wins: this interrupts whatever is playing. */
export async function speak(socket: string, token: string, text: string) {
  const response = await send(socket, "POST", "/tts/speak", { token, body: { text } })
  return ((await response.json()) as { utterance_id?: string }).utterance_id
}

/** Stop the current utterance and drop what is queued. Idempotent. */
export async function silence(socket: string, token: string) {
  await send(socket, "POST", "/tts/speak/stop", { token })
}

export type Stream = {
  /** Append generated text. Partial words and split markup are fine — the daemon holds an ambiguous tail. */
  text: (delta: string) => void
  /** No more text is coming; play out what remains. */
  end: () => void
  /** Stop now and drop queued audio. */
  cancel: () => void
  readonly closed: boolean
}

/**
 * Speak text as it is generated. The daemon synthesizes each sentence as it
 * completes, so speech starts while the model is still writing. Resolves once
 * the session is open and `start` has been accepted.
 */
export async function stream(
  socket: string,
  token: string,
  options: {
    /** The daemon's id for this utterance, as soon as it names one. */
    onUtterance?: (id: string) => void
    onProgress?: (spokenMs: number, queuedMs: number) => void
    onDone?: () => void
    onError?: (message: string) => void
  } = {},
): Promise<Stream> {
  const connection = await openSocket({
    unix: socket,
    endpoint: `${Daemon.PREFIX}/tts/speak/stream`,
    host: Daemon.HOST,
    headers: { Authorization: `Bearer ${token}` },
    handlers: {
      onMessage: (raw) => {
        const frame = parse(raw)
        if (frame?.type === "utterance" && frame.id) options.onUtterance?.(frame.id)
        if (frame?.type === "progress") options.onProgress?.(frame.spoken_ms ?? 0, frame.queued_ms ?? 0)
        if (frame?.type === "done") options.onDone?.()
        if (frame?.type === "error") options.onError?.(frame.message ?? "synthesis failed")
      },
      onClose: () => options.onDone?.(),
      onError: (error) => options.onError?.(error.message),
    },
  }).catch((error) => {
    if (error instanceof WebSocketError && error.status === 401)
      throw new TtsError("session rejected", "invalid_session", 401)
    if (error instanceof WebSocketError && error.status === 503)
      throw new TtsError("too many speak sessions", "speak_sessions_busy", 503)
    throw new TtsError(
      error instanceof Error ? error.message : "could not open the speak stream",
      "stream_failed",
      error instanceof WebSocketError && error.status ? error.status : 0,
    )
  })

  // The first frame must be `start`. It carries nothing: `voice`, `language`,
  // `speed` and `instructions` each override something the user configured in
  // Super Voice, so each needs the `settings` scope, and a session that names one
  // without it is closed rather than quietly given the configured value.
  connection.send(JSON.stringify({ type: "start" }))

  return {
    text: (delta) => {
      if (!delta || connection.closed) return
      connection.send(JSON.stringify({ type: "text", delta }))
    },
    end: () => {
      if (connection.closed) return
      connection.send(JSON.stringify({ type: "end" }))
    },
    cancel: () => {
      if (connection.closed) return
      connection.send(JSON.stringify({ type: "cancel" }))
      connection.close()
    },
    get closed() {
      return connection.closed
    },
  }
}

function parse(raw: string) {
  try {
    return JSON.parse(raw) as {
      type?: string
      id?: string
      message?: string
      spoken_ms?: number
      queued_ms?: number
    }
  } catch {
    return undefined
  }
}

/**
 * Follow the speakers until `signal` aborts.
 *
 * This is the only thing that knows when an utterance has actually been heard.
 * The streaming session's `done` frame means every sample is *queued*: a local
 * backend synthesizes several times faster than realtime, so it arrives while
 * most of the reply is still buffered ahead of the speakers, and for a short
 * reply before a single word has played. The daemon holds the utterance open
 * for the whole playout and publishes the stop here at the end of it.
 *
 * The events describe the *device*, not our requests — another app's utterance
 * raises them too — so callers match `utterance` against their own id.
 */
export async function* speaking(socket: string, token: string, signal?: AbortSignal): AsyncGenerator<Speaking> {
  const response = await send(socket, "GET", "/events?topics=speaking_state", {
    token,
    accept: "text/event-stream",
    signal,
  })
  if (!response.body) return

  for await (const frame of Daemon.frames(response.body, signal)) {
    if (frame.event !== "speaking_state") continue
    const data = (() => {
      try {
        return JSON.parse(frame.data) as { is_speaking?: boolean; utterance_id?: string }
      } catch {
        return undefined
      }
    })()
    if (!data) continue
    yield { speaking: data.is_speaking === true, utterance: data.utterance_id }
  }
}
