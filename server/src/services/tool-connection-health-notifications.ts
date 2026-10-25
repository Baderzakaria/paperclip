import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export const notifyToolConnectionHealth = (transaction: object, companyId: string) =>
  notifyDeliveryWork(transaction, DELIVERY_QUEUES.toolConnectionHealth, companyId);

export function writeToolConnectionHealthChange<T>(db: Db, companyId: string, write: (transaction: Db) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await notifyToolConnectionHealth(tx, companyId);
    return write(tx as unknown as Db);
  });
}
