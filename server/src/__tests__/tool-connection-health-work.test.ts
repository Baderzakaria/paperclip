import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { deleteCompany } from "../services/company-deletion.js";
import { notifyChatConnectionHealth } from "../services/chat-channels/connection-health-notifications.js";
import { toolAccessService } from "../services/tool-access.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, createDb, toolApplications, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { connectionHealthSchedule } from "../services/tool-access/catalog/health-schedule.js";
import { registerToolConnectionHealthWork } from "../services/tool-connection-health-work.js";
import { writeToolConnectionHealthChange } from "../services/tool-connection-health-notifications.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_TOOL_HEALTH_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("scheduled tool connection health", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>, companyId: string, applicationId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let draining = false;
  const errors: unknown[] = [];
  const probe = vi.fn();
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("tool-health-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 30_000);
  beforeEach(async () => {
    companyId = randomUUID(); draining = false; errors.length = 0;
    await db.insert(companies).values({ id: companyId, name: "Tool health", issuePrefix: `H${companyId.slice(0, 6)}` });
    const [app] = await db.insert(toolApplications).values({ companyId, name: "Health fixture", type: "mcp_http" }).returning();
    applicationId = app.id;
    probe.mockReset(); probe.mockImplementation(async (id: string) => {
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, id));
      await writeToolConnectionHealthChange(db, connection.companyId, async tx => {
        await tx.update(toolConnections).set({ healthCheckedAt: new Date(), healthStatus: "ok" }).where(eq(toolConnections.id, id));
      });
      return {};
    });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(companies).where(eq(companies.id, companyId));
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  function connection(patch: Partial<typeof toolConnections.$inferInsert> = {}, signal = true) {
    const insert = async (writer: typeof db) => (await writer.insert(toolConnections).values({
      companyId, applicationId, name: "Check", uid: randomUUID(), transport: "mcp_remote", status: "active", enabled: true, ...patch,
    }).returning())[0];
    return signal ? writeToolConnectionHealthChange(db, companyId, insert) : insert(db);
  }
  async function start(service = connectionHealthSchedule(db, probe)) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true, onError: error => errors.push(error) });
    await registerToolConnectionHealthWork(coordinator, service, () => !draining).ready;
    return service;
  }
  async function idleAt(expected: number | null) {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()).toBe(expected);
    }, { timeout: 5000 });
  }
  async function quiet() {
    await idleAt(null);
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction"), executes = vi.spyOn(db, "execute");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore(); executes.mockRestore();
  }
  async function checked(count = 1) {
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(probe).toHaveBeenCalledTimes(count); }, { timeout: 5000 });
  }
  it("stays SQL-quiet after empty startup", async () => { await start(); await quiet(); });
  it("waits without SQL until a configured check is due", async () => {
    const checkedAt = new Date(); await connection({ healthCheckedAt: checkedAt });
    await start(); const due = checkedAt.getTime() + 900_000; await idleAt(due);
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore();
    await vi.advanceTimersByTimeAsync(due - Date.now()); await checked();
  });
  it("keeps disabled, archived, and excluded transports quiet", async () => {
    await connection({ enabled: false }); await connection({ status: "archived" });
    await connection({ transport: "chat_sdk", connectionPurpose: "channel" });
    await connection({ transport: "runtime_auth", connectionPurpose: "ai" });
    await start(); await quiet(); expect(probe).not.toHaveBeenCalled();
  });
  it("reactivates on the first committed connection and disarms after deletion", async () => {
    await start(); await quiet(); const row = await connection(); await checked();
    await writeToolConnectionHealthChange(db, companyId, async tx => { await tx.delete(toolConnections).where(eq(toolConnections.id, row.id)); });
    await quiet();
  });
  it("defers nested creation until the outer transaction commits and ignores rollback", async () => {
    await start(); await quiet();
    await expect(db.transaction(async tx => {
      await writeToolConnectionHealthChange(tx as unknown as typeof db, companyId, async writer => {
        await writer.insert(toolConnections).values({ companyId, applicationId, name: "Rollback", uid: randomUUID(), transport: "mcp_remote", status: "active", enabled: true });
      });
      await vi.advanceTimersByTimeAsync(60_000); expect(probe).not.toHaveBeenCalled();
      throw new Error("abort");
    })).rejects.toThrow("abort");
    await quiet();
    await db.transaction(async tx => {
      await writeToolConnectionHealthChange(tx as unknown as typeof db, companyId, async writer => {
        await writer.insert(toolConnections).values({ companyId, applicationId, name: "Commit", uid: randomUUID(), transport: "mcp_remote", status: "active", enabled: true });
      });
      await vi.advanceTimersByTimeAsync(60_000); expect(probe).not.toHaveBeenCalled();
    });
    await checked();
  });
  it("retains first writes through drain without querying", async () => {
    await start(); await quiet(); draining = true; await connection();
    const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).not.toHaveBeenCalled(); reads.mockRestore(); expect(probe).not.toHaveBeenCalled();
    draining = false; await checked();
  });
  it("moves the deadline when an actual-use health observation commits", async () => {
    const row = await connection({ healthCheckedAt: new Date() }); await start();
    const checkedAt = new Date(Date.now() + 60_000);
    await writeToolConnectionHealthChange(db, companyId, async tx => { await tx.update(toolConnections).set({ healthCheckedAt: checkedAt }).where(eq(toolConnections.id, row.id)); });
    await idleAt(checkedAt.getTime() + 900_000); expect(probe).not.toHaveBeenCalled();
  });
  it("reconstructs saved future checks after restart", async () => {
    const checkedAt = new Date(); await connection({ healthCheckedAt: checkedAt }); await start();
    await coordinator!.stop(); await start(); await idleAt(checkedAt.getTime() + 900_000);
    await vi.advanceTimersByTimeAsync(checkedAt.getTime() + 900_000 - Date.now()); await checked();
  });
  it("drains more than one due page without repeatedly checking completed rows", async () => {
    for (let i = 0; i < 30; i++) await connection();
    await start(); await checked(30);
    expect(new Set(probe.mock.calls.map(([id]) => id)).size).toBe(30);
  });
  it("checks the first connection created by the real API service after setup commits", async () => {
    const requests = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    });
    const tools = toolAccessService(db, {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }], remoteHttpRequest: requests,
    });
    await start(tools.scheduledHealth); await quiet();
    const row = await tools.createConnection(companyId, { applicationId, name: "Real producer", transport: "mcp_remote", status: "active", enabled: true,
      config: { url: "https://health.example.test/mcp" } });
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      const [stored] = await db.select().from(toolConnections).where(eq(toolConnections.id, row.id));
      expect(stored.healthStatus).toBe("ok"); expect(stored.healthCheckedAt).not.toBeNull();
    }, { timeout: 5000 });
    expect(requests).toHaveBeenCalledOnce();
    await tools.updateConnection(row.id, { enabled: false }); await quiet();
    await tools.updateConnection(row.id, { enabled: true });
    const [stored] = await db.select().from(toolConnections).where(eq(toolConnections.id, row.id));
    await idleAt(stored.healthCheckedAt!.getTime() + 900_000);
    expect(requests).toHaveBeenCalledOnce();
    await tools.archiveConnection(row.id, companyId); await quiet();
  });

  it("continues another company's checks when one scope cannot refresh", async () => {
    const service = connectionHealthSchedule(db, probe), load = service.load;
    await start(service); await quiet();
    service.load = async scope => { if (scope === companyId) throw new Error("scope unavailable"); return load(scope); };
    const otherId = randomUUID();
    await db.insert(companies).values({ id: otherId, name: "Other", issuePrefix: `O${otherId.slice(0, 6)}` });
    const [app] = await db.insert(toolApplications).values({ companyId: otherId, name: "Other health", type: "mcp_http" }).returning();
    try {
      await connection();
      const [other] = await writeToolConnectionHealthChange(db, otherId, tx => tx.insert(toolConnections).values({
        companyId: otherId, applicationId: app.id, name: "Other", uid: randomUUID(), transport: "mcp_remote", status: "active", enabled: true,
      }).returning());
      await checked(); expect(probe.mock.calls[0][0]).toBe(other.id);
    } finally { service.load = load; await db.delete(companies).where(eq(companies.id, otherId)); errors.length = 0; }
  });
  it("cancels and restores experimental connector checks through the settings producer", async () => {
    const settings = instanceSettingsService(db);
    const original = (await settings.getExperimental()).enablePaperclipNotebook;
    try {
      await settings.updateExperimental({ enablePaperclipNotebook: false });
      await connection({ config: { sourceTemplateKey: "paperclip-notebook" } });
      await start(); await quiet(); expect(probe).not.toHaveBeenCalled();
      await settings.updateExperimental({ enablePaperclipNotebook: true });
      await checked();
      await settings.updateExperimental({ enablePaperclipNotebook: false });
      await quiet();
    } finally {
      await coordinator?.stop(); coordinator = undefined;
      await settings.updateExperimental({ enablePaperclipNotebook: original });
    }
  });
  it("cancels a company's cached deadline when the real deletion service commits", async () => {
    const checkedAt = new Date(); await connection({ healthCheckedAt: checkedAt });
    await start(); await idleAt(checkedAt.getTime() + 900_000);
    await deleteCompany(db, companyId); await quiet(); expect(probe).not.toHaveBeenCalled();
  });
  it("keeps SDK-only chat mutations quiet and wakes the existing voice obligation", async () => {
    const voice = await connection({ transport: "voice", connectionPurpose: "channel", status: "draft", enabled: false });
    await start(); await quiet();
    await db.transaction(async tx => { await notifyChatConnectionHealth(tx, { companyId, provider: "slack" }); });
    await quiet();
    await db.transaction(async tx => {
      await notifyChatConnectionHealth(tx, { companyId, provider: "speko" });
      await tx.update(toolConnections).set({ status: "active", enabled: true }).where(eq(toolConnections.id, voice.id));
    });
    await checked(); expect(probe.mock.calls[0][0]).toBe(voice.id);
  });
  it("retains a producer wake arriving while its company is being refreshed", async () => {
    const service = connectionHealthSchedule(db, probe), load = service.load;
    await start(service); await quiet();
    let inserted = false;
    service.load = async scope => {
      const rows = await load(scope);
      if (scope === companyId && !inserted) { inserted = true; await connection(); }
      return rows;
    };
    await connection(); await checked(2);
    expect(new Set(probe.mock.calls.map(([id]) => id)).size).toBe(2);
  });
  it("backs off an unpersisted check without blocking another connection and recovers", async () => {
    const failed = await connection(), healthy = await connection();
    const persist = probe.getMockImplementation()!;
    let broken = true;
    probe.mockImplementation(async id => { if (id === failed.id && broken) throw new Error("health write unavailable"); return persist(id); });
    await start();
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(probe.mock.calls.some(([id]) => id === healthy.id)).toBe(true);
      expect(errors.length).toBeGreaterThan(0);
    });
    const before = probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000); expect(probe).toHaveBeenCalledTimes(before);
    broken = false;
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      const [stored] = await db.select().from(toolConnections).where(eq(toolConnections.id, failed.id));
      expect(stored.healthCheckedAt).not.toBeNull();
    }, { timeout: 5000 });
    errors.length = 0;
  });
  it("awaits an admitted health check during shutdown and stops future work", async () => {
    await start(); await quiet();
    const persist = probe.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    probe.mockImplementation(async id => { await gate; return persist(id); });
    await connection(); await checked();
    let stopped = false;
    const stopping = coordinator!.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1000); expect(stopped).toBe(false);
    release(); await stopping; coordinator = undefined;
    await vi.advanceTimersByTimeAsync(1_800_000); expect(probe).toHaveBeenCalledOnce();
  });

  it("warns for a persisted failed probe without retrying before its saved deadline", async () => {
    const warnings = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const requests = vi.fn(async () => new Response("private-provider-response", { status: 503 }));
    const tools = toolAccessService(db, {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }], remoteHttpRequest: requests,
    });
    const row = await connection({ config: { url: "https://health.example.test/mcp" } });
    await start(tools.scheduledHealth);
    const [stored] = await db.select().from(toolConnections).where(eq(toolConnections.id, row.id));
    expect(stored.healthCheckedAt).not.toBeNull();
    expect(warnings).toHaveBeenCalledWith(
      { companyId, connectionId: row.id }, "Scheduled tool connection health check failed",
    );
    expect(JSON.stringify(warnings.mock.calls)).not.toContain("private-provider-response");
    const due = stored.healthCheckedAt!.getTime() + 900_000;
    await idleAt(due);
    const before = requests.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(requests).toHaveBeenCalledTimes(before);
    expect(errors).toEqual([]);
  });

});
