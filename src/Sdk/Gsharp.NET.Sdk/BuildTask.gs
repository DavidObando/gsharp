// <copyright file="BuildTask.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.NET.Sdk.Tools

import Microsoft.Build.Framework
import Microsoft.Build.Utilities
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import System.Threading

/// MSBuild task that invokes `gsc` to compile a set of `.gs` sources
/// into a managed assembly. Modeled after Peachpie's
/// `Peachpie.NET.Sdk.Tools.BuildTask`.
open class BuildTask : Task, ICancelableTask {
    private let cts CancellationTokenSource = CancellationTokenSource()

    /// Gets or sets the full path to gsc.dll.
    @Required
    prop GsharpCompilerFullPath string?

    /// Gets or sets the directory where the final assembly is written.
    @Required
    prop OutputPath string?

    /// Gets or sets the base name (without extension) of the output assembly.
    @Required
    prop OutputName string?

    /// Gets or sets the temporary output (obj) path.
    @Required
    prop TempOutputPath string?

    /// Gets or sets the target framework moniker (e.g. net10.0).
    @Required
    prop TargetFramework string?

    /// Gets or sets the path of the response file to be written.
    prop ResponseFilePath string?

    /// Gets or sets the project base directory, used to resolve relative source paths.
    prop BasePath string?

    /// Gets or sets the optimization level (bool, level number, or "debug"/"release").
    private var _optimization string = bool.TrueString

    prop Optimization string {
        get {
            return _optimization
        }
        set {
            _optimization = value
        }
    }

    /// Gets or sets the requested debug type (full/portable/embedded/none).
    prop DebugType string?

    /// Gets or sets the PDB output path.
    prop PdbFile string?

    /// Gets or sets the path to a Source Link JSON file (forwarded to `gsc /sourcelink:`).
    prop SourceLink string?

    /// Gets or sets a value (parsed as a bool) controlling whether all primary
    /// source files are embedded in the Portable PDB (forwarded as
    /// `gsc /embed`). Maps to MSBuild's `EmbedAllSources` property.
    prop EmbedAllSources string?

    /// Gets or sets a value (parsed as a bool) controlling deterministic emit
    /// (forwarded as `gsc /deterministic`). Maps to MSBuild's
    /// `Deterministic` property.
    prop Deterministic string?

    /// Gets or sets the assembly version stamped on the output.
    prop Version string?

    /// Gets or sets the MSBuild OutputType (Exe / Library).
    prop OutputType string?

    /// Gets or sets the path of the metadata-only reference assembly to write (refint).
    prop RefAssembly string?

    /// Gets or sets the path of the XML documentation file to write.
    prop DocumentationFile string?

    /// Gets or sets the comma-separated list of diagnostic IDs to suppress (NoWarn MSBuild property).
    prop NoWarn string?

    /// Gets or sets a value indicating whether all warnings should be treated as errors
    /// (TreatWarningsAsErrors MSBuild property).
    prop TreatWarningsAsErrors string?

    /// Gets or sets the comma-separated list of diagnostic IDs to promote to errors (WarningsAsErrors
    /// MSBuild property).
    prop WarningsAsErrors string?

    /// Gets or sets the comma-separated list of diagnostic IDs that stay
    /// warnings even under (cref:TreatWarningsAsErrors) — the standard
    /// `WarningsNotAsErrors` MSBuild property, forwarded as
    /// `gsc /warnaserror-:`. Issue #3782: cs2gs's redundant-`!!`
    /// polish loop sets it to survey a whole project graph in one build
    /// instead of one project per round.
    prop WarningsNotAsErrors string?

    /// Gets or sets the Compile item group (the .gs sources).
    private var _compile[]?ITaskItem = Array.Empty[ITaskItem]()

    prop Compile[]?ITaskItem {
        get {
            return _compile
        }
        set {
            _compile = value
        }
    }

    /// Gets or sets the ReferencePath item group (resolved metadata references).
    private var _references[]ITaskItem = Array.Empty[ITaskItem]()!!

    prop References[]ITaskItem {
        get {
            return _references
        }
        set {
            _references = value
        }
    }

    /// Gets or sets the managed resources to embed.
    private var _resources[]ITaskItem = Array.Empty[ITaskItem]()!!

    prop Resources[]ITaskItem {
        get {
            return _resources
        }
        set {
            _resources = value
        }
    }

