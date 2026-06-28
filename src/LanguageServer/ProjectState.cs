#nullable disable

// <copyright file="ProjectState.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.LanguageServer;

/// <summary>
/// Represents the state of a single GSharp project, holding all source files
/// and producing a unified <see cref="Compilation"/> from them.
/// </summary>
public class ProjectState
{
    private readonly object compilationLock = new();
    private readonly ConcurrentDictionary<string, SyntaxTree> syntaxTrees = new(StringComparer.OrdinalIgnoreCase);

    // ADR-0105 (Phase 1): the per-project bound-body cache. It is owned here —
    // alongside the per-edit lifecycle (UpdateFile -> Invalidate ->
    // GetCompilation) and the warm cachedResolver — and seeded into every
    // Compilation this project produces so unchanged member bodies can be
    // reused across edits when reuse is provably sound. Until ADR-0105 Phase 2
    // gives symbols stable cross-compilation identity, the cache's soundness
    // gate makes reuse a near-no-op (it never alters emitted IL or
    // diagnostics); the infrastructure lands now without user-visible effect.
    private readonly Core.CodeAnalysis.Binding.BoundBodyCache bodyCache = new();

    private Compilation compilation;
    private bool isDirty = true;
    private IReadOnlyList<string> references = Array.Empty<string>();
    private string referenceSourcePath;
    private DateTime referenceSourceMtimeUtc = DateTime.MinValue;
    private ReferenceResolver cachedResolver;
    private IReadOnlyList<string> resolverReferences;

    /// <summary>
    /// Initializes a new instance of the <see cref="ProjectState"/> class.
    /// </summary>
    /// <param name="projectFilePath">Absolute path to the <c>.gsproj</c> file.</param>
    public ProjectState(string projectFilePath)
    {
        ProjectFilePath = projectFilePath ?? throw new ArgumentNullException(nameof(projectFilePath));
        ProjectDirectory = Path.GetDirectoryName(Path.GetFullPath(projectFilePath));
    }

    /// <summary>
    /// Gets the absolute path to the <c>.gsproj</c> file.
    /// </summary>
    public string ProjectFilePath { get; }

    /// <summary>
    /// Gets the directory containing the project file.
    /// </summary>
    public string ProjectDirectory { get; }

    /// <summary>
    /// Gets or sets the project's effective <c>AssemblyName</c> — the basename
    /// (without extension) of the output DLL the SDK emits for this project.
    /// Defaults to <c>null</c> for projects constructed without discovery (e.g.
    /// the implicit project for loose files and most unit-test scaffolding);
    /// <see cref="WorkspaceInitializer"/> populates it for every project parsed
    /// out of a <c>.gsproj</c>. Cross-project Go-to-Definition consults this
    /// via <see cref="WorkspaceState.TryGetProjectByOutputAssembly"/>.
    /// </summary>
    public string AssemblyName { get; set; }

    /// <summary>
    /// Gets or sets the project's target framework moniker (e.g. <c>net10.0</c>),
    /// parsed from the <c>.gsproj</c> by <see cref="ProjectDiscovery"/>. Surfaced to
    /// the VS Code Test Explorer so discovered tests can be grouped under a
    /// <c>&lt;project&gt; (&lt;tfm&gt;)</c> node. May be <c>null</c> or empty when the
    /// project was constructed without discovery or declares no target framework.
    /// </summary>
    public string TargetFramework { get; set; }

    /// <summary>
    /// Gets the set of source file paths currently in this project.
    /// </summary>
    public IReadOnlyCollection<string> SourceFiles => syntaxTrees.Keys.ToList();

    /// <summary>
    /// Gets or sets the list of referenced project file paths.
    /// </summary>
    public IReadOnlyList<string> ProjectReferences { get; set; } = Array.Empty<string>();

    /// <summary>
    /// Gets or sets the list of assembly reference paths (NuGet packages,
    /// transitive dependencies, and the ref-assemblies of non-G# project
    /// references) that imports in this project's sources resolve against.
    /// Typically populated from the MSBuild-emitted <c>.rsp</c> file via
    /// <see cref="ProjectDiscovery.DiscoverProject(string)"/>.
    /// </summary>
    public IReadOnlyList<string> References
    {
        get => references;
        set
        {
            var next = value ?? Array.Empty<string>();
            lock (compilationLock)
            {
                if (!ReferenceListsEqual(references, next))
                {
                    references = next;
                    Invalidate();
                    cachedResolver = null;
                    resolverReferences = null;
                }
            }
        }
    }

