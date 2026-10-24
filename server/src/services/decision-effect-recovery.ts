import { and, asc, lte, sql } from "drizzle-orm";
import { decisions, type Db } from "@paperclipai/db";

const running = sql`${decisions.status} = 'decided' AND ${decisions.executionStatus} = 'running'`;

export function decisionSweepBatchSize() {
  const value = Number(process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE ?? 100);
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 100;
}

function recoveryGraceMs() {
  const value = Number(process.env.PAPERCLIP_DECISIONS_RECOVERY_GRACE_MS ?? 60_000);
  return Number.isFinite(value) && value >= 0 ? value : 60_000;
}

export function decisionEffectRecoveryService(db: Db, resume: (id: string) => Promise<boolean>) {
  let cursor: { updatedAt: Date; id: string } | undefined;

  async function sweep(now = new Date(), limit = decisionSweepBatchSize(), signal?: AbortSignal) {
    let resumed = 0;
    if (signal?.aborted) return { resumed };
    const rows = await db.select({ id: decisions.id, updatedAt: decisions.updatedAt }).from(decisions)
      .where(and(running, lte(decisions.updatedAt, new Date(now.getTime() - recoveryGraceMs())), cursor
        ? sql`(${decisions.updatedAt}, ${decisions.id}) > (${cursor.updatedAt.toISOString()}::timestamptz, ${cursor.id}::uuid)` : undefined))
      .orderBy(asc(decisions.updatedAt), asc(decisions.id)).limit(limit);
    const errors: unknown[] = [];
    for (const row of rows) {
      if (signal?.aborted) return { resumed };
      try { if (await resume(row.id)) resumed++; } catch (error) { errors.push(error); }
      cursor = row;
    }
    if (rows.length < limit) cursor = undefined;
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Decision effect recovery failed");
    return { resumed };
  }

  async function next(): Promise<number | null> {
    const [row] = await db.select({ at: decisions.updatedAt }).from(decisions).where(running)
      .orderBy(asc(decisions.updatedAt), asc(decisions.id)).limit(1);
    return row ? row.at.getTime() + recoveryGraceMs() : null;
  }

  return { sweep, next };
}
