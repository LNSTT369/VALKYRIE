import type { Env } from "../env.d";
import { createD1Client } from "../storage/d1/client";
import { encryptText } from "../lib/utils";

export async function handlePortalGet(request: Request, env: Env): Promise<Response> {
  if (request.method === "POST") {
    // API Credentials Setup
    try {
      const body = await request.json() as {
        token: string;
        alpaca_api_key: string;
        alpaca_api_secret: string;
        alpaca_paper: boolean;
      };
      
      const { token, alpaca_api_key, alpaca_api_secret, alpaca_paper } = body;
      const db = createD1Client(env.DB);
      const secretKey = env.KILL_SWITCH_SECRET || "default-fallback-super-secret-key-123456";
      const encryptedKey = await encryptText(alpaca_api_key, secretKey);
      const encryptedSecret = await encryptText(alpaca_api_secret, secretKey);
      
      await db.run(
        `UPDATE api_keys SET alpaca_api_key = ?, alpaca_api_secret = ?, alpaca_paper = ? WHERE key_id = 'master' OR token_hash = ?`,
        [encryptedKey, encryptedSecret, alpaca_paper ? 1 : 0, token]
      );
      
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }

  // Serve the React app index.html for GET /portal
  // We rewrite the request to /index.html and strip unnecessary headers
  const url = new URL(request.url);
  url.pathname = "/index.html";
  return env.ASSETS.fetch(new Request(url.toString()));
}