    /// <summary>
    /// Gets or sets the absolute path to the <c>.rsp</c> file the references
    /// were parsed from. The file's last-write time is polled on each
    /// <see cref="GetCompilation"/> call so that a fresh build invalidates the
    /// cached <see cref="ReferenceResolver"/> automatically.
    /// </summary>
    public string ReferenceSourcePath
    {
        get => referenceSourcePath;
        set
        {
            lock (compilationLock)
            {
                referenceSourcePath = value;
                referenceSourceMtimeUtc = DateTime.MinValue;
            }
        }
    }

    /// <summary>
    /// Adds or updates a source file in the project. When the supplied text is
    /// byte-identical to the cached tree's source, the call is a no-op and
    /// returns the existing tree; this preserves the cached
    /// <see cref="Compilation"/> (and its lazily-bound <c>GlobalScope</c> /
    /// <c>BoundProgram</c>) across LSP requests that re-issue the same
    /// in-memory buffer (e.g. successive diagnostic / hover pulls).
    /// </summary>
    /// <param name="filePath">Absolute path to the <c>.gs</c> file.</param>
    /// <param name="text">The current text content of the file.</param>
    /// <returns>The parsed <see cref="SyntaxTree"/>.</returns>
    public SyntaxTree UpdateFile(string filePath, string text)
    {
        var key = NormalizePath(filePath);
        if (syntaxTrees.TryGetValue(key, out var existing)
            && existing.Text?.FileName == filePath
            && existing.Text.ToString() == text)
        {
            return existing;
        }

        var sourceText = GSharp.Core.CodeAnalysis.Text.SourceText.From(text, filePath);
        var tree = SyntaxTree.Parse(sourceText);
        syntaxTrees[key] = tree;
        Invalidate();
        return tree;
    }

    /// <summary>
    /// Adds a source file by reading it from disk.
    /// </summary>
    /// <param name="filePath">Absolute path to the <c>.gs</c> file.</param>
    /// <returns>The parsed <see cref="SyntaxTree"/>, or null if the file could not be read.</returns>
    public SyntaxTree AddFileFromDisk(string filePath)
    {
        try
        {
            var text = File.ReadAllText(filePath);
            return UpdateFile(filePath, text);
        }
        catch (IOException)
        {
            return null;
        }
    }

    /// <summary>
    /// Removes a source file from the project.
    /// </summary>
    /// <param name="filePath">Absolute path to the <c>.gs</c> file.</param>
    /// <returns>True if the file was found and removed.</returns>
    public bool RemoveFile(string filePath)
    {
        if (syntaxTrees.TryRemove(NormalizePath(filePath), out _))
        {
            Invalidate();
            return true;
        }

        return false;
    }

    /// <summary>
    /// Returns whether the project contains the given file.
    /// </summary>
    /// <param name="filePath">Absolute path to check.</param>
    /// <returns>True if the file is part of this project.</returns>
    public bool ContainsFile(string filePath)
    {
        return syntaxTrees.ContainsKey(NormalizePath(filePath));
    }

    /// <summary>
    /// Gets the <see cref="SyntaxTree"/> for a given file in this project.
    /// </summary>
    /// <param name="filePath">Absolute path to the <c>.gs</c> file.</param>
    /// <param name="tree">The syntax tree if found.</param>
    /// <returns>True if the file exists in the project.</returns>
    public bool TryGetSyntaxTree(string filePath, out SyntaxTree tree)
    {
        return syntaxTrees.TryGetValue(NormalizePath(filePath), out tree);
    }

    /// <summary>
    /// Gets the project-level <see cref="Compilation"/> built from all source trees.
    /// The compilation is cached and only rebuilt when a file has changed.
    /// </summary>
    /// <returns>The current compilation.</returns>
    public Compilation GetCompilation()
    {
        lock (compilationLock)
        {
            RefreshReferencesFromSourceFile_NoLock();
            if (!isDirty && compilation != null)
            {
                return compilation;
            }

            var trees = syntaxTrees.Values.ToArray();
            var resolver = GetOrBuildResolver_NoLock();

            // ADR-0105 (Phase 2): attempt the incremental fast path — a single
            // file changed and that change is a body-only edit, so we can reuse
            // the previous compilation's BoundGlobalScope (and therefore every
            // symbol instance) and let the BoundBodyCache serve every unchanged
            // file's bodies, re-binding only the edited file. On any mismatch
            // this returns null and we fall back to a full rebuild below
            // (over-invalidation is always safe; under-invalidation would be a
            // correctness bug).
            var incremental = TryBuildIncrementalCompilation_NoLock(trees, resolver);
            if (incremental != null)
            {
                compilation = incremental;
                compilation.BodyCache = bodyCache;
                isDirty = false;
                return compilation;
            }

            if (trees.Length == 0)
            {
                compilation = resolver != null
                    ? new Compilation(resolver, SyntaxTree.Parse(string.Empty))
                    : new Compilation(SyntaxTree.Parse(string.Empty));
            }
            else
            {
                compilation = resolver != null
                    ? new Compilation(resolver, trees)
                    : new Compilation(trees);
            }

            // ADR-0105 (Phase 1): seed the project-owned body cache into the
            // freshly constructed Compilation. The Compilation stays immutable
            // per instance (the cache is external state set once at
            // construction), so the language server's ConditionalWeakTable
            // model/index caches keyed on the Compilation instance keep
            // invalidating correctly.
            compilation.BodyCache = bodyCache;

            isDirty = false;
            return compilation;
        }
    }

