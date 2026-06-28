// <copyright file="CSharpProjectLoader.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.MSBuild;

namespace Cs2Gs.Translator.Loading;

/// <summary>
/// Loads C# input into a fully bound <see cref="CSharpCompilation"/> with a
/// <see cref="SemanticModel"/> per file (ADR-0115 §A). Two entry points are
/// provided:
/// <list type="bullet">
/// <item><description>
/// <see cref="LoadProjectAsync(string, CancellationToken)"/> — the primary
/// loader that opens a real <c>.csproj</c> through Roslyn's
/// <see cref="MSBuildWorkspace"/> (SDK resolution via
/// <see cref="MSBuildLocator"/>). This is the production ingestion path.
/// </description></item>
/// <item><description>
/// <see cref="LoadInMemory(IReadOnlyList{ValueTuple{string, string}}, IReadOnlyList{MetadataReference}, string)"/>
/// — a lightweight secondary loader that compiles in-memory C# source strings
/// against the running runtime's reference assemblies, for fast unit tests of
/// the visitor without spinning up MSBuild.
/// </description></item>
/// </list>
/// </summary>
public static class CSharpProjectLoader
{
    private static readonly object MSBuildRegistrationLock = new();
    private static bool msbuildRegistered;

    /// <summary>
    /// Opens a C# project through <see cref="MSBuildWorkspace"/> and returns its
    /// bound compilation. Registers the SDK MSBuild via
    /// <see cref="MSBuildLocator.RegisterDefaults"/> exactly once before the
    /// workspace is created.
    /// </summary>
    /// <param name="projectPath">The absolute or relative path to the <c>.csproj</c>.</param>
    /// <param name="cancellationToken">A cancellation token.</param>
    /// <returns>The loaded project with its compilation, documents, and diagnostics.</returns>
    /// <exception cref="FileNotFoundException">The project file does not exist.</exception>
    /// <exception cref="InvalidOperationException">The opened project did not produce a C# compilation.</exception>
    public static async Task<LoadedCSharpProject> LoadProjectAsync(
        string projectPath,
        CancellationToken cancellationToken = default)
    {
        if (projectPath is null)
        {
            throw new ArgumentNullException(nameof(projectPath));
        }

        string fullPath = Path.GetFullPath(projectPath);
        if (!File.Exists(fullPath))
        {
            throw new FileNotFoundException($"Project file not found: {fullPath}", fullPath);
        }

        EnsureMSBuildRegistered();

        var loadDiagnostics = new List<Diagnostic>();
        using var workspace = MSBuildWorkspace.Create();
        workspace.LoadMetadataForReferencedProjects = true;

        Project project = await workspace.OpenProjectAsync(fullPath, cancellationToken: cancellationToken)
            .ConfigureAwait(false);

        Compilation compilation = await project.GetCompilationAsync(cancellationToken).ConfigureAwait(false);
        if (compilation is not CSharpCompilation csharpCompilation)
        {
            throw new InvalidOperationException(
                $"Project '{fullPath}' did not produce a C# compilation (language: {project.Language}).");
        }

        IReadOnlyList<LoadedDocument> documents = BuildDocuments(csharpCompilation);
        loadDiagnostics.AddRange(SignificantDiagnostics(csharpCompilation));

        return new LoadedCSharpProject(csharpCompilation, documents, loadDiagnostics);
    }

    /// <summary>
    /// Compiles a set of in-memory C# sources into a bound compilation. This is
    /// the fast path for unit tests; it does not touch MSBuild.
    /// </summary>
    /// <param name="sources">The <c>(fileName, sourceText)</c> pairs to compile.</param>
    /// <param name="references">
    /// The metadata references; when <see langword="null"/> the running runtime's
    /// reference assemblies (from <c>TRUSTED_PLATFORM_ASSEMBLIES</c>) are used.
    /// </param>
    /// <param name="assemblyName">The output assembly name.</param>
    /// <returns>The loaded project with its compilation, documents, and diagnostics.</returns>
    public static LoadedCSharpProject LoadInMemory(
        IReadOnlyList<(string FileName, string Source)> sources,
        IReadOnlyList<MetadataReference> references = null,
        string assemblyName = "Cs2Gs.InMemory")
    {
        if (sources is null)
        {
            throw new ArgumentNullException(nameof(sources));
        }

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        var trees = sources
            .Select(s => CSharpSyntaxTree.ParseText(s.Source, parseOptions, path: s.FileName))
            .ToImmutableArray();

        IReadOnlyList<MetadataReference> resolvedReferences = references ?? RuntimeReferences();

        var compilation = CSharpCompilation.Create(
            assemblyName,
            trees,
            resolvedReferences,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithAllowUnsafe(true));

        IReadOnlyList<LoadedDocument> documents = BuildDocuments(compilation);
        IReadOnlyList<Diagnostic> loadDiagnostics = SignificantDiagnostics(compilation);

        return new LoadedCSharpProject(compilation, documents, loadDiagnostics);
    }

