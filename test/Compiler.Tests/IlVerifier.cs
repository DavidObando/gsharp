// <copyright file="IlVerifier.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
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
/// </list>
/// </summary>
internal static class IlVerifier
{
    private const string SkipEnvVar = "GSHARP_SKIP_ILVERIFY";

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
    public static void Verify(
        string assemblyPath,
        IEnumerable<string>? additionalReferences = null,
        IEnumerable<string>? ignoredErrorCodes = null)
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

        using var proc = Process.Start(psi)
            ?? throw new XunitException($"ilverify: failed to start '{command}'");

        // Drain both pipes concurrently before waiting: reading stdout to EOF
        // and only then stderr can deadlock when ilverify fills the stderr pipe
        // buffer (~64 KB of error lines) while we are still blocked on stdout,
        // leaving the child unable to exit. Awaiting both reads together avoids
        // the classic redirected-pipe deadlock.
        var stdoutTask = proc.StandardOutput.ReadToEndAsync();
        var stderrTask = proc.StandardError.ReadToEndAsync();
        proc.WaitForExit();
        var stdout = stdoutTask.GetAwaiter().GetResult();
        var stderr = stderrTask.GetAwaiter().GetResult();

        if (proc.ExitCode != 0)
        {
            // ilverify writes one line per IL error. Surface its full output so
            // a CI failure points directly at the offending opcode/method.
            var message = new StringBuilder()
                .Append("ilverify detected invalid IL in '")
                .Append(assemblyPath)
                .Append("' (exit ")
                .Append(proc.ExitCode)
                .AppendLine("):")
                .AppendLine(stdout.TrimEnd())
                .Append(stderr.TrimEnd())
                .ToString();
            throw new XunitException(message);
        }
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
    /// Maps a sample name (as it appears under <c>samples/</c>) to the bundle
    /// of ilverify error codes that the conformance harness should treat as
    /// known issues. Samples not present in this map are verified strictly.
    /// Keys are matched case-insensitively against the sample's base name
    /// without extension.
    /// </summary>
    public static IReadOnlyList<string> GetKnownIssuesForSample(string sampleBaseName)
    {
        var key = sampleBaseName.TrimEnd('/');
        if (SampleKnownIssues.TryGetValue(key, out var codes))
        {
            return codes;
        }

        return Array.Empty<string>();
    }

    private static readonly Dictionary<string, string[]> SampleKnownIssues = new(StringComparer.OrdinalIgnoreCase)
    {
        // Ref struct emission: see KnownIssues.RefStruct.
        ["UserRefStruct"] = KnownIssues.RefStruct,

        // ADR-0089 / issue #755: static-virtual interface dispatch emits
        // the canonical `constrained. !!T  call <iface>::<method>` pattern
        // that pre-C#-11 ilverify rules don't understand. Identical errors
        // are produced by csc-emitted IL for the same C# 11 pattern.
        ["StaticVirtualInterfaces"] = KnownIssues.StaticVirtualInterface,
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

        try
        {
            using var proc = Process.Start(psi);
            if (proc is null)
            {
                args = Array.Empty<string>();
                return false;
            }

            proc.StandardOutput.ReadToEnd();
            proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode == 0)
            {
                args = new[] { "tool", "run", "ilverify" };
                return true;
            }
        }
        catch
        {
            // Fall through to the next probe.
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

        try
        {
            using var proc = Process.Start(psi);
            if (proc is null)
            {
                return false;
            }

            proc.StandardOutput.ReadToEnd();
            proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            return proc.ExitCode == 0;
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

        return refs;
    }
}
