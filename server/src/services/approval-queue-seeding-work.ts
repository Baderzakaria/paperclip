import { and, asc, eq, gt, sql, type SQL } from "drizzle-orm";
import { approvals, companies, issues, type Db } from "@paperclipai/db";
import { executionIssueCondition } from "./issue-visibility.js";
import { decisionQueueService } from "./decision-queues.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerDeadlineWork } from "./deadline-work.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

const linkedIssue = sql<string>`(select linked.issue_id from issue_approvals linked
  where linked.company_id = ${approvals.companyId} and linked.approval_id = ${approvals.id}
  order by linked.issue_id limit 1)`;

export function approvalQueueSeedingService(db: Db) {
  let cursor: string | undefined;
  function candidates(database: Db, condition?: SQL) {
    return database.select({ id: approvals.id, companyId: approvals.companyId, issueId: linkedIssue }).from(approvals)
      .innerJoin(companies, eq(companies.id, approvals.companyId))
      .where(and(eq(approvals.status, "pending"), eq(companies.status, "active"), condition,
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
    const rows = await candidates(db, cursor ? gt(approvals.id, cursor) : undefined).limit(100);
    const errors: unknown[] = [];
    for (const row of rows) {
      if (signal?.aborted) break;
      try {
        await db.transaction(async tx => {
          const database = tx as unknown as Db;
          const [current] = await candidates(database, eq(approvals.id, row.id)).for("update", { of: approvals });
          if (!current) return;
          await decisionQueueService(database).materializeSeedSources(current.companyId, [{
            sourceKind: "approval", sourceId: current.id, issueId: current.issueId,
          }]);
        });
      } catch (error) { errors.push(error); }
      cursor = row.id;
    }
    if (rows.length < 100) cursor = undefined;
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Approval queue seeding failed");
  }
  async function next() {
    return (await candidates(db).limit(1)).length ? Date.now() : null;
  }
  return { sweep, next };
}

export function registerApprovalQueueSeedingWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof approvalQueueSeedingService>,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.approvalQueueSeeding, {
    run: signal => service.sweep(signal), next: service.next, canRun, retryMs: 1_000,
  });
}
