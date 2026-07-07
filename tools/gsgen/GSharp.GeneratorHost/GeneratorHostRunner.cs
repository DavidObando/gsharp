// <copyright file="GeneratorHostRunner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;

namespace GSharp.GeneratorHost;

/// <summary>
/// ADR-0145 §B/§C facade: drives the full source-generator loop for a bound G#
/// <see cref="Compilation"/> — project to a C# stub, run the generators, and
/// back-translate their output into G# <c>partial</c> parts.
/// </summary>
public static class GeneratorHostRunner
{
    /// <summary>
    /// Runs the supplied generator instances over the projection of
    /// <paramref name="gsCompilation"/> and back-translates their output.
    /// </summary>
    /// <param name="gsCompilation">The bound G# compilation to project and generate against.</param>
    /// <param name="references">The metadata references the C# stub/generated code binds against.</param>
    /// <param name="generators">The incremental generators to run.</param>
    /// <returns>The aggregate host result.</returns>
    public static GeneratorHostResult Run(
        Compilation gsCompilation,
        IReadOnlyList<MetadataReference> references,
        IReadOnlyList<IIncrementalGenerator> generators)
    {
        ArgumentNullException.ThrowIfNull(generators);
        string stub = ProjectStub(gsCompilation, out IReadOnlyList<string> fallbacks);
        GeneratorRunResult runResult = GeneratorRunner.Run(stub, references, generators);
        return Assemble(stub, runResult, references, fallbacks);
    }

    /// <summary>
    /// Runs generators loaded from analyzer assembly paths over the projection
    /// of <paramref name="gsCompilation"/> and back-translates their output.
    /// </summary>
    /// <param name="gsCompilation">The bound G# compilation to project and generate against.</param>
    /// <param name="references">The metadata references the C# stub/generated code binds against.</param>
    /// <param name="analyzerAssemblyPaths">The analyzer/generator assembly paths.</param>
    /// <returns>The aggregate host result.</returns>
    public static GeneratorHostResult RunFromAnalyzerPaths(
        Compilation gsCompilation,
        IReadOnlyList<MetadataReference> references,
        IReadOnlyList<string> analyzerAssemblyPaths)
    {
        ArgumentNullException.ThrowIfNull(analyzerAssemblyPaths);
        string stub = ProjectStub(gsCompilation, out IReadOnlyList<string> fallbacks);
        GeneratorRunResult runResult = GeneratorRunner.RunFromAnalyzerPaths(stub, references, analyzerAssemblyPaths);
        return Assemble(stub, runResult, references, fallbacks);
    }

    private static string ProjectStub(Compilation gsCompilation, out IReadOnlyList<string> fallbacks)
    {
        string stub = GsToCSharpProjection.ProjectToCSharp(gsCompilation, out GsStubRenderer renderer);
        fallbacks = renderer.Fallbacks;
        return stub;
    }

    private static GeneratorHostResult Assemble(
        string stub,
        GeneratorRunResult runResult,
        IReadOnlyList<MetadataReference> references,
        IReadOnlyList<string> fallbacks)
    {
        IReadOnlyList<TranslatedGsDocument> translated =
            GeneratedDocTranslator.Translate(stub, runResult.Documents, references);

        // Deterministic ordering: sort back-translated parts by hint name.
        var gsFiles = translated
            .OrderBy(t => t.HintName, StringComparer.Ordinal)
            .Select(t => (t.HintName, t.GSharpSource))
            .ToList();

        return new GeneratorHostResult(
            gsFiles,
            runResult.GeneratorDiagnostics,
            runResult.Failures,
            fallbacks);
    }
}

/// <summary>
/// The aggregate outcome of a <see cref="GeneratorHostRunner"/> run (ADR-0145
/// §B/§C/§H): the back-translated G# parts, generator diagnostics, crash-
/// isolated failures, and the type-spelling fallbacks the stub projection hit.
/// </summary>
public sealed class GeneratorHostResult
{
    /// <summary>
    /// Initializes a new instance of the <see cref="GeneratorHostResult"/> class.
    /// </summary>
    /// <param name="generatedGsFiles">The back-translated G# parts (hint name + G# source).</param>
    /// <param name="generatorDiagnostics">The diagnostics reported by the generators.</param>
    /// <param name="failures">Crash-isolated generator/load failures.</param>
    /// <param name="stubFallbacks">The type-spelling fallbacks (GS9204) from the stub projection.</param>
    public GeneratorHostResult(
        IReadOnlyList<(string HintName, string GSharpSource)> generatedGsFiles,
        IReadOnlyList<Diagnostic> generatorDiagnostics,
        IReadOnlyList<GeneratorFailure> failures,
        IReadOnlyList<string> stubFallbacks)
    {
        GeneratedGsFiles = generatedGsFiles;
        GeneratorDiagnostics = generatorDiagnostics;
        Failures = failures;
        StubFallbacks = stubFallbacks;
    }

    /// <summary>Gets the back-translated G# parts (hint name + G# source).</summary>
    public IReadOnlyList<(string HintName, string GSharpSource)> GeneratedGsFiles { get; }

    /// <summary>Gets the diagnostics reported by the generators.</summary>
    public IReadOnlyList<Diagnostic> GeneratorDiagnostics { get; }

    /// <summary>Gets the crash-isolated generator/load failures.</summary>
    public IReadOnlyList<GeneratorFailure> Failures { get; }

    /// <summary>Gets the type-spelling fallbacks (GS9204) from the stub projection.</summary>
    public IReadOnlyList<string> StubFallbacks { get; }
}
