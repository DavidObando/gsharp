# Plan: a modern TUI REPL to replace `Interpreter.csproj`

## 1. Goal

Replace the current console REPL (`src/Interpreter`) with a brand-new, full-screen,
IDE-like TUI for G#. The new REPL adopts the **AppShell** chrome model and widget stack
proven in `..\Oahu\src\Oahu.Cli.Tui` (Spectre.Console), borrows the keyboard-first,
calm-color UI language of **OpenCode**, and reuses G#'s existing `LanguageServer`
analysis (completions, hover, diagnostics, semantic tokens, formatting) so the prompt
behaves like a real editor rather than a line reader.

---

## 2. What we have today

### Current REPL (`src/Interpreter`)
- **`Program.cs`** — entry point; runs file mode (`.gs` path) or `repl.Run()`; `--log` flag.
- **`Repl.cs`** — generic line/multiline editor over the *primary* console buffer; manual
  cursor math (`SubmissionView`), history via PageUp/Down, `#`-prefixed meta-commands,
  `IsCompleteSubmission` for continuation.
- **`GSharpRepl.cs`** — G# specialization: per-token coloring in `RenderLine`, incremental
  state via `Compilation.ContinueWith`, `#showTree/#showProgram/#cls/#reset`.

Limits: no alt-screen, single-prompt-at-cursor model, no completion/hover, no resize
handling, no panes, ad-hoc `ConsoleColor`, no themes/accessibility.

### Reusable engine
- **`Core` `Compilation`**: `ContinueWith`, `Evaluate(variables)`, diagnostics with
  severity, tree/IL dumps — keep as the eval core.
- **`LanguageServer`**: `HoverComputer`, completion (`TypeClauseCompletions`),
  `SemanticTokensHandler`, `FormattingEngine`, `CodeActionComputer`, diagnostics. These
  are in-process libraries we can call directly (no LSP socket) for IDE features.

### Oahu TUI patterns to copy (Spectre.Console, net10.0)
- `Shell/AppShell.cs` — header + tab strip + body + pinned hint bar, modal overlay, logs
  overlay, progressive Ctrl+C, two-tier render loop, `IKeyReader` (testable input).
- `Shell/AltScreen.cs` — alt-screen, synchronized update (DEC 2026), erase-to-EOL.
- `Themes/Theme.cs` + `Tokens/Tokens.cs` + `Tokens/SemanticColor.cs` — semantic palette
  (Default/Mono/HighContrast/Colorblind), `NO_COLOR`/screen-reader → Mono.
- Widgets: `HintBar`, `TabStrip`, `StatusLine`, `Pager`, `SortableTable`, `PulseSpinner`,
  `Dialog`, `TextInput`, `SelectList`, `TimelineItem`, `ITabScreen`, modal/broker.

---

## 3. UX direction (OpenCode-influenced)

- Calm by default: static chrome, one animated element (status verb), color reserved for
  diagnostics/run state — same restraint as Oahu's tokens.
- Keyboard-first: `1-6` tabs, `:` command palette, `/` search, `?` help, progressive Ctrl+C.
- A **session is a transcript**: each submission becomes a collapsible "cell" (input +
  result/diagnostics), OpenCode-style, scrolled in the body with a Pager.
- IDE editor pane: gutter line numbers, live syntax tokens, inline diagnostics squiggles,
  ghost completions, hover on demand.

---

## 4. Target chrome (mockup, 120×32)

```
╭─ gsharp ─────────────────────────────── session · 12 cells · idle ─ v1.0 ─╮
│  1 REPL   2 History   3 Variables   4 Diagnostics   5 Help   6 Settings   │
├───────────────────────────────────────────────────────────────────────────┤
│  [1] » let xs = [1,2,3].Select(x => x*2)                                  │
│       = [2, 4, 6]                                                         │
│                                                                           │
│  [2] » func fib(n int) int { n < 2 ? n : fib(n-1)+fib(n-2) }              │
│       ✓ defined fib(int) int                                              │
│                                                                           │
│  [3] » fib(10                                                             │
│   1 │ fib(10|                                                             │
│       ╰── GS0019 expected ')'                                             │
│       ┌ completions ────────────┐                                         │
│       │ ❯ fib(n int) int        │                                         │
│       │   filter  · stdlib      │                                         │
│       └─────────────────────────┘                                         │
├───────────────────────────────────────────────────────────────────────────┤
│ ⏎ run · ⇧⏎ newline · Tab complete · K hover · : palette · L logs · ^C quit│
╰───────────────────────────────────────────────────────────────────────────╯
```

