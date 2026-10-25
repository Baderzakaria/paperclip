import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, chatConversations, chatEndpoints, chatVoiceSessions, chatVoiceReports, companies, createDb, issues, toolApplications, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { voiceCallReports } from "../services/voice/voice-call-reports.js";
import type { SpekoCallReport } from "../services/voice/speko-call-report.js";
import { notifyVoiceReports } from "../services/voice/voice-report-notifications.js";
import { withVoiceSessionChange } from "../services/voice/voice-recovery-notifications.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_VOICE_REPORT_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("voice call-report lifecycle", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>, companyId: string, endpointId: string, agentId: string, issueId: string, conversationId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let enabled = true;
  const errors: unknown[] = [];
  const fixtureCompanies: string[] = [];
  const day = 86_400_000;
  const result = (): SpekoCallReport => ({ complete: true, transcript: [], costMicroUsd: "100", durationSeconds: 10, providerUpdatedAt: new Date() });
  const fetchReport = vi.fn(async (_session: typeof chatVoiceSessions.$inferSelect) => result());
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("voice-call-reports-");
    db = createDb(external ?? temporary!.connectionString, { idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
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
    enabled = true; errors.length = 0; fetchReport.mockReset().mockImplementation(async () => result());
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
      callerId: randomUUID(), callerAuthority: "member", mode: "browser", state: "ended", endedAt: new Date(), generation: 1, credentialFingerprint: "test", providerSessionId: randomUUID(),
      toolTokenHash: "a".repeat(64), idempotencyKey: id, requestFingerprint: id, createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 600_000), ...patch }).returning()).then(rows => rows[0]);
  }
  async function start(service = voiceCallReports(db, fetchReport)) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => enabled, canReconcile: () => true, onError: error => errors.push(error) });
    await service.register(coordinator, () => enabled).ready;
    return service;
  }
  async function flush() {
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); }, { timeout: 5000 });
  }
  async function quiet(ms = 10_000) {
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    const requests = fetchReport.mock.calls.length;
    try { await vi.advanceTimersByTimeAsync(ms); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(fetchReport).toHaveBeenCalledTimes(requests); }
    finally { reads.mockRestore(); writes.mockRestore(); }
  }
  async function report(id: string) { return (await db.select().from(chatVoiceReports).where(eq(chatVoiceReports.sessionId, id)))[0]; }
  async function due(id: string) {
    await db.transaction(async tx => {
      await notifyVoiceReports(tx, { kind: "session", id });
      await tx.update(chatVoiceReports).set({ nextCheckAt: new Date(0) }).where(eq(chatVoiceReports.sessionId, id));
    });
  }
  it("leaves configured idle, live calls, old history and unidentified calls quiet", async () => {
    await session({ state: "active", endedAt: null });
    await session({ endedAt: new Date(Date.now() - day - 1000) });
    await session({ providerSessionId: null });
    await start(); await flush(); expect(coordinator!.nextWakeAt()).toBeNull(); await quiet(120_000);
    expect(fetchReport).not.toHaveBeenCalled();
  });
  it("wakes on committed termination and preserves refresh of available reports", async () => {
    await start(); await flush(); await quiet();
    const call = await session(); await flush();
    expect(fetchReport).toHaveBeenCalledOnce(); expect((await report(call.id)).status).toBe("available");
    const next = (await report(call.id)).nextCheckAt.getTime();
    expect(coordinator!.nextWakeAt()).toBe(next); await quiet();
    await vi.advanceTimersByTimeAsync(next - Date.now() + 1000); await flush();
    expect(fetchReport).toHaveBeenCalledTimes(2); expect((await report(call.id)).attempts).toBe(2);
  });
  it("reconstructs persisted retries after restart without early provider reads", async () => {
    const call = await session(); fetchReport.mockRejectedValueOnce(new Error("provider unavailable"));
    await start(); await flush(); const saved = await report(call.id);
    expect(saved.attempts).toBe(1); expect(saved.status).toBe("pending");
    await coordinator!.stop(); await start(); await flush();
    expect(coordinator!.nextWakeAt()).toBe(saved.nextCheckAt.getTime()); await quiet();
    await vi.advanceTimersByTimeAsync(saved.nextCheckAt.getTime() - Date.now() + 1000); await flush();
    expect(fetchReport).toHaveBeenCalledTimes(2); expect((await report(call.id)).status).toBe("available");
  });
  it("disarms at the end of the finite window even when the next check is later", async () => {
    const endedAt = new Date(Date.now() - day + 25_000), call = await session({ endedAt });
    await start(); await flush();
    expect(coordinator!.nextWakeAt()).toBe(endedAt.getTime() + day + 1);
    expect((await report(call.id)).nextCheckAt.getTime()).toBeGreaterThan(coordinator!.nextWakeAt()!);
    await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(coordinator!.nextWakeAt()).toBeNull(); await quiet(120_000); expect(fetchReport).toHaveBeenCalledOnce();
    await coordinator!.stop(); await start(); await flush(); expect(coordinator!.nextWakeAt()).toBeNull(); await quiet();
  });
  it("rounds the inclusive PostgreSQL window end up without another provider fetch", async () => {
    const call = await session(), end = Math.trunc(Date.now()) + 60_000;
    await db.execute(sql`UPDATE chat_voice_sessions SET ended_at = to_timestamp(${end - day}::double precision / 1000) + interval '0.0005 seconds' WHERE id = ${call.id}`);
    await db.insert(chatVoiceReports).values({ companyId, sessionId: call.id, status: "available", nextCheckAt: new Date(end + 60_000) });
    const service = voiceCallReports(db, fetchReport);
    expect((await service.load())[0].dueAt).toBe(end + 1);
    vi.setSystemTime(end + 1);
    expect(await service.check(call.id)).toBeNull(); expect(fetchReport).not.toHaveBeenCalled();
  });
  it("marks repeated missing reports unavailable but never downgrades retained available data", async () => {
    const available = await session(), missing = await session(), service = voiceCallReports(db, fetchReport);
    await service.check(available.id);
    await db.update(chatVoiceReports).set({ attempts: 7, nextCheckAt: new Date(0) }).where(eq(chatVoiceReports.sessionId, available.id));
    await db.insert(chatVoiceReports).values({ companyId, sessionId: missing.id, attempts: 7, nextCheckAt: new Date(0) });
    fetchReport.mockRejectedValue(new Error("provider unavailable"));
    await service.check(available.id); await service.check(missing.id);
    expect(await report(available.id)).toMatchObject({ attempts: 8, status: "available", costMicroUsd: "100" });
    expect(await report(missing.id)).toMatchObject({ attempts: 8, status: "unavailable" });
    expect((await report(missing.id)).nextCheckAt.getTime()).toBeGreaterThan(Date.now());
  });
  it("retains committed work during drain and ignores rolled-back nested writes", async () => {
    await start(); await flush(); enabled = false;
    const call = await session(); await quiet(60_000); expect(await report(call.id)).toBeUndefined();
    enabled = true; await flush(); expect(fetchReport).toHaveBeenCalledOnce();
    await expect(db.transaction(async tx => { await session({}, tx as unknown as typeof db); throw new Error("rollback"); })).rejects.toThrow("rollback");
    await flush(); expect(fetchReport).toHaveBeenCalledOnce(); await quiet();
  });
  it("does not fetch an uncommitted nested termination", async () => {
    await start(); await flush();
    await db.transaction(async tx => {
      await session({}, tx as unknown as typeof db);
      await vi.advanceTimersByTimeAsync(5000); expect(fetchReport).not.toHaveBeenCalled();
    });
    await flush(); expect(fetchReport).toHaveBeenCalledOnce();
  });
  it("keeps a callback's earlier deadline when an older provider response finishes", async () => {
    const call = await session(), service = voiceCallReports(db, fetchReport);
    let release!: (value: SpekoCallReport) => void;
    fetchReport.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const checking = service.check(call.id);
    await vi.waitFor(() => expect(fetchReport).toHaveBeenCalledOnce());
    await due(call.id);
    release({ ...result(), costMicroUsd: "1" }); await checking;
    expect((await report(call.id)).nextCheckAt.getTime()).toBe(0);
    expect((await report(call.id)).costMicroUsd).toBeNull();
    await service.check(call.id); expect((await report(call.id)).costMicroUsd).toBe("100");
  });
  it("does not regress an available report from incomplete or older responses", async () => {
    const call = await session(), service = voiceCallReports(db, fetchReport);
    const latest = new Date(Date.now() + 10000);
    fetchReport.mockResolvedValueOnce({ ...result(), providerUpdatedAt: latest, costMicroUsd: "200" });
    await service.check(call.id);
    for (const response of [{ ...result(), complete: false, providerUpdatedAt: new Date(latest.getTime() + 1), costMicroUsd: "1" },
      { ...result(), providerUpdatedAt: new Date(0), costMicroUsd: "2" }]) {
      await due(call.id); fetchReport.mockResolvedValueOnce(response); await service.check(call.id);
      expect(await report(call.id)).toMatchObject({ status: "available", costMicroUsd: "200" });
    }
  });
  it("allows only one concurrent due claim and saves its retry before provider contact", async () => {
    const call = await session(), first = voiceCallReports(db, fetchReport), second = voiceCallReports(db, fetchReport);
    let release!: (value: SpekoCallReport) => void;
    fetchReport.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const checking = first.check(call.id);
    await vi.waitFor(() => expect(fetchReport).toHaveBeenCalledOnce());
    const saved = await report(call.id); expect(saved.attempts).toBe(1); expect(saved.nextCheckAt.getTime()).toBeGreaterThan(Date.now());
    await second.check(call.id); expect(fetchReport).toHaveBeenCalledOnce();
    release(result()); await checking;
  });
  it("pages and fairly schedules a backlog with one failing provider", async () => {
    const broken = await session(); for (let i = 0; i < 103; i++) await session();
    const other = await fixture(); const last = await session(other);
    fetchReport.mockImplementation(async call => { if (call.id === broken.id) throw new Error("unavailable"); return result(); });
    await start(); expect(fetchReport.mock.calls.slice(0, 25).some(([call]) => call.id === last.id)).toBe(true);
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(fetchReport).toHaveBeenCalledTimes(105); }, { timeout: 5000 });
    expect((await report(broken.id)).attempts).toBe(1); await flush(); await quiet();
  });
  it("joins an in-flight report at shutdown and resumes its saved retry", async () => {
    const call = await session(); let release!: (value: SpekoCallReport) => void;
    fetchReport.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = voiceCallReports(db, fetchReport).register(coordinator, () => true);
    await vi.waitFor(() => expect(fetchReport).toHaveBeenCalledOnce());
    let stopped = false; const stopping = coordinator.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1000); expect(stopped).toBe(false);
    release(result()); await stopping; await worker.ready;
    expect((await report(call.id)).status).toBe("available");
    await start(); await flush(); await quiet(); expect(fetchReport).toHaveBeenCalledOnce();
  });
});
