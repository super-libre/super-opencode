import { expect, test } from "bun:test"
import { tmpdir } from "os"
import path from "path"
import { rm } from "fs/promises"
import { open, WebSocketError } from "../src/tts/websocket"

function server(socket: string, options: { reject?: boolean; onOpen?: (ws: any) => void } = {}) {
  return Bun.serve<{ authorized: string | null }>({
    unix: socket,
    fetch(request, instance) {
      if (options.reject) return new Response("nope", { status: 403 })
      if (instance.upgrade(request, { data: { authorized: request.headers.get("Authorization") } })) return
      return new Response("expected upgrade", { status: 400 })
    },
    websocket: {
      open(ws) {
        options.onOpen?.(ws)
      },
      message(ws, message) {
        const text = String(message)
        if (text === "who") {
          ws.send(JSON.stringify({ authorization: ws.data.authorized }))
          return
        }
        if (text === "big") {
          // Exercises the 16-bit length path in both directions.
          ws.send("x".repeat(70000))
          return
        }
        if (text === "bye") {
          ws.close()
          return
        }
        ws.send(`echo:${text}`)
      },
    },
  })
}

async function connect(socket: string, received: string[], onClose?: () => void) {
  return open({
    unix: socket,
    endpoint: "/v1/tts/speak/stream",
    host: "tts.local",
    headers: { Authorization: "Bearer tts_test" },
    handlers: { onMessage: (text) => received.push(text), onClose },
  })
}

test("completes the handshake and round-trips text frames", async () => {
  const socket = path.join(tmpdir(), `opencode-ws-${process.pid}-a.sock`)
  const instance = server(socket)
  const received: string[] = []
  const ws = await connect(socket, received)

  ws.send("hello")
  await Bun.sleep(80)
  expect(received).toEqual(["echo:hello"])

  ws.close()
  instance.stop(true)
  await rm(socket, { force: true })
})

test("sends the authorization header through the upgrade", async () => {
  const socket = path.join(tmpdir(), `opencode-ws-${process.pid}-b.sock`)
  const instance = server(socket)
  const received: string[] = []
  const ws = await connect(socket, received)

  ws.send("who")
  await Bun.sleep(80)
  expect(JSON.parse(received[0]!).authorization).toBe("Bearer tts_test")

  ws.close()
  instance.stop(true)
  await rm(socket, { force: true })
})

test("reassembles a payload past the 125-byte length boundary", async () => {
  const socket = path.join(tmpdir(), `opencode-ws-${process.pid}-c.sock`)
  const instance = server(socket)
  const received: string[] = []
  const ws = await connect(socket, received)

  // Out: a 300-char frame uses the 16-bit length. Back: 70000 chars.
  ws.send("y".repeat(300))
  await Bun.sleep(80)
  expect(received[0]).toBe("echo:" + "y".repeat(300))

  ws.send("big")
  await Bun.sleep(150)
  expect(received[1]).toHaveLength(70000)

  ws.close()
  instance.stop(true)
  await rm(socket, { force: true })
})

test("reports a close initiated by the daemon", async () => {
  const socket = path.join(tmpdir(), `opencode-ws-${process.pid}-d.sock`)
  const instance = server(socket)
  const received: string[] = []
  let closed = false
  const ws = await connect(socket, received, () => (closed = true))

  ws.send("bye")
  await Bun.sleep(120)
  expect(closed).toBe(true)
  expect(ws.closed).toBe(true)

  instance.stop(true)
  await rm(socket, { force: true })
})

test("rejects when the upgrade is refused", async () => {
  const socket = path.join(tmpdir(), `opencode-ws-${process.pid}-e.sock`)
  const instance = server(socket, { reject: true })
  const error = await connect(socket, []).catch((error) => error)
  expect(error).toBeInstanceOf(WebSocketError)
  expect(error.status).toBe(403)
  instance.stop(true)
  await rm(socket, { force: true })
})

test("rejects when the socket is not there", async () => {
  const error = await connect(path.join(tmpdir(), "opencode-ws-absent.sock"), []).catch((error) => error)
  expect(error).toBeInstanceOf(WebSocketError)
  expect(error.message).toContain("cannot reach")
})
