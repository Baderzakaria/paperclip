import { and, asc, eq, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { companies, decisionRetention, invites, joinRequests, type Db } from "@paperclipai/db";
import { decisionRetentionService, DEFAULT_DECISION_ARCHIVE_DAYS } from "./decision-retention.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerDeadlineWork } from "./deadline-work.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

const archiveDelay = DEFAULT_DECISION_ARCHIVE_DAYS * 86_400_000;

export function joinRequestRetentionService(db: Db) {
  let cursor: { at: string; id: string } | undefined;
  function candidates(database: Db, condition?: SQL) {
    return database.select({ id: joinRequests.id, companyId: joinRequests.companyId,
      at: joinRequests.updatedAt, cursorAt: sql<string>`${joinRequests.updatedAt}::text` }).from(joinRequests)
      .innerJoin(companies, eq(companies.id, joinRequests.companyId))
      .innerJoin(invites, and(eq(invites.id, joinRequests.inviteId), eq(invites.companyId, joinRequests.companyId)))
      .leftJoin(decisionRetention, and(eq(decisionRetention.companyId, joinRequests.companyId),
        eq(decisionRetention.sourceKind, "join_request"), sql`${decisionRetention.sourceId} = ${joinRequests.id}::text`))
      .where(and(sql`${joinRequests.status} = 'pending_approval'`, eq(companies.status, "active"),
        or(isNull(decisionRetention.id), eq(decisionRetention.keep, false)), isNull(decisionRetention.archivedAt), condition))
      .orderBy(asc(joinRequests.updatedAt), asc(joinRequests.id));
  }
  async function sweep(now = new Date(), signal?: AbortSignal) {
    const cutoff = new Date(now.getTime() - archiveDelay);
    const rows = await candidates(db, and(lte(joinRequests.updatedAt, cutoff), cursor
      ? sql`(${joinRequests.updatedAt}, ${joinRequests.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : undefined)).limit(100);
    let archived = 0;
    const errors: unknown[] = [];
    for (const candidate of rows) {
      if (signal?.aborted) break;
      try {
        archived += await db.transaction(async tx => {
          const database = tx as unknown as Db;
          const [current] = await candidates(database, and(eq(joinRequests.id, candidate.id), lte(joinRequests.updatedAt, cutoff)))
            .for("update", { of: joinRequests });
          if (!current) return 0;
          const retention = decisionRetentionService(database);
          const source = { sourceKind: "join_request" as const, subject: { id: current.id }, activityAt: current.at.toISOString() };
          const states = await retention.syncItems(current.companyId, [source]);
          const state = states.get(`join_request:${current.id}`)!;
          return retention.autoArchive({ companyId: current.companyId, now, items: [{ ...source,
            keep: state.keep, archivedAt: state.archivedAt?.toISOString() ?? null, retentionVersion: state.version,
          }] });
        });
      } catch (error) { errors.push(error); }
      cursor = { at: candidate.cursorAt, id: candidate.id };
    }
    if (rows.length < 100) cursor = undefined;
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Join request retention failed");
    return { archived };
  }
  async function next() {
    const [row] = await candidates(db).limit(1);
    return row ? row.at.getTime() + archiveDelay : null;
  }
  return { sweep, next };
}

export function registerJoinRequestRetentionWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof joinRequestRetentionService>,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.joinRequestRetention, {
    run: signal => service.sweep(new Date(), signal), next: service.next, canRun, retryMs: 30_000,
  });
}
