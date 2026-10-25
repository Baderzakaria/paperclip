import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type ChatConfirmationScope = { companyId: string; issueId?: string };

export async function notifyChatConfirmationWork(tx: object, scope: ChatConfirmationScope) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatTerminalConfirmations,
    JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }));
}
