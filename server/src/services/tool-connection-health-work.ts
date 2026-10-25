import { takeCompanyWorkBatch } from "./company-work-batch.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { ConnectionHealthDeadline } from "./tool-access/catalog/health-schedule.js";

export function registerToolConnectionHealthWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: {
    load(companyId?: string): Promise<ConnectionHealthDeadline[]>;
    check(id: string): Promise<ConnectionHealthDeadline | null>;
  },
  canRun: () => boolean,
) {
  const dirty = new Set<string>(["*"]);
  const deadlines = new Map<string, ConnectionHealthDeadline>();
  const failures = new Map<string, { count: number; retryAt: number }>();
  const retryMs = 30_000;
  let earliest = 0;
  let lastCompany: string | null = null;
  function request(hints?: ReadonlySet<string>) {
    for (const hint of hints ?? ["*"]) dirty.add(hint);
  }
  function next() {
    let result: number | null = dirty.size ? earliest : null;
    for (const entry of deadlines.values()) {
      const at = Math.max(earliest, entry.dueAt, failures.get(entry.id)?.retryAt ?? 0);
      result = result === null ? at : Math.min(result, at);
    }
    return result;
  }
  return coordinator.register(DELIVERY_QUEUES.toolConnectionHealth, {
    retryMs,
    pausePassiveMaintenance: true,
    onSettled: request,
    run: async signal => {
      if (!canRun() || Date.now() < earliest) return;
      earliest = Date.now() + retryMs;
      const scopes = dirty.has("*") ? ["*"] : [...dirty];
      dirty.clear();
      const errors: unknown[] = [];
      const unavailable = new Set<string>();
      for (let index = 0; index < scopes.length; index++) {
        const scope = scopes[index];
        if (signal.aborted || !canRun()) { for (const remaining of scopes.slice(index)) dirty.add(remaining); return; }
        try {
          const rows = await service.load(scope === "*" ? undefined : scope);
          for (const entry of deadlines.values()) if (scope === "*" || entry.companyId === scope) deadlines.delete(entry.id);
          for (const entry of rows) deadlines.set(entry.id, entry);
          for (const id of failures.keys()) {
            const current = deadlines.get(id);
            if (!current || current.dueAt > Date.now()) failures.delete(id);
          }
        } catch (error) { dirty.add(scope); unavailable.add(scope); errors.push(error); }
      }
      const due = [...deadlines.values()].filter(entry => !unavailable.has("*") && !unavailable.has(entry.companyId)
        && Math.max(entry.dueAt, failures.get(entry.id)?.retryAt ?? 0) <= Date.now())
        .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
      const batch = takeCompanyWorkBatch(due, 25, lastCompany);
      lastCompany = batch.lastCompany;
      for (const entry of batch.entries) {
        if (signal.aborted || !canRun()) break;
        try {
          const current = await service.check(entry.id);
          if (current) deadlines.set(entry.id, current); else deadlines.delete(entry.id);
          failures.delete(entry.id);
        } catch (error) {
          const count = Math.min((failures.get(entry.id)?.count ?? 0) + 1, 6);
          failures.set(entry.id, { count, retryAt: Date.now() + Math.min(15 * 60_000, retryMs * 2 ** (count - 1)) });
          errors.push(error);
        }
      }
      if (due.length > batch.entries.length) earliest = Date.now() + 1_000;
      if (errors.length) throw new AggregateError(errors, "Tool connection health checks could not settle");
    },
    hasPending: async () => dirty.size > 0,
    nextRunAt: next,
  });
}
