import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import type { InboundWakeNoticeScope } from "./chat-channels/inbound/wakeup-notices.js";

export function notifyChatInboundWakeNotices(tx: object, scope: InboundWakeNoticeScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.chatInboundWakeNotices,
    JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }));
}
