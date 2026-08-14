import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader } from "@pierre/diffs";
import { useParams } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import type { ScopedThreadRef, RunId } from "@t3tools/contracts";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  ExternalLinkIcon,
  MinusIcon,
  PanelRightIcon,
  PilcrowIcon,
  PlusIcon,
  RefreshCwIcon,
  Rows3Icon,
  Undo2Icon,
  SearchIcon,
  TextWrapIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { type DraftId } from "../composerDraftStore";
import { openDiffFilePrimaryAction } from "../diffFileActions";
import { useCheckpointDiff } from "~/lib/checkpointDiffState";
import { cn } from "~/lib/utils";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { useTheme } from "../hooks/useTheme";
import {
  buildFileDiffRenderKey,
  buildFileDiffUiStateKey,
  getDiffCollapseIconClassName,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
} from "../lib/diffRendering";
import { areAllDiffFilesCollapsed, toggleAllDiffFileExpansion } from "../lib/diffCollapse";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useProject, useThreadProjection, useThreadShell } from "../state/entities";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useClientSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./diffs/AnnotatableCodeView";
import { Button } from "./ui/button";
import { Toggle } from "./ui/toggle-group";
import { Switch } from "./ui/switch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { serverEnvironment } from "../state/server";
import { reviewEnvironment } from "../state/review";
import { vcsEnvironment } from "../state/vcs";
import { buildBaseRefChoices, filterBaseRefChoices } from "../lib/baseRefChoices";
import { createGitDiffFileContentsLoader } from "../lib/diffFileContents";
import { resolveDiffFileActions } from "../lib/diffReviewActions";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { DiffFileNavigator } from "./diffs/DiffFileNavigator";
import { toastManager } from "./ui/toast";

type DiffThemeType = "light" | "dark";
const AUTOMATIC_BASE_REF = "__automatic_base_ref__";

const EMPTY_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();

const DIFF_PANEL_HEADER_UNSAFE_CSS = `
[data-diffs-header] {
  cursor: pointer;
  justify-content: flex-start !important;
  gap: 1ch !important;
  border-top: 1px solid var(--border) !important;
  border-bottom: 1px solid var(--border) !important;
  background: color-mix(in srgb, var(--background) 93%, var(--foreground)) !important;
}

[data-diffs-header] [data-change-icon] {
  display: none !important;
}

[data-diffs-header] [data-header-content],
[data-diffs-header] [data-metadata] {
  display: contents !important;
}

[data-diffs-header] slot[name="header-prefix"]::slotted(*) {
  order: 0;
}

[data-diffs-header] [data-change-icon] {
  order: 1;
}

[data-diffs-header] [data-prev-name],
[data-diffs-header] [data-rename-icon],
[data-diffs-header] [data-title] {
  order: 2;
}

[data-diffs-header] [data-additions-count] {
  order: 3;
}

[data-diffs-header] [data-deletions-count] {
  order: 4;
}

[data-diffs-header] slot[name="header-filename-suffix"] {
  display: flex;
  min-width: 0;
  flex: 1;
  order: 5;
}

[data-diffs-header] slot[name="header-filename-suffix"]::slotted(*) {
  display: flex;
  min-width: 0;
  flex: 1;
}

[data-diffs-header] slot[name="header-metadata"] {
  display: block;
  order: 6;
}

[data-diffs-header]:not(:hover):not(:focus-within)
  slot[name="header-filename-suffix"]::slotted(*) {
  pointer-events: none;
  opacity: 0;
}

[data-diffs-header] [data-title] {
  flex: 0 1 auto;
}
`;

interface DiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
  initialGitScope: "branch" | "working-tree";
}

