import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("indexed issue redaction lookup", () => {
  let db!: ReturnType<typeof createDb>;
  let otherDb!: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const keyDirectory = path.join(os.tmpdir(), `paperclip-redaction-issue-${randomUUID()}`);
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const dialect = new PgDialect();

  beforeAll(async () => {
    mkdirSync(keyDirectory, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(keyDirectory, "master.key");
    database = await startEmbeddedPostgresTestDatabase("redaction-issue");
    db = createDb(database.connectionString);
    otherDb = createDb(database.connectionString);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await database?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(keyDirectory, { recursive: true, force: true });
  });

  async function company() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Redaction cache", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reader", role: "engineer", adapterType: "codex_local" });
    return { companyId, agentId };
  }

  async function run(fixture: Awaited<ReturnType<typeof company>>, contextSnapshot: Record<string, unknown>) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, ...fixture, contextSnapshot });
    return id;
  }

  it("preserves modern, legacy and conflicting IDs, malformed contexts and company boundaries", async () => {
    const fixture = await company();
    const foreign = await company();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const registry = createRunSecretRedactionRegistry(db);
    const primary = await run(fixture, { issueId, paperclipIssue: { id: issueId }, prompt: "x".repeat(200_000) });
    const legacy = await run(fixture, { paperclipIssue: { id: issueId } });
    const conflicting = await run(fixture, { issueId: otherIssueId, paperclipIssue: { id: issueId } });
    const foreignRun = await run(foreign, { issueId });
    for (const [id, value] of [[primary, "primary-secret"], [legacy, "legacy-secret"], [conflicting, "conflicting-secret"], [foreignRun, "foreign-secret"]]) {
      await registry.register(id === foreignRun ? foreign.companyId : fixture.companyId, id, value);
    }
    for (const context of [null, 42, "scalar", [{ issueId }], { paperclipIssue: "scalar" }]) {
      const id = await run(fixture, {});
      await db.execute(sql`UPDATE ${heartbeatRuns} SET context_snapshot = ${JSON.stringify(context)}::jsonb WHERE id = ${id}`);
    }
    const select = vi.spyOn(db, "select");
    const resolve = vi.spyOn(getSecretProvider("local_encrypted"), "resolveVersion");
    const text = "primary-secret legacy-secret conflicting-secret foreign-secret";
    const expected = `${REDACTED_EVENT_VALUE} ${REDACTED_EVENT_VALUE} ${REDACTED_EVENT_VALUE} foreign-secret`;
    expect(await registry.redactForIssue(fixture.companyId, issueId, text)).toBe(expected);
    expect(await createRunSecretRedactionRegistry(db).redactForIssue(fixture.companyId, issueId, text)).toBe(expected);
    expect(await registry.redactForIssue(fixture.companyId, otherIssueId, text))
      .toBe(`primary-secret legacy-secret ${REDACTED_EVENT_VALUE} foreign-secret`);
    expect(select).toHaveBeenCalledTimes(3);
    expect(resolve).toHaveBeenCalledTimes(7);
    const columns = select.mock.calls[0][0] as { contextSnapshot: SQL };
    expect(dialect.sqlToQuery(columns.contextSnapshot).sql).toContain("-> 'paperclipSecretRedactions'");
    expect(JSON.stringify(resolve.mock.calls)).not.toContain("primary-secret");
    expect(await createRunSecretRedactionRegistry(otherDb).redactForIssue(fixture.companyId, issueId, text)).toBe(expected);
  });

  it("sees external registrations without an updatedAt change, new runs, moved IDs and deletions", async () => {
    const fixture = await company();
    const issueId = randomUUID();
    const movedIssueId = randomUUID();
    const id = await run(fixture, { issueId });
    const registry = createRunSecretRedactionRegistry(db);
    await registry.register(fixture.companyId, id, "first-secret");
    expect(await registry.redactForIssue(fixture.companyId, issueId, "first-secret late-secret"))
      .toBe(`${REDACTED_EVENT_VALUE} late-secret`);
    const [before] = await otherDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    await createRunSecretRedactionRegistry(otherDb).register(fixture.companyId, id, "late-secret");
    await otherDb.update(heartbeatRuns).set({ updatedAt: before.updatedAt }).where(eq(heartbeatRuns.id, id));
    expect(await registry.redactForIssue(fixture.companyId, issueId, "first-secret late-secret"))
      .toBe(`${REDACTED_EVENT_VALUE} ${REDACTED_EVENT_VALUE}`);
    await otherDb.execute(sql`UPDATE ${heartbeatRuns} SET context_snapshot = jsonb_set(context_snapshot, '{issueId}', ${JSON.stringify(movedIssueId)}::jsonb) WHERE id = ${id}`);
    expect(await registry.redactForIssue(fixture.companyId, issueId, "first-secret")).toBe("first-secret");
    expect(await registry.redactForIssue(fixture.companyId, movedIssueId, "first-secret")).toBe(REDACTED_EVENT_VALUE);
    const newId = await run(fixture, { issueId });
    await createRunSecretRedactionRegistry(otherDb).register(fixture.companyId, newId, "new-run-secret");
    expect(await registry.redactForIssue(fixture.companyId, issueId, "new-run-secret")).toBe(REDACTED_EVENT_VALUE);
    await otherDb.delete(heartbeatRuns).where(eq(heartbeatRuns.id, newId));
    expect(await registry.redactForIssue(fixture.companyId, issueId, "new-run-secret")).toBe("new-run-secret");
  });

  it("decrypts per request and fails closed on database and decryption errors", async () => {
    const fixture = await company();
    const issueId = randomUUID();
    const id = await run(fixture, { issueId });
    const registry = createRunSecretRedactionRegistry(db);
    await registry.register(fixture.companyId, id, "registered-secret");
    const resolve = vi.spyOn(getSecretProvider("local_encrypted"), "resolveVersion");
    expect(await registry.redactForIssue(fixture.companyId, issueId, "registered-secret")).toBe(REDACTED_EVENT_VALUE);
    resolve.mockRejectedValueOnce(new Error("key unavailable"));
    await expect(registry.redactForIssue(fixture.companyId, issueId, "registered-secret")).rejects.toThrow("key unavailable");
    expect(resolve).toHaveBeenCalledTimes(2);
    vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("database unavailable"); });
    await expect(registry.redactForIssue(fixture.companyId, issueId, "registered-secret")).rejects.toThrow("database unavailable");
    expect(await registry.redactForIssue(fixture.companyId, issueId, "registered-secret")).toBe(REDACTED_EVENT_VALUE);
  });
});
