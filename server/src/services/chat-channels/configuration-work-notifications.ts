import { notifyChatReceiver, notifyChatConnectionReceiver, notifyChatCompanyReceivers } from "./runtime/receiver-work-notifications.js";
import type { ChatProvider, ToolConnectionTransport } from "@paperclipai/shared";
import { notifyDiscordCommandRegistration } from "./discord/command-work-notifications.js";

export async function notifyChatEndpointConfiguration(transaction: object, endpoint: { id: string; provider: ChatProvider }) {
  await notifyChatReceiver(transaction, endpoint);
  if (endpoint.provider === "discord") {
    await notifyDiscordCommandRegistration(transaction, { kind: "endpoint", id: endpoint.id });
  }
}

export async function notifyChatConnectionConfiguration(transaction: object, connectionId: string, transport: ToolConnectionTransport = "chat_sdk") {
  await notifyChatConnectionReceiver(transaction, connectionId, transport);
  if (transport === "chat_sdk") {
    await notifyDiscordCommandRegistration(transaction, { kind: "connection", id: connectionId });
  }
}

export async function notifyChatCompanyConfiguration(transaction: object, companyId: string) {
  await notifyChatCompanyReceivers(transaction, companyId);
  await notifyDiscordCommandRegistration(transaction, { kind: "company", id: companyId });
}
