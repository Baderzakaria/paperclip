// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { IssueComment } from "@paperclipai/shared";
import { useIssueHistoryWindow } from "./useIssueHistoryWindow";
import { queryKeys } from "@/lib/queryKeys";
const api = vi.hoisted(() => ({ recentComments: vi.fn(), listComments: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: api }));

it.each([true, false])("retains a burst larger than the preview window (initially empty: %s)", async (empty) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  const root = createRoot(container);
  const comment = (n: number) => ({ id: `comment-${n}`, createdAt: new Date(n * 1000), body: `Message ${n}` } as IssueComment);
  let current: ReturnType<typeof useIssueHistoryWindow>;
  function Probe() { current = useIssueHistoryWindow("one", false); return <span>{current.recent.data?.comments.length}</span>; }
  api.recentComments.mockResolvedValue({ comments: empty ? [] : [comment(0)], latestCommentId: empty ? null : "comment-0", hasMore: !empty });
  api.listComments.mockReset();
  const wait = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  try {
    await act(async () => { root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>); });
    for (let i = 0; i < 20 && !current!.recent.isSuccess; i++) await wait();
    expect(current!.recent.isSuccess).toBe(true);
    api.recentComments.mockResolvedValue({ comments: [comment(58),comment(59),comment(60)], latestCommentId: "comment-60", hasMore: true });
    api.listComments.mockResolvedValueOnce(Array.from({length:50},(_,i)=>comment(i+1))).mockResolvedValueOnce(Array.from({length:10},(_,i)=>comment(i+51)));
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.issues.comments("one") }); });
    for (let i = 0; i < 20 && current!.recent.data?.latestCommentId !== "comment-60"; i++) await wait();
    expect(current!.recent.error).toBeNull();
    expect(current!.recent.data?.comments).toHaveLength(empty ? 60 : 61);
    expect(current!.recent.data?.hasMore).toBe(!empty);
    expect(api.listComments).toHaveBeenCalledTimes(2);
    expect(new Set(current!.recent.data?.comments.map(c=>c.id)).size).toBe(empty ? 60 : 61);
  } finally { await act(async () => root.unmount()); client.clear(); }
});
