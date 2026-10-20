import { accessKeyConfigured } from "../auth.js";
import { checkPassword, issueToken, loginConfigured } from "../session.js";
import { clearFailures, isBlocked, recordFailure } from "../throttle.js";

const clientIp = (req: Request) =>
  req.headers.get("x-nf-client-connection-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";

// GET  /api/login   which sign-in methods this site accepts (public, reveals nothing secret)
// POST /api/login   { username, password } -> { token, expiresAt, username }
// DELETE is not needed: tokens are stateless, so signing out just forgets the token.
export async function handleLogin(req: Request): Promise<Response> {
  if (req.method === "GET") {
    return Response.json({ passwordLogin: loginConfigured(), accessKey: accessKeyConfigured(), disabled: process.env.AUTH_DISABLED === "true" });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (!loginConfigured()) {
    return Response.json({ error: "Password login is not set up: set LOGIN_USERS and SESSION_SECRET (32+ characters) on the site" }, { status: 503 });
  }

  const ip = clientIp(req);
  if (await isBlocked(ip)) {
    return Response.json({ error: "Too many wrong attempts. Wait ten minutes and try again." }, { status: 429 });
  }

  let body: { username?: unknown; password?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  }
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password || password.length > 200) {
    return Response.json({ error: "Enter a username and password" }, { status: 400 });
  }

  if (!checkPassword(username, password)) {
    await recordFailure(ip);
    return Response.json({ error: "Wrong username or password" }, { status: 401 });
  }
  await clearFailures(ip);
  return Response.json({ ...issueToken(username), username });
}
