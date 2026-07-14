// <copyright file="Issue2325NestedDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2325: compiling with explicit <c>/reference:</c> assemblies (the
/// same MetadataLoadContext-backed mode cs2gs drives gsc with) previously
/// threw <c>GS9998 ArgumentException: This type '...' was not loaded by the
/// MetadataLoadContext that loaded the generic type or method</c> whenever a
/// function/delegate type was nested inside another delegate signature —
/// e.g. <c>Action&lt;Action&lt;object&gt;, object&gt;</c>.
///
/// Root cause: <c>ReflectionMetadataEmitter.ResolveDelegateClrType</c>
/// resolves the outer open generic delegate through the active reference
/// (MetadataLoadContext) context, but the per-argument helper
/// (<c>ResolveDelegateArgClrType</c>) called <c>MapToReferenceClrType</c>,
/// which only performed a flat <c>Type.FullName</c> lookup. A *constructed*
/// generic argument's <c>FullName</c> embeds each nested argument's
/// assembly-qualified name (e.g.
/// <c>"System.Action`1[[System.Object, System.Private.CoreLib, ...]]"</c>),
/// which never matches the reference index (built from open generic
/// *definitions* only), so the lookup silently fell back to the host-context
/// <see cref="Type"/>. <c>MakeGenericType</c> then combined a
/// MetadataLoadContext open definition with a host-context type argument —
/// exactly the mismatch <c>MakeGenericType</c> rejects at runtime.
/// <c>ResolveTargetDelegateClrType</c> already contained the correct
/// recursive constructed-generic remapping logic (for a delegate type
/// obtained by reflecting over a host CLR method), so the two code paths had
/// diverged. The fix makes <c>MapToReferenceClrType</c> itself the single
/// recursive reference-context remapper — resolving a constructed generic's
/// open definition in the active reference context and recursing into every
/// type argument through the same helper — so both
/// <c>ResolveDelegateArgClrType</c> and <c>ResolveTargetDelegateClrType</c>
/// share one implementation instead of maintaining divergent copies.
///
/// These tests drive gsc through explicit <c>/reference:</c> flags pointing
/// at the <c>Microsoft.NETCore.App.Ref</c> targeting-pack facades — the same
/// reference-assembly closure the .NET SDK (and cs2gs) supplies — so the
/// MetadataLoadContext code path that reproduces GS9998 is actually
/// exercised (the TPA-backed default resolver shares the host's runtime
/// identity and would mask the bug). Each test compiles, ILVerifies, and
/// runs the emitted assembly end-to-end.
/// </summary>
public class Issue2325NestedDelegateEmitTests
{
    [Fact]
    public void NestedAction_MinimalReproFromIssue_CompilesRunsAndIlVerifies()
    {
        // Exact minimal repro from the issue: an outer two-parameter Action
        // whose first parameter is itself an `(object?) -> void` function
        // type — i.e. Action<Action<object>, object> once both levels are
        // materialised as CLR delegates.
        var gsource = """
            package Repro
            import System

            func Invoke2(cb ((object?) -> void, object?) -> void) {
                cb((o object?) -> Console.WriteLine(o), nil)
            }

            Invoke2((inner (object?) -> void, arg object?) -> inner(arg))
            """;

        Assert.Equal("\n", CompileAndRun(gsource));
    }

    [Fact]
    public void NestedFunc_ReturningVariant_CompilesRunsAndIlVerifies()
    {
        // A nested Func-shaped (returning) variant of the same bug: the
        // outer delegate's first parameter is itself a value-returning
        // `(int32) -> int32` function type, i.e.
        // Func<Func<int32,int32>, int32, int32>.
        var gsource = """
            package Repro
            import System

            func Invoke2(cb ((int32) -> int32, int32) -> int32) int32 {
                return cb((x int32) -> x + 1, 41)
            }

            Console.WriteLine(Invoke2((inner (int32) -> int32, arg int32) -> inner(arg)))
            """;

        Assert.Equal("42\n", CompileAndRun(gsource));
    }

    [Fact]
    public void OahuSendOrPostCallbackShape_CompilesRunsAndIlVerifies()
    {
        // Structurally mirrors the real Oahu occurrence:
        // ExtensionsSyncContext.SendOrPost(Action<SendOrPostCallback, object> sendOrPost, Action delgat).
        // G# has no named-delegate type distinct from a structural function
        // type, so a CLR `SendOrPostCallback` parameter (Invoke shape
        // `void Invoke(object state)`) translates to the nested function
        // type `(object?) -> void` — exactly reproducing the two-parameter,
        // nested-first-argument shape that triggered GS9998.
        var gsource = """
            package Repro
            import System

            func SendOrPost(sendOrPost ((object?) -> void, object?) -> void, delgat () -> void) {
                sendOrPost((state object?) -> Console.WriteLine(state), "hello")
                delgat()
            }

            SendOrPost((callback (object?) -> void, state object?) -> callback(state), () -> Console.WriteLine("done"))
            """;

        Assert.Equal("hello\ndone\n", CompileAndRun(gsource));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2325_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
            };

            foreach (var reference in RefPackReferences())
            {
                args.Add("/reference:" + reference);
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    /// <summary>
    /// Assembles the same reference closure the .NET SDK (and cs2gs) would
    /// pass to gsc via explicit <c>/reference:</c> flags — the
    /// <c>Microsoft.NETCore.App.Ref</c> targeting-pack facades for the
    /// running runtime. Loading these through gsc's isolated
    /// MetadataLoadContext (rather than the host's trusted-platform
    /// assemblies) is what actually exercises the GS9998 cross-context
    /// mismatch this issue is about — the TPA-backed default resolver shares
    /// the host runtime's own <c>System.Private.CoreLib</c> identity and
    /// would mask the bug. Throws (via <see cref="Xunit.Sdk.XunitException"/>)
    /// rather than silently skipping when the ref-pack is absent, so a CI
    /// environment missing the ref-pack surfaces a clear diagnostic instead
    /// of a false pass.
    /// </summary>
    private static IEnumerable<string> RefPackReferences()
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir))
        {
            throw new Xunit.Sdk.XunitException("host runtime directory not resolvable");
        }

        var sharedDir = Directory.GetParent(runtimeDir)?.Parent;
        var dotnetRoot = sharedDir?.Parent?.FullName;
        if (string.IsNullOrEmpty(dotnetRoot))
        {
            throw new Xunit.Sdk.XunitException("dotnet root not resolvable");
        }

        var tfm = $"net{Environment.Version.Major}.0";
        var packsRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref");
        if (!Directory.Exists(packsRoot))
        {
            throw new Xunit.Sdk.XunitException($"ref pack root '{packsRoot}' missing");
        }

        var version = Environment.Version.ToString(3);
        var refDir = Path.Combine(packsRoot, version, "ref", tfm);
        if (!Directory.Exists(refDir))
        {
            var major = Environment.Version.Major.ToString();
            var candidate = Directory.EnumerateDirectories(packsRoot, major + ".*")
                .OrderByDescending(d => d, StringComparer.Ordinal)
                .Select(d => Path.Combine(d, "ref", tfm))
                .FirstOrDefault(Directory.Exists);
            if (string.IsNullOrEmpty(candidate))
            {
                throw new Xunit.Sdk.XunitException($"no ref pack for net{major}.0 under '{packsRoot}'");
            }

            refDir = candidate;
        }

        return Directory.EnumerateFiles(refDir, "*.dll").ToArray();
    }
}
