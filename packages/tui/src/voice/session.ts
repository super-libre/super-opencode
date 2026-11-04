import path from "path"
import { rename, rm, writeFile } from "fs/promises"
import type { Session } from "./daemon"

// The Super Voice session token: a 0600 file in the TUI's state directory,
// beside the prompt history. One token serves dictation and speech both. Taken
// from the caller rather than resolved here, so a test pointed at a scratch
// directory cannot write over a real token.
//
// It is deliberately not an entry in auth.json, because every `type: "api"`
// record there is merged in as an LLM provider (see provider.ts loadAuth),
// which would surface a phantom provider in the model list.
const NAME = "super-voice.json"

const MODE = 0o600

export async function read(directory: string): Promise<Session | undefined> {
  const data = (await Bun.file(path.join(directory, NAME))
    .json()
    .catch(() => undefined)) as Partial<Session> | undefined
  if (!data || typeof data.token !== "string" || !data.token) return undefined
  if (expired(data.expires)) return undefined
  return { token: data.token, scopes: data.scopes ?? [], expires: data.expires }
}

export async function write(directory: string, session: Session) {
  const file = path.join(directory, NAME)
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(session), { mode: MODE }).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
  // rename keeps the temporary file's mode, so the credential is never briefly
  // world-readable at its final path.
  await rename(temporary, file).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
}

function expired(value?: string) {
  if (!value) return false
  const at = Date.parse(value)
  if (Number.isNaN(at)) return false
  return at <= Date.now()
}
