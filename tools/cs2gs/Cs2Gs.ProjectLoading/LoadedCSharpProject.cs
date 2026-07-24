// <copyright file="LoadedCSharpProject.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Cs2Gs.Translator.Loading;

/// <summary>
/// The result of loading a C# input (a <c>.csproj</c> or a set of loose
/// sources) into a fully bound Roslyn compilation. This is the front-end
/// hand-off the translator consumes (ADR-0115 §A); the pipeline inspects
/// <see cref="ErrorDiagnostics"/> to detect a project that does not even bind in
/// C# before the Translate stage runs (ADR-0115 §C).
/// </summary>
public sealed class LoadedCSharpProject
{
    /// <summary>
    /// Initializes a new instance of the <see cref="LoadedCSharpProject"/> class.
    /// </summary>
    /// <param name="compilation">The bound C# compilation.</param>
    /// <param name="documents">The per-file syntax tree + semantic model pairs.</param>
    /// <param name="loadDiagnostics">The compile diagnostics surfaced while loading.</param>
    /// <param name="projectDirectory">
    /// The directory containing the project file, or <see langword="null"/> for an
    /// in-memory-loaded project (<see cref="CSharpProjectLoader.LoadInMemory"/>).
    /// </param>
    /// <param name="rootNamespace">
    /// The project's effective root/default namespace (issue #2200), used to compute
    /// the namespace of a generated resx codebehind file; empty for an in-memory-loaded
    /// project.
    /// </param>
    /// <param name="resxFiles">
    /// The absolute paths of the <c>.resx</c> files discovered under
    /// <paramref name="projectDirectory"/> (issue #2200), excluding the project's own
    /// <c>obj</c>/<c>bin</c> output directories.
    /// </param>
    /// <param name="analyzerReferencePaths">
    /// The on-disk analyzer/generator assembly paths the project references
    /// (issue #2215), forwarded by the Compile stage to gsc's <c>/analyzer:</c>
    /// flag so generator output reaches the cs2gs-compiled assembly the same
    /// way a real build would produce it.
    /// </param>
    /// <param name="additionalFiles">
    /// The non-source generator inputs (issue #2223) — the project's
    /// <c>@(AdditionalFiles)</c> plus discovered <c>.axaml</c> — forwarded to
    /// gsc/gsgen as Roslyn <c>AdditionalText</c> so file-driven generators (e.g.
    /// Avalonia's XAML name generator) can materialize their output.
    /// </param>
    /// <param name="projectPath">
    /// The loaded project file path, or <see langword="null"/> for in-memory inputs.
    /// </param>
    /// <param name="isTestProject">Whether evaluated MSBuild properties identify a test project.</param>
    public LoadedCSharpProject(
        CSharpCompilation compilation,
        IReadOnlyList<LoadedDocument> documents,
        IReadOnlyList<Diagnostic> loadDiagnostics,
        string projectDirectory = null,
        string rootNamespace = null,
        IReadOnlyList<string> resxFiles = null,
        IReadOnlyList<string> analyzerReferencePaths = null,
        IReadOnlyList<string> additionalFiles = null,
        string projectPath = null,
        bool isTestProject = false)
    {
        this.Compilation = compilation;
        this.Documents = documents;
        this.LoadDiagnostics = loadDiagnostics;
        this.ProjectDirectory = projectDirectory;
        this.RootNamespace = rootNamespace ?? string.Empty;
        this.ResxFiles = resxFiles ?? ImmutableArray<string>.Empty;
        this.AnalyzerReferencePaths = analyzerReferencePaths ?? ImmutableArray<string>.Empty;
        this.AdditionalFiles = additionalFiles ?? ImmutableArray<string>.Empty;
        this.ProjectPath = projectPath;
        this.IsTestProject = isTestProject;
    }

    /// <summary>Gets the bound C# compilation.</summary>
    public CSharpCompilation Compilation { get; }

    /// <summary>Gets the per-file syntax tree + semantic model pairs.</summary>
    public IReadOnlyList<LoadedDocument> Documents { get; }

    /// <summary>Gets the compile diagnostics surfaced while loading.</summary>
    public IReadOnlyList<Diagnostic> LoadDiagnostics { get; }

