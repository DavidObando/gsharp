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
using Microsoft.CodeAnalysis.Text;

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
/// <see cref="LoadInMemory(IReadOnlyList{ValueTuple{string, string}}, IReadOnlyList{MetadataReference}, string, OutputKind)"/>
/// — a lightweight secondary loader that compiles in-memory C# source strings
/// against the running runtime's reference assemblies, for fast unit tests of
/// the visitor without spinning up MSBuild.
/// </description></item>
/// </list>
/// </summary>
public static class CSharpProjectLoader
{
    /// <summary>
    /// Diagnostic id for an MSBuild workspace load failure — the exact signal
    /// pipeline stages must gate on (issue #1742): a project that soft-failed
    /// to open (missing SDK/targets, an unresolvable project reference, an
    /// unsupported TFM, ...), as opposed to an ordinary C# semantic error in a
    /// document that did load (some corpus fixtures carry those deliberately,
    /// e.g. to exercise the later <c>gsc</c> compile-gap stage).
    /// </summary>
    public const string WorkspaceLoadFailureDiagnosticId = "CS2GS0001";

    private static readonly object MSBuildRegistrationLock = new object();

    /// <summary>
    /// Diagnostic id for an MSBuild workspace load failure (a project that
    /// soft-failed to load: missing SDK/targets, skipped project reference,
    /// wrong TFM, etc.). Surfaced as an <see cref="DiagnosticSeverity.Error"/> so
    /// <see cref="LoadedCSharpProject.BoundWithoutErrors"/> reflects the real
    /// state of the load instead of silently proceeding on a degraded project.
    /// </summary>
#pragma warning disable RS2008 // no analyzer release-tracking file for this non-analyzer diagnostic id
    private static readonly DiagnosticDescriptor MSBuildWorkspaceLoadFailureDescriptor = new DiagnosticDescriptor(
        id: WorkspaceLoadFailureDiagnosticId,
        title: "MSBuild workspace load failure",
        messageFormat: "MSBuild workspace failed to load the project: {0}",
        category: "Cs2Gs.Loading",
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true);

    /// <summary>
    /// Diagnostic id emitted (informationally) for each source file excluded from
    /// translation because it is genuinely build-generated (recognized by an
    /// <c>&lt;auto-generated&gt;</c> header or by living under the project's own
    /// <c>obj/</c>/<c>bin/</c> output directories) — never by file name alone.
    /// </summary>
    private static readonly DiagnosticDescriptor GeneratedSourceSkippedDescriptor = new DiagnosticDescriptor(
        id: "CS2GS0002",
        title: "Generated source file excluded from translation",
        messageFormat: "Skipped '{0}' because it is recognized as generated code",
        category: "Cs2Gs.Loading",
        defaultSeverity: DiagnosticSeverity.Info,
        isEnabledByDefault: true);
#pragma warning restore RS2008

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

        // OD-T? (issue #1742): MSBuildWorkspace can soft-fail a project load (missing
        // SDK/targets, a project reference it had to skip, an unrecognized TFM, ...)
        // without throwing. Those failures land in workspace.Diagnostics and were
        // previously never inspected, so the translator proceeded on a degraded
        // compilation and the user only saw confusing downstream binding errors.
        // Surface them as load errors so BoundWithoutErrors reflects reality.
        loadDiagnostics.AddRange(
            workspace.Diagnostics
                .Where(d => d.Kind == WorkspaceDiagnosticKind.Failure)
                .Select(d => Diagnostic.Create(MSBuildWorkspaceLoadFailureDescriptor, Location.None, d.Message)));

