// <copyright file="GeneratorRunResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace GSharp.GeneratorHost;

/// <summary>
/// The aggregate outcome of running Roslyn source generators against the C#
/// stub projection (ADR-0145 §C): the generated documents, the diagnostics the
/// generators reported, and any crash-isolated failures.
/// </summary>
public sealed class GeneratorRunResult
{
    /// <summary>
    /// Initializes a new instance of the <see cref="GeneratorRunResult"/> class.
    /// </summary>
    /// <param name="documents">The generated C# documents.</param>
    /// <param name="generatorDiagnostics">The diagnostics reported by the generators.</param>
    /// <param name="failures">Generators that threw or analyzer assemblies that failed to load.</param>
    public GeneratorRunResult(
        IReadOnlyList<GeneratedCsDocument> documents,
        IReadOnlyList<Diagnostic> generatorDiagnostics,
        IReadOnlyList<GeneratorFailure> failures)
    {
        Documents = documents;
        GeneratorDiagnostics = generatorDiagnostics;
        Failures = failures;
    }

    /// <summary>Gets the generated C# documents (hint name + source text).</summary>
    public IReadOnlyList<GeneratedCsDocument> Documents { get; }

    /// <summary>Gets the diagnostics reported by the generators.</summary>
    public IReadOnlyList<Diagnostic> GeneratorDiagnostics { get; }

    /// <summary>Gets the generators that threw or analyzer assemblies that failed to load.</summary>
    public IReadOnlyList<GeneratorFailure> Failures { get; }
}

/// <summary>
/// One generated C# document produced by a Roslyn source generator: its
/// generator-assigned <c>hintName</c> and the emitted <see cref="SourceText"/>
/// (ADR-0145 §C).
/// </summary>
public sealed class GeneratedCsDocument
{
    /// <summary>
    /// Initializes a new instance of the <see cref="GeneratedCsDocument"/> class.
    /// </summary>
    /// <param name="hintName">The generator-assigned hint name (e.g. <c>Foo.g.cs</c>).</param>
    /// <param name="sourceText">The generated C# source text.</param>
    public GeneratedCsDocument(string hintName, SourceText sourceText)
    {
        HintName = hintName;
        SourceText = sourceText;
    }

    /// <summary>Gets the generator-assigned hint name.</summary>
    public string HintName { get; }

    /// <summary>Gets the generated C# source text.</summary>
    public SourceText SourceText { get; }
}

/// <summary>
/// A generator that threw during execution or an analyzer assembly that failed
/// to load. Recording (rather than propagating) these keeps a single broken
/// generator from aborting the whole host run — ADR-0145 §C crash isolation.
/// </summary>
public sealed class GeneratorFailure
{
    /// <summary>
    /// Initializes a new instance of the <see cref="GeneratorFailure"/> class.
    /// </summary>
    /// <param name="source">A description of the failing generator or analyzer path.</param>
    /// <param name="exception">The captured exception.</param>
    public GeneratorFailure(string source, System.Exception exception)
    {
        Source = source;
        Exception = exception;
    }

    /// <summary>Gets a description of the failing generator or analyzer path.</summary>
    public string Source { get; }

    /// <summary>Gets the captured exception.</summary>
    public System.Exception Exception { get; }
}
