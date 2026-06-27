// <copyright file="Issue1248GenericUpcastEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1248: a generic class instance must upcast to its constructed generic base
/// class when the base type argument is one of the derived class's OWN type
/// parameters (<c>TransformBase[TIn, TOut] : FilterBase[TIn]</c>). These tests drive
/// the real end-to-end emit pipeline: they construct the derived instance, upcast it
/// to the base type, invoke a base method at runtime to prove correct dispatch, and
/// verify the emitted IL with <c>ilverify</c> — proving the upcast lowers to a valid
/// no-op reference conversion, not merely that the binder accepts it.
/// </summary>
public class Issue1248GenericUpcastEmitTests
{
    [Fact]
    public void TwoLevelGenericUpcast_PassesAsBaseParameterAndDispatches()
    {
        // TransformBase[int32, int32] is upcast to FilterBase[int32] when passed
        // to Take; the base method Tag is invoked through the base-typed reference.
        var source = """
            package p
            open class FilterBase[T]() {
                open func Tag() int32 { return 7 }
            }
            open class TransformBase[TIn, TOut] : FilterBase[TIn] { }
            class C {
                func Take(f FilterBase[int32]) int32 { return f.Tag() }
                func Run() int32 {
                    var x = TransformBase[int32, int32]()
                    return Take(x)
                }
            }
            func Main() {
                let c C = C()
                System.Console.WriteLine(c.Run())
            }
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void TwoLevelGenericUpcast_OverriddenBaseMethodDispatchesThroughBaseSlot()
    {
        // The derived class overrides the base method; invoking it through the
        // upcast base-typed local must reach the override (vtable dispatch).
        var source = """
            package p
            open class FilterBase[T]() {
                open func Tag() int32 { return 1 }
            }
            open class TransformBase[TIn, TOut] : FilterBase[TIn] {
                override func Tag() int32 { return 42 }
            }
            func Main() {
                let f FilterBase[int32] = TransformBase[int32, int32]()
                System.Console.WriteLine(f.Tag())
            }
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void ConcreteLeafBelowGenericIntermediate_UpcastsAndDispatches()
    {
        // FilterBase[T] -> TransformBase[TIn, TOut] : FilterBase[TIn] ->
        // LosslessFilter : TransformBase[int32, int32]. The concrete leaf upcasts
        // to FilterBase[int32] across two hops and the base method dispatches.
        var source = """
            package p
            open class FilterBase[T]() {
                open func Tag() int32 { return 5 }
            }
            open class TransformBase[TIn, TOut] : FilterBase[TIn] {
                override func Tag() int32 { return 99 }
            }
            class LosslessFilter : TransformBase[int32, int32] { }
            func Main() {
                let f FilterBase[int32] = LosslessFilter()
                System.Console.WriteLine(f.Tag())
            }
            """;

        Assert.Equal("99\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1248_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
