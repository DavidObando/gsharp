// <copyright file="GeneratorRunner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost

import GSharp.Core.CodeAnalysis.Compilation
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.Diagnostics
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.InteropServices
import System.Runtime.Loader
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
    /// Each analyzer directory has a collectible dependency context. Roslyn stays
    /// in the host context so generator interfaces retain their identity.
    private class AnalyzerAssemblyLoader : AssemblyLoadContext, IAnalyzerAssemblyLoader, IDisposable {
        private let directory string
        private let dependencies AssemblyDependencyResolver

        init(path string) : base("gsgen-analyzers", true) {
            directory = Path.GetDirectoryName(Path.GetFullPath(path)) ?? Environment.CurrentDirectory
            dependencies = AssemblyDependencyResolver(Path.GetFullPath(path))
        }

        func AddDependencyLocation(fullPath string) {
            // Dependencies are resolved beside this analyzer, not another
            // analyzer with a different version of the same dependency.

        }

        func LoadFromPath(fullPath string) Assembly -> LoadFromAssemblyPath(Path.GetFullPath(fullPath))

        protected override func Load(name AssemblyName) Assembly? {
            let roslyn = typeof(ISourceGenerator).Assembly
            let csharp = typeof(CSharpCompilation).Assembly
            if name.Name == roslyn.GetName().Name {
                return roslyn
            }
            if name.Name == csharp.GetName().Name {
                return csharp
            }
            if name.Name is {} simpleName && FrameworkAssemblyNames.Contains(simpleName) {
                return AssemblyLoadContext.Default.LoadFromAssemblyName(name)
            }
            let candidate = dependencies.ResolveAssemblyToPath(name) ?? Path.Combine(
                directory,
                (name.Name ?? string.Empty) + ".dll"
            )
            return if File.Exists(candidate) {
                LoadFromPath(candidate)
            } else {
                nil
            }
        }

        protected override func LoadUnmanagedDll(name string) IntPtr {
            let path = dependencies.ResolveUnmanagedDllToPath(name)
            return if path == nil {
                IntPtr.Zero
            } else {
                LoadUnmanagedDllFromPath(path)
            }
        }

        func Dispose() -> Unload()

        shared {
            private let FrameworkAssemblyNames HashSet[string] = Directory
                .GetFiles(RuntimeEnvironment.GetRuntimeDirectory(), "*.dll")
                .Select((path string) -> Path.GetFileNameWithoutExtension(path))
                .ToHashSet(StringComparer.OrdinalIgnoreCase)
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
        using let discovery = Discover(analyzerAssemblyPaths)
        return RunDiscovered(stubCSharp, references, discovery, additionalTexts, optionsProvider)
    }

    /// Discovers real generators before a caller loads, binds, or projects G#.
    /// Dispose the result after the complete generation and translation request.
    /// @param analyzerAssemblyPaths Analyzer assemblies in resolution order.
    /// @returns Generators, load failures, and their request-scoped load contexts.
    func Discover(analyzerAssemblyPaths IReadOnlyList[string]) GeneratorDiscovery {
        using let phase = CompilationMeasurements.BeginPhase("generator.discovery")
        ArgumentNullException.ThrowIfNull(analyzerAssemblyPaths, paramName: "analyzerAssemblyPaths")
        CompilationMeasurements.Count("generator.analyzer_paths", analyzerAssemblyPaths.Count)
        let failures = List[GeneratorFailure]()
        let generators = List[ISourceGenerator]()
        let contexts = List[IDisposable]()
        let loaders = Dictionary[string, GeneratorRunner.AnalyzerAssemblyLoader](StringComparer.Ordinal)
        let analyzerHashes = HashSet[string](StringComparer.Ordinal)
        for path in analyzerAssemblyPaths {
            try {
                using let stream = File.OpenRead(path)
                let hash = Convert.ToHexString(SHA256.HashData(stream))
                if !analyzerHashes.Add(hash) {
                    continue
                }
                let fullPath = Path.GetFullPath(path)
                let directory = Path.GetDirectoryName(fullPath) ?? Environment.CurrentDirectory
                // Assemblies beside one another share their dependency closure.
                // Different package directories keep separate version identities.
                if !loaders.TryGetValue(directory, out var loader) {
                    loader = GeneratorRunner.AnalyzerAssemblyLoader(fullPath)
                    loaders.Add(directory, loader)
                    contexts.Add(loader)
                }
                let reference = AnalyzerFileReference(fullPath, loader)
                reference.AnalyzerLoadFailed += (_ object?, args AnalyzerLoadFailureEventArgs) -> {
                    failures.Add(GeneratorFailure("failed to load analyzer '$path': ${args.Message}", args.Exception))
                }
                generators.AddRange(reference.GetGenerators(LanguageNames.CSharp))
            } catch (ex Exception) {
                failures.Add(GeneratorFailure("failed to load analyzer '$path'", ex))
            }
        }
        CompilationMeasurements.Count("generator.generators", generators.Count)
        CompilationMeasurements.Count("generator.load_failures", failures.Count)
        CompilationMeasurements.Count("generator.load_contexts", contexts.Count)
        return GeneratorDiscovery(generators, failures, contexts)
    }

    /// Runs a discovery result without loading the analyzer assemblies again.
    /// @param stubCSharp Declaration-only C# projection.
    /// @param references Metadata references in project order.
    /// @param discovery Generators and load failures for this request.
    /// @param additionalTexts Non-source generator inputs.
    /// @param optionsProvider Project and additional-file options.
    /// @returns Generated source, diagnostics, and failures.
    func RunDiscovered(
        stubCSharp string,
        references IReadOnlyList[MetadataReference],
        discovery GeneratorDiscovery,
        additionalTexts IReadOnlyList[AdditionalText]? = nil,
        optionsProvider AnalyzerConfigOptionsProvider? = nil
    ) GeneratorRunResult {
        ArgumentNullException.ThrowIfNull(discovery, paramName: "discovery")
        return RunCore(
            stubCSharp,
            references,
            discovery.Generators,
            discovery.Failures.ToList(),
            additionalTexts,
            optionsProvider
        )
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
        if generators.Count == 0 {
            return GeneratorRunResult(Array.Empty[GeneratedCsDocument](), Array.Empty[Diagnostic](), failures)
        }
        using let phase = CompilationMeasurements.BeginPhase("generator.execution")
        CompilationMeasurements.Count("generator.host_csharp_trees_parsed")
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
                documents.Add(GeneratedCsDocument(source.HintName, source.SourceText, source.SyntaxTree))
            }
        }
        CompilationMeasurements.Count("generator.generated_documents", documents.Count)
        CompilationMeasurements.Count("generator.diagnostics", diagnostics.Count)
        return GeneratorRunResult(documents, diagnostics, failures, compilation)
    }
}

/// Request-scoped analyzer discovery. It never caches prior output or drivers.
class GeneratorDiscovery : IDisposable {
    private let contexts IReadOnlyList[IDisposable]

    internal init(
        generators IReadOnlyList[ISourceGenerator],
        failures IReadOnlyList[GeneratorFailure],
        contexts IReadOnlyList[IDisposable]
    ) {
        Generators = generators
        Failures = failures
        this.contexts = contexts
        LoadContexts = contexts.Select((context IDisposable) -> WeakReference(context)).ToArray()
    }

    /// Gets the actual generators, including generators that may emit no source.
    prop Generators IReadOnlyList[ISourceGenerator] {
        get;
    }

    /// Gets failures reported while loading analyzer assemblies or generators.
    prop Failures IReadOnlyList[GeneratorFailure] {
        get;
    }

    /// Gets weak lifetime probes so a worker can retire when an analyzer cannot unload.
    prop LoadContexts IReadOnlyList[WeakReference] {
        get;
    }

    /// Requests unloading after the caller releases the request's results.
    func Dispose() {
        for context in contexts {
            context.Dispose()
        }
    }
}
