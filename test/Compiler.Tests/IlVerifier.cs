// <copyright file="IlVerifier.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Xunit.Sdk;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Mechanical IL verification gate for assemblies emitted by Compiler.Tests.
///
/// Wraps the <c>dotnet-ilverify</c> local tool (declared in
/// <c>.config/dotnet-tools.json</c>) and runs it against a freshly-emitted
/// assembly. Tests should call <see cref="Verify(string, IEnumerable{string})"/>
/// immediately after a successful compile so that any invalid IL produced by
/// gsc is attributed to the test that emitted it.
///
/// Behavior:
/// <list type="bullet">
///   <item>The host runtime's <c>System.*.dll</c>, <c>mscorlib.dll</c>,
///         <c>netstandard.dll</c> and <c>System.Private.CoreLib.dll</c> are
///         always added to the reference set, so callers only need to pass
///         user-supplied or test-built references.</item>
///   <item>Verification can be globally skipped by setting the environment
///         variable <c>GSHARP_SKIP_ILVERIFY=1</c>. This is intended for local
///         debugging only; CI must run with verification enabled so invalid IL
///         is caught on every PR.</item>
///   <item>If the <c>ilverify</c> tool cannot be located, the helper throws
///         (instead of silently passing) so CI failures are obvious. To bypass
///         in environments without the tool, set <c>GSHARP_SKIP_ILVERIFY=1</c>.</item>
///   <item>Verification is limited to 30 seconds. On timeout, the helper kills
///         the tool process tree and reports any partial stdout and stderr.</item>
/// </list>
/// </summary>
internal static class IlVerifier
{
    private const string SkipEnvVar = "GSHARP_SKIP_ILVERIFY";
    private const int VerifyTimeoutMilliseconds = 30_000;
    private const int ToolProbeTimeoutMilliseconds = 30_000;
    private const int KillGraceMilliseconds = 10_000;
    private const string UnavailableOutput = "<unavailable: output pipe held by a surviving descendant>";

    private static readonly object ToolLocateSync = new();
    private static readonly Lazy<IReadOnlyList<string>> RuntimeReferences =
        new(BuildDefaultRuntimeReferences);

    private static string? cachedToolCommand;
    private static IReadOnlyList<string>? cachedToolArgs;

    /// <summary>
    /// Verifies the IL of the assembly at <paramref name="assemblyPath"/> using
    /// <c>dotnet-ilverify</c>. Throws (failing the test) on any verification
    /// error. The host runtime's BCL assemblies are added to the reference set
    /// automatically; callers only need to pass additional, test-specific
    /// references (for example, a user library the assembly under test depends
    /// on).
    /// </summary>
    /// <param name="assemblyPath">Path to the .dll to verify.</param>
    /// <param name="additionalReferences">Optional extra reference assemblies
    /// the assembly under test depends on. May be null or empty.</param>
    /// <param name="ignoredErrorCodes">Optional ECMA-335 error codes that
    /// ilverify should treat as non-fatal. Use this to mark known compiler
    /// bugs so the gate catches NEW regressions without failing on
    /// already-tracked issues. Each entry should be the bracketed identifier
    /// from ilverify output (for example, <c>"CallVirtOnValueType"</c>); the
    /// helper translates it into the matching regex.</param>
    /// <param name="ignoredErrorScope">Optional ilverify member-name regex
    /// limiting <paramref name="ignoredErrorCodes"/> to matching methods. The
    /// rest of the assembly is verified separately without suppressions.</param>
    public static void Verify(
        string assemblyPath,
        IEnumerable<string>? additionalReferences = null,
        IEnumerable<string>? ignoredErrorCodes = null,
        string? ignoredErrorScope = null)
    {
        if (Environment.GetEnvironmentVariable(SkipEnvVar) == "1")
        {
            return;
        }

        if (!File.Exists(assemblyPath))
        {
            throw new XunitException($"ilverify: assembly not found at '{assemblyPath}'");
        }

        var (command, leadingArgs) = LocateTool();
        var references = BuildReferenceSet(assemblyPath, additionalReferences);

        if (!string.IsNullOrWhiteSpace(ignoredErrorScope))
        {
            VerifyCore(
                command,
                leadingArgs,
                assemblyPath,
                references,
                ignoredErrorCodes: null,
                includedScope: null,
                excludedScope: ignoredErrorScope);
            // ponytail: -g remains category-wide inside the matched method;
            // parse exact verifier instances only if method scope proves too broad.
            VerifyCore(
                command,
                leadingArgs,
                assemblyPath,
                references,
                ignoredErrorCodes,
                includedScope: ignoredErrorScope,
                excludedScope: null);
            return;
        }

        VerifyCore(
            command,
            leadingArgs,
            assemblyPath,
            references,
            ignoredErrorCodes,
            includedScope: null,
            excludedScope: null);
    }

