import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";

export type VoiceRecoveryScope = { kind: "session" | "endpoint" | "connection" | "company"; id: string };
export function voiceRecoveryScope(hint: string): VoiceRecoveryScope | undefined {
  if (hint === "*") return undefined;
  const [kind, id, extra] = hint.split(":");
  if (!id || extra !== undefined || !["session", "endpoint", "connection", "company"].includes(kind))
    throw new Error("Invalid voice recovery scope");
  return { kind: kind as VoiceRecoveryScope["kind"], id };
}
export function notifyVoiceRecovery(tx: object, scope?: VoiceRecoveryScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.voiceSessionRecovery, scope ? `${scope.kind}:${scope.id}` : "*");
}
export function withVoiceSessionChange<T>(db: Db, id: string, write: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => PromiseLike<T>): Promise<T> {
  return db.transaction(async tx => {
    await notifyVoiceRecovery(tx, { kind: "session", id });
    return write(tx);
  });
}
