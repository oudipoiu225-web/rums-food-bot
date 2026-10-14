import crypto from "node:crypto";
import { cookies } from "next/headers";
import { eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import type { User } from "@/db/schema";

const COOKIE_NAME = "rums_session";
const SESSION_DAYS = 30;

function randomId(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export async function createSession(userId: number): Promise<void> {
  const token = randomId() + randomId();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await db.insert(sessions).values({ id: token, userId, expiresAt });
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const sid = store.get(COOKIE_NAME)?.value;
  if (sid) {
    await db.delete(sessions).where(eq(sessions.id, sid)).catch(() => undefined);
    store.delete(COOKIE_NAME);
  }
}

export async function getCurrentUser(): Promise<User | null> {
  const store = await cookies();
  const sid = store.get(COOKIE_NAME)?.value;
  if (!sid) return null;

  const [row] = await db
    .select({ user: users, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sid));
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, sid));
    return null;
  }
  return row.user;
}

export async function pruneExpiredSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}