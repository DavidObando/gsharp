// <copyright file="Issue1496IfExpressionDefaultEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1496 — an if-expression (<c>if cond { ... } else { ... }</c>) with a
/// bare <c>default</c> arm whose merge type is an open type parameter, a
/// nullable open generic, an erased user generic, or a value type emitted
/// <c>ldnull</c> for the <c>default</c> arm instead of a zero-initialized value,
/// producing unverifiable IL (<c>found Nullobjref expected value 'T'</c>). The
/// ternary <c>cond ? value : default</c> path already pre-typed the bare default
/// from its sibling; the if-expression path did not, so the placeholder
/// <c>BoundDefaultExpression(syntax, TypeSymbol.Error)</c> survived to emit.
/// The fix materialises the bare default against the conditional merge target at
/// the shared <c>ConvertConditionalBranch</c> choke point, covering both <c>if</c>
/// and <c>?:</c>.
///
/// One facet per distinct result-type IL shape: interface-constrained <c>T?</c>,
/// <c>[T struct] T?</c>, <c>[T class] T?</c>, unconstrained <c>T</c>, an erased
/// user generic <c>G[T]</c>, a concrete struct (<c>initobj</c>), a reference type
/// (still <c>ldnull</c>, no regression), and both-<c>default</c> arms with a
/// target type. Each uses a UNIQUE package/type name to avoid the in-process,
/// name-keyed <c>FunctionTypeSymbol</c> cache contaminating sibling tests.
/// </summary>
public class Issue1496IfExpressionDefaultEmitTests
{
    [Fact]
    public void EndToEnd_InterfaceConstrainedNullable_DefaultArmIsNull_Runs()
    {
        var source = """
            package P1496Iface
            import System
            interface ITag1496[T] { func Tag() string; }
            class TagBox1496 : ITag1496[TagBox1496] { func Tag() string -> "tb" }
            class HolderIf1496[T ITag1496[T]] {
                func GetOrDefault(present bool, value T) T? -> if !present { default } else { value }
            }
            func Main() {
                var h = HolderIf1496[TagBox1496]()
                Console.WriteLine(h.GetOrDefault(false, TagBox1496()) == nil)
                Console.WriteLine(h.GetOrDefault(true, TagBox1496()) == nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_StructConstrainedNullable_DefaultArmIsNull_Runs()
    {
        var source = """
            package P1496Struct
            import System
            struct MyVal1496 { var n int32 }
            class HolderSt1496[T struct] {
                func GetOrDefault(present bool, value T) T? -> if !present { default } else { value }
            }
            func Main() {
                var h = HolderSt1496[MyVal1496]()
                Console.WriteLine(h.GetOrDefault(false, MyVal1496{n: 9}) == nil)
                Console.WriteLine(h.GetOrDefault(true, MyVal1496{n: 9}) == nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_ClassConstrainedNullable_DefaultArmIsNull_Runs()
    {
        var source = """
            package P1496Class
            import System
            class Ref1496 { var n int32 }
            class HolderCl1496[T class] {
                func GetOrDefault(present bool, value T) T? -> if !present { default } else { value }
            }
            func Main() {
                var h = HolderCl1496[Ref1496]()
                Console.WriteLine(h.GetOrDefault(false, Ref1496()) == nil)
                Console.WriteLine(h.GetOrDefault(true, Ref1496()) == nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_UnconstrainedTypeParameter_DefaultArmIsZero_Runs()
    {
        var source = """
            package P1496UnconstrainedT
            import System
            class HolderU1496[T] {
                func Pick(c bool, v T) T -> if c { default } else { v }
            }
            func Main() {
                var hi = HolderU1496[int32]()
                Console.WriteLine(hi.Pick(true, 7))
                Console.WriteLine(hi.Pick(false, 7))
                var hs = HolderU1496[string]()
                Console.WriteLine(hs.Pick(true, "x") == nil)
                Console.WriteLine(hs.Pick(false, "x"))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n7\nTrue\nx\n", output);
    }

    [Fact]
    public void EndToEnd_ErasedUserGenericNullable_DefaultArmIsNull_Runs()
    {
        var source = """
            package P1496Box
            import System
            class Box1496[T] { var v T }
            class Maker1496[T] {
                func GetOrDefault(present bool, b Box1496[T]) Box1496[T]? -> if !present { default } else { b }
            }
            func Main() {
                var m = Maker1496[int32]()
                Console.WriteLine(m.GetOrDefault(false, Box1496[int32]()) == nil)
                Console.WriteLine(m.GetOrDefault(true, Box1496[int32]()) == nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_ConcreteStruct_DefaultArmInitObjZeroValue_Runs()
    {
        var source = """
            package P1496ConcreteStruct
            import System
            struct Point1496 {
                var x int32
                var y int32
            }
            class Sc1496 {
                func Get(c bool) Point1496 -> if c { default } else { Point1496{x: 3, y: 4} }
            }
            func Main() {
                var s = Sc1496()
                Console.WriteLine(s.Get(true).x)
                Console.WriteLine(s.Get(false).x)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n3\n", output);
    }

    [Fact]
    public void EndToEnd_ReferenceType_DefaultArmStillNullAndVerifies_Runs()
    {
        var source = """
            package P1496RefDefault
            import System
            class Sr1496 {
                func Get(c bool, s string) string -> if c { default } else { s }
            }
            func Main() {
                var s = Sr1496()
                Console.WriteLine(s.Get(true, "hi") == nil)
                Console.WriteLine(s.Get(false, "hi"))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nhi\n", output);
    }

    [Fact]
    public void EndToEnd_BothArmsBareDefaultWithTargetType_DefaultIsNull_Runs()
    {
        var source = """
            package P1496BothDefault
            import System
            class HolderBd1496[T struct] {
                func Pick(c bool) T? -> if c { default } else { default }
            }
            func Main() {
                var h = HolderBd1496[int32]()
                Console.WriteLine(h.Pick(true) == nil)
                Console.WriteLine(h.Pick(false) == nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nTrue\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1496_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
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
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

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
