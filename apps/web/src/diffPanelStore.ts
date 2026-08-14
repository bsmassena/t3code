import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type DiffPanelSelection =
  | { kind: "branch"; baseRef: string | null }
  | { kind: "working-tree" }
  | { kind: "unstaged" }
  | { kind: "staged" }
  | { kind: "turn"; turnId: RunId; filePath: string | null; revealRequestId: number };

export type DiffRenderMode = "stacked" | "split";

export interface DiffFileUiState {
  readonly expandedFileKeys: ReadonlyArray<string>;
  readonly viewedFileKeys: ReadonlyArray<string>;
}

const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch", baseRef: null };
const DEFAULT_WORKING_TREE_SELECTION: DiffPanelSelection = { kind: "working-tree" };
const EMPTY_DIFF_FILE_UI_STATE: DiffFileUiState = {
  expandedFileKeys: [],
  viewedFileKeys: [],
};

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  diffFileUiStateByScopeKey: Record<string, DiffFileUiState>;
  diffRenderMode: DiffRenderMode;
  setDiffRenderMode: (mode: DiffRenderMode) => void;
  selectGitScope: (
    ref: ScopedThreadRef,
    scope: "branch" | "working-tree" | "unstaged" | "staged",
  ) => void;
  selectBranchBaseRef: (ref: ScopedThreadRef, baseRef: string | null) => void;
  selectTurn: (ref: ScopedThreadRef, turnId: RunId, filePath?: string) => void;
  reconcileTurnSelection: (ref: ScopedThreadRef, availableTurnIds: ReadonlyArray<RunId>) => void;
  toggleDiffFileExpanded: (scopeKey: string, fileKey: string) => void;
  setExpandedDiffFileKeys: (scopeKey: string, fileKeys: ReadonlyArray<string>) => void;
  toggleDiffFileViewed: (scopeKey: string, fileKey: string) => void;
  reconcileDiffFileUiState: (scopeKey: string, fileKeys: ReadonlyArray<string>) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

