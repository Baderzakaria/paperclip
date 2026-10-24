import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_PLUGIN_SCHEDULE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("plugin job scheduling without idle polling", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let scheduler: ReturnType<typeof createPluginJobScheduler> | undefined;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("plugin-schedule-");
    db = createDb(external ?? temporary!.connectionString, { idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    await db.execute(sql`select 1`);
  }, 30_000);
  afterEach(() => { scheduler?.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  it("does not query repeatedly after an empty startup reconciliation", async () => {
    const workerManager = { isRunning: () => false, call: vi.fn() } as unknown as PluginWorkerManager;
    scheduler = createPluginJobScheduler({ db, jobStore: pluginJobStore(db), workerManager });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    scheduler.start(); await scheduler.tick();
    const reads = vi.spyOn(db, "select");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(reads).not.toHaveBeenCalled();
  });
});
