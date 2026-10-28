// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Text
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Diagnostics
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Execution
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.IO
import GSharp.Core.CodeAnalysis.Analyzers
import System.ComponentModel
import System.Reflection.PortableExecutable
import GSharp.Workers

/// Entry point to gsc, the GSharp command-line compiler.
open class Program {
    private enum OutputTarget {
        Exe,
        Library
    }

    private class CommandLineArgs {
        init() {
            SourceFiles = List[string]()
            References = List[string]()
            Resources = List[(Path string, Name string, IsPublic bool)]()
            AnalyzerPaths = List[string]()
            GsAnalyzerPaths = List[string]()
            DiagnosticSeverityOverrides = Dictionary[string, DiagnosticSeverity?](StringComparer.OrdinalIgnoreCase)
            AdditionalFiles = List[string]()
            GlobalOptions = List[string]()
            NoWarnIds = HashSet[string](StringComparer.OrdinalIgnoreCase)
            WarnAsErrorIds = HashSet[string](StringComparer.OrdinalIgnoreCase)
            WarnNotAsErrorIds = HashSet[string](StringComparer.OrdinalIgnoreCase)
        }

        prop SourceFiles List[string] {
            get;
        }

        prop References List[string] {
            get;
        }

        /// Gets the managed resources to embed, as source path and logical name pairs.
        prop Resources List[(Path string, Name string, IsPublic bool)] {
            get;
        }

        /// Gets the analyzer/generator assembly paths (from /analyzer:<path>). Non-empty triggers a gsgen run
        /// (issue #2215).
        prop AnalyzerPaths List[string] {
            get;
        }

        prop GsAnalyzerPaths List[string] {
            get;
        }

        prop DiagnosticSeverityOverrides Dictionary[string, DiagnosticSeverity?] {
            get;
        }

        /// Gets the raw additional-file specs (from /additionalfile:<path[;key=value]>) forwarded to gsgen
        /// (issue #2223).
        prop AdditionalFiles List[string] {
            get;
        }

        /// Gets the raw generator global options (from /globaloption:<key=value>) forwarded to gsgen (issue
        /// #2223).
        prop GlobalOptions List[string] {
            get;
        }

        /// Gets or sets an explicit override for the resolved gsgen.dll path (from /gsgentool:<path>).
        prop GsgenToolPath string?

        /// Gets or sets the SDK package tools folder (from /sdktoolsdir:<dir>). It holds the portable
        /// gsgen and runtime files (ADR-0207).
        prop SdkToolsDir string?

        prop OutputPath string?
        prop RefOutputPath string?
        prop AssemblyName string?
        private var _target OutputTarget = OutputTarget.Exe

        prop Target OutputTarget {
            get {
                return _target
            }
            set {
                _target = value
            }
        }

        prop TargetFramework string?
        prop ShowHelp bool
        private var _implicitSystemImport bool = true

        prop ImplicitSystemImport bool {
            get {
                return _implicitSystemImport
            }
            set {
                _implicitSystemImport = value
            }
        }

        /// Gets or sets how oblivious imported reference positions are read
        /// (from /nullability:<mode>, ADR-0186). <b>ADR-0186 step 3
        /// flipped the default to
        /// <see cref="NullabilityMode.PlatformTypes" /></b>: an oblivious
        /// imported reference position is the platform type `T!`.
        /// `/nullability:enabled` selects ADR-0136's older reading, in
        /// which such a position is `T?`. `/nullability:oblivious`
        /// (ADR-0186 §9, step 5) reads imports as `platform-types` does
        /// and additionally makes this compilation's own unadorned reference
        /// declarations `T!`.
        ///
        /// This property, not `NullabilityOptions.DefaultMode`, is what
        /// governs `gsc` — `Program` assigns it to
        /// `Compilation.Nullability` unconditionally, so the ambient
        /// default is only ever observed by an embedder that constructs a
        /// `Compilation` directly (the language server, the REPL, and
        /// the test suite). Both had to move for the flip to be complete.
        private var _nullability NullabilityMode = NullabilityMode.PlatformTypes

        prop Nullability NullabilityMode {
            get {
                return _nullability
            }
            set {
                _nullability = value
            }
        }

        /// Gets or sets a value indicating whether ADR-0186 §4's runtime nil
        /// check is inserted at each `T! -> T` coercion (from
        /// /platform-nil-checks:<on|off>). Defaults to
        /// `true`.
        private var _platformNilChecks bool = true

        prop PlatformNilChecks bool {
            get {
                return _platformNilChecks
            }
            set {
                _platformNilChecks = value
            }
        }

        /// Gets the set of diagnostic IDs to suppress (from /nowarn).
        prop NoWarnIds HashSet[string] {
            get;
        }

        /// Gets or sets a value indicating whether all warnings should be treated as errors (from /warnaserror
        /// without IDs).
        prop TreatAllWarningsAsErrors bool

        /// Gets the set of diagnostic IDs that should be promoted to errors (from /warnaserror+:<ids>).
        prop WarnAsErrorIds HashSet[string] {
            get;
        }

        /// Gets the set of diagnostic IDs that should remain as warnings (from /warnaserror-:<ids>), overriding
        /// /warnaserror.
        prop WarnNotAsErrorIds HashSet[string] {
            get;
        }

        /// Gets or sets the requested PDB emit format (from /debug, /debug:<value>, /debug+/-). Defaults to
        /// None.
        private var _debugFormat DebugInformationFormat = DebugInformationFormat.None

        prop DebugFormat DebugInformationFormat {
            get {
                return _debugFormat
            }
            set {
                _debugFormat = value
            }
        }

        /// Gets or sets a value indicating whether emitted assemblies allow JIT optimization (from /optimize,
        /// /optimize+/-). Defaults to true.
        private var _optimize bool = true

        prop Optimize bool {
            get {
                return _optimize
            }
            set {
                _optimize = value
            }
        }

        /// Gets or sets a value indicating whether a /debug, /debug+, or /debug- switch was observed on the
        /// command line. Used so that a bare /pdb:<path> can default the format to Portable without overriding
        /// a later /debug-.
        prop DebugFlagSeen bool

        /// Gets or sets the explicit sidecar PDB path (from /pdb:<path>). Null means "default to
        /// {OutputPath}.pdb".
        prop PdbPath string?

        /// Gets or sets the XML documentation output path (from /doc:<path>).
        prop DocumentationFile string?

        /// Gets or sets the path to a Source Link JSON file (from /sourcelink:<path>).
        prop SourceLinkPath string?

        /// Gets or sets a value indicating whether the emit should be deterministic (from /deterministic,
        /// /deterministic+/-).
        prop Deterministic bool

        /// Gets or sets a value indicating whether all primary source files are embedded in the Portable PDB
        /// (from /embed, /embed+/-).
        prop EmbedAllSources bool

        /// Gets or sets the informational version string stamped on the output assembly (from /version:).
        prop Version string?

        /// Gets or sets the log file path (from /log:<file>). When non-null, a (cref:FileLogger) is created and
        /// attached to the compilation.
        prop LogPath string?

        private var maxWorkers int32 = 1

        prop MaxWorkers int32 {
            get -> maxWorkers
            set -> maxWorkers = value
        }

        private var workerMemoryBudgetMiB int32 = 1024

        prop WorkerMemoryBudgetMiB int32 {
            get -> workerMemoryBudgetMiB
            set -> workerMemoryBudgetMiB = value
        }
    }

    private class CommandLineException : Exception {
        init(message string) : base(message) { }
    }

