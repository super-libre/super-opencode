import {
  createContext,
  createEffect,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Switch,
  useContext,
  type ParentProps,
} from "solid-js"
import { useRenderer } from "@opentui/solid"
import { useTheme } from "../../context/theme"
import { useEvent } from "../../context/event"
import { useToast } from "../../ui/toast"
import { useStorage } from "../../context/storage"
import { useTuiApp, useTuiPaths } from "../../context/runtime"
import { useConfig } from "../../config"
import { errorMessage } from "../../util/error"
import {
  authorize,
  available,
  satisfies,
  silence,
  socketPath,
  speak,
  speaking as watchSpeaking,
  status,
  stream,
  TtsError,
  valid,
} from "../../tts/client"
import { read, write } from "../../voice/session"
import type { Session, Speaking, Stream } from "../../tts/client"
import type { SessionMessageAssistant } from "@opencode/client"
import { DAEMON_CHECK_MS } from "./dictate"

export type Speech = ReturnType<typeof createSpeech>

/** How the microphone is held open in interactive mode: on a key, or all the time. */
export type Listening = "push" | "open"

const SpeechContext = createContext<Speech>()

/**
 * One speech session for the whole app. The prompt owns the toggle that reads
 * replies as they arrive; the transcript plays single replies through the same
 * daemon session, and both share the one indicator, consent and utterance.
 */
// Quitting happens outside the component tree, and the voice belongs to a
// daemon that outlives the process, so the running provider leaves a handle
// behind for the one caller that has to reach it from there.
let silencer: (() => Promise<void> | undefined) | undefined

/**
 * Stop the voice and wait for the daemon to confirm it. Does nothing when
 * speech was never switched on, and never throws: this runs on the way out.
 */
export function hushVoice() {
  return silencer?.()?.catch(() => undefined)
}

export function SpeechProvider(props: ParentProps) {
  const speech = createSpeech()
  return <SpeechContext.Provider value={speech}>{props.children}</SpeechContext.Provider>
}

export function useSpeech() {
  const speech = useContext(SpeechContext)
  if (!speech) throw new Error("Speech context must be used within a SpeechProvider")
  return speech
}