        return await BuildLoadedProjectAsync(project, loadDiagnostics, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Loads a C# project together with the transitive closure of its
    /// same-solution <c>ProjectReference</c>s, each as its own bound
    /// <see cref="LoadedCSharpProject"/>. The primary (requested) project is
    /// returned first and carries any MSBuild workspace load-failure diagnostics;
    /// the referenced projects follow. This lets the migration pipeline translate
    /// sibling-project source into G# so an app's uses of sibling types resolve at
    /// the gsc compile stage (Refs #914). Package references are unaffected — they
    /// remain metadata references on each compilation.
    /// </summary>
    /// <param name="projectPath">The absolute or relative path to the app's <c>.csproj</c>.</param>
    /// <param name="cancellationToken">A cancellation token.</param>
    /// <returns>The primary project followed by its transitively referenced C# projects.</returns>
    public static async Task<IReadOnlyList<LoadedCSharpProject>> LoadProjectWithReferencesAsync(
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

        var workspaceFailures = new List<Diagnostic>();
        using var workspace = MSBuildWorkspace.Create();
        workspace.LoadMetadataForReferencedProjects = true;

        Project project = await workspace.OpenProjectAsync(fullPath, cancellationToken: cancellationToken)
            .ConfigureAwait(false);

        workspaceFailures.AddRange(
            workspace.Diagnostics
                .Where(d => d.Kind == WorkspaceDiagnosticKind.Failure)
                .Select(d => Diagnostic.Create(MSBuildWorkspaceLoadFailureDescriptor, Location.None, d.Message)));

        var results = new List<LoadedCSharpProject>
        {
            await BuildLoadedProjectAsync(project, workspaceFailures, cancellationToken).ConfigureAwait(false),
        };

        foreach (Project referenced in TransitiveCSharpProjectReferences(project))
        {
            results.Add(await BuildLoadedProjectAsync(referenced, new List<Diagnostic>(), cancellationToken)
                .ConfigureAwait(false));
        }

        return results;
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
    /// <param name="outputKind">
    /// The compilation's output kind. Defaults to a library, so
    /// <c>Compilation.GetEntryPoint</c> is <see langword="null"/> and entry-point
    /// flattening (<c>TranslateEntryType</c>) is not exercised. Pass
    /// <see cref="OutputKind.ConsoleApplication"/> to test entry-point
    /// translation (issue #1904) with this fast in-memory harness.
    /// </param>
    /// <returns>The loaded project with its compilation, documents, and diagnostics.</returns>
    public static LoadedCSharpProject LoadInMemory(
        IReadOnlyList<(string FileName, string Source)> sources,
        IReadOnlyList<MetadataReference> references = null,
        string assemblyName = "Cs2Gs.InMemory",
        OutputKind outputKind = OutputKind.DynamicallyLinkedLibrary)
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
            new CSharpCompilationOptions(outputKind).WithAllowUnsafe(true));

        var loadDiagnostics = new List<Diagnostic>();
        IReadOnlyList<LoadedDocument> documents = BuildDocuments(compilation, projectDirectory: null, loadDiagnostics);
        loadDiagnostics.AddRange(SignificantDiagnostics(compilation));

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

    /// <summary>
    /// Enumerates the transitive closure of a project's same-solution
    /// <c>ProjectReference</c>s that produce a C# compilation, each visited once
    /// (breadth-first). The root project itself is excluded.
    /// </summary>
    private static IEnumerable<Project> TransitiveCSharpProjectReferences(Project root)
    {
        Solution solution = root.Solution;
        var seen = new HashSet<ProjectId>();
        var queue = new Queue<Project>();
        foreach (ProjectReference reference in root.ProjectReferences)
        {
            Project referenced = solution.GetProject(reference.ProjectId);
            if (referenced is not null)
            {
                queue.Enqueue(referenced);
            }
        }

        while (queue.Count > 0)
        {
            Project current = queue.Dequeue();
            if (!seen.Add(current.Id))
            {
                continue;
            }

            if (string.Equals(current.Language, LanguageNames.CSharp, StringComparison.Ordinal))
            {
                yield return current;
            }

            foreach (ProjectReference reference in current.ProjectReferences)
            {
                Project referenced = solution.GetProject(reference.ProjectId);
                if (referenced is not null && !seen.Contains(referenced.Id))
                {
                    queue.Enqueue(referenced);
                }
            }
        }
    }

    /// <summary>
    /// Builds a <see cref="LoadedCSharpProject"/> from a bound Roslyn
    /// <see cref="Project"/>, seeding its diagnostics with the supplied list
    /// (e.g. workspace load failures for the primary project).
    /// </summary>
    private static async Task<LoadedCSharpProject> BuildLoadedProjectAsync(
        Project project,
        List<Diagnostic> seedDiagnostics,
        CancellationToken cancellationToken)
    {
        Compilation compilation = await project.GetCompilationAsync(cancellationToken).ConfigureAwait(false);
        if (compilation is not CSharpCompilation csharpCompilation)
        {
            throw new InvalidOperationException(
                $"Project '{project.FilePath}' did not produce a C# compilation (language: {project.Language}).");
        }

        string projectDirectory = Path.GetDirectoryName(project.FilePath);
        IReadOnlyList<LoadedDocument> documents = BuildDocuments(csharpCompilation, projectDirectory, seedDiagnostics);
        seedDiagnostics.AddRange(SignificantDiagnostics(csharpCompilation));

        return new LoadedCSharpProject(csharpCompilation, documents, seedDiagnostics);
    }

    private static IReadOnlyList<LoadedDocument> BuildDocuments(
        CSharpCompilation compilation,
        string projectDirectory,
        ICollection<Diagnostic> diagnosticSink)
    {
        var documents = new List<LoadedDocument>();
        foreach (SyntaxTree tree in compilation.SyntaxTrees)
        {
            // OD-T4 (issue #1742): only skip a file when it is genuinely
            // build-generated — under the project's own obj/bin output, or
            // carrying the standard `<auto-generated>` header (Nerdbank.GitVersioning
            // `ThisAssembly`, SDK AssemblyInfo, resx Designer files, source-generator
            // output, ...). A hand-written file that merely happens to match a
            // generated-looking name (e.g. a hand-written `Api.Version.cs`) is kept.
            if (IsGeneratedSource(tree, projectDirectory))
            {
                diagnosticSink.Add(Diagnostic.Create(GeneratedSourceSkippedDescriptor, Location.None, tree.FilePath));
                continue;
            }

            SemanticModel model = compilation.GetSemanticModel(tree, ignoreAccessibility: false);
            documents.Add(new LoadedDocument(tree.FilePath, tree, model));
        }

        return documents;
    }

    /// <summary>
    /// Determines whether a C# source is a build-generated artifact that should
    /// not be translated. A file is only considered generated when it lives under
    /// the project's own <c>obj/</c> or <c>bin/</c> output directories, or its text
    /// carries the standard <c>&lt;auto-generated&gt;</c> header — never by file
    /// name alone.
    /// </summary>
    private static bool IsGeneratedSource(SyntaxTree tree, string projectDirectory)
    {
        string filePath = tree.FilePath;
        if (string.IsNullOrEmpty(filePath))
        {
            return false;
        }

        if (!string.IsNullOrEmpty(projectDirectory))
        {
            string normalized = filePath.Replace('\\', '/');
            string objPrefix = Path.Combine(projectDirectory, "obj").Replace('\\', '/').TrimEnd('/') + "/";
            string binPrefix = Path.Combine(projectDirectory, "bin").Replace('\\', '/').TrimEnd('/') + "/";
            if (normalized.StartsWith(objPrefix, StringComparison.OrdinalIgnoreCase) ||
                normalized.StartsWith(binPrefix, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return HasAutoGeneratedHeader(tree);
    }

    /// <summary>
    /// Sniffs the leading comment lines of a source file for the standard
    /// <c>// &lt;auto-generated&gt;</c> marker (the convention emitted by T4,
    /// resx code-gen, source generators, and the SDK's own generated files).
    /// </summary>
    private static bool HasAutoGeneratedHeader(SyntaxTree tree)
    {
        SourceText text = tree.GetText();
        int linesToCheck = Math.Min(text.Lines.Count, 5);
        for (int i = 0; i < linesToCheck; i++)
        {
            string line = text.Lines[i].ToString().Trim();
            if (line.Length == 0)
            {
                continue;
            }

            if (!line.StartsWith("//", StringComparison.Ordinal))
            {
                break;
            }

            if (line.Contains("<auto-generated", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
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
