import { createEffect, createMemo, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { useTerminalDimensions } from "@opentui/solid"
import { useToast } from "../../ui/toast"
import { useConfig, type SttStopMode } from "../../config"
import { useTuiApp, useTuiPaths } from "../../context/runtime"
import { errorMessage } from "../../util/error"
import {
  authorize,
  available,
  satisfies,
  socketPath,
  spectrum,
  SttError,
  status,
  stop,
  transcribe,
  valid,
} from "../../stt/client"
import { read, write } from "../../voice/session"
import type { Session } from "../../stt/client"

export type DictationState = "idle" | "starting" | "recording" | "transcribing"

export type Dictation = ReturnType<typeof usePromptDictation>

/**
 * Live transcription as the daemon hears it, on its own full-width line so the
 * text is actually readable while speaking. What the text spans depends on the
 * model: a realtime model streams everything heard so far, while for every
 * other model the daemon re-transcribes a sliding window, so the line shows the
 * last few seconds and replaces itself. Neither is the final transcript — that
 * arrives when the capture ends and goes into the prompt.
 */
export function DictatePreview(props: { dictation: Dictation }) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <Show when={props.dictation.state === "recording" || props.dictation.state === "transcribing"}>
      <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} width="100%">
        <text fg={theme.text.feedback.error.base} flexShrink={0}>
          ●
        </text>
        <text
          fg={props.dictation.preview && props.dictation.active ? theme.text.base : theme.text.muted}
          flexShrink={1}
        >
          {props.dictation.preview
            ? Locale.truncateLeft(props.dictation.preview, Math.max(20, dimensions().width - 12))
            : props.dictation.state === "transcribing"
              ? "transcribing…"
              : "listening…"}
        </text>
      </box>
    </Show>
  )
}

// How long the microphone waits, after the last sign that the talk key is
// still down, before deciding it was let go. Bounds on a figure learned from
// the keyboard itself — see `hold`.
// Biased long on purpose. This is a fallback for a terminal that reports no key
// releases at all, and the two failures are not comparable: closing late costs a
// moment of silence, closing early cuts a sentence in half.
const TALK_RELEASE_MIN_MS = 700
const TALK_RELEASE_MAX_MS = 1500

// How often a watched daemon is asked whether it is still there. Only a
// connection, so it can be often: a warning that lags the daemon going away by
// more than a moment is one the user has already worked out for themselves.
export const DAEMON_CHECK_MS = 2000

const METER_LEVELS = "▁▂▃▄▅▆▇█"
const METER_CELLS = 12
const METER_SAMPLE_MS = 80
// The amplitude a band has to reach to fill a cell. Super STT's own applet
// normalizes against the same figure, so the meter answers to a voice the way
// the desktop widget does rather than to a scale of its own.
const METER_BAND_MAX = 3

/** The daemon's 64 bands, averaged down to the cells there is room to draw. */
function levels(bands: Float32Array) {
  const width = bands.length / METER_CELLS
  return Array.from({ length: METER_CELLS }, (_, cell) => {
    const from = Math.floor(cell * width)
    const to = Math.max(from + 1, Math.floor((cell + 1) * width))
    let sum = 0
    for (let band = from; band < to; band++) sum += bands[band]
    const filled = sum / (to - from) / METER_BAND_MAX
    return Math.max(0, Math.min(7, Math.round(filled * 7)))
  })
}

/**
 * What the microphone is picking up, for interactive mode where the prompt
 * takes nothing typed and this row is the microphone.
 *
 * The bars are the daemon's own spectrum, measured from the device, so they
 * move with a voice whatever the model is doing. Where the daemon sends none —
 * an older one, or a session without the `audio_visualization` scope — the bars
 * sweep instead, which claims nothing except that the microphone is open.
 */
