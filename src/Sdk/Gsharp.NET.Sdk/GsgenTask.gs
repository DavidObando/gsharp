// <copyright file="GsgenTask.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.NET.Sdk.Tools

import Microsoft.Build.Framework
import Microsoft.Build.Utilities
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text
import System.Text.RegularExpressions
import System.Threading

/// MSBuild task that invokes the `gsgen` source-generator host (ADR-0145
/// §E/§F) before `CoreCompile`. It projects the user's `.gs` sources to
/// a C# stub, runs the supplied Roslyn generators over that stub, and writes the
/// back-translated `.g.gs` parts (plus a newline manifest) to the output
/// directory so the SDK can feed them into gsc.
/// @remarks Default execution uses `dotnet <tool>.dll @rsp`, like (cref:BuildTask).
/// Optional shared execution uses a serial build-lifetime worker. Both modes
/// preserve structured diagnostic relay and kill the child on MSBuild cancellation.
open class GsgenTask : Task, ICancelableTask {
    private let cts CancellationTokenSource = CancellationTokenSource()

    /// Initializes a task with a conservative serial worker grant.
    init() {
        WorkerGrant = 1
    }

    /// Gets or sets the full path to gsgen.dll.
    @Required
    prop GsgenToolFullPath string?

    /// Gets or sets the Compile item group (the user's .gs sources).
    private var _compile[]?ITaskItem = Array.Empty[ITaskItem]()

    prop Compile[]?ITaskItem {
        get {
            return _compile
        }
        set {
            _compile = value
        }
    }

    /// Gets or sets "foreign" C# `Compile` items (issue #2214) — a stray
    /// `.cs` file the SDK found in the project's own `@(Compile)`
    /// (e.g. Nerdbank.GitVersioning's generated `ThisAssembly.cs`, added
    /// as an ordinary `Compile` item by its own MSBuild target) rather
    /// than hand-written G#. gsgen translates these directly to G# — no stub
    /// projection or generator run — and folds the result into `@(Compile)`
    /// the same way as generator output.
    private var _foreignCompile[]ITaskItem = Array.Empty[ITaskItem]()!!

    prop ForeignCompile[]ITaskItem {
        get {
            return _foreignCompile
        }
        set {
            _foreignCompile = value
        }
    }

    /// Gets or sets the resolved metadata references (forwarded via /r:).
    private var _references[]ITaskItem = Array.Empty[ITaskItem]()!!

    prop References[]ITaskItem {
        get {
            return _references
        }
        set {
            _references = value
        }
    }

    /// Gets or sets the analyzer/generator assembly paths (forwarded via /analyzer:).
    private var _analyzers[]ITaskItem = Array.Empty[ITaskItem]()!!

    prop Analyzers[]ITaskItem {
        get {
            return _analyzers
        }
        set {
            _analyzers = value
        }
    }

    /// Gets or sets the additional (non-source) files (issue #2223) forwarded to
    /// generators via /additionalfile:. Each item's `SourceItemGroup`,
    /// `TargetPath` and `ManifestResourceName` metadata (when present)
    /// are appended as `;key=value` pairs so a file/options-driven generator
    /// (e.g. Avalonia's XAML name generator) recognizes them.
    private var _additionalFiles[]ITaskItem = Array.Empty[ITaskItem]()!!

    prop AdditionalFiles[]ITaskItem {
        get {
            return _additionalFiles
        }
        set {
            _additionalFiles = value
        }
    }

    /// Gets or sets the project-wide generator options (issue #2223) forwarded
    /// via /globaloption: as `build_property.*`. Each item's ItemSpec is the
    /// option name and its `Value` metadata the option value.
    private var _globalOptions[]ITaskItem = Array.Empty[ITaskItem]()!!

    prop GlobalOptions[]ITaskItem {
        get {
            return _globalOptions
        }
        set {
            _globalOptions = value
        }
    }

    /// Gets or sets the output directory for the generated .g.gs files (/out:).
    @Required
    prop OutputDir string?

    /// Gets or sets the manifest path receiving the newline-separated generated-file list (/manifest:).
    @Required
    prop ManifestPath string?

    /// Gets or sets the optional root namespace (/rootnamespace:).
    prop RootNamespace string?

    /// Gets or sets the path of the response file to be written.
    @Required
    prop ResponseFilePath string?

    /// Gets or sets the project base directory, used as the process working directory.
    prop BasePath string?

    /// Gets or sets whether to reuse a bounded generator worker within this build.
    prop UseSharedCompilation bool

