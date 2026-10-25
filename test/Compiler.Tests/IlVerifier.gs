// <copyright file="IlVerifier.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text
import System.Threading.Tasks
import SystemObject = System.Object
import Xunit.Sdk

/// Mechanical IL verification gate for assemblies emitted by Compiler.Tests.
///
/// Wraps the `dotnet-ilverify` local tool (declared in
/// `.config/dotnet-tools.json`) and runs it against a freshly-emitted
/// assembly. Tests should call (cref:Verify(string, IEnumerable{string}))
/// immediately after a successful compile so that any invalid IL produced by
/// gsc is attributed to the test that emitted it.
///
/// Behavior:
/// - The host runtime's `System.*.dll`, `mscorlib.dll`, `netstandard.dll` and
/// `System.Private.CoreLib.dll` are always added to the reference set, so callers only need to pass
/// user-supplied or test-built references.
/// - Verification can be globally skipped by setting the environment variable `GSHARP_SKIP_ILVERIFY=1`.
/// This is intended for local debugging only; CI must run with verification enabled so invalid IL is
/// caught on every PR.
/// - If the `ilverify` tool cannot be located, the helper throws (instead of silently passing) so CI
/// failures are obvious. To bypass in environments without the tool, set `GSHARP_SKIP_ILVERIFY=1`.
/// - Verification is limited to 30 seconds. On timeout, the helper kills the tool process tree and
/// reports any partial stdout and stderr.
internal shared class IlVerifier {
    /// Pre-computed ilverify error-code bundles for compiler-emission patterns
    /// that currently produce non-strict-conforming IL. Each bundle should map
    /// to an open GitHub issue (see comments). As bugs are fixed, the matching
    /// bundle should shrink — and once empty, the gate is fully closed.
    shared class KnownIssues {
        /// By-value returns of a user-declared `ref struct` (e.g.
        /// `func add(a Accumulator, n int32) Accumulator { return Accumulator{Total: a.Total + n} }`)
        /// trip ilverify's `ReturnPtrToStack` check on
        /// `dotnet-ilverify` 10.0.8. This is a known ilverify
        /// limitation, NOT a G# emitter bug: the same minimal C# program
        /// (a `public ref struct` with a `public static T Add(T, int)`
        /// returning `new T { ... }`) compiled by `csc` emits
        /// identical IL and fails the same check. The verifier rejects any
        /// `IsByRefLike` return-type signature even when the returned
        /// value is in a "permanent home" (the caller's stack frame, the
        /// only legal escape for a ref struct value).
        ///
        /// Track the upstream issue at
        /// https://github.com/dotnet/runtime/issues/129030 and
        /// drop this bundle once a newer ilverify release distinguishes
        /// permanent-home returns from raw byref returns.
        let RefStruct[]string = []string{"ReturnPtrToStack"}

        /// ADR-0089 / issue #755: `constrained.` + `call` on a
        /// static-virtual interface slot trips
        /// `dotnet-ilverify` 10.0.8's pre-C# 11 verifier rules. The
        /// verifier hard-codes "every `constrained.` prefix must be
        /// followed by `callvirt`" and "static `call` is not
        /// allowed on abstract methods". Both rules predate the .NET 7
        /// static-virtual-in-interfaces extension (ECMA-335 II.15.4.2.4 +
        /// .NET 7 specification of static-virtual dispatch via
        /// `constrained. !!T call`), so the same minimal pattern
        /// emitted by the C# 11 compiler with `LangVersion=preview`
        /// fails the same two checks. The runtime JIT accepts the IL and
        /// dispatches correctly.
        ///
        /// Track the upstream issue at
        /// https://github.com/dotnet/runtime/issues/132820 (fixed upstream
        /// by #132944) and drop this bundle once a stable ilverify release
        /// recognises the static-virtual pattern.
        let StaticVirtualInterface[]string = []string{"CallAbstract", "Constrained"}
    }

    private const SkipEnvVar string = "GSHARP_SKIP_ILVERIFY"
    private const VerifyTimeoutMilliseconds int32 = 30_000
    private const ToolProbeTimeoutMilliseconds int32 = 30_000
    private const KillGraceMilliseconds int32 = 10_000
    private const UnavailableOutput string = "<unavailable: output pipe held by a surviving descendant>"
    private let ToolLocateSync object = SystemObject()
    private let RuntimeReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
        BuildDefaultRuntimeReferences
    )
    private var cachedToolCommand string?
    private var cachedToolArgs IReadOnlyList[string]?

    /// Verifies the IL of the assembly at [`assemblyPath`](paramref) using
    /// `dotnet-ilverify`. Throws (failing the test) on any verification
    /// error. The host runtime's BCL assemblies are added to the reference set
    /// automatically; callers only need to pass additional, test-specific
    /// references (for example, a user library the assembly under test depends
    /// on).
    /// @param assemblyPath Path to the .dll to verify.
    /// @param additionalReferences Optional extra reference assemblies
    /// the assembly under test depends on. May be null or empty.
    /// @param ignoredErrorCodes Optional ECMA-335 error codes that
    /// ilverify should treat as non-fatal. Use this to mark known compiler
    /// bugs so the gate catches NEW regressions without failing on
    /// already-tracked issues. Each entry should be the bracketed identifier
    /// from ilverify output (for example, `"CallVirtOnValueType"`); the
    /// helper translates it into the matching regex.
    /// @param ignoredErrorScope Optional ilverify member-name regex
    /// limiting [`ignoredErrorCodes`](paramref) to matching methods. The
    /// rest of the assembly is verified separately without suppressions.
    func Verify(
        assemblyPath string,
        additionalReferences IEnumerable[string]? = nil,
        ignoredErrorCodes IEnumerable[string]? = nil,
        ignoredErrorScope string? = nil,
        report Action[string]? = nil
    ) {
        if Environment.GetEnvironmentVariable(SkipEnvVar) == "1" {
            return
        }
        if !File.Exists(assemblyPath) {
            throw XunitException("ilverify: assembly not found at '$assemblyPath'")
        }
        let (command, leadingArgs) = LocateTool()
        let references = BuildReferenceSet(assemblyPath, additionalReferences)
        if !string.IsNullOrWhiteSpace(ignoredErrorScope) {
            VerifyCore(
                command,
                leadingArgs,
                assemblyPath,
                references,
                ignoredErrorCodes: nil,
                includedScope: nil,
                excludedScope: ignoredErrorScope,
                report
            )
            // ponytail: -g remains category-wide inside the matched method;
            // parse exact verifier instances only if method scope proves too broad.
            VerifyCore(
                command,
                leadingArgs,
                assemblyPath,
                references,
                ignoredErrorCodes,
                includedScope: ignoredErrorScope,
                excludedScope: nil,
                report
            )
            return
        }
        VerifyCore(
            command,
            leadingArgs,
            assemblyPath,
            references,
            ignoredErrorCodes,
            includedScope: nil,
            excludedScope: nil,
            report
        )
    }

    internal func VerifyCore(
        command string,
        leadingArgs IReadOnlyList[string],
        assemblyPath string,
        references IReadOnlyList[string],
        ignoredErrorCodes IEnumerable[string]?,
        includedScope string?,
        excludedScope string?,
        report Action[string]? = nil
    ) {
        let args = List[string](leadingArgs){assemblyPath, "-s", "System.Private.CoreLib"}
        for reference in references {
            args.Add("-r")
            args.Add(reference)
        }
        if ignoredErrorCodes != nil {
            for code in ignoredErrorCodes {
                if string.IsNullOrWhiteSpace(code) {
                    continue
                }
                // ilverify's --ignore-error matches its regex against the
                // error category name (e.g., "CallVirtOnValueType"), NOT
                // against the rendered "[IL]: Error [code]: ..." line. Pass
                // the bare code so a partial-substring regex hits cleanly.
                args.Add("-g")
                args.Add(code)
            }
        }
        if includedScope != nil {
            args.Add("-i")
            args.Add(includedScope)
        }
        if excludedScope != nil {
            args.Add("-e")
            args.Add(excludedScope)
        }
        let psi = ProcessStartInfo(command){
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = FindRepoRoot()
        }
        for a in args {
            psi.ArgumentList.Add(a)
        }
        let (exitCode, stdout, stderr) = RunProcess(psi, assemblyPath, VerifyTimeoutMilliseconds)
        let upstreamReturn = stdout.Contains("[ReturnPtrToStack]", StringComparison.Ordinal)
        if report != nil || upstreamReturn {
            let policy = if exitCode == 2 && stderr.Length == 0 {
                IlVerifyFalsePositives.Report(assemblyPath, stdout, allowFilterInFinally: true)
            } else {
                "ILVerify policy: no diagnostic exception applies to this raw process outcome."
            }
            let details = "ilverify invocation: " + command + " " + string.Join(" ", args) +
                "${Environment.NewLine}raw exit: $exitCode${Environment.NewLine}raw stdout:${Environment.NewLine}" +
                stdout +
                "${Environment.NewLine}raw stderr:${Environment.NewLine}" +
                stderr +
                Environment.NewLine +
                policy
            if report != nil {
                report(details)
            } else {
                Console.WriteLine(details)
            }
        }
        if exitCode == 2 && stderr.Length == 0 && IlVerifyFalsePositives.OnlyKnown(
            assemblyPath,
            stdout,
            allowFilterInFinally: true
        ) {
            return
        }
        if exitCode != 0 || stderr.Length != 0 {
            // ilverify writes one line per IL error. Surface its full output so
            // a CI failure points directly at the offending opcode/method.
            let message = StringBuilder()
                .Append("ilverify detected invalid IL in '")
                .Append(assemblyPath)
                .Append("' (exit ")
                .Append(exitCode)
                .AppendLine("):")
                .AppendLine(stdout.TrimEnd())
                .Append(stderr.TrimEnd())
                .ToString()
            throw XunitException(message)
        }
        let successMarker = "All Classes and Methods in ${Path.GetFullPath(assemblyPath, psi.WorkingDirectory)} Verified."
        if stdout.Trim() != successMarker {
            throw XunitException(
                "ilverify exited successfully without confirming verification of '$assemblyPath'.${Environment.NewLine}" +
                    stdout.TrimEnd() + Environment.NewLine + stderr.TrimEnd()
            )
        }
    }

    internal func RunProcess(startInfo ProcessStartInfo, assemblyPath string, timeoutMilliseconds int32)(
        ExitCode int32,
        Stdout string,
        Stderr string
    ) {
        using let proc = Process.Start(startInfo) ??
            throw XunitException("ilverify: failed to start '${startInfo.FileName}'")
        // Drain both pipes concurrently before waiting: reading stdout to EOF
        // and only then stderr can deadlock when ilverify fills the stderr pipe
        // buffer (~64 KB of error lines) while we are still blocked on stdout,
        // leaving the child unable to exit. Awaiting both reads together avoids
        // the classic redirected-pipe deadlock.
        let stdoutTask = proc.StandardOutput.ReadToEndAsync()
        let stderrTask = proc.StandardError.ReadToEndAsync()
        if !proc.WaitForExit(timeoutMilliseconds) {
            proc.Kill(entireProcessTree: true)
            proc.WaitForExit(KillGraceMilliseconds)
            // Observation prevents a later unobserved-task escalation when a
            // surviving descendant eventually closes a pipe with an error.
            // It does not change task state: Wait/Result below still throw any
            // fault that completes within the grace period.
            let _ = stdoutTask.ContinueWith(
                (task Task[string]) -> task.Exception,
                TaskContinuationOptions.OnlyOnFaulted
            )
            let _ = stderrTask.ContinueWith(
                (task Task[string]) -> task.Exception,
                TaskContinuationOptions.OnlyOnFaulted
            )
            let Grab = func (task Task[string]) string {
                return if task.Wait(KillGraceMilliseconds) {
                    task.Result
                } else {
                    UnavailableOutput
                }
            }
            let timedOutStdout = Grab(stdoutTask)
            let timedOutStderr = Grab(stderrTask)
            let message = StringBuilder()
                .Append("process '")
                .Append(startInfo.FileName)
                .Append("' timed out after ")
                .Append(timeoutMilliseconds)
                .Append(" ms while verifying '")
                .Append(assemblyPath)
                .AppendLine("':")
                .AppendLine("stdout:")
                .AppendLine(timedOutStdout.TrimEnd())
                .AppendLine("stderr:")
                .Append(timedOutStderr.TrimEnd())
                .ToString()
            throw XunitException(message)
        }
        let stdout = stdoutTask.GetAwaiter().GetResult()
        let stderr = stderrTask.GetAwaiter().GetResult()
        return (proc.ExitCode, stdout, stderr)
    }

    /// Returns true when IL verification is enabled for this test run. Tests
    /// can use this to skip emitting an assembly path that ilverify cannot
    /// handle (for example, executables targeting a host the tool does not
    /// support). The default is true; set `GSHARP_SKIP_ILVERIFY=1` to
    /// disable.
    prop IsEnabled bool -> Environment.GetEnvironmentVariable(SkipEnvVar) != "1"

    /// Maps a sample name (as it appears under `samples/`) to ilverify
    /// error codes and the methods where the conformance harness should treat
    /// them as known issues. Samples not present in this map are verified strictly.
    /// Keys are matched case-insensitively against the sample's base name
    /// without extension.
    func GetKnownIssuesForSample(sampleBaseName string)(ErrorCodes IReadOnlyList[string], Scope string?) {
        let key = sampleBaseName.TrimEnd('/')
        if SampleKnownIssues.TryGetValue(key, out var knownIssues) {
            return knownIssues
        }
        return (Array.Empty[string](), nil)
    }

    private let SampleKnownIssues Dictionary[string, (ErrorCodes IReadOnlyList[string], Scope string?)] = Dictionary[
        string,
        (ErrorCodes IReadOnlyList[string], Scope string?)
    ](StringComparer.OrdinalIgnoreCase){["UserRefStruct"] = (KnownIssues.RefStruct, "<Program>\\.add$$")}

    private func LocateTool()(Command string, LeadingArgs IReadOnlyList[string]) {
        // Discovering the tool requires a `dotnet` lookup that may walk up the
        // directory tree (the local manifest lives at the repo root). Cache the
        // result on first use so we don't pay that cost per test.
        if cachedToolCommand != nil && cachedToolArgs != nil {
            return (cachedToolCommand!!, cachedToolArgs!!)
        }
        lock ToolLocateSync {
            if cachedToolCommand != nil && cachedToolArgs != nil {
                return (cachedToolCommand!!, cachedToolArgs!!)
            }
            // 1) Prefer the local-tool manifest entry: `dotnet tool run ilverify`.
            //    This is what CI restores via `dotnet tool restore`.
            if TryProbeDotnetToolRun(out var args) {
                cachedToolCommand = "dotnet"
                cachedToolArgs = args
                return (cachedToolCommand!!, cachedToolArgs!!)
            }
            // 2) Fall back to a globally-installed `ilverify` on PATH (or in
            //    $HOME/.dotnet/tools, which dotnet adds for global tools).
            if TryProbeOnPath("ilverify") {
                cachedToolCommand = "ilverify"
                cachedToolArgs = Array.Empty[string]()
                return (cachedToolCommand!!, cachedToolArgs!!)
            }
            throw XunitException(
                "ilverify is required by the test suite but was not found. " +
                    "Run `dotnet tool restore` at the repository root, or install it globally with " +
                    "`dotnet tool install -g dotnet-ilverify`. To skip verification for local debugging only, " +
                    "set $SkipEnvVar=1."
            )
        }
    }

    private func TryProbeDotnetToolRun(out args IReadOnlyList[string]) bool {
        // `dotnet tool run ilverify --version` returns 0 when the local
        // manifest knows about the tool. The version flag avoids printing the
        // full help text on success.
        let psi = ProcessStartInfo("dotnet"){
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = FindRepoRoot()
        }
        psi.ArgumentList.Add("tool")
        psi.ArgumentList.Add("run")
        psi.ArgumentList.Add("ilverify")
        psi.ArgumentList.Add("--version")
        if TryProbe(psi) {
            args = []string{"tool", "run", "ilverify"}
            return true
        }
        args = Array.Empty[string]()
        return false
    }

    private func TryProbeOnPath(command string) bool {
        let psi = ProcessStartInfo(command){
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        }
        psi.ArgumentList.Add("--version")
        return TryProbe(psi)
    }

    internal func TryProbe(startInfo ProcessStartInfo, timeoutMilliseconds int32 = 30000) bool {
        try {
            let (exitCode, _, _) = RunProcess(startInfo, "ilverify tool probe", timeoutMilliseconds)
            return exitCode == 0
        } catch {
            return false
        }
    }

    internal func FindRepoRoot() string {
        // Walk up from this assembly's location until we find a directory
        // containing `.config/dotnet-tools.json`. This keeps tool discovery
        // working regardless of the runner's current directory.
        var dir = Path.GetDirectoryName(typeof(IlVerifier).Assembly.Location)
        while !string.IsNullOrEmpty(dir) {
            if File.Exists(Path.Combine(dir, ".config", "dotnet-tools.json")) {
                return dir
            }
            dir = Path.GetDirectoryName(dir)
        }
        return Environment.CurrentDirectory
    }

    private func BuildReferenceSet(assemblyPath string, additionalReferences IEnumerable[string]?) IReadOnlyList[
        string
    ] {
        // Use an ordinal-ignore-case set so we don't double-pass the same DLL
        // when an additional reference also lives in the runtime directory.
        let seen = HashSet[string](StringComparer.OrdinalIgnoreCase)
        let ordered = List[string]()
        let Add = func (path string) {
            if string.IsNullOrEmpty(path) {
                return
            }
            if !File.Exists(path) {
                throw XunitException("ilverify: reference assembly not found at '$path'")
            }
            // ilverify treats the verified assembly itself as the "primary"
            // input; don't also pass it via -r (that confuses metadata loading).
            if string.Equals(
                Path.GetFullPath(path),
                Path.GetFullPath(assemblyPath),
                StringComparison.OrdinalIgnoreCase
            ) {
                return
            }
            if seen.Add(path) {
                ordered.Add(path)
            }
        }
        for r in RuntimeReferences.Value {
            Add(r)
        }
        if additionalReferences != nil {
            for r in additionalReferences {
                Add(r)
            }
        }
        return ordered
    }

    private func BuildDefaultRuntimeReferences() IReadOnlyList[string] {
        // The host runtime directory is the simplest stable source of refs that
        // matches what Compiler.Tests typically passes to gsc via /reference:.
        let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)
        if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
            return Array.Empty[string]()
        }
        let refs = List[string]()
        for path in Directory.EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly) {
            let name = Path.GetFileName(path)
            if name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                name,
                "mscorlib.dll",
                StringComparison.OrdinalIgnoreCase
            ) ||
                string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase) || string.Equals(
                name,
                "Microsoft.CSharp.dll",
                StringComparison.OrdinalIgnoreCase
            ) ||
                string.Equals(name, "Microsoft.VisualBasic.Core.dll", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(name, "Microsoft.Win32.Primitives.dll", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(name, "Microsoft.Win32.Registry.dll", StringComparison.OrdinalIgnoreCase) {
                refs.Add(path)
            }
        }
        // ADR-0174 D1: emitted programs reference Gsharp.Runtime.Channels
        // whenever they construct or operate on a channel. It is not a BCL
        // assembly; the test host carries it beside itself (Compiler.Tests →
        // Compiler → runtime copy-local), exactly where `dotnet exec` of the
        // emitted program will also find it.
        let channelsRuntime = Path.Combine(AppContext.BaseDirectory, "Gsharp.Runtime.Channels.dll")
        if File.Exists(channelsRuntime) {
            refs.Add(channelsRuntime)
        }
        let valuesRuntime = Path.Combine(AppContext.BaseDirectory, "Gsharp.Runtime.Values.dll")
        if File.Exists(valuesRuntime) {
            refs.Add(valuesRuntime)
        }
        return refs
    }
}
