import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import type { decisionService } from "./decisions.js";

export function notifyDecisionTargetWork(transaction: object, hint?: `issue:${string}` | `decision:${string}`) {
  return notifyDeliveryWork(transaction, DELIVERY_QUEUES.decisionTargets, hint ?? "all");
}

export function registerDecisionTargetWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: Pick<ReturnType<typeof decisionService>, "sweepInvalidTargets" | "decisionTargetsChanged" | "hasDecisionTargetWork">,
  canRun: () => boolean,
) {
  return coordinator.register(DELIVERY_QUEUES.decisionTargets, {
    retryMs: 30_000,
    pausePassiveMaintenance: true,
    onSettled: service.decisionTargetsChanged,
    run: signal => canRun() ? service.sweepInvalidTargets(new Date(), signal) : Promise.resolve(),
    hasPending: async () => service.hasDecisionTargetWork(),
  });
}
