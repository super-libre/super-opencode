#!/usr/bin/env bun
// Exercise the Super Voice speech integration end to end without launching the TUI.
//
//   bun run --cwd packages/tui script/speech-check.ts
//   bun run --cwd packages/tui script/speech-check.ts "say this instead"
//
// Walks the same path the prompt does — socket, consent, model, one-shot speak,
// then the streaming session — and prints where it stops when it stops. The
// first run raises a consent dialog that has to be approved.

import {
  authorize,
  available,
  silence,
  socketPath,
  speak,
  speaking,
  satisfies,
  status,
  stream,
  TtsError,
  valid,
} from "../src/tts/client"
import { read, write } from "../src/voice/session"
import { Global } from "@opencode/util/global"

const phrase = process.argv.slice(2).join(" ") || "Super Voice is wired up. This is opencode reading a reply out loud."

const started = Date.now()
const at = () => `${((Date.now() - started) / 1000).toFixed(2)}s`
const step = (message: string) => console.log(`  ${at().padStart(6)}  ${message}`)
const fail = (message: string, hint?: string) => {
  console.log(`\n  ✗ ${message}`)
  if (hint) console.log(`    ${hint}`)
  process.exit(1)
}

console.log("\nSuper Voice speech check\n")

const socket = socketPath()
if (!socket) fail("XDG_RUNTIME_DIR is not set, so the daemon socket cannot be located.")
step(`socket   ${socket}`)

if (!(await available(socket!)))
  fail("The Super Voice daemon is not running.", "Start it with: systemctl --user start super-voice")
step("daemon   listening")

let session = await read(Global.Path.state)
if (session && satisfies(session) && (await valid(socket!, session.token)))
  step("auth     reusing the stored session token")
else {
  step("auth     requesting consent — APPROVE THE DIALOG")
  session = await authorize(socket!, "speech-check").catch((error: unknown) => {
    if (error instanceof TtsError && error.code === "popup_failed")
      fail(
        "The daemon could not show its consent dialog.",
        "It only looks for super-voice-consent beside its own binary — check that it is there.",
      )
    if (error instanceof TtsError && error.code.startsWith("user_")) fail(`Consent was not granted (${error.code}).`)
    fail(error instanceof Error ? error.message : String(error))
    return undefined as never
  })
  await write(Global.Path.state, session).catch(() => step("auth     (token could not be persisted)"))
  step(`auth     granted, scopes: ${session.scopes.join(", ")}`)
}

const current = await status(socket!, session!.token).catch(() => undefined)
if (!current) fail("The daemon accepted the token but would not report its status.")
if (!current!.model_loaded)
  fail("No speech model is loaded.", "Open the Super TTS app and load one, then run this again.")
step(`model    ${current!.current_model ?? "unknown"} on ${current!.device}`)

// One-shot: the whole phrase at once.
step(`speak    "${phrase}"`)
await speak(socket!, session!.token, phrase).catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error))
})
step("speak    queued — you should be hearing it now")
await Bun.sleep(4000)
await silence(socket!, session!.token).catch(() => undefined)

// `speaking_state` is the only thing that knows when the voice actually stopped;
// the stream's `done` frame only means every sample is queued.
const watching = new AbortController()
let quiet: number | undefined
let utterance: string | undefined
const watcher = (async () => {
  for await (const frame of speaking(socket!, session!.token, watching.signal)) {
    if (frame.speaking) continue
    if (frame.utterance && frame.utterance !== utterance) continue
    quiet = Date.now()
  }
})().catch(() => step("events   (speaking_state is unavailable — is the playback_events scope granted?)"))

// Streaming: the path the agent's replies actually take.
step("stream   opening a speak session")
let done = false
const open = await stream(socket!, session!.token, {
  onUtterance: (id) => (utterance = id),
  onDone: () => (done = true),
  onError: (message) => fail(`the daemon rejected the stream: ${message}`),
}).catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error))
  return undefined as never
})

// Deltas mid-word and mid-markup, the way generated text actually arrives.
for (const delta of ["Streaming ", "wor", "ks too. ", "**Mark", "up** is ", "stripped by the daemon."]) {
  open.text(delta)
  await Bun.sleep(120)
}
open.end()
step("stream   sent, waiting for the utterance to finish")

for (let tick = 0; tick < 100 && !done; tick++) await Bun.sleep(100)
if (!done) fail("The daemon never reported the utterance as done.")
const queued = Date.now()
step("stream   done — every sample is queued, not yet heard")

for (let tick = 0; tick < 200 && quiet === undefined; tick++) await Bun.sleep(100)
watching.abort()
await watcher
if (quiet === undefined) fail("The daemon never reported the speakers going quiet.")
// The gap is what an indicator driven by `done` would cut off, and on a backend
// faster than realtime it is most of the utterance.
step(`playout  quiet ${((quiet! - queued) / 1000).toFixed(2)}s after done`)

console.log(`\n  ✓ both the one-shot and streaming paths work (${at()})\n`)
