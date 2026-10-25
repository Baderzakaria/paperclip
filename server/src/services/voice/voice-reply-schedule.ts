import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { chatActions, chatEndpoints, chatVoiceSessions, type Db } from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import { instanceSettingsService } from "../instance-settings.js";
import { recoverVoiceReplyDispatches } from "./voice-reply-dispatch-recovery.js";
import { notifyVoiceReplies, type VoiceReplyScope } from "./voice-reply-notifications.js";
import { VOICE_REPLY_ACTION_KIND, VOICE_REPLY_DISPATCH_TIMEOUT_MS } from "./voice-reply-policy.js";
import { readVoiceReplyState } from "./voice-reply-state.js";
import type { voiceSessionStore } from "./voice-session-store.js";

export type VoiceReplyEntry = {
  id: string;
  kind: "session" | "action";
  sourceId: string;
  sessionId: string | null;
  companyId: string;
  endpointId: string;
  connectionId: string;
  dueAt: number;
};

/** Existing sessions and dispatch intents own separate obligations. In particular,
 * ending a call must not erase an unacknowledged provider send. */
export function voiceReplySchedule(db: Db, operations: {
  store: Pick<ReturnType<typeof voiceSessionStore>, "authorizeSession" | "collectMissedReplies">;
  push(sessionId: string): Promise<void>;
}) {
  // Live-call recovery already rechecks authority before provider inspection.
  // Remember only denied inspections so a later successful check can wake them
  // without making every healthy call inspection rescan an idle reply queue.
  const authorityBlocked = new Map<string, VoiceReplyEntry>();
  async function authorityAvailable(tx: object, sessionId: string) {
    if (authorityBlocked.has(sessionId)) await notifyVoiceReplies(tx, { kind: "session", id: sessionId });
  }
  async function load(scope?: VoiceReplyScope, signal?: AbortSignal): Promise<VoiceReplyEntry[]> {
    const entries: VoiceReplyEntry[] = [];
    let cursor: string | undefined;
    for (;;) {
      signal?.throwIfAborted();
      const rows = await db.select({ id: chatVoiceSessions.id, companyId: chatVoiceSessions.companyId,
        endpointId: chatVoiceSessions.endpointId, connectionId: chatEndpoints.connectionId })
        .from(chatVoiceSessions).innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatVoiceSessions.endpointId), eq(chatEndpoints.companyId, chatVoiceSessions.companyId)))
        .where(and(inArray(chatVoiceSessions.mode, ["inbound_phone", "outbound_phone"]),
          inArray(chatVoiceSessions.state, ["connecting", "active"]), gt(chatVoiceSessions.expiresAt, new Date()),
          scope?.kind === "session" ? eq(chatVoiceSessions.id, scope.id) : undefined,
          scope?.kind === "endpoint" ? eq(chatVoiceSessions.endpointId, scope.id) : undefined,
          scope?.kind === "connection" ? eq(chatEndpoints.connectionId, scope.id) : undefined,
          scope?.kind === "company" ? eq(chatVoiceSessions.companyId, scope.id) : undefined,
          cursor ? gt(chatVoiceSessions.id, cursor) : undefined)).orderBy(chatVoiceSessions.id).limit(100);
      entries.push(...rows.map(row => ({ ...row, id: `session:${row.id}`, sourceId: row.id,
        sessionId: row.id, kind: "session" as const, dueAt: 0 })));
      if (rows.length < 100) break;
      cursor = rows[rows.length - 1].id;
    }
    cursor = undefined;
    for (;;) {
      signal?.throwIfAborted();
      const rows = await db.select({ id: chatActions.id, companyId: chatActions.companyId, endpointId: chatActions.endpointId,
        connectionId: chatEndpoints.connectionId, sessionId: sql<string | null>`${chatActions.payload}->>'sessionId'`, updatedAt: chatActions.updatedAt })
        .from(chatActions).innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatActions.endpointId), eq(chatEndpoints.companyId, chatActions.companyId)))
        .where(and(eq(chatActions.kind, VOICE_REPLY_ACTION_KIND), eq(chatActions.status, "dispatching"),
          scope?.kind === "session" ? sql`${chatActions.payload}->>'sessionId' = ${scope.id}` : undefined,
          scope?.kind === "endpoint" ? eq(chatActions.endpointId, scope.id) : undefined,
          scope?.kind === "connection" ? eq(chatEndpoints.connectionId, scope.id) : undefined,
          scope?.kind === "company" ? eq(chatActions.companyId, scope.id) : undefined,
          cursor ? gt(chatActions.id, cursor) : undefined)).orderBy(chatActions.id).limit(100);
      entries.push(...rows.map(({ updatedAt, ...row }) => ({ ...row, id: `action:${row.id}`, sourceId: row.id,
        kind: "action" as const, dueAt: updatedAt.getTime() + VOICE_REPLY_DISPATCH_TIMEOUT_MS + 1 })));
      if (rows.length < 100) break;
      cursor = rows[rows.length - 1].id;
    }
    const retained = new Set(entries.filter(entry => entry.kind === "session").map(entry => entry.sourceId));
    for (const entry of authorityBlocked.values()) {
      const matches = !scope || (scope.kind === "session" ? entry.sourceId : scope.kind === "endpoint" ? entry.endpointId
        : scope.kind === "connection" ? entry.connectionId : entry.companyId) === scope.id;
      if (matches && !retained.has(entry.sourceId)) authorityBlocked.delete(entry.sourceId);
    }
    if (!entries.length) return entries;
    return (await instanceSettingsService(db).getExperimental()).enableChatConnectors ? entries : [];
  }

  async function sessionDeadline(entry: VoiceReplyEntry): Promise<number | null> {
    try {
      return await db.transaction(async tx => {
        const { session } = await operations.store.authorizeSession(tx, entry.companyId, entry.sourceId);
        authorityBlocked.delete(entry.sourceId);
        if (!session.providerSessionId || !["inbound_phone", "outbound_phone"].includes(session.mode)
          || !["connecting", "active"].includes(session.state) || session.expiresAt.getTime() <= Date.now()) return null;
        await operations.store.collectMissedReplies(tx, session);
        const state = await readVoiceReplyState(tx, session);
        const due = state.kind === "in_flight" ? state.retryAt
          : state.kind !== "reply" || state.plan.kind === "blocked" ? null
          : state.plan.kind === "retry" ? state.plan.retryAt : 0;
        return due === null ? null : Math.min(due, session.expiresAt.getTime());
      });
    } catch (error) {
      if (error instanceof HttpError && [403, 404].includes(error.status)) {
        if (error.status === 403) authorityBlocked.set(entry.sourceId, entry);
        else authorityBlocked.delete(entry.sourceId);
        return null;
      }
      throw error;
    }
  }

  async function check(entry: VoiceReplyEntry, signal?: AbortSignal): Promise<VoiceReplyEntry | null> {
    signal?.throwIfAborted();
    if (!(await instanceSettingsService(db).getExperimental()).enableChatConnectors) return null;
    if (entry.kind === "action") {
      await recoverVoiceReplyDispatches(db, { actionId: entry.sourceId });
      const [action] = await db.select({ updatedAt: chatActions.updatedAt }).from(chatActions)
        .where(and(eq(chatActions.id, entry.sourceId), eq(chatActions.kind, VOICE_REPLY_ACTION_KIND), eq(chatActions.status, "dispatching")));
      return action ? { ...entry, dueAt: action.updatedAt.getTime() + VOICE_REPLY_DISPATCH_TIMEOUT_MS + 1 } : null;
    }
    let dueAt = await sessionDeadline(entry);
    if (dueAt !== null && dueAt <= Date.now()) {
      signal?.throwIfAborted();
      await operations.push(entry.sourceId);
      dueAt = await sessionDeadline(entry);
    }
    return dueAt === null ? null : { ...entry, dueAt };
  }
  return { load, check, authorityAvailable };
}
