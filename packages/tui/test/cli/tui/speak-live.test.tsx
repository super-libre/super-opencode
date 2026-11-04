/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { afterAll, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir as systmp } from "node:os"
import type { OpenCodeEvent } from "@opencode/client"
import { DAEMON_CHECK_MS } from "../../../src/component/prompt/dictate"
import { hushVoice, SpeechProvider, useSpeech, type Speech } from "../../../src/component/prompt/speak"
import { ClientProvider } from "../../../src/context/client"
import { useToast } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { createApi, createEventStream, createFetch } from "../../fixture/tui-client"
import { VoiceTestContexts } from "../../fixture/voice"

// The session the voice follows: the one a prompt would be showing.
const SESSION = "ses_1"

type Seen = {
  auth: number
  started: number
  deltas: string[]
  ended: number
  spoken: string[]
  stopped: number
  busy: boolean
  /** Set to refuse the next authorized request the way a revoked token is refused. */
  revoked?: boolean
  /** How long the consent dialog stays up before it is answered. */
  consent?: number
}

// Subscribers to `GET /events`. The daemon publishes the end of the *audio*
// here, long after the streaming session's `done` frame.
const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>()

function publish(payload: Record<string, unknown>) {
  const frame = new TextEncoder().encode(`event: speaking_state\ndata: ${JSON.stringify(payload)}\n\n`)
  for (const listener of listeners) {
    // A subscriber whose daemon has been stopped is gone, not a failure.
    try {
      listener.enqueue(frame)
    } catch {
      listeners.delete(listener)
    }
  }
}

/** Wait for a condition rather than a fixed delay, which a loaded machine outruns. */
async function until(condition: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (!condition() && Date.now() < deadline) await Bun.sleep(10)
  return condition()
}

/**
 * `queueing` is how long `POST /speak` takes to answer. The real daemon answers
 * once the whole reply is queued, so a backend that synthesizes at about the
 * speed of speech leaves the request open for most of the utterance — which is
 * where a press to stop it lands.
 */
function daemon(socket: string, seen: Seen, queueing = 0) {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

  return Bun.serve<{ id: string }>({
    unix: socket,
    async fetch(request, instance) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/auth/request") {
        seen.auth++
        if (seen.consent) await Bun.sleep(seen.consent)
        seen.revoked = false
        return json({
          status: "success",
          session_token: "tts_live",
          scopes: ["transcribe", "speak", "status", "audio_visualization", "playback_events"],
          expires_at: "2099-01-01T00:00:00Z",
        })
      }
      // Always refuse a stored token, so whatever a test does that needs one
      // goes through consent and can be counted.
      if (url.pathname === "/v1/auth/status")
        return json({ status: "error", message: "invalid_session", data: { reason: "expired" } }, 401)
      if (url.pathname === "/v1/status")
        return json({
          status: "success",
          stt: { device: "unknown", model_loaded: false, busy: false },
          tts: { device: "cpu", model_loaded: true, current_model: "kokoro-82m", busy: seen.busy },
        })
      if (url.pathname === "/v1/tts/speak/stop") {
        // A token the daemon has revoked, because the binary it was minted for
        // changed on disk while opencode was running.
        if (seen.revoked)
          return json({ status: "error", message: "invalid_session", data: { reason: "exe_changed" } }, 401)
        seen.stopped++
        const spoke = seen.busy
        seen.busy = false
        if (spoke) publish({ is_speaking: false, utterance_id: "utt_replay" })
        return json({ status: "success", ...(spoke ? { utterance_id: "utt_replay" } : {}) })
      }
      if (url.pathname === "/v1/tts/speak") {
        seen.spoken.push(((await request.json()) as { text?: string }).text ?? "")
        seen.busy = true
        // The utterance is announced as it starts, long before the request is
        // answered: the answer only comes once the whole reply is queued.
        publish({ is_speaking: true, utterance_id: "utt_replay" })
        if (queueing) await Bun.sleep(queueing)
        return json({ status: "success", utterance_id: "utt_replay" }, 202)
      }
      if (url.pathname === "/v1/events") {
        let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            subscriber = controller
            listeners.add(controller)
            controller.enqueue(new TextEncoder().encode('event: subscribed\ndata: {"client_id":"sub_1"}\n\n'))
          },
          cancel() {
            if (subscriber) listeners.delete(subscriber)
          },
        })
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
      }
      if (url.pathname === "/v1/tts/speak/stream") {
        if (instance.upgrade(request, { data: { id: "utt_1" } })) return
        return json({ status: "error", message: "expected upgrade" }, 400)
      }
      return json({ status: "error", message: "not_found" }, 404)
    },
    websocket: {
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as { type: string; delta?: string }
        if (frame.type === "start") {
          seen.started++
          // `start` names nothing: voice, language, speed and instructions are
          // all Super TTS's settings, and naming one closes the session.
          expect(frame).toEqual({ type: "start" })
          ws.send(JSON.stringify({ type: "utterance", id: ws.data.id }))
          publish({ is_speaking: true, utterance_id: ws.data.id })
        }
        if (frame.type === "text") {
          seen.deltas.push(frame.delta ?? "")
          // The daemon reports progress after each delta; 600ms is still queued.
          ws.send(JSON.stringify({ type: "progress", spoken_ms: 0, queued_ms: 600 }))
        }
        if (frame.type === "end") {
          seen.ended++
          ws.send(JSON.stringify({ type: "done", id: ws.data.id, chunks: 1 }))
        }
      },
    },
  })
}