export function VoiceMeter(props: { dictation: Dictation; hint: string; warning?: string }) {
  const theme = useTheme()
  const config = useConfig().data
  const dimensions = useTerminalDimensions()
  const [cells, setCells] = createSignal<number[]>([])
  const [step, setStep] = createSignal(0)
  const capturing = () => props.dictation.state === "recording"

  createEffect(() => {
    if (!capturing() || !(config.animations ?? true)) return
    const timer = setInterval(() => {
      const bands = props.dictation.bands
      setStep((value) => value + 1)
      setCells(bands && bands.length > 0 ? levels(bands) : [])
    }, METER_SAMPLE_MS)
    onCleanup(() => {
      clearInterval(timer)
      setCells([])
    })
  })

  const bar = createMemo(() => {
    const drawn = cells()
    if (drawn.length > 0) return drawn.map((level) => METER_LEVELS[level]).join("")
    // Nothing is being measured. A flat line would read as a dead microphone,
    // so say the one thing that is known: it is open.
    if (capturing()) {
      const head = step() % METER_CELLS
      return Array.from({ length: METER_CELLS }, (_, cell) => {
        const behind = (head - cell + METER_CELLS) % METER_CELLS
        return METER_LEVELS[behind === 0 ? 4 : behind === 1 ? 2 : 0]
      }).join("")
    }
    return METER_LEVELS[0].repeat(METER_CELLS)
  })

  return (
    <box flexDirection="row" flexShrink={0} gap={2} width="100%">
      <text fg={capturing() ? theme.text.feedback.error.base : theme.border.base} flexShrink={0}>
        {bar()}
      </text>
      {/* Ahead of what was last heard, which stays on the row until the next
          capture: a warning behind it would be hidden for as long as it matters. */}
      <Show
        when={props.warning && props.dictation.state === "idle"}
        fallback={
          <text
            fg={props.dictation.preview && props.dictation.active ? theme.text.base : theme.text.muted}
            flexShrink={1}
          >
            {props.dictation.preview
              ? Locale.truncateLeft(props.dictation.preview, Math.max(20, dimensions().width - METER_CELLS - 12))
              : props.dictation.state === "transcribing"
                ? "transcribing…"
                : capturing()
                  ? "listening…"
                  : props.hint}
          </text>
        }
      >
        <text fg={theme.text.feedback.warning.base} flexShrink={1}>
          △ {props.warning}
        </text>
      </Show>
    </box>
  )
}

/**
 * The prompt's dictation control: a button that starts the capture and stops
 * it again.
 */
export function DictateButton(props: { dictation: Dictation; disabled?: boolean }) {
  const theme = useTheme()

  return (
    <>
      <box
        flexDirection="row"
        gap={1}
        flexShrink={0}
        onMouseDown={() => {
          if (props.disabled) return
          props.dictation.toggle()
        }}
      >
        <Switch>
          <Match when={props.dictation.state === "recording"}>
            <text fg={theme.text.feedback.error.base}>● stop</text>
          </Match>
          <Match when={props.dictation.state === "starting"}>
            <text fg={theme.text.muted}>◌ starting</text>
          </Match>
          <Match when={props.dictation.state === "transcribing"}>
            <text fg={theme.text.muted}>◌ transcribing</text>
          </Match>
          <Match when={true}>
            <text fg={props.disabled ? theme.border.base : theme.text.muted}>◉ dictate</text>
          </Match>
        </Switch>
      </box>
    </>
  )
}

/**
 * Dictation through the Super Voice daemon. The daemon owns the microphone and
 * the model — opencode asks it to capture, streams back preview text while the
 * user speaks, and inserts the final transcription into the prompt.
 */
// As with the voice: quitting happens outside the component tree, and the
// microphone belongs to a daemon that outlives the process.
let closer: (() => Promise<void> | undefined) | undefined

/**
 * Close the microphone and wait for the daemon to confirm it. Does nothing when
 * no capture is running, and never throws: this runs on the way out.
 */
export function hushMicrophone() {
  return closer?.()?.catch(() => undefined)
}