    shared {
        private const Success int32 = 0
        private const Error int32 = 1
        private var workerCanReuse bool = true

        /// Entry point to the GSharp compiler.
        /// @param args Command line arguments.
        /// @returns Exit code.
        func Main(args[]string) int32 {
            if args.Length == 2 && args[0] == "--compiler-worker" {
                return WorkerServer.Run(
                    typeof(Program).Assembly.Location,
                    RunWorkerRequest,
                    () -> workerCanReuse,
                    args[1]
                )
            }
            return Compile(args, requireOutput: false)
        }

        internal func RunWorkerRequest(args[]string) int32 -> Compile(args, requireOutput: true)

        private func Compile(args[]string, requireOutput bool) int32 {
            if args.Length == 0 {
                Console.Error.WriteLine("Must specify path to a file via arguments.")
                return Error
            }
            var parsed CommandLineArgs
            try {
                parsed = ParseCommandLine(args)
                ReferenceResolver.SdkToolsDirectory = parsed.SdkToolsDir
            } catch (ex CommandLineException) {
                Console.Error.WriteLine(ex.Message)
                return Error
            } catch (ex IOException) {
                return ReportFatalIOError(ex)
            } catch (ex UnauthorizedAccessException) {
                return ReportFatalIOError(ex)
            }
            if requireOutput && parsed.OutputPath == nil {
                Console.Error.WriteLine("Compiler workers require /out; evaluation must use the standalone driver.")
                return Error
            }
            if requireOutput && parsed.References.Count == 0 {
                Console.Error.WriteLine("Compiler workers require explicit /reference inputs.")
                return Error
            }
            if requireOutput {
                // Analyzer code may retain threads or process events. Do not run
                // another request in that process until unload isolation is proven.
                workerCanReuse = parsed.GsAnalyzerPaths.Count == 0
            }
            if parsed.ShowHelp {
                PrintHelp()
                return Success
            }
            if parsed.SourceFiles.Count == 0 {
                Console.Error.WriteLine("Must specify at least one source file.")
                return Error
            }
            try {
                using let measurements = CompilationMeasurements.StartFromEnvironment("gsc")
                using let requestPhase = CompilationMeasurements.BeginPhase("compilation")
                CompilationMeasurements.SetProperty("target-framework", parsed.TargetFramework ?? "unspecified")
                CompilationMeasurements.SetProperty("nullability", parsed.Nullability.ToString())
                CompilationMeasurements.SetProperty("optimize", parsed.Optimize.ToString())
                CompilationMeasurements.SetProperty("deterministic", parsed.Deterministic.ToString())
                // Issue #2215: when /analyzer: paths are supplied, spawn gsgen (a
                // sibling process — ADR-0027 keeps Roslyn out of gsc) to run the
                // project's source generators and fold the generated .gs into this
                // same compilation. Zero analyzers (the overwhelmingly common case)
                // is a true no-op: no process spawned, no extra I/O.
                var allSourceFiles = parsed.SourceFiles
                if parsed.AnalyzerPaths.Count > 0 {
                    if !TryRunGsgen(parsed, out var generatedGsFiles) {
                        return Error
                    }
                    allSourceFiles = List[string](parsed.SourceFiles)
                    allSourceFiles.AddRange(generatedGsFiles)
                }
                var granted = parsed.MaxWorkers
                if int32.TryParse(Environment.GetEnvironmentVariable("GSHARP_WORKER_GRANT"), out var requestGrant) &&
                    requestGrant > 0 {
                    granted = Math.Min(granted, requestGrant)
                }
                let workBudget = CompilationWorkBudget(granted, parsed.WorkerMemoryBudgetMiB)
                let syntaxTrees = [allSourceFiles.Count]SyntaxTree
                CompilationMeasurements.Count("input.sources", allSourceFiles.Count)
                if CompilationMeasurements.IsEnabled {
                    let supplied = if int32.TryParse(
                        Environment.GetEnvironmentVariable("GSHARP_WORKER_GRANT"),
                        out var grant
                    ) &&
                        grant > 0 {
                        grant
                    } else {
                        workBudget.MaxWorkers
                    }
                    CompilationMeasurements.Count("workers.granted", supplied)
                    CompilationMeasurements.Count("workers.active", 1)
                }
                let fullPaths = [allSourceFiles.Count]string
                var largestSource int64 = 0
                var totalSourceBytes int64 = 0
                for var index = 0; index < allSourceFiles.Count; index++ {
                    let path = allSourceFiles[index]
                    if !File.Exists(path) {
                        Console.Error.WriteLine("Unable to find specified file $path")
                        return Error
                    }
                    // Resolve to an absolute path so the document name recorded in the
                    // PDB is rooted. Debuggers (vsdbg/coreclr) match on-disk breakpoints
                    // against the PDB document name; a relative name leaves source
                    // unresolvable, which surfaces as a phantom tab with
                    // "Could not load source ...: Incorrect format of 'source' message."
                    let fullPath = Path.GetFullPath(path)
                    fullPaths[index] = fullPath
                    if CompilationMeasurements.IsEnabled || workBudget.MaxWorkers > 1 {
                        let sourceBytes = FileInfo(fullPath).Length
                        largestSource = Math.Max(largestSource, sourceBytes)
                        totalSourceBytes += sourceBytes
                        if CompilationMeasurements.IsEnabled {
                            CompilationMeasurements.Count("input.source-bytes", sourceBytes)
                        }
                    }
                }
                let usesRuntimeReferences = parsed.OutputPath == nil || parsed.References.Count == 0
                using let snapshotPhase = CompilationMeasurements.BeginPhase(
                    "references.runtime-snapshot",
                    usesRuntimeReferences
                )
                let hostSnapshot = if usesRuntimeReferences {
                    ReferenceResolver.CaptureHostAssemblies()
                } else {
                    default(ImmutableArray[System.Reflection.Assembly])
                }
                snapshotPhase?.Dispose()
                using let parsePhase = CompilationMeasurements.BeginPhase("parse")
                workBudget.Run(
                    fullPaths.Length,
                    (index int32) -> {
                        let fullPath = fullPaths[index]
                        syntaxTrees[index] = SyntaxTree.Load(fullPath)
                    },
                    Math.Max(16777216, largestSource * 16),
                    allowParallel: fullPaths.Length >= 4 || totalSourceBytes >= 65536
                )
                CompilationMeasurements.Count("parse.workers.active", workBudget.LastObservedWorkers)
                parsePhase?.Dispose()
                using let referencePhase = CompilationMeasurements.BeginPhase("references.setup")
                if !ReferenceResolver.TryValidateDriverReferencePaths(parsed.References, out var referenceError) {
                    Console.Error.WriteLine(referenceError)
                    return Error
                }
                let referencePaths = ReferenceResolver.ResolveDriverReferencePaths(parsed.References)
                CompilationMeasurements.Count("input.references", referencePaths.Count)
                using let references = if parsed.OutputPath == nil {
                    ReferenceResolver.WithRuntimeReferences(referencePaths, hostSnapshot)
                } else {
                    (
                        if parsed.References.Count > 0 {
                            ReferenceResolver.WithReferences(referencePaths)
                        } else {
                            ReferenceResolver.WithRuntimeReferences(referencePaths, hostSnapshot)
                        }
                    )
                }
                referencePhase?.Dispose()
                let logger ILogger = if parsed.LogPath != nil {
                    cast[ILogger](FileLogger(parsed.LogPath!!))
                } else {
                    cast[ILogger](NullLogger.Instance)
                }
                try {
                    logger.LogInfo(
                        "Starting compiler. Sources: ${parsed.SourceFiles.Count}; Output: ${parsed.OutputPath ?? "<none>"}"
                    )
                    if !ReportMissingTransitiveReferences(references, parsed, syntaxTrees[0]) {
                        Console.Error.WriteLine("Failed.")
                        return Error
                    }
                    let compilation = Compilation(references, syntaxTrees){
                        WorkBudget = workBudget,
                        ImplicitSystemImport = parsed.ImplicitSystemImport,
                        Nullability = parsed.Nullability,
                        PlatformNilChecks = parsed.PlatformNilChecks,
                        IsLibrary = parsed.Target == OutputTarget.Library,
                        Optimize = parsed.Optimize,
                        Logger = logger,
                        AssemblyName = parsed.AssemblyName,
                        EmbeddedResources = parsed
                            .Resources
                            .Select(
                            (resource(Path string, Name string, IsPublic bool)) -> (
                                resource.Name,
                                File.ReadAllBytes(Path.GetFullPath(resource.Path)),
                                resource.IsPublic
                            )
                        )
                            .ToImmutableArray(),
                        DebugInformation = {
                            Format = parsed.DebugFormat,
                            PdbFilePath = parsed.PdbPath,
                            SourceLinkFilePath = parsed.SourceLinkPath,
                            Deterministic = parsed.Deterministic,
                            EmbedAllSources = parsed.EmbedAllSources
                        }
                    }
                    let outputPath string? = parsed.OutputPath
                    if outputPath == nil {
                        // Legacy / no-output mode (ADR-0156 Phase 1): compile with
                        // the real emitter into memory and execute in-process,
                        // preserving the historical evaluate-mode driver protocol.
                        return ExecuteInMemory(compilation, parsed, referencePaths)
                    }
                    return Emit(compilation, parsed, outputPath)
                } finally {
                    (logger as IDisposable)?.Dispose()
                }
            } catch (ex IOException) {
                // I/O failures during source loading, directory creation, output
                // file creation, or assembly emit must surface as a structured
                // diagnostic with a non-zero exit code rather than crashing gsc.
                return ReportFatalIOError(ex)
            } catch (ex UnauthorizedAccessException) {
                // Permission-denied while reading sources or writing outputs.
                return ReportFatalIOError(ex)
            } catch (ex Exception) when !(ex is OutOfMemoryException) && !(ex is StackOverflowException) {
                // 6.2 SilentEmitFailure invariant (outer ring): any exception
                // that escapes Compilation.Emit or compilation setup becomes a
                // GS9998 on stdout, using a carried source anchor when available.
                return ReportUnhandledException(ex)
            }
        }

        // Tokenizes a single response-file line, splitting on whitespace while
        // respecting double-quote delimiters. Quotes are stripped from the
        // resulting tokens but the content between them (including spaces) is
        // preserved as a single token. A doubled quote ("") inside a quoted
        // section emits a literal quote character. Behavior matches what csc /
        // dotnet build accept for response files.
        internal func TokenizeResponseFileLine(line string) List[string] {
            let tokens = List[string]()
            if string.IsNullOrEmpty(line) {
                return tokens
            }
            let sb = StringBuilder()
            var inQuotes = false
            var hasToken = false
            for var i = 0; i < line.Length; i++ {
                let c = line[i]
                if c == '"' {
                    if inQuotes && i + 1 < line.Length && line[i + 1] == '"' {
                        // Escaped quote inside a quoted section.
                        sb.Append('"')
                        hasToken = true
                        i++
                    } else {
                        inQuotes = !inQuotes
                        hasToken = true
                    }
                } else if !inQuotes && char.IsWhiteSpace(c) {
                    if hasToken {
                        tokens.Add(sb.ToString())
                        sb.Clear()
                        hasToken = false
                    }
                } else {
                    sb.Append(c)
                    hasToken = true
                }
            }
            if hasToken {
                tokens.Add(sb.ToString())
            }
            return tokens
        }

        internal func ReportUnhandledException(ex Exception) int32 {
            DiagnosticWriter.WriteDiagnostics(Console.Out, []Diagnostic{Compilation.CreateInternalErrorDiagnostic(ex)})
            if Environment.GetEnvironmentVariable("GS_DEBUG_STACK") != nil {
                Console.Out.WriteLine(ex.ToString())
            }
            return Error
        }

        private func ReportFatalIOError(ex Exception) int32 {
            // Emit in the csc-compatible "gsc: error GS9997: <message>" form so
            // the SDK BuildTask's diagnostic regex surfaces it as a structured
            // MSBuild error rather than an opaque process crash.
            let descriptor = DiagnosticDescriptors.FatalCompilerIOError
            Console.Error.WriteLine(
                "gsc: error ${descriptor.Id}: ${string.Format(descriptor.MessageFormat, ex.Message)}"
            )
            return Error
        }

        private func ReportMissingTransitiveReferences(
            references ReferenceResolver?,
            args CommandLineArgs,
            firstSource SyntaxTree
        ) bool {
            if references == nil || references.MissingTransitiveReferences.IsDefaultOrEmpty {
                return true
            }
            // GS9100 is advisory: the resolver already degrades gracefully (the
            // affected members are skipped), but a genuinely under-referenced
            // project benefits from naming the missing assemblies (issue #340).
            // Anchor the diagnostic at the first source file so the SDK BuildTask's
            // diagnostic regex surfaces it with its effective severity.
            let names = string.Join(", ", references.MissingTransitiveReferences)
            let diagnostic = Diagnostic(
                TextLocation(firstSource.Text, TextSpan(0, 0)),
                "GS9100",
                DiagnosticSeverity.Warning,
                "One or more referenced assemblies depend on assemblies that were not supplied via /r: ($names). " +
                    "Members that reference these assemblies will be skipped. Ensure the full transitive closure of references is passed (e.g. add the missing package or project reference)."
            )
            let effective = ApplySuppressPromote([]Diagnostic{diagnostic}, args)
            if effective.Any() {
                DiagnosticWriter.WriteDiagnostics(Console.Out, effective)
            }
            return !effective.Any((d Diagnostic) -> d.IsError)
        }

        // ADR-0156 Phase 1: bare gsc no longer interprets. The program is emitted
        // to memory and executed in-process by the shared host, keeping the
        // driver protocol: diagnostics to stdout, "Success."/"Failed." trailer,
        // exit code 0 on success (the program's own return value is discarded,
        // as evaluate mode always did — use /out: for a real executable).
        private func ExecuteInMemory(
            compilation Compilation,
            args CommandLineArgs,
            referencePaths IReadOnlyList[string]
        ) int32 {
            let result = EmittedProgramHost.Run(compilation, referencePaths)
            if result.Diagnostics.Any() {
                let effective = ApplySuppressPromote(result.Diagnostics, args)
                DiagnosticWriter.WriteDiagnostics(Console.Out, effective)
                if effective.Any((d Diagnostic) -> d.IsError) {
                    Console.Error.WriteLine("Failed.")
                    return Error
                }
            }
            if result.UnhandledException != nil {
                // Mirror the CLR host's unhandled-exception protocol so the
                // in-memory driver and `dotnet exec` render crashes identically.
                Console.Error.WriteLine(EmittedProgramHost.FormatUnhandledException(result.UnhandledException!!))
                return EmittedProgramHost.UnhandledExceptionExitCode
            }
            Console.WriteLine("Success.")
            return Success
        }

        /// Emitted channels and native slices reference their SDK runtime assemblies.
        /// Under the SDK, MSBuild's
        /// copy-local puts that assembly beside the app; a direct `gsc /out:`
        /// invocation has no such step, so gsc copies each referenced runtime itself.
        /// A program whose PE has no corresponding AssemblyRef gets nothing extra.
        /// A destination copy is refreshed only when the bundled runtime is newer.
        /// @param outputPath The emitted assembly.
        private func CopyBundledRuntimeBeside(outputPath string) {
            CopyBundledRuntimeBeside(
                outputPath,
                ReferenceResolver.FindBundledChannelsRuntimePath(AppContext.BaseDirectory)
            )
            CopyBundledRuntimeBeside(
                outputPath,
                ReferenceResolver.FindBundledValuesRuntimePath(AppContext.BaseDirectory)
            )
        }

        private func CopyBundledRuntimeBeside(outputPath string, bundled string?) {
            try {
                let outputDir = Path.GetDirectoryName(Path.GetFullPath(outputPath))
                if bundled == nil || string.IsNullOrEmpty(outputDir) {
                    return
                }
                let destination = Path.Combine(outputDir!!, Path.GetFileName(bundled))
                if string.Equals(Path.GetFullPath(bundled), destination, StringComparison.OrdinalIgnoreCase) {
                    return
                }
                // A copy from an earlier compile into the same folder is refreshed
                // when the bundled runtime is newer — a stale runtime beside a fresh
                // program fails at run time with a missing member.
                if File.Exists(destination) && File.GetLastWriteTimeUtc(destination) >= File.GetLastWriteTimeUtc(
                    bundled
                ) {
                    return
                }
                using let peStream = File.OpenRead(outputPath)
                using let pe = PEReader(peStream)
                if !pe.HasMetadata {
                    return
                }
                let reader = pe.GetMetadataReader()
                let runtimeName = Path.GetFileNameWithoutExtension(bundled)
                for handle in reader.AssemblyReferences {
                    if string.Equals(
                        reader.GetString(reader.GetAssemblyReference(handle).Name),
                        runtimeName,
                        StringComparison.Ordinal
                    ) {
                        File.Copy(bundled, destination, overwrite: true)
                        return
                    }
                }
            } catch (IOException) {
                // Best effort: the program is still correct; only a direct-driver
                // run from that folder would need the assembly placed manually.

            } catch (UnauthorizedAccessException) { }
        }

        private func Emit(compilation Compilation, args CommandLineArgs, outputPath string) int32 {
            let outputDir = Path.GetDirectoryName(outputPath)
            if !string.IsNullOrEmpty(outputDir) {
                Directory.CreateDirectory(outputDir)
            }
            let refOutputPath = args.RefOutputPath
            if !string.IsNullOrEmpty(refOutputPath) {
                let refDir = Path.GetDirectoryName(refOutputPath)
                if !string.IsNullOrEmpty(refDir) {
                    Directory.CreateDirectory(refDir)
                }
            }
            let documentationOutputPath = args.DocumentationFile
            if !string.IsNullOrEmpty(documentationOutputPath) {
                let documentationDir = Path.GetDirectoryName(documentationOutputPath)
                if !string.IsNullOrEmpty(documentationDir) {
                    Directory.CreateDirectory(documentationDir)
                }
            }
            // Phase 3 / ADR-0027 §7.7a: when Portable PDB is requested, open the
            // sidecar stream alongside the PE. If the caller did not supply an
            // explicit /pdb:<path>, default to "<PE>.pdb" (csc.exe convention).
            // Embedded format keeps the PDB content inside the PE — no sidecar.
            var pdbOutputPath string? = nil
            if compilation.DebugInformation!!.Format == DebugInformationFormat.Portable {
                pdbOutputPath = compilation.DebugInformation!!.PdbFilePath
                if string.IsNullOrEmpty(pdbOutputPath) {
                    pdbOutputPath = Path.ChangeExtension(outputPath, ".pdb")
                }
                // Resolve to an absolute path so the CodeView entry recorded in
                // the PE points at a rooted sidecar location. Debuggers (vsdbg/
                // coreclr) require an absolute PDB path to bind breakpoints; a
                // relative /out:<path> would otherwise leave the sidecar
                // reference unresolvable from the debugger's working directory.
                // Mirrors the source-path fix in commit 34002ff.
                pdbOutputPath = Path.GetFullPath(pdbOutputPath)
                compilation.DebugInformation!!.PdbFilePath = pdbOutputPath
                let pdbDir = Path.GetDirectoryName(pdbOutputPath)
                if !string.IsNullOrEmpty(pdbDir) {
                    Directory.CreateDirectory(pdbDir)
                }
            }
            var result EmitResult
            let createdOutputs = List[string]()
            try {
                using let peStream = CreateOutput(outputPath, createdOutputs)
                using let refStream = if string.IsNullOrEmpty(refOutputPath) {
                    default(FileStream?)
                } else {
                    CreateOutput(refOutputPath!!, createdOutputs)
                }
                using let pdbStream = if pdbOutputPath == nil {
                    default(FileStream?)
                } else {
                    CreateOutput(pdbOutputPath, createdOutputs)
                }
                using let docStream = if string.IsNullOrEmpty(documentationOutputPath) {
                    default(FileStream?)
                } else {
                    CreateOutput(documentationOutputPath!!, createdOutputs)
                }
                result = compilation.Emit(
                    peStream,
                    pdbStream,
                    refStream,
                    docStream,
                    args.AssemblyName,
                    args.Version,
                    GetTargetFrameworkMoniker(args.TargetFramework)
                )
            } catch {
                for path in createdOutputs {
                    TryDelete(path)
                }
                rethrow
            }
            // ADR-0169: run G# analyzers over the same compilation (BoundProgram
            // is cached, so this does not re-bind) and merge their diagnostics
            // into the post-hoc severity pass below.
            var mergedDiagnostics IEnumerable[Diagnostic] = result.Diagnostics
            if args.GsAnalyzerPaths.Count > 0 {
                mergedDiagnostics = mergedDiagnostics.Concat(GSharpAnalyzerHost.Run(compilation, args.GsAnalyzerPaths))
            }
            // Apply /gsdiag, /nowarn, /warnaserror filtering.
            let effectiveDiagnostics = ApplySuppressPromote(mergedDiagnostics, args)
            // Always print diagnostics (errors and warnings).
            if effectiveDiagnostics.Any() {
                DiagnosticWriter.WriteDiagnostics(Console.Out, effectiveDiagnostics)
            }
            let hasErrors = !result.Success || effectiveDiagnostics.Any((d Diagnostic) -> d.IsError)
            if hasErrors {
                TryDelete(outputPath)
                if !string.IsNullOrEmpty(refOutputPath) {
                    TryDelete(refOutputPath)
                }
                if !string.IsNullOrEmpty(pdbOutputPath) {
                    TryDelete(pdbOutputPath)
                }
                if !string.IsNullOrEmpty(documentationOutputPath) {
                    TryDelete(documentationOutputPath)
                }
                Console.Error.WriteLine("Failed.")
                return Error
            }
            if args.Target == OutputTarget.Exe {
                WriteRuntimeConfig(outputPath, args.TargetFramework)
            }
            CopyBundledRuntimeBeside(outputPath)
            Console.WriteLine("Wrote $outputPath")
            if !string.IsNullOrEmpty(refOutputPath) {
                Console.WriteLine("Wrote $refOutputPath")
            }
            return Success
        }

        private func GetTargetFrameworkMoniker(targetFramework string?) string? {
            if string.IsNullOrWhiteSpace(targetFramework) {
                return nil
            }
            let tfm = targetFramework.Split('-')[0]
            if tfm.StartsWith("netstandard", StringComparison.OrdinalIgnoreCase) {
                return ".NETStandard,Version=v" + tfm.Substring("netstandard".Length)
            }
            if tfm.StartsWith("netcoreapp", StringComparison.OrdinalIgnoreCase) {
                return ".NETCoreApp,Version=v" + tfm.Substring("netcoreapp".Length)
            }
            if !tfm.StartsWith("net", StringComparison.OrdinalIgnoreCase) {
                return nil
            }
            let version = tfm.Substring(3)
            if version.Contains('.') {
                let identifier = if int32.TryParse(version.Split('.')[0], out var major) && major >= 5 {
                    ".NETCoreApp"
                } else {
                    ".NETFramework"
                }
                return "$identifier,Version=v$version"
            }
            if version.Length < 2 || !version.All(char.IsDigit) {
                return nil
            }
            return ".NETFramework,Version=v" + string.Join(".", version.Select((c char) -> c.ToString()))
        }

        /// Applies /gsdiag, /nowarn, /warnaserror, /warnaserror+:, /warnaserror-: filtering to a diagnostic
        /// list.
        /// Returns the filtered/promoted set.
        private func ApplySuppressPromote(diagnostics IEnumerable[Diagnostic], args CommandLineArgs) IReadOnlyList[
            Diagnostic
        ] {
            let result = List[Diagnostic]()
            for d in diagnostics {
                let id = d.Id
                var severity = d.Severity
                // /gsdiag:<ID>=<severity> overrides come first: "none" suppresses,
                // and an explicit severity replaces the default (which can promote
                // a Hidden diagnostic into visibility).
                if args.DiagnosticSeverityOverrides.TryGetValue(id, out var overrideSeverity) {
                    if overrideSeverity == nil {
                        continue
                    }
                    severity = overrideSeverity
                }
                // Hidden diagnostics are never surfaced on the command line unless
                // severity configuration promoted them above.
                if severity == DiagnosticSeverity.Hidden {
                    continue
                }
                // /nowarn suppresses warning-level diagnostics with the specified ID.
                if severity == DiagnosticSeverity.Warning && args.NoWarnIds.Contains(id) {
                    continue
                }
                // /warnaserror+:<id> promotes specific warnings to errors.
                if severity == DiagnosticSeverity.Warning && args.WarnAsErrorIds.Contains(id) {
                    severity = DiagnosticSeverity.Error
                }
                // GS9100 is advisory under global promotion. Explicit diagnostic promotion still applies.
                if severity == DiagnosticSeverity.Warning &&
                    args.TreatAllWarningsAsErrors &&
                    id != "GS9100" &&
                    !args
                    .WarnNotAsErrorIds
                    .Contains(id) {
                    severity = DiagnosticSeverity.Error
                }
                result.Add(d.WithSeverity(severity))
            }
            return result
        }

        private func CreateOutput(path string, createdOutputs List[string]) FileStream {
            try {
                let stream = FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None)
                createdOutputs.Add(path)
                return stream
            } catch (IOException) when File.Exists(path) {
                let target = File.ResolveLinkTarget(path, returnFinalTarget: true)
                if target != nil && !target.Exists {
                    // Track a new dangling-link target without deleting the existing link.
                    return CreateOutput(target.FullName, createdOutputs)
                }
                // Keep the existing overwrite policy without claiming ownership of an existing file.
                return FileStream(path, FileMode.Truncate, FileAccess.ReadWrite, FileShare.None)
            }
        }