let sequence = 0

function event(type: string, data: Record<string, unknown>, session = SESSION) {
  sequence++
  return {
    id: `evt_${sequence}`,
    created: Date.now(),
    type,
    data: { sessionID: session, ...data },
    durable: { aggregateID: session, seq: sequence, version: 1 },
  } as unknown as OpenCodeEvent
}

/** A piece of a reply's text as it streams. */
const delta = (message: string, text: string, session = SESSION) =>
  event("session.text.delta", { assistantMessageID: message, ordinal: 0, delta: text }, session)
/** A piece of a reply's text finished, carrying its whole value. */
const ended = (message: string, text: string) =>
  event("session.text.ended", { assistantMessageID: message, ordinal: 0, text })
/** What the model thinks to itself, which has events of its own. */
const thought = (message: string, text: string) =>
  event("session.reasoning.delta", { assistantMessageID: message, ordinal: 0, delta: text })
/** The step that wrote a reply is over. */
const finished = (message: string) =>
  event("session.step.ended", {
    assistantMessageID: message,
    finish: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })

const states: { [Symbol.asyncDispose](): Promise<void> }[] = []
afterAll(() => Promise.all(states.map((state) => state[Symbol.asyncDispose]())))

async function mount(saved?: { interactive?: boolean; listen?: "push" | "open" }) {
  const state = await tmpdir()
  states.push(state)
  // What a previous run left behind, where the TUI keeps its saved state.
  if (saved) {
    const directory = path.join(state.path, "test", "tui")
    await mkdir(directory, { recursive: true })
    await Bun.write(
      path.join(directory, "voice.json"),
      JSON.stringify({ interactive: false, listen: "push", ...saved }),
    )
  }

  const events = createEventStream()
  const calls = createFetch(undefined, events)
  let speech: Speech | undefined
  let toast: ReturnType<typeof useToast> | undefined

  function Harness() {
    speech = useSpeech()
    speech.follow(SESSION)
    toast = useToast()
    return <text>{speech.interactive ? "on" : "off"}</text>
  }

  const app = await testRender(
    () => (
      <VoiceTestContexts state={state.path}>
        <ClientProvider api={createApi(calls.fetch)}>
          <SpeechProvider>
            <Harness />
          </SpeechProvider>
        </ClientProvider>
      </VoiceTestContexts>
    ),
    { width: 60, height: 5 },
  )

  // The render is not synchronous with `testRender` resolving, so the hook may
  // not have run yet.
  if (!(await until(() => speech !== undefined))) throw new Error("the speech harness never mounted")
  return { app, events, speech: speech!, hushVoice, toast: () => toast?.currentToast }
}

function reply(events: { emit: (event: OpenCodeEvent) => void }, message: string, text: string) {
  events.emit(ended(message, text))
}

