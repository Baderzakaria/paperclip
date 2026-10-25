import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { VoiceReplyEntry, voiceReplySchedule } from "./voice-reply-schedule.js";
import { voiceReplyScope, type VoiceReplyScope } from "./voice-reply-notifications.js";

function matches(entry: VoiceReplyEntry, scope?: VoiceReplyScope) {
  return !scope || (scope.kind === "session" ? entry.sessionId : scope.kind === "endpoint" ? entry.endpointId : scope.kind === "connection" ? entry.connectionId : entry.companyId) === scope.id;
}
export function registerVoiceReplyWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof voiceReplySchedule>,
  canRun: () => boolean,
) {
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.voiceReplies,
    decodeScope: voiceReplyScope,
    matches,
    load: (scope, signal) => service.load(scope, signal),
    check: (entry, signal) => service.check(entry, signal),
  }, canRun);
}
