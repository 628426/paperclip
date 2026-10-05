import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, chatEndpoints, companies, createDb, toolApplications, toolConnections,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createChatReconciliationCoordinator } from "../app.js";
import { enqueueChatRunMilestones } from "./chat-run-publications.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("idle external chat projection", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-idle-chat-projection-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await tempDb?.cleanup(); });

  it("avoids run and event selectors without endpoints while durable lanes still drain", async () => {
    const select = vi.spyOn(db, "select");
    const deliver = vi.fn(async () => undefined);
    const publish = vi.fn(async () => undefined);
    const errors = vi.fn();
    const coordinator = createChatReconciliationCoordinator({
      reconcileProviderRuntimes: async () => undefined,
      processPendingDeliveries: deliver,
      projectRunMilestones: () => enqueueChatRunMilestones(db),
      flushPublications: publish,
      processPendingSlackFileUploadReceipts: async () => undefined,
      processPendingSlackSessionSyncs: async () => undefined,
      onError: errors,
    });
    try {
      coordinator.reconcile();
      await coordinator.drain();
      expect(select).toHaveBeenCalledTimes(1);
      expect(deliver).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledOnce();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      coordinator.stop();
      select.mockRestore();
    }
  });

  it("rechecks explicit and newly automatic endpoints on each invocation", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const endpointId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Idle chat", issuePrefix: "IDL" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat agent", role: "engineer", adapterType: "process" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Chat", type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Chat", uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel" });
    await db.insert(chatEndpoints).values({
      id: endpointId, companyId, connectionId, provider: "slack", publicId: endpointId,
      assignedAgentId: agentId, publicationMode: "explicit",
    });
    const select = vi.spyOn(db, "select");
    try {
      await expect(enqueueChatRunMilestones(db)).resolves.toBe(0);
      expect(select).toHaveBeenCalledTimes(1);
      await db.update(chatEndpoints).set({ publicationMode: "automatic" }).where(eq(chatEndpoints.id, endpointId));
      select.mockClear();
      await expect(enqueueChatRunMilestones(db)).resolves.toBe(0);
      expect(select.mock.calls.length).toBeGreaterThan(1);
      await db.update(chatEndpoints).set({ publicationMode: "explicit" }).where(eq(chatEndpoints.id, endpointId));
      select.mockClear();
      await expect(enqueueChatRunMilestones(db)).resolves.toBe(0);
      expect(select).toHaveBeenCalledTimes(1);
    } finally {
      select.mockRestore();
    }
  });
});
