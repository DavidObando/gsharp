// <copyright file="LoadedCSharpProject.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator.Loading

import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// The result of loading a C# input (a `.csproj` or a set of loose
/// sources) into a fully bound Roslyn compilation. This is the front-end
/// hand-off the translator consumes (ADR-0115 §A); the pipeline inspects
/// (cref:ErrorDiagnostics) to detect a project that does not even bind in
/// C# before the Translate stage runs (ADR-0115 §C).
class LoadedCSharpProject {
    /// Initializes a new instance of the (cref:LoadedCSharpProject) class.
    /// @param compilation The bound C# compilation.
    /// @param documents The per-file syntax tree + semantic model pairs.
    /// @param loadDiagnostics The compile diagnostics surfaced while loading.
    /// @param projectDirectory The directory containing the project file, or `null` for an
    /// in-memory-loaded project ((cref:CSharpProjectLoader.LoadInMemory)).
    /// @param rootNamespace The project's effective root/default namespace (issue #2200), used to compute
    /// the namespace of a generated resx codebehind file; empty for an in-memory-loaded
    /// project.
    /// @param resxFiles The absolute paths of the `.resx` files discovered under
    /// [`projectDirectory`](paramref) (issue #2200), excluding the project's own
    /// `obj`/`bin` output directories.
    /// @param analyzerReferencePaths The on-disk analyzer/generator assembly paths the project references
    /// (issue #2215), forwarded by the Compile stage to gsc's `/analyzer:`
    /// flag so generator output reaches the cs2gs-compiled assembly the same
    /// way a real build would produce it.
    /// @param additionalFiles The non-source generator inputs (issue #2223) — the project's
    /// `@(AdditionalFiles)` plus discovered `.axaml` — forwarded to
    /// gsc/gsgen as Roslyn `AdditionalText` so file-driven generators (e.g.
    /// Avalonia's XAML name generator) can materialize their output.
    /// @param projectPath The loaded project file path, or `null` for in-memory inputs.
    /// @param isTestProject Whether evaluated MSBuild properties identify a test project.
    init(
        compilation CSharpCompilation,
        documents IReadOnlyList[LoadedDocument],
        loadDiagnostics IReadOnlyList[Diagnostic],
        projectDirectory string? = nil,
        rootNamespace string? = nil,
        resxFiles IReadOnlyList[string]? = nil,
        analyzerReferencePaths IReadOnlyList[string]? = nil,
        additionalFiles IReadOnlyList[string]? = nil,
        projectPath string? = nil,
        isTestProject bool = false
    ) {
        this.Compilation = compilation
        this.Documents = documents
        this.LoadDiagnostics = loadDiagnostics
        this.ProjectDirectory = projectDirectory
        this.RootNamespace = rootNamespace ?? string.Empty
        this.ResxFiles = resxFiles ?? ImmutableArray[string].Empty
        this.AnalyzerReferencePaths = analyzerReferencePaths ?? ImmutableArray[string].Empty
        this.AdditionalFiles = additionalFiles ?? ImmutableArray[string].Empty
        this.ProjectPath = projectPath
        this.IsTestProject = isTestProject
    }

    /// Gets the bound C# compilation.
    prop Compilation CSharpCompilation {
        get;
    }

    /// Gets the per-file syntax tree + semantic model pairs.
    prop Documents IReadOnlyList[LoadedDocument] {
        get;
    }

    /// Gets the compile diagnostics surfaced while loading.
    prop LoadDiagnostics IReadOnlyList[Diagnostic] {
        get;
    }

    /// Gets the directory containing the project file, or `null`
    /// for an in-memory-loaded project.
    prop ProjectDirectory string? {
        get;
    }

    /// Gets the project's effective root/default namespace (Roslyn's
    /// `Project.DefaultNamespace`, which reflects MSBuild's
    /// `<RootNamespace>`, falling back to the assembly/project file
    /// name) — issue #2200. Empty for an in-memory-loaded project.
    prop RootNamespace string {
        get;
    }

    /// Gets the absolute paths of the `.resx` files discovered under
    /// (cref:ProjectDirectory) (issue #2200), excluding the project's own
    /// `obj`/`bin` output directories. Each drives a generated
    /// `*.Designer.gs` codebehind via
    /// (cref:GSharp.Core.Resx.ResxCodeGenerator) instead of translating a
    /// hand-authored `*.Designer.cs` (which is skipped as generated source;
    /// see (cref:CSharpProjectLoader)'s auto-generated-header check).
    prop ResxFiles IReadOnlyList[string] {
        get;
    }

    /// Gets the on-disk analyzer/generator assembly paths the project
    /// references (issue #2215) — empty for an in-memory-loaded project.
    prop AnalyzerReferencePaths IReadOnlyList[string] {
        get;
    }

    /// Gets the non-source generator inputs (issue #2223) — the project's
    /// `@(AdditionalFiles)` plus discovered `.axaml` — forwarded to
    /// gsc/gsgen as Roslyn `AdditionalText`. Empty for an in-memory-loaded
    /// project.
    prop AdditionalFiles IReadOnlyList[string] {
        get;
    }

    /// Gets the loaded project file path, or `null`.
    prop ProjectPath string? {
        get;
    }

    /// Gets a value indicating whether this is an evaluated test project.
    prop IsTestProject bool {
        get;
    }

    /// Gets the subset of (cref:LoadDiagnostics) with
    /// (cref:DiagnosticSeverity.Error) severity — a non-empty list means
    /// the project does not bind in C# and the Translate stage should not run.
    prop ErrorDiagnostics IReadOnlyList[Diagnostic] -> this
        .LoadDiagnostics
        .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        .ToImmutableArray()

    /// Gets a value indicating whether the project bound with no C# errors.
    prop BoundWithoutErrors bool -> this.ErrorDiagnostics.Count == 0

    /// Gets a value indicating whether MSBuild itself failed to open the
    /// project (missing SDK/targets, an unresolvable project reference, an
    /// unsupported TFM, ...) — see
    /// (cref:CSharpProjectLoader.WorkspaceLoadFailureDiagnosticId)
    /// (ADR-0115 §C, issue #1742). Unlike (cref:BoundWithoutErrors), this
    /// ignores ordinary C# semantic errors from documents that did load (some
    /// corpus fixtures carry those deliberately to exercise a later stage), so
    /// pipeline stages should gate on THIS to stop before translating a project
    /// that never even bound, without misfiring on those fixtures.
    prop WorkspaceLoadFailed bool -> this.ErrorDiagnostics.Any(
        (d Diagnostic) -> d.Id == CSharpProjectLoader.WorkspaceLoadFailureDiagnosticId
    )

    /// Gets the subset of (cref:ErrorDiagnostics) that are MSBuild
    /// workspace load failures — the diagnostics a stage should surface when
    /// (cref:WorkspaceLoadFailed) is `true`.
    prop WorkspaceLoadErrors IReadOnlyList[Diagnostic] -> this
        .ErrorDiagnostics
        .Where((d Diagnostic) -> d.Id == CSharpProjectLoader.WorkspaceLoadFailureDiagnosticId)
        .ToImmutableArray()
}