function toggleFileKey(fileKeys: ReadonlyArray<string>, fileKey: string): ReadonlyArray<string> {
  return fileKeys.includes(fileKey)
    ? fileKeys.filter((candidate) => candidate !== fileKey)
    : [...fileKeys, fileKey];
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      diffFileUiStateByScopeKey: {},
      diffRenderMode: "stacked",
      setDiffRenderMode: (diffRenderMode) => set({ diffRenderMode }),
      selectGitScope: (ref, scope) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const previousBaseRef =
            previous?.kind === "branch"
              ? previous.baseRef
              : (state.branchBaseRefByThreadKey[threadKey] ?? null);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]:
                scope === "branch" ? { kind: "branch", baseRef: previousBaseRef } : { kind: scope },
            },
            branchBaseRefByThreadKey:
              previous?.kind === "branch"
                ? { ...state.branchBaseRefByThreadKey, [threadKey]: previous.baseRef }
                : state.branchBaseRefByThreadKey,
          };
        }),
      selectBranchBaseRef: (ref, baseRef) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const normalizedBaseRef = normalizeBaseRef(baseRef);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { kind: "branch", baseRef: normalizedBaseRef },
            },
            branchBaseRefByThreadKey: {
              ...state.branchBaseRefByThreadKey,
              [threadKey]: normalizedBaseRef,
            },
          };
        }),
      selectTurn: (ref, turnId, filePath) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                kind: "turn",
                turnId,
                filePath: filePath?.trim() || null,
                revealRequestId: previous?.kind === "turn" ? previous.revealRequestId + 1 : 1,
              },
            },
          };
        }),
      reconcileTurnSelection: (ref, availableTurnIds) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const latestTurnId = availableTurnIds[0];
          if (
            previous?.kind !== "turn" ||
            latestTurnId === undefined ||
            availableTurnIds.includes(previous.turnId)
          ) {
            return state;
          }
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { ...previous, turnId: latestTurnId },
            },
          };
        }),
      toggleDiffFileExpanded: (scopeKey, fileKey) =>
        set((state) => {
          const current = state.diffFileUiStateByScopeKey[scopeKey] ?? EMPTY_DIFF_FILE_UI_STATE;
          return {
            diffFileUiStateByScopeKey: {
              ...state.diffFileUiStateByScopeKey,
              [scopeKey]: {
                ...current,
                expandedFileKeys: toggleFileKey(current.expandedFileKeys, fileKey),
              },
            },
          };
        }),
      setExpandedDiffFileKeys: (scopeKey, fileKeys) =>
        set((state) => {
          const current = state.diffFileUiStateByScopeKey[scopeKey] ?? EMPTY_DIFF_FILE_UI_STATE;
          return {
            diffFileUiStateByScopeKey: {
              ...state.diffFileUiStateByScopeKey,
              [scopeKey]: { ...current, expandedFileKeys: [...new Set(fileKeys)] },
            },
          };
        }),
      toggleDiffFileViewed: (scopeKey, fileKey) =>
        set((state) => {
          const current = state.diffFileUiStateByScopeKey[scopeKey] ?? EMPTY_DIFF_FILE_UI_STATE;
          return {
            diffFileUiStateByScopeKey: {
              ...state.diffFileUiStateByScopeKey,
              [scopeKey]: {
                ...current,
                viewedFileKeys: toggleFileKey(current.viewedFileKeys, fileKey),
              },
            },
          };
        }),
      reconcileDiffFileUiState: (scopeKey, fileKeys) =>
        set((state) => {
          const current = state.diffFileUiStateByScopeKey[scopeKey];
          if (!current) return state;

          const activeFileKeys = new Set(fileKeys);
          const expandedFileKeys = current.expandedFileKeys.filter((fileKey) =>
            activeFileKeys.has(fileKey),
          );
          const viewedFileKeys = current.viewedFileKeys.filter((fileKey) =>
            activeFileKeys.has(fileKey),
          );
          if (
            expandedFileKeys.length === current.expandedFileKeys.length &&
            viewedFileKeys.length === current.viewedFileKeys.length
          ) {
            return state;
          }

          if (expandedFileKeys.length === 0 && viewedFileKeys.length === 0) {
            const { [scopeKey]: _removed, ...diffFileUiStateByScopeKey } =
              state.diffFileUiStateByScopeKey;
            return { diffFileUiStateByScopeKey };
          }

          return {
            diffFileUiStateByScopeKey: {
              ...state.diffFileUiStateByScopeKey,
              [scopeKey]: { expandedFileKeys, viewedFileKeys },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const diffScopePrefix = `${threadKey}:`;
          const hasDiffFileUiState = Object.keys(state.diffFileUiStateByScopeKey).some((scopeKey) =>
            scopeKey.startsWith(diffScopePrefix),
          );
          if (
            !(threadKey in state.byThreadKey) &&
            !(threadKey in state.branchBaseRefByThreadKey) &&
            !hasDiffFileUiState
          ) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _removedBaseRef, ...branchBaseRefByThreadKey } =
            state.branchBaseRefByThreadKey;
          const diffFileUiStateByScopeKey = Object.fromEntries(
            Object.entries(state.diffFileUiStateByScopeKey).filter(
              ([scopeKey]) => !scopeKey.startsWith(diffScopePrefix),
            ),
          );
          return { byThreadKey, branchBaseRefByThreadKey, diffFileUiStateByScopeKey };
        }),
    }),
    {
      name: "t3code:diff-panel-state:v1",
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: state.byThreadKey,
        branchBaseRefByThreadKey: state.branchBaseRefByThreadKey,
        diffFileUiStateByScopeKey: state.diffFileUiStateByScopeKey,
        diffRenderMode: state.diffRenderMode,
      }),
    },
  ),
);

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
  hasWorkingTreeChanges = false,
): DiffPanelSelection {
  if (!ref) return DEFAULT_SELECTION;
  return (
    byThreadKey[scopedThreadKey(ref)] ??
    (hasWorkingTreeChanges ? DEFAULT_WORKING_TREE_SELECTION : DEFAULT_SELECTION)
  );
}
