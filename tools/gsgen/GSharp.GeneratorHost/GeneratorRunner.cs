// <copyright file="GeneratorRunner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;

namespace GSharp.GeneratorHost;

/// <summary>
/// ADR-0145 §C: runs Roslyn incremental source generators against the C# stub
/// projection (<see cref="GsToCSharpProjection"/>). The stub is parsed and
/// compiled in-memory (never emitted), the generators are driven over it, and
/// every generated source is captured as a <see cref="GeneratedCsDocument"/>.
/// <para>
/// <b>Crash isolation.</b> A generator that throws — or an analyzer assembly
/// that fails to load — is recorded as a <see cref="GeneratorFailure"/> and
/// never propagates out of a <c>Run*</c> call, so one broken generator cannot
/// abort the host.
/// </para>
/// </summary>
public static class GeneratorRunner
{
    private const string StubAssemblyName = "GsgenStubs";

    /// <summary>
    /// Runs the supplied generator instances against the stub C#. Intended for
    /// tests and callers that already hold generator instances.
    /// </summary>
    /// <param name="stubCSharp">The declaration-only C# stub source.</param>
    /// <param name="references">The metadata references the stub compiles against.</param>
    /// <param name="generators">The incremental generators to run.</param>
    /// <returns>The aggregate generator run result.</returns>
    public static GeneratorRunResult Run(
        string stubCSharp,
        IReadOnlyList<MetadataReference> references,
        IReadOnlyList<IIncrementalGenerator> generators)
    {
        ArgumentNullException.ThrowIfNull(generators);
        return RunCore(
            stubCSharp,
            references,
            generators.Select(g => g.AsSourceGenerator()).ToList(),
            new List<GeneratorFailure>());
    }

    /// <summary>
    /// Production path: loads generators from each analyzer assembly path and
    /// runs them against the stub C#. A path that fails to load is recorded as a
    /// <see cref="GeneratorFailure"/> and skipped.
    /// </summary>
    /// <param name="stubCSharp">The declaration-only C# stub source.</param>
    /// <param name="references">The metadata references the stub compiles against.</param>
    /// <param name="analyzerAssemblyPaths">The analyzer/generator assembly paths.</param>
    /// <returns>The aggregate generator run result.</returns>
    public static GeneratorRunResult RunFromAnalyzerPaths(
        string stubCSharp,
        IReadOnlyList<MetadataReference> references,
        IReadOnlyList<string> analyzerAssemblyPaths)
    {
        ArgumentNullException.ThrowIfNull(analyzerAssemblyPaths);

        var failures = new List<GeneratorFailure>();
        var generators = new List<ISourceGenerator>();

        foreach (string path in analyzerAssemblyPaths)
        {
            try
            {
                var reference = new AnalyzerFileReference(path, AnalyzerAssemblyLoader.Instance);
                generators.AddRange(reference.GetGenerators(LanguageNames.CSharp));
            }
            catch (Exception ex)
            {
                failures.Add(new GeneratorFailure($"failed to load analyzer '{path}'", ex));
            }
        }

        // TODO(ADR-0145): forward AdditionalText / AnalyzerConfigOptionsProvider
        // to the driver once the production host needs generators that consume
        // them. The in-test / declaration-driven path does not require them.
        return RunCore(stubCSharp, references, generators, failures);
    }

    private static GeneratorRunResult RunCore(
        string stubCSharp,
        IReadOnlyList<MetadataReference> references,
        IReadOnlyList<ISourceGenerator> generators,
        List<GeneratorFailure> failures)
    {
        ArgumentNullException.ThrowIfNull(stubCSharp);
        ArgumentNullException.ThrowIfNull(references);

        SyntaxTree stubTree = CSharpSyntaxTree.ParseText(
            stubCSharp,
            new CSharpParseOptions(LanguageVersion.Latest),
            path: "GsgenStubs.cs");

        var compilation = CSharpCompilation.Create(
            StubAssemblyName,
            new[] { stubTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithAllowUnsafe(true));

        if (generators.Count == 0)
        {
            return new GeneratorRunResult(
                Array.Empty<GeneratedCsDocument>(),
                Array.Empty<Diagnostic>(),
                failures);
        }

        GeneratorDriver driver = CSharpGeneratorDriver.Create(generators);

        // RunGenerators never surfaces a generator's own exception; it is
        // captured on the per-generator GeneratorRunResult.Exception instead.
        driver = driver.RunGenerators(compilation);
        GeneratorDriverRunResult runResult = driver.GetRunResult();

        var documents = new List<GeneratedCsDocument>();
        var diagnostics = new List<Diagnostic>();

        foreach (Microsoft.CodeAnalysis.GeneratorRunResult perGenerator in runResult.Results)
        {
            if (perGenerator.Exception is not null)
            {
                string name = perGenerator.Generator.GetType().FullName ?? "generator";
                failures.Add(new GeneratorFailure($"generator '{name}' threw", perGenerator.Exception));
            }

            diagnostics.AddRange(perGenerator.Diagnostics);

            foreach (GeneratedSourceResult source in perGenerator.GeneratedSources)
            {
                documents.Add(new GeneratedCsDocument(source.HintName, source.SourceText));
            }
        }

        return new GeneratorRunResult(documents, diagnostics, failures);
    }

    /// <summary>
    /// A trivial <see cref="IAnalyzerAssemblyLoader"/> that loads analyzer
    /// assemblies from disk via <see cref="Assembly.LoadFrom(string)"/>.
    /// </summary>
    private sealed class AnalyzerAssemblyLoader : IAnalyzerAssemblyLoader
    {
        public static readonly AnalyzerAssemblyLoader Instance = new();

        public void AddDependencyLocation(string fullPath)
        {
            // No dependency-resolution bookkeeping needed for the simple
            // LoadFrom strategy; the CLR probes alongside the loaded assembly.
        }

        public Assembly LoadFromPath(string fullPath) => Assembly.LoadFrom(fullPath);
    }
}