test("asks for consent as soon as speech is enabled, then streams the reply", async () => {
  const socket = path.join(systmp(), `opencode-speak-live-${process.pid}.sock`)
  process.env.SUPER_VOICE_HTTP_SOCKET = socket
  const seen: Seen = { auth: 0, started: 0, deltas: [], ended: 0, spoken: [], stopped: 0, busy: false }
  const server = daemon(socket, seen)

  const { app, events, speech } = await mount()

  await Bun.sleep(120)
  expect(seen.auth).toBe(0)

  // Enabling is what triggers consent — not the first reply, which would put the
  // dialog in the middle of one and lose its opening sentences.
  speech.toggle()
  await Bun.sleep(300)
  expect(seen.auth).toBe(1)
  expect(seen.started).toBe(0)

  // What the model thinks to itself has events of its own, so none of it can
  // reach the daemon.
  events.emit(thought("msg_1", "the user probably wants"))
  // Nor can another session's reply: a subagent working, or another tab.
  events.emit(delta("msg_other", "Elsewhere entirely.", "ses_other"))
  await Bun.sleep(150)
  expect(seen.started).toBe(0)
  expect(seen.deltas).toEqual([])

  events.emit(delta("msg_1", "The kettle is "))
  events.emit(delta("msg_1", "boiling."))
  await Bun.sleep(300)
  expect(seen.started).toBe(1)
  expect(seen.deltas.join("")).toBe("The kettle is boiling.")

  // Its end carries the whole value, which says nothing new here.
  events.emit(ended("msg_1", "The kettle is boiling."))
  // The step being over plays out what remains.
  events.emit(finished("msg_1"))
  await Bun.sleep(200)
  expect(seen.ended).toBe(1)

  // `done` only means every sample is queued: a backend faster than realtime
  // gets there while most of the reply is still buffered ahead of the speakers.
  expect(speech.speaking).toBe(true)

  // Well past the 600ms the progress frame reported as queued. Guessing from
  // that frame is what used to drop the indicator early — only the daemon knows
  // when the audio actually ran out, and it has not said so yet.
  await Bun.sleep(900)
  expect(speech.speaking).toBe(true)

  publish({ is_speaking: false, utterance_id: "utt_1" })
  expect(await until(() => speech.speaking === false)).toBe(true)

  app.renderer.destroy()
  server.stop(true)
  await rm(socket, { force: true })
})

test("plays a written reply, without speech ever having been switched on", async () => {
  const socket = path.join(systmp(), `opencode-speak-play-${process.pid}.sock`)
  process.env.SUPER_VOICE_HTTP_SOCKET = socket
  const seen: Seen = { auth: 0, started: 0, deltas: [], ended: 0, spoken: [], stopped: 0, busy: false }
  listeners.clear()
  const server = daemon(socket, seen)

  const { app, speech } = await mount()
  await Bun.sleep(120)

  // Speech stays off for the whole test. The control speaks a reply the
  // transcript already holds, so it plays one that arrived before this process
  // did — nothing here is watched off the event stream.
  expect(speech.interactive).toBe(false)
  expect(speech.speaking).toBe(false)

  await speech.play("The kettle is boiling.", "msg_1")

  // Consent is asked for here, at the first thing that would make a sound. The
  // written reply goes out in one piece rather than through a speak session,
  // which has nothing left to stream.
  expect(seen.auth).toBe(1)
  expect(seen.spoken).toEqual(["The kettle is boiling."])
  expect(seen.started).toBe(0)
  expect(speech.speaking).toBe(true)
  // Which reply is talking, so the control that asked can say so.
  expect(speech.source).toBe("msg_1")

  expect(await until(() => listeners.size > 0)).toBe(true)
  publish({ is_speaking: false, utterance_id: "utt_replay" })
  expect(await until(() => speech.speaking === false)).toBe(true)
  expect(speech.source).toBeUndefined()

  app.renderer.destroy()
  server.stop(true)
  await rm(socket, { force: true })
})

