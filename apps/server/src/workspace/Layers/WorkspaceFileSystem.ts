import { promises as fsPromises } from "node:fs";
import { Effect, FileSystem, Layer, Path } from "effect";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const PROJECT_EDITOR_MAX_DIRECTORY_ENTRIES = 500;
const PROJECT_EDITOR_MAX_FILE_BYTES = 512 * 1024;
const PROJECT_EDITOR_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const resolveDirectoryTarget = Effect.fn("WorkspaceFileSystem.resolveDirectoryTarget")(function* (
    cwd: string,
    relativePath: string,
  ) {
    const normalizedRelativePath = relativePath.trim();
    if (normalizedRelativePath === "." || normalizedRelativePath === "./") {
      return {
        absolutePath: path.resolve(cwd),
        relativePath: ".",
      };
    }
    return yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: path.resolve(cwd),
      relativePath: normalizedRelativePath,
    });
  });

  const listDirectory: WorkspaceFileSystemShape["listDirectory"] = Effect.fn(
    "WorkspaceFileSystem.listDirectory",
  )(function* (input) {
    const target = yield* resolveDirectoryTarget(input.cwd, input.relativePath);
    const dirents = yield* Effect.tryPromise({
      try: () => fsPromises.readdir(target.absolutePath, { withFileTypes: true }),
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.listDirectory",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

    const visibleEntries = dirents
      .filter((dirent) => {
        if (!dirent.isDirectory() && !dirent.isFile()) return false;
        return !(dirent.isDirectory() && PROJECT_EDITOR_IGNORED_DIRECTORIES.has(dirent.name));
      })
      .toSorted((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });
    const limitedEntries = visibleEntries.slice(0, PROJECT_EDITOR_MAX_DIRECTORY_ENTRIES);

    return {
      relativePath: target.relativePath,
      entries: limitedEntries.map((dirent) => ({
        name: dirent.name,
        path: toPosixRelativePath(
          target.relativePath === "." ? dirent.name : path.join(target.relativePath, dirent.name),
        ),
        kind: dirent.isDirectory() ? ("directory" as const) : ("file" as const),
      })),
      truncated: visibleEntries.length > limitedEntries.length,
    };
  });

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
      const stat = yield* Effect.tryPromise({
        try: () => fsPromises.stat(target.absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.readFile.stat",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      if (!stat.isFile()) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: "Workspace path is not a file.",
        });
      }
      if (stat.size > PROJECT_EDITOR_MAX_FILE_BYTES) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: `File is too large to open in the built-in editor (${stat.size} bytes).`,
        });
      }

      const buffer = yield* Effect.tryPromise({
        try: () => fsPromises.readFile(target.absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.readFile",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      if (isBinaryBuffer(buffer)) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: "Binary files cannot be opened in the built-in editor.",
        });
      }

      return {
        relativePath: target.relativePath,
        contents: buffer.toString("utf8"),
        sizeBytes: buffer.byteLength,
      };
    },
  );

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });
  return { listDirectory, readFile, writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
