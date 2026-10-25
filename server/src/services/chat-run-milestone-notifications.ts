import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

/** Lineage changes can authorize descendants, so invalidate the issue rather
 * than just the run whose row changed. Configuration may invalidate a company. */
export type ChatRunMilestoneScope = { companyId: string; issueId?: string };

export function notifyChatRunMilestones(tx: object, scope: ChatRunMilestoneScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.chatRunMilestones, JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }));
}