Command palette (`:`), same as Oahu §11 language:

```
╭─ : ───────────────────────────────────────────╮
│  : reset_                                      │
│    reset            clear session state        │
│    show tree        toggle parse-tree dump     │
│    show il          toggle bound/IL dump       │
│    load <file.gs>   run a file into session    │
│  ↑↓ navigate · Tab complete · Enter run · Esc  │
╰────────────────────────────────────────────────╯
```

---

## 5. Architecture

New project **`src/Repl`** (`GSharp.Repl`, exe, net10.0) replaces `Interpreter`.

```
src/Repl/
  Program.cs                 # arg parse (--log, file mode), TTY guard, alt-screen
  ReplHost.cs                # owns AppShell lifecycle (port of Oahu TuiHost)
  Engine/
    SessionEngine.cs         # wraps Compilation.ContinueWith + variables; cells
    AnalysisBridge.cs        # calls LanguageServer computers (hover/complete/tokens)
  Shell/  (port of Oahu)     # AppShell, AltScreen, IKeyReader, CtrlCState, IModal
  Themes/ Tokens/            # port verbatim
  Widgets/                   # HintBar, TabStrip, StatusLine, Pager, completions popup
  Screens/
    ReplScreen.cs            # editor pane + transcript (tab 1)
    HistoryScreen.cs  VariablesScreen.cs  DiagnosticsScreen.cs
    HelpScreen.cs     SettingsScreen.cs
```

Two-tier loop, alt-screen, themes, modals, `IKeyReader` → keep Oahu semantics so unit
tests drive a fixed key queue. `Console.ForegroundColor` highlighting is replaced by
semantic tokens.

---

## 6. Tabs / screens

1. **REPL** — editor pane (highlight, gutter, completions, hover, inline diagnostics) +
   scrollable transcript of cells.
2. **History** — past submissions; Enter re-loads into editor.
3. **Variables** — live `variables` map: name · type · value (SortableTable).
4. **Diagnostics** — full list, jump-to-cell.
5. **Help** — keybindings/`:` verbs.
6. **Settings** — theme, show-tree/IL, ascii fallback.

`:` palette gives parity verbs for everything (reset, load, show tree/il, theme).

---

## 7. IDE features via reuse
- Highlight: `SemanticTokensHandler`/`SyntaxTree.ParseTokens` → token markup.
- Completion: `TypeClauseCompletions` + symbols → popup; Tab = LCP.
- Hover (`K`): `HoverComputer` flyout. Diagnostics: live squiggles + Diagnostics tab.
- Format (`⇧⌥F`): `FormattingEngine`. Continuation: keep `IsCompleteSubmission`.

---

## 8. Phases
1. Scaffold `GSharp.Repl`, port Shell/Themes/Tokens/widgets, empty REPL tab.
2. SessionEngine: cells, run, transcript Pager, ⏎/⇧⏎.
3. Editor pane: highlight + gutter + inline diagnostics.
4. Completions + hover. 5. `:` palette + other tabs. 6. Logs/accessibility/Ctrl+C.
7. Delete `src/Interpreter`: swap sln, repoint tooling, port tests to `Repl`.

## 9. Testing/build
StyleCop-as-error (order fields/public first), net10.0; add `Spectre.Console`
PackageReference. `IKeyReader`/`StyledTable` deterministic tests like Oahu. Wholesale
eval tests can OOM — filter + capped threads. Accessibility themes ship but are not a v1
gate.

## 10. Decisions (locked)
- **Spectre.Console**: yes — added as a dependency of `GSharp.Repl`.
- **Project**: `src/Repl` (`GSharp.Repl`) is the only REPL project; `src/Interpreter`
  is deleted (sln, tooling, and `Interpreter.Tests` repointed to `Repl` in phase 7).
- **Accessibility** (Mono/HighContrast/Colorblind themes, screen-reader/`NO_COLOR`
  fallback): nice-to-have, **not required for v1** — port tokens but don't gate ship on it.

- **Meta-commands**: drop `#`-prefixed commands entirely; the `:` command palette is the
  only meta surface (`:reset`, `:show tree`, `:show il`, `:load <file.gs>`, `:theme`).

## 11. Open
None — ready to scaffold.
