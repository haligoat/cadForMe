// AI providers for cadSlop: Claude (Anthropic API), Gemini, OpenAI. Each teammate keeps their own key
// in the macOS Keychain (via Electron safeStorage); keys never go into the project or git.
import Anthropic from "@anthropic-ai/sdk";

export const PROVIDERS = {
  "claude-code": { label: "Claude Code (installed CLI)", needsKey: false },
  anthropic: { label: "Claude API key", needsKey: true, model: "claude-opus-5-5" },
  gemini: { label: "Google Gemini API key", needsKey: true, model: "gemini-2.5-pro" },
  openai: { label: "OpenAI API key", needsKey: true, model: "gpt-4.1" },
};

async function claude({ key, model, system, prompt, images }) {
  const client = new Anthropic({ apiKey: key });
  try {
    // Streaming keeps long part files from hitting request timeouts. Server-side fallback (default routing)
    // re-runs the request on another model if this one declines.
    const stream = client.beta.messages.stream({
      model, max_tokens: 64000, system,
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: [...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })), { type: "text", text: prompt }] }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") throw new Error(`Claude declined this request${msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : ""}`);
    if (msg.stop_reason === "max_tokens") throw new Error("The answer was cut off (too long). Try a smaller change");
    return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error("Anthropic rejected the API key. Check it in the AI tab");
    if (e instanceof Anthropic.RateLimitError) throw new Error("Anthropic rate limit reached. Wait a moment and try again");
    if (e instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${e.status}: ${e.message}`);
    throw e;
  }
}

async function gemini({ key, model, system, prompt, images }) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [...images.map((i) => ({ inlineData: { mimeType: i.mime, data: i.data } })), { text: prompt }] }], generationConfig: { maxOutputTokens: 32768 } }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${j.error?.message ?? "request failed"}`);
  const cand = j.candidates?.[0];
  if (!cand?.content) throw new Error(`Gemini returned no answer${cand?.finishReason ? ` (${cand.finishReason})` : ""}`);
  return cand.content.parts.map((p) => p.text ?? "").join("");
}

async function openai({ key, model, system, prompt, images }) {
  const res = await fetch(`${process.env.CADSLOP_OPENAI_BASE || "https://api.openai.com"}/v1/chat/completions`, { // env override is for tests only
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: images.length ? [{ type: "text", text: prompt }, ...images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } }))] : prompt }] }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${j.error?.message ?? "request failed"}`);
  return j.choices?.[0]?.message?.content ?? "";
}

/** One request/response with the chosen provider. `images` are { mime, data (base64) }. Returns the text answer. */
export function complete(provider, cfg, system, prompt, images = []) {
  const fn = { anthropic: claude, gemini, openai }[provider];
  if (!fn) throw new Error(`Unknown AI provider "${provider}"`);
  if (!cfg?.key) throw new Error(`Add your ${PROVIDERS[provider].label} in the AI tab first`);
  return fn({ key: cfg.key, model: cfg.model || PROVIDERS[provider].model, system, prompt, images });
}

/** Pull the updated part JSON (and a one-line summary) out of a model answer. */
export function extractPart(text) {
  const summary = (text.match(/^SUMMARY:\s*(.+)$/m)?.[1] ?? "").trim();
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = fenced.length ? fenced : [text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const c of candidates.reverse()) {
    try {
      const j = JSON.parse(c);
      if (j && typeof j === "object" && Array.isArray(j.features)) return { part: j, summary };
    } catch { /* try the next block */ }
  }
  return { part: null, summary: summary || text.trim().slice(0, 600) };
}
