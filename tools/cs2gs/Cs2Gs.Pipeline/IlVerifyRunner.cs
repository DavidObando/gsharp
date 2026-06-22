// <copyright file="IlVerifyRunner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Resolves and invokes the repo-pinned <c>dotnet-ilverify</c> local tool for
/// stage 3 (ADR-0115 §C). The recipe mirrors the repo's reference wrapper
/// <c>test/Compiler.Tests/IlVerifier.cs</c>: invoke <c>dotnet tool run
/// ilverify</c> with the process working directory anchored at the repo root so
/// the <c>.config/dotnet-tools.json</c> manifest is discovered, pass every
/// path absolute, and add the host runtime BCL plus the app's references to the
/// verifier's reference set. All process I/O is local — it only shells out to
/// <c>dotnet</c>; there is no network egress and no keys.
/// </summary>
public sealed class IlVerifyRunner
{
    /// <summary>
    /// The environment variable that, when set to <c>1</c>, bypasses IL
    /// verification (the stage no-ops to PASS). Intended for environments
    /// without the <c>dotnet-ilverify</c> tool; CI runs with verification on.
    /// Mirrors <c>IlVerifier</c>'s <c>GSHARP_SKIP_ILVERIFY</c> switch.
    /// </summary>
    public const string SkipEnvVar = "GSHARP_SKIP_ILVERIFY";

