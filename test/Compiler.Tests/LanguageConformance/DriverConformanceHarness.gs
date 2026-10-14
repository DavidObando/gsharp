// <copyright file="DriverConformanceHarness.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.LanguageConformance

import System
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.IO
import System.Linq
import System.Reflection
import System.Text.RegularExpressions
import System.Threading.Tasks
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

internal shared class DriverConformanceHarness {
    private data class DriverResult(
        ExitCode int32,
        Output string,
        DiagnosticIds[]string,
        StandardError string,
        CompilerOutput string = "",
        IlDump string? = nil,
        AssemblyReferences IReadOnlyList[string]? = nil
    ) : IEquatable[DriverConformanceHarness.DriverResult] { }

    /// The result of one differential comparison (issue #3717): the sample,
    /// every level at which the two reference closures disagreed, and the
    /// `AssemblyRef` sets each compile produced (the non-vacuity
    /// evidence that the two modes really used different reflection contexts).
    /// @param Sample The sample name.
    /// @param Differences Human-readable divergence reports; empty when the modes agree.
    /// @param HostTpaAssemblyReferences AssemblyRef names emitted by the host-TPA compile.
    /// @param RefPackAssemblyReferences AssemblyRef names emitted by the ref-pack compile.
    data class DifferentialOutcome(
        Sample string,
        Differences IReadOnlyList[string],
        HostTpaAssemblyReferences IReadOnlyList[string],
        RefPackAssemblyReferences IReadOnlyList[string]
    ) : IEquatable[DifferentialOutcome] { }

    private data class ProcessResult(ExitCode int32, StandardOutput string, StandardError string) : IEquatable[
        DriverConformanceHarness.ProcessResult
    ] { }

    private let DiagnosticIdPattern Regex = Regex("\\b(?:GS\\d{4}|GSI\\d{3})\\b", RegexOptions.CultureInvariant)

    // IL offsets in the normalised dump (issue #3717). Blanked out when two
    // method bodies are compared so a single dropped instruction does not read
    // as a wholesale rewrite.
    private let IlOffsetPattern Regex = Regex("IL_[0-9A-F]{4}", RegexOptions.CultureInvariant)

    async func AssertSingleFileConformsAsync(displayName string, sourcePath string, goldenPath string? = nil) {
        let extensionsAssembly = Assembly.Load("Gsharp.Extensions")
        let usesExtensions = NeedsExtensions(File.ReadAllText(sourcePath))
        let extensionsReference string? = if usesExtensions {
            "/r:" + extensionsAssembly.Location
        } else {
            default(string?)
        }
        let gscArguments = if usesExtensions {
            []string{extensionsReference!!, "/nowarn:GS9100", sourcePath}
        } else {
            []string{sourcePath}
        }
        let gsiArguments = if usesExtensions {
            []string{extensionsReference!!, sourcePath}
        } else {
            []string{sourcePath}
        }
        let emitted = await RunEmittedAsync([]string{sourcePath}, Path.GetFileNameWithoutExtension(displayName))
        if goldenPath != nil {
            GoldenFile.AssertMatches(goldenPath, emitted.Output, "$displayName emitted output changed.")
        }
        let gscInProcessHost = await RunDriverProcessAsync(
            "Compiler",
            "gsc",
            sourcePath,
            compilerProtocol: true,
            gscArguments
        )
        let gsiInProcessHost = await RunDriverProcessAsync(
            "Repl",
            "gsi",
            sourcePath,
            compilerProtocol: false,
            gsiArguments
        )
        AssertResults(displayName, ("gsc", emitted, gscInProcessHost), ("gsi", emitted, gsiInProcessHost))
    }

    async func AssertEmittedMatchesGoldenAsync(displayName string, sourcePaths[]string, goldenPath string) {
        let emitted = await RunEmittedAsync(sourcePaths, displayName)
        GoldenFile.AssertMatches(goldenPath, emitted.Output, "$displayName emitted output changed.")
    }

    /// Issue #3717: compiles the sample twice — once as the rest of this
    /// harness does (no `/reference:`, so gsc resolves imports from the
    /// host's trusted platform assemblies and every imported type is a live
    /// runtime (cref:Type)) and once against the full
    /// `Microsoft.NETCore.App.Ref` closure (so gsc builds a
    /// (cref:System.Reflection.MetadataLoadContext), as every SDK build
    /// does) — and asserts the two agree.
    ///
    /// A load-context defect is by definition a case where those two
    /// compilations disagree, so this assertion detects the whole family
    /// without anyone having to anticipate a specific defect. Agreement is
    /// checked strongest-first: diagnostics, then normalised IL, then runtime
    /// output against the sample's golden.
    /// @param displayName The sample name, for failure messages.
    /// @param sourcePaths The sample's source files.
    /// @param goldenPath The sample's golden file, or `null`.
    /// @returns The differential outcome, for the caller to triage.
    async func RunDifferentialAsync(displayName string, sourcePaths[]string, goldenPath string?) DifferentialOutcome {
        let assemblyName = Path.GetFileNameWithoutExtension(displayName.TrimEnd('/'))
        let tpa = await RunEmittedAsync(
            sourcePaths,
            assemblyName,
            ReferenceClosureMode.HostTrustedPlatform,
            captureIl: true
        )
        let refPack = await RunEmittedAsync(
            sourcePaths,
            assemblyName,
            ReferenceClosureMode.ReferencePack,
            captureIl: true
        )
        let differences = List[string]()
        // (a) Diagnostics — ids and the raw compiler text, which carries the
        // locations. Catches the "member not found / throws under MLC" shapes.
        if !tpa.DiagnosticIds.SequenceEqual(refPack.DiagnosticIds, StringComparer.Ordinal) || !string.Equals(
            tpa.CompilerOutput,
            refPack.CompilerOutput,
            StringComparison.Ordinal
        ) {
            differences.Add(
                "diagnostics differ between reference closures:\n" +
                    (`  host-TPA:  [` + "${string.Join(", ", tpa.DiagnosticIds)}" + `]
`) +
                    ("${Indent(tpa.CompilerOutput)}" + `
`) +
                    (`  ref-pack:  [` + "${string.Join(", ", refPack.DiagnosticIds)}" + `]
`) +
                    "${Indent(refPack.CompilerOutput)}"
            )
        }
        // (b) Emitted IL, modulo assembly-reference tokens and ordering.
        if !string.Equals(tpa.IlDump, refPack.IlDump, StringComparison.Ordinal) {
            differences.Add(
                "emitted IL differs between reference closures:\n" +
                    DescribeIlDifference(tpa.IlDump!!, refPack.IlDump!!)
            )
        }
        // (c) Runtime output, against the existing golden.
        if !string.Equals(tpa.Output, refPack.Output, StringComparison.Ordinal) || tpa.ExitCode != refPack.ExitCode {
            differences.Add(
                "runtime output differs between reference closures:\n" + (`  host-TPA:  ` + "${Format(tpa)}" + `
`) + "  ref-pack:  ${Format(refPack)}"
            )
        } else if goldenPath != nil {
            GoldenFile.AssertMatches(
                goldenPath,
                refPack.Output,
                "$displayName ref-pack runtime output does not match the golden."
            )
        }
        return DifferentialOutcome(displayName, differences, tpa.AssemblyReferences!!, refPack.AssemblyReferences!!)
    }

    private func Indent(text string) string -> string.Join(
        "\n",
        (text ?? string.Empty).Split('\n').Select((line string) -> "    " + line)
    )

    /// Describes how two normalised IL dumps diverge, per method rather than
    /// per line. A naive line diff is useless here: one dropped protected
    /// region shifts every subsequent IL offset, so the real finding (#3708 —
    /// two missing `.region Finally` rows) is buried under a hundred
    /// spurious lines. This reports, for each differing method, the
    /// offset-insensitive exception-region difference first and then the first
    /// divergence in the opcode sequence.
    /// @param expected The host-TPA dump.
    /// @param actual The ref-pack dump.
    /// @returns A bounded description of the divergence.
    private func DescribeIlDifference(expected string, actual string) string {
        let left = SplitMethods(expected)
        let right = SplitMethods(actual)
        let report = List[string]()
        for only in left
            .Keys
            .Except(right.Keys, StringComparer.Ordinal)
            .OrderBy((key string) -> key, StringComparer.Ordinal)
            .Take(5) {
            report.Add("  emitted only by the host-TPA compile: $only")
        }
        for only in right
            .Keys
            .Except(left.Keys, StringComparer.Ordinal)
            .OrderBy((key string) -> key, StringComparer.Ordinal)
            .Take(5) {
            report.Add("  emitted only by the ref-pack compile: $only")
        }
        var shown = 0
        for key in left
            .Keys
            .Intersect(right.Keys, StringComparer.Ordinal)
            .OrderBy((key string) -> key, StringComparer.Ordinal) {
            if left[key].SequenceEqual(right[key], StringComparer.Ordinal) || shown >= 5 {
                continue
            }
            shown++
            report.Add("  $key")
            report.AddRange(DescribeMethodDifference(left[key], right[key]))
        }
        if report.Count == 0 {
            report.Add("  dumps differ only in method ordering or whitespace")
        }
        return string.Join("\n", report)
    }

    private func DescribeMethodDifference(left[]string, right[]string) sequence[string] {
        let leftRegions = OffsetInsensitive(left, "  .region ")
        let rightRegions = OffsetInsensitive(right, "  .region ")
        for missing in leftRegions.Except(rightRegions, StringComparer.Ordinal) {
            yield "    protected region present under host-TPA, absent under ref-pack: $missing"
        }
        for extra in rightRegions.Except(leftRegions, StringComparer.Ordinal) {
            yield "    protected region present under ref-pack, absent under host-TPA: $extra"
        }
        if leftRegions.Length != rightRegions.Length {
            yield "    region count: host-TPA ${leftRegions.Length}, ref-pack ${rightRegions.Length}"
        }
        let leftLocals string? = left.FirstOrDefault(
            (line string) -> line.StartsWith("  .locals ", StringComparison.Ordinal)
        )
        let rightLocals string? = right.FirstOrDefault(
            (line string) -> line.StartsWith("  .locals ", StringComparison.Ordinal)
        )
        if !string.Equals(leftLocals, rightLocals, StringComparison.Ordinal) {
            yield "    locals differ:" + (`
      host-TPA: ` + "${leftLocals?.Trim() ?? "<none>"}") + (`
      ref-pack: ` + "${rightLocals?.Trim() ?? "<none>"}")
        }
        let leftCode = OffsetInsensitive(left, "  IL_")
        let rightCode = OffsetInsensitive(right, "  IL_")
        for var i = 0; i < Math.Max(leftCode.Length, rightCode.Length); i++ {
            let leftLine = if i < leftCode.Length {
                leftCode[i]
            } else {
                "<end of method>"
            }
            let rightLine = if i < rightCode.Length {
                rightCode[i]
            } else {
                "<end of method>"
            }
            if !string.Equals(leftLine, rightLine, StringComparison.Ordinal) {
                yield "    first opcode divergence at instruction $i:"
                yield "      host-TPA: $leftLine"
                yield "      ref-pack: $rightLine"
                yield break
            }
        }
    }

    /// Selects the dump lines with the given prefix and blanks out IL offsets,
    /// so a shifted body does not read as a wholly different one.
    /// @param lines The method's dump lines.
    /// @param prefix The line prefix to select.
    /// @returns Offset-insensitive lines.
    private func OffsetInsensitive(lines[]string, prefix string)[]string -> lines
        .Where((line string) -> line.StartsWith(prefix, StringComparison.Ordinal))
        .Select((line string) -> IlOffsetPattern.Replace(line, "IL_x"))
        .Select((line string) -> line.TrimStart())
        .ToArray()

    private func SplitMethods(dump string) Dictionary[string, []string] {
        let methods = Dictionary[string, []string](StringComparer.Ordinal)
        var current string? = nil
        var body = List[string]()
        for line in(dump ?? string.Empty).Split('\n') {
            if line.StartsWith("method ", StringComparison.Ordinal) {
                if current != nil {
                    methods[current] = body.ToArray()
                }
                // Compiler-generated closures can share a header line;
                // disambiguate so the two dumps still pair up entry for entry.
                var candidate = line
                for var occurrence = 2; methods.ContainsKey(candidate); occurrence++ {
                    candidate = line + " #" + occurrence.ToString(CultureInfo.InvariantCulture)
                }
                current = candidate
                body = List[string]()
            } else {
                body.Add(line)
            }
        }
        if current != nil {
            methods[current] = body.ToArray()
        }
        return methods
    }

    private async func RunEmittedAsync(
        sourcePaths[]string,
        assemblyName string,
        referenceMode ReferenceClosureMode = ReferenceClosureMode.HostTrustedPlatform,
        captureIl bool = false
    ) DriverConformanceHarness
        .DriverResult {
        let testDirectory string? = Path.GetDirectoryName(typeof(DriverConformanceHarness).Assembly.Location)
        Assert.NotNull(testDirectory)
        let outputDirectory = Path.Combine(testDirectory!!, "driver-conformance", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(outputDirectory)
        let outputPath = Path.Combine(outputDirectory, assemblyName + ".dll")
        try {
            let usesExtensions = sourcePaths.Any((path string) -> NeedsExtensions(File.ReadAllText(path)))
            let extensionsAssemblyPath = Assembly.Load("Gsharp.Extensions").Location
            if usesExtensions {
                File.Copy(
                    extensionsAssemblyPath,
                    Path.Combine(outputDirectory, "Gsharp.Extensions.dll"),
                    overwrite: true
                )
            }
            let arguments = List[string]{
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100"
            }
            if usesExtensions {
                arguments.Add("/r:" + extensionsAssemblyPath)
            }
            if referenceMode == ReferenceClosureMode.ReferencePack {
                // Issue #3717: the closure the .NET SDK passes. Supplying it
                // makes gsc bind imports through a MetadataLoadContext instead
                // of the host's live runtime types.
                for reference in ReferenceClosure.RefPackAssemblies() {
                    arguments.Add("/reference:" + reference)
                }
            }
            arguments.AddRange(sourcePaths)
            let compile = CaptureConsole(() -> Program.Main(arguments.ToArray()), compilerProtocol: true)
            Assert.True(compile.ExitCode == 0, "gsc failed for $assemblyName ($referenceMode): ${Format(compile)}")
            Assert.Equal(string.Empty, compile.StandardError)
            Assert.True(File.Exists(outputPath), "Expected emitted assembly at $outputPath.")
            let knownIlIssues = IlVerifier.GetKnownIssuesForSample(assemblyName)
            IlVerifier.Verify(
                outputPath,
                additionalReferences: if usesExtensions {
                    []string{extensionsAssemblyPath}
                } else {
                    default([]?string)
                },
                ignoredErrorCodes: knownIlIssues.ErrorCodes,
                ignoredErrorScope: knownIlIssues.Scope
            )
            EmittedFixture.Load(outputPath).GetTypes()
            let ilDump string? = if captureIl {
                NormalizedIlDump.Create(outputPath)
            } else {
                default(string?)
            }
            let assemblyReferences IReadOnlyList[string]? = if captureIl {
                NormalizedIlDump.AssemblyReferenceNames(outputPath)
            } else {
                default(IReadOnlyList[string]?)
            }
            let runtime = await RunProcessAsync(
                "dotnet",
                outputDirectory,
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                outputPath
            )
            let result = DriverConformanceHarness.DriverResult(
                runtime.ExitCode,
                GoldenFile.Normalize(runtime.StandardOutput),
                compile.DiagnosticIds,
                GoldenFile.Normalize(runtime.StandardError),
                compile.CompilerOutput.Replace(outputDirectory, "<output>", StringComparison.Ordinal),
                ilDump,
                assemblyReferences
            )
            Assert.True(
                result.ExitCode == 0,
                "$assemblyName emitted runtime failed ($referenceMode): ${Format(result)}"
            )
            Assert.Equal(string.Empty, result.StandardError)
            return result
        } finally {
            Directory.Delete(outputDirectory, recursive: true)
        }
    }

    private func CaptureConsole(action() -> int32, compilerProtocol bool) DriverConformanceHarness.DriverResult {
        using let stdout = StringWriter{NewLine: "\n"}
        using let stderr = StringWriter{NewLine: "\n"}
        let previousOut = Console.Out
        let previousError = Console.Error
        Console.SetOut(stdout)
        Console.SetError(stderr)
        var exitCode int32
        try {
            exitCode = action()
        } finally {
            Console.SetOut(previousOut)
            Console.SetError(previousError)
        }
        return CreateCliResult(exitCode, stdout.ToString(), stderr.ToString(), compilerProtocol)
    }

    private async func RunDriverProcessAsync(
        projectDirectory string,
        executableName string,
        sourcePath string,
        compilerProtocol bool,
        arguments[]string
    ) DriverConformanceHarness
        .DriverResult {
        let testDirectory string? = Path.GetDirectoryName(typeof(DriverConformanceHarness).Assembly.Location)
        Assert.NotNull(testDirectory)
        let executable = Path.GetFullPath(
            Path.Combine(
                testDirectory!!,
                "..",
                projectDirectory,
                if OperatingSystem.IsWindows() {
                    executableName + ".exe"
                } else {
                    executableName
                }
            )
        )
        Assert.True(File.Exists(executable), "$executableName executable not found at $executable.")
        let process = await RunProcessAsync(executable, Path.GetDirectoryName(sourcePath), arguments)
        return CreateCliResult(process.ExitCode, process.StandardOutput, process.StandardError, compilerProtocol)
    }

    private func CreateCliResult(
        exitCode int32,
        stdout string,
        stderr string,
        compilerProtocol bool
    ) DriverConformanceHarness
        .DriverResult {
        let diagnosticIds = DiagnosticIdPattern
            .Matches(stdout + "\n" + stderr)
            .Select((match Match) -> match.Value)
            .Distinct(StringComparer.Ordinal)
            .OrderBy((id string) -> id, StringComparer.Ordinal)
            .ToArray()
        return DriverConformanceHarness.DriverResult(
            exitCode,
            CleanCliStream(stdout, compilerProtocol),
            diagnosticIds,
            CleanCliStream(stderr, compilerProtocol),
            CompilerOutput: string.Join(
                "\n",
                GoldenFile
                    .Normalize(stdout + "\n" + stderr)
                    .Split('\n')
                    .Where((line string) -> line != "Success." && line != "Failed.")
            )
        )
    }

    private func CleanCliStream(value string, compilerProtocol bool) string {
        var lines = GoldenFile.Normalize(value).Split('\n')
        let diagnosticIndex = Array.FindIndex(lines, (line string) -> DiagnosticIdPattern.IsMatch(line))
        if diagnosticIndex >= 0 {
            lines = lines[.. diagnosticIndex]
        }
        return string.Join(
            "\n",
            lines.Where((line string) -> !compilerProtocol || line != "Success." && line != "Failed.")
        )
    }

    private async func RunProcessAsync(
        fileName string,
        workingDirectory string?,
        arguments ...string
    ) DriverConformanceHarness
        .ProcessResult {
        let startInfo = ProcessStartInfo(fileName){
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDirectory!!
        }
        for argument in arguments {
            startInfo.ArgumentList.Add(argument)
        }
        using let process Process? = Process.Start(startInfo)
        Assert.NotNull(process)
        let stdoutTask = process!!.StandardOutput.ReadToEndAsync()
        let stderrTask = process!!.StandardError.ReadToEndAsync()
        if !process!!.WaitForExit(30_000) {
            process!!.Kill(entireProcessTree: true)
            Assert.True(process!!.WaitForExit(5_000), "$fileName did not exit after it was killed.")
            await Task.WhenAll(stdoutTask, stderrTask)
            Assert.Fail("$fileName timed out after 30 seconds.")
        }
        return DriverConformanceHarness.ProcessResult(process!!.ExitCode, await stdoutTask, await stderrTask)
    }

    private func Equivalent(
        left DriverConformanceHarness.DriverResult,
        right DriverConformanceHarness.DriverResult
    ) bool -> left.ExitCode == right.ExitCode &&
        string.Equals(left.Output, right.Output, StringComparison.Ordinal) && left.DiagnosticIds.SequenceEqual(
        right.DiagnosticIds,
        StringComparer.Ordinal
    ) &&
        string.Equals(left.StandardError, right.StandardError, StringComparison.Ordinal)

    private func AssertResults(
        sample string,
        results ...(
            Driver string,
            Expected DriverConformanceHarness.DriverResult,
            Actual DriverConformanceHarness.DriverResult
        )
    ) {
        let failures = results
            .Where(
            (
                result(
                    Driver string,
                    Expected DriverConformanceHarness.DriverResult,
                    Actual DriverConformanceHarness.DriverResult
                )
            ) -> !Equivalent(result.Expected, result.Actual)
        )
            .Select(
            (
                result(
                    Driver string,
                    Expected DriverConformanceHarness.DriverResult,
                    Actual DriverConformanceHarness.DriverResult
                )
            ) -> (("$sample" + ` diverged under ` + "${result.Driver}" + `.
`) + (`Expected: ` + "${Format(result.Expected)}" + `
`) + "Actual:   ${Format(result.Actual)}")
        )
            .ToArray()
        Assert.True(failures.Length == 0, string.Join(`

`, failures))
    }

    private func Format(
        result DriverConformanceHarness.DriverResult
    ) string -> "rc=${result.ExitCode}, diagnostics=[${string.Join(", ", result.DiagnosticIds)}], " +
        "stdout=[${result.Output.Replace("\n", "\\n", StringComparison.Ordinal)}], " +
        "stderr=[${result.StandardError.Replace("\n", "\\n", StringComparison.Ordinal)}]"

    // A sample needs `/r:Gsharp.Extensions` when it names that namespace, and
    // also when it names `Gsharp.Concurrency` — ADR-0174 D9's `after`, `tick`
    // and `merge` are G#-authored and live in the Extensions assembly even
    // though the package is imported implicitly.
    private func NeedsExtensions(source string) bool -> source.Contains(
        "Gsharp.Extensions",
        StringComparison.Ordinal
    ) ||
        source.Contains("Gsharp.Concurrency", StringComparison.Ordinal)
}