test("stops the reply it is playing when asked a second time", async () => {
  const socket = path.join(systmp(), `opencode-speak-stop-${process.pid}.sock`)
  process.env.SUPER_VOICE_HTTP_SOCKET = socket
  const seen: Seen = { auth: 0, started: 0, deltas: [], ended: 0, spoken: [], stopped: 0, busy: false }
  listeners.clear()
  const server = daemon(socket, seen)

  const { app, speech } = await mount()
  await Bun.sleep(120)

  // One press is all the control and the `o` shortcut do; the second is the
  // same call again, and it is the daemon that says which of the two it is.
  const press = () => speech.play("The kettle is boiling.", "msg_1")

  await press()
  expect(seen.spoken.length).toBe(1)
  expect(speech.speaking).toBe(true)
  expect(speech.source).toBe("msg_1")

  await press()
  expect(await until(() => seen.stopped === 1)).toBe(true)
  expect(speech.speaking).toBe(false)
  // And it stopped rather than started over.
  expect(seen.spoken.length).toBe(1)

  app.renderer.destroy()
  server.stop(true)
  await rm(socket, { force: true })
})

test("stops a reply the daemon is still queueing, rather than starting it over", async () => {
  const socket = path.join(systmp(), `opencode-speak-slow-${process.pid}.sock`)
  process.env.SUPER_VOICE_HTTP_SOCKET = socket
  const seen: Seen = { auth: 0, started: 0, deltas: [], ended: 0, spoken: [], stopped: 0, busy: false }
  listeners.clear()
  const server = daemon(socket, seen, 400)

  const { app, speech } = await mount()
  await Bun.sleep(120)

  // The press that starts it. Its request stays open while the reply is spoken,
  // so this is what the second press interrupts.
  const queueing = speech.play("The kettle is boiling.", "msg_1")
  expect(await until(() => seen.spoken.length === 1)).toBe(true)
  expect(speech.speaking).toBe(true)

  await speech.play("The kettle is boiling.", "msg_1")
  expect(await until(() => seen.stopped === 1)).toBe(true)
  expect(speech.speaking).toBe(false)
  // The reply was stopped, not spoken a second time.
  expect(seen.spoken.length).toBe(1)

  // The first request answering afterwards is about an utterance that is over.
  await queueing
  await Bun.sleep(50)
  expect(speech.speaking).toBe(false)
  expect(seen.spoken.length).toBe(1)

  app.renderer.destroy()
  server.stop(true)
  await rm(socket, { force: true })
})

test("stops a reply the indicator has lost track of", async () => {
  const socket = path.join(systmp(), `opencode-speak-stale-${process.pid}.sock`)
  process.env.SUPER_VOICE_HTTP_SOCKET = socket
  const seen: Seen = { auth: 0, started: 0, deltas: [], ended: 0, spoken: [], stopped: 0, busy: false }
  listeners.clear()
  const server = daemon(socket, seen)

  const { app, speech } = await mount()
  await Bun.sleep(120)

  await speech.play("The kettle is boiling.", "msg_1")
  expect(await until(() => speech.speaking)).toBe(true)

  // Something makes the indicator let go while the speakers are still busy —
  // here another utterance claiming them, elsewhere a frame that never arrived
  // or a subscription that dropped. Whatever the reason, the press that follows
  // has to reach silence rather than start the reply over.
  publish({ is_speaking: true, utterance_id: "utt_elsewhere" })
  expect(await until(() => speech.speaking === false)).toBe(true)
  expect(seen.busy).toBe(true)

  await speech.play("The kettle is boiling.", "msg_1")
  expect(await until(() => seen.stopped === 1)).toBe(true)
  expect(seen.spoken.length).toBe(1)
  expect(seen.busy).toBe(false)

  app.renderer.destroy()
  server.stop(true)
  await rm(socket, { force: true })
})

// The voice belongs to a daemon that outlives the process: audio already queued
// plays on after the interface is gone, so quitting has to ask it to stop and
// wait for the answer rather than firing the request and dying.
test("quitting stops the voice, and waits for the daemon to say so", async () => {
  const socket = path.join(systmp(), `opencode-speak-hush-${process.pid}.sock`)
  process.env.SUPER_VOICE_HTTP_SOCKET = socket
  const seen: Seen = { auth: 0, started: 0, deltas: [], ended: 0, spoken: [], stopped: 0, busy: false }
  const server = daemon(socket, seen)
  const { app, speech, hushVoice } = await mount()

  try {
    await speech.play("The kettle is boiling.", "msg_1")
    expect(seen.spoken).toEqual(["The kettle is boiling."])

    const pending = hushVoice()
    expect(pending).toBeDefined()
    await pending
    // Awaited, not fired into the dark: the daemon has already answered.
    expect(seen.stopped).toBe(1)
  } finally {
    app.renderer.destroy()
    server.stop(true)
    await rm(socket, { force: true })
  }
})

