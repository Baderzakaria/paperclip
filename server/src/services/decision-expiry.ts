import { and, asc, eq, lte, sql } from "drizzle-orm";
import { decisions, type Db } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { writeDecisionChange } from "./decision-work-notifications.js";

type Decision = typeof decisions.$inferSelect;
type ExpiryReason = "ttl" | "target_gone" | "target_completed";
const open = sql`${decisions.status} = 'open'`;

export function decisionExpiryService(db: Db, deliverContinuation: (id: string) => Promise<void>) {
  async function expire(decision: Decision, reason: ExpiryReason, now: Date) {
    const [updated] = await writeDecisionChange(db, async tx => tx.update(decisions).set({
      status: "expired", updatedAt: now,
      metadata: sql`${decisions.metadata} || ${JSON.stringify({ expiredReason: reason,
        ...(decision.continuationPolicy === "wake_origin_agent" ? { continuationPending: true } : {}) })}::jsonb`,
    }).where(and(eq(decisions.id, decision.id), open,
      reason === "ttl" ? lte(decisions.expiresAt, now) : undefined)).returning());
    if (!updated) return 0;
    await logActivity(db, { companyId: updated.companyId, actorType: "system", actorId: "decision-expiry-sweeper",
      agentId: updated.originAgentId, runId: updated.originRunId, action: "decision.expired", entityType: "decision",
      entityId: updated.id, details: { expiredReason: reason } });
    await deliverContinuation(updated.id);
    return 1;
  }

  async function due(now: Date, limit: number, cursor?: { expiresAt: Date; id: string }) {
    return db.select().from(decisions).where(and(open, lte(decisions.expiresAt, now), cursor
      ? sql`(${decisions.expiresAt}, ${decisions.id}) > (${cursor.expiresAt.toISOString()}::timestamptz, ${cursor.id}::uuid)` : undefined))
      .orderBy(asc(decisions.expiresAt), asc(decisions.id)).limit(limit);
  }

  async function sweep(now = new Date()) {
    let cursor: { expiresAt: Date; id: string } | undefined;
    let expired = 0;
    const errors: unknown[] = [];
    for (;;) {
      const rows = await due(now, 100, cursor);
      for (const row of rows) {
        try { expired += await expire(row, "ttl", now); } catch (error) { errors.push(error); }
      }
      if (rows.length < 100) break;
      cursor = rows.at(-1)!;
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Decision expiry failed");
    return { expired };
  }

  async function next(): Promise<number | null> {
    const [row] = await db.select({ at: decisions.expiresAt }).from(decisions).where(open)
      .orderBy(asc(decisions.expiresAt), asc(decisions.id)).limit(1);
    return row?.at.getTime() ?? null;
  }

  return { expire, due, sweep, next };
}
