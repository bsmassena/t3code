import { describe, expect, it } from "vitest";

import { __mergePersistedClientSettingsForTests } from "./useSettings";

describe("client settings hydration", () => {
  it("keeps separate project grouping even when manual groups are persisted", () => {
    const settings = __mergePersistedClientSettingsForTests({
      sidebarProjectGroupingMode: "separate",
      sidebarProjectManualGroups: {
        "environment-local:/tmp/project-a": "Client work",
      },
    });

    expect(settings.sidebarProjectGroupingMode).toBe("separate");
    expect(settings.sidebarProjectManualGroups).toEqual({
      "environment-local:/tmp/project-a": "Client work",
    });
  });
});