    /// Gets or sets the G# diagnostic-analyzer assemblies forwarded to gsc via /gsanalyzer: (ADR-0169).
    private var _gsAnalyzers[]ITaskItem = Array.Empty[ITaskItem]()!!

    prop GsAnalyzers[]ITaskItem {
        get {
            return _gsAnalyzers
        }
        set {
            _gsAnalyzers = value
        }
    }

    /// Gets or sets whether the task should return arguments without invoking gsc.
    prop SkipCompilerExecution string?

    /// Gets or sets whether the task should expose the generated compiler arguments.
    prop ProvideCommandLineArgs string?

    /// Gets or sets whether to reuse a bounded compiler worker. Defaults to false.
    prop UseSharedCompilation bool

    /// Gets or sets the per-request CPU grant supplied by the build scheduler.
    private var _workerGrant int32 = 1

    prop WorkerGrant int32 {
        get -> _workerGrant
        set -> _workerGrant = value
    }

    /// Gets or sets the requested within-project concurrency. Defaults to sequential execution.
    private var maxWorkers int32 = 1

    prop MaxWorkers int32 {
        get -> maxWorkers
        set -> maxWorkers = value
    }

    /// Gets or sets the concurrent workspace budget in MiB. This is not a total process heap limit.
    private var workerMemoryBudgetMiB int32 = 1024

    prop WorkerMemoryBudgetMiB int32 {
        get -> workerMemoryBudgetMiB
        set -> workerMemoryBudgetMiB = value
    }

    /// Gets the generated gsc command-line arguments for design-time builds.
    private var _commandLineArgs[]ITaskItem = Array.Empty[ITaskItem]()!!