    private static void VerifyCore(
        string command,
        IReadOnlyList<string> leadingArgs,
        string assemblyPath,
        IReadOnlyList<string> references,
        IEnumerable<string>? ignoredErrorCodes,
        string? includedScope,
        string? excludedScope)
    {
        var args = new List<string>(leadingArgs)
        {
            assemblyPath,
            "-s",
            "System.Private.CoreLib",
        };
        foreach (var reference in references)
        {
            args.Add("-r");
            args.Add(reference);
        }

        if (ignoredErrorCodes is not null)
        {
            foreach (var code in ignoredErrorCodes)
            {
                if (string.IsNullOrWhiteSpace(code))
                {
                    continue;
                }

                // ilverify's --ignore-error matches its regex against the
                // error category name (e.g., "CallVirtOnValueType"), NOT
                // against the rendered "[IL]: Error [code]: ..." line. Pass
                // the bare code so a partial-substring regex hits cleanly.
                args.Add("-g");
                args.Add(code);
            }
        }

        if (includedScope is not null)
        {
            args.Add("-i");
            args.Add(includedScope);
        }

        if (excludedScope is not null)
        {
            args.Add("-e");
            args.Add(excludedScope);
        }

        var psi = new ProcessStartInfo(command)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            // When using `dotnet tool run`, the manifest is discovered relative
            // to the current directory. Tests routinely emit assemblies into a
            // per-test temp dir with no manifest, so anchor the tool lookup at
            // the repo root. All paths passed to ilverify are absolute.
            WorkingDirectory = FindRepoRoot(),
        };
        foreach (var a in args)
        {
            psi.ArgumentList.Add(a);
        }

        var (exitCode, stdout, stderr) =
            RunProcess(psi, assemblyPath, VerifyTimeoutMilliseconds);

        if (exitCode != 0)
        {
            // ilverify writes one line per IL error. Surface its full output so
            // a CI failure points directly at the offending opcode/method.
            var message = new StringBuilder()
                .Append("ilverify detected invalid IL in '")
                .Append(assemblyPath)
                .Append("' (exit ")
                .Append(exitCode)
                .AppendLine("):")
                .AppendLine(stdout.TrimEnd())
                .Append(stderr.TrimEnd())
                .ToString();
            throw new XunitException(message);
        }

