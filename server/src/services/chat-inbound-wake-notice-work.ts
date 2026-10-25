import type { ChatChannelService } from "./chat-channels.js";
import type { InboundWakeNoticeScope } from "./chat-channels/inbound/wakeup-notices.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";

type Entry = { id: string; companyId: string; issueId: string; dueAt: number };
const batchSize = 100;

/** Admission receipts own queued/not-started/removed notices. The channel
 * service retains authorization and publication policy; this owner schedules
 * only unfinished batches, contention, and failed reconciliation. */
export function chatInboundWakeNoticeWork(service: Pick<ChatChannelService,
  "loadInboundWakeNoticeScopes" | "reconcileInboundWakeNotices">) {
  async function load(scope?: InboundWakeNoticeScope, signal?: AbortSignal): Promise<Entry[]> {
    return (await service.loadInboundWakeNoticeScopes(scope, signal)).map(row => ({
      ...row, id: `${row.companyId}:${row.issueId}`, dueAt: 0,
    }));
  }
  async function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    const result = await service.reconcileInboundWakeNotices({ scope: entry, limit: batchSize, signal });
    if (result.inserted === batchSize) return { ...entry, dueAt: Date.now() };
    return result.contended ? { ...entry, dueAt: Date.now() + 1000 } : null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.chatInboundWakeNotices,
      decodeScope: (hint: string): InboundWakeNoticeScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: Entry, scope?: InboundWakeNoticeScope) => !scope ||
        (entry.companyId === scope.companyId && (!scope.issueId || entry.issueId === scope.issueId)),
      load, check,
    }, canRun);
  }
  return { load, check, register };
}
