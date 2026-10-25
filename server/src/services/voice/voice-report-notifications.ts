import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import type { VoiceRecoveryScope } from "./voice-recovery-notifications.js";

export function notifyVoiceReports(tx: object, scope?: VoiceRecoveryScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.voiceReports, scope ? `${scope.kind}:${scope.id}` : "*");
}
