import { and, asc, eq, gt, sql, type SQL } from "drizzle-orm";
import { approvals, companies, issues, type Db } from "@paperclipai/db";
import { executionIssueCondition } from "./issue-visibility.js";
import { decisionQueueService } from "./decision-queues.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

const linkedIssue = sql<string>`(select linked.issue_id from issue_approvals linked
  where linked.company_id = ${approvals.companyId} and linked.approval_id = ${approvals.id}
  order by linked.issue_id limit 1)`;

export function approvalQueueSeedingService(db: Db) {
  const pending = new Map<string | undefined, { cursor?: string; generation: number }>([[undefined, { generation: 0 }]]);
  function request(companyIds: ReadonlySet<string> | undefined) {
    for (const companyId of companyIds ?? []) {
      const existing = pending.get(companyId);
      if (existing) existing.generation++;
      else pending.set(companyId, { generation: 0 });
    }
  }
  function candidates(database: Db, companyId: string | undefined, condition?: SQL) {
    return database.select({ id: approvals.id, companyId: approvals.companyId, issueId: linkedIssue }).from(approvals)
      .innerJoin(companies, eq(companies.id, approvals.companyId))
      .where(and(eq(approvals.status, "pending"), eq(companies.status, "active"), companyId === undefined ? undefined : eq(approvals.companyId, companyId), condition,
        sql`exists (select 1 from ${issues} where ${issues.id} = ${linkedIssue}
          and ${issues.companyId} = ${approvals.companyId} and ${executionIssueCondition()}
          and exists (select 1 from issue_work_products product where product.company_id = ${approvals.companyId}
            and product.issue_id = ${issues.id} and product.type = 'pull_request'))`,
        sql`not exists (select 1 from decision_queues queue where queue.company_id = ${approvals.companyId} and queue.key = 'prs'
          and (not queue.seed_rules_enabled or exists (select 1 from decision_queue_items item where item.queue_id = queue.id
            and item.company_id = ${approvals.companyId} and item.source_kind = 'approval' and item.source_id = ${approvals.id}::text)))`,
      )).orderBy(asc(approvals.id));
  }
  async function sweep(signal?: AbortSignal) {
    const scope = pending.entries().next().value;
    if (!scope) return;
    const [companyId, state] = scope;
    const generation = state.generation;
    const rows = await candidates(db, companyId, state.cursor ? gt(approvals.id, state.cursor) : undefined).limit(100);
    const errors: unknown[] = [];
    for (const row of rows) {
      if (signal?.aborted) break;
      try {
        await db.transaction(async tx => {
          const database = tx as unknown as Db;
          const [current] = await candidates(database, row.companyId, eq(approvals.id, row.id)).for("update", { of: approvals });
          if (!current) return;
          await decisionQueueService(database).materializeSeedSources(current.companyId, [{
            sourceKind: "approval", sourceId: current.id, issueId: current.issueId,
          }]);
        });
      } catch (error) { errors.push(error); }
      state.cursor = row.id;
    }
    if (rows.length < 100) state.cursor = undefined;
    const remaining = await candidates(db, companyId).limit(1);
    if (!signal?.aborted && generation === state.generation && remaining.length === 0) {
      pending.delete(companyId);
    } else {
      pending.delete(companyId);
      pending.set(companyId, state);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Approval queue seeding failed");
  }
  async function next() {
    return pending.size ? Date.now() : null;
  }
  return { sweep, next, request };
}

export function registerApprovalQueueSeedingWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof approvalQueueSeedingService>,
  canRun: () => boolean,
) {
  let earliest = 0;
  let next: number | null = null;
  return coordinator.register(DELIVERY_QUEUES.approvalQueueSeeding, {
    retryMs: 1_000,
    pausePassiveMaintenance: true,
    onSettled: service.request,
    run: async signal => {
      if (!canRun()) return;
      if (Date.now() < earliest) { next = earliest; return; }
      earliest = Date.now() + 1_000;
      await service.sweep(signal);
      next = await service.next();
    },
    hasPending: async () => (await service.next()) !== null,
    nextRunAt: () => next,
  });
}