test("quitting without ever having spoken does not wait on the daemon", async () => {
  const socket = path.join(systmp(), `opencode-speak-quiet-${process.pid}.sock`)
  process.env.SUPER_VOICE_HTTP_SOCKET = socket
  const seen: Seen = { auth: 0, started: 0, deltas: [], ended: 0, spoken: [], stopped: 0, busy: false }
  const server = daemon(socket, seen)
  const { app, hushVoice } = await mount()

  try {
    // No session was ever minted, so there is nothing to stop and nothing to
    // hold the application open on the way out.
    expect(hushVoice()).toBeUndefined()
    expect(seen.stopped).toBe(0)
  } finally {
    app.renderer.destroy()
    server.stop(true)
    await rm(socket, { force: true })
  }
})

// Silencing a reply that is still being written has to stick. Generation does
// not stop because the listener stopped listening, and every delta that follows
// used to open a new session and carry on reading out the very thing that was
// just cut off — which is why the microphone appeared to do nothing.
test("a reply silenced mid-sentence is not picked up again by the next delta", async () => {
  const socket = path.join(systmp(), `opencode-speak-abandon-${process.pid}.sock`)
  process.env.SUPER_VOICE_HTTP_SOCKET = socket
  const seen: Seen = { auth: 0, started: 0, deltas: [], ended: 0, spoken: [], stopped: 0, busy: false }
  const server = daemon(socket, seen)
  const { app, events, speech } = await mount()

  try {
    speech.toggle()
    await Bun.sleep(300)

    events.emit(delta("msg_1", "The kettle is"))
    await Bun.sleep(300)
    expect(seen.started).toBe(1)
    expect(seen.deltas.join("")).toBe("The kettle is")

    // What opening the microphone does.
    speech.stop()
    await Bun.sleep(100)
    expect(seen.stopped).toBe(1)

    // The agent writes on regardless; none of it should be read out.
    events.emit(delta("msg_1", " boiling, and the tea is ready."))
    events.emit(ended("msg_1", "The kettle is boiling, and the tea is ready."))
    events.emit(finished("msg_1"))
    await Bun.sleep(400)
    expect(seen.started).toBe(1)
    expect(seen.deltas.join("")).toBe("The kettle is")

    // A reply that starts after the interruption is a different reply, and is
    // read out as usual.
    events.emit(delta("msg_2", "Right away."))
    await Bun.sleep(400)
    expect(seen.started).toBe(2)
    expect(seen.deltas.join("")).toBe("The kettle isRight away.")
  } finally {
    app.renderer.destroy()
    server.stop(true)
    await rm(socket, { force: true })
  }
})

// The daemon watches the binary a token was minted for and revokes the token
// when it changes — which, while opencode is being rebuilt, happens in the
// middle of a session. A stop refused for that cannot simply fail: the voice is
// still talking, and nothing on screen would explain why.
test("a stop refused by a revoked token mints a new one and stops anyway", async () => {
  const socket = path.join(systmp(), `opencode-speak-revoked-${process.pid}.sock`)
  process.env.SUPER_VOICE_HTTP_SOCKET = socket
  const seen: Seen = { auth: 0, started: 0, deltas: [], ended: 0, spoken: [], stopped: 0, busy: false }
  const server = daemon(socket, seen)
  const { app, speech, hushVoice } = await mount()

  try {
    await speech.play("The kettle is boiling.", "msg_1")
    expect(seen.spoken).toEqual(["The kettle is boiling."])
    expect(seen.auth).toBe(1)

    // The binary changed on disk, so the token this session holds is dead.
    seen.revoked = true

    await hushVoice()
    // Minted again and asked a second time, rather than left talking.
    expect(seen.auth).toBe(2)
    expect(seen.stopped).toBe(1)
  } finally {
    app.renderer.destroy()
    server.stop(true)
    await rm(socket, { force: true })
  }
})

