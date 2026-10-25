import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents, toolActionDeliveries, toolActionRequests, toolInvocations, toolGatewaySessions, toolCallEvents, toolAccessAuditEvents, toolPolicies,
  companySecretBindings, companySecretProposals, companySecrets, createDb,
  chatPublications, heartbeatRuns, issueThreadInteractions, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createChatMilestoneFixtures } from "./helpers/chat-milestone-fixtures.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { chatRunMilestoneWork } from "../services/chat-run-milestone-work.js";
import { createSecretProposalsService } from "../services/secret-proposals.js";
import { commitToolActionReview } from "../services/tool-action-review.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_MILESTONE_GOVERNED_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("chat milestones after governed interaction writes", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let fixtures: ReturnType<typeof createChatMilestoneFixtures>;
  let f: Awaited<ReturnType<typeof fixtures.create>>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  const errors: unknown[] = [];
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("chat-governed-milestones-");
    db = createDb(external ?? temporary!.connectionString, { idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    fixtures = createChatMilestoneFixtures(db);
  }, 60_000);
  beforeEach(async () => {
    errors.length = 0; f = await fixtures.create();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(companySecretProposals).where(eq(companySecretProposals.companyId, f.companyId));
    await db.delete(companySecretBindings).where(eq(companySecretBindings.companyId, f.companyId));
    await db.delete(companySecrets).where(eq(companySecrets.companyId, f.companyId));
    await db.delete(toolActionDeliveries).where(eq(toolActionDeliveries.companyId, f.companyId));
    await db.delete(toolGatewaySessions).where(eq(toolGatewaySessions.companyId, f.companyId));
    await db.delete(toolCallEvents).where(eq(toolCallEvents.companyId, f.companyId));
    await db.delete(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, f.companyId));
    await db.delete(toolActionRequests).where(eq(toolActionRequests.companyId, f.companyId));
    await db.delete(toolInvocations).where(eq(toolInvocations.companyId, f.companyId));
    await db.delete(toolPolicies).where(eq(toolPolicies.companyId, f.companyId));
    await fixtures.cleanup();
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error) });
    await chatRunMilestoneWork(db).register(coordinator, () => true).ready;
    await flush();
  }
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

  async function run(status: "failed" | "running" = "failed") {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      responsibleUserId: f.userId, status, errorCode: "test_run_failed", updatedAt: new Date(),
      contextSnapshot: { issueId: f.issueId, source: "chat:slack", endpointId: f.endpointId, wakeCommentId: f.commentId },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    return runId;
  }

  it.each(["approved", "rejected", "withdrawn", "expired", "rolled back", "parent rejected"] as const)("reactivates after a binding proposal is %s", async status => {
    const runId = await run();
    // Binding review needs secret metadata, not the provider value. No secret is resolved.
    const [secret] = await db.insert(companySecrets).values({ companyId: f.companyId, name: "test/binding", key: "BINDING_TEST" }).returning();
    const parent = status === "parent rejected" ? (await db.insert(companySecretProposals).values({
      companyId: f.companyId, kind: "secret", proposedName: "test/parent", proposedKey: "PARENT_TEST",
      justification: "Pending parent secret", proposedByAgentId: f.agentId, originRunId: runId,
      originIssueId: f.issueId, expiresAt: new Date(Date.now() + 86_400_000),
    }).returning())[0] : null;
    const proposals = createSecretProposalsService(db);
    const proposal = await proposals.createBinding({ companyId: f.companyId, heartbeatRunId: runId }, {
      ...(parent ? { secretProposalId: parent.id } : { secretId: secret.id }), configPath: "env.BINDING_TEST", justification: "Use the existing company credential", bindingTargetPolicy: "self_and_reports",
    });
    expect(proposal.interactionId).toBeTruthy();
    await start(); expect(await publications()).toEqual([]); await quiet();
    if (status === "rolled back") {
      await expect(db.transaction(async tx => {
        await createSecretProposalsService(tx as unknown as typeof db).transition(f.companyId, proposal.id, "rejected");
        throw new Error("rollback proposal");
      })).rejects.toThrow("rollback proposal");
      expect((await proposals.getById(f.companyId, proposal.id))?.status).toBe("pending");
      await flush(); expect(await publications()).toEqual([]); await quiet();
      await proposals.transition(f.companyId, proposal.id, "rejected");
    } else if (parent) {
      await proposals.transition(f.companyId, parent.id, "rejected");
      expect((await proposals.getById(f.companyId, proposal.id))?.status).toBe("rejected");
    } else if (status === "approved") {
      await proposals.approve(f.companyId, proposal.id, { resolvedByUserId: f.userId });
    } else if (status === "expired") {
      expect(await proposals.sweepExpired(new Date(proposal.expiresAt.getTime() + 1))).toBe(1);
    } else if (status === "rejected" || status === "withdrawn") {
      await proposals.transition(f.companyId, proposal.id, status, { resolvedByUserId: f.userId, proposerAgentId: f.agentId });
    }
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, proposal.interactionId!)))[0].status)
      .toBe(status === "approved" ? "accepted" : status === "withdrawn" ? "cancelled" : status === "rolled back" || status === "parent rejected" ? "rejected" : status);
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${runId}:failed:${f.endpointId}`);
    await quiet();
  });
  it.each(["approved", "rejected", "expired"] as const)("reactivates after a tool review is %s", async status => {
    await db.update(agents).set({ adapterType: "process" }).where(eq(agents.id, f.agentId));
    const runId = await run("running");
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Ask first", policyType: "require_approval",
      selectors: { toolName: "mcp-remote-fixture:update_note" } });
    const remote = vi.fn(async () => { throw new Error("Review must not invoke the provider"); });
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "milestone-review-fixture", remoteHttpRequest: remote });
    const session = await gateway.createSession({ companyId: f.companyId, agentId: f.agentId, runId });
    await expect(gateway.executeTool({ sessionToken: session.token, tool: "mcp-remote-fixture:update_note", parameters: { noteId: "test" } }))
      .rejects.toMatchObject({ reasonCode: "approval_required" });
    const [request] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.companyId));
    expect(request.interactionId).toBeTruthy();
    // The prompt could not be delivered, and the run failed while awaiting review.
    // The pending review still owns its response until the board resolves it.
    await db.update(chatPublications).set({ state: "failed" }).where(eq(chatPublications.issueId, f.issueId));
    await db.update(heartbeatRuns).set({ status: "failed", updatedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await start();
    expect((await publications()).some(row => row.idempotencyKey.startsWith(`run:${runId}:`))).toBe(false);
    await quiet();
    if (status === "expired") {
      await db.update(toolActionRequests).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(toolActionRequests.id, request.id));
      await gateway.sweepExpiredActionReviews();
    } else {
      await commitToolActionReview(db, { companyId: f.companyId, actionRequestId: request.id, decision: status, actor: { userId: f.userId } });
    }
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, request.interactionId!)))[0].status)
      .toBe(status === "approved" ? "accepted" : status);
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${runId}:failed:${f.endpointId}`);
    await quiet(); expect(remote).not.toHaveBeenCalled();
  });

});
