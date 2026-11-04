/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir as systmp } from "node:os"
import { DAEMON_CHECK_MS, hushMicrophone, usePromptDictation } from "../../../src/component/prompt/dictate"
import { tmpdir } from "../../fixture/fixture"
import { VoiceTestContexts } from "../../fixture/voice"

// Long enough to outlast the fallback, whatever repeat rate it measured.
const TALK_RELEASE_MAX_MS = 1500

/**
 * A daemon that takes its time opening the microphone, the way a real one does
 * while it claims the device and spins up a model.
 */
function daemon(
  socket: string,
  warmup: number,
  transcript = "a held key",
  // How the consent dialog goes: how long it stays up, and whether it is refused.
  consent?: { wait?: number; deny?: boolean },
) {
  let stopped = false
  const seen = { captures: 0, stops: 0, asked: 0 }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

  const server = Bun.serve({
    unix: socket,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/auth/request") {
        seen.asked++
        // The request is answered once the dialog is: that is the whole wait.
        if (consent?.wait) await Bun.sleep(consent.wait)
        if (consent?.deny)
          return json(
            { status: "error", error_code: "auth_denied", message: "auth_denied", data: { reason: "user_denied" } },
            403,
          )
        return json({ status: "success", session_token: "stt_hold", scopes: ["transcribe", "speak", "status", "audio_visualization", "playback_events"] })
      }
      if (url.pathname === "/v1/auth/status") return json({ status: "success" })
      if (url.pathname === "/v1/status")
        return json({
          status: "success",
          stt: { device: "cpu", model_loaded: true, current_model: "tiny", busy: false },
          tts: { device: "unknown", model_loaded: false, busy: false },
        })
      if (url.pathname === "/v1/stt/transcribe/stop") {
        seen.stops++
        stopped = true
        return json({ status: "success" })
      }
      if (url.pathname === "/v1/stt/transcribe") {
        seen.captures++
        stopped = false
        // Claiming the device and loading a model takes time, and the client
        // sits in "starting" for all of it.
        await Bun.sleep(warmup)
        return new Response(
          new ReadableStream({
            async start(controller) {
              const write = (frame: string) => controller.enqueue(new TextEncoder().encode(frame))
              write(": stream-open\n\n")
              await Bun.sleep(10)
              if (transcript)
                write(`event: preview\ndata: ${JSON.stringify({ text: transcript, source: "window" })}\n\n`)
              for (let tick = 0; tick < 400 && !stopped; tick++) await Bun.sleep(10)
              write(`event: done\ndata: ${JSON.stringify({ transcription: transcript })}\n\n`)
              controller.close()
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      }
      return json({ status: "error", message: "not_found" }, 404)
    },
  })
  return { server, seen }
}

/** Wait for a condition rather than a fixed delay, which a loaded machine outruns. */
async function until(condition: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (!condition() && Date.now() < deadline) await Bun.sleep(10)
  return condition()
}

async function mount(
  warmup: number,
  transcript = "a held key",
  extra: { monitor?: () => boolean; consent?: { wait?: number; deny?: boolean } } = {},
) {
  const socket = path.join(systmp(), `opencode-dictate-hold-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
  process.env.SUPER_VOICE_HTTP_SOCKET = socket
  const { server, seen } = daemon(socket, warmup, transcript, extra.consent)
  // A state directory of its own, which is where the token is kept: every
  // mount meets the daemon for the first time.
  const state = await tmpdir()

  const delivered: string[] = []
  let silenced = 0
  let refused = 0
  let dictation: ReturnType<typeof usePromptDictation> | undefined

  function Harness() {
    dictation = usePromptDictation({
      deliver: (text: string) => delivered.push(text),
      silence: () => silenced++,
      monitor: extra.monitor,
      refused: () => refused++,
    })
    return <text>{dictation.state}</text>
  }

  const app = await testRender(
    () => (
      <VoiceTestContexts state={state.path}>
        <Harness />
      </VoiceTestContexts>
    ),
    { width: 90, height: 6 },
  )
  await Bun.sleep(120)

  return {
    dictation: dictation!,
    delivered,
    seen,
    socket,
    stopDaemon: () => server.stop(true),
    silenced: () => silenced,
    refused: () => refused,
    hushMicrophone,
    destroy: async () => {
      app.renderer.destroy()
      void server.stop(true)
      await rm(socket, { force: true })
      await state[Symbol.asyncDispose]()
    },
  }
}

test("a press let go before the microphone opens still ends the capture", async () => {
  // The bug this covers: `end` checked for a capture already running, so a
  // release that beat the daemon was dropped and the microphone stayed open.
  const { dictation, delivered, seen, destroy } = await mount(300)
  try {
    expect(dictation.hold()).toBe(true)
    await Bun.sleep(20)
    expect(dictation.state).toBe("starting")

    dictation.release()
    // The capture opens after this, and has to close itself straight away.
    await Bun.sleep(700)
    expect(seen.stops).toBe(1)
    expect(delivered).toEqual(["a held key"])
    expect(dictation.state).toBe("idle")
  } finally {
    await destroy()
  }
})

test("the key repeating is the same press, not another one", async () => {
  // The bug this covers: every repeat ran the press again, and each press asks
  // the TTS daemon to stop speaking — hundreds of requests for one held key.
  const { dictation, seen, destroy } = await mount(20)
  try {
    expect(dictation.hold()).toBe(true)
    await Bun.sleep(60)
    expect(dictation.state).toBe("recording")

    for (let repeat = 0; repeat < 10; repeat++) {
      expect(dictation.hold()).toBe(false)
      await Bun.sleep(30)
    }
    expect(seen.captures).toBe(1)
    expect(dictation.state).toBe("recording")
  } finally {
    await destroy()
  }
})

test("repeats running out close a microphone no release ever reports", async () => {
  const { dictation, delivered, destroy } = await mount(20)
  try {
    dictation.hold()
    await Bun.sleep(60)
    // A keyboard repeating at about 30 a second, and then a key let go.
    for (let repeat = 0; repeat < 8; repeat++) {
      dictation.hold()
      await Bun.sleep(30)
    }
    expect(dictation.state).toBe("recording")

    await Bun.sleep(TALK_RELEASE_MAX_MS + 200)
    expect(dictation.state).not.toBe("recording")
    await Bun.sleep(400)
    expect(delivered).toEqual(["a held key"])
  } finally {
    await destroy()
  }
})

test("a release cancels the wait for repeats to run out", async () => {
  const { dictation, delivered, destroy } = await mount(20)
  try {
    dictation.hold()
    await Bun.sleep(60)
    for (let repeat = 0; repeat < 4; repeat++) {
      dictation.hold()
      await Bun.sleep(30)
    }
    dictation.release()
    // Far sooner than the repeats would have run out.
    await Bun.sleep(250)
    expect(delivered).toEqual(["a held key"])
    // The transcript the daemon settled on stays on screen as what was heard.
    expect(dictation.preview).toBe("a held key")
  } finally {
    await destroy()
  }
})

// The microphone belongs to a daemon that outlives the process: quitting with a
// capture open used to leave it recording, because nothing asked it to stop and
// nothing waited for the answer.
test("quitting closes a capture that is still running", async () => {
  const { dictation, seen, hushMicrophone, destroy } = await mount(20)
  try {
    dictation.hold()
    await Bun.sleep(80)
    expect(dictation.state).toBe("recording")

    const pending = hushMicrophone()
    expect(pending).toBeDefined()
    await pending
    expect(seen.stops).toBe(1)
    expect(dictation.state).toBe("idle")
  } finally {
    await destroy()
  }
})

test("quitting with nothing recording does not wait on the daemon", async () => {
  const { seen, hushMicrophone, destroy } = await mount(20)
  try {
    // Nothing to stop, so nothing to wait for: the application leaves at once.
    expect(hushMicrophone()).toBeUndefined()
    expect(seen.stops).toBe(0)
  } finally {
    await destroy()
  }
})

// A terminal that reports a key going up has proven the fallback unnecessary,
// and running it anyway races the release for the capture — which is how a
// terminal with working releases ended up being told it had none.
test("once a release is seen, repeats running out no longer close anything", async () => {
  const { dictation, delivered, destroy } = await mount(20)
  try {
    // One ordinary hold, ending the way a terminal with releases ends it.
    dictation.hold()
    await Bun.sleep(80)
    dictation.hold()
    await Bun.sleep(30)
    dictation.release()
    await Bun.sleep(300)
    expect(delivered).toEqual(["a held key"])

    // A second hold, with the repeats stopping dead and no release behind
    // them. The capture stays open, because the key never came up.
    dictation.hold()
    await Bun.sleep(80)
    for (let repeat = 0; repeat < 4; repeat++) {
      dictation.hold()
      await Bun.sleep(30)
    }
    expect(dictation.state).toBe("recording")
    await Bun.sleep(TALK_RELEASE_MAX_MS + 300)
    expect(dictation.state).toBe("recording")
    expect(delivered).toEqual(["a held key"])

    dictation.release()
    await Bun.sleep(300)
    expect(delivered).toEqual(["a held key", "a held key"])
  } finally {
    await destroy()
  }
})

// Two voices at once is neither, so the microphone opening is what quiets the
// one reading replies aloud — wherever it opens from, not just the one keybind.
test("opening the microphone asks for the voice to be quieted", async () => {
  const { dictation, silenced, destroy } = await mount(20)
  try {
    dictation.hold()
    await Bun.sleep(80)
    expect(silenced()).toBe(1)

    // The key repeating is the same press, and asks again for nothing.
    dictation.hold()
    dictation.hold()
    expect(silenced()).toBe(1)

    dictation.release()
    await Bun.sleep(300)

    // Plain dictation opens the microphone too, and used to talk over a reply.
    dictation.toggle()
    await Bun.sleep(80)
    expect(silenced()).toBe(2)
  } finally {
    await destroy()
  }
})

test("an open microphone starting its next capture does not cut a reply short", async () => {
  const { dictation, silenced, delivered, destroy } = await mount(20)
  try {
    dictation.begin({ open: true })
    await Bun.sleep(80)
    expect(silenced()).toBe(1)

    // The daemon ends each utterance on silence and the next capture follows.
    // That is the gap between two sentences, not someone deciding to talk, so
    // it must not silence a reply being read aloud.
    dictation.end()
    await Bun.sleep(400)
    expect(delivered).toEqual(["a held key"])
    expect(silenced()).toBe(1)
  } finally {
    dictation.cancel()
    await destroy()
  }
})

// A take with nothing in it is not a turn. The agent keeps working until the
// microphone closes *and* something was actually said — clearing your throat
// over a reply silences the voice, and leaves the agent alone.
test("a take that heard nothing is never delivered", async () => {
  const { dictation, delivered, silenced, seen, destroy } = await mount(20, "")
  try {
    dictation.hold()
    await Bun.sleep(80)
    // The voice stops the moment the microphone opens, whatever comes of it.
    expect(silenced()).toBe(1)
    expect(dictation.state).toBe("recording")

    dictation.release()
    await Bun.sleep(400)
    expect(seen.stops).toBe(1)
    expect(dictation.state).toBe("idle")
    // Nothing heard, so nothing to interrupt the agent with.
    expect(delivered).toEqual([])
  } finally {
    await destroy()
  }
})

test("a watched daemon that goes away is noticed, and picked up again once it is back", async () => {
  const { dictation, socket, stopDaemon, destroy } = await mount(0, "a held key", { monitor: () => true })
  try {
    expect(dictation.ready).toBe(true)
    expect(dictation.reachable).toBe(true)

    await stopDaemon()
    expect(await until(() => !dictation.reachable, DAEMON_CHECK_MS + 1000)).toBe(true)
    // The talk key goes with it, rather than promising a microphone.
    expect(dictation.ready).toBe(false)

    const back = daemon(socket, 0)
    try {
      expect(await until(() => dictation.reachable && dictation.ready, DAEMON_CHECK_MS + 1000)).toBe(true)
    } finally {
      await back.server.stop(true)
    }
  } finally {
    await destroy()
  }
})

test("asks for the microphone once, however many ask while the dialog is up", async () => {
  const { dictation, seen, destroy } = await mount(0, "a held key", { consent: { wait: 300 } })
  try {
    // The mode coming on asks, and the talk key goes down before anyone answers.
    const asking = dictation.prepare()
    dictation.hold()
    await asking
    expect(seen.asked).toBe(1)
    expect(seen.captures).toBe(0)

    // Answered once, and the press that waited on it goes ahead.
    expect(await until(() => dictation.state === "recording")).toBe(true)
    expect(seen.asked).toBe(1)
    dictation.release()
  } finally {
    await destroy()
  }
})

test("a microphone refused before anything is said tells whoever depends on it", async () => {
  const { dictation, seen, refused, destroy } = await mount(0, "a held key", { consent: { deny: true } })
  try {
    await dictation.prepare()
    expect(seen.asked).toBe(1)
    expect(refused()).toBe(1)
    expect(seen.captures).toBe(0)
  } finally {
    await destroy()
  }
})