    // Matches a single ilverify error line, e.g.
    //   [IL]: Error [StackUnexpected]: [/abs/App.dll : Program::Main(string[])][offset 0x00000001] Unexpected type on the stack.
    // `code` is the bracketed ECMA-335 category; `location` (optional) carries
    // the `<assembly> : <Type>::<Method>(<sig>)` skeleton up to the `[offset …]`
    // marker (lazy so the `]` inside array types like `string[]` is not mistaken
    // for the location's closing bracket); `message` is the rest.
    private static readonly Regex ErrorPattern = new Regex(
        @"^\[IL\]:\s*Error\s*\[(?<code>[^\]]+)\]:\s*" +
        @"(?:\[(?<location>.*?)\]\s*\[offset[^\]]*\]\s*)?(?<message>.*)$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private readonly object restoreSync = new();
    private bool restoreAttempted;

    /// <summary>
    /// Initializes a new instance of the <see cref="IlVerifyRunner"/> class.
    /// </summary>
    /// <param name="repoRoot">
    /// The repository root (the directory containing
    /// <c>.config/dotnet-tools.json</c>). When <see langword="null"/> it is
    /// discovered by walking up from this assembly's location.
    /// </param>
    public IlVerifyRunner(string repoRoot = null)
    {
        this.RepoRoot = repoRoot ?? FindRepoRoot();
    }

    /// <summary>
    /// Gets the documented ilverify 10.0.8 FALSE-POSITIVE error codes the
    /// pipeline must ignore so it does not file spurious <c>ilverify-failure</c>
    /// gaps for known verifier limitations (NOT emitter bugs). These are passed
    /// to ilverify as <c>-g &lt;code&gt;</c> ignore-error flags and are also
    /// filtered defensively from any parsed output. Two upstream-tracked
    /// bundles, citing the same issues the repo's <c>IlVerifier</c> cites:
    /// <list type="bullet">
    ///   <item><description><c>ReturnPtrToStack</c> — by-value returns of a
    ///   user-declared <c>ref struct</c> trip ilverify even when the value is
    ///   in its only legal "permanent home" (the caller's frame). The same
    ///   minimal C# (a <c>public ref struct</c> returned by value) compiled by
    ///   <c>csc</c> emits identical IL and fails the same check. Track
    ///   https://github.com/dotnet/runtime/issues/129030.</description></item>
    ///   <item><description><c>CallAbstract</c> + <c>Constrained</c> — the
    ///   static-virtual <c>constrained. !!T  call</c> interface-dispatch pattern
    ///   (ADR-0089 / issue #755) trips ilverify's pre-C#-11 rules; csc-emitted
    ///   IL for the same C# 11 pattern fails identically and the JIT accepts it.
    ///   Track https://github.com/dotnet/runtime/issues/49558.</description></item>
    /// </list>
    /// </summary>
    public static IReadOnlyList<string> KnownIlVerifyFalsePositives { get; } = new[]
    {
        // KnownIssues.RefStruct — dotnet/runtime#129030.
        "ReturnPtrToStack",

        // KnownIssues.StaticVirtualInterface — ADR-0089 / #755, dotnet/runtime#49558.
        "CallAbstract",
        "Constrained",
    };

    /// <summary>Gets the resolved repository root used as the tool working directory.</summary>
    public string RepoRoot { get; }

    /// <summary>
    /// Gets a value indicating whether IL verification is enabled for this run.
    /// Returns <see langword="false"/> when <see cref="SkipEnvVar"/> is set to
    /// <c>1</c> (the stage then no-ops to PASS).
    /// </summary>
    public static bool IsEnabled => Environment.GetEnvironmentVariable(SkipEnvVar) != "1";

    /// <summary>
    /// Parses every ilverify error line out of the tool's combined output. Lines
    /// that are not error records (banners, the trailing summary) are skipped.
    /// </summary>
    /// <param name="output">The combined stdout+stderr of an ilverify run.</param>
    /// <returns>The parsed errors in tool order.</returns>
    public static IReadOnlyList<IlVerifyError> ParseErrors(string output)
    {
        var errors = new List<IlVerifyError>();
        if (string.IsNullOrEmpty(output))
        {
            return errors;
        }

        foreach (string rawLine in output.Replace("\r\n", "\n").Split('\n'))
        {
            string line = rawLine.Trim();
            Match match = ErrorPattern.Match(line);
            if (!match.Success)
            {
                continue;
            }

            string code = match.Groups["code"].Value.Trim();
            string method = ExtractMethod(match.Groups["location"].Value);
            errors.Add(new IlVerifyError(code, method, line));
        }

        return errors;
    }

    /// <summary>
    /// Verifies the IL of the assembly at <paramref name="assemblyPath"/> with
    /// the repo-pinned <c>dotnet-ilverify</c>, honoring the
    /// <see cref="SkipEnvVar"/> bypass. The host runtime BCL is always added to
    /// the reference set; <paramref name="additionalReferences"/> (the corpus
    /// app's <c>ReferencedAssemblies</c>) are appended. The
    /// <see cref="KnownIlVerifyFalsePositives"/> codes are passed as ignore
    /// flags and filtered from the parsed errors.
    /// </summary>
    /// <param name="assemblyPath">The absolute path of the .dll to verify.</param>
    /// <param name="additionalReferences">The app's extra references, or null.</param>
    /// <returns>The verification result (skipped/passed/failed + parsed errors).</returns>
    public IlVerifyResult Verify(string assemblyPath, IReadOnlyList<string> additionalReferences = null)
    {
        if (!IsEnabled)
        {
            return IlVerifyResult.Skipped();
        }

        if (string.IsNullOrEmpty(assemblyPath) || !File.Exists(assemblyPath))
        {
            return IlVerifyResult.Skipped();
        }

        this.EnsureToolRestored();

        IReadOnlyList<string> references = BuildReferenceSet(assemblyPath, additionalReferences);

        var args = new List<string> { "tool", "run", "ilverify", assemblyPath, "-s", "System.Private.CoreLib" };
        foreach (string reference in references)
        {
            args.Add("-r");
            args.Add(reference);
        }

        foreach (string code in KnownIlVerifyFalsePositives)
        {
            // ilverify's `-g` regex matches the bare error-category name.
            args.Add("-g");
            args.Add(code);
        }

        (int exit, string output) = this.RunDotnet(args);

        IReadOnlyList<IlVerifyError> errors = FilterIgnored(ParseErrors(output));

        if (exit == 0 || errors.Count == 0)
        {
            return IlVerifyResult.Passed(output, errors);
        }

        return IlVerifyResult.Failed(exit, output, errors);
    }

    /// <summary>
    /// Removes the documented ilverify false-positive codes
    /// (<see cref="KnownIlVerifyFalsePositives"/>) from a parsed error list, so
    /// the pipeline never files a spurious <c>ilverify-failure</c> gap for a
    /// known verifier limitation. This mirrors the <c>-g</c> ignore flags passed
    /// to ilverify and is applied defensively in case a tool build still surfaces
    /// the code.
    /// </summary>
    /// <param name="errors">The parsed ilverify errors.</param>
    /// <returns>The errors with the known false positives removed.</returns>
    public static IReadOnlyList<IlVerifyError> FilterIgnored(IEnumerable<IlVerifyError> errors)
    {
        if (errors is null)
        {
            return Array.Empty<IlVerifyError>();
        }

        var ignored = new HashSet<string>(KnownIlVerifyFalsePositives, StringComparer.OrdinalIgnoreCase);
        return errors.Where(e => e.Code is null || !ignored.Contains(e.Code)).ToList();
    }

    private static string ExtractMethod(string location)
    {
        if (string.IsNullOrWhiteSpace(location))
        {
            return null;
        }

        // location is `<assembly path> : <Type>::<Method>(<sig>)`. Take the part
        // after the last " : " so a Windows drive colon does not split it.
        int sep = location.LastIndexOf(" : ", StringComparison.Ordinal);
        string candidate = sep >= 0 ? location.Substring(sep + 3).Trim() : location.Trim();
        return string.IsNullOrEmpty(candidate) ? null : candidate;
    }

    private static IReadOnlyList<string> BuildReferenceSet(
        string assemblyPath,
        IReadOnlyList<string> additionalReferences)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var ordered = new List<string>();
        string fullAssembly = Path.GetFullPath(assemblyPath);

        void Add(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return;
            }

            // ilverify treats the verified assembly as the primary input; never
            // also pass it via -r (that confuses metadata loading).
            if (string.Equals(Path.GetFullPath(path), fullAssembly, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            if (seen.Add(path))
            {
                ordered.Add(path);
            }
        }

        foreach (string reference in BuildDefaultRuntimeReferences())
        {
            Add(reference);
        }

        if (additionalReferences is not null)
        {
            foreach (string reference in additionalReferences)
            {
                Add(reference);
            }
        }

        return ordered;
    }

    private static IReadOnlyList<string> BuildDefaultRuntimeReferences()
    {
        // The host runtime directory is the stable source of BCL refs matching
        // what stage 2 passes to gsc, mirroring IlVerifier.BuildDefaultRuntimeReferences.
        string runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        var refs = new List<string>();
        foreach (string path in Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly))
        {
            string name = Path.GetFileName(path);
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

    private static string FindRepoRoot()
    {
        // Walk up from this assembly's location until we find a directory holding
        // `.config/dotnet-tools.json`, so the local tool manifest is discovered
        // regardless of the runner's current directory (mirrors IlVerifier).
        string dir = Path.GetDirectoryName(typeof(IlVerifyRunner).Assembly.Location);
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

    private void EnsureToolRestored()
    {
        if (this.restoreAttempted)
        {
            return;
        }

        lock (this.restoreSync)
        {
            if (this.restoreAttempted)
            {
                return;
            }

            this.restoreAttempted = true;

            // `dotnet tool run ilverify --version` returns 0 when the manifest
            // tool is already restored. Only pay the restore cost when needed.
            (int probeExit, _) = this.RunDotnet(new[] { "tool", "run", "ilverify", "--version" });
            if (probeExit != 0)
            {
                this.RunDotnet(new[] { "tool", "restore" });
            }
        }
    }

    private (int Exit, string Output) RunDotnet(IReadOnlyList<string> arguments)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,

            // The local tool manifest is discovered relative to the working
            // directory; anchor at the repo root. All paths are passed absolute.
            WorkingDirectory = this.RepoRoot,
        };
        foreach (string arg in arguments)
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi);
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }
}

