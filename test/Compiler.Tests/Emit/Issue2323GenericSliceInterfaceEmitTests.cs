// <copyright file="Issue2323GenericSliceInterfaceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2323: the binder already accepts a slice <c>[]T</c> converting to
/// each of the five supported one-argument generic collection interfaces —
/// <c>IEnumerable[T]</c>, <c>ICollection[T]</c>, <c>IList[T]</c>,
/// <c>IReadOnlyList[T]</c>, <c>IReadOnlyCollection[T]</c> — when <c>T</c> is a
/// generic type parameter (via <c>Conversion.SliceConvertsToInterfaceSymbolically</c>),
/// but <c>MethodBodyEmitter.IsReferenceCompatible</c> only mirrored the
/// element-INDEPENDENT #2140 array supertypes and threw
/// <see cref="NotSupportedException"/> (surfaced as GS9998) for these five
/// generic interfaces. These tests prove the paired emitter fix end-to-end —
/// compile, ILVerify, and run — for all five interfaces using the exact
/// shape from the issue's minimal repro (a generic <c>Holder[T]</c> class),
/// plus negative coverage proving mismatched element types and unsupported
/// generic interfaces are still rejected at BIND time (never reaching the
/// emitter).
/// </summary>
public class Issue2323GenericSliceInterfaceEmitTests
{
    [Fact]
    public void GenericParamElementSlice_ToIEnumerable_CompilesRunsAndIlVerifies()
    {
        var gsource = """
            package Repro
            import System
            import System.Collections.Generic

            class Holder[T] {
                var items IEnumerable[T]
                init(values []T) { items = values }
                func Count() int32 {
                    var n int32 = 0
                    for x in items { n = n + 1 }
                    return n
                }
            }

            var h = Holder[int32]([]int32{1, 2, 3})
            Console.WriteLine(h.Count())
            """;

        Assert.Equal("3\n", CompileAndRun(gsource));
    }

    [Fact]
    public void GenericParamElementSlice_ToICollection_CompilesRunsAndIlVerifies()
    {
        var gsource = """
            package Repro
            import System
            import System.Collections.Generic

            class Holder[T] {
                var items ICollection[T]
                init(values []T) { items = values }
            }

            var h = Holder[int32]([]int32{1, 2, 3, 4})
            Console.WriteLine(h.items.Count)
            """;

        Assert.Equal("4\n", CompileAndRun(gsource));
    }

    [Fact]
    public void GenericParamElementSlice_ToIList_CompilesRunsAndIlVerifies()
    {
        var gsource = """
            package Repro
            import System
            import System.Collections.Generic

            class Holder[T] {
                var items IList[T]
                init(values []T) { items = values }
            }

            var h = Holder[int32]([]int32{1, 2, 3})
            Console.WriteLine(h.items.Count)
            Console.WriteLine(h.items[1])
            """;

        Assert.Equal("3\n2\n", CompileAndRun(gsource));
    }

    [Fact]
    public void GenericParamElementSlice_ToIReadOnlyList_CompilesRunsAndIlVerifies()
    {
        var gsource = """
            package Repro
            import System
            import System.Collections.Generic

            class Holder[T] {
                var items IReadOnlyList[T]
                init(values []T) { items = values }
            }

            var h = Holder[int32]([]int32{7, 9})
            Console.WriteLine(h.items[0])
            Console.WriteLine(h.items.Count)
            """;

        Assert.Equal("7\n2\n", CompileAndRun(gsource));
    }

    [Fact]
    public void GenericParamElementSlice_ToIReadOnlyCollection_CompilesRunsAndIlVerifies()
    {
        var gsource = """
            package Repro
            import System
            import System.Collections.Generic

            class Holder[T] {
                var items IReadOnlyCollection[T]
                init(values []T) { items = values }
            }

            var h = Holder[int32]([]int32{1, 2, 3, 4, 5})
            Console.WriteLine(h.items.Count)
            """;

        Assert.Equal("5\n", CompileAndRun(gsource));
    }

    [Fact]
    public void GenericParamElementSlice_ToIList_WithStringInstantiation_CompilesRunsAndIlVerifies()
    {
        // Same generic Holder[T], closed over a reference-type argument
        // instead of the primitive int32 used above.
        var gsource = """
            package Repro
            import System
            import System.Collections.Generic

            class Holder[T] {
                var items IList[T]
                init(values []T) { items = values }
            }

            var h = Holder[string]([]string{"a", "b", "c"})
            Console.WriteLine(h.items.Count)
            Console.WriteLine(h.items[2])
            """;

        Assert.Equal("3\nc\n", CompileAndRun(gsource));
    }

    [Fact]
    public void Negative_GenericParamElementSlice_ToMismatchedIList_FailsAtBind()
    {
        // Slice invariance must hold: []T does NOT convert to IList[U] for a
        // different generic parameter U. Must fail to compile (never reach
        // the emitter), not crash with GS9998.
        var gsource = """
            package Repro
            import System.Collections.Generic

            class Holder[T, U] {
                var items IList[U]
                init(values []T) { items = values }
            }
            """;

        var (exitCode, stderr) = Compile(gsource);
        Assert.NotEqual(0, exitCode);
        Assert.DoesNotContain("GS9998", stderr);
    }

    [Fact]
    public void Negative_GenericParamElementSlice_ToUnsupportedGenericInterface_FailsAtBind()
    {
        // ISet[T] is not one of the five supported array supertype
        // interfaces; []T must not convert to it.
        var gsource = """
            package Repro
            import System.Collections.Generic

            class Holder[T] {
                var items ISet[T]
                init(values []T) { items = values }
            }
            """;

        var (exitCode, stderr) = Compile(gsource);
        Assert.NotEqual(0, exitCode);
        Assert.DoesNotContain("GS9998", stderr);
    }

    private static (int ExitCode, string Stderr) Compile(string source, string[] ignoredIlErrorCodes = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2323_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            return (compileExit, compileOut.ToString() + compileErr.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRun(string source, string[] ignoredIlErrorCodes = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2323_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath, ignoredErrorCodes: ignoredIlErrorCodes);

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
}
