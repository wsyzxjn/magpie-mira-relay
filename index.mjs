// Mirasim, as a provider plugin for OpenCode and magpie.
//
// A Mirasim deployment serves its model API and its quota page from the same
// origin: <origin>/v1 for the API, <origin>/usage for the quota. The quota page
// needs no sign-in, so the numbers below come from the base URL the user typed
// at login. The API key is only ever used to sign requests.

// A deployment is a provider of its own: each is reached at its own base URL
// and holds its own key, and each sets its own default. Signing one in twice
// would make magpie offer one provider twice, with one set of models behind
// both, so the deployments are named here instead.
const DEPLOYMENTS = {
  mirasim: { name: "Mirasim", base: "https://mira.renako.cc" },
  "mirasim-lxns": { name: "Mirasim Lxns", base: "https://mira.lxns.org" },
}

const makePlugin = (id) => async ({ client }) => {
const CLIENT = "opencode-mirasim-auth/0.1.0"

// A model has exactly one API: magpie's gateway converts an agent's request
// into that shape, and the plugin's fetch is what finally sends it. magpie
// plugins have no way to declare one model on several APIs — the top-level
// npm decides for the whole provider — so a provider serving both families
// says which is which on each model instead.
//
// Mirasim draws the line itself and answers with a 400 if you cross it:
// the Claude family is on the Anthropic Messages API, and everything else is
// on OpenAI Responses.
const APIS = {
  responses: { npm: "@ai-sdk/openai", path: "/responses" },
  anthropic: { npm: "@ai-sdk/anthropic", path: "/messages" },
  chat: { npm: "@ai-sdk/openai-compatible", path: "/chat/completions" },
}

// The default for a model whose family is not stated below.
const DEFAULT_API = "responses"

const apiFor = (id) => (/^claude-/i.test(id) ? "anthropic" : DEFAULT_API)

// The reasoning efforts offered for a model that thinks. These are the efforts
// magpie's own agents know how to send, so a model here takes the same set.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

const num = (v) => {
  const n = Number.parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""))
  return Number.isFinite(n) ? n : null
}

// A base URL is whatever the user typed: a site root, or one that already ends
// in the API prefix. The API lives under <root>/v1 and the quota page at
// <root>/usage, so both are derived from the root alone.
function roots(raw) {
  let s = String(raw ?? "").trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null // some other scheme, not a host
    s = "https://" + s
  }
  let u
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null
  // /v1, /api/v1 and /v1/messages all name the same service; the site root is
  // the one form they share.
  const path = u.pathname.replace(/\/+$/, "").replace(/\/(api\/)?v1(\/.*)?$/i, "")
  return {
    origin: u.origin,
    api: u.origin + (path || "") + "/v1",
    usage: u.origin + (path || "") + "/usage",
    models: u.origin + (path || "") + "/v1/models",
  }
}