/// <summary>
/// A single parsed <c>ilverify</c> error: its ECMA-335 category code, the
/// failing method skeleton (when present), and the trimmed raw line.
/// </summary>
public sealed class IlVerifyError
{
    /// <summary>
    /// Initializes a new instance of the <see cref="IlVerifyError"/> class.
    /// </summary>
    /// <param name="code">The ilverify error code (e.g. <c>StackUnexpected</c>).</param>
    /// <param name="method">The failing <c>Type::Method(sig)</c>, or null.</param>
    /// <param name="rawLine">The trimmed ilverify error line.</param>
    public IlVerifyError(string code, string method, string rawLine)
    {
        this.Code = code;
        this.Method = method;
        this.RawLine = rawLine;
    }

    /// <summary>Gets the ilverify error code (the ECMA-335 category).</summary>
    public string Code { get; }

    /// <summary>Gets the failing <c>Type::Method(sig)</c> skeleton, or null.</summary>
    public string Method { get; }

    /// <summary>Gets the trimmed ilverify error line.</summary>
    public string RawLine { get; }
}

/// <summary>
/// The outcome of an <see cref="IlVerifyRunner.Verify"/> invocation.
/// </summary>
public sealed class IlVerifyResult
{
    private IlVerifyResult(
        IlVerifyStatus status,
        int exitCode,
        string output,
        IReadOnlyList<IlVerifyError> errors)
    {
        this.Status = status;
        this.ExitCode = exitCode;
        this.Output = output;
        this.Errors = errors ?? Array.Empty<IlVerifyError>();
    }

