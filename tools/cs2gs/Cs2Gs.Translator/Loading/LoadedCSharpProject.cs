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
    public LoadedCSharpProject(
        CSharpCompilation compilation,
        IReadOnlyList<LoadedDocument> documents,
        IReadOnlyList<Diagnostic> loadDiagnostics)
    {
        this.Compilation = compilation;
        this.Documents = documents;
        this.LoadDiagnostics = loadDiagnostics;
    }

    /// <summary>Gets the bound C# compilation.</summary>
    public CSharpCompilation Compilation { get; }

    /// <summary>Gets the per-file syntax tree + semantic model pairs.</summary>
    public IReadOnlyList<LoadedDocument> Documents { get; }

    /// <summary>Gets the compile diagnostics surfaced while loading.</summary>
    public IReadOnlyList<Diagnostic> LoadDiagnostics { get; }

    /// <summary>
    /// Gets the subset of <see cref="LoadDiagnostics"/> with
    /// <see cref="DiagnosticSeverity.Error"/> severity — a non-empty list means
    /// the project does not bind in C# and the Translate stage should not run.
    /// </summary>
    public IReadOnlyList<Diagnostic> ErrorDiagnostics =>
        this.LoadDiagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).ToImmutableArray();

    /// <summary>Gets a value indicating whether the project bound with no C# errors.</summary>
    public bool BoundWithoutErrors => this.ErrorDiagnostics.Count == 0;
}