        var successMarker = $"All Classes and Methods in {assemblyPath} Verified.";
        if (!stdout.Contains(successMarker, StringComparison.Ordinal))
        {
            throw new XunitException(
                $"ilverify exited successfully without confirming verification of '{assemblyPath}'.{Environment.NewLine}" +
                stdout.TrimEnd() + Environment.NewLine + stderr.TrimEnd());
        }
    }

    internal static (int ExitCode, string Stdout, string Stderr) RunProcess(
        ProcessStartInfo startInfo,
        string assemblyPath,
        int timeoutMilliseconds)
    {
        using var proc = Process.Start(startInfo)
            ?? throw new XunitException($"ilverify: failed to start '{startInfo.FileName}'");

        // Drain both pipes concurrently before waiting: reading stdout to EOF
        // and only then stderr can deadlock when ilverify fills the stderr pipe
        // buffer (~64 KB of error lines) while we are still blocked on stdout,
        // leaving the child unable to exit. Awaiting both reads together avoids
        // the classic redirected-pipe deadlock.
        var stdoutTask = proc.StandardOutput.ReadToEndAsync();
        var stderrTask = proc.StandardError.ReadToEndAsync();
        if (!proc.WaitForExit(timeoutMilliseconds))
        {
            proc.Kill(entireProcessTree: true);
            proc.WaitForExit(KillGraceMilliseconds);

            // Observation prevents a later unobserved-task escalation when a
            // surviving descendant eventually closes a pipe with an error.
            // It does not change task state: Wait/Result below still throw any
            // fault that completes within the grace period.
            _ = stdoutTask.ContinueWith(
                task => _ = task.Exception,
                TaskContinuationOptions.OnlyOnFaulted);
            _ = stderrTask.ContinueWith(
                task => _ = task.Exception,
                TaskContinuationOptions.OnlyOnFaulted);

            string Grab(Task<string> task) => task.Wait(KillGraceMilliseconds)
                ? task.Result
                : UnavailableOutput;
            var timedOutStdout = Grab(stdoutTask);
            var timedOutStderr = Grab(stderrTask);
            var message = new StringBuilder()
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
                .ToString();
            throw new XunitException(message);
        }

        var stdout = stdoutTask.GetAwaiter().GetResult();
        var stderr = stderrTask.GetAwaiter().GetResult();
        return (proc.ExitCode, stdout, stderr);
    }

    /// <summary>
    /// Returns true when IL verification is enabled for this test run. Tests
    /// can use this to skip emitting an assembly path that ilverify cannot
    /// handle (for example, executables targeting a host the tool does not
    /// support). The default is true; set <c>GSHARP_SKIP_ILVERIFY=1</c> to
    /// disable.
    /// </summary>
    public static bool IsEnabled => Environment.GetEnvironmentVariable(SkipEnvVar) != "1";

    /// <summary>
    /// Pre-computed ilverify error-code bundles for compiler-emission patterns
    /// that currently produce non-strict-conforming IL. Each bundle should map
    /// to an open GitHub issue (see comments). As bugs are fixed, the matching
    /// bundle should shrink — and once empty, the gate is fully closed.
    /// </summary>
    public static class KnownIssues
    {
        /// <summary>
        /// By-value returns of a user-declared <c>ref struct</c> (e.g.
        /// <c>func add(a Accumulator, n int32) Accumulator { return Accumulator{Total: a.Total + n} }</c>)
        /// trip ilverify's <c>ReturnPtrToStack</c> check on
        /// <c>dotnet-ilverify</c> 10.0.8. This is a known ilverify
        /// limitation, NOT a G# emitter bug: the same minimal C# program
        /// (a <c>public ref struct</c> with a <c>public static T Add(T, int)</c>
        /// returning <c>new T { ... }</c>) compiled by <c>csc</c> emits
        /// identical IL and fails the same check. The verifier rejects any
        /// <c>IsByRefLike</c> return-type signature even when the returned
        /// value is in a "permanent home" (the caller's stack frame, the
        /// only legal escape for a ref struct value).
        ///
        /// Track the upstream issue at
        /// https://github.com/dotnet/runtime/issues/129030 and
        /// drop this bundle once a newer ilverify release distinguishes
        /// permanent-home returns from raw byref returns.
        /// </summary>
        public static readonly string[] RefStruct =
        {
            "ReturnPtrToStack",
        };

        /// <summary>
        /// ADR-0089 / issue #755: <c>constrained.</c> + <c>call</c> on a
        /// static-virtual interface slot trips
        /// <c>dotnet-ilverify</c> 10.0.8's pre-C# 11 verifier rules. The
        /// verifier hard-codes "every <c>constrained.</c> prefix must be
        /// followed by <c>callvirt</c>" and "static <c>call</c> is not
        /// allowed on abstract methods". Both rules predate the .NET 7
        /// static-virtual-in-interfaces extension (ECMA-335 II.15.4.2.4 +
        /// .NET 7 specification of static-virtual dispatch via
        /// <c>constrained. !!T  call</c>), so the same minimal pattern
        /// emitted by the C# 11 compiler with <c>LangVersion=preview</c>
        /// fails the same two checks. The runtime JIT accepts the IL and
        /// dispatches correctly.
        ///
        /// Track the upstream issue at
        /// https://github.com/dotnet/runtime/issues/49558 (dotnet-ilverify
        /// catch-up) and drop this bundle once a newer ilverify release
        /// recognises the static-virtual pattern.
        /// </summary>
        public static readonly string[] StaticVirtualInterface =
        {
            "CallAbstract",
            "Constrained",
        };
    }

    /// <summary>
    /// Maps a sample name (as it appears under <c>samples/</c>) to ilverify
    /// error codes and the methods where the conformance harness should treat
    /// them as known issues. Samples not present in this map are verified strictly.
    /// Keys are matched case-insensitively against the sample's base name
    /// without extension.
    /// </summary>
    public static (IReadOnlyList<string> ErrorCodes, string? Scope) GetKnownIssuesForSample(
        string sampleBaseName)
    {
        var key = sampleBaseName.TrimEnd('/');
        if (SampleKnownIssues.TryGetValue(key, out var knownIssues))
        {
            return knownIssues;
        }

        return (Array.Empty<string>(), null);
    }

    private static readonly Dictionary<string, (IReadOnlyList<string> ErrorCodes, string? Scope)> SampleKnownIssues =
        new(StringComparer.OrdinalIgnoreCase)
    {
        // Ref struct emission: see KnownIssues.RefStruct.
        ["UserRefStruct"] = (KnownIssues.RefStruct, @"<Program>\.add$"),

        // ADR-0089 / issue #755: static-virtual interface dispatch emits
        // the canonical `constrained. !!T  call <iface>::<method>` pattern
        // that pre-C#-11 ilverify rules don't understand. Identical errors
        // are produced by csc-emitted IL for the same C# 11 pattern.
        ["StaticVirtualInterfaces"] = (
            KnownIssues.StaticVirtualInterface,
            @"<Program>\.(Apply|IdentityOf)$"),
    };

    private static (string Command, IReadOnlyList<string> LeadingArgs) LocateTool()
    {
        // Discovering the tool requires a `dotnet` lookup that may walk up the
        // directory tree (the local manifest lives at the repo root). Cache the
        // result on first use so we don't pay that cost per test.
        if (cachedToolCommand is not null && cachedToolArgs is not null)
        {
            return (cachedToolCommand, cachedToolArgs);
        }

        lock (ToolLocateSync)
        {
            if (cachedToolCommand is not null && cachedToolArgs is not null)
            {
                return (cachedToolCommand, cachedToolArgs);
            }

            // 1) Prefer the local-tool manifest entry: `dotnet tool run ilverify`.
            //    This is what CI restores via `dotnet tool restore`.
            if (TryProbeDotnetToolRun(out var args))
            {
                cachedToolCommand = "dotnet";
                cachedToolArgs = args;
                return (cachedToolCommand, cachedToolArgs);
            }

            // 2) Fall back to a globally-installed `ilverify` on PATH (or in
            //    $HOME/.dotnet/tools, which dotnet adds for global tools).
            if (TryProbeOnPath("ilverify"))
            {
                cachedToolCommand = "ilverify";
                cachedToolArgs = Array.Empty<string>();
                return (cachedToolCommand, cachedToolArgs);
            }

            throw new XunitException(
                "ilverify is required by the test suite but was not found. " +
                "Run `dotnet tool restore` at the repository root, or install it globally with " +
                "`dotnet tool install -g dotnet-ilverify`. To skip verification for local debugging only, " +
                $"set {SkipEnvVar}=1.");
        }
    }

    private static bool TryProbeDotnetToolRun(out IReadOnlyList<string> args)
    {
        // `dotnet tool run ilverify --version` returns 0 when the local
        // manifest knows about the tool. The version flag avoids printing the
        // full help text on success.
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = FindRepoRoot(),
        };
        psi.ArgumentList.Add("tool");
        psi.ArgumentList.Add("run");
        psi.ArgumentList.Add("ilverify");
        psi.ArgumentList.Add("--version");

        if (TryProbe(psi))
        {
            args = new[] { "tool", "run", "ilverify" };
            return true;
        }

        args = Array.Empty<string>();
        return false;
    }

    private static bool TryProbeOnPath(string command)
    {
        var psi = new ProcessStartInfo(command)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("--version");

        return TryProbe(psi);
    }

    internal static bool TryProbe(
        ProcessStartInfo startInfo,
        int timeoutMilliseconds = ToolProbeTimeoutMilliseconds)
    {
        try
        {
            var (exitCode, _, _) = RunProcess(
                startInfo,
                "ilverify tool probe",
                timeoutMilliseconds);
            return exitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    private static string FindRepoRoot()
    {
        // Walk up from this assembly's location until we find a directory
        // containing `.config/dotnet-tools.json`. This keeps tool discovery
        // working regardless of the runner's current directory.
        var dir = Path.GetDirectoryName(typeof(IlVerifier).Assembly.Location);
        while (!string.IsNullOrEmpty(dir))
        {
            if (File.Exists(Path.Combine(dir, ".config", "dotnet-tools.json")))
            {
                return dir;
            }

            dir = Path.GetDirectoryName(dir);
        }

        return Environment.CurrentDirectory;
    }

    private static IReadOnlyList<string> BuildReferenceSet(
        string assemblyPath,
        IEnumerable<string>? additionalReferences)
    {
        // Use an ordinal-ignore-case set so we don't double-pass the same DLL
        // when an additional reference also lives in the runtime directory.
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var ordered = new List<string>();

        void Add(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return;
            }

            if (!File.Exists(path))
            {
                throw new XunitException($"ilverify: reference assembly not found at '{path}'");
            }

            // ilverify treats the verified assembly itself as the "primary"
            // input; don't also pass it via -r (that confuses metadata loading).
            if (string.Equals(
                    Path.GetFullPath(path),
                    Path.GetFullPath(assemblyPath),
                    StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            if (seen.Add(path))
            {
                ordered.Add(path);
            }
        }

        foreach (var r in RuntimeReferences.Value)
        {
            Add(r);
        }

        if (additionalReferences is not null)
        {
            foreach (var r in additionalReferences)
            {
                Add(r);
            }
        }

        return ordered;
    }

    private static IReadOnlyList<string> BuildDefaultRuntimeReferences()
    {
        // The host runtime directory is the simplest stable source of refs that
        // matches what Compiler.Tests typically passes to gsc via /reference:.
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        var refs = new List<string>();
        foreach (var path in Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly))
        {
            var name = Path.GetFileName(path);
            if (name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                || string.Equals(name, "Microsoft.CSharp.dll", StringComparison.OrdinalIgnoreCase)
                || string.Equals(name, "Microsoft.VisualBasic.Core.dll", StringComparison.OrdinalIgnoreCase)
                || string.Equals(name, "Microsoft.Win32.Primitives.dll", StringComparison.OrdinalIgnoreCase)
                || string.Equals(name, "Microsoft.Win32.Registry.dll", StringComparison.OrdinalIgnoreCase))
            {
                refs.Add(path);
            }
        }

        // ADR-0174 D1: emitted programs reference Gsharp.Runtime.Channels
        // whenever they construct or operate on a channel. It is not a BCL
        // assembly; the test host carries it beside itself (Compiler.Tests →
        // Compiler → runtime copy-local), exactly where `dotnet exec` of the
        // emitted program will also find it.
        var channelsRuntime = Path.Combine(AppContext.BaseDirectory, "Gsharp.Runtime.Channels.dll");
        if (File.Exists(channelsRuntime))
        {
            refs.Add(channelsRuntime);
        }

        return refs;
    }
}
