import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatMRBody } from "./src/resources/extensions/gitlab-sync/templates.ts";

describe("test", () => {
  it("formatMRBody", () => {
    const body = formatMRBody({
      id: "S01",
      sliceId: "S01",
      sliceTitle: "Test Slice",
      milestoneId: "M001",
      milestoneTitle: "Test Milestone",
      vision: "A vision",
      taskCount: 5,
      verifyCriteria: ["Check A", "Check B"],
    });
    console.log("body:", JSON.stringify(body));
    assert.ok(body.includes("Tasks completed: 5"));
  });
});
