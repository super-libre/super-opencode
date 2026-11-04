/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir as systmp } from "node:os"
import { DictateButton, DictatePreview, usePromptDictation } from "../../../src/component/prompt/dictate"
import { tmpdir } from "../../fixture/fixture"
import { VoiceTestContexts } from "../../fixture/voice"

// A daemon that streams previews on a cadence, so the hook is driven exactly as
// the real one drives it.
function daemon(socket: string) {
  let stopped = false
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

  return Bun.serve({
    unix: socket,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/auth/request")
        return json({ status: "success", session_token: "stt_live", scopes: ["transcribe", "speak", "status", "audio_visualization", "playback_events"] })
      if (url.pathname === "/v1/auth/status") return json({ status: "success" })
      if (url.pathname === "/v1/status")
        return json({
          status: "success",
          stt: { device: "cpu", model_loaded: true, current_model: "whisper-tiny", busy: false },
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
              await Bun.sleep(30)
              write('event: preview\ndata: {"text":"hello from the mic","source":"window"}\n\n')
              for (let tick = 0; tick < 200 && !stopped; tick++) await Bun.sleep(10)
              write('event: done\ndata: {"transcription":"hello from the mic"}\n\n')
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

test("streams live preview text into the prompt footer, then inserts the final transcript", async () => {
  const socket = path.join(systmp(), `opencode-dictate-live-${process.pid}.sock`)
  process.env.SUPER_VOICE_HTTP_SOCKET = socket
  const server = daemon(socket)
  await using state = await tmpdir()

  const inserted: string[] = []
  let toggle: (() => void) | undefined

  function Harness() {
    const dictation = usePromptDictation({ deliver: (text: string) => inserted.push(text) })
    toggle = dictation.toggle
    return (
      <>
        <DictatePreview dictation={dictation} />
        <box flexDirection="row" gap={1}>
          <DictateButton dictation={dictation} />
        </box>
      </>
    )
  }

  const app = await testRender(
    () => (
      <VoiceTestContexts state={state.path}>
        <Harness />
      </VoiceTestContexts>
    ),
    { width: 100, height: 8 },
  )

  // Let onMount probe the socket so the control becomes available.
  await Bun.sleep(100)
  expect(app.captureCharFrame()).toContain("◉ dictate")

  toggle!()
  // Capture is running and the first preview has been streamed.
  await Bun.sleep(400)
  const recording = app.captureCharFrame()
  expect(recording).toContain("● stop")
  expect(recording).toContain("hello from the mic")

  toggle!()
  await Bun.sleep(400)
  expect(inserted).toEqual(["hello from the mic"])

  app.renderer.destroy()
  server.stop(true)
  await rm(socket, { force: true })
})
