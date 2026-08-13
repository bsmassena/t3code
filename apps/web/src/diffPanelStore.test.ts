import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, RunId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("diffPanelStore", () => {
  beforeEach(() =>
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      diffFileUiStateByScopeKey: {},
      diffRenderMode: "stacked",
    }),
  );

  it("keeps the selected render mode in panel and persisted state", async () => {
    useDiffPanelStore.getState().setDiffRenderMode("split");

    expect(useDiffPanelStore.getState().diffRenderMode).toBe("split");
    expect(
      useDiffPanelStore.persist.getOptions().partialize?.(useDiffPanelStore.getState()),
    ).toMatchObject({ diffRenderMode: "split" });

    const { name, storage } = useDiffPanelStore.persist.getOptions();
    if (!name) throw new Error("Expected diff panel persistence to have a storage name");
    const persisted = await storage?.getItem(name);
    expect(persisted?.state).toMatchObject({ diffRenderMode: "split" });

    useDiffPanelStore.setState({ diffRenderMode: "stacked" });
    if (persisted) await storage?.setItem(name, persisted);
    await useDiffPanelStore.persist.rehydrate();

    expect(useDiffPanelStore.getState().diffRenderMode).toBe("split");
  });

  it("defaults each thread to branch changes with automatic base selection", () => {
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: null });
  });

  it("clears incompatible selection fields when changing scopes", () => {
    const store = useDiffPanelStore.getState();
    store.selectTurn(THREAD_REF, RunId.make("turn-1"), "src/app.ts");
    store.selectGitScope(THREAD_REF, "unstaged");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "unstaged" });

    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, " origin/main ");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("selects staged changes as a distinct scope", () => {
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "staged");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "staged" });
  });

  it("increments the reveal request when opening the same turn file again", () => {
    const turnId = RunId.make("turn-1");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "turn", turnId, filePath: "src/app.ts", revealRequestId: 2 });
  });

  it("restores the selected branch base after visiting another scope", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "unstaged");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("reconciles a missing turn selection to the latest available turn", () => {
    const missingTurnId = RunId.make("turn-missing");
    const latestTurnId = RunId.make("turn-latest");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, missingTurnId, "src/app.ts");
    useDiffPanelStore.getState().reconcileTurnSelection(THREAD_REF, [latestTurnId]);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "turn",
      turnId: latestTurnId,
      filePath: "src/app.ts",
      revealRequestId: 1,
    });
  });

  it("persists expanded and viewed files until the thread is removed", () => {
    const scopeKey = `${THREAD_REF.environmentId}:${THREAD_REF.threadId}:branch`;
    useDiffPanelStore.getState().toggleDiffFileExpanded(scopeKey, "src/app.ts");
    useDiffPanelStore.getState().toggleDiffFileViewed(scopeKey, "src/app.ts");

    expect(useDiffPanelStore.getState().diffFileUiStateByScopeKey[scopeKey]).toEqual({
      expandedFileKeys: ["src/app.ts"],
      viewedFileKeys: ["src/app.ts"],
    });
    expect(
      useDiffPanelStore.persist.getOptions().partialize?.(useDiffPanelStore.getState()),
    ).toMatchObject({
      diffFileUiStateByScopeKey: {
        [scopeKey]: {
          expandedFileKeys: ["src/app.ts"],
          viewedFileKeys: ["src/app.ts"],
        },
      },
    });

    useDiffPanelStore.getState().removeThread(THREAD_REF);
    expect(useDiffPanelStore.getState().diffFileUiStateByScopeKey[scopeKey]).toBeUndefined();
  });

  it("keeps unchanged file state while removing stale content keys", () => {
    const scopeKey = `${THREAD_REF.environmentId}:${THREAD_REF.threadId}:branch`;
    const unchangedKey = "src/app.ts:unchanged";
    const changedKey = "src/other.ts:old";
    useDiffPanelStore.getState().toggleDiffFileExpanded(scopeKey, unchangedKey);
    useDiffPanelStore.getState().toggleDiffFileExpanded(scopeKey, changedKey);
    useDiffPanelStore.getState().toggleDiffFileViewed(scopeKey, unchangedKey);
    useDiffPanelStore.getState().toggleDiffFileViewed(scopeKey, changedKey);

    useDiffPanelStore
      .getState()
      .reconcileDiffFileUiState(scopeKey, [unchangedKey, "src/other.ts:new"]);

    expect(useDiffPanelStore.getState().diffFileUiStateByScopeKey[scopeKey]).toEqual({
      expandedFileKeys: [unchangedKey],
      viewedFileKeys: [unchangedKey],
    });
  });
});
