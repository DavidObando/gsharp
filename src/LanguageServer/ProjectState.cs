// <copyright file="ProjectState.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
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
    /// Adds or updates a source file in the project.
    /// </summary>
    /// <param name="filePath">Absolute path to the <c>.gs</c> file.</param>
    /// <param name="text">The current text content of the file.</param>
    /// <returns>The parsed <see cref="SyntaxTree"/>.</returns>
    public SyntaxTree UpdateFile(string filePath, string text)
    {
        var sourceText = GSharp.Core.CodeAnalysis.Text.SourceText.From(text, filePath);
        var tree = SyntaxTree.Parse(sourceText);
        syntaxTrees[NormalizePath(filePath)] = tree;
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
        if (!isDirty && compilation != null)
        {
            return compilation;
        }

        lock (compilationLock)
        {
            if (!isDirty && compilation != null)
            {
                return compilation;
            }

            var trees = syntaxTrees.Values.ToArray();
            compilation = trees.Length > 0 ? new Compilation(trees) : new Compilation(SyntaxTree.Parse(string.Empty));
            isDirty = false;
            return compilation;
        }
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
