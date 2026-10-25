import { and, desc, eq, or, sql } from "drizzle-orm";
import { chatMessageLinks, heartbeatRuns, type Db } from "@paperclipai/db";
import { githubRunReplyState } from "../../chat-run-publications.js";
import { chatRunSourceMessageId } from "../run-origin.js";

const runColumns = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  responsibleUserId: heartbeatRuns.responsibleUserId,
  activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
  nativeIssueId: heartbeatRuns.nativeIssueId,
  issueId: heartbeatRuns.issueId,
  status: heartbeatRuns.status,
  updatedAt: heartbeatRuns.updatedAt,
  contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
    'issueId', ${heartbeatRuns.contextSnapshot}->'issueId',
    'taskId', ${heartbeatRuns.contextSnapshot}->'taskId',
    'wakeCommentId', ${heartbeatRuns.contextSnapshot}->'wakeCommentId',
    'wakeCommentIds', ${heartbeatRuns.contextSnapshot}->'wakeCommentIds'
  )`,
};

export type GitHubResponseExecutionInput = {
  companyId: string;
  endpointId: string;
  agentId: string;
  issueId: string;
  deliveryId: string;
  sourceMessageId: string | null;
  issueStatus: string;
  deliveryCreatedAt: Date;
};

export async function githubResponseExecution(db: Db, input: GitHubResponseExecutionInput) {
  const [requestRun] = await db.select({ runId: heartbeatRuns.id }).from(heartbeatRuns).innerJoin(chatMessageLinks, and(
    eq(chatMessageLinks.companyId, input.companyId), eq(chatMessageLinks.endpointId, input.endpointId),
    eq(chatMessageLinks.deliveryId, input.deliveryId), eq(chatMessageLinks.direction, "inbound"),
    or(sql`${chatMessageLinks.commentId}::text = ${heartbeatRuns.contextSnapshot}->>'wakeCommentId'`,
      sql`coalesce(${heartbeatRuns.contextSnapshot}->'wakeCommentIds', '[]'::jsonb) ? ${chatMessageLinks.commentId}::text`),
  )).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issueId}`))
    .orderBy(desc(heartbeatRuns.createdAt)).limit(1);
  const [latestRun] = await db.select(runColumns).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issueId}`,
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  const originMessageId = latestRun?.activeIdentityContextId ? await chatRunSourceMessageId(db, latestRun,
    { allowLegacyWakeComment: true, provider: "github" }) : null;
  const ownsLatestRequest = !!latestRun && (requestRun?.runId === latestRun.id ||
    (!!input.sourceMessageId && originMessageId === input.sourceMessageId));
  const requestRunning = ownsLatestRequest && latestRun?.status === "running";
  const terminal = latestRun && ["succeeded", "failed", "interrupted", "timed_out", "cancelled"].includes(latestRun.status);
  const run = terminal && (ownsLatestRequest || input.issueStatus === "blocked") ? latestRun : null;

  const reply = run && ownsLatestRequest ? await githubRunReplyState(db, {
    companyId: input.companyId, endpointId: input.endpointId, issueId: input.issueId, runId: run.id,
  }) : "none";
  const paused = !!run ? input.issueStatus === "blocked" && !ownsLatestRequest
    : input.issueStatus === "blocked" && latestRun?.status !== "running";
  const body = run ? reply === "confirmed" ? "This request has been handled. See the response in this conversation."
    : paused ? "Work is paused. Your request is saved. See the Paperclip task for details."
    : run.status === "succeeded" ? "This turn ended without publishing a final response. See the Paperclip task for details."
    : "This turn stopped before completing. See the Paperclip task for details."
    : paused ? "Work is paused. Your request is saved. See the Paperclip task for details." : undefined;
  return {
    body, paused, reply, running: requestRunning,
    versionAt: run ? new Date(Math.max(run.updatedAt.getTime(), input.deliveryCreatedAt.getTime()))
      : paused ? input.deliveryCreatedAt : undefined,
    version: JSON.stringify([latestRun?.id ?? null, latestRun?.status ?? null,
      latestRun?.updatedAt.toISOString() ?? null, ownsLatestRequest, input.issueStatus === "blocked", reply]),
  };
}
