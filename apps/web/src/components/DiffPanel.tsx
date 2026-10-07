import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
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
  Columns2Icon,
  ExternalLinkIcon,
  MinusIcon,
  PanelRightIcon,
  PilcrowIcon,
  PlusIcon,
  Rows3Icon,
  Undo2Icon,
  TextWrapIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as DateTime from "effect/DateTime";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { ChevronsDownUp, ChevronsUpDown } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { useFileContextMenuHandler } from "../fileContextMenu";
import { type DraftId } from "../composerDraftStore";
import { openDiffFilePrimaryAction } from "../diffFileActions";
import { useCheckpointDiff } from "~/lib/checkpointDiffState";
import { cn } from "~/lib/utils";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { useTheme } from "../hooks/useTheme";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  buildFileDiffUiStateKey,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
} from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { areAllDiffFilesCollapsed, toggleAllDiffFileExpansion } from "../lib/diffCollapse";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useWorkspaceMutationRefresh } from "../hooks/useWorkspaceMutationRefresh";
import { useProject, useThreadProjection, useThreadShell } from "../state/entities";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../timestampFormat";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./diffs/AnnotatableCodeView";
import { Button } from "./ui/button";
import { Toggle } from "./ui/toggle-group";
import { Switch } from "./ui/switch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
import {
  resolveDiffFileActions,
  recordCompletedDiffFileAction,
  getCompletedDiffFiles,
  needsDiffActionRefresh,
} from "../lib/diffReviewActions";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { DiffFileNavigator } from "./diffs/DiffFileNavigator";
import { toastManager } from "./ui/toast";

import { useReviewFilePatches } from "./diffs/useReviewFilePatches";
import { DiffFileLoadingBoundary } from "./diffs/DiffFileLoadingBoundary";

type DiffThemeType = "light" | "dark";
const AUTOMATIC_BASE_REF = "__automatic_base_ref__";
const fileEntryCache = new WeakMap<
  FileDiffMetadata,
  { fileDiff: FileDiffMetadata; fileKey: string; fileVersion: number; uiStateKey: string }
>();

function getCachedFileEntry(fileDiff: FileDiffMetadata) {
  const cached = fileEntryCache.get(fileDiff);
  if (cached) return cached;
  const entry = {
    fileDiff,
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion: buildFileDiffContentVersion(fileDiff),
    uiStateKey: buildFileDiffUiStateKey(fileDiff),
  };
  fileEntryCache.set(fileDiff, entry);
  return entry;
}

const EMPTY_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();

const DIFF_PANEL_HEADER_UNSAFE_CSS = `
[data-diffs-header] {
  cursor: pointer;
  justify-content: flex-start !important;
  gap: 8px !important;
  border-top: 0 !important;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent) !important;
  background: var(--background) !important;
}

[data-diffs-header]:hover {
  background: color-mix(in srgb, var(--background) 98%, var(--foreground)) !important;
}

[data-diffs-header] [data-change-icon] {
  display: none !important;
}

[data-diffs-header] [data-header-content],
[data-diffs-header] [data-metadata] {
  display: contents !important;
}

[data-diffs-header] slot[name="header-prefix"] {
  display: flex;
  flex-shrink: 0;
  order: 0;
  margin-inline-end: -6px;
}

[data-diffs-header] [data-change-icon] {
  order: 1;
}

[data-diffs-header] [data-prev-name],
[data-diffs-header] [data-rename-icon],
[data-diffs-header] [data-title] {
  order: 2;
}

[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  display: none;
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
  --diff-file-action-opacity: 1;
  --diff-file-action-pointer-events: auto;
  --diff-mark-as-viewed-opacity: 1;
  --diff-mark-as-viewed-pointer-events: auto;
  display: block;
  order: 6;
}

[data-diffs-header]:not(:hover):not(:focus-within) slot[name="header-metadata"] {
  --diff-file-action-opacity: 0;
  --diff-file-action-pointer-events: none;
  --diff-mark-as-viewed-opacity: 0;
  --diff-mark-as-viewed-pointer-events: none;
}

[data-diffs-header]:not(:hover):not(:focus-within) slot[name="header-filename-suffix"] {
  --diff-file-action-opacity: 0;
  --diff-file-action-pointer-events: none;
}

[data-diffs-header] [data-title] {
  flex: 0 1 auto;
}
`;