    /// <summary>
    /// ADR-0105 (Phase 2): attempts to construct the next <see cref="Compilation"/>
    /// incrementally when the only change since <see cref="compilation"/> is a
    /// body-only edit to a single file. On success returns a new compilation
    /// that reuses the previous <c>BoundGlobalScope</c> (with the edited file's
    /// symbols re-pointed at the new syntax) and marks the edited tree dirty so
    /// only its bodies are re-bound; every other file's bodies are served from
    /// the shared <see cref="bodyCache"/>. Returns <see langword="null"/> for
    /// every other edit shape (signature edit, import/package/alias change,
    /// multiple files changed, add/remove, or a reference change), forcing the
    /// caller's full rebuild. Must be called under <see cref="compilationLock"/>.
    /// </summary>
    /// <param name="trees">The current set of syntax trees.</param>
    /// <param name="resolver">The current reference resolver (may be null).</param>
    /// <returns>An incrementally-built compilation, or <see langword="null"/> to fall back.</returns>
    private Compilation TryBuildIncrementalCompilation_NoLock(SyntaxTree[] trees, ReferenceResolver resolver)
    {
        var previous = compilation;
        if (previous == null || trees.Length == 0)
        {
            return null;
        }

        // A reference (.rsp) change is project-wide — fall back. Comparing the
        // resolver instance is sufficient: GetOrBuildResolver_NoLock returns the
        // same cached instance until references change, when it is rebuilt.
        if (!ReferenceEquals(previous.References, resolver))
        {
            return null;
        }

        // The REPL/append chain shape is not produced here; only handle the flat
        // single-compilation shape the language server builds.
        if (previous.Previous != null)
        {
            return null;
        }

        // Pair the previous and current trees by file path. Any added or removed
        // file makes this not a single-file body edit.
        var previousTrees = previous.SyntaxTrees;
        if (previousTrees.Length != trees.Length)
        {
            return null;
        }

        var previousByPath = new Dictionary<string, SyntaxTree>(previousTrees.Length, StringComparer.OrdinalIgnoreCase);
        foreach (var tree in previousTrees)
        {
            var name = tree.Text?.FileName;
            if (string.IsNullOrEmpty(name))
            {
                return null;
            }

            previousByPath[NormalizePath(name)] = tree;
        }

        SyntaxTree changedPrevious = null;
        SyntaxTree changedUpdated = null;
        foreach (var tree in trees)
        {
            var name = tree.Text?.FileName;
            if (string.IsNullOrEmpty(name) || !previousByPath.TryGetValue(NormalizePath(name), out var prevTree))
            {
                return null;
            }

            if (ReferenceEquals(prevTree, tree))
            {
                continue;
            }

            if (changedUpdated != null)
            {
                // More than one file changed — fall back.
                return null;
            }

            changedPrevious = prevTree;
            changedUpdated = tree;
        }

        if (changedUpdated == null)
        {
            // Nothing actually changed (should not happen when dirty), but if so
            // there is nothing to rebind — let the caller reuse normally.
            return null;
        }

        // Reuse the previous global scope and re-point the edited file's symbols
        // at the new syntax. This both validates the edit is body-only and (on
        // success) performs the only mutation. On failure nothing is mutated.
        var reusedScope = previous.GlobalScope;
        if (!Core.CodeAnalysis.Binding.IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(reusedScope, changedPrevious, changedUpdated))
        {
            return null;
        }

        var incremental = resolver != null
            ? new Compilation(resolver, trees)
            : new Compilation(trees);
        incremental.ReusedGlobalScope = reusedScope;
        incremental.DirtyBodyTrees = System.Collections.Immutable.ImmutableHashSet.Create(changedUpdated);
        return incremental;
    }

    private void RefreshReferencesFromSourceFile_NoLock()
    {
        if (string.IsNullOrEmpty(referenceSourcePath))
        {
            return;
        }

        DateTime currentMtime;
        try
        {
            if (!File.Exists(referenceSourcePath))
            {
                return;
            }

            currentMtime = File.GetLastWriteTimeUtc(referenceSourcePath);
        }
        catch (IOException)
        {
            return;
        }

        if (currentMtime == referenceSourceMtimeUtc)
        {
            return;
        }

        // The .rsp was rewritten by a build — reparse so completion/hover see
        // any newly added or removed PackageReference / ProjectReference.
        var freshRefs = ProjectDiscovery.ParseReferencesFromResponseFile(referenceSourcePath);
        referenceSourceMtimeUtc = currentMtime;
        if (!ReferenceListsEqual(references, freshRefs))
        {
            references = freshRefs;
            cachedResolver = null;
            resolverReferences = null;
            Invalidate();
        }
    }

