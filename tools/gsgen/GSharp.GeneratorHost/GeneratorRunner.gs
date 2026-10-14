// <copyright file="GeneratorRunner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost

import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.Diagnostics
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Security.Cryptography

/// ADR-0145 §C: runs Roslyn incremental source generators against the C# stub
/// projection ((cref:GsToCSharpProjection)). The stub is parsed and
/// compiled in-memory (never emitted), the generators are driven over it, and
/// every generated source is captured as a (cref:GeneratedCsDocument).
///
/// <b>Crash isolation.</b> A generator that throws — or an analyzer assembly
/// that fails to load — is recorded as a (cref:GeneratorFailure) and
/// never propagates out of a `Run*` call, so one broken generator cannot
/// abort the host.
shared class GeneratorRunner {
    /// A trivial (cref:IAnalyzerAssemblyLoader) that loads analyzer
    /// assemblies from disk via (cref:Assembly.LoadFrom(string)).
    private class AnalyzerAssemblyLoader : IAnalyzerAssemblyLoader {
        func AddDependencyLocation(fullPath string) {
            // No dependency-resolution bookkeeping needed for the simple
            // LoadFrom strategy; the CLR probes alongside the loaded assembly.

        }

        func LoadFromPath(fullPath string) Assembly -> Assembly.LoadFrom(fullPath)

        shared {
            let Instance GeneratorRunner.AnalyzerAssemblyLoader = GeneratorRunner.AnalyzerAssemblyLoader()
        }
    }

    private const StubAssemblyName string = "GsgenStubs"

    /// Runs the supplied generator instances against the stub C#. Intended for
    /// tests and callers that already hold generator instances.
    /// @param stubCSharp The declaration-only C# stub source.
    /// @param references The metadata references the stub compiles against.
    /// @param generators The incremental generators to run.
    /// @param additionalTexts Non-source inputs forwarded to generators as (cref:AdditionalText) (issue
    /// #2223).
    /// @param optionsProvider The MSBuild-derived generator options, or `null` for none.
    /// @returns The aggregate generator run result.
    func Run(
        stubCSharp string,
        references IReadOnlyList[MetadataReference],
        generators IReadOnlyList[IIncrementalGenerator],
        additionalTexts IReadOnlyList[AdditionalText]? = nil,
        optionsProvider AnalyzerConfigOptionsProvider? = nil
    ) GeneratorRunResult {
        ArgumentNullException.ThrowIfNull(generators, paramName: "generators")
        return RunCore(
            stubCSharp,
            references,
            generators.Select((g IIncrementalGenerator) -> g.AsSourceGenerator()).ToList(),
            List[GeneratorFailure](),
            additionalTexts,
            optionsProvider
        )
    }

    /// Production path: loads generators from each analyzer assembly path and
    /// runs them against the stub C#. A path that fails to load is recorded as a
    /// (cref:GeneratorFailure) and skipped.
    /// @param stubCSharp The declaration-only C# stub source.
    /// @param references The metadata references the stub compiles against.
    /// @param analyzerAssemblyPaths The analyzer/generator assembly paths.
    /// @param additionalTexts Non-source inputs forwarded to generators as (cref:AdditionalText) (issue
    /// #2223).
    /// @param optionsProvider The MSBuild-derived generator options, or `null` for none.
    /// @returns The aggregate generator run result.
    func RunFromAnalyzerPaths(
        stubCSharp string,
        references IReadOnlyList[MetadataReference],
        analyzerAssemblyPaths IReadOnlyList[string],
        additionalTexts IReadOnlyList[AdditionalText]? = nil,
        optionsProvider AnalyzerConfigOptionsProvider? = nil
    ) GeneratorRunResult {
        ArgumentNullException.ThrowIfNull(analyzerAssemblyPaths, paramName: "analyzerAssemblyPaths")
        let failures = List[GeneratorFailure]()
        let generators = List[ISourceGenerator]()
        let analyzerHashes = HashSet[string](StringComparer.Ordinal)
        for path in analyzerAssemblyPaths {
            try {
                using let stream = File.OpenRead(path)
                let hash = Convert.ToHexString(SHA256.HashData(stream))
                if !analyzerHashes.Add(hash) {
                    continue
                }
                let reference = AnalyzerFileReference(path, GeneratorRunner.AnalyzerAssemblyLoader.Instance)
                generators.AddRange(reference.GetGenerators(LanguageNames.CSharp))
            } catch (ex Exception) {
                failures.Add(GeneratorFailure("failed to load analyzer '$path'", ex))
            }
        }
        return RunCore(stubCSharp, references, generators, failures, additionalTexts, optionsProvider)
    }

    private func RunCore(
        stubCSharp string,
        references IReadOnlyList[MetadataReference],
        generators IReadOnlyList[ISourceGenerator],
        failures List[GeneratorFailure],
        additionalTexts IReadOnlyList[AdditionalText]? = nil,
        optionsProvider AnalyzerConfigOptionsProvider? = nil
    ) GeneratorRunResult {
        ArgumentNullException.ThrowIfNull(stubCSharp, paramName: "stubCSharp")
        ArgumentNullException.ThrowIfNull(references, paramName: "references")
        let stubTree = CSharpSyntaxTree.ParseText(
            stubCSharp,
            CSharpParseOptions(LanguageVersion.Latest),
            path: "GsgenStubs.cs"
        )
        let compilation = CSharpCompilation.Create(
            StubAssemblyName,
            []SyntaxTree{stubTree},
            references,
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Enable
            )
                .WithAllowUnsafe(true)
        )
        if generators.Count == 0 {
            return GeneratorRunResult(Array.Empty[GeneratedCsDocument](), Array.Empty[Diagnostic](), failures)
        }
        // ADR-0145 §C / issue #2223: forward the project's non-source inputs
        // (e.g. Avalonia .axaml) and their MSBuild options so file/options-driven
        // generators can find and process them.
        var driver GeneratorDriver = CSharpGeneratorDriver.Create(
            generators,
            additionalTexts: additionalTexts?.ToImmutableArray() ?? ImmutableArray[AdditionalText].Empty,
            parseOptions: cast[CSharpParseOptions](stubTree.Options),
            optionsProvider: optionsProvider
        )
        // RunGenerators never surfaces a generator's own exception; it is
        // captured on the per-generator GeneratorRunResult.Exception instead.
        driver = driver.RunGenerators(compilation)
        let runResult = driver.GetRunResult()
        let documents = List[GeneratedCsDocument]()
        let diagnostics = List[Diagnostic]()
        for perGenerator in runResult.Results {
            if perGenerator.Exception != nil {
                let name = perGenerator.Generator.GetType().FullName ?? "generator"
                failures.Add(GeneratorFailure("generator '$name' threw", perGenerator.Exception))
            }
            diagnostics.AddRange(perGenerator.Diagnostics)
            for source in perGenerator.GeneratedSources {
                documents.Add(GeneratedCsDocument(source.HintName, source.SourceText))
            }
        }
        return GeneratorRunResult(documents, diagnostics, failures)
    }
}
