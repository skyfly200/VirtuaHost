// Small fetch wrapper: JSON or binary, with a timeout and readable errors.
async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 60000, binary = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
    const err = new Error(`${method} ${new URL(url).host} failed: ${res.status} ${detail}`.trim());
    err.status = res.status;
    throw err;
  }
  return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
}

module.exports = { request };
