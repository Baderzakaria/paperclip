import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, chatPublications, createDb, heartbeatRuns, issueComments, subscribeDatabaseWork } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createChatMilestoneFixtures } from "./helpers/chat-milestone-fixtures.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { chatRunMilestoneWork } from "../services/chat-run-milestone-work.js";
import { initializeRunIdentity, reserveSteeredIdentity, acceptSteeredIdentity } from "../services/run-identity.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_MILESTONE_IDENTITY_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("chat milestones after identity activation", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let fixtures: ReturnType<typeof createChatMilestoneFixtures>;
  let f: Awaited<ReturnType<typeof fixtures.create>>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  const errors: unknown[] = [];
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("chat-identity-milestones-");
    db = createDb(external ?? temporary!.connectionString, { idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    fixtures = createChatMilestoneFixtures(db);
  }, 60_000);
  beforeEach(async () => {
    errors.length = 0; f = await fixtures.create();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; vi.useRealTimers(); vi.restoreAllMocks();
    await fixtures.cleanup(); expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function flush() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
  }
  async function quiet() {
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    try { await vi.advanceTimersByTimeAsync(120_000); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); }
    finally { reads.mockRestore(); writes.mockRestore(); }
  }
  const publications = () => db.select().from(chatPublications).where(eq(chatPublications.issueId, f.issueId));

  it.each(["initialization", "steering"] as const)("wakes matching monitor lineage after %s commits, preserving rollback and replay", async kind => {
    const nextCheckAt = new Date(Date.now() - 1000).toISOString();
    const sourceId = randomUUID(), successorId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "succeeded", responsibleUserId: f.userId,
      contextSnapshot: { issueId: f.issueId, source: "chat:slack", endpointId: f.endpointId, wakeCommentId: f.commentId },
      resultJson: { semanticToolReceipts: { schedule: { operationId: "set_task_monitor",
        result: { taskId: f.issueId, monitor: { status: "scheduled", nextCheckAt } } } } },
    });
    await db.insert(heartbeatRuns).values({ id: successorId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "running", responsibleUserId: null,
      contextSnapshot: { issueId: f.issueId, source: "issue.monitor" },
    });
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, runId: successorId,
      source: "automation", reason: "issue_monitor_due", status: "claimed",
      idempotencyKey: `issue-monitor:${f.issueId}:${nextCheckAt}`, payload: { issueId: f.issueId, nextCheckAt },
    });
    const identityInput = { companyId: f.companyId, runId: successorId, issueId: f.issueId, responsibleUserId: f.userId, cause: "dispatch" };
    if (kind === "steering") {
      await initializeRunIdentity(db, { ...identityInput, responsibleUserId: null });
      await db.update(issueComments).set({ authorUserId: f.userId }).where(eq(issueComments.id, f.commentId));
    }
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error) });
    await chatRunMilestoneWork(db).register(coordinator, () => true).ready;
    await flush(); expect(await publications()).toEqual([]); await quiet();
    const pending = kind === "steering" ? await reserveSteeredIdentity(db, {
      companyId: f.companyId, runId: successorId, issueId: f.issueId, messageId: f.commentId,
    }) : null;
    // Reserving an unacknowledged message must not activate its identity.
    if (kind === "steering") expect(pending?.status).toBe("pending");
    await flush(); expect(await publications()).toEqual([]); await quiet();
    const activate = (rollback: boolean) => db.transaction(async tx => {
      if (kind === "steering") await acceptSteeredIdentity(tx, pending!);
      else await initializeRunIdentity(tx as unknown as typeof db, identityInput);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await publications()).toEqual([]);
      if (rollback) throw new Error("outer rollback");
    });
    await expect(activate(true)).rejects.toThrow("outer rollback");
    await flush(); expect(await publications()).toEqual([]); await quiet();
    await activate(false); await flush();
    expect(await publications()).toEqual([expect.objectContaining({ idempotencyKey: `run:${successorId}:working:${f.endpointId}` })]);
    await quiet();
    const notices: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatRunMilestones, event => notices.push(event));
    try {
      await db.transaction(async tx => {
        if (kind === "steering") await acceptSteeredIdentity(tx, pending!);
        else await initializeRunIdentity(tx as unknown as typeof db, identityInput);
      });
      expect(notices).toEqual([]);
    } finally { unsubscribe(); }
    await flush(); await quiet();
  });
});
