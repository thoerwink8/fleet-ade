// OpenAI-compatible chat call against the magpie gateway. The key stays in the
// Authorization header and is never logged. Tests pass a stand-in `fetch`.
function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("model reply has no JSON object");
  return JSON.parse(body.slice(start, end + 1));
}

async function complete({ baseUrl, model, apiKey, messages, fetchImpl }) {
  const fetchFn = fetchImpl ?? fetch;
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetchFn(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, temperature: 0, messages }),
  });
  if (!response.ok) {
    throw new Error(`magpie ${response.status}`);
  }
  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("magpie reply is empty");
  return extractJson(text);
}

module.exports = { extractJson, complete };
