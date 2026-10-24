import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export const notifyApprovalQueueWork = (transaction: object) => notifyDeliveryWork(transaction, DELIVERY_QUEUES.approvalQueueSeeding);

export async function notifyApprovalWork(transaction: object) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.approvalRetention);
  await notifyApprovalQueueWork(transaction);
}

export function writeApprovalChange<T>(db: Db, write: (transaction: Db) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await notifyApprovalWork(tx);
    return write(tx as unknown as Db);
  });
}