export function usePromptDictation(input: {
  deliver: (text: string) => void
  /**
   * Called as the microphone opens, for whoever owns the voice to quiet it.
   * Deliberately not called for the open microphone's own restarts: those are
   * the silence between two sentences, not someone deciding to talk.
   */
  silence?: () => void
  /**
   * Keep checking the daemon is there for as long as this holds. Where the
   * microphone is the only way in, a daemon that is gone must be said, not
   * discovered by talking to nothing.
   */
  monitor?: () => boolean
  /**
   * Called when the user says no to the consent dialog, or it could not be
   * shown, for whoever has no use without the microphone to give up with it.
   */
  refused?: () => void
}) {
  const toast = useToast()
  const config = useConfig().data
  const app = useTuiApp()
  const paths = useTuiPaths()
  const [state, setState] = createSignal<DictationState>("idle")
  const [preview, setPreview] = createSignal("")
  const [ready, setReady] = createSignal(false)
  // Whether the daemon answered the last time anyone looked. Assumed until a
  // look says otherwise, so nothing warns before there is reason to.
  const [reachable, setReachable] = createSignal(true)

  const socket = socketPath()
  let controller: AbortController | undefined
  let session: Session | undefined
  // An open microphone is one capture after another: the daemon ends each on
  // silence and hands back what it heard, and the next one starts straight
  // away. Cleared when the microphone is closed, so a capture that resolves
  // afterwards is the last.
  let open = false
  // A capture asked to end before the daemon has opened the microphone. The
  // request is held rather than dropped, because the key was already let go.
  let closing = false
  // How this capture is meant to end. It belongs to the interaction rather than
  // to taste: a held key ends its own capture, an open microphone needs silence
  // to close each utterance so the next can start, and plain dictation is
  // whatever the user configured. The daemon's own default is neither — with
  // `manual_only` an open microphone would record until it was told to stop.
  let stopMode: SttStopMode | undefined
  // The newest spectrum frame from the daemon. Held outside the reactive graph
  // because it arrives at the audio callback rate — far faster than anything
  // should re-render — and the meter samples it on its own clock.
  let bands: Float32Array | undefined
  let watcher: AbortController | undefined

  onMount(() => {
    if (!config.stt.enabled || !socket) return
    void available(socket).then(setReady)
  })

  // Both ways: a daemon that comes back is picked up without a restart, which is
  // also what brings back an open microphone that closed when it went away.
  createEffect(() => {
    if (!input.monitor?.() || !config.stt.enabled || !socket) return
    const check = () =>
      void available(socket).then((up) => {
        setReachable(up)
        setReady(up)
      })
    const timer = setInterval(check, DAEMON_CHECK_MS)
    check()
    onCleanup(() => clearInterval(timer))
  })

  /**
   * Close the microphone for good. Dropping our stream is an implicit stop, but
   * only the request is a promise we can wait on, and on the way out waiting is
   * the whole point.
   */
  function hush() {
    // Nothing is recording, so quitting has nothing to wait for.
    if (state() === "idle") return
    cancel()
    if (!socket || !session) return
    return stop(socket, session.token)
  }

  closer = hush
  onCleanup(() => {
    if (closer === hush) closer = undefined
    controller?.abort()
    clearTimeout(holdTimer)
    unwatch()
  })

  // Holding a key makes it repeat, and each repeat arrives as another press, so
  // the repeats are how we know it is still down. Not every terminal reports a
  // key going up — Rio before 0.5.13 reports none, and zellij asks the terminal
  // for only the first layer of the kitty protocol, so behind it none arrives
  // whatever the terminal — and there the repeats running out is the only sign
  // the key was let go.
  let lastHold = 0
  let holdRepeat: number | undefined
  let holdTimer: ReturnType<typeof setTimeout> | undefined
  // Whether this terminal has ever reported a key going up. Until one does the
  // fallback has to run; once one has, it must not — a release closes a capture
  // exactly when the key is let go, and a timer racing that can only close one
  // early. Terminals do not change their minds mid-session, so one release is
  // all the evidence needed.
  let reportsReleases = false

  const notify = (message: string) => toast.show({ title: "Dictation", message, variant: "error" })

  // Shared while it is pending. Interactive mode coming on, an open microphone
  // and the talk key can all ask before the consent dialog is answered, and
  // each asking on its own would put up a dialog of its own.
  let authenticating: ReturnType<typeof establish> | undefined

  function authenticate(force?: boolean) {
    if (force) return establish(true)
    authenticating ??= establish().finally(() => {
      authenticating = undefined
    })
    return authenticating
  }

  // A token is minted once and persisted; the daemon binds it to the opencode
  // binary, so a reinstall invalidates it (`exe_changed`) and we mint again.
  async function establish(force?: boolean) {
    if (!socket) return undefined
    if (!force) {
      session = session ?? (await read(paths.state))
      if (session && satisfies(session) && (await valid(socket, session.token))) return session
    }
    session = await authorize(socket, app.version)
    await write(paths.state, session).catch((error) => {
      // A token we cannot persist still works for this run.
      console.debug("failed to persist super-voice session", { error })
    })
    return session
  }

  /**
   * Follow the microphone's spectrum for as long as this capture runs. It is
   * decoration for the meter, not part of dictation, so a daemon that refuses
   * the topic costs nothing but the drawing.
   */
  function watch(token: string) {
    watcher?.abort()
    const own = new AbortController()
    watcher = own
    void (async () => {
      for await (const frame of spectrum(socket!, token, own.signal)) {
        if (own.signal.aborted) return
        bands = frame.bands
      }
    })().catch(() => undefined)
  }

  function unwatch() {
    watcher?.abort()
    watcher = undefined
    bands = undefined
  }

  async function run(token: string) {
    controller = new AbortController()
    watch(token)
    return transcribe(socket!, token, {
      language: config.stt.language,
      stopMode,
      // No start and stop cues. They tell you the microphone opened, which is
      // what the meter is for — and in interactive mode, where every turn is a
      // take, a chime on each end of each one is noise.
      audioCues: false,
      signal: controller.signal,
      onCapture: () => {
        setState("recording")
        // The key came back up while the daemon was still opening the
        // microphone, so the capture is over before it began.
        if (closing) void finish()
      },
      onPreview: (value) => setPreview(value.text),
    })
  }

  async function start() {
    if (!socket) {
      notify("Super Voice is unavailable: XDG_RUNTIME_DIR is not set.")
      return
    }
    // Claim the state before the first await so a double press cannot open two
    // captures against the daemon.
    setState("starting")
    setPreview("")

    if (!(await available(socket))) {
      setState("idle")
      notify("The Super Voice daemon is not running. Start it with: systemctl --user start super-voice")
      setReady(false)
      setReachable(false)
      return
    }

    const authenticated = await authenticate().catch((error) => {
      if (!declined(error)) notify(errorMessage(error))
      return undefined
    })
    if (!authenticated) {
      setState("idle")
      return
    }

    const current = await status(socket, authenticated.token).catch(() => undefined)
    if (current && !current.model_loaded) {
      setState("idle")
      notify("No speech model is loaded. Load one in the Super STT app, then try again.")
      return
    }
    if (current?.busy) {
      setState("idle")
      notify("Super Voice is already recording for another app.")
      return
    }

    // A token rejected mid-flight is re-minted once: the daemon revokes on
    // expiry and on a changed binary, neither of which the caller can predict.
    const text = await run(authenticated.token)
      .catch(async (error) => {
        if (!(error instanceof SttError) || error.status !== 401) throw error
        const renewed = await authenticate(true)
        if (!renewed) throw error
        return run(renewed.token)
      })
      .catch((error) => {
        if (controller?.signal.aborted) return ""
        notify(errorMessage(error))
        return ""
      })

    controller = undefined
    unwatch()
    setState("idle")
    // The final transcript is the only text the daemon is sure of, and for a
    // model that previews nothing it is the only text there has been. It stays
    // on the row as what was heard, until the next capture replaces it.
    const heard = text.trim()
    setPreview(heard)
    if (heard) input.deliver(heard)
    // Straight back in while the microphone is meant to stay open: the daemon
    // ends a capture on silence, which is the end of a sentence, not the end
    // of the conversation.
    if (open) void start()
  }

  /**
   * Ask for the microphone before anything is said, and check there is a model
   * to hear it with. Left to the first press of the talk key, the dialog would
   * open over the first sentence.
   */
  async function prepare() {
    if (!config.stt.enabled || !socket) return
    // Said on the prompt for as long as it lasts, rather than once in a toast.
    if (!(await available(socket))) {
      setReachable(false)
      return
    }
    const authenticated = await authenticate().catch((error) => {
      if (!declined(error)) notify(errorMessage(error))
      return undefined
    })
    if (!authenticated) return
    const current = await status(socket, authenticated.token).catch(() => undefined)
    if (current && !current.model_loaded) notify("No speech model is loaded. Load one in the Super STT app to talk.")
  }

  /**
   * The consent dialog's answer, when it was not yes. Says why, and tells
   * whoever has no use without the microphone. Answers whether it was one of
   * these, leaving any other failure to the caller.
   */
  function declined(error: unknown) {
    if (!(error instanceof SttError)) return false
    const denied = error.code === "user_denied" || error.code === "user_denied_cached"
    if (!denied && error.code !== "popup_failed" && error.code !== "user_dismissed") return false
    if (denied) notify("Super Voice access was denied. Approve opencode in the consent dialog to use the microphone.")
    // The daemon only looks for its consent helper next to its own binary, so
    // this is what a daemon run straight out of a build tree reports.
    if (error.code === "popup_failed")
      notify("Super Voice could not show its consent dialog. Check that super-voice-consent sits beside the daemon.")
    input.refused?.()
    return true
  }

  async function finish() {
    if (!socket || !session) return
    setState("transcribing")
    // Stop over the protocol rather than closing our stream: a disconnect is an
    // implicit stop that drops the result, and the final transcription is only
    // delivered on the connection that started the capture.
    await stop(socket, session.token).catch((error) => notify(errorMessage(error)))
  }

  function cancel() {
    open = false
    closing = false
    unwatch()
    clearTimeout(holdTimer)
    holdTimer = undefined
    if (state() === "idle") return
    // The controller stays put so the in-flight catch can tell a deliberate
    // cancel from a real failure and skip the error toast.
    controller?.abort()
    setState("idle")
    setPreview("")
  }

  function toggle() {
    const current = state()
    if (current === "idle") {
      stopMode = config.stt.stop_mode
      input.silence?.()
      void start()
      return
    }
    if (current === "recording") {
      void finish()
      return
    }
  }

  /**
   * Open the microphone and hold it, for as long as a key is held or until the
   * mode is left. Pressing a held key repeats, so starting again while a
   * capture is running is not an error — it is the same press arriving twice.
   */
  function begin(options?: { open?: boolean }) {
    open = options?.open === true
    closing = false
    stopMode = open ? "silence_and_manual" : "manual_only"
    if (state() !== "idle") return
    // Opening the microphone is someone deciding to talk, and two voices at
    // once is neither, so whatever is being read aloud stops here.
    input.silence?.()
    void start()
  }

  /**
   * The talk key is down. The first call opens the microphone; every repeat
   * after it says the key is still held, and two of them give the repeat
   * interval, so a gap several times longer than that means it was let go.
   *
   * Answers whether this call is the one that opened the microphone, because a
   * press has consequences elsewhere that a repeat must not have.
   */
  function hold() {
    if (state() === "idle") {
      lastHold = Date.now()
      holdRepeat = undefined
      begin()
      return true
    }
    // The key going up is reported here, so waiting for repeats to run out
    // would only ever take the capture away from the release that owns it.
    if (reportsReleases) return false
    const now = Date.now()
    const gap = now - lastHold
    lastHold = now
    // Too long to be the keyboard repeating: several would have arrived by now.
    if (gap <= 0 || gap > 1000) return false
    holdRepeat = holdRepeat === undefined ? gap : Math.min(holdRepeat, gap)
    clearTimeout(holdTimer)
    holdTimer = setTimeout(
      // Quietly. Behind zellij this is how every held key ends, and a message
      // each time would be noise. Closing the microphone is the whole job.
      () => {
        holdTimer = undefined
        end()
      },
      Math.min(TALK_RELEASE_MAX_MS, Math.max(TALK_RELEASE_MIN_MS, holdRepeat * 4)),
    )
    return false
  }

  /** The talk key came back up, as a terminal that reports it would say. */
  function release() {
    reportsReleases = true
    clearTimeout(holdTimer)
    holdTimer = undefined
    lastHold = 0
    holdRepeat = undefined
    end()
  }

  /** Close the microphone: the daemon returns what it heard, and it is delivered. */
  function end() {
    open = false
    // Opening a microphone takes long enough that a short press can be over
    // before the daemon reports the capture. Remember it, and end it then.
    if (state() === "starting") {
      closing = true
      return
    }
    if (state() !== "recording") return
    void finish()
  }

  return {
    get state() {
      return state()
    },
    get preview() {
      return preview()
    },
    /** The newest spectrum frame, or nothing if the daemon is not sending any. */
    get bands() {
      return bands
    },
    get active() {
      return state() !== "idle"
    },
    // The button and keybind stay hidden unless the daemon is actually there,
    // so the affordance never promises something that cannot work.
    get ready() {
      return ready()
    },
    /** False once the daemon is found gone, until it is found back. */
    get reachable() {
      return reachable()
    },
    prepare,
    toggle,
    begin,
    end,
    hold,
    release,
    cancel,
  }
}