function DiffHeaderActionButton(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-40"
            aria-label={props.label}
            disabled={props.disabled}
            data-diff-header-action="file-action"
            onClick={(event) => {
              event.stopPropagation();
              props.onClick();
            }}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({
  mode = "inline",
  composerDraftTarget,
  initialGitScope: initialGitScopeProp,
}: DiffPanelProps) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const [initialGitScope] = useState(initialGitScopeProp);
  const diffRenderMode = useDiffPanelStore((state) => state.diffRenderMode);
  const setDiffRenderMode = useDiffPanelStore((state) => state.setDiffRenderMode);
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [baseRefQuery, setBaseRefQuery] = useState("");
  const [navigatorSelectedFileKey, setNavigatorSelectedFileKey] = useState<string | null>(null);
  const [pendingFileActionKey, setPendingFileActionKey] = useState<string | null>(null);
  const [navigatorVisible, setNavigatorVisible] = useState(true);
  const codeViewRef = useRef<AnnotatableCodeViewHandle>(null);
  const lastCompletedTurnRefreshRef = useRef<{
    readonly threadKey: string | null;
    readonly runId: RunId | null;
  } | null>(null);

  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const activeThread = useThreadShell(routeThreadRef);
  const activeThreadProjection = useThreadProjection(routeThreadRef)?.projection ?? null;
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useProject(
    activeThread && activeProjectId
      ? {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        }
      : null,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.workspaceRoot;
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(activeThread?.environmentId ?? null),
  );
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeThread?.environmentId ?? null,
    serverConfig?.availableEditors ?? [],
  );
  const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);
  const runDiffFileAction = useAtomCommand(reviewEnvironment.runDiffFileAction, {
    reportFailure: false,
  });
  const gitStatusQuery = useEnvironmentQuery(
    activeThread !== null && activeThread !== undefined && activeCwd != null
      ? vcsEnvironment.status({
          environmentId: activeThread.environmentId,
          input: { cwd: activeCwd },
        })
      : null,
  );
  const diffSelection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(
      state.byThreadKey,
      routeThreadRef,
      initialGitScope === "working-tree",
    ),
  );
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByRunId } =
    useTurnDiffSummaries(activeThreadProjection);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByRunId[left.runId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByRunId[right.runId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByRunId, turnDiffSummaries],
  );

  useEffect(() => {
    if (!routeThreadRef || diffSelection.kind !== "turn") return;
    useDiffPanelStore.getState().reconcileTurnSelection(
      routeThreadRef,
      orderedTurnDiffSummaries.map((summary) => summary.runId),
    );
  }, [diffSelection, orderedTurnDiffSummaries, routeThreadRef]);

  const selectedRunId = diffSelection.kind === "turn" ? diffSelection.turnId : null;
  const selectedGitScope =
    diffSelection.kind === "working-tree"
      ? "working-tree"
      : diffSelection.kind === "unstaged"
        ? "unstaged"
        : diffSelection.kind === "staged"
          ? "staged"
          : "branch";
  const selectedBaseRef = diffSelection.kind === "branch" ? diffSelection.baseRef : null;
  const selectedFilePath = diffSelection.kind === "turn" ? diffSelection.filePath : null;
  const selectedFileRevealRequestId =
    diffSelection.kind === "turn" ? diffSelection.revealRequestId : 0;
  const selectedTurn =
    selectedRunId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.runId === selectedRunId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByRunId[selectedTurn.runId]);
  const latestTurn = orderedTurnDiffSummaries[0];
  const selectedScopeLabel =
    selectedRunId === null
      ? selectedGitScope === "working-tree"
        ? "Working tree"
        : selectedGitScope === "unstaged"
          ? "Unstaged"
          : selectedGitScope === "staged"
            ? "Staged"
            : "Branch changes"
      : selectedTurn?.runId === latestTurn?.runId
        ? "Latest turn"
        : `Turn ${selectedCheckpointTurnCount ?? "?"}`;
  const reviewSectionId = selectedTurn ? `turn:${selectedTurn.runId}` : selectedGitScope;
  const collapseScopeKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}:${reviewSectionId}`
    : null;
  const diffFileUiState = useDiffPanelStore((state) =>
    collapseScopeKey ? state.diffFileUiStateByScopeKey[collapseScopeKey] : undefined,
  );
  const expandedDiffFileKeys = useMemo(
    () => new Set(diffFileUiState?.expandedFileKeys ?? EMPTY_DIFF_FILE_KEYS),
    [diffFileUiState?.expandedFileKeys],
  );
  const viewedDiffFileKeys = useMemo(
    () => new Set(diffFileUiState?.viewedFileKeys ?? EMPTY_DIFF_FILE_KEYS),
    [diffFileUiState?.viewedFileKeys],
  );
  const codeViewMountKey = collapseScopeKey ?? reviewSectionId;
  const reviewSectionTitle = selectedTurn
    ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
    : selectedGitScope === "working-tree"
      ? "Working tree"
      : selectedGitScope === "unstaged"
        ? "Unstaged"
        : selectedGitScope === "staged"
          ? "Staged"
          : "Branch changes";
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const activeCheckpointDiff = useCheckpointDiff(
    {
      environmentId: activeThread?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: selectedCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: selectedCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.runId}` : null,
    },
    { enabled: isGitRepo && selectedTurn !== undefined },
  );
  const primaryBranchDiffPreview = useEnvironmentQuery(
    selectedRunId === null && activeThread && activeCwd
      ? reviewEnvironment.diffPreview({
          environmentId: activeThread.environmentId,
          input: {
            cwd: activeCwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
            includeLocalSources: true,
          },
        })
      : null,
  );
  const shouldRetryBranchDiffAtEnvironmentCwd =
    selectedRunId === null &&
    primaryBranchDiffPreview.error?.includes("configured workspace root") === true &&
    serverConfig?.cwd !== undefined &&
    serverConfig.cwd !== activeCwd;
  const fallbackBranchDiffPreview = useEnvironmentQuery(
    shouldRetryBranchDiffAtEnvironmentCwd && activeThread && serverConfig
      ? reviewEnvironment.diffPreview({
          environmentId: activeThread.environmentId,
          input: {
            cwd: serverConfig.cwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
            includeLocalSources: true,
          },
        })
      : null,
  );
  const branchDiffPreview = shouldRetryBranchDiffAtEnvironmentCwd
    ? fallbackBranchDiffPreview
    : primaryBranchDiffPreview;
  const refreshBranchDiffPreview = branchDiffPreview.refresh;
  const canRefreshGitDiff =
    isGitRepo && selectedRunId === null && activeThread != null && activeCwd != null;
  const activeThreadRefreshKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}`
    : null;

  useEffect(() => {
    if (!canRefreshGitDiff) return;
    const refreshOnFocus = () => refreshBranchDiffPreview();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [canRefreshGitDiff, refreshBranchDiffPreview]);

  useEffect(() => {
    const current = {
      threadKey: activeThreadRefreshKey,
      runId: latestTurn?.runId ?? null,
    };
    const previous = lastCompletedTurnRefreshRef.current;
    if (!canRefreshGitDiff) {
      return;
    }
    if (previous === null || previous.threadKey !== current.threadKey) {
      lastCompletedTurnRefreshRef.current = current;
      return;
    }
    if (previous.runId === current.runId) return;
    refreshBranchDiffPreview();
    lastCompletedTurnRefreshRef.current = current;
  }, [activeThreadRefreshKey, canRefreshGitDiff, latestTurn?.runId, refreshBranchDiffPreview]);

  const gitSources = [
    ...(branchDiffPreview.data?.sources ?? []),
    ...(branchDiffPreview.data?.localSources ?? []),
  ];
  const supportsLocalGitSources = branchDiffPreview.data?.localSources !== undefined;
  const selectedGitSource = gitSources.find(
    (source) =>
      source.kind ===
      (selectedGitScope === "working-tree"
        ? "working-tree"
        : selectedGitScope === "unstaged"
          ? gitSources.some((candidate) => candidate.kind === "unstaged")
            ? "unstaged"
            : "working-tree"
          : selectedGitScope === "staged"
            ? "staged"
            : "branch-range"),
  );
  useEffect(() => {
    if (
      selectedRunId === null &&
      (selectedGitScope === "staged" || selectedGitScope === "unstaged") &&
      branchDiffPreview.data &&
      !supportsLocalGitSources &&
      routeThreadRef
    ) {
      useDiffPanelStore.getState().selectGitScope(routeThreadRef, "working-tree");
    }
  }, [
    branchDiffPreview.data,
    routeThreadRef,
    selectedGitScope,
    selectedRunId,
    supportsLocalGitSources,
  ]);
  const loadDiffFiles = useMemo<FileDiffContentsLoader | undefined>(() => {
    const preview = branchDiffPreview.data;
    if (selectedRunId !== null || !activeThread || !preview || !selectedGitSource) {
      return undefined;
    }

    return createGitDiffFileContentsLoader(getDiffFileContents, {
      environmentId: activeThread.environmentId,
      cwd: preview.cwd,
      sourceKind: selectedGitSource.kind,
      baseRef: selectedGitSource.baseRef,
      headRef: selectedGitSource.headRef,
      cacheKey: selectedGitSource.diffHash,
    });
  }, [activeThread, branchDiffPreview.data, getDiffFileContents, selectedGitSource, selectedRunId]);
  const localBranchRefs = useEnvironmentQuery(
    selectedRunId === null &&
      selectedGitScope === "branch" &&
      activeThread &&
      branchDiffPreview.data?.cwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: branchDiffPreview.data.cwd,
            includeMatchingRemoteRefs: true,
            refKind: "local",
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  );
  const remoteBranchRefs = useEnvironmentQuery(
    selectedRunId === null &&
      selectedGitScope === "branch" &&
      activeThread &&
      branchDiffPreview.data?.cwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: branchDiffPreview.data.cwd,
            includeMatchingRemoteRefs: true,
            refKind: "remote",
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  );
  const baseRefChoices = buildBaseRefChoices(
    localBranchRefs.data?.refs.filter((ref) => ref.name !== selectedGitSource?.headRef) ?? [],
    remoteBranchRefs.data?.refs ?? [],
  );
  const matchingBaseRefChoices = filterBaseRefChoices(baseRefChoices, baseRefQuery);
  const valueForBaseRefChoice = (choice: (typeof baseRefChoices)[number]) =>
    selectedBaseRef && selectedBaseRef === choice.remote?.name
      ? selectedBaseRef
      : (choice.local?.name ?? choice.remote?.name ?? choice.id);
  const baseRefItems = [AUTOMATIC_BASE_REF, ...baseRefChoices.map(valueForBaseRefChoice)];
  const filteredBaseRefItems = [
    ...(baseRefQuery.trim().length === 0 ? [AUTOMATIC_BASE_REF] : []),
    ...matchingBaseRefChoices.map(valueForBaseRefChoice),
  ];
  const gitDiff = selectedGitSource?.diff;

  const selectedPatch = selectedTurn ? activeCheckpointDiff.data?.diff : gitDiff;
  const isSelectedPatchTruncated = !selectedTurn && selectedGitSource?.truncated === true;
  const isLoadingSelectedPatch = selectedTurn
    ? activeCheckpointDiff.isPending
    : branchDiffPreview.isPending;
  const selectedPatchError = selectedTurn ? activeCheckpointDiff.error : branchDiffPreview.error;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`, {
        compactPartialHunkOffsets: selectedRunId === null,
      }),
    [resolvedTheme, selectedPatch, selectedRunId],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);
  const renderableFileEntries = useMemo(
    () =>
      renderableFiles.map((fileDiff) => ({
        fileDiff,
        fileKey: buildFileDiffRenderKey(fileDiff),
        uiStateKey: buildFileDiffUiStateKey(fileDiff),
      })),
    [renderableFiles],
  );
  const codeViewFiles = useMemo(
    () =>
      renderableFileEntries.map(({ fileDiff, fileKey, uiStateKey }) => {
        return {
          fileDiff,
          filePath: resolveFileDiffPath(fileDiff),
          fileKey,
          collapsed: !expandedDiffFileKeys.has(uiStateKey),
        };
      }),
    [expandedDiffFileKeys, renderableFileEntries],
  );
  const diffFileUiStateKeys = useMemo(
    () => renderableFileEntries.map((file) => file.uiStateKey),
    [renderableFileEntries],
  );
  const uiStateKeyByRenderKey = useMemo(
    () => new Map(renderableFileEntries.map((file) => [file.fileKey, file.uiStateKey])),
    [renderableFileEntries],
  );
  const allDiffFilesCollapsed = areAllDiffFilesCollapsed(diffFileUiStateKeys, expandedDiffFileKeys);
  const diffLineStat = useMemo(() => getDiffLineStat(renderableFiles), [renderableFiles]);
  const selectedDiffFileKey = selectedFilePath
    ? (codeViewFiles.find((candidate) => candidate.filePath === selectedFilePath)?.fileKey ?? null)
    : null;

  useEffect(() => {
    if (!collapseScopeKey || diffFileUiStateKeys.length === 0) return;
    useDiffPanelStore.getState().reconcileDiffFileUiState(collapseScopeKey, diffFileUiStateKeys);
  }, [collapseScopeKey, diffFileUiStateKeys]);

  useEffect(() => {
    if (!selectedDiffFileKey) return;
    codeViewRef.current?.scrollTo({ type: "item", id: selectedDiffFileKey, align: "start" });
  }, [codeViewMountKey, selectedDiffFileKey, selectedFileRevealRequestId]);

  useEffect(() => {
    if (
      navigatorSelectedFileKey !== null &&
      !codeViewFiles.some((file) => file.fileKey === navigatorSelectedFileKey)
    ) {
      setNavigatorSelectedFileKey(null);
    }
  }, [codeViewFiles, navigatorSelectedFileKey]);

  useEffect(() => {
    if (!navigatorSelectedFileKey) return;
    codeViewRef.current?.scrollTo({
      type: "item",
      id: navigatorSelectedFileKey,
      align: "start",
    });
  }, [codeViewFiles, navigatorSelectedFileKey]);

  const openDiffFile = useCallback(
    (filePath: string) => {
      openDiffFilePrimaryAction({
        threadRef: routeThreadRef,
        filePath,
        activeCwd,
        openInEditor: (targetPath) => {
          void (async () => {
            const result = await openInPreferredEditor(targetPath);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              console.warn("Failed to open diff file in editor.", {
                operation: "open-diff-file",
                ...(routeThreadRef
                  ? {
                      environmentId: routeThreadRef.environmentId,
                      threadId: routeThreadRef.threadId,
                    }
                  : {}),
                ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
              });
            }
          })();
        },
      });
    },
    [activeCwd, openInPreferredEditor, routeThreadRef],
  );
  const toggleDiffFileCollapsed = useCallback(
    (fileUiStateKey: string) => {
      if (!collapseScopeKey) return;
      useDiffPanelStore.getState().toggleDiffFileExpanded(collapseScopeKey, fileUiStateKey);
    },
    [collapseScopeKey],
  );

  const toggleDiffFileViewed = useCallback(
    (fileUiStateKey: string) => {
      if (!collapseScopeKey) return;
      useDiffPanelStore.getState().toggleDiffFileViewed(collapseScopeKey, fileUiStateKey);
    },
    [collapseScopeKey],
  );

  const toggleDiffFileCollapse = useCallback(() => {
    if (!collapseScopeKey) return;
    useDiffPanelStore
      .getState()
      .setExpandedDiffFileKeys(collapseScopeKey, [
        ...toggleAllDiffFileExpansion(diffFileUiStateKeys, expandedDiffFileKeys),
      ]);
  }, [collapseScopeKey, diffFileUiStateKeys, expandedDiffFileKeys]);

  const selectNavigatorFile = useCallback(
    (fileKey: string) => {
      setNavigatorSelectedFileKey(fileKey);
      const fileUiStateKey = uiStateKeyByRenderKey.get(fileKey);
      if (collapseScopeKey && fileUiStateKey && !expandedDiffFileKeys.has(fileUiStateKey)) {
        useDiffPanelStore
          .getState()
          .setExpandedDiffFileKeys(collapseScopeKey, [...expandedDiffFileKeys, fileUiStateKey]);
        return;
      }
      codeViewRef.current?.scrollTo({ type: "item", id: fileKey, align: "start" });
    },
    [collapseScopeKey, expandedDiffFileKeys, uiStateKeyByRenderKey],
  );

  const runFileAction = useCallback(
    async (
      action: "stage" | "unstage" | "revert" | "revert-staged",
      filePath: string,
      previousFilePath?: string,
    ) => {
      if (!activeThread || !branchDiffPreview.data || pendingFileActionKey !== null) return;
      const actionKey = `${action}:${filePath}`;
      setPendingFileActionKey(actionKey);
      const result = await runDiffFileAction({
        environmentId: activeThread.environmentId,
        input: {
          cwd: branchDiffPreview.data.cwd,
          filePath,
          ...(previousFilePath && previousFilePath !== filePath ? { previousFilePath } : {}),
          action,
        },
      });
      setPendingFileActionKey((current) => (current === actionKey ? null : current));
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `Unable to ${action === "revert-staged" ? "revert" : action} file`,
          description: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      refreshBranchDiffPreview();
    },
    [
      activeThread,
      branchDiffPreview.data,
      pendingFileActionKey,
      refreshBranchDiffPreview,
      runDiffFileAction,
    ],
  );

  const selectTurn = (runId: RunId) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectTurn(routeThreadRef, runId);
  };
  const selectGitScope = (scope: "branch" | "working-tree" | "unstaged" | "staged") => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectGitScope(routeThreadRef, scope);
  };
  const selectBranchBaseRef = (baseRef: string | null) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectBranchBaseRef(routeThreadRef, baseRef);
  };

  const headerRow = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3 [-webkit-app-region:no-drag]">
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-accent px-2 text-xs font-medium text-accent-foreground outline-none transition-colors hover:bg-accent/80 focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Diff scope: ${selectedScopeLabel}`}
          >
            <span className="truncate">{selectedScopeLabel}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuItem
              className={
                selectedRunId === null && selectedGitScope === "working-tree"
                  ? "bg-foreground/[0.08]"
                  : undefined
              }
              onClick={() => selectGitScope("working-tree")}
            >
              <span>Working tree</span>
              {selectedRunId === null && selectedGitScope === "working-tree" && (
                <CheckIcon className="ml-auto" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              className={
                selectedRunId === null && selectedGitScope === "unstaged"
                  ? "bg-foreground/[0.08]"
                  : undefined
              }
              disabled={!supportsLocalGitSources}
              title={
                supportsLocalGitSources ? undefined : "Unstaged diffs require an updated server."
              }
              onClick={() => selectGitScope("unstaged")}
            >
              <span>Unstaged</span>
              {selectedRunId === null && selectedGitScope === "unstaged" && (
                <CheckIcon className="ml-auto" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              className={
                selectedRunId === null && selectedGitScope === "staged"
                  ? "bg-foreground/[0.08]"
                  : undefined
              }
              disabled={!supportsLocalGitSources}
              title={
                supportsLocalGitSources ? undefined : "Staged diffs require an updated server."
              }
              onClick={() => selectGitScope("staged")}
            >
              <span>Staged</span>
              {selectedRunId === null && selectedGitScope === "staged" && (
                <CheckIcon className="ml-auto" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              className={
                selectedRunId === null && selectedGitScope === "branch"
                  ? "bg-foreground/[0.08]"
                  : undefined
              }
              onClick={() => selectGitScope("branch")}
            >
              <span>Branch changes</span>
              {selectedRunId === null && selectedGitScope === "branch" && (
                <CheckIcon className="ml-auto" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              className={
                selectedRunId !== null && selectedTurn?.runId === latestTurn?.runId
                  ? "bg-foreground/[0.08]"
                  : undefined
              }
              onClick={() => {
                if (latestTurn) selectTurn(latestTurn.runId);
              }}
            >
              <span>Latest turn</span>
              {selectedRunId !== null && selectedTurn?.runId === latestTurn?.runId && (
                <CheckIcon className="ml-auto" />
              )}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Turn</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64">
                {orderedTurnDiffSummaries.map((summary) => {
                  const turnCount =
                    summary.checkpointTurnCount ??
                    inferredCheckpointTurnCountByRunId[summary.runId] ??
                    "?";
                  return (
                    <DropdownMenuItem
                      key={summary.runId}
                      className={
                        summary.runId === selectedTurn?.runId ? "bg-foreground/[0.08]" : undefined
                      }
                      onClick={() => selectTurn(summary.runId)}
                    >
                      <span>Turn {turnCount}</span>
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                        {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                      </span>
                      {summary.runId === selectedTurn?.runId && <CheckIcon className="ml-1" />}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        {selectedRunId === null && selectedGitScope === "branch" && selectedGitSource?.baseRef && (
          <div
            className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
            title={`${selectedGitSource.headRef ?? "HEAD"} → ${selectedGitSource.baseRef}`}
            aria-label={`Comparing ${selectedGitSource.headRef ?? "HEAD"} against ${selectedGitSource.baseRef}`}
          >
            <span className="min-w-0 max-w-48 truncate">{selectedGitSource.headRef ?? "HEAD"}</span>
            <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
            <Combobox
              items={baseRefItems}
              filteredItems={filteredBaseRefItems}
              value={selectedBaseRef ?? AUTOMATIC_BASE_REF}
              onOpenChange={(open) => {
                if (!open) setBaseRefQuery("");
              }}
              onValueChange={(value) => {
                if (!value) return;
                selectBranchBaseRef(value === AUTOMATIC_BASE_REF ? null : value);
              }}
            >
              <ComboboxTrigger
                className="inline-flex min-w-0 max-w-48 items-center gap-1 overflow-hidden rounded-md px-1.5 py-1 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Change comparison target. Currently ${selectedGitSource.baseRef}`}
              >
                <span className="min-w-0 truncate">{selectedGitSource.baseRef}</span>
                <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
              </ComboboxTrigger>
              <ComboboxPopup
                align="start"
                className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden [&>[data-slot=combobox-popup]]:min-w-0 [&>[data-slot=combobox-popup]]:overflow-hidden"
              >
                <div className="min-w-0 shrink-0 px-3 pt-2.5">
                  <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
                    <SearchIcon
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
                    />
                    <ComboboxInput
                      className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
                      inputClassName="rounded-none bg-transparent text-sm"
                      placeholder="Search refs..."
                      showTrigger={false}
                      size="sm"
                      unstyled
                      value={baseRefQuery}
                      onChange={(event) => setBaseRefQuery(event.target.value)}
                    />
                  </div>
                </div>
                <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
                  <span aria-hidden="true" />
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
                    <span>Branch</span>
                    <span className="text-right">Remote</span>
                  </div>
                </div>
                <ComboboxEmpty>No matching refs.</ComboboxEmpty>
                <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
                  <ComboboxItem
                    className="h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] py-0"
                    contentClassName="w-full min-w-0 overflow-hidden"
                    value={AUTOMATIC_BASE_REF}
                  >
                    <span className="block min-w-0 truncate">Automatic</span>
                  </ComboboxItem>
                  {baseRefChoices.map((choice) => {
                    const item = valueForBaseRefChoice(choice);
                    const hasBoth = choice.local !== null && choice.remote !== null;
                    const useRemote = choice.remote?.name === item;
                    return (
                      <ComboboxItem
                        key={choice.id}
                        className="h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] py-0"
                        contentClassName="w-full min-w-0 overflow-hidden"
                        value={item}
                      >
                        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center overflow-hidden">
                          <span className="block min-w-0 truncate pe-2">{choice.label}</span>
                          {hasBoth ? (
                            <div
                              className="flex justify-end"
                              onClick={(event) => event.stopPropagation()}
                              onPointerDown={(event) => event.stopPropagation()}
                            >
                              <Switch
                                aria-label={`Use remote version of ${choice.label}`}
                                checked={useRemote}
                                className="[--thumb-size:--spacing(3)]"
                                onCheckedChange={(checked) => {
                                  const nextRef = checked
                                    ? choice.remote?.name
                                    : choice.local?.name;
                                  if (nextRef) selectBranchBaseRef(nextRef);
                                }}
                              />
                            </div>
                          ) : choice.remote ? (
                            <span
                              className="flex justify-end text-muted-foreground"
                              title="Remote only"
                            >
                              <CheckIcon aria-hidden="true" className="size-3" />
                            </span>
                          ) : null}
                        </div>
                      </ComboboxItem>
                    );
                  })}
                </ComboboxList>
              </ComboboxPopup>
            </Combobox>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {codeViewFiles.length > 0 && (
          <DiffStatLabel
            additions={diffLineStat.additions}
            deletions={diffLineStat.deletions}
            className="mr-1 text-[11px]"
            layout="inline"
          />
        )}
        {canRefreshGitDiff && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={branchDiffPreview.isPending ? "Refreshing diff" : "Refresh diff"}
                  onClick={refreshBranchDiffPreview}
                />
              }
            >
              <RefreshCwIcon
                className={cn("size-3.5", branchDiffPreview.isPending && "animate-spin")}
              />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {branchDiffPreview.isPending ? "Refreshing diff…" : "Refresh diff"}
            </TooltipPopup>
          </Tooltip>
        )}
        {codeViewFiles.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
                  onClick={toggleDiffFileCollapse}
                />
              }
            >
              {allDiffFilesCollapsed ? (
                <ChevronsUpDownIcon className="size-3.5" />
              ) : (
                <ChevronsDownUpIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
            </TooltipPopup>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={
                  diffRenderMode === "split" ? "Switch to unified diff" : "Switch to split diff"
                }
                onClick={() => setDiffRenderMode(diffRenderMode === "split" ? "stacked" : "split")}
              />
            }
          >
            {diffRenderMode === "split" ? (
              <Rows3Icon className="size-3.5" />
            ) : (
              <Columns2Icon className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {diffRenderMode === "split" ? "Switch to unified diff" : "Switch to split diff"}
          </TooltipPopup>
        </Tooltip>
        {codeViewFiles.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={navigatorVisible ? "Hide file navigator" : "Show file navigator"}
                  variant="ghost"
                  size="sm"
                  pressed={navigatorVisible}
                  onPressedChange={(pressed) => setNavigatorVisible(Boolean(pressed))}
                />
              }
            >
              <PanelRightIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {navigatorVisible ? "Hide file navigator" : "Show file navigator"}
            </TooltipPopup>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
                variant="ghost"
                size="sm"
                pressed={wordWrap}
                onPressedChange={(pressed) => {
                  setWordWrap(Boolean(pressed));
                }}
              />
            }
          >
            <TextWrapIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
                }
                variant="ghost"
                size="sm"
                pressed={diffIgnoreWhitespace}
                onPressedChange={(pressed) => {
                  setDiffIgnoreWhitespace(Boolean(pressed));
                }}
              />
            }
          >
            <PilcrowIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : selectedRunId !== null && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <>
          <div className="diff-panel-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {isSelectedPatchTruncated && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                This diff was truncated because it exceeded the preview limit. The changes shown are
                incomplete.
              </p>
            )}
            {selectedPatchError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[11px] text-error/80">{selectedPatchError}</p>
              </div>
            )}
            {!renderablePatch ? (
              isLoadingSelectedPatch ? (
                <DiffPanelLoadingState
                  label={
                    selectedTurn
                      ? "Loading checkpoint diff..."
                      : selectedGitScope === "working-tree"
                        ? "Loading working tree diff..."
                        : selectedGitScope === "unstaged"
                          ? "Loading unstaged diff..."
                          : selectedGitScope === "staged"
                            ? "Loading staged diff..."
                            : "Loading branch diff..."
                  }
                />
              ) : (
                <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                  <p>
                    {hasNoNetChanges
                      ? "No net changes in this selection."
                      : "No patch available for this selection."}
                  </p>
                </div>
              )
            ) : renderablePatch.kind === "files" ? (
              <div className="flex min-h-0 flex-1">
                <div
                  className="min-h-0 min-w-0 flex-1"
                  onClickCapture={(event) => {
                    const composedPath = event.nativeEvent.composedPath?.() ?? [];
                    const clickedAction = composedPath.some(
                      (node) =>
                        node instanceof HTMLElement && node.hasAttribute("data-diff-header-action"),
                    );
                    if (clickedAction) return;

                    const header = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
                    );
                    if (!header) return;

                    const root = header.getRootNode();
                    const host = root instanceof ShadowRoot ? root.host : null;
                    const fileKey =
                      host instanceof HTMLElement
                        ? host.querySelector<HTMLElement>("[data-diff-file-key]")?.dataset
                            .diffFileKey
                        : undefined;
                    if (fileKey) toggleDiffFileCollapsed(fileKey);
                  }}
                >
                  <AnnotatableCodeView
                    key={collapseScopeKey ?? reviewSectionId}
                    viewerRef={codeViewRef}
                    codeViewKey={codeViewMountKey}
                    className="h-full min-h-0 overflow-auto"
                    files={codeViewFiles}
                    sectionId={reviewSectionId}
                    sectionTitle={reviewSectionTitle}
                    composerDraftTarget={composerDraftTarget}
                    unsafeCSSExtra={DIFF_PANEL_HEADER_UNSAFE_CSS}
                    renderHeaderPrefix={(fileDiff, fileKey, collapsed) => {
                      const filePath = resolveFileDiffPath(fileDiff);
                      const uiStateKey = uiStateKeyByRenderKey.get(fileKey);
                      if (!uiStateKey) return null;
                      return (
                        <div className="flex items-center gap-1">
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  className={cn(
                                    "-ms-0.5 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-foreground/10 focus-visible:outline-hidden",
                                    getDiffCollapseIconClassName(fileDiff),
                                  )}
                                  aria-label={
                                    collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`
                                  }
                                  aria-expanded={!collapsed}
                                  data-diff-file-key={uiStateKey}
                                  data-diff-header-action="toggle-collapse"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    toggleDiffFileCollapsed(uiStateKey);
                                  }}
                                />
                              }
                            >
                              {collapsed ? (
                                <ChevronRightIcon className="size-4" />
                              ) : (
                                <ChevronDownIcon className="size-4" />
                              )}
                            </TooltipTrigger>
                            <TooltipPopup side="top">
                              {collapsed ? "Expand diff" : "Collapse diff"}
                            </TooltipPopup>
                          </Tooltip>
                          <PierreEntryIcon
                            pathValue={filePath}
                            kind="file"
                            theme={resolvedTheme}
                            className="size-3.5"
                          />
                        </div>
                      );
                    }}
                    renderHeaderFilenameSuffix={(fileDiff, fileKey) => {
                      const filePath = resolveFileDiffPath(fileDiff);
                      const uiStateKey = uiStateKeyByRenderKey.get(fileKey);
                      if (!uiStateKey) return null;
                      return (
                        <div className="flex items-center gap-3 transition-opacity duration-100">
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                                  aria-label={`Open ${filePath} in a tab`}
                                  data-diff-header-action="open-file"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openDiffFile(filePath);
                                  }}
                                />
                              }
                            >
                              <ExternalLinkIcon className="size-3.5" />
                            </TooltipTrigger>
                            <TooltipPopup side="top">Open file in a tab</TooltipPopup>
                          </Tooltip>
                        </div>
                      );
                    }}
                    renderHeaderMetadata={(fileDiff, fileKey) => {
                      const uiStateKey = uiStateKeyByRenderKey.get(fileKey);
                      if (!uiStateKey) return null;
                      const filePath = resolveFileDiffPath(fileDiff);
                      const previousFilePath = resolveFileDiffPreviousPath(fileDiff);
                      const viewed = viewedDiffFileKeys.has(uiStateKey);
                      const fileActions = supportsLocalGitSources
                        ? resolveDiffFileActions({
                            scope: selectedGitScope,
                            changeType: fileDiff.type,
                            isCheckpoint: selectedRunId !== null,
                          })
                        : [];
                      return (
                        <div className="flex shrink-0 items-center gap-1 pr-2">
                          {fileActions.includes("revert") && (
                            <DiffHeaderActionButton
                              label="Revert file"
                              disabled={pendingFileActionKey !== null}
                              onClick={() =>
                                void runFileAction(
                                  selectedGitScope === "staged" ? "revert-staged" : "revert",
                                  filePath,
                                  previousFilePath,
                                )
                              }
                            >
                              <Undo2Icon className="size-3.5" />
                            </DiffHeaderActionButton>
                          )}
                          {fileActions.includes("stage") && (
                            <DiffHeaderActionButton
                              label="Stage file"
                              disabled={pendingFileActionKey !== null}
                              onClick={() =>
                                void runFileAction("stage", filePath, previousFilePath)
                              }
                            >
                              <PlusIcon className="size-3.5" />
                            </DiffHeaderActionButton>
                          )}
                          {fileActions.includes("unstage") && (
                            <DiffHeaderActionButton
                              label="Unstage file"
                              disabled={pendingFileActionKey !== null}
                              onClick={() =>
                                void runFileAction("unstage", filePath, previousFilePath)
                              }
                            >
                              <MinusIcon className="size-3.5" />
                            </DiffHeaderActionButton>
                          )}
                          <button
                            type="button"
                            className="ml-1 inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent p-0 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={
                              viewed
                                ? `Mark ${filePath} as not viewed`
                                : `Mark ${filePath} as viewed`
                            }
                            aria-pressed={viewed}
                            data-diff-header-action="toggle-viewed"
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleDiffFileViewed(uiStateKey);
                            }}
                          >
                            {viewed && <CheckIcon className="size-3.5" />}
                            <span>{viewed ? "Viewed" : "Mark as viewed"}</span>
                          </button>
                        </div>
                      );
                    }}
                    options={{
                      diffStyle: diffRenderMode === "split" ? "split" : "unified",
                      lineDiffType: "none",
                      overflow: wordWrap ? "wrap" : "scroll",
                      theme: resolveDiffThemeName(resolvedTheme),
                      themeType: resolvedTheme as DiffThemeType,
                      stickyHeaders: true,
                      ...(loadDiffFiles ? { loadDiffFiles } : {}),
                    }}
                  />
                </div>
                {navigatorVisible && (
                  <DiffFileNavigator
                    files={codeViewFiles}
                    selectedFileKey={navigatorSelectedFileKey}
                    theme={resolvedTheme}
                    onSelectFile={selectNavigatorFile}
                  />
                )}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                      wordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch.text}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}
