import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  logger,
  runWithContext,
  __setTestDestination,
  __resetTestDestination,
} from "$lib/server/log";

describe("log.ts", () => {
  let writes: Record<string, unknown>[];

  beforeEach(() => {
    writes = [];
    __setTestDestination((line) => {
      writes.push(JSON.parse(line));
    });
  });

  afterEach(() => {
    __resetTestDestination();
  });

  describe("logger()", () => {
    it("returns base logger when called outside runWithContext", () => {
      logger().info({ event: "outside" }, "outside");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ event: "outside", msg: "outside" });
      expect(writes[0]).not.toHaveProperty("requestId");
    });

    it("returns child logger with requestId when inside runWithContext", () => {
      runWithContext(
        { requestId: "req-123", route: "/api/sync", method: "POST" },
        () => {
          logger().info({ event: "inside" }, "inside");
        },
      );
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        event: "inside",
        msg: "inside",
        requestId: "req-123",
        route: "/api/sync",
        method: "POST",
      });
    });

    it("propagates context through async boundaries", async () => {
      await runWithContext({ requestId: "req-async" }, async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        logger().info({ event: "after_await" }, "after_await");
      });
      expect(writes[0]).toMatchObject({
        requestId: "req-async",
        event: "after_await",
      });
    });

    it("nested runWithContext shadows outer context", () => {
      runWithContext({ requestId: "outer" }, () => {
        runWithContext({ requestId: "inner" }, () => {
          logger().info({ event: "nested" }, "nested");
        });
        logger().info({ event: "after_nested" }, "after_nested");
      });
      expect(writes[0]).toMatchObject({ requestId: "inner" });
      expect(writes[1]).toMatchObject({ requestId: "outer" });
    });
  });

  describe("redaction", () => {
    it("redacts *.token", () => {
      logger().info({ event: "auth", token: "sk_device_secret" }, "auth");
      expect(writes[0].token).toBe("[REDACTED]");
    });

    it("redacts *.email", () => {
      logger().info({ event: "signup", email: "user@example.com" }, "signup");
      expect(writes[0].email).toBe("[REDACTED]");
    });

    it("redacts userEmail at top level and nested (StatusResult leak guard)", () => {
      logger().info(
        { event: "pair_status", userEmail: "user@example.com" },
        "pair_status",
      );
      logger().info(
        { event: "pair_status", result: { userEmail: "nested@example.com" } },
        "pair_status",
      );
      expect(writes[0].userEmail).toBe("[REDACTED]");
      expect((writes[1].result as Record<string, unknown>).userEmail).toBe(
        "[REDACTED]",
      );
    });

    it("redacts *.api_token_hash", () => {
      logger().info({ event: "auth", api_token_hash: "deadbeef" }, "auth");
      expect(writes[0].api_token_hash).toBe("[REDACTED]");
    });

    it("redacts *.password", () => {
      logger().info({ event: "login", password: "hunter2" }, "login");
      expect(writes[0].password).toBe("[REDACTED]");
    });

    it("redacts *.privateKey", () => {
      logger().info({ event: "realtime_token", privateKey: "PEM..." }, "mint");
      expect(writes[0].privateKey).toBe("[REDACTED]");
    });

    it("redacts *.jwk", () => {
      logger().info(
        { event: "realtime_token", jwk: { kty: "EC", d: "secret" } },
        "mint",
      );
      expect(writes[0].jwk).toBe("[REDACTED]");
    });
  });

  describe("level filtering", () => {
    it("debug is suppressed at default level", () => {
      logger().debug({ event: "debug_line" }, "debug_line");
      expect(writes).toHaveLength(0);
    });

    it("info, warn, error all emit at default level", () => {
      logger().info({ event: "i" }, "i");
      logger().warn({ event: "w" }, "w");
      logger().error({ event: "e" }, "e");
      expect(writes).toHaveLength(3);
      expect(writes.map((w) => w.level)).toEqual(["info", "warn", "error"]);
    });
  });
});