/** The reply as it would be spoken: its visible text, in the order it was written. */
export function spokenText(message: Pick<SessionMessageAssistant, "content">) {
  return message.content
    .flatMap((content) => (content.type === "text" ? [content.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n")
}

/**
 * The prompt's interactive-mode control. Provisional: what the prompt becomes
 * in this mode is still being designed, and this is the toggle in the meantime.
 */
export function SpeakButton(props: { speech: Speech; disabled?: boolean; listening?: boolean }) {
  const theme = useTheme()

  return (
    <box
      flexDirection="row"
      gap={1}
      flexShrink={0}
      onMouseDown={() => {
        if (props.disabled) return
        props.speech.toggle()
      }}
    >
      <Switch>
        <Match when={props.listening}>
          <text fg={theme.text.feedback.error.base}>● listening</text>
        </Match>
        <Match when={props.speech.speaking}>
          <text fg={theme.text.action.primary.base}>♪ speaking</text>
        </Match>
        <Match when={props.speech.interactive}>
          <text fg={theme.text.action.primary.base}>♪ interactive</text>
        </Match>
        <Match when={true}>
          <text fg={props.disabled ? theme.border.base : theme.text.muted}>♪ interactive</text>
        </Match>
      </Switch>
    </box>
  )
}

/**
 * Which way the microphone is held open in interactive mode: pushed down for as
 * long as a key is held, or left open until the mode ends.
 */
export function ListenButton(props: { speech: Speech; disabled?: boolean }) {
  const theme = useTheme()

  return (
    <box
      flexShrink={0}
      onMouseDown={() => {
        if (props.disabled) return
        props.speech.cycleListening()
      }}
    >
      <text fg={props.disabled ? theme.border.base : theme.text.muted}>
        {props.speech.listen === "open" ? "◉ open" : "◉ push"}
      </text>
    </box>
  )
}

/**
 * Plays one reply, and stops it again. It sits with the reply it speaks, so any
 * of them can be heard — not only the newest, and not only the ones that
 * arrived while this instance of opencode was running.
 */
export function PlayButton(props: { speech: Speech; text: string; source: string }) {
  const theme = useTheme()
  const renderer = useRenderer()
  const playing = () => props.speech.speaking && props.speech.source === props.source

  return (
    <box
      flexShrink={0}
      onMouseUp={() => {
        // The transcript is selectable text: releasing a drag over the control
        // is someone copying a reply, not asking to hear it.
        if (renderer.getSelection()?.getSelectedText()) return
        void props.speech.play(props.text, props.source)
      }}
    >
      <text fg={playing() ? theme.text.action.primary.base : theme.text.muted}>
        {playing() ? "♪ playing" : "↻ play"}
      </text>
    </box>
  )
}

/**
 * Reads the agent's replies aloud through the Super Voice daemon. Assistant text
 * is forwarded as it streams, over one WebSocket session per message, so the
 * daemon speaks each sentence as it completes rather than waiting for the whole
 * reply. Markup is the daemon's problem: its normalizer drops code blocks and
 * strips emphasis, links and table pipes, and holds an ambiguous tail across
 * deltas — so raw text goes out unprocessed.
 */
function createSpeech() {
  const event = useEvent()
  const config = useConfig().data
  const toast = useToast()
  const app = useTuiApp()
  const paths = useTuiPaths()
  // Interactive mode: the ears and the voice both on, a conversation rather
  // than a prompt. Saved so the choice survives a restart, along with how the
  // microphone is held open — but held here, because a save lands only once it
  // is on disk, and the mode has to change the moment it is switched. Another
  // opencode switching its own mode does not reach into this one either.
  const [saved, save] = useStorage().store<{ interactive: boolean; listen: Listening }>("voice", {
    initial: { interactive: false, listen: "push" },
  })
  const [interactive, setMode] = createSignal(saved.interactive === true)
  const [listen, setListen] = createSignal<Listening>(saved.listen === "open" ? "open" : "push")
  const remember = (mutation: (draft: { interactive: boolean; listen: Listening }) => void) =>
    void save(mutation).catch((error) => console.debug("failed to save voice settings", { error }))
  const setInteractive = (value: boolean) => {
    setMode(value)
    remember((draft) => {
      draft.interactive = value
    })
  }
  // The session whose replies are read aloud: the one the prompt is showing.
  // Text from any other — a subagent at work, another tab — is not this
  // conversation.
  const [conversation, setConversation] = createSignal<string>()
  const [speaking, setSpeaking] = createSignal(false)
  // Which reply the voice is on, when it was asked for by name. The toggle's
  // own reading leaves this unset: it speaks whatever is arriving, and there is
  // no one control in the transcript that asked for it.
  const [source, setSource] = createSignal<string>()
  const [ready, setReady] = createSignal(false)
  // Whether the daemon answered the last time anyone looked. Assumed until a
  // look says otherwise, so nothing warns before there is reason to.
  const [reachable, setReachable] = createSignal(true)

  // Everything that quiets the voice also forgets whose reply it was.
  function quiet() {
    setSpeaking(false)
    setSource(undefined)
  }

  const socket = socketPath()
  let session: Session | undefined
  // Our own copy of each piece of a reply's text, by message and ordinal. Its
  // deltas are live-only and its end carries the whole value, so a piece whose
  // deltas went missing is still caught up on when it ends.
  const accumulated = new Map<string, string>()
  const spoken = new Map<string, number>()
  type Utterance = { message: string; stream?: Stream; buffered: string[]; ended: boolean }
  let active: Utterance | undefined
  // The reply that was silenced. Generation does not stop because the listener
  // stopped listening, so without this the next delta opens a new session and
  // carries on reading aloud the very thing that was just cut off.
  let abandoned: string | undefined
  // How much of what is playing is still to be heard, as far as we can tell
  // without `speaking_state`: the audio a streaming session last reported
  // queued ahead of the speakers, or a length estimate for a reply played from
  // the transcript, which has no progress frames of its own.
  let remaining = 0
  // Bumped whenever what is being spoken changes, so a pending drain timer from
  // a finished utterance cannot clear the indicator for the next one.
  let generation = 0
  // The utterance we are waiting to hear the end of, named by the stream's
  // `utterance` frame and cleared by `speaking_state`.
  let playing: string | undefined
  // Set between asking for an utterance and being told its name. `POST /speak`
  // answers only once the whole reply is queued, which on a backend that
  // synthesizes at about the speed of speech is most of the way through
  // speaking it — so the start, and sometimes the end, of our own utterance
  // reaches us before we know what it is called.
  let expecting = false
  // The reply we last asked for, kept until something else is asked for or the
  // voice is stopped. Unlike the indicator it is never cleared by an event, so
  // a toggle can tell "this reply is the one talking" even when a frame about
  // it went missing.
  let requested: string | undefined
  // The open `speaking_state` subscription, and whether it is carrying us.
  // Without one there is nothing to wait on but the queued-audio estimate.
  let watcher: AbortController | undefined
  let tracked = false

  onMount(() => {
    if (!config.tts.enabled || !socket) return
    void available(socket).then(setReady)
  })

  // Replies arrive whether or not anything can say them, so in interactive mode
  // a daemon that is gone is otherwise just an agent that went quiet. Both ways:
  // one that comes back — or was not up yet when opencode started — is picked
  // up without a restart.
  createEffect(() => {
    if (!interactive() || !config.tts.enabled || !socket) return
    const check = () =>
      void available(socket).then((up) => {
        setReachable(up)
        setReady(up)
      })
    const timer = setInterval(check, DAEMON_CHECK_MS)
    check()
    onCleanup(() => clearInterval(timer))
  })

  silencer = hush
  onCleanup(() => {
    if (silencer === hush) silencer = undefined
    active?.stream?.cancel()
    active = undefined
    watcher?.abort()
    watcher = undefined
  })

  const notify = (message: string) => toast.show({ title: "Speech", message, variant: "error" })

  // Synthesis refuses for one reason the user can actually act on, and the bare
  // code says nothing about the app they would act in.
  function trouble(error: unknown) {
    if (error instanceof TtsError && error.code === "model_not_loaded")
      notify("No speech model is loaded. Load one in the Super TTS app, then try again.")
    else notify(errorMessage(error))
  }

  // Shared while it is pending. Interactive mode coming on, the first reply and
  // the play key can all ask before the consent dialog is answered, and each
  // asking on its own would put up a dialog of its own.
  let authenticating: ReturnType<typeof establish> | undefined

  function authenticate(force?: boolean) {
    if (force) return establish(true)
    authenticating ??= establish().finally(() => {
      authenticating = undefined
    })
    return authenticating
  }

  async function establish(force?: boolean) {
    if (!socket) return undefined
    if (!force) {
      session = session ?? (await read(paths.state))
      if (session && satisfies(session) && (await valid(socket, session.token))) return session
    }
    session = await authorize(socket, app.version)
    await write(paths.state, session).catch((error) => {
      console.debug("failed to persist super-voice session", { error })
    })
    return session
  }

  // Every caller that needs a token comes through here, so a refusal switches
  // the toggle back off in one place rather than leaving it on and silent.
  async function connect() {
    return authenticate().catch((error) => {
      // Gone rather than refusing. Interactive mode stays on and the prompt says
      // why it is quiet — a toast on every reply would say it once per reply,
      // and leaving would end the conversation over a daemon restart.
      if (interactive() && error instanceof TtsError && error.code === "daemon_unreachable") {
        setReachable(false)
        return undefined
      }
      setInteractive(false)
      if (error instanceof TtsError && (error.code === "user_denied" || error.code === "user_denied_cached"))
        notify("Super Voice access was denied. Approve opencode in the consent dialog to hear replies.")
      else if (error instanceof TtsError && error.code === "popup_failed")
        notify("Super Voice could not show its consent dialog. Check that super-voice-consent sits beside the daemon.")
      else if (!(error instanceof TtsError && error.code === "user_dismissed")) notify(errorMessage(error))
      return undefined
    })
  }

  /**
   * Follow `speaking_state` for as long as speech is on.
   *
   * The streaming session cannot tell us when the voice stopped: its `done`
   * frame means every sample is queued, and a local backend synthesizes several
   * times faster than realtime, so it lands while most of the reply is still
   * buffered ahead of the speakers. The daemon holds the utterance open for the
   * whole playout and publishes the stop on this stream at the end of it.
   */
  async function follow(token: string) {
    if (watcher) return
    const controller = new AbortController()
    watcher = controller
    tracked = true
    try {
      for await (const frame of watchSpeaking(socket!, token, controller.signal)) observe(frame)
    } catch (error) {
      console.debug("super-voice speaking_state subscription ended", { error })
    } finally {
      if (watcher === controller) {
        watcher = undefined
        tracked = false
        // Nothing is left to hear the end on. A streaming session still has its
        // `done` frame to fall back from; a reply played whole has only the
        // estimate, and without this its indicator would stay lit for good.
        if (playing && !active && speaking()) settle(remaining)
      }
    }
  }

  // These describe the speakers, not our requests — an utterance another app
  // started raises them too — so only frames about ours are acted on.
  function observe(frame: Speaking) {
    if (frame.speaking) {
      // The start of the utterance we are waiting to be told the name of. One
      // plays at a time and the newest wins, so whatever starts while we are
      // waiting is either ours or the thing that took the speakers from us —
      // and learning its name is what lets us hear about the end either way.
      if (expecting && frame.utterance) {
        playing = frame.utterance
        expecting = false
        return
      }
      if (!playing) return
      // Another app's utterance starting means ours was cut off mid-word.
      if (!frame.utterance || frame.utterance === playing) return
    } else {
      // A stop is only ours to act on once we know which utterance is ours: it
      // names the one it ended, and before that every stop belongs to whatever
      // was speaking before us.
      if (!playing) return
      if (frame.utterance && frame.utterance !== playing) return
    }
    playing = undefined
    expecting = false
    generation++
    quiet()
  }

  /**
   * Let go of whatever was playing, before claiming the speakers for something
   * new. The previous utterance's stop may still be in flight, and matching it
   * against an id we have moved on from would clear the indicator we just lit;
   * a pending drain timer from it would do the same.
   */
  function release() {
    playing = undefined
    expecting = false
    generation++
  }

  // One session per assistant message. Deltas that arrive while it is opening
  // are buffered rather than dropped, since generation does not wait for us.
  async function begin(message: string) {
    const current: Utterance = { message, buffered: [], ended: false }
    active = current
    release()
    remaining = 0
    setSpeaking(true)

    const authenticated = await connect()
    if (!authenticated || active !== current) {
      if (active === current) stop()
      return
    }

    void follow(authenticated.token)

    const opened = await stream(socket!, authenticated.token, {
      onUtterance: (id) => {
        playing = id
      },
      onProgress: (spokenMs, queuedMs) => {
        remaining = Math.max(0, queuedMs - spokenMs)
      },
      onDone: () => {
        if (active?.message !== message) return
        active = undefined
        // `done` only says every sample is queued, so the indicator stays on
        // until `speaking_state` reports the speakers quiet. With no
        // subscription to carry that, fall back to guessing from the last
        // progress frame — which precedes the tail `end` synthesizes, so it
        // lets go a little early.
        if (!tracked || !playing) settle(remaining)
      },
      onError: (message) => notify(message),
    }).catch((error) => {
      trouble(error)
      return undefined
    })

    // The toggle may have been switched off, or a newer message started, while
    // the socket was opening.
    if (!opened) {
      if (active === current) stop()
      return
    }
    if (active !== current) {
      opened.cancel()
      return
    }

    current.stream = opened
    for (const delta of current.buffered) opened.text(delta)
    current.buffered.length = 0
    if (current.ended) opened.end()
  }

  function feed(message: string, delta: string) {
    if (!delta) return
    // Silenced mid-reply. The rest of it is not spoken, though the play button
    // will still read the whole thing back on request.
    if (message === abandoned) return
    if (active?.message !== message) {
      active?.stream?.end()
      void begin(message)
    }
    if (active?.message !== message) return
    if (active.stream) active.stream.text(delta)
    else active.buffered.push(delta)
  }

  function finish(message: string) {
    if (active?.message !== message) return
    active.ended = true
    active.stream?.end()
  }

  // Fallback for when `speaking_state` is not available: clear the indicator
  // once the audio that was queued has had time to play.
  function settle(pending: number) {
    const token = ++generation
    if (pending <= 0) {
      quiet()
      return
    }
    setTimeout(() => {
      if (token === generation) quiet()
    }, pending)
  }

  /**
   * Everything that stops, including the daemon, and resolves once it has.
   *
   * Cancelling our stream only stops more text being sent; audio already queued
   * plays on regardless, so the request is what actually silences the voice —
   * and quitting has to wait for it, or the process dies first and the voice
   * carries on talking to a terminal that is no longer there.
   */
  function hush() {
    const current = active
    if (current) abandoned = current.message
    active = undefined
    playing = undefined
    expecting = false
    requested = undefined
    generation++
    quiet()
    watcher?.abort()
    watcher = undefined
    current?.stream?.cancel()
    // Never spoken, so nothing to stop — and quitting should not wait on a
    // daemon this session never used.
    if (!socket || !session) return
    return silence(socket, session.token).catch(async (error) => {
      // The daemon binds a token to the binary it was minted for and revokes it
      // when that binary changes — which, while opencode is being built, is
      // every few minutes, and the revocation lands mid-session. A stop refused
      // for that reason cannot be the end of it: the voice is still talking,
      // and that is the one thing that must not be left running.
      if (!(error instanceof TtsError) || error.status !== 401) throw error
      const renewed = await authenticate(true)
      if (!renewed) throw error
      await silence(socket, renewed.token)
    })
  }

  function stop() {
    void hush()?.catch((error) => {
      // Nothing is speaking through a daemon that is not there.
      if (error instanceof TtsError && error.code === "daemon_unreachable") {
        setReachable(false)
        return
      }
      // Everything else here is local: the indicator is already off, so a
      // stop that did not reach the daemon leaves the voice going with
      // nothing on screen to explain it.
      notify("Super Voice did not accept the stop. The voice may still be speaking.")
    })
  }

  /**
   * Speak a reply that is already written, or silence it if it is the one
   * already talking — one press of a control that shows both.
   *
   * Which of the two it is comes from the daemon rather than from our own
   * indicator. That indicator mirrors `speaking_state`, and frames go missing:
   * `POST /speak` answers only once the whole reply is queued, so on a backend
   * that synthesizes at about the speed of speech the frames about our own
   * utterance arrive while we still have no name to match them against. A
   * toggle that guesses wrong from a stale indicator starts the reply over
   * instead of stopping it, which is the one thing it must never do — and
   * `GET /status` is what the daemon's own reference points a speak/silence
   * toggle at.
   *
   * The text is finished by the time this runs, so it goes out through
   * `POST /speak` rather than a streaming session: there is nothing left to
   * feed in pieces. Newest wins at the daemon, so a reply still being read
   * aloud is cut off by this — our own session goes with it rather than keep
   * feeding a voice that has moved on.
   */
  async function play(text: string, id: string) {
    if (!socket || !text) return

    const authenticated = await connect()
    if (!authenticated) return

    const current = await status(socket, authenticated.token).catch(() => undefined)
    if (current?.busy && requested === id) {
      stop()
      return
    }
    // The speakers went quiet without us hearing about it. Let the indicator
    // catch up rather than leave it lit under the reply about to start.
    if (current && !current.busy && speaking()) quiet()

    active?.stream?.cancel()
    active = undefined
    void follow(authenticated.token)

    release()
    requested = id
    expecting = true
    // Ordinary speech runs at roughly fifteen characters a second. Rough is
    // enough: this is only consulted when the daemon is not telling us what the
    // speakers are doing, to decide how long to hold the indicator for.
    remaining = (text.length / 15) * 1000
    setSpeaking(true)
    setSource(id)
    // `null` is the refusal; the daemon answering without an utterance id is
    // not one, and leaves `undefined`.
    const utterance = await speak(socket, authenticated.token, text).catch((error) => {
      trouble(error)
      return null
    })
    if (utterance === null) {
      release()
      requested = undefined
      quiet()
      return
    }
    // A start frame may have named it already, and it may since have ended —
    // in which case this answer is about an utterance that is over, and the
    // indicator it was holding has already been let go.
    if (expecting) {
      playing = utterance
      expecting = false
    }
    // A daemon that names no utterance leaves `speaking_state` nothing to match
    // ours against, so the estimate is all there is to go on. Nothing to drain
    // if the utterance has already been heard out.
    if (speaking() && (!tracked || !playing)) settle(remaining)
  }

  /**
   * Check the wiring without waiting for the agent to say something. It goes
   * through the streaming session rather than `POST /speak`, in deltas that
   * split mid-word, so it exercises the same path a real reply takes — a test
   * that took the one-shot route could pass while replies stayed silent.
   */
  async function test() {
    if (!socket) return
    const authenticated = await connect()
    if (!authenticated) return

    void follow(authenticated.token)

    let finished = false
    release()
    remaining = 0
    const opened = await stream(socket, authenticated.token, {
      onUtterance: (id) => {
        playing = id
      },
      onProgress: (spokenMs, queuedMs) => (remaining = Math.max(0, queuedMs - spokenMs)),
      onDone: () => (finished = true),
      onError: (message) => notify(message),
    }).catch((error: unknown) => {
      trouble(error)
      return undefined
    })
    if (!opened) return

    setSpeaking(true)
    for (const delta of ["Super Voice is conn", "ected. This is opencode ", "reading a reply out loud."]) {
      opened.text(delta)
      await Bun.sleep(80)
    }
    opened.end()
    for (let tick = 0; tick < 150 && !finished; tick++) await Bun.sleep(100)
    if (!tracked || !playing) settle(remaining)
  }

  // Shared while it is pending, so the prompt can wait on this asking before it
  // puts up the microphone's dialog, rather than stacking one on the other.
  let preparing: Promise<void> | undefined

  /**
   * Consent and the model check happen the moment interactive mode comes on —
   * switched on, or found on by a restart. Left until the first reply, the
   * dialog would appear in the middle of one and the opening sentences would be
   * lost to it.
   */
  function prepare() {
    preparing ??= (async () => {
      const authenticated = await connect()
      if (!authenticated) return
      const current = await status(socket!, authenticated.token).catch(() => undefined)
      if (current && !current.model_loaded)
        notify("No speech model is loaded. Load one in the Super TTS app to hear replies.")
    })().finally(() => {
      preparing = undefined
    })
    return preparing
  }

  createEffect(() => {
    if (interactive() && config.tts.enabled) void prepare()
  })

  function toggle() {
    if (interactive()) {
      setInteractive(false)
      stop()
      return
    }
    setInteractive(true)
  }

  // Which way the microphone is held open. Switching does not touch a capture
  // already running: whoever owns the microphone decides what becomes of the
  // one in flight.
  function cycleListening() {
    const next = listen() === "push" ? "open" : "push"
    setListen(next)
    remember((draft) => {
      draft.listen = next
    })
  }

  // Visible text only: reasoning and tool calls have events of their own, so
  // nothing the model thought to itself reaches the speakers.
  const handlers = [
    event.on("session.text.delta", (evt) => {
      if (evt.data.sessionID !== conversation()) return
      const piece = `${evt.data.assistantMessageID}:${evt.data.ordinal}`
      accumulated.set(piece, (accumulated.get(piece) ?? "") + evt.data.delta)
      flush(evt.data.assistantMessageID, piece)
    }),
    event.on("session.text.ended", (evt) => {
      if (evt.data.sessionID !== conversation()) return
      const piece = `${evt.data.assistantMessageID}:${evt.data.ordinal}`
      accumulated.set(piece, evt.data.text)
      flush(evt.data.assistantMessageID, piece)
    }),
    event.on("session.step.ended", (evt) => {
      if (evt.data.sessionID === conversation()) finish(evt.data.assistantMessageID)
    }),
    event.on("session.step.failed", (evt) => {
      if (evt.data.sessionID === conversation()) finish(evt.data.assistantMessageID)
    }),
  ]

  function flush(message: string, piece: string) {
    if (!interactive() || !ready()) return
    const text = accumulated.get(piece) ?? ""
    const already = spoken.get(piece) ?? 0
    if (text.length <= already) return
    spoken.set(piece, text.length)
    feed(message, text.slice(already))
  }

  onCleanup(() => handlers.forEach((off) => off()))

  return {
    get interactive() {
      return interactive()
    },
    get listen() {
      return listen()
    },
    get speaking() {
      return speaking()
    },
    get ready() {
      return ready()
    },
    /** False once the daemon is found gone, until it is found back. */
    get reachable() {
      return reachable()
    },
    get source() {
      return source()
    },
    toggle,
    /** Read aloud the replies of this session, and no other. */
    follow: setConversation,
    prepare,
    cycleListening,
    stop,
    play,
    test,
  }
}
