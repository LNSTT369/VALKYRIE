import type { Env } from "../env.d";
import { createD1Client } from "../storage/d1/client";
import { insertAlphaSignal } from "../storage/d1/queries/signals";
import type { AlphaSignal } from "../signals/types";
import { DEFAULT_TTL } from "../signals/types";
import { generateId, nowISO } from "../lib/utils";

// Inbound message types the stream endpoint understands
type StreamInbound =
  | { type: "subscribe"; symbols: string[] }
  | { type: "unsubscribe"; symbols: string[] }
  | { type: "signal"; payload: Omit<AlphaSignal, "signal_id" | "generated_at"> }
  | { type: "ping" };

type StreamOutbound =
  | { type: "subscribed"; symbols: string[] }
  | { type: "signal_accepted"; signal_id: string; symbol: string }
  | { type: "pong"; ts: string }
  | { type: "error"; message: string };

export async function handleStreamConnection(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    return new Response(
      JSON.stringify({ error: "UNAUTHORIZED", message: "Missing Bearer token" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const db = createD1Client(env.DB);
  try {
    const row = await db.executeOne(
      "SELECT key_id FROM api_keys WHERE token_hash = ? AND (revoked = 0 OR revoked IS NULL)",
      [token]
    );

    if (!row) {
      return new Response(
        JSON.stringify({ error: "UNAUTHORIZED", message: "Invalid or revoked Bearer token" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "INTERNAL_ERROR", message: "Database authentication failure" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const upgrade = request.headers.get("Upgrade");
  if (upgrade !== "websocket") {
    return new Response(
      JSON.stringify({ error: "Expected WebSocket upgrade" }),
      { status: 426, headers: { "Content-Type": "application/json" } }
    );
  }

  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();

  const subscriptions = new Set<string>();

  server.addEventListener("message", async (event) => {
    let msg: StreamInbound;

    try {
      msg = JSON.parse(event.data as string) as StreamInbound;
    } catch {
      send(server, { type: "error", message: "Invalid JSON" });
      return;
    }

    try {
      if (msg.type === "ping") {
        send(server, { type: "pong", ts: nowISO() });
        return;
      }

      if (msg.type === "subscribe") {
        const symbols = msg.symbols.map((s) => s.toUpperCase());
        symbols.forEach((s) => subscriptions.add(s));
        send(server, { type: "subscribed", symbols: Array.from(subscriptions) });
        return;
      }

      if (msg.type === "unsubscribe") {
        msg.symbols.map((s) => s.toUpperCase()).forEach((s) => subscriptions.delete(s));
        send(server, { type: "subscribed", symbols: Array.from(subscriptions) });
        return;
      }

      if (msg.type === "signal") {
        const p = msg.payload;
        const signal: AlphaSignal = {
          ...p,
          signal_id: generateId(),
          generated_at: nowISO(),
          ttl_seconds: p.ttl_seconds ?? DEFAULT_TTL[p.urgency],
          regime_tags: p.regime_tags ?? [],
          supporting_data: p.supporting_data ?? {},
        };

        const db = createD1Client(env.DB);
        const id = await insertAlphaSignal(db, signal);
        send(server, { type: "signal_accepted", signal_id: id, symbol: signal.symbol });
        return;
      }

      send(server, { type: "error", message: `Unknown message type` });
    } catch (err) {
      send(server, { type: "error", message: String(err) });
    }
  });

  server.addEventListener("close", () => {
    subscriptions.clear();
  });

  return new Response(null, { status: 101, webSocket: client });
}

function send(ws: WebSocket, msg: StreamOutbound): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // connection already closed
  }
}
