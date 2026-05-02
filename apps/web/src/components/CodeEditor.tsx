import { css } from "@codemirror/lang-css";
import { cpp } from "@codemirror/lang-cpp";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { tags } from "@lezer/highlight";
import { basicSetup, EditorView } from "codemirror";
import { useEffect, useMemo, useRef } from "react";

import { cn } from "~/lib/utils";

type CodeEditorProps = {
  path: string;
  value: string;
  disabled?: boolean;
  className?: string;
  onChange: (value: string) => void;
};

const cppExtensions = new Set(["c", "h", "cc", "cpp", "cxx", "hpp", "hxx", "hh"]);
const typeScriptExtensions = new Set(["ts", "mts", "cts"]);
const javaScriptExtensions = new Set(["js", "mjs", "cjs"]);
const pythonExtensions = new Set(["py", "pyw"]);
const phpExtensions = new Set(["php", "phtml"]);
const xmlExtensions = new Set(["xml", "svg", "xhtml", "rss", "atom"]);

const languageByExtension: Record<string, string> = {
  css: "css",
  go: "go",
  html: "html",
  htm: "html",
  java: "java",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  mdx: "markdown",
  rb: "ruby",
  rs: "rust",
  sql: "sql",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
};

const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
    fontSize: "13px",
    lineHeight: "20px",
  },
  ".cm-content": {
    caretColor: "var(--foreground)",
    padding: "12px 0 12px 8px",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--foreground)",
  },
  ".cm-line": {
    color: "var(--foreground)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--background)",
    borderRight: "1px solid var(--border)",
    color: "var(--muted-foreground)",
    zIndex: "1",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "2.75rem",
    padding: "0 12px 0 8px",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--muted)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--muted)",
    color: "var(--foreground)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
    {
      backgroundColor: "color-mix(in srgb, var(--primary) 38%, transparent) !important",
    },
  ".cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--primary) 38%, transparent) !important",
  },
  "&.cm-focused": {
    outline: "none",
  },
});

const t3HighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#c678dd" },
  {
    tag: [tags.name, tags.deleted, tags.character, tags.propertyName],
    color: "#e06c75",
  },
  {
    tag: [tags.function(tags.variableName), tags.labelName],
    color: "#61afef",
  },
  {
    tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)],
    color: "#d19a66",
  },
  { tag: [tags.definition(tags.name), tags.separator], color: "#abb2bf" },
  {
    tag: [
      tags.className,
      tags.number,
      tags.changed,
      tags.annotation,
      tags.modifier,
      tags.self,
      tags.namespace,
    ],
    color: "#e5c07b",
  },
  { tag: [tags.typeName, tags.operatorKeyword], color: "#56b6c2" },
  {
    tag: [tags.operator, tags.url, tags.escape, tags.regexp, tags.link],
    color: "#56b6c2",
  },
  { tag: [tags.meta, tags.comment], color: "#7f848e" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, textDecoration: "underline" },
  { tag: tags.heading, color: "#61afef", fontWeight: "700" },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: "#d19a66" },
  {
    tag: [tags.processingInstruction, tags.string, tags.inserted],
    color: "#98c379",
  },
  { tag: tags.invalid, color: "#ffffff", backgroundColor: "#e06c75" },
]);

function basenameOfPath(pathValue: string): string {
  const lastSlashIndex = Math.max(pathValue.lastIndexOf("/"), pathValue.lastIndexOf("\\"));
  return lastSlashIndex === -1 ? pathValue : pathValue.slice(lastSlashIndex + 1);
}

function extensionOfBasename(basename: string): string {
  const extensionSeparatorIndex = basename.lastIndexOf(".");
  return extensionSeparatorIndex === -1 ? "" : basename.slice(extensionSeparatorIndex + 1);
}

function languageNameForPath(pathValue: string): string {
  const basename = basenameOfPath(pathValue);
  const lowerBasename = basename.toLowerCase();
  const extension = extensionOfBasename(lowerBasename);

  if (lowerBasename === "dockerfile") return "dockerfile";
  if (
    lowerBasename === "gemfile" ||
    lowerBasename === "rakefile" ||
    lowerBasename.endsWith(".gemspec")
  ) {
    return "ruby";
  }
  if (lowerBasename === "makefile") return "makefile";
  if (lowerBasename === "tsconfig.json") return "json";

  if (cppExtensions.has(extension)) return "cpp";
  if (typeScriptExtensions.has(extension)) return "typescript";
  if (javaScriptExtensions.has(extension)) return "javascript";
  if (pythonExtensions.has(extension)) return "python";
  if (phpExtensions.has(extension)) return "php";
  if (xmlExtensions.has(extension)) return "xml";
  if (languageByExtension[extension]) return languageByExtension[extension];

  return extension || "text";
}

function languageExtensionForPath(pathValue: string): Extension {
  switch (languageNameForPath(pathValue)) {
    case "cpp":
      return cpp();
    case "css":
      return css();
    case "go":
      return go();
    case "html":
      return html();
    case "java":
      return java();
    case "javascript":
      return javascript();
    case "json":
      return json();
    case "jsx":
      return javascript({ jsx: true });
    case "markdown":
      return markdown();
    case "php":
      return php();
    case "python":
      return python();
    case "ruby":
      return StreamLanguage.define(ruby);
    case "rust":
      return rust();
    case "sql":
      return sql();
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "typescript":
      return javascript({ typescript: true });
    case "xml":
      return xml();
    case "yaml":
      return yaml();
    default:
      return [];
  }
}

export function CodeEditor(props: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialValueRef = useRef(props.value);
  const initialDisabledRef = useRef(props.disabled);
  const valueRef = useRef(props.value);
  const onChangeRef = useRef(props.onChange);
  const languageCompartment = useMemo(() => new Compartment(), []);
  const readOnlyCompartment = useMemo(() => new Compartment(), []);

  valueRef.current = props.value;
  onChangeRef.current = props.onChange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const nextValue = update.state.doc.toString();
      valueRef.current = nextValue;
      onChangeRef.current(nextValue);
    });

    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          basicSetup,
          editorTheme,
          syntaxHighlighting(oneDarkHighlightStyle),
          syntaxHighlighting(t3HighlightStyle),
          updateListener,
          languageCompartment.of([]),
          readOnlyCompartment.of([
            EditorState.readOnly.of(Boolean(initialDisabledRef.current)),
            EditorView.editable.of(!initialDisabledRef.current),
          ]),
        ],
      }),
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [languageCompartment, readOnlyCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || props.value === valueRef.current) return;
    valueRef.current = props.value;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: props.value,
      },
    });
  }, [props.value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure([
        EditorState.readOnly.of(Boolean(props.disabled)),
        EditorView.editable.of(!props.disabled),
      ]),
    });
  }, [props.disabled, readOnlyCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageCompartment.reconfigure(languageExtensionForPath(props.path)),
    });
  }, [languageCompartment, props.path]);

  return (
    <div ref={containerRef} className={cn("min-h-0 flex-1 overflow-hidden", props.className)} />
  );
}