    /// <summary>
    /// Builds the default metadata reference set from the running runtime's
    /// trusted platform assemblies (the shared framework).
    /// </summary>
    /// <returns>The metadata references for the current runtime.</returns>
    public static IReadOnlyList<MetadataReference> RuntimeReferences()
    {
        string tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            throw new InvalidOperationException(
                "TRUSTED_PLATFORM_ASSEMBLIES is unavailable; cannot derive default runtime references.");
        }

        return tpa
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Where(path => path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) && File.Exists(path))
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToImmutableArray();
    }

    private static IReadOnlyList<LoadedDocument> BuildDocuments(CSharpCompilation compilation)
    {
        var documents = new List<LoadedDocument>();
        foreach (SyntaxTree tree in compilation.SyntaxTrees)
        {
            // OD-T4: build-generated sources (Nerdbank.GitVersioning `ThisAssembly`,
            // `*.AssemblyInfo.cs`, global usings, etc.) reference attributes the G#
            // compiler cannot resolve (GS0198) and are not part of the app's hand-
            // written source. Skip them for translation/emit; they stay in the C#
            // compilation so semantic binding of the real sources is unaffected.
            if (IsGeneratedSource(tree.FilePath))
            {
                continue;
            }

            SemanticModel model = compilation.GetSemanticModel(tree, ignoreAccessibility: false);
            documents.Add(new LoadedDocument(tree.FilePath, tree, model));
        }

        return documents;
    }

    /// <summary>
    /// Determines whether a C# file is a build-generated artifact that should not
    /// be translated: anything under an <c>obj/</c> or <c>bin/</c> directory, or a
    /// recognized generated file name (assembly-info, global usings, version, or
    /// any <c>*.g.cs</c> / <c>*.g.i.cs</c> source generator output).
    /// </summary>
    private static bool IsGeneratedSource(string filePath)
    {
        if (string.IsNullOrEmpty(filePath))
        {
            return false;
        }

        string normalized = filePath.Replace('\\', '/');
        if (normalized.Contains("/obj/", StringComparison.OrdinalIgnoreCase) ||
            normalized.Contains("/bin/", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        string name = Path.GetFileName(normalized);
        return name.EndsWith(".AssemblyInfo.cs", StringComparison.OrdinalIgnoreCase) ||
            name.EndsWith(".AssemblyAttributes.cs", StringComparison.OrdinalIgnoreCase) ||
            name.EndsWith(".GlobalUsings.g.cs", StringComparison.OrdinalIgnoreCase) ||
            name.EndsWith(".Version.cs", StringComparison.OrdinalIgnoreCase) ||
            name.EndsWith(".g.i.cs", StringComparison.OrdinalIgnoreCase) ||
            name.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase);
    }

    private static IReadOnlyList<Diagnostic> SignificantDiagnostics(CSharpCompilation compilation) =>
        compilation.GetDiagnostics()
            .Where(d => d.Severity is DiagnosticSeverity.Warning or DiagnosticSeverity.Error)
            .ToImmutableArray();

    private static void EnsureMSBuildRegistered()
    {
        if (msbuildRegistered)
        {
            return;
        }

        lock (MSBuildRegistrationLock)
        {
            if (msbuildRegistered)
            {
                return;
            }

            if (!MSBuildLocator.IsRegistered)
            {
                MSBuildLocator.RegisterDefaults();
            }

            msbuildRegistered = true;
        }
    }
}