    /// <summary>
    /// Gets the directory containing the project file, or <see langword="null"/>
    /// for an in-memory-loaded project.
    /// </summary>
    public string ProjectDirectory { get; }

    /// <summary>
    /// Gets the project's effective root/default namespace (Roslyn's
    /// <c>Project.DefaultNamespace</c>, which reflects MSBuild's
    /// <c>&lt;RootNamespace&gt;</c>, falling back to the assembly/project file
    /// name) — issue #2200. Empty for an in-memory-loaded project.
    /// </summary>
    public string RootNamespace { get; }

    /// <summary>
    /// Gets the absolute paths of the <c>.resx</c> files discovered under
    /// <see cref="ProjectDirectory"/> (issue #2200), excluding the project's own
    /// <c>obj</c>/<c>bin</c> output directories. Each drives a generated
    /// <c>*.Designer.gs</c> codebehind via
    /// <see cref="GSharp.Core.Resx.ResxCodeGenerator"/> instead of translating a
    /// hand-authored <c>*.Designer.cs</c> (which is skipped as generated source;
    /// see <see cref="CSharpProjectLoader"/>'s auto-generated-header check).
    /// </summary>
    public IReadOnlyList<string> ResxFiles { get; }

    /// <summary>
    /// Gets the on-disk analyzer/generator assembly paths the project
    /// references (issue #2215) — empty for an in-memory-loaded project.
    /// </summary>
    public IReadOnlyList<string> AnalyzerReferencePaths { get; }

    /// <summary>
    /// Gets the non-source generator inputs (issue #2223) — the project's
    /// <c>@(AdditionalFiles)</c> plus discovered <c>.axaml</c> — forwarded to
    /// gsc/gsgen as Roslyn <c>AdditionalText</c>. Empty for an in-memory-loaded
    /// project.
    /// </summary>
    public IReadOnlyList<string> AdditionalFiles { get; }

    /// <summary>Gets the loaded project file path, or <see langword="null"/>.</summary>
    public string ProjectPath { get; }

    /// <summary>Gets a value indicating whether this is an evaluated test project.</summary>
    public bool IsTestProject { get; }

    /// <summary>
    /// Gets the subset of <see cref="LoadDiagnostics"/> with
    /// <see cref="DiagnosticSeverity.Error"/> severity — a non-empty list means
    /// the project does not bind in C# and the Translate stage should not run.
    /// </summary>
    public IReadOnlyList<Diagnostic> ErrorDiagnostics =>
        this.LoadDiagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).ToImmutableArray();

    /// <summary>Gets a value indicating whether the project bound with no C# errors.</summary>
    public bool BoundWithoutErrors => this.ErrorDiagnostics.Count == 0;

    /// <summary>
    /// Gets a value indicating whether MSBuild itself failed to open the
    /// project (missing SDK/targets, an unresolvable project reference, an
    /// unsupported TFM, ...) — see
    /// <see cref="CSharpProjectLoader.WorkspaceLoadFailureDiagnosticId"/>
    /// (ADR-0115 §C, issue #1742). Unlike <see cref="BoundWithoutErrors"/>, this
    /// ignores ordinary C# semantic errors from documents that did load (some
    /// corpus fixtures carry those deliberately to exercise a later stage), so
    /// pipeline stages should gate on THIS to stop before translating a project
    /// that never even bound, without misfiring on those fixtures.
    /// </summary>
    public bool WorkspaceLoadFailed =>
        this.ErrorDiagnostics.Any(d => d.Id == CSharpProjectLoader.WorkspaceLoadFailureDiagnosticId);

    /// <summary>
    /// Gets the subset of <see cref="ErrorDiagnostics"/> that are MSBuild
    /// workspace load failures — the diagnostics a stage should surface when
    /// <see cref="WorkspaceLoadFailed"/> is <see langword="true"/>.
    /// </summary>
    public IReadOnlyList<Diagnostic> WorkspaceLoadErrors =>
        this.ErrorDiagnostics
            .Where(d => d.Id == CSharpProjectLoader.WorkspaceLoadFailureDiagnosticId)
            .ToImmutableArray();
}