    /// Gets or sets the resource grant forwarded to the serial generator request.
    prop WorkerGrant int32

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Cancel() -> this.cts.Cancel()

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    open override func Execute() bool {
        // No sources means nothing to project; treat as a no-op success (gsgen
        // itself requires at least one /gs:, so we never launch it empty).
        if this.Compile == nil || this.Compile!!.Length == 0 {
            return true
        }
        let gsgenToolFullPath = (this.GsgenToolFullPath ?? string.Empty)
        let outputDir = (this.OutputDir ?? string.Empty)
        let manifestPath = (this.ManifestPath ?? string.Empty)
        let responseFilePath = (this.ResponseFilePath ?? string.Empty)
        if string.IsNullOrEmpty(gsgenToolFullPath) || string.IsNullOrEmpty(outputDir) || string.IsNullOrEmpty(
            manifestPath
        ) ||
            string
            .IsNullOrEmpty(responseFilePath) {
            this.Log.LogError("GsgenTask requires GsgenToolFullPath, OutputDir, ManifestPath, and ResponseFilePath.")
            return false
        }
        let args = List[string]()
        for s in this.Compile!! {
            args.Add(BuildTask.QuoteIfNeeded("/gs:${s.ItemSpec}"))
        }
        for r in this.References {
            args.Add(BuildTask.QuoteIfNeeded("/r:${r.ItemSpec}"))
        }
        for a in this.Analyzers {
            args.Add(BuildTask.QuoteIfNeeded("/analyzer:${a.ItemSpec}"))
        }
        for c in this.ForeignCompile {
            args.Add(BuildTask.QuoteIfNeeded("/csfile:${c.ItemSpec}"))
        }
        for af in this.AdditionalFiles {
            var spec = af.ItemSpec
            for name in[]string{"SourceItemGroup", "TargetPath", "ManifestResourceName"} {
                let meta = af.GetMetadata(name)
                if !string.IsNullOrEmpty(meta) {
                    spec += ";$name=$meta"
                }
            }
            args.Add(BuildTask.QuoteIfNeeded("/additionalfile:$spec"))
        }
        for go_ in this.GlobalOptions {
            args.Add(BuildTask.QuoteIfNeeded("/globaloption:${go_.ItemSpec}=${go_.GetMetadata("Value")}"))
        }
        args.Add(BuildTask.QuoteIfNeeded("/out:$outputDir"))
        args.Add(BuildTask.QuoteIfNeeded("/manifest:$manifestPath"))
        if !string.IsNullOrEmpty(this.RootNamespace) {
            args.Add(BuildTask.QuoteIfNeeded("/rootnamespace:${this.RootNamespace}"))
        }
        Directory.CreateDirectory(Path.GetDirectoryName(responseFilePath) ?? ".")
        File.WriteAllLines(responseFilePath, args, Encoding.UTF8)
        if this.UseSharedCompilation && this.BuildEngine is IBuildEngine4 engine {
            if this.WorkerGrant < 1 {
                this.Log.LogError("GsgenTask requires a positive WorkerGrant.")
                return false
            }
            var lastWorkerOutput string? = nil
            var lastWorkerError string? = nil
            try {
                let client = WorkerProcessClient.Get(engine, "GSharp.GeneratorWorker")
                if client.TryRun(
                    Path.GetFullPath(gsgenToolFullPath),
                    "--generator-worker",
                    Path.GetFullPath(this.BasePath ?? Environment.CurrentDirectory),
                    []string{"@" + Path.GetFullPath(responseFilePath)},
                    this.WorkerGrant,
                    this.cts.Token,
                    (line string) -> {
                        lastWorkerOutput = line
                        this.LogCompilerLine(line)
                    },
                    (line string) -> {
                        lastWorkerError = line
                        this.Log.LogError(line)
                    },
                    (message string) -> this.Log.LogMessage(MessageImportance.Low, message),
                    out var exitCode
                ) {
                    return this.Complete(exitCode, lastWorkerOutput, lastWorkerError, gsgenToolFullPath)
                }
            } catch (ex OperationCanceledException) {
                return false
            } catch (ex IOException) {
                this.Log.LogError("Generator worker transport failed after dispatch: ${ex.Message}")
                return false
            }
        } else if this.UseSharedCompilation {
            this.Log.LogMessage(
                MessageImportance.Low,
                "G# generator worker unavailable without IBuildEngine4; using standalone gsgen."
            )
        }
        let psi = ProcessStartInfo("dotnet", "\"$gsgenToolFullPath\" @\"$responseFilePath\""){
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = this.BasePath ?? Environment.CurrentDirectory
        }
        var proc Process
        try {
            proc = Process.Start(psi)
        } catch (ex Exception) {
            // Hard failure: the gsgen process could not even be launched.
            this.Log.LogError("Failed to launch gsgen ('$gsgenToolFullPath'): ${ex.Message}")
            return false
        }
        {
            using let _ = proc
            // Mirror BuildTask (issue #1667): register the cancellation token so an
            // MSBuild Cancel() actually kills the child gsgen process instead of
            // blocking in WaitForExit() until it finishes on its own.
            using let cancelRegistration = this
                .cts
                .Token
                .Register(
                () -> {
                    try {
                        // netstandard2.0 (this task's TFM) lacks Process.Kill(bool);
                        // gsgen doesn't spawn grandchildren, so killing it directly
                        // stops the generator run.
                        proc.Kill()
                    } catch (InvalidOperationException) {
                        // Process already exited.

                    }
                }
            )
            var lastStdoutLine string? = nil
            var lastStderrLine string? = nil
            proc.OutputDataReceived += (_ object, e DataReceivedEventArgs) -> {
                if e.Data != nil {
                    lastStdoutLine = e.Data
                    this.LogCompilerLine(e.Data)
                }
            }
            proc.ErrorDataReceived += (_ object, e DataReceivedEventArgs) -> {
                if e.Data == nil {
                    return
                }
                lastStderrLine = e.Data
                this.Log.LogError(e.Data)
            }
            proc.BeginOutputReadLine()
            proc.BeginErrorReadLine()
            proc.WaitForExit()
            return this.Complete(proc.ExitCode, lastStdoutLine, lastStderrLine, gsgenToolFullPath)
        }
    }