test("a daemon that goes away is said, not the end of interactive mode, and is picked up again", async () => {
  const socket = path.join(systmp(), `opencode-speak-gone-${process.pid}.sock`)
  process.env.SUPER_VOICE_HTTP_SOCKET = socket
  const seen: Seen = { auth: 0, started: 0, deltas: [], ended: 0, spoken: [], stopped: 0, busy: false }
  let server = daemon(socket, seen)
  const { app, events, speech, toast } = await mount()

  try {
    speech.toggle()
    expect(await until(() => seen.auth === 1)).toBe(true)
    expect(speech.reachable).toBe(true)

    // A reply straight after, before any check has had a chance to notice: it
    // is the reply that finds the daemon gone.
    await server.stop(true)
    reply(events, "msg_gone", "Nobody hears this.")
    expect(await until(() => !speech.reachable)).toBe(true)
    await Bun.sleep(200)
    // The prompt says so. A toast per reply would say it again every time, and
    // leaving would end the conversation over a daemon restart.
    expect(speech.interactive).toBe(true)
    expect(toast()).toBeNull()

    server = daemon(socket, seen)
    expect(await until(() => speech.reachable, DAEMON_CHECK_MS + 1000)).toBe(true)
    reply(events, "msg_back", "Now you hear me.")
    expect(await until(() => seen.deltas.join("") === "Now you hear me.")).toBe(true)
  } finally {
    app.renderer.destroy()
    await server.stop(true)
    await rm(socket, { force: true })
  }
})

test("switched on with no daemon, interactive mode stays on and says so", async () => {
  const socket = path.join(systmp(), `opencode-speak-absent-${process.pid}.sock`)
  process.env.SUPER_VOICE_HTTP_SOCKET = socket
  await rm(socket, { force: true })
  const { app, speech, toast } = await mount()

  try {
    speech.toggle()
    expect(await until(() => !speech.reachable, DAEMON_CHECK_MS + 1000)).toBe(true)
    // Switching on asks for consent at once, and finds nobody to ask. The mode
    // stays on to say why it is quiet — and to be left, whatever the daemon.
    await Bun.sleep(300)
    expect(speech.interactive).toBe(true)
    expect(toast()).toBeNull()
    expect(speech.ready).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("a restart that finds interactive mode on asks for consent straight away", async () => {
  const socket = path.join(systmp(), `opencode-speak-restored-${process.pid}.sock`)
  process.env.SUPER_VOICE_HTTP_SOCKET = socket
  const seen: Seen = { auth: 0, started: 0, deltas: [], ended: 0, spoken: [], stopped: 0, busy: false }
  const server = daemon(socket, seen)
  // Remembered from last time: on, and nobody has switched anything.
  const { app, speech } = await mount({ interactive: true })

  try {
    expect(speech.interactive).toBe(true)
    expect(await until(() => seen.auth === 1)).toBe(true)
  } finally {
    app.renderer.destroy()
    await server.stop(true)
    await rm(socket, { force: true })
  }
})

test("one consent dialog, however many ask while it is up", async () => {
  const socket = path.join(systmp(), `opencode-speak-once-${process.pid}.sock`)
  process.env.SUPER_VOICE_HTTP_SOCKET = socket
  const seen: Seen = { auth: 0, started: 0, deltas: [], ended: 0, spoken: [], stopped: 0, busy: false, consent: 300 }
  const server = daemon(socket, seen)
  const { app, events, speech } = await mount()

  try {
    // The prompt waits on the same asking before it puts up the microphone's.
    speech.toggle()
    const waiting = speech.prepare()
    // And the agent answers before anyone has clicked anything.
    await Bun.sleep(50)
    reply(events, "msg_early", "Straight in.")

    await waiting
    expect(await until(() => seen.deltas.join("") === "Straight in.")).toBe(true)
    expect(seen.auth).toBe(1)
  } finally {
    app.renderer.destroy()
    await server.stop(true)
    await rm(socket, { force: true })
  }
})
