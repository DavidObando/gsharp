// <copyright file="Issue1572UserValueTypeNullableEmitTests.cs" company="GSharp">
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
/// Issue #1572: user-declared value-type nullables (<c>struct?</c> / <c>enum?</c>)
/// must emit verifiable IL for the nil-default, lift, <c>(v!!)</c> unwrap, and
/// <c>(v!!).Member</c> operations, plus the <c>if v != nil { ... }</c> narrowing
/// (issue #1547) that reuses the same unwrap machinery. In-flight user value
/// types have a null CLR <see cref="Type"/> during emit, so the detector must be
/// symbol-aware (<c>StructSymbol</c> with <c>!IsClass</c>, or <c>EnumSymbol</c>)
/// and the emitter must close <c>System.Nullable`1</c> over the emitted
/// TypeDef/TypeSpec rather than a host <c>Type</c>.
///
/// Each test compiles via <c>gsc</c>, IL-verifies the produced PE, then executes
/// it under <c>dotnet exec</c> and asserts on captured stdout. Every user
/// struct/enum/package is given a UNIQUE name because the in-process
/// name-keyed <c>FunctionTypeSymbol</c> cache is not cleared between tests.
/// </summary>
public class Issue1572UserValueTypeNullableEmitTests
{
    [Fact]
    public void StructNilDefault_EmitsVerifiableInitobj()
    {
        var source = """
            package NilDefaultPkg

            import System

            struct PtA { var x int32 }

            func MakeNil() PtA? { return nil }

            let v = MakeNil()
            Console.WriteLine(v == nil)
            """;

        Assert.Equal("True\n", CompileAndRun(source));
    }

    [Fact]
    public void StructLift_EmitsNewobjNullableCtor()
    {
        var source = """
            package LiftPkg

            import System

            struct PtB { var x int32 }

            func Lift() PtB? {
                let p = PtB{x: 7}
                return p
            }

            let v = Lift()
            Console.WriteLine((v!!).x)
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void StructBang_UnwrapsViaGetValue()
    {
        var source = """
            package BangPkg

            import System

            struct PtC { var x int32 }

            func Unwrap(v PtC?) PtC { return v!! }

            let p = PtC{x: 42}
            let r = Unwrap(p)
            Console.WriteLine(r.x)
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void StructBangMember_ReadsFieldOffUnwrappedValue()
    {
        var source = """
            package BangMemberPkg

            import System

            struct PtD { var x int32 }

            func GetX(v PtD?) int32 { return (v!!).x }

            let p = PtD{x: 99}
            Console.WriteLine(GetX(p))
            """;

        Assert.Equal("99\n", CompileAndRun(source));
    }

    [Fact]
    public void EnumBang_UnwrapsViaGetValue()
    {
        var source = """
            package EnumBangPkg

            import System

            enum ColorA { Red, Green, Blue }

            func Unwrap(v ColorA?) ColorA { return v!! }

            let c ColorA? = ColorA.Green
            let r = Unwrap(c)
            Console.WriteLine(r == ColorA.Green)
            """;

        Assert.Equal("True\n", CompileAndRun(source));
    }

    [Fact]
    public void EnumNilDefault_EmitsVerifiableInitobj()
    {
        var source = """
            package EnumNilPkg

            import System

            enum ColorB { Red, Green }

            func MakeNil() ColorB? { return nil }

            let v = MakeNil()
            Console.WriteLine(v == nil)
            """;

        Assert.Equal("True\n", CompileAndRun(source));
    }

    [Fact]
    public void StructNarrowing_IfNotNil_ReadsUnwrappedValue()
    {
        var source = """
            package NarrowStructPkg

            import System

            struct PtE { var x int32 }

            func Describe(v PtE?) int32 {
                if v != nil {
                    return v.x
                }
                return -1
            }

            let p = PtE{x: 5}
            let none PtE? = nil
            Console.WriteLine(Describe(p))
            Console.WriteLine(Describe(none))
            """;

        Assert.Equal("5\n-1\n", CompileAndRun(source));
    }

    [Fact]
    public void EnumNarrowing_IfNotNil_ReadsUnwrappedValue()
    {
        var source = """
            package NarrowEnumPkg

            import System

            enum ColorC { Red, Green, Blue }

            func Pick(v ColorC?) ColorC {
                if v != nil {
                    return v
                }
                return ColorC.Red
            }

            let c ColorC? = ColorC.Blue
            let none ColorC? = nil
            Console.WriteLine(Pick(c) == ColorC.Blue)
            Console.WriteLine(Pick(none) == ColorC.Red)
            """;

        Assert.Equal("True\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void MultiFieldStruct_LiftUnwrapAndMemberAllVerify()
    {
        var source = """
            package MultiFieldPkg

            import System

            struct Rec {
                var a int32
                var b string
                var c bool
            }

            func Lift() Rec? {
                let r = Rec{a: 1, b: "hi", c: true}
                return r
            }

            func GetB(v Rec?) string { return (v!!).b }

            let lifted = Lift()
            Console.WriteLine((lifted!!).a)
            Console.WriteLine(GetB(lifted))
            """;

        Assert.Equal("1\nhi\n", CompileAndRun(source));
    }

    [Fact]
    public void StructWithReferenceField_UnwrapReadsReferenceMember()
    {
        var source = """
            package RefFieldPkg

            import System

            struct Named {
                var name string
                var count int32
            }

            func GetName(v Named?) string { return (v!!).name }

            let n = Named{name: "widget", count: 3}
            Console.WriteLine(GetName(n))
            """;

        Assert.Equal("widget\n", CompileAndRun(source));
    }

    [Fact]
    public void EmptyStruct_NilDefaultAndUnwrapVerify()
    {
        var source = """
            package EmptyStructPkg

            import System

            struct Unit {}

            func MakeNil() Unit? { return nil }
            func Unwrap(v Unit?) Unit { return v!! }

            let some Unit? = Unit{}
            let unwrapped = Unwrap(some)
            Console.WriteLine(MakeNil() == nil)
            """;

        Assert.Equal("True\n", CompileAndRun(source));
    }

    [Fact]
    public void ArgumentLift_NonNullableStructPassedToNullableParameter()
    {
        var source = """
            package ArgLiftPkg

            import System

            struct PtF { var x int32 }

            func Take(v PtF?) int32 { return (v!!).x }

            let p = PtF{x: 21}
            Console.WriteLine(Take(p))
            """;

        Assert.Equal("21\n", CompileAndRun(source));
    }

    [Fact]
    public void NullableStructField_UnwrapReadsNestedMember()
    {
        var source = """
            package NestedFieldPkg

            import System

            struct Inner { var v int32 }

            struct Outer {
                var opt Inner?
            }

            func Read(o Outer) int32 { return (o.opt!!).v }

            let o = Outer{opt: Inner{v: 8}}
            Console.WriteLine(Read(o))
            """;

        Assert.Equal("8\n", CompileAndRun(source));
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1572_").FullName;
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
