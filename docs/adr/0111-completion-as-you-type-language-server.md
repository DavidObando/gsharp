# ADR-0111: Completion-as-you-type triggering policy

- **Status**: Proposed
- **Date**: 2026-06-21
- **Phase**: Language-server developer experience
- **Related**: issue #917; ADR-0105/0106/0107 (language-server behavior); `src/LanguageServer/Server/ServerCapabilitiesFactory.cs`, `src/LanguageServer/HoverComputer.cs` (`CompletionComputer`), `src/vscode-gsharp/package.json`

## Context

G# completion lists historically surfaced only in a narrow set of contexts — most
visibly after typing a member-access dot (`.`), which is the single completion
trigger character the server advertises. Comparable tooling (Pylance for Python,
the C# Dev Kit) instead shows completions continuously as the developer types
identifiers, member names, and keywords. Issue #917 asks us to expand automatic
triggering so the list appears while typing ordinary code — without spamming
irrelevant popups.

Two mechanisms drive when an editor asks a language server for completions:

1. **Trigger characters** advertised in `CompletionOptions.triggerCharacters`. The
   editor invokes the server when one of these characters is typed
   (`CompletionTriggerKind.TriggerCharacter`).
2. **Implicit ("24x7") IntelliSense**, controlled entirely on the editor side by
   `editor.quickSuggestions`. When enabled, the editor invokes *every* registered
   completion provider as identifier characters are typed
   (`CompletionTriggerKind.Invoke`) and filters the returned list against the word
   under the caret.

A naïve way to "trigger on every letter" would be to list the whole alphabet as
server trigger characters. Pylance and Roslyn deliberately do **not** do this: it
produces redundant requests, fights the editor's own filtering, and couples the
server to one client's keystroke model. The idiomatic approach is to leave trigger
characters minimal and rely on `editor.quickSuggestions` for as-you-type behavior,
while ensuring the server returns a correctly *ranged* candidate list when invoked
implicitly mid-identifier (so the editor replaces the typed prefix instead of
inserting alongside it).

## Decision

Completion-as-you-type is enabled through the **editor's implicit IntelliSense**,
not through an expanded server trigger-character set:

1. **Client (`src/vscode-gsharp/package.json`).** Contribute
   `configurationDefaults` for the `[gsharp]` language scope that turns implicit
   suggestions on by default and keeps them relevant:

   ```jsonc
   "[gsharp]": {
     "editor.quickSuggestions": { "other": "on", "comments": "off", "strings": "off" },
     "editor.suggestOnTriggerCharacters": true,
     "editor.quickSuggestionsDelay": 10,
     "editor.wordBasedSuggestions": "off"
   }
   ```

   Quick suggestions fire for code (not comments/strings), trigger characters still
   work, and word-based suggestions are disabled so the LSP list is not duplicated
   by raw editor-buffer words. These are *defaults*: users can still override any of
   them.

2. **Server trigger characters remain minimal.** `CompletionOptions.TriggerCharacters`
   stays `["."]` for member access. The alphabet is intentionally **not** added.

3. **Server completion handler is hardened for mid-identifier invocation.**
   `CompletionComputer.ComputeCompletions` now computes the span of the partial
   identifier immediately preceding the caret and attaches it as an explicit
   `textEdit` replacement range (with `newText` = the candidate label) to every
   plain candidate — global keywords/symbols/types as well as member-access
   results. Snippet items that carry their own `insertText` are left untouched, and
   when there is no identifier prefix at the caret (e.g. right after `.`) no range is
   attached so the editor applies its own word-range heuristics.

## Consequences

- **Positive.** Typing an identifier, keyword, or partial member name now surfaces a
  filtered completion list by default, matching the Pylance / C# Dev Kit DX. The
  explicit replacement range makes the editor replace the typed prefix cleanly
  rather than producing doubled text. Member completion after `.`, hover, and
  signature help are unaffected because trigger characters and their handlers are
  unchanged.
- **Neutral.** The behavior is a default, fully overridable per user or workspace via
  standard `editor.*` settings. The existing (currently unwired) `gsharp.completion.triggerOnDot`
  setting is left in place.
- **Negative / bounded.** Relying on the editor's `quickSuggestions` means a client
  that does not honor `configurationDefaults` (a non-VS Code LSP client) will not get
  as-you-type behavior automatically; such clients must enable implicit completion
  themselves. This is acceptable: the server still answers `Invoke`-kind requests
  correctly, so any client that asks gets a properly ranged list.

## Alternatives considered

- **Advertise every identifier character as a server trigger character.** Rejected:
  redundant requests on every keystroke, fights the editor's filtering, couples the
  server to a specific keystroke model, and is not what mature servers (Pylance,
  Roslyn) do.
- **Add `(`, space, etc. as trigger characters.** Rejected as noisy and overlapping
  with signature help (`(`, `,`); implicit IntelliSense already covers these
  positions without extra popups.
- **Server-side prefix filtering** (returning only candidates matching the typed
  prefix). Rejected: the editor already filters/sorts against the word under the
  caret, and server-side filtering would break incremental typing and fuzzy matching.