    private ReferenceResolver GetOrBuildResolver_NoLock()
    {
        var effectiveReferences = references;
        if (effectiveReferences.Count == 0)
        {
            // ADR-0107: no `.rsp` (fresh clone, or after `dotnet clean` — the
            // `.rsp` lives in the gitignored `obj/`). Try to bootstrap the
            // reference set from a previously-written `.lscache` so the LSP can
            // still resolve imported types without first building. The cache
            // re-validates every DLL (exists + size:mtime) before returning; any
            // missing/changed reference falls back to today's empty/degraded
            // behavior (over-invalidation is always safe).
            var bootstrapped = ColdStartCache.TryBootstrapReferences(ProjectFilePath, AssemblyName);
            if (bootstrapped != null && bootstrapped.Count > 0)
            {
                effectiveReferences = bootstrapped;
            }
        }

        if (effectiveReferences.Count == 0)
        {
            return null;
        }

        // The resolver cache is keyed on the project's own `references` identity
        // (the `.rsp`-derived list, or the stable empty instance when there is no
        // `.rsp`). A bootstrapped reference set is used to build the resolver but
        // does not change that identity, so the resolver is rebuilt only when a
        // real `.rsp` later replaces `references`.
        if (cachedResolver != null && ReferenceEquals(resolverReferences, references))
        {
            return cachedResolver;
        }

        cachedResolver = ReferenceResolver.WithReferences(effectiveReferences);
        resolverReferences = references;
        WarmOrSeedColdStartCache_NoLock(cachedResolver, effectiveReferences);
        return cachedResolver;
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
    private void WarmOrSeedColdStartCache_NoLock(ReferenceResolver resolver, IReadOnlyList<string> effectiveReferences)
    {
        if (resolver == null || ColdStartCache.Disabled)
        {
            return;
        }

        try
        {
            var sourceFingerprint = ComputeSourceFingerprint_NoLock();
            var targetFramework = ProjectDiscovery.ResolveTargetFramework(ProjectFilePath);

            var cached = ColdStartCache.TryLoad(
                ProjectFilePath, AssemblyName, effectiveReferences, referenceSourcePath, sourceFingerprint, targetFramework);
            if (cached != null && resolver.TryUseMetadataIndex(cached))
            {
                return;
            }

            var fresh = resolver.ExportMetadataIndex();
            resolver.TryUseMetadataIndex(fresh);
            ColdStartCache.Save(
                ProjectFilePath, AssemblyName, effectiveReferences, referenceSourcePath, sourceFingerprint, targetFramework, fresh);
        }
        catch (Exception)
        {
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
    private string ComputeSourceFingerprint_NoLock()
    {
        try
        {
            var entries = new List<string>(syntaxTrees.Count);
            foreach (var pair in syntaxTrees)
            {
                var content = pair.Value?.Text?.ToString() ?? string.Empty;
                var relative = pair.Key;
                try
                {
                    if (!string.IsNullOrEmpty(ProjectDirectory))
                    {
                        relative = Path.GetRelativePath(ProjectDirectory, pair.Key)
                            .Replace(Path.DirectorySeparatorChar, '/');
                    }
                }
                catch (ArgumentException)
                {
                    relative = pair.Key;
                }

                entries.Add(relative + "\u0000" + content);
            }

            entries.Sort(StringComparer.Ordinal);
            var sb = new System.Text.StringBuilder();
            foreach (var entry in entries)
            {
                sb.Append(entry).Append('\n');
            }

            var hash = System.Security.Cryptography.SHA256.HashData(
                System.Text.Encoding.UTF8.GetBytes(sb.ToString()));
            return Convert.ToHexString(hash).ToLowerInvariant();
        }
        catch (Exception)
        {
            return string.Empty;
        }
    }

    private static bool ReferenceListsEqual(IReadOnlyList<string> a, IReadOnlyList<string> b)
    {
        if (ReferenceEquals(a, b))
        {
            return true;
        }

        if (a == null || b == null)
        {
            return false;
        }

        if (a.Count != b.Count)
        {
            return false;
        }

        for (var i = 0; i < a.Count; i++)
        {
            if (!string.Equals(a[i], b[i], StringComparison.Ordinal))
            {
                return false;
            }
        }

        return true;
    }

    private void Invalidate()
    {
        isDirty = true;
    }

    private static string NormalizePath(string path)
    {
        return Path.GetFullPath(path);
    }
}
