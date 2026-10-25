import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, chatConversations, chatEndpoints, chatVoiceInboundCalls, chatVoiceSessions, companies, createDb, issues, toolApplications, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { voiceInboundRetention } from "../services/voice/voice-inbound-retention.js";
import { notifyVoiceInbound } from "../services/voice/voice-inbound-notifications.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_VOICE_RETENTION_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("inbound voice retention lifecycle", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>, companyId: string, endpointId: string, agentId: string, issueId: string, conversationId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let enabled = true;
  const errors: unknown[] = [], fixtureCompanies: string[] = [];
  const week = 7 * 86_400_000;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("voice-inbound-retention-");
    db = createDb(external ?? temporary!.connectionString, { idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 60_000);
  async function fixture() {
    const companyId = randomUUID(), endpointId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), conversationId = randomUUID();
    fixtureCompanies.push(companyId);
    const applicationId = randomUUID(), connectionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Inbound cleanup", issuePrefix: `V${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Voice", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Voice", assigneeAgentId: agentId, status: "in_progress" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Voice", type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Voice", uid: connectionId, transport: "voice", connectionPurpose: "channel", enabled: true, status: "active" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, assignedAgentId: agentId, publicId: endpointId, provider: "speko", status: "active", setup: { step: "complete", runtimeGeneration: 1 } });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId, externalConversationId: conversationId, externalThreadId: conversationId, externalLabel: "Voice", isDirectMessage: true });
    return { companyId, endpointId, agentId, issueId, conversationId };
  }
  beforeEach(async () => {
    enabled = true; errors.length = 0;
    ({ companyId, endpointId, agentId, issueId, conversationId } = await fixture());
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; vi.useRealTimers(); vi.restoreAllMocks();
    for (const companyId of fixtureCompanies.splice(0)) {
      await db.delete(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.companyId, companyId));
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
  async function admission(patch: Partial<typeof chatVoiceInboundCalls.$inferInsert> = {}, writer = db) {
    const id = randomUUID();
    return writer.transaction(async tx => {
      await notifyVoiceInbound(tx, { kind: "admission", id });
      return (await tx.insert(chatVoiceInboundCalls).values({ id, companyId, endpointId, providerSessionId: randomUUID(), state: "ended", cleanupConfirmedAt: new Date(), updatedAt: new Date(Date.now() - week - 1000), approvalCode: "123456", generation: 1, credentialFingerprint: "test", toolTokenHash: "a".repeat(64), requestFingerprint: id, expiresAt: new Date(Date.now() - week - 1000), ...patch }).returning())[0];
    });
  }
  async function owner(call: typeof chatVoiceInboundCalls.$inferSelect, patch: Partial<typeof chatVoiceSessions.$inferInsert> = {}) {
    return (await db.insert(chatVoiceSessions).values({ companyId, endpointId, conversationId, issueId, assignedAgentId: agentId, callerId: call.approvedByUserId ?? `guest:${call.id}`, callerAuthority: call.callerAuthority === "member" ? "member" : "guest_intake", approvedByUserId: call.approvedByUserId,
      mode: "inbound_phone", state: "active", generation: call.generation, credentialFingerprint: call.credentialFingerprint, providerSessionId: call.providerSessionId, toolTokenHash: call.toolTokenHash, idempotencyKey: `inbound:${call.id}`, requestFingerprint: call.requestFingerprint, expiresAt: new Date(Date.now() + 600_000), ...patch }).returning())[0];
  }
  async function start(service = voiceInboundRetention(db)) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => enabled, canReconcile: () => true, onError: error => errors.push(error) });
    await service.register(coordinator, () => enabled).ready;
    return service;
  }
  async function flush() {
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); }, { timeout: 5000 });
  }
  async function quiet(ms = 120_000) {
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    try { await vi.advanceTimersByTimeAsync(ms); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); }
    finally { reads.mockRestore(); writes.mockRestore(); }
  }
  async function row(id: string) { return (await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, id)))[0]; }
  it("leaves configured idle quiet and reacts to the first committed history", async () => {
    await start(); await flush(); expect(coordinator!.nextWakeAt()).toBeNull(); await quiet();
    const call = await admission(); await flush(); expect(await row(call.id)).toBeUndefined();
    expect(coordinator!.nextWakeAt()).toBeNull(); await quiet();
  });
  it("uses the later timestamp, stays quiet before its deadline, and reconstructs it on restart", async () => {
    const now = Date.now(), later = now + 400_000;
    const call = await admission({ expiresAt: new Date(now - week + 200_000), updatedAt: new Date(later - week) });
    await start(); await flush(); expect(coordinator!.nextWakeAt()).toBe(later); await quiet();
    await coordinator!.stop(); await start(); await flush(); expect(coordinator!.nextWakeAt()).toBe(later);
    expect(await row(call.id)).toBeDefined();
    await vi.advanceTimersByTimeAsync(later - Date.now() + 1000); await flush();
    expect(await row(call.id)).toBeUndefined(); expect(coordinator!.nextWakeAt()).toBeNull(); await quiet();
  });
  it("rounds PostgreSQL submillisecond deadlines up and never deletes early", async () => {
    const call = await admission(); const dueAt = Math.trunc(Date.now()) + 60_000;
    await db.execute(sql`UPDATE chat_voice_inbound_calls SET updated_at = to_timestamp(${dueAt - week}::double precision / 1000) + interval '0.0005 seconds' WHERE id = ${call.id}`);
    const service = voiceInboundRetention(db), [entry] = await service.load({ kind: "admission", id: call.id });
    expect(entry.dueAt).toBe(dueAt + 1);
    vi.setSystemTime(dueAt); await service.check(call.id); expect(await row(call.id)).toBeDefined();
    vi.setSystemTime(dueAt + 1); await service.check(call.id); expect(await row(call.id)).toBeUndefined();
  });
  it("never prunes unconfirmed, live, task-bound or session-bound history", async () => {
    const unconfirmed = await admission({ cleanupConfirmedAt: null });
    const live = await admission({ state: "awaiting_approval" });
    const task = await admission({ intakeIssueId: issueId });
    const bound = await admission(), session = await owner(bound);
    await db.update(chatVoiceInboundCalls).set({ sessionId: session.id }).where(eq(chatVoiceInboundCalls.id, bound.id));
    const service = await start(); await flush(); await service.prune();
    for (const call of [unconfirmed, live, task, bound]) expect(await row(call.id)).toBeDefined();
    expect(coordinator!.nextWakeAt()).toBeNull(); await quiet();
  });
  it("rechecks current dates and bindings after stale discovery", async () => {
    const service = voiceInboundRetention(db), changed = await admission(), bound = await admission();
    expect(await service.load()).toHaveLength(2);
    await db.update(chatVoiceInboundCalls).set({ updatedAt: new Date() }).where(eq(chatVoiceInboundCalls.id, changed.id));
    await db.update(chatVoiceInboundCalls).set({ intakeIssueId: issueId }).where(eq(chatVoiceInboundCalls.id, bound.id));
    expect((await service.check(changed.id))!.dueAt).toBeGreaterThan(Date.now());
    expect(await service.check(bound.id)).toBeNull();
    expect(await row(changed.id)).toBeDefined(); expect(await row(bound.id)).toBeDefined();
  });
  it("waits for a concurrent binding transaction and rechecks after its commit", async () => {
    const call = await admission(), service = voiceInboundRetention(db);
    let release!: () => void, acquired!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const binding = db.transaction(async tx => {
      await tx.update(chatVoiceInboundCalls).set({ intakeIssueId: issueId }).where(eq(chatVoiceInboundCalls.id, call.id));
      acquired(); await gate;
    });
    await ready;
    let finished = false;
    const deleting = service.check(call.id).then(result => { finished = true; return result; });
    try {
      await vi.advanceTimersByTimeAsync(100); expect(finished).toBe(false);
    } finally { release(); await binding; }
    expect(await deleting).toBeNull(); expect((await row(call.id)).intakeIssueId).toBe(issueId);
  });
  it("defers nested writes until outer commit and discards rollback", async () => {
    await start(); await flush(); let committed!: string;
    await db.transaction(async tx => {
      committed = (await admission({}, tx as typeof db)).id;
      await vi.advanceTimersByTimeAsync(5000);
      expect(await row(committed)).toBeUndefined();
      expect(await tx.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, committed))).toHaveLength(1);
    });
    await flush(); expect(await row(committed)).toBeUndefined(); await quiet();
    await expect(db.transaction(async tx => { await admission({}, tx as typeof db); throw new Error("rollback"); })).rejects.toThrow("rollback");
    await flush(); expect(coordinator!.nextWakeAt()).toBeNull(); await quiet();
  });
  it("keeps the first write during drain and runs it on resume", async () => {
    await start(); await flush(); enabled = false;
    const call = await admission(); await quiet(60_000); expect(await row(call.id)).toBeDefined();
    enabled = true; await flush(); expect(await row(call.id)).toBeUndefined(); await quiet();
  });
  it("pages through more than one batch of history across companies", async () => {
    for (let i = 0; i < 104; i++) await admission();
    const other = await fixture(); const last = await admission({ companyId: other.companyId, endpointId: other.endpointId });
    const service = await start();
    expect(await row(last.id)).toBeUndefined();
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(await service.load()).toHaveLength(0); }, { timeout: 5000 });
    await flush(); await quiet();
  });
  it("retains failed deletion for a bounded retry and then becomes quiet", async () => {
    const call = await admission();
    const transaction = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("database unavailable"));
    await start(); transaction.mockRestore();
    expect(errors).toHaveLength(1); errors.length = 0;
    expect(await row(call.id)).toBeDefined();
    await quiet(10_000);
    await vi.advanceTimersByTimeAsync(31_000); await flush(); expect(await row(call.id)).toBeUndefined(); await quiet();
  });
  it("stops future deletion at shutdown and resumes its durable deadline after restart", async () => {
    const call = await admission({ updatedAt: new Date(Date.now() - week + 60_000) });
    await start(); await flush(); await coordinator!.stop();
    await quiet(120_000); expect(await row(call.id)).toBeDefined();
    await start(); await flush(); expect(await row(call.id)).toBeUndefined(); await quiet();
  });
});
