import * as Daemon from "../voice/daemon"

// Client for Super Voice's speech-to-text feature: its routes are under
// /v1/stt, with Server-Sent Events for streaming transcriptions. The transport,
// the token and the routes the daemon has once are ../voice/daemon's.

export { APP_NAME, SCOPES, available, satisfies, socketPath, valid } from "../voice/daemon"
export type { Session } from "../voice/daemon"

/** The shortest gap between two spectrum frames handed to a caller. */
const SPECTRUM_MIN_INTERVAL_MS = 40

export type StopMode = "silence_only" | "silence_and_manual" | "manual_only"

export type Preview = {
  text: string
  // "stream" extends the previous frame (realtime models), "window" replaces it
  // (the daemon re-transcribing a sliding window). Absent on older daemons.
  source?: "stream" | "window"
}

/** One `frequency_bands` frame: the microphone's spectrum, and the frame's energy. */
export type Spectrum = {
  bands: Float32Array
  energy: number
}

/** Speech to text's part of `GET /v1/status`. */
export type Status = Daemon.FeatureStatus

export class SttError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = "SttError"
    this.code = code
    this.status = status
  }
}

const make: Daemon.MakeError = (message, code, status) => new SttError(message, code, status)

function send(
  socket: string,
  method: string,
  endpoint: string,
  options?: { token?: string; body?: unknown; accept?: string; signal?: AbortSignal },
) {
  return Daemon.send(socket, method, endpoint, make, options)
}

/**
 * Trigger the consent popup and mint a session token. The daemon binds the
 * token to the calling binary, so a token minted here stops working if the
 * opencode executable changes (`exe_changed`).
 */
export function authorize(socket: string, version: string) {
  return Daemon.authorize(socket, version, make)
}

/** Speech to text's model and device, and whether a capture is under way. */
export async function status(socket: string, token: string): Promise<Status> {
  return (await Daemon.status(socket, token, make)).stt
}

/**
 * Stop an in-flight daemon-mic capture. The final transcription still arrives
 * on the connection that started it, which is why a toggle-off calls this
 * rather than closing that connection — a disconnect drops undelivered output.
 */
export async function stop(socket: string, token: string) {
  await send(socket, "POST", "/stt/transcribe/stop", { token })
}

/**
 * Start a daemon-mic capture and resolve with the final transcription. The
 * daemon owns the microphone; opencode never touches audio. Aborting the
 * signal closes the stream, which the daemon treats as a stop that discards
 * any result still in flight.
 */
export async function transcribe(
  socket: string,
  token: string,
  options: {
    language?: string
    stopMode?: StopMode
    /**
     * Whether the daemon plays its start and stop cues for this capture. Left
     * out, it follows the configured audio theme. Per-request, so it needs no
     * `settings` scope and leaves nothing to restore if we die mid-take.
     */
    audioCues?: boolean
    signal?: AbortSignal
    onPreview?: (preview: Preview) => void
    onCapture?: () => void
  },
) {
  const response = await send(socket, "POST", "/stt/transcribe", {
    token,
    accept: "text/event-stream",
    signal: options.signal,
    body: {
      wait: true,
      stream_realtime: true,
      write_mode: false,
      ...(options.language ? { language: options.language } : {}),
      ...(options.stopMode ? { stop_mode: options.stopMode } : {}),
      ...(options.audioCues === undefined ? {} : { audio_cues: options.audioCues }),
    },
  })
  if (!response.body) throw new SttError("daemon returned no transcription stream", "empty_stream", response.status)

  options.onCapture?.()

  let transcription = ""
  for await (const frame of Daemon.frames(response.body, options.signal)) {
    if (frame.event === "preview") {
      const data = parse(frame.data) as Preview | undefined
      if (data?.text !== undefined) options.onPreview?.(data)
      continue
    }
    if (frame.event === "done") {
      transcription = (parse(frame.data) as { transcription?: string } | undefined)?.transcription ?? ""
      break
    }
    if (frame.event === "error") {
      const message = (parse(frame.data) as { message?: string } | undefined)?.message
      throw new SttError(message ?? "transcription failed", "transcribe_failed", 500)
    }
  }
  return transcription
}

/**
 * The microphone's spectrum while a capture runs, from the daemon's event
 * stream: 64 frequency bands and the frame's total energy, published at the
 * audio callback rate.
 *
 * This is the only live signal a capture has. Preview text is the model's
 * business — a realtime one streams as you speak, and a batch one says nothing
 * at all until the capture ends — but the spectrum is measured from the device
 * and arrives either way.
 */
export async function* spectrum(socket: string, token: string, signal?: AbortSignal): AsyncGenerator<Spectrum> {
  let last = 0
  const response = await send(socket, "GET", "/events?topics=frequency_bands", {
    token,
    accept: "text/event-stream",
    signal,
  })
  if (!response.body) return

  for await (const frame of Daemon.frames(response.body, signal)) {
    if (frame.event !== "frequency_bands") continue
    // The daemon publishes one of these per audio callback — far faster than a
    // terminal can draw, and parsing every one is work that shows up as jank
    // everywhere else, including in the timers that decide when a held key was
    // let go. Frames inside the window are dropped before being parsed, which
    // is what the daemon itself does to a reader it is outrunning.
    const now = Date.now()
    if (now - last < SPECTRUM_MIN_INTERVAL_MS) continue
    const data = parse(frame.data) as { bands_b64?: string; total_energy?: number } | undefined
    // The window governs frames actually handed over, so one the daemon sent
    // without bands does not cost the caller the next good one.
    if (!data?.bands_b64) continue
    last = now
    yield { bands: decodeBands(data.bands_b64), energy: data.total_energy ?? 0 }
  }
}

/** Little-endian f32 samples, as the daemon packs them. */
function decodeBands(encoded: string) {
  const bytes = Buffer.from(encoded, "base64")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const bands = new Float32Array(Math.floor(bytes.byteLength / 4))
  for (let band = 0; band < bands.length; band++) bands[band] = view.getFloat32(band * 4, true)
  return bands
}

function parse(data: string) {
  if (!data) return undefined
  return JSON.parse(data) as unknown
}