    private func Complete(
        exitCode int32,
        lastStdoutLine string?,
        lastStderrLine string?,
        gsgenToolFullPath string
    ) bool {
        if this.cts.IsCancellationRequested {
            // Build was cancelled: gsgen was killed above; report failure
            // without logging a spurious "exited with code N" error.
            return false
        }
        // Boundary-ring invariant (mirrors BuildTask GS9998): if gsgen exits
        // non-zero without emitting a structured diagnostic, anchor a synthetic
        // GS9998 at the first Compile item so the IDE navigates to a source
        // file, not gsgen.dll.
        if exitCode != 0 && !this.Log.HasLoggedErrors {
            let anchorFile = if this.Compile?.Length > 0 {
                this.Compile!![0].ItemSpec!!
            } else {
                gsgenToolFullPath
            }
            let lastOutput = lastStderrLine ?? lastStdoutLine
            let breadcrumb = if string.IsNullOrWhiteSpace(lastOutput) {
                string.Empty!!
            } else {
                " Last generator output: $lastOutput"
            }
            this.Log.LogError(
                subcategory: nil,
                errorCode: "GS9998",
                helpKeyword: nil,
                file: anchorFile,
                lineNumber: 1,
                columnNumber: 1,
                endLineNumber: 1,
                endColumnNumber: 1,
                message: "gsgen exited with code $exitCode without emitting a structured diagnostic.$breadcrumb"
            )
        }
        // Return false only on a hard failure: a non-zero exit AND at least one
        // logged error. Generator warnings/info alone never fail the build.
        return exitCode == 0 || !this.Log.HasLoggedErrors
    }

    /// Routes a single line of gsgen stdout to the MSBuild logger. Diagnostic
    /// header lines become structured errors/warnings; all other lines are logged
    /// at low importance to keep default-verbosity output clean. Mirrors
    /// (cref:BuildTask)'s relay.
    /// @param line A line written by gsgen to standard output.
    private func LogCompilerLine(line string) {
        let match = DiagnosticLine.Match(line)
        if !match!!.Success {
            this.Log.LogMessage(MessageImportance.Low, line)
            return
        }
        let file = match!!.Groups["file"].Value.Trim()
        let code = match!!.Groups["code"].Value.Trim()
        let message = match!!.Groups["msg"].Value
        let startLine = int32.Parse(match!!.Groups["l1"].Value)
        let startColumn = int32.Parse(match!!.Groups["c1"].Value)
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
                this.Log.LogWarning(nil, code, nil, file, startLine, startColumn, endLine, endColumn, message)
            }
            default {
                this.Log.LogMessage(MessageImportance.Normal, line)
            }
        }
    }

    shared {
        /// Matches gsgen's canonical diagnostic header line
        /// `file(startLine,startCol,endLine,endCol): error|warning|info CODE: message`
        /// (identical to gsc's format) so it can be re-emitted through the MSBuild
        /// logger with structured location, code, and severity. End line/column are
        /// optional.
        private let DiagnosticLine Regex = Regex(
            "^(?<file>[^(]+)\\((?<l1>\\d+),(?<c1>\\d+)(?:,(?<l2>\\d+),(?<c2>\\d+))?\\):\\s*(?<sev>error|warning|info)\\s+(?<code>[^:]+):\\s*(?<msg>.*)$$",
            RegexOptions.Compiled
        )
    }
}