    /// <summary>Gets the verification status.</summary>
    public IlVerifyStatus Status { get; }

    /// <summary>Gets the ilverify process exit code (0 when skipped/passed).</summary>
    public int ExitCode { get; }

    /// <summary>Gets the combined stdout+stderr (empty when skipped).</summary>
    public string Output { get; }

    /// <summary>Gets the parsed, false-positive-filtered errors (empty on pass).</summary>
    public IReadOnlyList<IlVerifyError> Errors { get; }

    /// <summary>Gets a value indicating whether the stage-3 gate held.</summary>
    public bool Succeeded => this.Status != IlVerifyStatus.Failed;

    /// <summary>Creates a skipped result (verification bypassed or no assembly).</summary>
    /// <returns>A skipped <see cref="IlVerifyResult"/>.</returns>
    public static IlVerifyResult Skipped() =>
        new IlVerifyResult(IlVerifyStatus.Skipped, 0, string.Empty, Array.Empty<IlVerifyError>());

    /// <summary>Creates a passing result.</summary>
    /// <param name="output">The tool output.</param>
    /// <param name="errors">The (empty, post-filter) error list.</param>
    /// <returns>A passing <see cref="IlVerifyResult"/>.</returns>
    public static IlVerifyResult Passed(string output, IReadOnlyList<IlVerifyError> errors) =>
        new IlVerifyResult(IlVerifyStatus.Passed, 0, output, errors);

    /// <summary>Creates a failing result carrying the parsed errors.</summary>
    /// <param name="exitCode">The ilverify exit code.</param>
    /// <param name="output">The tool output.</param>
    /// <param name="errors">The parsed, false-positive-filtered errors.</param>
    /// <returns>A failing <see cref="IlVerifyResult"/>.</returns>
    public static IlVerifyResult Failed(int exitCode, string output, IReadOnlyList<IlVerifyError> errors) =>
        new IlVerifyResult(IlVerifyStatus.Failed, exitCode, output, errors);
}