        private func TryDelete(path string) {
            try {
                File.Delete(path)
            } catch (IOException) {
                // Best-effort cleanup; ignore.

            } catch (UnauthorizedAccessException) { }
        }

        private func WriteRuntimeConfig(assemblyPath string, targetFramework string?) {
            let tfm = if string.IsNullOrEmpty(targetFramework) {
                "net10.0"
            } else {
                targetFramework!!
            }
            let (frameworkName, frameworkVersion) = ResolveFrameworkMoniker(tfm)
            let configPath = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json")
            let json = (`{
  "runtimeOptions": {
    "tfm": "` + "$tfm" + `",
    "framework": {
      "name": "` + "$frameworkName" + `",
      "version": "` + "$frameworkVersion" + `"
    },
    "rollForward": "LatestMinor"
  }
}`)
            File.WriteAllText(configPath, json)
        }

        /// Issue #2215: runs `gsgen` as a sibling process (ADR-0027 — Roslyn
        /// never links into gsc) over the caller's already-resolved `/analyzer:`
        /// paths, so any gsc invocation (SDK build, cs2gs, tests, direct compiles)
        /// gets generator output uniformly. gsgen's own diagnostics are already
        /// formatted in gsc's canonical header line, so stdout/stderr are relayed
        /// through unchanged.
        /// @param parsed The parsed command line (source files, references, analyzer paths).
        /// @param generatedGsFiles The generated `.g.gs` paths from gsgen's manifest, on success.
        /// @returns `true` on success; `false` if gsgen could not be launched or exited non-zero.
        private func TryRunGsgen(parsed CommandLineArgs, out generatedGsFiles List[string]) bool {
            generatedGsFiles = List[string]()
            let gsgenPath = ResolveGsgenToolPath(parsed)
            if !File.Exists(gsgenPath) {
                return ReportGsgenFailure(
                    "/analyzer was supplied but gsgen was not found at '$gsgenPath'. Pass /gsgentool:<path> to override."
                )
            }
            // ponytail: a one-shot temp workspace; not cleaned up afterwards (the
            // generated .g.gs files must outlive this method to be loaded as syntax
            // trees below). Left for the OS temp reaper — gsc's invocations of gsgen
            // are rare (only with /analyzer:) so this is not worth the bookkeeping
            // of a deferred delete after the syntax trees are read into memory.
            let workDir = Directory.CreateTempSubdirectory("gsc-gsgen-").FullName
            let outDir = Path.Combine(workDir, "out")
            let manifestPath = Path.Combine(workDir, "manifest.txt")
            let rspPath = Path.Combine(workDir, "gsgen.rsp")
            let rspLines = List[string]()
            for gs in parsed.SourceFiles {
                rspLines.Add("/gs:\"${Path.GetFullPath(gs)}\"")
            }
            for r in parsed.References {
                rspLines.Add("/r:\"$r\"")
            }
            for a in parsed.AnalyzerPaths {
                rspLines.Add("/analyzer:\"$a\"")
            }
            // Issue #2223: forward non-source generator inputs (.axaml) and project
            // options (build_property.*) so file/options-driven generators run.
            for af in parsed.AdditionalFiles {
                rspLines.Add("/additionalfile:\"$af\"")
            }
            for go_ in parsed.GlobalOptions {
                rspLines.Add("/globaloption:\"$go_\"")
            }
            rspLines.Add("/out:\"$outDir\"")
            rspLines.Add("/manifest:\"$manifestPath\"")
            File.WriteAllLines(rspPath, rspLines, Encoding.UTF8)
            let psi = ProcessStartInfo(ResolveLaunchHost(), "\"$gsgenPath\" @\"$rspPath\""){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            var proc Process?
            try {
                proc = Process.Start(psi)
            } catch (ex Exception) when ex is IOException || ex is Win32Exception {
                return ReportGsgenFailure("failed to launch gsgen ('$gsgenPath'): ${ex.Message}")
            }
            if proc == nil {
                return ReportGsgenFailure("failed to launch gsgen ('$gsgenPath'): no process was started.")
            }
            {
                using let _ = proc
                // Read stdout/stderr concurrently with waiting for exit: reading
                // them sequentially (ReadToEnd, then ReadToEnd, then WaitForExit)
                // deadlocks if gsgen fills the other pipe's OS buffer first.
                let stdoutTask = proc.StandardOutput.ReadToEndAsync()
                let stderrTask = proc.StandardError.ReadToEndAsync()
                const gsgenTimeoutMs = 5 * 60 * 1000
                if !proc.WaitForExit(gsgenTimeoutMs) {
                    try {
                        proc.Kill(entireProcessTree: true)
                    } catch (InvalidOperationException) {
                        // Process already exited between the timeout check and Kill.

                    }
                    return ReportGsgenFailure(
                        "gsgen timed out after ${gsgenTimeoutMs / 1000}s while running source generators."
                    )
                }
                let stdout = stdoutTask.GetAwaiter().GetResult()
                let stderr = stderrTask.GetAwaiter().GetResult()
                if !string.IsNullOrEmpty(stdout) {
                    Console.Out.Write(stdout)
                }
                if !string.IsNullOrEmpty(stderr) {
                    Console.Error.Write(stderr)
                }
                if proc.ExitCode != 0 {
                    if string.IsNullOrWhiteSpace(stdout) && string.IsNullOrWhiteSpace(stderr) {
                        return ReportGsgenFailure(
                            "gsgen exited with code ${proc.ExitCode} while running source generators."
                        )
                    }
                    return false
                }
            }
            if File.Exists(manifestPath) {
                for line in File.ReadAllLines(manifestPath) {
                    let trimmed = line.Trim()
                    if trimmed.Length > 0 {
                        generatedGsFiles.Add(trimmed)
                    }
                }
            }
            return true
        }

        private func ReportGsgenFailure(message string) bool {
            let descriptor = DiagnosticDescriptors.SourceGeneratorExecutionFailure
            Console.Error.WriteLine("gsc: error ${descriptor.Id}: ${string.Format(descriptor.MessageFormat, message)}")
            return false
        }

        /// Resolves the gsgen.dll path (ADR-0207). The order is: the /gsgentool: switch, the
        /// GSHARP_GSGEN_TOOL variable, gsgen/gsgen.dll under the SDK tools folder (the /sdktoolsdir:
        /// switch or the GSHARP_SDK_TOOLS_DIR variable), and last the packaged-SDK sibling convention
        /// (tools/compiler/gsc.dll + tools/gsgen/gsgen.dll under a shared tools/). The sibling
        /// convention is valid only for the IL gsc inside the SDK package.
        private func ResolveGsgenToolPath(parsed CommandLineArgs) string {
            if !string.IsNullOrEmpty(parsed.GsgenToolPath) {
                return parsed.GsgenToolPath!!
            }
            let fromEnvironment = Environment.GetEnvironmentVariable("GSHARP_GSGEN_TOOL")
            if !string.IsNullOrEmpty(fromEnvironment) {
                return Path.GetFullPath(fromEnvironment)
            }
            let sdkToolsDir = if string.IsNullOrEmpty(parsed.SdkToolsDir) {
                Environment.GetEnvironmentVariable("GSHARP_SDK_TOOLS_DIR")
            } else {
                parsed.SdkToolsDir
            }
            if !string.IsNullOrEmpty(sdkToolsDir) {
                return Path.GetFullPath(Path.Combine(sdkToolsDir, "gsgen", "gsgen.dll"))
            }
            return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "gsgen", "gsgen.dll"))
        }

        /// Gives the executable that starts gsgen: the host that runs this compiler, so that
        /// the child process has the same architecture (ADR-0207). The bare name `dotnet` is the
        /// fallback when the host is not the dotnet muxer.
        private func ResolveLaunchHost() string {
            let processPath = Environment.ProcessPath
            if !string.IsNullOrEmpty(processPath) && string.Equals(
                Path.GetFileNameWithoutExtension(processPath),
                "dotnet",
                StringComparison.OrdinalIgnoreCase
            ) {
                return processPath!!
            }
            return "dotnet"
        }

        private func ResolveFrameworkMoniker(tfm string)(Name string, Version string) {
            // Crude TFM → runtime framework mapping good enough for net8/9/10.
            // The "framework.version" is the minimum shared framework version to load.
            return switch tfm {
                case "net8.0": ("Microsoft.NETCore.App", "8.0.0")
                case "net9.0": ("Microsoft.NETCore.App", "9.0.0")
                case "net10.0": ("Microsoft.NETCore.App", "10.0.0")
                default: ("Microsoft.NETCore.App", "10.0.0")
            }
        }

        /// Prints usage/help text for the gsc command-line switches to stdout.
        private func PrintHelp() {
            Console.WriteLine(`Usage: gsc <source-files> [options]

Options:
  /out:<file>                   Output assembly path.
  /refout:<file>                Output reference assembly path.
  /assemblyname:<name>          Output assembly name.
  /version:<string>             Informational version stamped on the output assembly.
  /target:exe|library|lib|dll   Output type (default: exe).
  /targetframework:<tfm>        Target framework moniker (alias: /tfm:<tfm>).
  /r:<file>, /reference:<file>  Reference an assembly.
  /resource:<file>[,<name>[,public|private]]
                                Embed a managed resource (alias: /res).
  /analyzer:<file>              Analyzer/generator assembly; runs gsgen before compiling (repeatable).
  /gsgentool:<file>             Override the resolved path to gsgen.dll (default: sibling of gsc.dll).
  /sdktoolsdir:<dir>            SDK package tools folder with gsgen/ and the portable runtime files.
  /gsanalyzer:<file>            G# diagnostic analyzer assembly, run in-process after binding (repeatable, ADR-0169).
  /gsdiag:<ID>=<severity>       Per-diagnostic severity override: none, hidden, info, warning, or error (repeatable).
  /lib:<path>                   Accepted for csc compatibility (currently a no-op).
  /implicitimports[+|-]         Enable/disable implicit System import (alias: /implicit-imports).
  /noimplicitimports            Disable implicit System import (alias: /no-implicit-imports).
  /nullability:<mode>           How oblivious imported reference positions are read: platform-types (default, ADR-0186) or enabled (ADR-0136); oblivious also makes this compilation's own declarations oblivious (ADR-0186 §9).
  /platform-nil-checks:<on|off> Insert the ADR-0186 nil check where a platform value is coerced to a non-null type (default: on; off is an escape hatch, not a supported mode).
  /nowarn:<ids>                 Suppress the given diagnostic IDs (comma/semicolon separated).
  /warnaserror[+|-][:<ids>]     Treat warnings as errors, globally or for specific IDs.
  /optimize[+|-]                Enable/disable JIT optimization (default: enabled).
  /debug[+|-][:<value>]         Emit debug info: none, portable, full, pdbonly, embedded.
  /pdb:<file>                   Sidecar PDB path.
  /doc:<file>                   XML documentation output path.
  /sourcelink:<file>            Source Link JSON file.
  /deterministic[+|-]           Enable/disable deterministic emit.
  /embed[+|-]                   Embed all primary sources in the PDB.
  /additionalfile:<file>        Non-source generator input (e.g. Avalonia .axaml); forwarded to gsgen (repeatable).
  /globaloption:<key>=<value>   Project-wide generator option (build_property.*); forwarded to gsgen (repeatable).
  /log:<file>                   Write compiler diagnostic log to file.
  --workers:<1..32>             Opt into bounded within-project work (default: 1).
  --worker-memory-mib:<MiB>     Concurrent workspace budget, minimum 256 (default: 1024).
  /?, /help                     Show this help message.`)
        }

        private func ParseCommandLine(args[]string) CommandLineArgs {
            let result = CommandLineArgs()
            let expanded = ExpandResponseFiles(args)
            for raw in expanded {
                if raw.Length == 0 {
                    continue
                }
                if IsSwitch(raw) {
                    var body = raw.Substring(1)
                    if body.StartsWith("-", StringComparison.Ordinal) {
                        body = body.Substring(1)
                    }
                    let separator = IndexOfSwitchValueSeparator(body)
                    let name = if separator < 0 {
                        body
                    } else {
                        body.Substring(0, separator)
                    }
                    let value string? = if separator < 0 {
                        string.Empty
                    } else {
                        body.Substring(separator + 1)
                    }
                    switch name.ToLowerInvariant() {
                        case "workers" {
                            if !int32.TryParse(value, out var workers) || workers < 1 || workers > 32 {
                                throw CommandLineException("--workers requires an integer between 1 and 32.")
                            }
                            result.MaxWorkers = workers
                        }
                        case "worker-memory-mib" {
                            if !int32.TryParse(value, out var memory) || memory < 256 {
                                throw CommandLineException("--worker-memory-mib requires an integer of at least 256.")
                            }
                            result.WorkerMemoryBudgetMiB = memory
                        }
                        case "out" {
                            result.OutputPath = value
                        }
                        case "refout" {
                            result.RefOutputPath = value
                        }
                        case "assemblyname" {
                            result.AssemblyName = value
                        }
                        case "version" {
                            result.Version = value
                        }
                        case "target" {
                            result.Target = switch value!!.ToLowerInvariant() {
                                case "exe": OutputTarget.Exe
                                case "library" or "lib" or "dll": OutputTarget.Library
                                default: throw CommandLineException("Unsupported /target value: $value")
                            }
                        }
                        case "targetframework", "tfm" {
                            result.TargetFramework = value
                        }
                        case "r", "reference" {
                            // Loaded into the binder's ReferenceResolver so imports can resolve types
                            // declared in user-supplied assemblies in addition to the BCL.
                            result.References.Add(value!!)
                        }
                        case "resource", "res" {
                            if string.IsNullOrWhiteSpace(value) {
                                throw CommandLineException("/resource requires a path: /resource:<file>[,<name>].")
                            }
                            let resourceParts = value.Split([]char{','}, 3)
                            let resourcePath = resourceParts[0]
                            let resourceName = if resourceParts.Length < 2 {
                                Path.GetFileName(resourcePath)
                            } else {
                                resourceParts[1]
                            }
                            let resourceAccess = if resourceParts.Length < 3 {
                                "public"
                            } else {
                                resourceParts[2]
                            }
                            if string.IsNullOrWhiteSpace(resourcePath) || string.IsNullOrWhiteSpace(resourceName) {
                                throw CommandLineException("/resource requires a non-empty path and name.")
                            }
                            if !string.Equals(resourceAccess, "public", StringComparison.OrdinalIgnoreCase) &&
                                !string
                                .Equals(resourceAccess, "private", StringComparison.OrdinalIgnoreCase) {
                                throw CommandLineException("/resource access must be 'public' or 'private'.")
                            }
                            if result.Resources.Any(
                                (resource(Path string, Name string, IsPublic bool)) -> string.Equals(
                                    resource.Name,
                                    resourceName,
                                    StringComparison.Ordinal
                                )
                            ) {
                                throw CommandLineException("Duplicate resource name '$resourceName'.")
                            }
                            result.Resources.Add(
                                (
                                    resourcePath,
                                    resourceName,
                                    string.Equals(resourceAccess, "public", StringComparison.OrdinalIgnoreCase)
                                )
                            )
                        }
                        case "analyzer" {
                            // Issue #2215: an already-resolved generator/analyzer assembly path.
                            // Repeatable, like /reference. Presence triggers a gsgen sub-process
                            // run (ADR-0145) before compilation; gsc does no analyzer discovery
                            // of its own.
                            if string.IsNullOrEmpty(value) {
                                throw CommandLineException("/analyzer requires a path: /analyzer:<file>.")
                            }
                            result.AnalyzerPaths.Add(value)
                        }
                        case "gsanalyzer" {
                            // ADR-0169: a G# diagnostic-analyzer assembly, loaded
                            // in-process and run by GSharpAnalyzerDriver after
                            // binding. Distinct from /analyzer:, which names a
                            // Roslyn generator assembly for gsgen.
                            if string.IsNullOrEmpty(value) {
                                throw CommandLineException("/gsanalyzer requires a path: /gsanalyzer:<file>.")
                            }
                            result.GsAnalyzerPaths.Add(value)
                        }
                        case "gsdiag" {
                            // ADR-0169: /gsdiag:GS0001=error;PROBE001=none — per-
                            // diagnostic severity overrides applied in the same
                            // post-hoc pass as /nowarn. "none" suppresses; other
                            // values replace the severity (promoting Hidden
                            // surfaces it).
                            for pair in(value ?? string.Empty).Split(
                                []char{',', ';'},
                                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries
                            ) {
                                let equalsIndex = pair.IndexOf('=')
                                if equalsIndex <= 0 || equalsIndex == pair.Length - 1 {
                                    throw CommandLineException(
                                        "/gsdiag requires <ID>=<none|hidden|info|warning|error> entries."
                                    )
                                }
                                let id = ParseIdList(pair[.. equalsIndex]).Single()
                                let severityText = pair[(equalsIndex + 1) ..]
                                let severity DiagnosticSeverity? = switch severityText.ToLowerInvariant() {
                                    case "none": nil
                                    case "hidden": DiagnosticSeverity.Hidden
                                    case "info": DiagnosticSeverity.Info
                                    case "warning": DiagnosticSeverity.Warning
                                    case "error": DiagnosticSeverity.Error
                                    default: throw CommandLineException(
                                        "/gsdiag: unknown severity '$severityText'; expected none, hidden, info, warning, or error."
                                    )
                                }
                                result.DiagnosticSeverityOverrides[id] = severity
                            }
                        }
                        case "additionalfile" {
                            // Issue #2223: a non-source input (e.g. Avalonia .axaml)
                            // forwarded verbatim to gsgen as a Roslyn AdditionalText.
                            // Repeatable. Value may carry `;key=value` metadata pairs.
                            if string.IsNullOrWhiteSpace(value) {
                                throw CommandLineException("/additionalfile requires a path: /additionalfile:<file>.")
                            }
                            result.AdditionalFiles.Add(value)
                        }
                        case "globaloption" {
                            // Issue #2223: a project-wide generator option (build_property.*)
                            // forwarded verbatim to gsgen. Repeatable. Value is `key=value`.
                            if string.IsNullOrWhiteSpace(value) {
                                throw CommandLineException(
                                    "/globaloption requires a key=value: /globaloption:<key>=<value>."
                                )
                            }
                            result.GlobalOptions.Add(value)
                        }
                        case "gsgentool" {
                            // Overrides the resolved path to gsgen.dll. Optional: defaults to the
                            // sibling tools/gsgen/gsgen.dll next to gsc.dll (the packaged SDK
                            // layout). Mainly useful for tests and non-packaged (cs2gs) callers.
                            result.GsgenToolPath = value
                        }
                        case "sdktoolsdir" {
                            // The SDK package tools folder (ADR-0207). Gives gsgen and the
                            // portable runtime files when this gsc runs from another package.
                            result.SdkToolsDir = value
                        }
                        case "implicitimports", "implicit-imports" {
                            result.ImplicitSystemImport = ParseBoolFlag(value!!, defaultIfEmpty: true)
                        }
                        case "noimplicitimports", "no-implicit-imports" {
                            result.ImplicitSystemImport = false
                        }
                        case "nullability" {
                            // ADR-0186: how an oblivious imported reference
                            // position is read. `platform-types` reads it as the
                            // platform type `T!` and is the DEFAULT since step 3
                            // flipped it; `enabled` selects ADR-0136's older `T?`
                            // reading. The default lives on
                            // `CommandLineArgs.Nullability`, not here — this
                            // switch only overrides it — and the two statements
                            // have to agree, which is why `/help`'s wording is
                            // asserted by `Adr0186NullabilitySwitchTests`.
                            result.Nullability = switch value!!.ToLowerInvariant() {
                                case "enabled": NullabilityMode.Enabled
                                case "platform-types" or "platformtypes": NullabilityMode.PlatformTypes
                                case "oblivious": NullabilityMode.Oblivious
                                default: throw CommandLineException(
                                    "/nullability: unknown mode '$value'; expected enabled, platform-types or oblivious."
                                )
                            }
                        }
                        case "platformnilchecks", "platform-nil-checks" {
                            // ADR-0186 §4: the coercion check at each `T! -> T`
                            // boundary. On by default; `off` is a measurement and
                            // escape-hatch switch, STRICTLY WEAKER than either the
                            // old or the new model (the silenced sites are neither
                            // an error nor a check), and deliberately not a
                            // supported mode.
                            result.PlatformNilChecks = switch value!!.ToLowerInvariant() {
                                case "" or "on" or "true" or "+": true
                                case "off" or "false" or "-": false
                                default: throw CommandLineException(
                                    "/platform-nil-checks: unknown value '$value'; expected on or off."
                                )
                            }
                        }
                        case "nowarn" {
                            // /nowarn:GS0001,GS0002 or /nowarn:0001,0002
                            for id in ParseIdList(value!!) {
                                result.NoWarnIds.Add(id)
                            }
                        }
                        case "warnaserror", "warnaserror+" {
                            // /warnaserror  → global; /warnaserror+:<ids> → promote specific ids
                            // /warnaserror-:<ids> → demote specific ids (keep as warnings even with /warnaserror)
                            if string.IsNullOrEmpty(value) {
                                result.TreatAllWarningsAsErrors = true
                            } else {
                                for id in ParseIdList(value) {
                                    result.WarnAsErrorIds.Add(id)
                                }
                            }
                        }
                        case "warnaserror-" {
                            if string.IsNullOrEmpty(value) {
                                result.TreatAllWarningsAsErrors = false
                            } else {
                                for id in ParseIdList(value) {
                                    result.WarnNotAsErrorIds.Add(id)
                                }
                            }
                        }
                        case "optimize" {
                            result.Optimize = ParseBoolFlag(value!!, defaultIfEmpty: true)
                        }
                        case "optimize+" {
                            result.Optimize = true
                        }
                        case "optimize-" {
                            result.Optimize = false
                        }
                        case "debug" {
                            result.DebugFormat = ParseDebugValue(value!!)
                            result.DebugFlagSeen = true
                        }
                        case "debug+" {
                            // /debug+ is an alias for /debug with no value: enable portable.
                            result.DebugFormat = DebugInformationFormat.Portable
                            result.DebugFlagSeen = true
                        }
                        case "debug-" {
                            // /debug- explicitly disables debug emit, overriding any earlier /debug.
                            result.DebugFormat = DebugInformationFormat.None
                            result.DebugFlagSeen = true
                        }
                        case "pdb" {
                            // /pdb:<path> sets the sidecar PDB path. Only meaningful with
                            // a Portable format — if no /debug flag has been seen yet we
                            // imply Portable here, matching csc.exe behaviour.
                            if string.IsNullOrEmpty(value) {
                                throw CommandLineException("/pdb requires a path: /pdb:<file>.")
                            }
                            result.PdbPath = value
                            if !result.DebugFlagSeen {
                                result.DebugFormat = DebugInformationFormat.Portable
                            }
                        }
                        case "doc" {
                            if string.IsNullOrEmpty(value) {
                                throw CommandLineException("/doc requires a path: /doc:<file>.")
                            }
                            result.DocumentationFile = value
                        }
                        case "sourcelink" {
                            if string.IsNullOrEmpty(value) {
                                throw CommandLineException("/sourcelink requires a path: /sourcelink:<file>.")
                            }
                            result.SourceLinkPath = value
                        }
                        case "deterministic" {
                            result.Deterministic = ParseBoolFlag(value!!, defaultIfEmpty: true)
                        }
                        case "deterministic+" {
                            result.Deterministic = true
                        }
                        case "deterministic-" {
                            result.Deterministic = false
                        }
                        case "embed" {
                            // /embed[+/-] embeds all primary sources in the PDB.
                            // Bare /embed defaults to on, matching csc semantics.
                            result.EmbedAllSources = ParseBoolFlag(value!!, defaultIfEmpty: true)
                        }
                        case "embed+" {
                            result.EmbedAllSources = true
                        }
                        case "embed-" {
                            result.EmbedAllSources = false
                        }
                        case "log" {
                            result.LogPath = if string.IsNullOrWhiteSpace(value) {
                                DiagnosticLogPaths.GetDefaultFilePath("gsharp-compiler-debug.log")
                            } else {
                                value!!.Trim()
                            }
                        }
                        case "lib" { }
                        case "?", "help" {
                            result.ShowHelp = true
                        }
                        default {
                            throw CommandLineException("Unrecognized option: $raw. Use /? or /help for usage.")
                        }
                    }
                } else {
                    result.SourceFiles.Add(raw)
                }
            }
            return result
        }

        /// Parses a comma- or semicolon-separated list of diagnostic IDs. Accepts both canonical
        /// form (`GS0001`) and bare numeric form (`0001` or `1`). Semicolon is
        /// supported because MSBuild-forwarded properties such as NoWarn/WarningsAsErrors are
        /// conventionally semicolon-delimited (e.g. `$(NoWarn);GS0012`).
        private func ParseIdList(value string) sequence[string] {
            if string.IsNullOrWhiteSpace(value) {
                yield break
            }
            for raw in value.Split(
                []char{',', ';'},
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries
            ) {
                if raw.StartsWith("GS", StringComparison.OrdinalIgnoreCase) {
                    yield raw.ToUpperInvariant()
                } else if int32.TryParse(raw, out var num) {
                    // Bare number: normalise to GS#### form.
                    yield "GS${num:D4}"
                } else {
                    // Unrecognised format — pass through as-is.
                    yield raw
                }
            }
        }

        private func ExpandResponseFiles(args[]string) List[string] {
            let result = List[string](args.Length)
            for arg in args {
                if arg.Length > 0 && arg[0] == '@' {
                    let path = arg.Substring(1)
                    if !File.Exists(path) {
                        throw CommandLineException("Response file not found: $path")
                    }
                    for line in File.ReadAllLines(path, Encoding.UTF8) {
                        let trimmed = line.Trim()
                        if trimmed.Length == 0 || trimmed[0] == '#' {
                            continue
                        }
                        for token in TokenizeResponseFileLine(trimmed) {
                            result.Add(token)
                        }
                    }
                } else {
                    result.Add(arg)
                }
            }
            return result
        }

        private func ParseDebugValue(value string) DebugInformationFormat {
            // /debug, /debug+, /debug:portable, /debug:full → Portable
            // /debug:embedded → Embedded
            // /debug:none, /debug- → None
            if string.IsNullOrEmpty(value) {
                return DebugInformationFormat.Portable
            }
            return switch value.ToLowerInvariant() {
                case "none": DebugInformationFormat.None
                case "portable" or "full" or "pdbonly": DebugInformationFormat.Portable
                case "embedded": DebugInformationFormat.Embedded
                default: throw CommandLineException(
                    "Unsupported /debug value: $value. Expected one of: none, portable, full, pdbonly, embedded."
                )
            }
        }

        private func ParseBoolFlag(value string, defaultIfEmpty bool) bool {
            if string.IsNullOrEmpty(value) {
                return defaultIfEmpty
            }
            return switch value.ToLowerInvariant() {
                case "true" or "1" or "on" or "yes": true
                case "false" or "0" or "off" or "no": false
                default: throw CommandLineException("Unsupported boolean value: $value")
            }
        }

        private func IndexOfSwitchValueSeparator(value string) int32 {
            let colon = value.IndexOf(':')
            let equals = value.IndexOf('=')
            if colon < 0 {
                return equals
            }
            if equals < 0 {
                return colon
            }
            return Math.Min(colon, equals)
        }

        private func IsSwitch(arg string) bool {
            if arg.Length == 0 {
                return false
            }
            if arg[0] == '-' {
                return true
            }
            if arg[0] != '/' {
                return false
            }
            // `/?` is the canonical help switch.
            if arg == "/?" {
                return true
            }
            // On Unix `/` is also the path separator. We treat `/foo:value` as a
            // switch only if the substring before the first colon contains no other
            // path separator (e.g. `/out:bar.dll` is a switch but `/tmp/x.gs` is not).
            // For `/foo` (no colon) we treat it as a switch only when the name after
            // the leading `/` contains no path separators (e.g. `/warnaserror` is a
            // switch but `/tmp/x.gs` is a file path).
            let colon = arg.IndexOf(':')
            if colon < 0 {
                let nameOnly = arg.AsSpan(1)
                return nameOnly.IndexOfAny('/', '\\') < 0
            }
            let head = arg.AsSpan(1, colon - 1)
            return head.IndexOfAny('/', '\\') < 0
        }
    }
}
