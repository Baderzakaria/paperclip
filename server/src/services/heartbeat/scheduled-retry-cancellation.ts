import { and, asc, eq, gt, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { readRunCancellation } from "../run-cancellation.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import type { ScheduledRetryCancellationScope } from "../scheduled-retry-cancellation-notifications.js";
import type { CancelRunOptions } from "./run-control.js";

type Deadline = { id: string; companyId: string; dueAt: number };

export function createScheduledRetryCancellationRecovery(db: Db, cancelRun: (
  runId: string, reason: string, options: Pick<CancelRunOptions, "expectedStatus" | "errorCode" | "resultJson">,
) => Promise<unknown>) {
  function candidates(scope?: ScheduledRetryCancellationScope, cursor?: string, full = false) {
    return db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
      result: full ? sql<Record<string, unknown>>`${heartbeatRuns.resultJson}`
        : sql<Record<string, unknown>>`jsonb_build_object('cancellation', ${heartbeatRuns.resultJson}->'cancellation')`,
      errorCode: sql<unknown>`${heartbeatRuns.resultJson}->'startupCancellation'->'errorCode'`,
    }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.status, "scheduled_retry"),
      sql`jsonb_typeof(${heartbeatRuns.resultJson}->'startupCancellation') = 'object'`,
      scope ? eq(heartbeatRuns.companyId, scope.companyId) : undefined,
      scope?.runId ? eq(heartbeatRuns.id, scope.runId) : undefined,
      cursor ? gt(heartbeatRuns.id, cursor) : undefined,
    )).orderBy(asc(heartbeatRuns.id)).limit(100);
  }
  async function load(scope: ScheduledRetryCancellationScope | undefined, admitted: () => boolean) {
    const entries: Deadline[] = [];
    let cursor: string | undefined;
    while (admitted()) {
      const rows = await candidates(scope, cursor);
      for (const row of rows) if (readRunCancellation(row.result)?.expected)
        entries.push({ id: row.id, companyId: row.companyId, dueAt: 0 });
      if (rows.length < 100) return entries;
      cursor = rows[rows.length - 1].id;
    }
    throw new Error("Scheduled retry cancellation reconstruction stopped");
  }
  async function check(entry: Deadline, admitted: () => boolean) {
    const [run] = await candidates({ companyId: entry.companyId, runId: entry.id }, undefined, true);
    const cancellation = readRunCancellation(run?.result);
    if (!run || !cancellation?.expected) return null;
    if (!admitted()) throw new Error("Scheduled retry cancellation stopped");
    await cancelRun(run.id, cancellation.reason, { expectedStatus: "scheduled_retry",
      errorCode: typeof run.errorCode === "string" && run.errorCode.trim() ? run.errorCode.trim() : "cancelled",
      resultJson: run.result });
    const [remaining] = await candidates({ companyId: entry.companyId, runId: entry.id });
    if (remaining && readRunCancellation(remaining.result)?.expected)
      throw new Error("Scheduled retry cancellation remains pending");
    return null;
  }
  async function sweep() {
    const entries = await load(undefined, () => true);
    for (const entry of entries.slice(0, 20)) {
      try { await check(entry, () => true); }
      catch (error) { logger.warn({ err: error, runId: entry.id }, "failed to finish interrupted retry cancellation"); }
    }
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean,
    canRecover: () => Promise<boolean>) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.scheduledRetryCancellation,
      batchSize: 20,
      decodeScope: (hint: string): ScheduledRetryCancellationScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: Deadline, scope?: ScheduledRetryCancellationScope) => !scope ||
        entry.companyId === scope.companyId && (!scope.runId || entry.id === scope.runId),
      load: async (scope, signal) => await canRecover()
        ? load(scope, () => canRun() && !signal?.aborted) : [],
      check: async (entry, signal) => await canRecover()
        ? check(entry, () => canRun() && !signal?.aborted) : null,
    }, canRun);
  }
  return { sweep, register };
}
