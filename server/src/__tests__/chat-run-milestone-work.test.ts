import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, companyMemberships, chatConversations, chatEndpoints, chatMessageLinks, chatPublications, companies, createDb,
  heartbeatRunEvents, heartbeatRuns, issueComments, issueQuestionResponseDeliveries, issueThreadInteractions, issues, toolApplications, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { chatRunMilestoneWork } from "../services/chat-run-milestone-work.js";
import { notifyChatRunMilestones } from "../services/chat-run-milestone-notifications.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { questionResponseDeliveryService } from "../services/question-response-delivery.js";
import { heartbeatService } from "../services/heartbeat.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_MILESTONE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("chat lifecycle milestone worker", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let enabled = true;
  const errors: unknown[] = [];
  const fixtureCompanies: string[] = [];
  const fixtureUsers: string[] = [];
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  let f: Fixture;

  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("chat-milestones-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 60_000);
  async function fixture(companyId = randomUUID()) {
    const agentId = randomUUID(), issueId = randomUUID(), endpointId = randomUUID(), conversationId = randomUUID(), commentId = randomUUID(), userId = randomUUID();
    if (!fixtureCompanies.includes(companyId)) {
      fixtureCompanies.push(companyId);
      await db.insert(companies).values({ id: companyId, name: "Milestones", issuePrefix: `M${companyId.slice(0, 7)}` });
    }
    fixtureUsers.push(userId);
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Maya", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat task", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: userId });
    const applicationId = randomUUID(), connectionId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: `Chat ${applicationId}`, type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Chat", uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, assignedAgentId: agentId, publicId: endpointId, provider: "slack", status: "active" });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId, externalConversationId: conversationId, externalThreadId: conversationId, externalLabel: "Chat" });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user", body: "Start work" });
    await db.insert(chatMessageLinks).values({ companyId, endpointId, conversationId, commentId, providerMessageId: commentId, direction: "inbound" });
    return { companyId, agentId, issueId, endpointId, conversationId, commentId, userId };
  }
  beforeEach(async () => {
    enabled = true; errors.length = 0; f = await fixture();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; vi.useRealTimers(); vi.restoreAllMocks();
    for (const companyId of fixtureCompanies.splice(0)) {
      await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
      await db.delete(chatMessageLinks).where(eq(chatMessageLinks.companyId, companyId));
      await db.delete(chatPublications).where(eq(chatPublications.companyId, companyId));
      await db.delete(chatConversations).where(eq(chatConversations.companyId, companyId));
      await db.delete(chatEndpoints).where(eq(chatEndpoints.companyId, companyId));
      await db.delete(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.companyId, companyId));
      await db.delete(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId));
      await db.delete(issueComments).where(eq(issueComments.companyId, companyId));
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      await db.delete(issues).where(eq(issues.companyId, companyId));
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
    }
    for (const userId of fixtureUsers.splice(0)) await db.delete(authUsers).where(eq(authUsers.id, userId));
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  function runValues(scope = f, patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    return { id: randomUUID(), companyId: scope.companyId, agentId: scope.agentId, responsibleUserId: scope.userId, status: "running", updatedAt: new Date(),
      contextSnapshot: { issueId: scope.issueId, source: "chat:slack", endpointId: scope.endpointId, wakeCommentId: scope.commentId }, ...patch };
  }
  async function run(scope = f, patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const values = runValues(scope, patch);
    await db.transaction(async tx => { await notifyChatRunMilestones(tx, scope); await tx.insert(heartbeatRuns).values(values); });
    return values;
  }
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => enabled, canReconcile: () => true, onError: error => errors.push(error) });
    await chatRunMilestoneWork(db).register(coordinator, () => enabled).ready;
  }
  async function flush() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
  }
  async function quiet(ms = 120_000) {
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    try { await vi.advanceTimersByTimeAsync(ms); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); }
    finally { reads.mockRestore(); writes.mockRestore(); }
  }
  const publications = (scope = f) => db.select().from(chatPublications).where(eq(chatPublications.issueId, scope.issueId));

  it("leaves configured idle, internal runs and old history quiet", async () => {
    await run(f, { contextSnapshot: { issueId: f.issueId, source: "issue.comment" } });
    await run(f, { updatedAt: new Date(Date.now() - 2 * 86_400_000) });
    await start(); await flush(); expect(await publications()).toEqual([]); await quiet();
  });
  it("reconstructs missing notices at startup and leaves published history quiet across restart", async () => {
    const row = await run(); await start(); await flush();
    expect(await publications()).toEqual([expect.objectContaining({ idempotencyKey: `run:${row.id}:working:${f.endpointId}` })]);
    await quiet(); await coordinator!.stop(); await start(); await flush(); await quiet();
    expect(await publications()).toHaveLength(1);
  });
  it("wakes on the first committed row after becoming quiet", async () => {
    await start(); await flush(); await quiet(); await run(); await flush();
    expect(await publications()).toHaveLength(1); await quiet();
  });
  it("wakes from the real run cancellation transaction without a manual milestone signal", async () => {
    const row = await run(f, { status: "queued", runtimeMode: "legacy" });
    await start(); await flush(); await quiet();
    // This fixture exercises the Stop producer, not successor execution.
    await heartbeatService(db).cancelRun(row.id, "Operator stopped queued work", { suppressImmediateRecovery: true });
    await flush();
    expect((await publications()).map(publication => publication.idempotencyKey).sort()).toEqual([
      `run:${row.id}:failed:${f.endpointId}`, `run:${row.id}:queued:${f.endpointId}`,
    ].sort());
    await quiet();
  });
  it("projects a continuation only after the real question delivery receipt commits", async () => {
    const source = await run(f, { status: "succeeded" });
    const interactions = issueThreadInteractionService(db);
    const interaction = await interactions.create({ id: f.issueId, companyId: f.companyId }, {
      kind: "ask_user_questions", continuationPolicy: "wake_assignee", sourceRunId: source.id,
      title: "Choose", payload: { version: 1, title: "Choose", questions: [{
        id: "choice", prompt: "Continue?", selectionMode: "single", required: true,
        options: [{ id: "yes", label: "Yes" }],
      }] },
    }, { agentId: f.agentId, runId: source.id });
    await interactions.answerQuestions({ id: f.issueId, companyId: f.companyId, status: "in_progress" }, interaction.id,
      { answers: [{ questionId: "choice", optionIds: ["yes"] }] }, { userId: f.userId });
    // A provider acknowledgement is durable input to this projection test.
    await db.insert(chatPublications).values({ companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId,
      issueId: f.issueId, idempotencyKey: `interaction:${interaction.id}:${f.endpointId}`,
      payload: { text: "Continue?", interactionId: interaction.id }, state: "published", providerMessageId: "question-1",
    }).onConflictDoNothing();
    await db.update(chatPublications).set({ state: "published", providerMessageId: "question-1" }).where(eq(chatPublications.issueId, f.issueId));
    await start(); await flush(); await quiet();
    let targetId!: string;
    const delivery = questionResponseDeliveryService(db, { heartbeat: {
      cancelRun: async () => { throw new Error("The source is already terminal"); },
      wakeup: async (_agentId, options) => {
        const values = runValues(f, { status: "queued", contextSnapshot: options.contextSnapshot });
        const [target] = await db.insert(heartbeatRuns).values(values).returning();
        targetId = target.id;
        await flush();
        expect((await publications()).some(row => row.idempotencyKey.startsWith(`run:${target.id}:`))).toBe(false);
        return target;
      },
    } });
    await expect(delivery.deliver(interaction.id)).resolves.toMatchObject({ status: "fallback_queued" });
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${targetId}:queued:${f.endpointId}`);
    await quiet();
  });
  it("waits for outer commit and ignores rolled-back nested writes", async () => {
    await start(); await flush();
    await expect(db.transaction(async tx => {
      await tx.transaction(async nested => { await notifyChatRunMilestones(nested, f); await nested.insert(heartbeatRuns).values(runValues()); });
      throw new Error("rollback fixture");
    })).rejects.toThrow("rollback fixture");
    await flush(); expect(await publications()).toEqual([]); await quiet();
    let release!: () => void, staged!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stagedPromise = new Promise<void>(resolve => { staged = resolve; });
    const writing = db.transaction(async tx => {
      await tx.transaction(async nested => { await notifyChatRunMilestones(nested, f); await nested.insert(heartbeatRuns).values(runValues()); });
      staged(); await gate;
    });
    try { await stagedPromise; await vi.advanceTimersByTimeAsync(1000); expect(await publications()).toEqual([]); }
    finally { release(); await writing; }
    await flush(); expect(await publications()).toHaveLength(1); await quiet();
  });
  it("retains the first committed wake during drain without periodic SQL", async () => {
    await start(); await flush(); enabled = false;
    await run(); await vi.advanceTimersByTimeAsync(1000);
    expect(await publications()).toEqual([]); await quiet();
    enabled = true; await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(await publications()).toHaveLength(1); await quiet();
  });
  it("scopes mutation wakes to their issue and company", async () => {
    const sibling = await fixture(f.companyId), foreign = await fixture();
    await start(); await flush();
    // Unsupported raw writers deliberately do not wake: they provide a sentinel
    // proving a supported issue mutation does not perform a global scan.
    await db.insert(heartbeatRuns).values([runValues(sibling), runValues(foreign)]);
    await run(); await flush();
    expect(await publications()).toHaveLength(1); expect(await publications(sibling)).toEqual([]); expect(await publications(foreign)).toEqual([]);
    await db.transaction(tx => notifyChatRunMilestones(tx, { companyId: f.companyId }));
    await flush(); expect(await publications(sibling)).toHaveLength(1); expect(await publications(foreign)).toEqual([]);
    await quiet();
  });
  it("disarms suppressed lineage and reactivates after its binding changes", async () => {
    const row = await run(f, { contextSnapshot: { issueId: f.issueId, source: "chat:slack", endpointId: randomUUID(), wakeCommentId: f.commentId } });
    await start(); await flush(); expect(await publications()).toEqual([]); await quiet();
    await db.transaction(async tx => {
      await notifyChatRunMilestones(tx, f);
      await tx.update(heartbeatRuns).set({ contextSnapshot: runValues().contextSnapshot }).where(eq(heartbeatRuns.id, row.id));
    });
    await flush(); expect(await publications()).toHaveLength(1); await quiet();
  });
  it("waits quietly for a late presentation decision", async () => {
    const row = await run(f, { status: "succeeded" }); await start(); await flush();
    expect(await publications()).toEqual([]); await quiet();
    await db.transaction(async tx => {
      await notifyChatRunMilestones(tx, f);
      await tx.update(heartbeatRuns).set({ resultJson: { presentationDecision: { source: "none" } } }).where(eq(heartbeatRuns.id, row.id));
    });
    await flush(); expect(await publications()).toEqual([expect.objectContaining({ idempotencyKey: `run:${row.id}:completed:${f.endpointId}` })]); await quiet();
  });
  it("drains more than one batch without duplicate notices or starving another company", async () => {
    const other = await fixture();
    await db.insert(heartbeatRuns).values([...Array.from({ length: 205 }, () => runValues()), runValues(other)]);
    await start(); await flush(); expect(await publications()).toHaveLength(205); expect(await publications(other)).toHaveLength(1); await quiet();
  });
  it("retains a failed selection for retry through drain", async () => {
    await run();
    const select = vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("temporary read failure"); });
    await start(); select.mockRestore(); expect(errors.splice(0)).toHaveLength(1);
    enabled = false; await quiet(); enabled = true; await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(await publications()).toHaveLength(1); await quiet();
  });
  it("retries a failed publication write without idle scans before its deadline", async () => {
    await run();
    const transaction = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("temporary publication failure"));
    await start(); transaction.mockRestore(); expect(errors.splice(0)).toHaveLength(1);
    expect(await publications()).toEqual([]); await quiet(10_000);
    await vi.advanceTimersByTimeAsync(30_000); await flush(); expect(await publications()).toHaveLength(1); await quiet();
  });
  it("preserves a committed change arriving while a projection batch is running", async () => {
    await run();
    const transaction = db.transaction.bind(db);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const staged = new Promise<void>(resolve => { entered = resolve; });
    const held = vi.spyOn(db, "transaction").mockImplementationOnce(async (callback, config) => {
      entered(); await gate; return transaction(callback, config);
    });
    const starting = start();
    try {
      await staged;
      await transaction(async tx => { await notifyChatRunMilestones(tx, f); await tx.insert(heartbeatRuns).values(runValues()); });
    } finally { release(); await starting; held.mockRestore(); }
    await flush(); expect(await publications()).toHaveLength(2); await quiet();
  });
  it("stops future wakes and reconstructs writes made after shutdown", async () => {
    await start(); await flush(); await coordinator!.stop(); await run(); await quiet();
    expect(await publications()).toEqual([]); await start(); await flush(); expect(await publications()).toHaveLength(1);
  });
});
