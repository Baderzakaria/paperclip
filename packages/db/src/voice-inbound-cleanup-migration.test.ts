import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const external = process.env.PAPERCLIP_MIGRATION_TEST_DATABASE_URL;
if (external && !new URL(external).pathname.endsWith("_test")) throw new Error("Migration test URL must name a test database");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const migrationFile = "0388_lying_trish_tilby.sql";
const indexName = "chat_voice_inbound_cleanup_idx";

(support.supported ? describe : describe.skip)("inbound voice cleanup migration", () => {
  it("boots through the application migrator and repairs an interrupted index on concurrent replay", async () => {
    let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
    let admin: ReturnType<typeof postgres> | undefined;
    let databaseName: string | undefined;
    let connectionString: string;
    let client: ReturnType<typeof postgres> | undefined;
    try {
      if (external) {
        admin = postgres(external, { max: 1, onnotice: () => {} });
        databaseName = `voice_migration_${randomUUID().replaceAll("-", "")}_test`;
        await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(external); url.pathname = `/${databaseName}`;
        connectionString = url.toString();
        await applyPendingMigrations(connectionString);
      } else {
        temporary = await startEmbeddedPostgresTestDatabase("voice-inbound-migration-");
        connectionString = temporary.connectionString;
      }
      client = postgres(connectionString, { max: 1, onnotice: () => {} });
      const columns = await client`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'chat_voice_inbound_calls'`;
      expect(columns.map(row => row.column_name)).toEqual(expect.arrayContaining([
        "cleanup_confirmed_at", "cleanup_next_attempt_at", "provider_account_id",
      ]));
      const content = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      await client`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      await client.unsafe(`DROP INDEX ${indexName}`);
      await client`INSERT INTO companies (name, issue_prefix) VALUES ('First', 'VM1'), ('Second', 'VM2')`;
      // A failed unique build deterministically leaves an invalid index under
      // the migration's name, as cancellation does, without timing a cancel.
      await expect(client.unsafe(`CREATE UNIQUE INDEX CONCURRENTLY ${indexName} ON companies ((true))`)).rejects.toThrow();
      const [invalid] = await client`SELECT indisvalid FROM pg_index WHERE indexrelid = ${indexName}::regclass`;
      expect(invalid.indisvalid).toBe(false);
      await Promise.all([applyPendingMigrations(connectionString), applyPendingMigrations(connectionString)]);
      const [rebuilt] = await client`SELECT indisvalid, pg_get_indexdef(indexrelid) AS definition
        FROM pg_index WHERE indexrelid = ${indexName}::regclass`;
      expect(rebuilt.indisvalid).toBe(true);
      expect(rebuilt.definition).toContain("chat_voice_inbound_calls");
      expect(rebuilt.definition).toContain("cleanup_confirmed_at IS NULL");
      const [history] = await client`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      expect(history.count).toBe(1);
      await applyPendingMigrations(connectionString);
    } finally {
      await client?.end();
      if (admin && databaseName) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await admin?.end();
      await temporary?.cleanup();
    }
  }, 120_000);
});