interface DiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
  initialGitScope?: "branch" | "working-tree";
  workspaceMutationId: string | null;
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
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-muted-foreground opacity-(--diff-file-action-opacity) transition-[color,background-color,opacity] duration-100 [pointer-events:var(--diff-file-action-pointer-events)] hover:bg-foreground/10 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-40"
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
  initialGitScope: initialGitScopeProp = "working-tree",
  composerDraftTarget,
  workspaceMutationId,
}: DiffPanelProps) {
  const { resolvedTheme, syntaxTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme, syntaxTheme);
  const settings = useClientSettings();
  const [initialGitScope] = useState(initialGitScopeProp);
  const diffRenderMode = settings.diffLayout;
  const updateSettings = useUpdateClientSettings();
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [baseRefQuery, setBaseRefQuery] = useState("");
  const [navigatorSelectedFileKey, setNavigatorSelectedFileKey] = useState<string | null>(null);
  const [pendingFileActionKey, setPendingFileActionKey] = useState<string | null>(null);
  const [navigatorVisible, setNavigatorVisible] = useState(true);
  const codeViewRef = useRef<AnnotatableCodeViewHandle>(null);

  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const activeThread = useThreadShell(routeThreadRef);
  const activeThreadProjection = useThreadProjection(routeThreadRef)?.projection ?? null;
  const fileAccess = useFilesystemReadAccess(activeThread?.environmentId ?? null);
  const { canReadFiles } = fileAccess;
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
  const activeRepositoryRoot = activeThread?.worktreePath
    ? undefined
    : activeProject?.repositoryIdentity?.rootPath;
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(activeThread?.environmentId ?? null),
  );
  const onFileContextMenu = useFileContextMenuHandler(activeThread?.environmentId ?? null);
  const primaryCommitList = useEnvironmentQuery(
    activeThread && activeCwd
      ? reviewEnvironment.commitList({
          environmentId: activeThread.environmentId,
          input: { cwd: activeCwd, limit: 50 },
        })
      : null,
  );
  const shouldRetryCommitListAtEnvironmentCwd =
    primaryCommitList.error?.includes("configured workspace root") === true &&
    serverConfig?.cwd !== undefined &&
    serverConfig.cwd !== activeCwd;
  const fallbackCommitList = useEnvironmentQuery(
    shouldRetryCommitListAtEnvironmentCwd && activeThread && serverConfig
      ? reviewEnvironment.commitList({
          environmentId: activeThread.environmentId,
          input: { cwd: serverConfig.cwd, limit: 50 },
        })
      : null,
  );
  const commitList = shouldRetryCommitListAtEnvironmentCwd ? fallbackCommitList : primaryCommitList;
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
  const selectedCommitSha = diffSelection.kind === "commit" ? diffSelection.commitSha : null;
  const isGitScopeSelected = selectedRunId === null && selectedCommitSha === null;
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
  const selectedCommit =
    selectedCommitSha === null
      ? undefined
      : commitList.data?.commits.find((commit) => commit.sha === selectedCommitSha);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByRunId[selectedTurn.runId]);
  const latestTurn = orderedTurnDiffSummaries[0];
  const selectedScopeLabel = selectedCommitSha
    ? (selectedCommit?.subject ?? `Commit ${selectedCommitSha.slice(0, 8)}`)
    : selectedRunId === null
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
  const reviewSectionId = selectedTurn
    ? `turn:${selectedTurn.runId}`
    : selectedCommitSha
      ? `commit:${selectedCommitSha}`
      : selectedGitScope;
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
  const reviewSectionTitle = selectedCommitSha
    ? (selectedCommit?.subject ?? `Commit ${selectedCommitSha.slice(0, 8)}`)
    : selectedTurn
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
    canReadFiles && isGitScopeSelected && activeThread && activeCwd
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
    isGitScopeSelected &&
    primaryBranchDiffPreview.error?.includes("configured workspace root") === true &&
    serverConfig?.cwd !== undefined &&
    serverConfig.cwd !== activeCwd;
  const fallbackBranchDiffPreview = useEnvironmentQuery(
    canReadFiles && shouldRetryBranchDiffAtEnvironmentCwd && activeThread && serverConfig
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
  const primaryCommitDiff = useEnvironmentQuery(
    selectedCommitSha && activeThread && activeCwd
      ? reviewEnvironment.commitDiff({
          environmentId: activeThread.environmentId,
          input: {
            cwd: activeCwd,
            commitSha: selectedCommitSha,
            ignoreWhitespace: diffIgnoreWhitespace,
          },
        })
      : null,
  );
  const shouldRetryCommitDiffAtEnvironmentCwd =
    primaryCommitDiff.error?.includes("configured workspace root") === true &&
    serverConfig?.cwd !== undefined &&
    serverConfig.cwd !== activeCwd;
  const fallbackCommitDiff = useEnvironmentQuery(
    shouldRetryCommitDiffAtEnvironmentCwd && selectedCommitSha && activeThread && serverConfig
      ? reviewEnvironment.commitDiff({
          environmentId: activeThread.environmentId,
          input: {
            cwd: serverConfig.cwd,
            commitSha: selectedCommitSha,
            ignoreWhitespace: diffIgnoreWhitespace,
          },
        })
      : null,
  );
  const commitDiff = shouldRetryCommitDiffAtEnvironmentCwd ? fallbackCommitDiff : primaryCommitDiff;
  const refreshBranchDiffPreview = branchDiffPreview.refresh;
  const [fileActionVersion, setFileActionVersion] = useState(0);
  const latestBranchPreview = useRef(branchDiffPreview.data);
  latestBranchPreview.current = branchDiffPreview.data;
  const refreshGitStatus = gitStatusQuery.refresh;
  useEffect(() => {
    if (isGitScopeSelected && needsDiffActionRefresh(branchDiffPreview.data, selectedGitScope)) {
      refreshBranchDiffPreview();
    }
  }, [
    branchDiffPreview.data,
    isGitScopeSelected,
    selectedGitScope,
    refreshBranchDiffPreview,
    fileActionVersion,
  ]);
  const refreshCommitDiff = commitDiff.refresh;
  const refreshCommitList = commitList.refresh;
  const refreshSelectedGitDiff = useCallback(() => {
    refreshCommitList();
    if (selectedCommitSha) {
      refreshCommitDiff();
      return;
    }
    refreshBranchDiffPreview();
  }, [refreshBranchDiffPreview, refreshCommitDiff, refreshCommitList, selectedCommitSha]);
  const canRefreshGitDiff =
    isGitRepo && selectedRunId === null && activeThread != null && activeCwd != null;
  const activeThreadRefreshKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}`
    : null;

  useEffect(() => {
    if (!canRefreshGitDiff) return;
    const refreshOnFocus = () => refreshSelectedGitDiff();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [canRefreshGitDiff, refreshSelectedGitDiff]);

  useWorkspaceMutationRefresh({
    enabled: canRefreshGitDiff,
    mutationId: workspaceMutationId,
    refresh: refreshSelectedGitDiff,
    resourceKey: `diff:${activeThreadRefreshKey ?? ""}`,
  });

  const gitSources = [
    ...(branchDiffPreview.data?.sources ?? []),
    ...(branchDiffPreview.data?.localSources ?? []),
  ];
  const supportsLocalGitSources =
    serverConfig?.environment.capabilities.localReviewSources === true;
  const selectedGitSource = selectedCommitSha
    ? commitDiff.data?.source
    : gitSources.find(
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
  const currentLoadDiffFiles = useMemo<FileDiffContentsLoader | undefined>(() => {
    const preview = selectedCommitSha ? commitDiff.data : branchDiffPreview.data;
    if (selectedTurn || !activeThread || !preview || !selectedGitSource) {
      return undefined;
    }

    if (!canReadFiles) return undefined;
    return createGitDiffFileContentsLoader(getDiffFileContents, {
      environmentId: activeThread.environmentId,
      cwd: preview.cwd,
      sourceKind: selectedGitSource.kind,
      baseRef: selectedGitSource.baseRef,
      headRef: selectedGitSource.headRef,
      cacheKey: selectedGitSource.diffHash,
    });
  }, [
    activeThread,
    branchDiffPreview.data,
    commitDiff.data,
    getDiffFileContents,
    selectedCommitSha,
    selectedGitSource,
    selectedTurn,
    canReadFiles,
  ]);
  const loadDiffFilesRef = useRef(currentLoadDiffFiles);
  loadDiffFilesRef.current = currentLoadDiffFiles;
  const loadDiffFiles = useCallback<FileDiffContentsLoader>(async (fileDiff) => {
    const loader = loadDiffFilesRef.current;
    if (!loader) throw new Error("Diff file contents are unavailable for this selection.");
    return loader(fileDiff);
  }, []);
  const localBranchRefs = useEnvironmentQuery(
    isGitScopeSelected &&
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
    isGitScopeSelected &&
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
    : selectedCommitSha
      ? commitDiff.isPending
      : branchDiffPreview.isPending;
  const selectedPatchError = selectedTurn
    ? activeCheckpointDiff.error
    : selectedCommitSha
      ? commitDiff.error
      : branchDiffPreview.error;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const lazySource =
    !selectedTurn &&
    selectedGitSource?.truncated &&
    (selectedGitSource.kind === "working-tree" || selectedGitSource.kind === "branch-range") &&
    selectedGitSource.files
      ? selectedGitSource
      : null;
  const renderablePatch = useMemo(
    () =>
      lazySource
        ? null
        : getRenderablePatch(selectedPatch, `diff-panel:${diffThemeName}`, {
            compactPartialHunkOffsets: selectedRunId === null,
          }),
    [lazySource, diffThemeName, selectedPatch, selectedRunId],
  );
  const fileStats = useMemo(
    () => new Map(lazySource?.files?.map((file) => [file.path, file])),
    [lazySource?.files],
  );
  const {
    scope: filePatchScope,
    isPending: areFilePatchesPending,
    requestFile,
    readyFilePaths,
    renderableFiles: loadedRenderableFiles,
    settledFileCount,
    loadNextFiles,
  } = useReviewFilePatches({
    environmentId: activeThread?.environmentId,
    cwd: branchDiffPreview.data?.cwd,
    source: lazySource,
    baseRef: lazySource?.baseRef ?? selectedBaseRef,
    ignoreWhitespace: diffIgnoreWhitespace,
    theme: resolvedTheme,
    revision: branchDiffPreview.data
      ? DateTime.formatIso(branchDiffPreview.data.generatedAt)
      : undefined,
    preview: renderablePatch,
  });
  const renderableFiles = useMemo(() => {
    const completed =
      selectedRunId === null && selectedCommitSha === null
        ? getCompletedDiffFiles(branchDiffPreview.data, selectedGitScope)
        : undefined;
    return loadedRenderableFiles.filter((file) => !completed?.has(resolveFileDiffPath(file)));
  }, [
    loadedRenderableFiles,
    selectedRunId,
    selectedCommitSha,
    branchDiffPreview.data,
    selectedGitScope,
    fileActionVersion,
  ]);
  const isRefreshingDiff = isLoadingSelectedPatch || areFilePatchesPending;
  const renderableFileEntries = useMemo(
    () => renderableFiles.map(getCachedFileEntry),
    [renderableFiles],
  );
  const renderLoadingBoundary = useCallback(
    () =>
      settledFileCount < renderableFiles.length ? (
        <DiffFileLoadingBoundary
          load={loadNextFiles}
          count={renderableFiles.length - settledFileCount}
        />
      ) : null,
    [settledFileCount, renderableFiles.length, loadNextFiles],
  );
  const codeViewFiles = useMemo(
    () =>
      renderableFileEntries
        .filter(({ fileDiff }) => !lazySource || readyFilePaths.has(resolveFileDiffPath(fileDiff)))
        .map(({ fileDiff, fileKey, fileVersion, uiStateKey }) => {
          return {
            fileDiff,
            filePath: resolveFileDiffPath(fileDiff),
            fileKey,
            fileVersion,
            collapsed: !expandedDiffFileKeys.has(uiStateKey),
          };
        }),
    [expandedDiffFileKeys, renderableFileEntries, lazySource, readyFilePaths],
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
  const diffLineStat = useMemo(
    () =>
      lazySource?.files
        ? lazySource.files.reduce(
            (total, file) => ({
              additions: total.additions + file.additions,
              deletions: total.deletions + file.deletions,
            }),
            { additions: 0, deletions: 0 },
          )
        : getDiffLineStat(renderableFiles),
    [lazySource, renderableFiles],
  );
  const selectedDiffFileKey = selectedFilePath
    ? (codeViewFiles.find((candidate) => candidate.filePath === selectedFilePath)?.fileKey ?? null)
    : null;

  useEffect(() => {
    if (!collapseScopeKey || diffFileUiStateKeys.length === 0) return;
    useDiffPanelStore
      .getState()
      .reconcileDiffFileUiState(
        collapseScopeKey,
        diffFileUiStateKeys,
        !lazySource || renderableFiles.every((file) => !file.cacheKey?.endsWith(":pending")),
      );
  }, [collapseScopeKey, diffFileUiStateKeys, lazySource, renderableFiles]);

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

  const externalRevealRef = useRef<{ cache: string; key: string } | null>(null);
  useEffect(() => {
    if (!lazySource || !selectedFilePath) return;
    const key = `${selectedFilePath}:${selectedFileRevealRequestId}`;
    if (
      externalRevealRef.current?.cache === filePatchScope &&
      externalRevealRef.current.key === key
    )
      return;
    externalRevealRef.current = { cache: filePatchScope, key };
    const index = renderableFileEntries.findIndex(
      (entry) => resolveFileDiffPath(entry.fileDiff) === selectedFilePath,
    );
    if (index >= 0) requestFile(index);
  }, [
    lazySource,
    selectedFilePath,
    selectedFileRevealRequestId,
    filePatchScope,
    renderableFileEntries,
    requestFile,
  ]);

  const openDiffFile = useCallback(
    (filePath: string) => {
      openDiffFilePrimaryAction({
        threadRef: routeThreadRef,
        filePath,
        activeCwd,
        repositoryRoot: activeRepositoryRoot,
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
    [activeCwd, activeRepositoryRoot, openInPreferredEditor, routeThreadRef],
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
      recordCompletedDiffFileAction(branchDiffPreview.data, action, filePath, previousFilePath);
      setFileActionVersion((version) => version + 1);
      refreshGitStatus();
      if (latestBranchPreview.current !== branchDiffPreview.data) refreshBranchDiffPreview();
    },
    [
      activeThread,
      branchDiffPreview.data,
      pendingFileActionKey,
      refreshBranchDiffPreview,
      runDiffFileAction,
      refreshGitStatus,
    ],
  );

  const selectTurn = (runId: RunId) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectTurn(routeThreadRef, runId);
  };
  const selectCommit = (commitSha: string) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectCommit(routeThreadRef, commitSha);
  };
  const selectGitScope = (scope: "branch" | "working-tree" | "unstaged" | "staged") => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectGitScope(routeThreadRef, scope);
  };
  const selectBranchBaseRef = (baseRef: string | null) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectBranchBaseRef(routeThreadRef, baseRef);
  };
  // The scope menu has two radio groups: the top-level one treats the latest
  // turn as "latest", while the turn sub-menu keys every turn by id so the
  // latest turn is also marked there.
  const selectedTurnValue = selectedTurn ? `turn:${selectedTurn.runId}` : "";
  const selectScopeValue = (value: string) => {
    if (value === "unstaged" || value === "branch") {
      selectGitScope(value);
    } else if (value === "latest") {
      if (latestTurn) selectTurn(latestTurn.runId);
    } else {
      const turn = orderedTurnDiffSummaries.find((summary) => `turn:${summary.runId}` === value);
      if (turn) selectTurn(turn.runId);
    }
  };

  const headerRow = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3 [-webkit-app-region:no-drag]">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="xs" variant="secondary" />}
            className="max-w-full"
            aria-label={`Diff scope: ${selectedScopeLabel}`}
          >
            <span className="truncate">{selectedScopeLabel}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuItem onClick={() => selectGitScope("working-tree")}>
              <span>Working tree</span>
              {isGitScopeSelected && selectedGitScope === "working-tree" && (
                <CheckIcon className="ml-auto" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!supportsLocalGitSources}
              title={
                supportsLocalGitSources ? undefined : "Unstaged diffs require an updated server."
              }
              onClick={() => selectGitScope("unstaged")}
            >
              <span>Unstaged</span>
              {isGitScopeSelected && selectedGitScope === "unstaged" && (
                <CheckIcon className="ml-auto" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!supportsLocalGitSources}
              title={
                supportsLocalGitSources ? undefined : "Staged diffs require an updated server."
              }
              onClick={() => selectGitScope("staged")}
            >
              <span>Staged</span>
              {isGitScopeSelected && selectedGitScope === "staged" && (
                <CheckIcon className="ml-auto" />
              )}
            </DropdownMenuItem>
            <DropdownMenuSub
              onOpenChange={(open) => {
                if (open) refreshCommitList();
              }}
            >
              <DropdownMenuSubTrigger>Committed</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-96 max-w-[calc(100vw-1rem)] overflow-y-auto">
                {commitList.isPending && !commitList.data ? (
                  <DropdownMenuItem disabled>Loading commits...</DropdownMenuItem>
                ) : commitList.error && !commitList.data ? (
                  <DropdownMenuItem disabled>Could not load commits.</DropdownMenuItem>
                ) : commitList.data?.commits.length === 0 ? (
                  <DropdownMenuItem disabled>No commits yet.</DropdownMenuItem>
                ) : (
                  commitList.data?.commits.map((commit) => (
                    <DropdownMenuItem
                      key={commit.sha}
                      title={`${commit.subject} (${commit.sha})`}
                      onClick={() => selectCommit(commit.sha)}
                    >
                      <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
                      <span className="ml-3 shrink-0 text-xs tabular-nums text-muted-foreground">
                        {formatRelativeTimeLabel(commit.committedAt)}
                      </span>
                      {commit.sha === selectedCommitSha && <CheckIcon className="ml-1 shrink-0" />}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onClick={() => selectGitScope("branch")}>
              <span>Branch changes</span>
              {isGitScopeSelected && selectedGitScope === "branch" && (
                <CheckIcon className="ml-auto" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
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
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={selectedTurnValue} onValueChange={selectScopeValue}>
                  {orderedTurnDiffSummaries.map((summary) => {
                    const turnCount =
                      summary.checkpointTurnCount ??
                      inferredCheckpointTurnCountByRunId[summary.runId] ??
                      "?";
                    return (
                      <DropdownMenuRadioItem
                        key={summary.runId}
                        value={`turn:${summary.runId}`}
                        closeOnClick
                      >
                        <span className="flex items-center gap-2">
                          <span>Turn {turnCount}</span>
                          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                            {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                          </span>
                        </span>
                      </DropdownMenuRadioItem>
                    );
                  })}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        {isGitScopeSelected && selectedGitScope === "branch" && selectedGitSource?.baseRef && (
          <div
            className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
            aria-label={`Comparing ${selectedGitSource.headRef ?? "HEAD"} against ${selectedGitSource.baseRef}`}
          >
            <Tooltip>
              <TooltipTrigger render={<span className="flex min-w-0 items-center gap-2" />}>
                <span className="min-w-0 max-w-48 truncate">
                  {selectedGitSource.headRef ?? "HEAD"}
                </span>
                <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {`${selectedGitSource.headRef ?? "HEAD"} Ã¢â€ â€™ ${selectedGitSource.baseRef}`}
              </TooltipPopup>
            </Tooltip>
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
                render={<Button variant="ghost-muted" size="xs" />}
                className="min-w-0 max-w-48"
                aria-label={`Change comparison target. Currently ${selectedGitSource.baseRef}`}
              >
                <span className="min-w-0 truncate">{selectedGitSource.baseRef}</span>
                <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
              </ComboboxTrigger>
              <ComboboxPopup
                align="start"
                className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden"
              >
                <ComboboxSearchInput
                  placeholder="Search refs..."
                  value={baseRefQuery}
                  onChange={(event) => setBaseRefQuery(event.target.value)}
                />
                <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
                  <span aria-hidden="true" />
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
                    <span>Branch</span>
                    <span className="text-right">Remote</span>
                  </div>
                </div>
                <ComboboxEmpty>No matching refs.</ComboboxEmpty>
                <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
                  <ComboboxItem
                    className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
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
                        className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
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
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span className="flex justify-end text-muted-foreground">
                                    <CheckIcon
                                      role="img"
                                      aria-label="Remote only"
                                      className="size-3"
                                    />
                                  </span>
                                }
                              />
                              <TooltipPopup side="top">Remote only</TooltipPopup>
                            </Tooltip>
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
        {codeViewFiles.length > 0 || (!selectedTurn && lazySource?.files?.length) ? (
          <DiffStatLabel
            additions={diffLineStat.additions}
            deletions={diffLineStat.deletions}
            className="mr-1 text-2xs"
            layout="inline"
          />
        ) : null}
        {canRefreshGitDiff && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={isRefreshingDiff ? "Refreshing diff" : "Refresh diff"}
                  onClick={refreshSelectedGitDiff}
                />
              }
            >
              <RefreshIcon size="sm" refreshing={isRefreshingDiff} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {isRefreshingDiff ? "Refreshing diffÃ¢â‚¬Â¦" : "Refresh diff"}
            </TooltipPopup>
          </Tooltip>
        )}
        {diffFileUiStateKeys.length > 0 && (
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
              <MorphIcon
                className="size-3.5"
                icon={allDiffFilesCollapsed ? ChevronsUpDown : ChevronsDownUp}
              />
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
                onClick={() =>
                  updateSettings({ diffLayout: diffRenderMode === "split" ? "stacked" : "split" })
                }
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
      ) : selectedRunId === null && !canReadFiles ? (
        fileAccess.isPending ? (
          <DiffPanelLoadingState label="Checking file access..." />
        ) : (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            {fileAccess.error ?? "This connection cannot read local diffs."}
          </div>
        )
      ) : (
        <>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
            {isSelectedPatchTruncated && !lazySource && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
                This preview exceeds the size limit. Changes shown are incomplete.
              </p>
            )}
            {selectedPatchError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-2xs text-error/80">{selectedPatchError}</p>
              </div>
            )}
            {(!renderablePatch && !lazySource) || hasNoNetChanges ? (
              isLoadingSelectedPatch ? (
                <DiffPanelLoadingState
                  label={
                    selectedCommitSha
                      ? "Loading commit diff..."
                      : selectedTurn
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
            ) : lazySource || renderablePatch?.kind === "files" ? (
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
                  onContextMenuCapture={(event) => {
                    const composedPath = event.nativeEvent.composedPath?.() ?? [];
                    const title = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-title"),
                    );
                    const filePath = title?.textContent?.trim();
                    if (!filePath) return;
                    event.preventDefault();
                    onFileContextMenu(
                      {
                        environmentId: activeThread?.environmentId ?? null,
                        filePath,
                        workspaceRoot: activeCwd,
                        repositoryRoot: activeRepositoryRoot,
                      },
                      event,
                    );
                  }}
                >
                  <AnnotatableCodeView
                    key={collapseScopeKey ?? reviewSectionId}
                    viewerRef={codeViewRef}
                    codeViewKey={codeViewMountKey}
                    className="h-full min-h-0 overflow-auto"
                    files={codeViewFiles}
                    renderCodeViewFooter={renderLoadingBoundary}
                    sectionId={reviewSectionId}
                    sectionTitle={reviewSectionTitle}
                    composerDraftTarget={composerDraftTarget}
                    unsafeCSSExtra={DIFF_PANEL_HEADER_UNSAFE_CSS}
                    renderHeaderPrefix={(fileDiff, fileKey, collapsed) => {
                      const filePath = resolveFileDiffPath(fileDiff);
                      const uiStateKey = uiStateKeyByRenderKey.get(fileKey);
                      if (!uiStateKey) return null;
                      const fileStatus = {
                        new: {
                          letter: "U",
                          label: "New file",
                          color: "text-emerald-600 dark:text-emerald-400",
                        },
                        deleted: {
                          letter: "D",
                          label: "Deleted",
                          color: "text-red-600 dark:text-red-400",
                        },
                        change: {
                          letter: "M",
                          label: "Modified",
                          color: "text-amber-600 dark:text-amber-400",
                        },
                        "rename-pure": {
                          letter: "R",
                          label: "Renamed",
                          color: "text-emerald-600 dark:text-emerald-400",
                        },
                        "rename-changed": {
                          letter: "R",
                          label: "Renamed and modified",
                          color: "text-emerald-600 dark:text-emerald-400",
                        },
                      }[fileDiff.type];
                      return (
                        <div className="flex items-center gap-1">
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  className="-ms-0.5 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-hidden"
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
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span
                                  className={cn(
                                    "me-1 shrink-0 font-mono text-xs font-medium",
                                    fileStatus.color,
                                  )}
                                  aria-label={fileStatus.label}
                                />
                              }
                            >
                              {fileStatus.letter}
                            </TooltipTrigger>
                            <TooltipPopup side="top">{fileStatus.label}</TooltipPopup>
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
                      const stat = fileStats.get(filePath) ?? getDiffLineStat([fileDiff]);
                      const previousFilePath = resolveFileDiffPreviousPath(fileDiff);
                      const fileActions = supportsLocalGitSources
                        ? resolveDiffFileActions({
                            scope: selectedGitScope,
                            changeType: fileDiff.type,
                            isCheckpoint: selectedRunId !== null,
                          })
                        : [];
                      return (
                        <div className="flex items-center gap-1">
                          <DiffStatLabel
                            additions={stat.additions}
                            deletions={stat.deletions}
                            layout="inline"
                          />
                          <div className="flex items-center gap-1 opacity-(--diff-file-action-opacity,1) transition-opacity duration-100 [pointer-events:var(--diff-file-action-pointer-events,auto)]">
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
                          </div>
                        </div>
                      );
                    }}
                    renderHeaderMetadata={(fileDiff, fileKey) => {
                      const uiStateKey = uiStateKeyByRenderKey.get(fileKey);
                      if (!uiStateKey) return null;
                      const filePath = resolveFileDiffPath(fileDiff);
                      const viewed = viewedDiffFileKeys.has(uiStateKey);
                      const canToggleViewed =
                        selectedRunId !== null ||
                        (selectedGitScope !== "staged" && selectedGitScope !== "unstaged");
                      return (
                        <div className="flex shrink-0 items-center gap-1 pr-2">
                          {canToggleViewed && (
                            <button
                              type="button"
                              className={cn(
                                "relative ml-1 inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent p-0 text-2xs text-muted-foreground transition-[color,opacity] duration-100 after:absolute after:-inset-x-1.5 after:-inset-y-1 after:content-[''] hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                                !viewed &&
                                  "opacity-(--diff-mark-as-viewed-opacity) [pointer-events:var(--diff-mark-as-viewed-pointer-events)]",
                              )}
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
                              <span>{viewed ? "Marked as viewed" : "Mark as viewed"}</span>
                            </button>
                          )}
                        </div>
                      );
                    }}
                    options={{
                      diffStyle: diffRenderMode === "split" ? "split" : "unified",
                      lineDiffType: "none",
                      overflow: wordWrap ? "wrap" : "scroll",
                      theme: diffThemeName,
                      preferredHighlighter: PREFERRED_HIGHLIGHTER,
                      themeType: resolvedTheme as DiffThemeType,
                      stickyHeaders: true,
                      ...(currentLoadDiffFiles ? { loadDiffFiles } : {}),
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
                  <p className="text-2xs text-muted-foreground/75">
                    {renderablePatch?.kind === "raw" ? renderablePatch.reason : null}
                  </p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-2xs leading-relaxed text-muted-foreground/90",
                      wordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch?.kind === "raw" ? renderablePatch.text : null}
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
