import type { ChatProvider } from "@paperclipai/shared";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";

export type VoiceReplyScope = { kind: "session" | "endpoint" | "connection" | "company"; id: string };
export function voiceReplyScope(hint: string): VoiceReplyScope | undefined {
  if (hint === "*") return undefined;
  const [kind, id, extra] = hint.split(":");
  if (!id || extra !== undefined || !["session", "endpoint", "connection", "company"].includes(kind))
    throw new Error("Invalid voice reply scope");
  return { kind: kind as VoiceReplyScope["kind"], id };
}
export function notifyVoiceReplies(tx: object, scope?: VoiceReplyScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.voiceReplies, scope ? `${scope.kind}:${scope.id}` : "*");
}
export async function notifyVoicePublication(tx: object, endpoint: { id: string; provider: ChatProvider }) {
  if (endpoint.provider === "speko") await notifyVoiceReplies(tx, { kind: "endpoint", id: endpoint.id });
}
