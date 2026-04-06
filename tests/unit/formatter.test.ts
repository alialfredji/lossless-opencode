import { describe, expect, it } from "bun:test";
import { formatContextAsMessages, formatSummaryAsMessage } from "../../src/context/formatter";
import { mockContextItem, mockSummary } from "../helpers";

describe("XML format", () => {
  it("wraps summaries in XML with depth and token metadata", () => {
    const summary = mockSummary({ depth: 1, tokenCount: 1200, messageIds: ["5", "25"] });

    const message = formatSummaryAsMessage(summary);

    expect(message.role).toBe("assistant");
    expect(message.content).toContain('<context_summary depth="1"');
    expect(message.content).toContain('tokens="1200"');
    expect(message.content).toContain('covers_messages="5-25"');
  });
});

describe("ordering", () => {
  it("returns preamble, summaries, then fresh messages", () => {
    const items = [
      mockContextItem({ type: "summary", content: "summary-1", referenceId: "summary-1" }),
      mockContextItem({ type: "summary", content: "summary-2", referenceId: "summary-2" }),
      mockContextItem({ type: "message", content: "message-1" }),
      mockContextItem({ type: "message", content: "message-2" }),
      mockContextItem({ type: "message", content: "message-3" }),
    ];

    const messages = formatContextAsMessages(items, {
      totalMessages: 5,
      summariesCount: 2,
      dagDepth: 1,
      freshTailSize: 3,
    });

    expect(messages).toHaveLength(6);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[2]?.role).toBe("assistant");
    expect(messages[3]?.role).toBe("assistant");
    expect(messages[4]?.role).toBe("assistant");
    expect(messages[5]?.role).toBe("assistant");
    expect(messages[1]?.content).toContain("<context_summary");
  });
});
