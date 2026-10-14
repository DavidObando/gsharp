// <copyright file="GeneratorHostRunner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost

import Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.Diagnostics
import System
import System.Collections.Generic
import System.Linq

/// ADR-0145 §B/§C facade: drives the full source-generator loop for a bound G#
/// (cref:Compilation) — project to a C# stub, run the generators, and
/// back-translate their output into G# `partial` parts.
shared class GeneratorHostRunner {
    /// Runs the supplied generator instances over the projection of
    /// [`gsCompilation`](paramref) and back-translates their output.
    /// @param gsCompilation The bound G# compilation to project and generate against.
    /// @param references The metadata references the C# stub/generated code binds against.
    /// @param generators The incremental generators to run.
    /// @param additionalTexts Non-source inputs forwarded to generators as (cref:AdditionalText) (issue
    /// #2223).
    /// @param optionsProvider The MSBuild-derived generator options, or `null` for none.
    /// @returns The aggregate host result.
    func Run(
        gsCompilation Compilation,
        references IReadOnlyList[MetadataReference],
        generators IReadOnlyList[IIncrementalGenerator],
        additionalTexts IReadOnlyList[AdditionalText]? = nil,
        optionsProvider AnalyzerConfigOptionsProvider? = nil
    ) GeneratorHostResult {
        ArgumentNullException.ThrowIfNull(generators, paramName: "generators")
        let renderer = ProjectStub(gsCompilation, out var stub)
        let runResult = GeneratorRunner.Run(stub, references, generators, additionalTexts, optionsProvider)
        return Assemble(stub, runResult, references, renderer)
    }

    /// Runs generators loaded from analyzer assembly paths over the projection
    /// of [`gsCompilation`](paramref) and back-translates their output.
    /// @param gsCompilation The bound G# compilation to project and generate against.
    /// @param references The metadata references the C# stub/generated code binds against.
    /// @param analyzerAssemblyPaths The analyzer/generator assembly paths.
    /// @param additionalTexts Non-source inputs forwarded to generators as (cref:AdditionalText) (issue
    /// #2223).
    /// @param optionsProvider The MSBuild-derived generator options, or `null` for none.
    /// @returns The aggregate host result.
    func RunFromAnalyzerPaths(
        gsCompilation Compilation,
        references IReadOnlyList[MetadataReference],
        analyzerAssemblyPaths IReadOnlyList[string],
        additionalTexts IReadOnlyList[AdditionalText]? = nil,
        optionsProvider AnalyzerConfigOptionsProvider? = nil
    ) GeneratorHostResult {
        ArgumentNullException.ThrowIfNull(analyzerAssemblyPaths, paramName: "analyzerAssemblyPaths")
        let renderer = ProjectStub(gsCompilation, out var stub)
        let runResult = GeneratorRunner.RunFromAnalyzerPaths(
            stub,
            references,
            analyzerAssemblyPaths,
            additionalTexts,
            optionsProvider
        )
        return Assemble(stub, runResult, references, renderer)
    }

    private func ProjectStub(gsCompilation Compilation, out stub string) GsStubRenderer {
        stub = GsToCSharpProjection.ProjectToCSharp(gsCompilation, out var renderer)
        return renderer
    }

    private func Assemble(
        stub string,
        runResult GeneratorRunResult,
        references IReadOnlyList[MetadataReference],
        renderer GsStubRenderer
    ) GeneratorHostResult {
        // ADR-0192 follow-on 2: the lone declaring parts the stub offered to
        // generators, whose headers the generated implementing parts copy; and
        // the data types, whose generated parts are `data` parts.
        let translated = GeneratedDocTranslator.Translate(
            stub,
            runResult.Documents,
            references,
            renderer.PartialDefinitions,
            renderer.DataTypes
        )
        // Deterministic ordering: sort back-translated parts by hint name.
        let gsFiles = translated
            .OrderBy((t TranslatedGsDocument) -> t.HintName, StringComparer.Ordinal)
            .Select((t TranslatedGsDocument) -> (t.HintName, t.GSharpSource))
            .ToList()
        return GeneratorHostResult(
            gsFiles,
            runResult.GeneratorDiagnostics,
            runResult.Failures,
            renderer.Fallbacks,
            translated.SelectMany(
                func (t TranslatedGsDocument) IEnumerable[GeneratorHostDiagnostic] {
                    return t.HostDiagnostics
                }
            )
                .ToList()
        )
    }
}

/// The aggregate outcome of a (cref:GeneratorHostRunner) run (ADR-0145
/// §B/§C/§H): the back-translated G# parts, generator diagnostics, crash-
/// isolated failures, and the type-spelling fallbacks the stub projection hit.
class GeneratorHostResult {
    /// Initializes a new instance of the (cref:GeneratorHostResult) class.
    /// @param generatedGsFiles The back-translated G# parts (hint name + G# source).
    /// @param generatorDiagnostics The diagnostics reported by the generators.
    /// @param failures Crash-isolated generator/load failures.
    /// @param stubFallbacks The type-spelling fallbacks (GS9204) from the stub projection.
    /// @param hostDiagnostics Diagnostics the host itself reported (e.g. GS9208), or `null` for none.
    init(
        generatedGsFiles IReadOnlyList[(HintName string, GSharpSource string)],
        generatorDiagnostics IReadOnlyList[Diagnostic],
        failures IReadOnlyList[GeneratorFailure],
        stubFallbacks IReadOnlyList[string],
        hostDiagnostics IReadOnlyList[GeneratorHostDiagnostic]? = nil
    ) {
        GeneratedGsFiles = generatedGsFiles
        GeneratorDiagnostics = generatorDiagnostics
        Failures = failures
        StubFallbacks = stubFallbacks
        HostDiagnostics = hostDiagnostics ?? Array.Empty[GeneratorHostDiagnostic]()
    }

    /// Gets the back-translated G# parts (hint name + G# source).
    prop GeneratedGsFiles IReadOnlyList[(HintName string, GSharpSource string)] {
        get;
    }

    /// Gets the diagnostics reported by the generators.
    prop GeneratorDiagnostics IReadOnlyList[Diagnostic] {
        get;
    }

    /// Gets the crash-isolated generator/load failures.
    prop Failures IReadOnlyList[GeneratorFailure] {
        get;
    }

    /// Gets the type-spelling fallbacks (GS9204) from the stub projection.
    prop StubFallbacks IReadOnlyList[string] {
        get;
    }

    /// Gets the diagnostics the host itself reported (e.g. `GS9208`).
    prop HostDiagnostics IReadOnlyList[GeneratorHostDiagnostic] {
        get;
    }
}
