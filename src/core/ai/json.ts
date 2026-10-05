// Tolerant JSON parsing for model output (shared by the local model and the team hub client).

/** Parses the first complete JSON object in a model response (tolerates stray text around it). */
export function parseModelJson<T>(text: string): T {
  try { return JSON.parse(text) as T; } catch { /* fall through to repair and extraction */ }
  // Seen with Qwen3.5 when the thinking budget is 0: the opening brace is swallowed with the
  // closed thought segment and the answer starts at the first key.
  const t = text.trim();
  if (t.startsWith('"')) { try { return JSON.parse(`{${t}${t.endsWith('}') ? '' : '}'}`) as T; } catch { /* keep trying */ } }
  const start = text.indexOf('{');
  let depth = 0, inStr = false, esc = false;
  for (let i = Math.max(0, start); start >= 0 && i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1)) as T;
  }
  throw new Error(`Model returned no JSON object: ${JSON.stringify(text.slice(0, 200))}`);
}
