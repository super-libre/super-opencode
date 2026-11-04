import { afterAll, expect, test } from "bun:test"
import { tmpdir } from "os"
import path from "path"
import { rm, stat } from "fs/promises"
import {
  authorize,
  available,
  silence,
  socketPath,
  speak,
  speaking,
  status,
  stream,
  TtsError,
  valid,
  SCOPES,
} from "../src/tts/client"

// A stand-in for the Super Voice daemon covering the slice of the /v1 protocol
// speech uses. See super-stt/docs/protocol/ for the wire reference.
type Frames = { started?: Record<string, unknown>; deltas: string[]; ended: boolean; cancelled: boolean }

const seen: Frames = { deltas: [], ended: false, cancelled: false }
const spoken: string[] = []
let stopped = 0

// Subscribers to `GET /events`, and the topics the last one asked for.
const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>()
let subscribed: string[] = []

function publish(payload: Record<string, unknown>) {
  const frame = new TextEncoder().encode(`event: speaking_state\ndata: ${JSON.stringify(payload)}\n\n`)
  for (const listener of listeners) listener.enqueue(frame)
}

function daemon(socket: string, options: { busySessions?: boolean } = {}) {
  const tokens = new Set<string>()
  let issued = 0
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

  return Bun.serve<{ id: string }>({
    unix: socket,
    async fetch(request, instance) {
      const url = new URL(request.url)
      const token = request.headers.get("Authorization")?.replace("Bearer ", "")

      if (url.pathname === "/v1/auth/request") {
        const body = (await request.json()) as { scopes: string[] }
        const minted = `tts_${++issued}`
        tokens.add(minted)
        return json({
          status: "success",
          session_token: minted,
          scopes: body.scopes,
          expires_at: "2099-01-01T00:00:00Z",
        })
      }
      if (!token || !tokens.has(token))
        return json({ status: "error", message: "invalid_session", data: { reason: "unknown" } }, 401)

      if (url.pathname === "/v1/auth/status") return json({ status: "success" })
      if (url.pathname === "/v1/events") {
        subscribed = (url.searchParams.get("topics") ?? "").split(",").filter(Boolean)
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            listeners.add(controller)
            // The daemon's first frame is always `subscribed`; it is not a
            // topic frame and must not reach the caller.
            controller.enqueue(
              new TextEncoder().encode(
                `event: subscribed\ndata: ${JSON.stringify({ client_id: "sub_1", subscribed_to: subscribed })}\n\n`,
              ),
            )
          },
          cancel(reason) {
            void reason
            for (const listener of listeners) listeners.delete(listener)
          },
        })
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
      }
      if (url.pathname === "/v1/status")
        return json({
          status: "success",
          stt: { device: "unknown", model_loaded: false, busy: false },
          tts: { device: "cpu", model_loaded: true, current_model: "kokoro-82m", busy: false },
        })
      if (url.pathname === "/v1/tts/speak") {
        spoken.push(((await request.json()) as { text: string }).text)
        return json({ status: "success", utterance_id: "utt_1" }, 202)
      }
      if (url.pathname === "/v1/tts/speak/stop") {
        stopped++
        return json({ status: "success" })
      }
      if (url.pathname === "/v1/tts/speak/stream") {
        if (options.busySessions)
          return json({ status: "error", error_code: "speak_sessions_busy", message: "busy" }, 503)
        if (instance.upgrade(request, { data: { id: "utt_stream" } })) return
        return json({ status: "error", message: "expected upgrade" }, 400)
      }
      return json({ status: "error", message: "not_found" }, 404)
    },
    websocket: {
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as { type: string; delta?: string }
        if (frame.type === "start") {
          seen.started = frame as Record<string, unknown>
          ws.send(JSON.stringify({ type: "utterance", id: ws.data.id }))
          return
        }
        if (frame.type === "text") {
          seen.deltas.push(frame.delta ?? "")
          return
        }
        if (frame.type === "end") {
          seen.ended = true
          ws.send(JSON.stringify({ type: "done", id: ws.data.id, chunks: seen.deltas.length }))
          return
        }
        if (frame.type === "cancel") seen.cancelled = true
      },
    },
  })
}

/** Wait for a condition rather than a fixed delay, which a loaded machine outruns. */
async function until(condition: () => boolean, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (!condition() && Date.now() < deadline) await Bun.sleep(10)
  return condition()
}

const socket = path.join(tmpdir(), `opencode-tts-${process.pid}.sock`)
const server = daemon(socket)

afterAll(async () => {
  await server.stop(true)
  await rm(socket, { force: true })
})

test("resolves the socket path and detects the daemon", async () => {
  expect(await available(socket)).toBe(true)
  expect(await available(path.join(tmpdir(), "opencode-tts-absent.sock"))).toBe(false)
  expect(socketPath()).toBe(
    process.env.SUPER_VOICE_HTTP_SOCKET ??
      (process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, "voice", "super-voice-http.sock") : undefined)!,
  )
})

