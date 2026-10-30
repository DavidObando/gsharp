// <copyright file="ProjectState.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.IO
import System.Linq
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import SystemObject = System.Object
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Security.Cryptography
import System.Text
import System.Threading

/// Represents the state of a single GSharp project, holding all source files
/// and producing a unified (cref:Compilation) from them.
open class ProjectState {
    private let compilationLock object = SystemObject()
    private let syntaxTrees ConcurrentDictionary[string, SyntaxTree] = ConcurrentDictionary[string, SyntaxTree](
        StringComparer.OrdinalIgnoreCase
    )

    private var compilation Compilation?
    // ADR-0212 §8: the lifetime token of `compilation`. The project cancels it when a successor replaces the
    // compilation, which releases every waiter on a build nobody wants.
    private var compilationLifetime CancellationTokenSource?
    private var isDirty bool = true
    private var references IReadOnlyList[string] = Array.Empty[string]()
    private var referenceSourcePath string?
    private var referenceSourceMtimeUtc DateTime = DateTime.MinValue
    private var nextReferenceDiscoveryUtc DateTime = DateTime.MinValue
    private var assemblyName string?
    private var cachedResolver ReferenceResolver?
    private var resolverReferences IReadOnlyList[string]?
    private var gsAnalyzerSourceMtimeUtc DateTime = DateTime.MinValue
    private var cachedGsAnalyzers ImmutableArray[GSharpDiagnosticAnalyzer] = ImmutableArray[
        GSharpDiagnosticAnalyzer
    ].Empty
    private var gsAnalyzerLoadDiagnostics ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic] = ImmutableArray[
        GSharp.Core.CodeAnalysis.Diagnostic
    ].Empty

    /// Initializes a new instance of the (cref:ProjectState) class.
    /// @param projectFilePath Absolute path to the `.gsproj` file.
    init(projectFilePath string) {
        ProjectFilePath = projectFilePath ?? throw ArgumentNullException("projectFilePath")
        ProjectDirectory = Path.GetDirectoryName(Path.GetFullPath(projectFilePath)) ?? string.Empty
    }

    /// Gets the absolute path to the `.gsproj` file.
    prop ProjectFilePath string {
        get;
    }

    /// Gets the directory containing the project file.
    prop ProjectDirectory string {
        get;
    }

    /// Gets or sets the project's effective `AssemblyName` — the basename
    /// (without extension) of the output DLL the SDK emits for this project.
    /// Defaults to `null` for projects constructed without discovery (e.g.
    /// the implicit project for loose files and most unit-test scaffolding);
    /// (cref:WorkspaceInitializer) populates it for every project parsed
    /// out of a `.gsproj`. Cross-project Go-to-Definition consults this
    /// via (cref:WorkspaceState.TryGetProjectByOutputAssembly). Every
    /// (cref:Compilation) this project builds carries it as
    /// (cref:Compilation.AssemblyName), so `InternalsVisibleTo` friendship is
    /// evaluated against the same consumer name `gsc` receives (ADR-0212 S6b).
    /// A null, empty, or whitespace name leaves the compilation's name unset,
    /// which grants no friendship. Changing the name rebuilds the compilation.
    prop AssemblyName string? {
        get -> assemblyName
        set {
            lock compilationLock {
                if !string.Equals(assemblyName, value, StringComparison.Ordinal) {
                    assemblyName = value
                    Invalidate()
                    // The resolver carries the consumer name for friend checks, and a successor copies its
                    // predecessor's name. So a new name retires the cached compilation (the next GetCompilation
                    // binds from scratch, even when the project has no references and so no resolver) and
                    // drops the resolver.
                    RetireCompilation_NoLock()
                    compilation = nil
                    cachedResolver = nil
                    resolverReferences = nil
                }
            }
        }
    }

    /// Gets or sets the project's effective `RootNamespace` (ADR-0142,
    /// issue #2200), parsed from the `.gsproj` by (cref:ProjectDiscovery)
    /// (falling back to (cref:AssemblyName) when undeclared, matching
    /// MSBuild). Used as the base namespace when the language server regenerates
    /// a `.resx`'s codebehind class on save.
    prop RootNamespace string?

    /// Gets or sets the project's target framework moniker (e.g. `net10.0`),
    /// parsed from the `.gsproj` by (cref:ProjectDiscovery). Surfaced to
    /// the VS Code Test Explorer so discovered tests can be grouped under a
    /// `<project> (<tfm>)` node. May be `null` or empty when the
    /// project was constructed without discovery or declares no target framework.
    prop TargetFramework string?

    /// Gets the set of source file paths currently in this project.
    prop SourceFiles IReadOnlyCollection[string] -> syntaxTrees.Keys.ToList()

    /// Gets or sets the list of referenced project file paths.
    private var _projectReferences IReadOnlyList[string] = Array.Empty[string]()

    prop ProjectReferences IReadOnlyList[string] {
        get {
            return _projectReferences
        }
        set {
            _projectReferences = value
        }
    }

    /// Gets or sets the list of assembly reference paths (NuGet packages,
    /// transitive dependencies, and the ref-assemblies of non-G# project
    /// references) that imports in this project's sources resolve against.
    /// Typically populated from the MSBuild-emitted `.rsp` file via
    /// (cref:ProjectDiscovery.DiscoverProject(string)).
    prop References IReadOnlyList[string] {
        get -> references
        set {
            let next = value ?? Array.Empty[string]()
            lock compilationLock {
                if !ReferenceListsEqual(references, next) {
                    references = next
                    Invalidate()
                    cachedResolver = nil
                    resolverReferences = nil
                }
            }
        }
    }

    /// Gets or sets the absolute path to the `.rsp` file the references
    /// were parsed from. The file's last-write time is polled on each
    /// (cref:GetCompilation) call so that a fresh build invalidates the
    /// cached (cref:ReferenceResolver) automatically.
    prop ReferenceSourcePath string? {
        get -> referenceSourcePath
        set {
            lock compilationLock {
                referenceSourcePath = value
                referenceSourceMtimeUtc = DateTime.MinValue
            }
        }
    }

    /// Adds or updates a source file in the project. When the supplied text is
    /// byte-identical to the cached tree's source, the call is a no-op and
    /// returns the existing tree; this preserves the cached
    /// (cref:Compilation) (and its lazily-bound `GlobalScope` /
    /// `BoundProgram`) across LSP requests that re-issue the same
    /// in-memory buffer (e.g. successive diagnostic / hover pulls).
    /// @param filePath Absolute path to the `.gs` file.
    /// @param text The current text content of the file.
    /// @param rawBytes Original file bytes, when loaded from disk rather than an editor buffer.
    /// @returns The parsed (cref:SyntaxTree).
    func UpdateFile(filePath string, text string, rawBytes[]?uint8 = nil) SyntaxTree {
        lock compilationLock {
            let key = NormalizePath(filePath)
            if syntaxTrees.TryGetValue(key, out var existing) &&
                existing
                .Text
                ?.FileName == filePath &&
                existing
                .Text
                .ToString() == text && (rawBytes ?? Array.Empty[uint8]()).SequenceEqual(
                existing.Text.RawBytes ?? Array.Empty[uint8]()
            ) {
                return existing
            }
            let sourceText = SourceText.From(text, filePath, rawBytes)
            let tree = SyntaxTree.Parse(sourceText)
            syntaxTrees[key] = tree
            Invalidate()
            return tree
        }
    }

    /// Adds a source file by reading it from disk.
    /// @param filePath Absolute path to the `.gs` file.
    /// @returns The parsed (cref:SyntaxTree), or null if the file could not be read.
    func AddFileFromDisk(filePath string) SyntaxTree? {
        try {
            let source = SourceText.Load(filePath)
            return UpdateFile(filePath, source.ToString(), source.RawBytes)
        } catch (IOException) {
            return nil
        } catch (UnauthorizedAccessException) {
            // An unreadable file (permissions) shouldn't abort loading the rest of the project.
            return nil
        }
    }

    /// Removes a source file from the project.
    /// @param filePath Absolute path to the `.gs` file.
    /// @returns True if the file was found and removed.
    func RemoveFile(filePath string) bool {
        if syntaxTrees.TryRemove(NormalizePath(filePath), out _) {
            Invalidate()
            return true
        }
        return false
    }

    /// Returns whether the project contains the given file.
    /// @param filePath Absolute path to check.
    /// @returns True if the file is part of this project.
    func ContainsFile(filePath string) bool {
        return syntaxTrees.ContainsKey(NormalizePath(filePath))
    }

    /// Gets the (cref:SyntaxTree) for a given file in this project.
    /// @param filePath Absolute path to the `.gs` file.
    /// @param tree The syntax tree if found.
    /// @returns True if the file exists in the project.
    func TryGetSyntaxTree(filePath string, out tree SyntaxTree?) bool {
        return syntaxTrees.TryGetValue(NormalizePath(filePath), out tree)
    }

    /// Gets the project-level (cref:Compilation) built from all source trees.
    /// The compilation is cached and only rebuilt when a file has changed.
    /// @returns The current compilation.
    func GetCompilation() Compilation {
        lock compilationLock {
            RefreshReferencesFromSourceFile_NoLock()
            if !isDirty && compilation != nil {
                return compilation!!
            }
            let trees = syntaxTrees.Values.ToArray()
            let resolver ReferenceResolver? = GetOrBuildResolver_NoLock()
            // Cancel the superseded compilation first, so the successor factory never waits for its build.
            RetireCompilation_NoLock()
            // ADR-0105 (Phase 2): when a single file changed, ask the previous compilation for its
            // successor. A body-only edit reuses the previous global scope and re-binds only the
            // edited file; any other edit binds from scratch (ADR-0212 §7a).
            let incremental Compilation? = TryBuildSuccessor_NoLock(trees, resolver)
            if incremental != nil {
                compilation = AttachLifetime_NoLock(incremental)
                isDirty = false
                return compilation!!
            }
            compilation = AttachLifetime_NoLock(
                if trees.Length == 0 {
                    NewCompilation_NoLock(resolver, true, SyntaxTree.Parse(string.Empty))
                } else {
                    NewCompilation_NoLock(resolver, true, trees)
                }
            )
            isDirty = false
            return compilation!!
        }
    }

    /// Builds a (cref:Compilation) against a caller-supplied [`snapshotTree`](paramref)
    /// for [`filePath`](paramref) WITHOUT mutating this project's cached trees, cached
    /// compilation, or dirty flag. This is the read-only counterpart to
    /// (cref:UpdateFile) + (cref:GetCompilation): non-mutating LSP requests (e.g.
    /// the textDocument/diagnostic pull handler) that run off the write gate must never call
    /// (cref:UpdateFile), because a request holding a stale (pre-edit) snapshot could
    /// otherwise race a concurrent didChange and overwrite a newer tree with the stale one
    /// (issue #1657). When [`snapshotTree`](paramref) is reference-equal to the tree
    /// already cached for [`filePath`](paramref) — the overwhelmingly common case, since
    /// (cref:UpdateFile) keeps the two in sync on every didOpen/didChange under the gate
    /// — this reuses the normal cached (cref:GetCompilation) path. Otherwise (a pull
    /// racing a not-yet-applied or already-superseded edit) it builds a throwaway compilation
    /// from the current tree set with this file's tree swapped for the snapshot, so the returned
    /// diagnostics always reflect exactly the requested text without disturbing project state.
    /// @param filePath Absolute path to the `.gs` file the snapshot belongs to.
    /// @param snapshotTree The already-parsed snapshot tree to bind.
    /// @returns A (cref:Compilation) reflecting exactly [`snapshotTree`](paramref).
    func GetCompilationForSnapshot(filePath string, snapshotTree SyntaxTree) Compilation {
        let key = NormalizePath(filePath)
        lock compilationLock {
            if syntaxTrees.TryGetValue(key, out var current) && object.ReferenceEquals(current, snapshotTree) {
                return GetCompilation()
            }
            RefreshReferencesFromSourceFile_NoLock()
            let resolver ReferenceResolver? = GetOrBuildResolver_NoLock()
            var trees = syntaxTrees.Values.ToArray()
            var replaced = false
            for var i = 0; i < trees.Length; i++ {
                let treePath = trees[i].Text?.FileName
                if ServerPathIdentity.AreSame(treePath, key) {
                    trees[i] = snapshotTree
                    replaced = true
                    break
                }
            }
            if !replaced {
                trees = trees.Append(snapshotTree).ToArray()
            }
            // Never GetCompilation() here: that would re-point symbols off the write gate. A clean cached
            // compilation answers through the one-shot factory; otherwise bind a throwaway one (ADR-0212 §8).
            if !isDirty && compilation != nil {
                for tree in compilation!!.SyntaxTrees {
                    let treePath = tree.Text?.FileName
                    if ServerPathIdentity.AreSame(treePath, key) {
                        return compilation!!.WithReplacedSyntaxTree(tree, snapshotTree)
                    }
                }
            }
            return NewCompilation_NoLock(resolver, false, trees)
        }
    }

    /// Gets the project's G# analyzer set (ADR-0169), parsed from the same
    /// MSBuild-emitted `.rsp` the references come from
    /// (`/gsanalyzer:` lines) and re-loaded only when the rsp changes.
    /// Analyzer instances are cached so registration and load costs are paid
    /// once per build, not per keystroke.
    /// @param loadDiagnostics GS9301/GS9303 diagnostics produced while loading the current set.
    /// @returns The loaded analyzers, possibly empty.
    func GetGsAnalyzers(out loadDiagnostics ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic]) ImmutableArray[
        GSharpDiagnosticAnalyzer
    ] {
        lock compilationLock {
            let rspPath = referenceSourcePath
            if string.IsNullOrEmpty(rspPath) || !File.Exists(rspPath) {
                loadDiagnostics = ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic].Empty
                return ImmutableArray[GSharpDiagnosticAnalyzer].Empty
            }
            var mtime DateTime
            try {
                mtime = File.GetLastWriteTimeUtc(rspPath!!)
            } catch (IOException) {
                loadDiagnostics = gsAnalyzerLoadDiagnostics
                return cachedGsAnalyzers
            }
            if mtime != gsAnalyzerSourceMtimeUtc {
                let paths = ProjectDiscovery.ParseGsAnalyzersFromResponseFile(rspPath!!)
                cachedGsAnalyzers = GSharpAnalyzerHost.Load(paths, out gsAnalyzerLoadDiagnostics)
                gsAnalyzerSourceMtimeUtc = mtime
            }
            loadDiagnostics = gsAnalyzerLoadDiagnostics
            return cachedGsAnalyzers
        }
    }

    // Cancels the lifetime token of the cached compilation. A dead compilation never builds again; readers that
    // hold it see OperationCanceledException for state it has not built (ADR-0212 §8, Q7).
    // The source is not disposed: it has no timer and no registration, and readers keep copies of its token.
    private func RetireCompilation_NoLock() {
        compilationLifetime?.Cancel()
        compilationLifetime = nil
    }

    // Gives a compilation of the cached chain its own lifetime token. Snapshot compilations keep the default
    // budget: they are one request and nothing cancels them.
    private func AttachLifetime_NoLock(created Compilation) Compilation {
        let source = CancellationTokenSource()
        compilationLifetime = source
        created.WorkBudget = CompilationWorkBudget(cancellationToken: source.Token)
        return created
    }

    // The server keeps no body cache and no reused scope of its own: IncrementalBodyReuse makes the
    // compilation chain own them (ADR-0212 §8).
    private func NewCompilation_NoLock(
        resolver ReferenceResolver?,
        incrementalBodyReuse bool,
        trees ...SyntaxTree
    ) Compilation {
        let created = if resolver != nil {
            Compilation(resolver, trees)
        } else {
            Compilation(trees)
        }
        // Before the first GlobalScope read: imported visibility is cached per consumer name (ADR-0212 S6b).
        // Successors copy the name from their predecessor, so this is the only place the server sets it.
        if !string.IsNullOrWhiteSpace(assemblyName) {
            created.AssemblyName = assemblyName
        }
        created.IncrementalBodyReuse = incrementalBodyReuse
        created.RecordMemberGroups = true
        return created
    }

    /// ADR-0105 (Phase 2): asks the previous (cref:Compilation) for its successor when the only change
    /// since then is one replaced file. Returns `null` for every other edit shape (add or remove, several
    /// files changed, or a reference change), which forces the caller's full rebuild. Must be called
    /// under (cref:compilationLock).
    /// @param trees The current set of syntax trees.
    /// @param resolver The current reference resolver (may be null).
    /// @returns The successor compilation, or `null` to fall back.
    private func TryBuildSuccessor_NoLock(trees[]SyntaxTree, resolver ReferenceResolver?) Compilation? {
        let previous Compilation? = compilation
        if previous == nil || trees.Length == 0 {
            return nil
        }
        // A reference (.rsp) change is project-wide — fall back. Comparing the
        // resolver instance is sufficient: GetOrBuildResolver_NoLock returns the
        // same cached instance until references change, when it is rebuilt.
        if !object.ReferenceEquals(previous.References, resolver) {
            return nil
        }
        // Pair the previous and current trees by file path. Any added or removed
        // file makes this not a single-file edit.
        let previousTrees = previous.SyntaxTrees
        if previousTrees.Length != trees.Length {
            return nil
        }
        let previousByPath = Dictionary[string, SyntaxTree](previousTrees.Length, StringComparer.OrdinalIgnoreCase)
        for tree in previousTrees {
            let name = tree.Text?.FileName
            if string.IsNullOrEmpty(name) {
                return nil
            }
            previousByPath[NormalizePath(name)] = tree
        }
        var changedPrevious SyntaxTree? = nil
        var changedUpdated SyntaxTree? = nil
        for tree in trees {
            let name = tree.Text?.FileName
            if string.IsNullOrEmpty(name) || !previousByPath.TryGetValue(NormalizePath(name!!), out var prevTree) {
                return nil
            }
            if object.ReferenceEquals(prevTree, tree) {
                continue
            }
            if changedUpdated != nil {
                // More than one file changed — fall back.
                return nil
            }
            changedPrevious = prevTree
            changedUpdated = tree
        }
        if changedPrevious == nil || changedUpdated == nil {
            // Nothing actually changed (should not happen when dirty), but if so
            // there is nothing to rebind — let the caller reuse normally.
            return nil
        }
        // Not every replaced file is a body-only edit: the factory binds from scratch when it is not,
        // and the successor still shares the body cache. Order follows the previous compilation, which
        // is the order of the project's trees because only one value changed.
        return previous.ReplaceSyntaxTree(changedPrevious, changedUpdated)
    }

    private func RefreshReferencesFromSourceFile_NoLock() {
        if string.IsNullOrEmpty(referenceSourcePath) {
            let now = DateTime.UtcNow
            if now < nextReferenceDiscoveryUtc {
                return
            }
            nextReferenceDiscoveryUtc = now.AddSeconds(1.0)
            let discovered = ProjectDiscovery.DiscoverReferences(ProjectFilePath, ProjectDirectory)
            if string.IsNullOrEmpty(discovered.ReferenceSourcePath) {
                return
            }
            referenceSourcePath = discovered.ReferenceSourcePath
            references = discovered.References
            referenceSourceMtimeUtc = DateTime.MinValue
            cachedResolver = nil
            resolverReferences = nil
            Invalidate()
        }
        var currentMtime DateTime
        try {
            if !File.Exists(referenceSourcePath) {
                return
            }
            currentMtime = File.GetLastWriteTimeUtc(referenceSourcePath!!)
        } catch (IOException) {
            return
        }
        if currentMtime == referenceSourceMtimeUtc {
            return
        }
        // The .rsp was rewritten by a build — reparse so completion/hover see
        // any newly added or removed PackageReference / ProjectReference.
        let freshRefs = ProjectDiscovery.ParseReferencesFromResponseFile(referenceSourcePath!!)
        referenceSourceMtimeUtc = currentMtime
        if !ReferenceListsEqual(references, freshRefs) {
            references = freshRefs
            cachedResolver = nil
            resolverReferences = nil
            Invalidate()
        }
    }

    private func GetOrBuildResolver_NoLock() ReferenceResolver? {
        var effectiveReferences = references
        if effectiveReferences.Count == 0 {
            // ADR-0107: no `.rsp` (fresh clone, or after `dotnet clean` — the
            // `.rsp` lives in the gitignored `obj/`). Try to bootstrap the
            // reference set from a previously-written `.lscache` so the LSP can
            // still resolve imported types without first building. The cache
            // re-validates every DLL (exists + size:mtime) before returning; any
            // missing/changed reference falls back to today's empty/degraded
            // behavior (over-invalidation is always safe).
            let bootstrapped IReadOnlyList[string]? = ColdStartCache.TryBootstrapReferences(
                ProjectFilePath,
                AssemblyName ?? string.Empty
            )
            if bootstrapped != nil && bootstrapped.Count > 0 {
                effectiveReferences = bootstrapped
            }
        }
        if effectiveReferences.Count == 0 {
            return nil
        }
        // The resolver cache is keyed on the project's own `references` identity
        // (the `.rsp`-derived list, or the stable empty instance when there is no
        // `.rsp`). A bootstrapped reference set is used to build the resolver but
        // does not change that identity, so the resolver is rebuilt only when a
        // real `.rsp` later replaces `references`.
        if cachedResolver != nil && object.ReferenceEquals(resolverReferences, references) {
            return cachedResolver!!
        }
        cachedResolver = ReferenceResolver.WithReferences(effectiveReferences)
        resolverReferences = references
        WarmOrSeedColdStartCache_NoLock(cachedResolver, effectiveReferences)
        return cachedResolver!!
    }

    // ADR-0107: load the persisted reference-metadata index for this project, or
    // build and persist a fresh one. On a fingerprint-matching cache hit the
    // resolver adopts the index and skips the ~120ms GetTypes() enumeration of the
    // whole reference closure on this cold start. On any miss/mismatch/corruption
    // the resolver stays cold: we build the index once (work the cold path needs
    // anyway), adopt it for this session, and write it for next time. The
    // fingerprint is `.rsp`-independent (reference set + source fingerprint + TFM
    // + versions), so a cache written from a bootstrapped reference set is itself
    // reusable. Every step is best-effort — a cache error must never disturb the
    // LSP, so the resolver simply falls back to its eager type-name index.
    private func WarmOrSeedColdStartCache_NoLock(
        resolver ReferenceResolver?,
        effectiveReferences IReadOnlyList[string]
    ) {
        if resolver == nil || ColdStartCache.Disabled {
            return
        }
        try {
            let sourceFingerprint = ComputeSourceFingerprint_NoLock()
            let targetFramework = ProjectDiscovery.ResolveTargetFramework(ProjectFilePath)
            let cached ReferenceMetadataIndex? = ColdStartCache.TryLoad(
                ProjectFilePath,
                AssemblyName ?? string.Empty,
                effectiveReferences,
                referenceSourcePath ?? string.Empty,
                sourceFingerprint,
                TargetFramework ?? string.Empty
            )
            if cached != nil && resolver.TryUseMetadataIndex(cached) {
                return
            }
            let fresh = resolver.ExportMetadataIndex()
            resolver.TryUseMetadataIndex(fresh)
            ColdStartCache.Save(
                ProjectFilePath,
                AssemblyName ?? string.Empty,
                effectiveReferences,
                referenceSourcePath,
                sourceFingerprint,
                TargetFramework,
                fresh
            )
        } catch (Exception) {
            // Defence in depth: the cache is a performance optimization only. On
            // any unexpected error leave the resolver on its eager cold path.

        }
    }

    // ADR-0107: a content hash over the project's current source set — each file's
    // project-relative path plus its in-memory text — folded into the cold-start
    // cache fingerprint. Project-relative paths keep the hash portable across
    // clones (so a committed `.lscache` validates on another checkout of the same
    // sources). Any edit to any source flips the hash, conservatively invalidating
    // the cache. Best-effort: returns an empty string on any error.
    private func ComputeSourceFingerprint_NoLock() string {
        try {
            let entries = List[string](syntaxTrees.Count)
            for pair in syntaxTrees {
                let content = pair.Value?.Text?.ToString() ?? string.Empty
                var relative = pair.Key
                try {
                    if !string.IsNullOrEmpty(ProjectDirectory) {
                        relative = Path.GetRelativePath(ProjectDirectory, pair.Key).Replace(
                            Path.DirectorySeparatorChar,
                            '/'
                        )
                    }
                } catch (ArgumentException) {
                    relative = pair.Key
                }
                entries.Add(relative + "\u0000" + content)
            }
            entries.Sort(StringComparer.Ordinal)
            let sb = StringBuilder()
            for entry in entries {
                sb.Append(entry).Append('\n')
            }
            let hash = SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()))
            return Convert.ToHexString(hash).ToLowerInvariant()
        } catch (Exception) {
            return string.Empty
        }
    }

    private func Invalidate() {
        isDirty = true
    }

    shared {
        private func ReferenceListsEqual(a IReadOnlyList[string]?, b IReadOnlyList[string]?) bool {
            if object.ReferenceEquals(a, b) {
                return true
            }
            if a == nil || b == nil {
                return false
            }
            if a.Count != b.Count {
                return false
            }
            for var i = 0; i < a.Count; i++ {
                if !string.Equals(a[i], b[i], StringComparison.Ordinal) {
                    return false
                }
            }
            return true
        }

        private func NormalizePath(path string) string {
            return ServerPathIdentity.Normalize(path)
        }
    }
}
