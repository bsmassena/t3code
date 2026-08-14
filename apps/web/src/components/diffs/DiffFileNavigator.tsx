import type { FileDiffMetadata } from "@pierre/diffs";
import { ChevronRightIcon, FolderClosedIcon, FolderIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { buildTurnDiffTree, type TurnDiffTreeNode } from "~/lib/turnDiffTree";
import { cn } from "~/lib/utils";
import { getDiffLineStat } from "~/lib/diffRendering";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";

interface DiffFileNavigatorEntry {
  readonly fileDiff: FileDiffMetadata;
  readonly filePath: string;
  readonly fileKey: string;
}

export const DiffFileNavigator = memo(function DiffFileNavigator(props: {
  files: ReadonlyArray<DiffFileNavigatorEntry>;
  selectedFileKey: string | null;
  theme: "light" | "dark";
  onSelectFile: (fileKey: string) => void;
}) {
  const { files, onSelectFile, selectedFileKey, theme } = props;
  const [collapsedDirectories, setCollapsedDirectories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const treeNodes = useMemo(
    () =>
      buildTurnDiffTree(
        files.map(({ fileDiff, filePath }) => ({
          path: filePath,
          kind: fileDiff.type,
          ...getDiffLineStat([fileDiff]),
        })),
      ),
    [files],
  );
  const fileKeyByPath = useMemo(
    () => new Map(files.map(({ fileKey, filePath }) => [filePath, fileKey])),
    [files],
  );
  const toggleDirectory = useCallback((pathValue: string) => {
    setCollapsedDirectories((current) => {
      const next = new Set(current);
      if (next.has(pathValue)) next.delete(pathValue);
      else next.add(pathValue);
      return next;
    });
  }, []);

  const renderNode = (node: TurnDiffTreeNode, depth: number) => {
    const paddingLeft = 8 + depth * 14;
    if (node.kind === "directory") {
      const collapsed = collapsedDirectories.has(node.path);
      return (
        <div key={`directory:${node.path}`}>
          <button
            type="button"
            role="treeitem"
            aria-level={depth + 1}
            className="group flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ paddingLeft }}
            aria-expanded={!collapsed}
            onClick={() => toggleDirectory(node.path)}
          >
            <ChevronRightIcon
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                !collapsed && "rotate-90",
              )}
            />
            {collapsed ? (
              <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>
          </button>
          {!collapsed && (
            <div className="relative" role="group">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 w-px bg-border/60"
                data-diff-tree-guide=""
                style={{ left: paddingLeft + 7 }}
              />
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    const fileKey = fileKeyByPath.get(node.path);
    if (!fileKey) return null;
    return (
      <button
        key={`file:${node.path}`}
        type="button"
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={selectedFileKey === fileKey}
        className={cn(
          "group flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selectedFileKey === fileKey && "bg-accent text-accent-foreground",
        )}
        style={{ paddingLeft: paddingLeft + 19 }}
        title={node.path}
        onClick={() => onSelectFile(fileKey)}
      >
        <PierreEntryIcon pathValue={node.path} kind="file" theme={theme} className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {node.stat ? (
          <DiffStatLabel
            additions={node.stat.additions}
            deletions={node.stat.deletions}
            layout="inline"
            className="shrink-0 text-[10px]"
          />
        ) : null}
      </button>
    );
  };

  return (
    <aside className="flex min-h-0 w-64 shrink-0 flex-col border-l border-border bg-background">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3 text-xs font-medium">
        <span>Files</span>
        <span className="text-muted-foreground tabular-nums">{files.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1.5" role="tree" aria-label="Diff files">
        {treeNodes.map((node) => renderNode(node, 0))}
      </div>
    </aside>
  );
});
