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

            isDirty = false;
            return compilation;
        }
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
        if (references.Count == 0)
        {
            return null;
        }

        if (cachedResolver != null && ReferenceEquals(resolverReferences, references))
        {
            return cachedResolver;
        }

        cachedResolver = ReferenceResolver.WithReferences(references);
        resolverReferences = references;
        return cachedResolver;
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