test("mints a token and reads status", async () => {
  const session = await authorize(socket, "1.2.3")
  expect(session.token).toStartWith("tts_")
  // One token for both features, so it asks for dictation's scopes too.
  expect(session.scopes).toEqual(SCOPES)
  expect(session.scopes).toContain("speak")
  expect(session.scopes).toContain("transcribe")
  expect(await valid(socket, session.token)).toBe(true)
  // Text to speech's part of the daemon's status, not speech to text's.
  const current = await status(socket, session.token)
  expect(current.model_loaded).toBe(true)
  expect(current.current_model).toBe("kokoro-82m")
})

test("speaks complete text and stops on request", async () => {
  const session = await authorize(socket, "1.2.3")
  expect(await speak(socket, session.token, "The kettle is boiling.")).toBe("utt_1")
  expect(spoken).toContain("The kettle is boiling.")
  const before = stopped
  await silence(socket, session.token)
  expect(stopped).toBe(before + 1)
})

test("streams generated text and plays it out on end", async () => {
  const session = await authorize(socket, "1.2.3")
  seen.deltas.length = 0
  seen.ended = false

  let done = false
  let utterance: string | undefined
  const session1 = await stream(socket, session.token, {
    onUtterance: (id) => (utterance = id),
    onDone: () => (done = true),
  })
  await Bun.sleep(40)
  // `start` names nothing: `voice`, `language`, `speed` and `instructions` each
  // override a value the user configured, so each needs the `settings` scope
  // and a session that names one is closed rather than quietly ignored.
  expect(seen.started).toEqual({ type: "start" })
  expect(utterance).toBe("utt_stream")

  session1.text("The kettle")
  session1.text(" is boiling.")
  await Bun.sleep(40)
  expect(seen.deltas).toEqual(["The kettle", " is boiling."])

  session1.end()
  await Bun.sleep(80)
  expect(seen.ended).toBe(true)
  expect(done).toBe(true)
})

test("cancel drops the utterance", async () => {
  const session = await authorize(socket, "1.2.3")
  seen.cancelled = false
  const open = await stream(socket, session.token)
  open.text("half a sentence")
  open.cancel()
  await Bun.sleep(60)
  expect(seen.cancelled).toBe(true)
  expect(open.closed).toBe(true)
})

test("follows the speakers until the stop that outlives the stream", async () => {
  const session = await authorize(socket, "1.2.3")
  const controller = new AbortController()
  const seen: { speaking: boolean; utterance?: string }[] = []
  const collect = (async () => {
    for await (const frame of speaking(socket, session.token, controller.signal)) seen.push(frame)
  })()

  await until(() => listeners.size === 1)
  expect(subscribed).toContain("speaking_state")
  // The real daemon sends the stop only once the audio has played out, well
  // after the streaming session's `done` frame and the socket that carried it.
  publish({ is_speaking: true, utterance_id: "utt_stream" })
  publish({ is_speaking: false, utterance_id: "utt_stream" })
  await until(() => seen.length === 2)

  // The opening `subscribed` frame is not a topic frame and does not appear.
  expect(seen).toEqual([
    { speaking: true, utterance: "utt_stream" },
    { speaking: false, utterance: "utt_stream" },
  ])

  controller.abort()
  await collect.catch(() => undefined)
})

test("an unusable token is reported so the caller can re-authorize", async () => {
  const error = await status(socket, "tts_bogus").catch((error) => error)
  expect(error).toBeInstanceOf(TtsError)
  expect(error.status).toBe(401)
})

test("surfaces a refused stream upgrade as a typed error", async () => {
  const busy = path.join(tmpdir(), `opencode-tts-busy-${process.pid}.sock`)
  const instance = daemon(busy, { busySessions: true })
  const session = await authorize(busy, "1.2.3")
  const error = await stream(busy, session.token).catch((error) => error)
  expect(error).toBeInstanceOf(TtsError)
  expect(error.code).toBe("speak_sessions_busy")
  await instance.stop(true)
  await rm(busy, { force: true })
})

test("reports an unreachable daemon as a typed error", async () => {
  const error = await status(path.join(tmpdir(), "opencode-tts-nothing.sock"), "tts_x").catch((error) => error)
  expect(error).toBeInstanceOf(TtsError)
  expect(error.code).toBe("daemon_unreachable")
})

test("ignores the socket a crashed daemon left behind", async () => {
  const stale = path.join(tmpdir(), `opencode-tts-stale-${process.pid}.sock`)
  await rm(stale, { force: true })
  // Killed rather than stopped: a daemon that exits cleanly removes its socket,
  // and one that crashes leaves it for whoever comes next.
  const crashed = Bun.spawn(
    [
      process.execPath,
      "-e",
      `Bun.listen({ unix: ${JSON.stringify(stale)}, socket: { data() {} } }); console.log("up")`,
    ],
    { stdout: "pipe" },
  )
  await crashed.stdout.getReader().read()
  crashed.kill("SIGKILL")
  await crashed.exited
  try {
    expect((await stat(stale)).isSocket()).toBe(true)
    expect(await available(stale)).toBe(false)
  } finally {
    await rm(stale, { force: true })
  }
})
