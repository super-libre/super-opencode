import { afterAll, expect, test } from "bun:test"
import { tmpdir } from "os"
import path from "path"
import { rm, stat } from "fs/promises"
import { authorize, available, socketPath, status, stop, transcribe, valid, SttError, SCOPES } from "../src/stt/client"

// A stand-in for the Super Voice daemon covering the slice of the /v1 protocol
// dictation uses. See super-stt/docs/protocol/ for the wire reference.
function daemon(socket: string, options: { rejectFirstToken?: boolean } = {}) {
  const tokens = new Set<string>()
  let issued = 0
  let stopped = false
  let reject = options.rejectFirstToken ?? false

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

  return Bun.serve({
    unix: socket,
    async fetch(request) {
      const url = new URL(request.url)
      const token = request.headers.get("Authorization")?.replace("Bearer ", "")

      if (url.pathname === "/v1/auth/request") {
        const body = (await request.json()) as { scopes: string[] }
        const minted = `stt_${++issued}`
        tokens.add(minted)
        return json({
          status: "success",
          session_token: minted,
          scopes: body.scopes,
          expires_at: "2099-01-01T00:00:00Z",
        })
      }

      if (reject) {
        reject = false
        tokens.clear()
        return json({ status: "error", message: "invalid_session", data: { reason: "exe_changed" } }, 401)
      }
      if (!token || !tokens.has(token))
        return json({ status: "error", message: "invalid_session", data: { reason: "unknown" } }, 401)

      if (url.pathname === "/v1/auth/status") return json({ status: "success", scopes: ["transcribe", "status"] })

      if (url.pathname === "/v1/status")
        return json({
          status: "success",
          stt: { device: "cuda", model_loaded: true, current_model: "whisper-tiny", busy: false },
          tts: { device: "unknown", model_loaded: false, busy: false },
        })

      if (url.pathname === "/v1/stt/transcribe/stop") {
        stopped = true
        return json({ status: "success", message: "Recording stop signal sent" })
      }

      if (url.pathname === "/v1/stt/transcribe") {
        stopped = false
        return new Response(
          new ReadableStream({
            async start(controller) {
              const write = (frame: string) => controller.enqueue(new TextEncoder().encode(frame))
              write(": stream-open\n\n")
              // Split mid-frame so the reader has to reassemble across reads.
              write('event: preview\ndata: {"text":"hello","sou')
              await Bun.sleep(10)
              write('rce":"window"}\n\n: keepalive\n\n')
              write('event: preview\ndata: {"text":"hello world","source":"window"}\n\n')
              for (let tick = 0; tick < 200 && !stopped; tick++) await Bun.sleep(10)
              write('event: done\ndata: {"transcription":"hello world"}\n\n')
              controller.close()
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      }

      return json({ status: "error", message: "not_found" }, 404)
    },
  })
}

const socket = path.join(tmpdir(), `opencode-stt-test-${process.pid}.sock`)
const server = daemon(socket)

afterAll(async () => {
  await server.stop(true)
  await rm(socket, { force: true })
})

test("detects a listening daemon and ignores a missing one", async () => {
  expect(await available(socket)).toBe(true)
  expect(await available(path.join(tmpdir(), "opencode-stt-absent.sock"))).toBe(false)
})

test("resolves the socket path from the environment", () => {
  expect(socketPath()).toBe(
    process.env.SUPER_VOICE_HTTP_SOCKET ??
      (process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, "voice", "super-voice-http.sock") : undefined)!,
  )
})

test("mints and validates a session token", async () => {
  const session = await authorize(socket, "1.2.3")
  expect(session.token).toStartWith("stt_")
  // Whatever this build asks for: the fake daemon echoes the request back, and
  // the list grows as topics are taken up.
  expect(session.scopes).toEqual(SCOPES)
  expect(await valid(socket, session.token)).toBe(true)
  expect(await valid(socket, "stt_bogus")).toBe(false)
})

test("reads daemon status", async () => {
  const session = await authorize(socket, "1.2.3")
  // Speech to text's part of the daemon's status, not text to speech's.
  const result = await status(socket, session.token)
  expect(result.model_loaded).toBe(true)
  expect(result.current_model).toBe("whisper-tiny")
  expect(result.busy).toBe(false)
})

test("streams previews and returns the final transcription after a stop", async () => {
  const session = await authorize(socket, "1.2.3")
  const previews: string[] = []
  const transcription = await transcribe(socket, session.token, {
    onCapture: () => setTimeout(() => void stop(socket, session.token), 40),
    onPreview: (preview) => previews.push(`${preview.text}/${preview.source}`),
  })
  // Comment frames are dropped and the frame split across reads is reassembled.
  expect(previews).toEqual(["hello/window", "hello world/window"])
  expect(transcription).toBe("hello world")
})

test("aborting the stream yields no transcription", async () => {
  const session = await authorize(socket, "1.2.3")
  const controller = new AbortController()
  const transcription = await transcribe(socket, session.token, {
    signal: controller.signal,
    onCapture: () => setTimeout(() => controller.abort(), 20),
  }).catch(() => "")
  expect(transcription).toBe("")
})

test("surfaces a revoked session as a 401 so the caller can re-authorize", async () => {
  const revoking = path.join(tmpdir(), `opencode-stt-revoke-${process.pid}.sock`)
  const server = daemon(revoking, { rejectFirstToken: true })
  const session = await authorize(revoking, "1.2.3")
  const error = await transcribe(revoking, session.token, {}).catch((error) => error)
  expect(error).toBeInstanceOf(SttError)
  expect(error.status).toBe(401)
  expect(error.code).toBe("exe_changed")

  // A freshly minted token works again.
  const renewed = await authorize(revoking, "1.2.3")
  expect((await status(revoking, renewed.token)).model_loaded).toBe(true)
  await server.stop(true)
  await rm(revoking, { force: true })
})

test("reports an unreachable daemon as a typed error", async () => {
  const error = await status(path.join(tmpdir(), "opencode-stt-nothing.sock"), "stt_x").catch((error) => error)
  expect(error).toBeInstanceOf(SttError)
  expect(error.code).toBe("daemon_unreachable")
})

test("ignores the socket a crashed daemon left behind", async () => {
  const stale = path.join(tmpdir(), `opencode-stt-stale-${process.pid}.sock`)
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