    @Output
    prop CommandLineArgs[]ITaskItem {
        get {
            return _commandLineArgs
        }
        private set {
            _commandLineArgs = value
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Cancel() -> this.cts.Cancel()

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    open override func Execute() bool {
        if this.Compile == nil || this.Compile!!.Length == 0 {
            this.Log.LogError("No .gs sources to compile (the Compile item group is empty).")
            return false
        }
        let gsharpCompilerFullPath = (this.GsharpCompilerFullPath ?? string.Empty)
        let outputPath = (this.OutputPath ?? string.Empty)
        let outputName = (this.OutputName ?? string.Empty)
        let tempOutputPath = (this.TempOutputPath ?? string.Empty)
        let targetFramework = (this.TargetFramework ?? string.Empty)
        if string.IsNullOrEmpty(gsharpCompilerFullPath) || string.IsNullOrEmpty(outputPath) || string.IsNullOrEmpty(
            outputName
        ) ||
            string.IsNullOrEmpty(tempOutputPath) || string.IsNullOrEmpty(targetFramework) {
            this.Log.LogError(
                "BuildTask requires GsharpCompilerFullPath, OutputPath, OutputName, TempOutputPath, and TargetFramework."
            )
            return false
        }
        let args = List[string]{
            QuoteIfNeeded("/out:${Path.Combine(outputPath, outputName)}.dll"),
            "--workers:${this.MaxWorkers}",
            "--worker-memory-mib:${this.WorkerMemoryBudgetMiB}"
        }
        if !string.IsNullOrEmpty(outputName) {
            args.Add(QuoteIfNeeded("/assemblyname:$outputName"))
        }
        let outputType string? = this.OutputType
        if outputType != nil && outputType.Length != 0 {
            let t = if outputType.Equals("Exe", StringComparison.OrdinalIgnoreCase) {
                "exe"
            } else {
                "library"
            }
            args.Add("/target:$t")
        }
        if !string.IsNullOrEmpty(targetFramework) {
            args.Add("/targetframework:$targetFramework")
        }
        args.Add(
            if ParseBool(this.Optimization) {
                "/optimize+"
            } else {
                "/optimize-"
            }
        )
        if !string.IsNullOrEmpty(this.DebugType) {
            args.Add("/debug:${this.DebugType}")
        }
        if !string.IsNullOrEmpty(this.PdbFile) {
            args.Add(QuoteIfNeeded("/pdb:${this.PdbFile}"))
        }
        if !string.IsNullOrEmpty(this.SourceLink) {
            args.Add(QuoteIfNeeded("/sourcelink:${this.SourceLink}"))
        }
        if ParseBool(this.EmbedAllSources) {
            args.Add("/embed+")
        }
        if ParseBool(this.Deterministic) {
            args.Add("/deterministic+")
        }
        if !string.IsNullOrEmpty(this.Version) {
            args.Add("/version:${this.Version}")
        }
        if !string.IsNullOrEmpty(this.RefAssembly) {
            args.Add(QuoteIfNeeded("/refout:${this.RefAssembly}"))
        }
        if !string.IsNullOrEmpty(this.DocumentationFile) {
            args.Add(QuoteIfNeeded("/doc:${this.DocumentationFile}"))
        }
        if !string.IsNullOrEmpty(this.NoWarn) {
            args.Add("/nowarn:${this.NoWarn}")
        }
        if !string.IsNullOrEmpty(this.WarningsAsErrors) {
            args.Add("/warnaserror+:${this.WarningsAsErrors}")
        }
        if string.Equals(this.TreatWarningsAsErrors, "true", StringComparison.OrdinalIgnoreCase) {
            args.Add("/warnaserror")
        }
        if !string.IsNullOrEmpty(this.WarningsNotAsErrors) {
            args.Add("/warnaserror-:${this.WarningsNotAsErrors}")
        }
        for r in this.References {
            args.Add(QuoteIfNeeded("/r:${r.ItemSpec}"))
        }
        for analyzer in this.GsAnalyzers {
            args.Add(QuoteIfNeeded("/gsanalyzer:${analyzer.ItemSpec}"))
        }
        // ADR-0169: lower .editorconfig dotnet_diagnostic.<ID>.severity entries
        // to /gsdiag: switches so severity configuration works without gsc ever
        // parsing editorconfig files. Sorted for a deterministic rsp.
        if !string.IsNullOrEmpty(this.BasePath) {
            for entry in EditorConfigSeverityReader.ReadSeverities(this.BasePath!!).OrderBy(
                (pair KeyValuePair[string, string]) -> pair.Key,
                StringComparer.OrdinalIgnoreCase
            )!! {
                args.Add("/gsdiag:${entry.Key}=${entry.Value}")
            }
        }
        for resource in this.Resources {
            var name = resource.GetMetadata("LogicalName")
            if string.IsNullOrWhiteSpace(name) {
                name = resource.GetMetadata("ManifestResourceName")
            }
            if !string.IsNullOrWhiteSpace(name) &&
                (
                string.Equals(resource.GetMetadata("Type"), "Resx", StringComparison.OrdinalIgnoreCase) ||
                    resource
                    .ItemSpec
                    .EndsWith(".resources", StringComparison.OrdinalIgnoreCase)
            ) &&
                !name!!.EndsWith(".resources", StringComparison.Ordinal) {
                name += ".resources"
            }
            if string.IsNullOrWhiteSpace(name) {
                name = Path.GetFileName(resource.ItemSpec)
            }
            var access = resource.GetMetadata("Access")
            if string.IsNullOrWhiteSpace(access) {
                access = "public"
            }
            args.Add(QuoteIfNeeded("/resource:${resource.ItemSpec},$name,$access"))
        }
        for s in this.Compile!! {
            args.Add(QuoteIfNeeded(s.ItemSpec))
        }
        if ParseBool(this.ProvideCommandLineArgs) {
            let commandLineArgs = [args.Count]ITaskItem
            for var i = 0; i < args.Count; i++ {
                commandLineArgs[i] = TaskItem(args[i])
            }
            this.CommandLineArgs = commandLineArgs
        }
        if ParseBool(this.SkipCompilerExecution) {
            return true
        }
        var acquired WorkerCoreLease
        try {
            acquired = WorkerCoreLease.Acquire(
                this.BuildEngine,
                this.MaxWorkers,
                this.WorkerMemoryBudgetMiB,
                this.cts.Token
            )
        } catch (ex OperationCanceledException) {
            return false
        } catch (ex ArgumentException) {
            this.Log.LogError(ex.Message)
            return false
        }
        using let coreLease = acquired
        args[1] = "--workers:${coreLease.Grant}"
        if !string.IsNullOrEmpty(this.ResponseFilePath) {
            Directory.CreateDirectory(Path.GetDirectoryName(this.ResponseFilePath) ?? ".")
            File.WriteAllLines(this.ResponseFilePath, args, Encoding.UTF8)
        }
        if this.UseSharedCompilation && this.References.Length == 0 {
            this.Log.LogMessage(
                MessageImportance.High,
                "G# worker requires explicit references; using standalone compiler."
            )
        } else if this.UseSharedCompilation {
            if this.WorkerGrant < 1 {
                this.Log.LogError("WorkerGrant must be at least one.")
                return false
            }
            if this.BuildEngine is IBuildEngine4 engine {
                try {
                    let client = WorkerProcessClient.Get(engine, "GSharp.CompilerWorker")
                    if client.TryRun(
                        Path.GetFullPath(gsharpCompilerFullPath),
                        "--compiler-worker",
                        Path.GetFullPath(this.BasePath ?? Environment.CurrentDirectory),
                        []string{"@" + this.ResponseFilePath},
                        this.WorkerGrant,
                        this.cts.Token,
                        this.LogCompilerLine,
                        (line string) -> {
                            if line.Trim() == "Failed." {
                                this.Log.LogMessage(MessageImportance.Low, line)
                            } else {
                                this.Log.LogError(line)
                            }
                        },
                        (message string) -> this.Log.LogMessage(
                            if message.Contains("using standalone") {
                                MessageImportance.High
                            } else {
                                MessageImportance.Normal
                            },
                            message
                        ),
                        out var exitCode
                    ) {
                        if exitCode != 0 && !this.Log.HasLoggedErrors {
                            this.LogFailure(
                                "compiler worker exited with code $exitCode without emitting a structured diagnostic."
                            )
                        }
                        return exitCode == 0 && !this.Log.HasLoggedErrors
                    }
                } catch (ex OperationCanceledException) {
                    return false
                } catch (ex IOException) {
                    this.LogFailure("compiler worker transport failed; request was not retried: ${ex.Message}")
                    return false
                }
            } else {
                this.Log.LogMessage(
                    MessageImportance.High,
                    "G# worker unavailable in this MSBuild host; using standalone compiler."
                )
            }
        }
        let psi = ProcessStartInfo("dotnet", "\"$gsharpCompilerFullPath\" @\"${this.ResponseFilePath}\""){
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = this.BasePath ?? Environment.CurrentDirectory
        }
        psi.EnvironmentVariables["GSHARP_WORKER_GRANT"] = coreLease.Grant.ToString(
            System.Globalization.CultureInfo.InvariantCulture
        )
        using let proc = Process.Start(psi)
        // Issue #1667: Cancel() only requests cancellation via cts; without
        // this registration the child gsc process is never signaled and
        // WaitForExit() below blocks until gsc finishes on its own, making
        // MSBuild's cancel a no-op and risking orphaned compiler processes.
        using let cancelRegistration = this
            .cts
            .Token
            .Register(
            () -> {
                try {
                    WorkerProcessClient.Kill(proc!!)
                } catch (InvalidOperationException) {
                    // Process already exited.

                }
            }
        )
        var lastStdoutLine string? = nil
        var lastStderrLine string? = nil
        proc!!.OutputDataReceived += (_ object, e DataReceivedEventArgs) -> {
            if e.Data != nil {
                lastStdoutLine = e.Data
                this.LogCompilerLine(e.Data)
            }
        }
        proc!!.ErrorDataReceived += (_ object, e DataReceivedEventArgs) -> {
            if e.Data == nil {
                return
            }
            lastStderrLine = e.Data
            // "Failed." is gsc's terminal exit sentinel, not a diagnostic; the
            // real errors are surfaced from stdout via LogCompilerLine. Demote
            // it to a low-importance message so the build error list shows the
            // actual diagnostics instead of an opaque "Failed.".
            if string.Equals(e.Data.Trim(), "Failed.", StringComparison.Ordinal) {
                this.Log.LogMessage(MessageImportance.Low, e.Data)
            } else {
                this.Log.LogError(e.Data)
            }
        }
        proc!!.BeginOutputReadLine()
        proc!!.BeginErrorReadLine()
        proc!!.WaitForExit()
        if this.cts.IsCancellationRequested {
            // Build was cancelled: gsc was killed above, report failure
            // without logging a spurious "gsc exited with code N" error.
            return false
        }
        // Issue #519 + 6.2 SilentEmitFailure invariant (boundary ring): when
        // gsc exits non-zero but no structured diagnostic was logged, anchor
        // the synthetic GS9998 at the first Compile item (so the IDE error
        // pane navigates to a source file, not gsc.dll). Include the last
        // captured output as a breadcrumb.
        if proc!!.ExitCode != 0 && !this.Log.HasLoggedErrors {
            let lastOutput = lastStderrLine ?? lastStdoutLine
            let breadcrumb = if string.IsNullOrWhiteSpace(lastOutput) {
                string.Empty!!
            } else {
                " Last compiler output: $lastOutput"
            }
            this.LogFailure(
                "gsc exited with code ${proc!!.ExitCode} without emitting a structured diagnostic.$breadcrumb"
            )
        }
        return proc!!.ExitCode == 0 && !this.Log.HasLoggedErrors
    }

    private func LogFailure(message string) {
        let anchor = if this.Compile?.Length > 0 {
            this.Compile!![0].ItemSpec
        } else {
            this.GsharpCompilerFullPath
        }
        this.Log.LogError(nil, "GS9998", nil, anchor, 1, 1, 1, 1, message)
    }

    /// Routes a single line of gsc stdout to the MSBuild logger. Diagnostic
    /// header lines become structured errors/warnings (so they appear in the
    /// build error list and editor problem panes); all other lines — including
    /// the source snippets gsc prints under each diagnostic — are logged at low
    /// importance to keep default-verbosity output clean.
    /// @param line A line written by gsc to standard output.
    internal func LogCompilerLine(line string) {
        let match = DiagnosticLine.Match(line)
        if !match!!.Success {
            this.Log.LogMessage(MessageImportance.Low, line)
            return
        }
        let file = if match!!.Groups["file"].Success {
            match!!.Groups["file"].Value.Trim()
        } else {
            default(string?)
        }
        let code = match!!.Groups["code"].Value.Trim()
        let message = match!!.Groups["msg"].Value
        let startLine = if match!!.Groups["l1"].Success {
            int32.Parse(match!!.Groups["l1"].Value)
        } else {
            0
        }
        let startColumn = if match!!.Groups["c1"].Success {
            int32.Parse(match!!.Groups["c1"].Value)
        } else {
            0
        }
        let endLine = if match!!.Groups["l2"].Success {
            int32.Parse(match!!.Groups["l2"].Value)
        } else {
            0
        }
        let endColumn = if match!!.Groups["c2"].Success {
            int32.Parse(match!!.Groups["c2"].Value)
        } else {
            0
        }
        switch match!!.Groups["sev"].Value {
            case "error" {
                this.Log.LogError(nil, code, nil, file, startLine, startColumn, endLine, endColumn, message)
            }
            case "warning" {
                // GS9100 is advisory (missing transitive references) — only surface
                // at detailed/diagnostic verbosity to keep normal builds quiet.
                if string.Equals(code, "GS9100", StringComparison.OrdinalIgnoreCase) {
                    this.Log.LogMessage(MessageImportance.Low, line)
                } else {
                    this.Log.LogWarning(nil, code, nil, file, startLine, startColumn, endLine, endColumn, message)
                }
            }
            default {
                this.Log.LogMessage(MessageImportance.Normal, line)
            }
        }
    }

    shared {
        /// Matches gsc's canonical diagnostic header line, with or without source
        /// coordinates, so every diagnostic can be re-emitted through the MSBuild
        /// logger with structured code and severity. End line/column are optional.
        private let DiagnosticLine Regex = Regex(
            "^(?:(?<file>[^(]+)\\((?<l1>\\d+),(?<c1>\\d+)(?:,(?<l2>\\d+),(?<c2>\\d+))?\\):\\s*)?(?<sev>error|warning|info)\\s+(?<code>[^:\\s]+):\\s*(?<msg>.*)$$",
            RegexOptions.Compiled
        )

        /// Wraps [`value`](paramref) in double quotes if it contains a
        /// whitespace character. The gsc response file tokenizer
        /// (`Program.TokenizeResponseFileLine`) splits on unquoted whitespace,
        /// so any argument that embeds a space (e.g. a reference path under
        /// `C:\Program Files\dotnet\...`) must be quoted to survive
        /// tokenization as a single token. See issue #856.
        /// @param value Raw argument text to be written to the response file.
        /// @returns [`value`](paramref) unchanged when it is null, empty, or contains
        /// no whitespace; otherwise the value wrapped in a single pair of double
        /// quotes.
        internal func QuoteIfNeeded(value string) string {
            if string.IsNullOrEmpty(value) {
                return value
            }
            for var i = 0; i < value.Length; i++ {
                if char.IsWhiteSpace(value[i]) {
                    return "\"" + value + "\""
                }
            }
            return value
        }

        /// Parses an MSBuild bool-style property value. Accepts the canonical
        /// `"true"` / `"false"` spellings (case-insensitive) and treats
        /// empty / null / unrecognized values as `false`.
        private func ParseBool(value string?) bool -> !string.IsNullOrEmpty(value) && bool.TryParse(value, out var b) &&
            b
    }
}
