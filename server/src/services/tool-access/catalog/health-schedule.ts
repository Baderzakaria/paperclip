import { and, eq, ne, sql } from "drizzle-orm";
import { toolApplications, toolConnections, type Db } from "@paperclipai/db";
import { isConnectorFeatureEnabled } from "@paperclipai/shared";
import { instanceSettingsService } from "../../instance-settings.js";
import { connectionSetupApp } from "../connections/setup-policy.js";
import type { ConnectionHealth } from "./health.js";

export type ConnectionHealthDeadline = { id: string; companyId: string; dueAt: number };
const HEALTH_FRESHNESS_MS = 15 * 60_000;

export function connectionHealthSchedule(db: Db, checkHealth: ConnectionHealth["checkConnectionHealth"]) {
  async function load(companyId?: string, connectionId?: string): Promise<ConnectionHealthDeadline[]> {
    const rows = await db.select({
      id: toolConnections.id,
      companyId: toolConnections.companyId,
      checkedAt: toolConnections.healthCheckedAt,
      applicationKey: toolApplications.applicationKey,
      sourceTemplateKey: sql<string | null>`coalesce(${toolConnections.config}->>'sourceTemplateKey', ${toolConnections.transportConfig}->>'sourceTemplateKey')`,
    }).from(toolConnections).innerJoin(toolApplications, and(
      eq(toolApplications.id, toolConnections.applicationId),
      eq(toolApplications.companyId, toolConnections.companyId),
    )).where(and(
      eq(toolConnections.enabled, true), eq(toolConnections.status, "active"),
      ne(toolConnections.transport, "chat_sdk"), ne(toolConnections.transport, "runtime_auth"),
      ne(toolApplications.type, "paperclip_plugin"),
      companyId === undefined ? undefined : eq(toolConnections.companyId, companyId),
      connectionId === undefined ? undefined : eq(toolConnections.id, connectionId),
    ));
    const definitions = rows.map(row => ({ row, app: connectionSetupApp(row.applicationKey, row.sourceTemplateKey) }));
    const settings = definitions.some(({ app }) => app?.experimentalFeatureKey)
      ? await instanceSettingsService(db).getExperimental() : null;
    return definitions.filter(({ app }) => !app || !settings || isConnectorFeatureEnabled(app, settings))
      .map(({ row }) => ({ id: row.id, companyId: row.companyId,
        dueAt: row.checkedAt === null ? 0 : row.checkedAt.getTime() + HEALTH_FRESHNESS_MS }));
  }

  async function check(id: string): Promise<ConnectionHealthDeadline | null> {
    const [before] = await load(undefined, id);
    if (!before || before.dueAt > Date.now()) return before ?? null;
    let failure: unknown;
    try { await checkHealth(id, { actorType: "system", actorId: "tool_health_sweep" }); }
    catch (error) { failure = error; }
    const [after] = await load(before.companyId, id);
    if (failure && after && after.dueAt <= Date.now()) throw failure;
    return after ?? null;
  }
  return { load, check };
}
