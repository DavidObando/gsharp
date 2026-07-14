// <copyright file="Issue2325NestedArrayDelegateEmitTests.cs" company="GSharp">
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
/// Issue #2325 follow-up: an array-typed delegate parameter (G# slice syntax
/// <c>[]int32</c>, whose CLR shape is the SZArray <c>System.Int32[]</c> —
/// see <c>SliceTypeSymbol</c>/<c>ArrayTypeSymbol</c>, both of which build
/// their CLR type via <c>elementType.ClrType.MakeArrayType()</c> over the
/// element's *host-runtime* <see cref="Type"/>) is subject to the exact same
/// cross-context mismatch as the nested-delegate case covered by
/// <c>Issue2325NestedDelegateEmitTests</c>: an array built over an unmapped
/// host-context element still carries the host identity, so combining it
/// with a reference-context (MetadataLoadContext) open generic definition
/// via <c>MakeGenericType</c> throws GS9998 the same way an unmapped
/// constructed-generic delegate argument did.
///
/// These tests drive gsc through explicit <c>/reference:</c> flags pointing
/// at the <c>Microsoft.NETCore.App.Ref</c> targeting-pack facades (the same
/// reference-assembly closure the .NET SDK and cs2gs supply), so the
/// MetadataLoadContext code path that reproduces the bug is actually
/// exercised. Each test compiles, ILVerifies, and runs the emitted assembly
/// end-to-end.
/// </summary>
public class Issue2325NestedArrayDelegateEmitTests
{
    [Fact]
    public void ArrayDelegateArgument_ActionShape_CompilesRunsAndIlVerifies()
    {
        // The delegate parameter `f`'s function type `([]int32, object?) -> void`
        // materialises as `Action<int32[], object>` — an array argument
        // alongside another argument in the same constructed generic, the
        // shape the array-remapping branch of MapToReferenceClrType exists
        // for. `PrintFirstAndTag` is a plain top-level function (rather than
        // a lambda) so the multi-statement void body needs no special lambda
        // block syntax; converting it to `f`'s function type still routes
        // through the same ResolveDelegateClrType/ResolveDelegateArgClrType
        // path a lambda literal would.
        var gsource = """
            package Repro
            import System

            func Apply(f ([]int32, object?) -> void, arr []int32, extra object?) {
                f(arr, extra)
            }

            func PrintFirstAndTag(values []int32, tag object?) {
                Console.WriteLine(values[0])
                Console.WriteLine(tag)
            }

            Apply(PrintFirstAndTag, []int32{7, 8, 9}, "tag")
            """;

        Assert.Equal("7\ntag\n", CompileAndRun(gsource));
    }

    [Fact]
    public void ArrayDelegateArgument_DoubleNested_CompilesRunsAndIlVerifies()
    {
        // A doubly-nested variant matching the shape of the issue's minimal
        // Action<Action<object>, object> repro, but with the inner
        // delegate's own argument being the array: the outer delegate's
        // first parameter is itself a `([]int32, object?) -> void` function
        // type, i.e. `Action<Action<int32[], object>, object>`.
        var gsource = """
            package Repro
            import System

            func Invoke2(cb (([]int32, object?) -> void, object?) -> void) {
                cb(PrintFirstAndExtra, "outer")
            }

            func PrintFirstAndExtra(values []int32, extra object?) {
                Console.WriteLine(values[0])
                Console.WriteLine(extra)
            }

            Invoke2((inner ([]int32, object?) -> void, arg object?) -> inner([]int32{1, 2, 3}, arg))
            """;

        Assert.Equal("1\nouter\n", CompileAndRun(gsource));
    }

    [Fact]
    public void ArrayReturningNestedFunc_CompilesRunsAndIlVerifies()
    {
        // A Func-shaped (returning) variant: the outer delegate's first
        // parameter is a value-returning `(int32) -> []int32` function type,
        // i.e. Func<Func<int32,int32[]>, int32, int32[]>.
        var gsource = """
            package Repro
            import System

            func Invoke2(cb ((int32) -> []int32, int32) -> []int32) []int32 {
                return cb(MakePair, 41)
            }

            func MakePair(n int32) []int32 {
                return []int32{n, n + 1}
            }

            let result = Invoke2((inner (int32) -> []int32, arg int32) -> inner(arg))
            Console.WriteLine(result[0])
            Console.WriteLine(result[1])
            """;

        Assert.Equal("41\n42\n", CompileAndRun(gsource));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2325_array_").FullName;
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
