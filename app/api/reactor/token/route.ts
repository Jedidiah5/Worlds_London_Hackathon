import { NextResponse } from "next/server";

const MODEL_NAME = "reactor/lingbot-world-2";
const MAX_SESSIONS = 10;
const TOKEN_LIFETIME_SECONDS = 60 * 60;

export async function GET() {
  const apiKey = process.env.REACTOR_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Live session credentials are not set on the server." },
      { status: 500 },
    );
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_COORDINATOR_URL ?? "https://api.reactor.inc";
  try {
    const response = await fetch(`${baseUrl}/tokens`, {
      method: "POST",
      headers: {
        "Reactor-API-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expires_after: TOKEN_LIFETIME_SECONDS,
        authorization_details: [
          {
            type: "session",
            resources: { models: { match: [MODEL_NAME] } },
            constraints: { max_sessions: MAX_SESSIONS },
          },
        ],
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      jwt?: string;
      expires_at?: number;
      error?: string;
      message?: string;
    };
    if (!response.ok || !payload.jwt || !payload.expires_at) {
      return NextResponse.json(
        {
          error:
            payload.error ??
            payload.message ??
            `Session token request returned ${response.status}.`,
        },
        { status: 502 },
      );
    }

    // No HTTP caching: the client decides when a new token is needed.
    //
    // A session-scoped JWT is bound to the session it opened. Reuse it for that
    // whole session (or polling and uploads 403 with "this token is
    // session-scoped and is not authorized for this resource"), but mint a
    // fresh one for each new session. The client caches it and invalidates on
    // connect, so both halves of that hold.
    return NextResponse.json(
      { jwt: payload.jwt, expires_at: payload.expires_at },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The live session service is unavailable.",
      },
      { status: 502 },
    );
  }
}