// The quota page is server-rendered HTML, so the windows are read back out of
// it. Each limit is one <section class="w">: a title, the share used, and the
// time the window resets.
function parseUsage(html) {
  const out = { windows: [] }
  const text = String(html ?? "")

  const section = /<section class="w">([\s\S]*?)<\/section>/g
  let m
  while ((m = section.exec(text)) !== null) {
    const block = m[1]
    const name = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1]?.replace(/<[^>]+>/g, "").trim()
    if (!name) continue
    const used = num(block.match(/<p class="pct"[^>]*>\s*([\d.]+)\s*%/)?.[1])
    if (used === null) continue
    // The reset time is the title of the span in the "resets in …" line. The
    // rendered text is a duration, so the title is the only exact value here.
    const resetsAt = block.match(/<span title="([^"]+)"/)?.[1]?.trim()
    const at = resetsAt ? new Date(resetsAt) : null
    out.windows.push({
      name,
      used,
      resetsAt: at && !Number.isNaN(at.getTime()) ? at.toISOString() : undefined,
    })
  }

  // "resets in 2h 24m" only appears when a window has no absolute reset time;
  // count it forward from now so the ring still gets a reset to count down to.
  const relative = /resets in\s*(?:<[^>]+>)*([\d.]+)\s*d(?:ays?)?\s*([\d.]+)\s*h/gi
  let r
  let idx = 0
  while ((r = relative.exec(text)) !== null) {
    const w = out.windows[idx++]
    if (w && !w.resetsAt) w.resetsAt = new Date(Date.now() + (Number(r[1]) * 86400 + Number(r[2]) * 3600) * 1000).toISOString()
  }
  const hours = /resets in\s*(?:<[^>]+>)*([\d.]+)\s*h(?:ours?|rs?)?\s*([\d.]+)?\s*m/i
  const hm = hours.exec(text)
  if (hm && out.windows[0] && !out.windows[0].resetsAt) {
    out.windows[0].resetsAt = new Date(Date.now() + (Number(hm[1]) * 3600 + Number(hm[2] || 0) * 60) * 1000).toISOString()
  }

  return out
}

  const log = (level, message) => {
    try {
      client?.app?.log?.({ level, service: id, message })
    } catch {}
  }

  return {
    // The provider itself. Models are declared as the site lists them, so an
    // account that has not answered yet still shows a usable provider.
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[id] ??= {
        name: DEPLOYMENTS[id].name,
        // The fallback for a deployment that has not been given a base URL
        // yet; a signed-in account reads its own address from metadata.
        npm: APIS[DEFAULT_API].npm,
        api: DEPLOYMENTS[id].base + "/v1",
        // What the deployments serve, on the 1M context window they are on,
        // each naming the API it is served on (see apiFor above). A signed-in
        // account gets the live list from /v1/models instead and keeps these
        // limits; a model neither declared nor listed is given the same window
        // by the provider hook below.
        // magpie reads the keys of `variants` as the reasoning efforts a model
        // takes, and offers them in the model picker. reasoning: true on its
        // own only says the model thinks, not which efforts it takes, so a
        // model left without variants offers the agent nothing to pick.
        models: Object.fromEntries(
          Object.entries({
            "claude-opus-5": { name: "Claude Opus 5", limit: { context: 1000000, output: 64000 }, reasoning: true, tool_call: true },
            "claude-opus-5-5": { name: "Claude Opus 5.5", limit: { context: 1000000, output: 64000 }, reasoning: true, tool_call: true },
            "claude-opus-4-6": { name: "Claude Opus 4.6", limit: { context: 1000000, output: 64000 }, reasoning: true, tool_call: true },
            "claude-opus-4-8": { name: "Claude Opus 4.8", limit: { context: 1000000, output: 64000 }, reasoning: true, tool_call: true },
            "claude-sonnet-5": { name: "Claude Sonnet 5", limit: { context: 1000000, output: 64000 }, reasoning: true, tool_call: true },
            "claude-fable-5": { name: "Claude Fable 5", limit: { context: 1000000, output: 64000 }, reasoning: true, tool_call: true },
            "claude-fable-5-1": { name: "Claude Fable 5.1", limit: { context: 1000000, output: 64000 }, reasoning: true, tool_call: true },
            "claude-haiku-4-5": { name: "Claude Haiku 4.5", limit: { context: 1000000, output: 64000 }, reasoning: true, tool_call: true },
            "gpt-6-astra": { name: "GPT 6 Astra", limit: { context: 1000000, output: 64000 }, reasoning: true, tool_call: true },
            "gpt-6.1-sol": { name: "GPT 6.1 Sol", limit: { context: 1000000, output: 64000 }, reasoning: true, tool_call: true },
            "gpt-5.6-sol": { name: "GPT 5.6 Sol", limit: { context: 1000000, output: 64000 }, reasoning: true, tool_call: true },
            "glm-5.3-flash": { name: "GLM 5.3 Flash", limit: { context: 1000000, output: 64000 }, reasoning: true, tool_call: true },
            "deepseek-flash": { name: "DeepSeek Flash", limit: { context: 1000000, output: 64000 }, reasoning: true, tool_call: true },
          }).map(([model, spec]) => [
            model,
            {
              ...spec,
              ...(spec.reasoning ? { variants: Object.fromEntries(EFFORTS.map((e) => [e, {}])) } : {}),
              provider: { npm: APIS[apiFor(model)].npm },
            },
          ]),
        ),
      }
    },

    auth: {
      provider: id,
      maxConcurrency: 8,
      methods: [
        {
          type: "api",
          label: "Mirasim",
          placeholder: "https://mira.renako.cc",
          // The base URL is asked for first: a key alone says nothing about
          // which deployment it is for, and the quota page is read from that
          // same origin. The key is not a prompt — magpie asks for it itself
          // once this returns, and keeps it, so the answer here carries the
          // address and an empty key that magpie then fills in.
          prompts: [
            {
              type: "text",
              key: "baseURL",
              message: "Base URL",
              placeholder: DEPLOYMENTS[id].base,
              validate: (v) => (roots(v) ? undefined : "A http(s) address, e.g. https://mira.renako.cc"),
            },
          ],
          async authorize(inputs) {
            const r = roots(inputs?.baseURL)
            if (!r) return { type: "failed", error: `That base URL can't be read: ${inputs?.baseURL || "empty"}` }
            // No `key` here: returning one (even an empty string) makes
            // magpie store that instead of the key the user just typed.
            // Leaving it out lets magpie keep the key it collected itself.
            return { type: "success", metadata: { baseURL: r.api.replace(/\/v1$/, "") } }
          },
        },
      ],

      // Everything this account sends, and the quota read that magpie shows.
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        const r = roots(auth.metadata?.baseURL) ?? roots(DEPLOYMENTS[id].base)
        const headers = { "x-api-key": auth.key, "x-mirasim-client": CLIENT }

        return {
          baseURL: r.api,
          fetch(input, init) {
            const h = new Headers(init?.headers)
            for (const [k, v] of Object.entries(headers)) h.set(k, v)
            return fetch(input, { ...init, headers: h })
          },
        }
      },

      // magpie's own hook. The quota page needs no sign-in, so this is a plain
      // read of the deployment's own /usage.
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") return { error: "Not signed in", windows: [] }
        const r = roots(auth.metadata?.baseURL) ?? roots(DEPLOYMENTS[id].base)

        let res
        try {
          res = await fetch(r.usage, { headers: { accept: "text/html" } })
        } catch (e) {
          return { error: `Couldn't reach ${r.usage}: ${e?.message ?? e}`, windows: [] }
        }
        if (!res.ok) return { error: `Mirasim answered ${res.status}`, windows: [] }

        const { windows } = parseUsage(await res.text())
        if (!windows.length) return { error: "No quota windows on the usage page", windows: [] }

        // A window that resets in 5 hours is a 5-hour window; magpie reads the
        // span to pace routing across accounts.
        const spans = { "current session": 5 * 3600, "this week": 7 * 86400 }
        return {
          windows: windows.map((w) => ({
            ...w,
            ...(spans[w.name.toLowerCase()] ? { span: spans[w.name.toLowerCase()] } : {}),
          })),
        }
      },
    },

    // Models the deployment is serving right now. A failure keeps the declared
    // list rather than emptying the picker.
    provider: {
      id,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models
        const r = roots(auth.metadata?.baseURL) ?? roots(DEPLOYMENTS[id].base)
        try {
          const res = await fetch(r.models, { headers: { "x-api-key": auth.key, authorization: `Bearer ${auth.key}` } })
          if (!res.ok) return provider.models
          const body = await res.json()
          const ids = (body?.data ?? []).map((m) => m?.id).filter(Boolean)
          if (!ids.length) return provider.models

          // A model the site lists but the config hook never named still needs
          // limits, so it copies the nearest one declared.
          const template = provider.models["claude-fable-5-1"] ?? Object.values(provider.models)[0]
          return Object.fromEntries(
            ids.map((id) => [
              id,
              // A model the site lists but the config hook never named still has
              // to be sent on the right API, or the deployment answers 400.
              { ...(provider.models[id] ?? template), id, name: id, provider: { npm: APIS[apiFor(id)].npm } },
            ]),
          )
        } catch (e) {
          log("warn", `model list failed: ${e?.message ?? e}`)
          return provider.models
        }
      },
    },
  }
}

// One export per provider. magpie calls each and takes the hooks it returns,
// so one package can offer several deployments without a name clash.
export const MirasimPlugin = makePlugin("mirasim")
export const MirasimLxnsPlugin = makePlugin("mirasim-lxns")
