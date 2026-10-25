import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, chatConversations, chatEndpoints, chatVoiceSessions, companies, createDb, issues, toolApplications, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { voiceSessionRecovery } from "../services/voice/voice-session-recovery.js";
import { registerVoiceRecoveryWork } from "../services/voice/voice-recovery-work.js";
import { notifyVoiceRecovery, withVoiceSessionChange } from "../services/voice/voice-recovery-notifications.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_VOICE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("voice session recovery lifecycle", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>, companyId: string, endpointId: string, agentId: string, issueId: string, conversationId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let enabled = true;
  const errors: unknown[] = [];
  const fixtureCompanies: string[] = [];
  const authorize = vi.fn(async (_session: typeof chatVoiceSessions.$inferSelect) => {}), inspect = vi.fn(async (_session: typeof chatVoiceSessions.$inferSelect): Promise<{ endedAt?: unknown }> => ({ endedAt: true }));
  const close = vi.fn(async (session: typeof chatVoiceSessions.$inferSelect) => {
    await withVoiceSessionChange(db, session.id, tx => tx.update(chatVoiceSessions).set({ state: "ended", endedAt: new Date(), updatedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id)));
  });
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("voice-recovery-");
    db = createDb(external ?? temporary!.connectionString, { idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
  }, 60_000);
  async function fixture() {
    const companyId = randomUUID(), endpointId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), conversationId = randomUUID();
    fixtureCompanies.push(companyId);
    const applicationId = randomUUID(), connectionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Voice recovery", issuePrefix: `V${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Voice", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Voice", assigneeAgentId: agentId, status: "in_progress" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Voice", type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Voice", uid: connectionId, transport: "voice", connectionPurpose: "channel", enabled: true, status: "active" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, assignedAgentId: agentId, publicId: endpointId, provider: "speko", status: "active", setup: { step: "complete", runtimeGeneration: 1 } });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId, externalConversationId: conversationId, externalThreadId: conversationId, externalLabel: "Voice", isDirectMessage: true });
    return { companyId, endpointId, assignedAgentId: agentId, issueId, conversationId };
  }
  beforeEach(async () => {
    enabled = true; errors.length = 0; authorize.mockClear(); inspect.mockReset().mockResolvedValue({ endedAt: true }); close.mockClear();
    ({ companyId, endpointId, assignedAgentId: agentId, issueId, conversationId } = await fixture());
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; vi.useRealTimers(); vi.restoreAllMocks();
    for (const companyId of fixtureCompanies.splice(0)) {
    await db.delete(chatVoiceSessions).where(eq(chatVoiceSessions.companyId, companyId));
    await db.delete(chatConversations).where(eq(chatConversations.companyId, companyId));
    await db.delete(chatEndpoints).where(eq(chatEndpoints.companyId, companyId));
    await db.delete(issues).where(eq(issues.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
    }
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function session(patch: Partial<typeof chatVoiceSessions.$inferInsert> = {}, writer = db) {
    const id = randomUUID();
    return withVoiceSessionChange(writer, id, tx => tx.insert(chatVoiceSessions).values({ id, companyId, endpointId, conversationId, issueId, assignedAgentId: agentId,
      callerId: randomUUID(), callerAuthority: "member", mode: "browser", state: "active", generation: 1, credentialFingerprint: "test", providerSessionId: randomUUID(),
      toolTokenHash: "a".repeat(64), idempotencyKey: id, requestFingerprint: id, createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 600_000), ...patch }).returning()).then(rows => rows[0]);
  }
  async function start(service = voiceSessionRecovery(db, { authorize, inspect, close })) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => enabled, canReconcile: () => true, onError: error => errors.push(error) });
    await registerVoiceRecoveryWork(coordinator, service, () => enabled).ready;
    return service;
  }
  async function settled() {
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull(); }, { timeout: 5000 });
  }
  async function quiet(ms = 120_000) {
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    try { await vi.advanceTimersByTimeAsync(ms); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); }
    finally { reads.mockRestore(); writes.mockRestore(); }
  }
  it("leaves configured terminal history quiet", async () => {
    await session({ state: "ended", endedAt: new Date() }); await start(); await settled(); await quiet(); expect(inspect).not.toHaveBeenCalled();
  });
  it("waits for outer commit and ignores a rolled-back nested producer", async () => {
    await start(); await settled();
    await expect(db.transaction(async tx => { await session({}, tx as unknown as typeof db); await vi.advanceTimersByTimeAsync(60_000); expect(inspect).not.toHaveBeenCalled(); throw new Error("rollback"); })).rejects.toThrow("rollback");
    await settled(); await quiet();
    await db.transaction(async tx => { await session({}, tx as unknown as typeof db); await vi.advanceTimersByTimeAsync(60_000); expect(inspect).not.toHaveBeenCalled(); });
    await settled(); expect(inspect).toHaveBeenCalledOnce(); await quiet();
  });
  it("preserves the first session during drain without passive database reads", async () => {
    await start(); await settled(); enabled = false;
    await db.transaction(async tx => {
      await session({}, tx as unknown as typeof db);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(idleWorkSnapshot().active).toBeGreaterThan(0);
      expect(inspect).not.toHaveBeenCalled();
    });
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); });
    const drained = idleWorkSnapshot();
    await quiet(60_000); expect(idleWorkSnapshot()).toEqual(drained); expect(inspect).not.toHaveBeenCalled();
    enabled = true; await settled(); expect(inspect).toHaveBeenCalledOnce(); await quiet();
  });
  it("retries unavailable authority without ending a valid provider call", async () => {
    const row = await session(); authorize.mockRejectedValueOnce(new Error("authority database unavailable"));
    await start(); expect(errors).toHaveLength(1); expect(close).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
    // Persisting cleanup_pending emits a committed hint; let that refresh settle first.
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); });
    expect(coordinator!.nextWakeAt()).toBeGreaterThan(Date.now() + 20_000);
    await quiet(10_000); await settled();
    expect(inspect).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
    expect((await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, row.id)))[0].state).toBe("ended");
    errors.length = 0; await quiet();
  });
  it("reconstructs a saved session deadline after restart", async () => {
    const due = Date.now() + 60_000;
    await session({ updatedAt: new Date(due - 30_000) }); await start();
    expect(coordinator!.nextWakeAt()).toBe(due); await coordinator!.stop();
    await start(); expect(coordinator!.nextWakeAt()).toBe(due); await quiet(10_000);
    await vi.advanceTimersByTimeAsync(due - Date.now()); await settled(); expect(inspect).toHaveBeenCalledOnce(); await quiet();
  });
  it("preserves a session committed during a full refresh", async () => {
    const service = voiceSessionRecovery(db, { authorize, inspect, close }), original = service.load;
    await start(service); await settled(); let inserted = false;
    service.load = async (...args) => { const rows = await original(...args); if (!inserted) { inserted = true; await session(); } return rows; };
    await db.transaction(tx => notifyVoiceRecovery(tx)); await settled(); expect(inspect).toHaveBeenCalledOnce(); await quiet();
  });
  it("pages saved sessions and drains healthy work while one provider fails", async () => {
    const failed = await session();
    for (let index = 0; index < 104; index++) await session();
    let broken = true;
    inspect.mockImplementation(async row => {
      if (row.id === failed.id && broken) throw new Error("one provider unavailable");
      return { endedAt: true };
    });
    await start();
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      const rows = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.companyId, companyId));
      expect(rows.filter(row => row.state === "ended")).toHaveLength(104);
    }, { timeout: 5000 });
    expect(inspect.mock.calls.filter(([row]) => row.id === failed.id)).toHaveLength(1);
    expect(errors).toHaveLength(1);
    broken = false; await settled(); errors.length = 0; await quiet();
  });
  it("includes another company in the first batch despite a large older backlog", async () => {
    for (let index = 0; index < 30; index++) await session({ updatedAt: new Date(Date.now() - 120_000) });
    const other = await fixture();
    const row = await session(other);
    await start();
    expect(inspect.mock.calls.slice(0, 25).some(([candidate]) => candidate.id === row.id)).toBe(true);
    await settled(); expect(inspect).toHaveBeenCalledTimes(31); await quiet();
  });
  it("does not inspect stale cached work until a failed scope refresh succeeds", async () => {
    const row = await session({ updatedAt: new Date(Date.now() - 20_000) });
    const service = voiceSessionRecovery(db, { authorize, inspect, close }), original = service.load;
    await start(service); service.load = async () => { throw new Error("scope unavailable"); };
    await db.transaction(tx => notifyVoiceRecovery(tx, { kind: "session", id: row.id }));
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(errors).toHaveLength(1); });
    await quiet(15_000); expect(inspect).not.toHaveBeenCalled();
    service.load = original; await settled(); expect(inspect).toHaveBeenCalledOnce(); errors.length = 0; await quiet();
  });
  it("does not expire a provider identity bound after the grace-period read", async () => {
    const row = await session({ state: "creation_unknown", providerSessionId: null,
      createdAt: new Date(Date.now() - 240_000), expiresAt: new Date(Date.now() - 180_000) });
    const service = voiceSessionRecovery(db, { authorize, inspect, close });
    const providerSessionId = randomUUID(), transact = db.transaction.bind(db);
    const transaction = vi.spyOn(db, "transaction").mockImplementationOnce(async (callback, options) => {
      await transact(async tx => {
        await notifyVoiceRecovery(tx, { kind: "session", id: row.id });
        await tx.update(chatVoiceSessions).set({ providerSessionId, state: "connecting", updatedAt: new Date() }).where(eq(chatVoiceSessions.id, row.id));
      });
      return transact(callback, options);
    });
    try { await service.check(row.id); } finally { transaction.mockRestore(); }
    const [bound] = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, row.id));
    expect(bound).toMatchObject({ state: "connecting", providerSessionId });
    await service.check(row.id);
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ id: row.id, providerSessionId }));
    expect((await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, row.id)))[0].state).toBe("ended");
  });
  it("joins admitted provider inspection at shutdown", async () => {
    await start(); await settled();
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    inspect.mockImplementationOnce(async () => { await gate; return { endedAt: true }; });
    await session(); await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(inspect).toHaveBeenCalledOnce(); });
    let stopped = false; const stopping = coordinator!.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(5000); expect(stopped).toBe(false);
    finish(); await stopping; expect(stopped).toBe(true);
  });
});
