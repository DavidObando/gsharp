// <copyright file="Issue1578UserValueTypeNullableCoalesceEmitTests.cs" company="GSharp">
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
/// Issue #1578: null-coalesce <c>??</c> over a user-declared value-type nullable
/// (<c>struct?</c> / <c>enum?</c>) must emit verifiable IL. The primitive
/// <c>Nullable&lt;T&gt;</c> <c>??</c> path (issue #519) probes via the BCL-backed
/// <c>get_HasValue</c>, but user value types have a null CLR <see cref="Type"/>
/// during emit, so #1572's TypeSpec machinery is required. The emitter spills the
/// <c>Nullable&lt;UserT&gt;</c> LHS to a pre-allocated slot, box-probes it over the
/// emitted <c>Nullable&lt;UserT&gt;</c> TypeSpec (<c>box; brfalse</c> — boxing a
/// <c>Nullable&lt;T&gt;</c> yields <c>null</c> when empty, ECMA-335), and on the
/// non-null branch either reloads the wrapper (result is <c>Nullable&lt;UserT&gt;</c>)
/// or unwraps to <c>UserT</c> via the TypeSpec <c>get_Value</c> MemberRef (#1572).
///
/// Each test compiles via <c>gsc</c>, IL-verifies the produced PE, then executes
/// it under <c>dotnet exec</c> and asserts on captured stdout. Every user
/// struct/enum/package is given a UNIQUE name because the in-process name-keyed
/// <c>FunctionTypeSymbol</c> cache is not cleared between tests.
/// </summary>
public class Issue1578UserValueTypeNullableCoalesceEmitTests
{
    [Fact]
    public void StructCoalesce_NilOperandTakesFallback()
    {
        var source = """
            package CoalStructNilPkg

            import System

            struct CsnPt { var x int32 }

            func Coalesce(v CsnPt?) CsnPt {
                let fb = CsnPt{x: -1}
                return v ?? fb
            }

            let none CsnPt? = nil
            Console.WriteLine(Coalesce(none).x)
            """;

        Assert.Equal("-1\n", CompileAndRun(source));
    }

    [Fact]
    public void StructCoalesce_PresentOperandTakesValue()
    {
        var source = """
            package CoalStructPresentPkg

            import System

            struct CspPt { var x int32 }

            func Coalesce(v CspPt?) CspPt {
                let fb = CspPt{x: -1}
                return v ?? fb
            }

            let some CspPt? = CspPt{x: 9}
            Console.WriteLine(Coalesce(some).x)
            """;

        Assert.Equal("9\n", CompileAndRun(source));
    }

    [Fact]
    public void EnumCoalesce_NilAndPresentOperands()
    {
        var source = """
            package CoalEnumPkg

            import System

            enum CeColor { Red, Green, Blue }

            func Coalesce(v CeColor?) CeColor { return v ?? CeColor.Red }

            let none CeColor? = nil
            let some CeColor? = CeColor.Blue
            Console.WriteLine(Coalesce(none) == CeColor.Red)
            Console.WriteLine(Coalesce(some) == CeColor.Blue)
            """;

        Assert.Equal("True\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void MultiFieldStructCoalesce_NilAndPresent()
    {
        var source = """
            package CoalMultiPkg

            import System

            struct CmRec {
                var a int32
                var b string
                var c bool
            }

            func Coalesce(v CmRec?) CmRec {
                return v ?? CmRec{a: 1, b: "fb", c: false}
            }

            let none CmRec? = nil
            let some CmRec? = CmRec{a: 2, b: "present", c: true}
            Console.WriteLine(Coalesce(none).b)
            Console.WriteLine(Coalesce(some).b)
            """;

        Assert.Equal("fb\npresent\n", CompileAndRun(source));
    }

    [Fact]
    public void StructWithReferenceFieldCoalesce_ReadsReferenceMember()
    {
        var source = """
            package CoalRefFieldPkg

            import System

            struct CrfNamed {
                var name string
                var count int32
            }

            func Coalesce(v CrfNamed?) CrfNamed {
                return v ?? CrfNamed{name: "fallback", count: 0}
            }

            let none CrfNamed? = nil
            Console.WriteLine(Coalesce(none).name)
            """;

        Assert.Equal("fallback\n", CompileAndRun(source));
    }

    [Fact]
    public void EmptyStructCoalesce_NilTakesFallback()
    {
        var source = """
            package CoalEmptyPkg

            import System

            struct CeUnit {}

            func Coalesce(v CeUnit?) CeUnit { return v ?? CeUnit{} }

            let none CeUnit? = nil
            Console.WriteLine(Coalesce(none).ToString())
            """;

        Assert.Equal("CoalEmptyPkg.CeUnit\n", CompileAndRun(source));
    }

    [Fact]
    public void StructCoalesceChain_ThreeOperands()
    {
        var source = """
            package CoalChainPkg

            import System

            struct CcPt { var x int32 }

            func Chain(v CcPt?, w CcPt?) CcPt {
                return v ?? w ?? CcPt{x: -99}
            }

            let none CcPt? = nil
            let w CcPt? = CcPt{x: 5}
            Console.WriteLine(Chain(none, none).x)
            Console.WriteLine(Chain(none, w).x)
            """;

        Assert.Equal("-99\n5\n", CompileAndRun(source));
    }

    [Fact]
    public void StructCoalesceMemberAccessOnResult()
    {
        var source = """
            package CoalMemberPkg

            import System

            struct CmemPt { var x int32 }

            func GetX(v CmemPt?) int32 {
                let fb = CmemPt{x: 42}
                return (v ?? fb).x
            }

            let none CmemPt? = nil
            let some CmemPt? = CmemPt{x: 9}
            Console.WriteLine(GetX(none))
            Console.WriteLine(GetX(some))
            """;

        Assert.Equal("42\n9\n", CompileAndRun(source));
    }

    [Fact]
    public void StructCoalesce_NullableResultBranchReloadsWrapper()
    {
        var source = """
            package CoalNullableRhsPkg

            import System

            struct CnrPt { var x int32 }

            func Coalesce(v CnrPt?, w CnrPt?) CnrPt {
                let fb = CnrPt{x: -5}
                return (v ?? w) ?? fb
            }

            let none CnrPt? = nil
            let w CnrPt? = CnrPt{x: 7}
            Console.WriteLine(Coalesce(none, none).x)
            Console.WriteLine(Coalesce(none, w).x)
            """;

        Assert.Equal("-5\n7\n", CompileAndRun(source));
    }

    [Fact]
    public void PrimitiveCoalesce_StillEmitsVerifiableIl()
    {
        var source = """
            package CoalPrimPkg

            import System

            func Coalesce(v int32?) int32 { return v ?? -1 }

            let none int32? = nil
            let some int32? = 8
            Console.WriteLine(Coalesce(none))
            Console.WriteLine(Coalesce(some))
            """;

        Assert.Equal("-1\n8\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1578_").FullName;
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
                "/nowarn:GS9100",
            };

            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
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
            return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
