// <copyright file="Issue1055OverrideGenericBaseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1055: when a class overrides an <c>open</c> base member whose
/// signature USES the base class's generic type parameters, and the base is
/// inherited as a CONSTRUCTED generic (e.g. <c>Derived : Base[int32, int32]</c>),
/// the override-matcher must first substitute the constructed base's type
/// arguments into the candidate base member's signature before comparing.
/// These tests compile and run an end-to-end program that dispatches through a
/// base-typed reference to confirm the override is correctly bound, emitted
/// (with the right base <c>extends</c> TypeSpec and base-ctor chaining), and
/// dispatched at runtime; the emitted IL is also checked with <c>ilverify</c>.
/// </summary>
public class Issue1055OverrideGenericBaseEmitTests
{
    [Fact]
    public void OverrideMethodUsingTypeParams_ConstructedBase_DispatchesThroughBaseRef_Runs()
    {
        var source = """
            package p
            open class Base[TIn, TOut] {
                open func Transform(x TIn) TOut;
            }
            class Derived : Base[int32, int32] {
                override func Transform(x int32) int32 { return x + 1 }
            }
            func Main() {
                let b Base[int32, int32] = Derived()
                System.Console.WriteLine(b.Transform(41))
            }
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void OverridePropertyUsingTypeParam_ConstructedBase_DispatchesThroughBaseRef_Runs()
    {
        var source = """
            package p
            open class Holder[T] {
                open prop Value T { get; }
            }
            class IntHolder : Holder[int32] {
                override prop Value int32 { get { return 7 } }
            }
            func Main() {
                let h Holder[int32] = IntHolder()
                System.Console.WriteLine(h.Value)
            }
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void OverrideMethodAcrossTwoConstructedLevels_DispatchesThroughMidRef_Runs()
    {
        // Leaf : Mid[int32] : Base[T] — the substitution composes across each
        // hop so the abstract `Do(x T) T` declared on Mid[T] is matched by the
        // concrete `Do(x int32) int32` override on Leaf.
        var source = """
            package p
            open class Base[T] {
                open prop Size int32 { get; }
            }
            open class Mid[T] : Base[T] {
                open func Do(x T) T;
            }
            open class Leaf : Mid[int32] {
                override prop Size int32 { get { return 1 } }
                override func Do(x int32) int32 { return x + 100 }
            }
            func Main() {
                let m Mid[int32] = Leaf()
                System.Console.WriteLine(m.Do(5))
            }
            """;

        Assert.Equal("105\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1055_emit_").FullName;
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
