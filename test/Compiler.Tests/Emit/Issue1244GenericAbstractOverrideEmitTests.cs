// <copyright file="Issue1244GenericAbstractOverrideEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1244: a GENERIC derived class whose <c>override</c> of an abstract base
/// member uses the class type parameter (<c>Der[T] : Base[T]</c> overriding
/// <c>Handle(x T) int32</c>) must be recognized as implementing the abstract, so a
/// concrete leaf (<c>Leaf : Der[int32]</c>) is fully instantiable (no GS0386/GS0387)
/// and emits a correct vtable. These tests drive the real end-to-end emit pipeline:
/// they construct the leaf, run the program, and verify the emitted IL with
/// <c>ilverify</c> — proving the override slot is laid out correctly, not merely the
/// diagnostic.
/// </summary>
public class Issue1244GenericAbstractOverrideEmitTests
{
    [Fact]
    public void CanonicalGenericDerivedOverride_LeafConstructsAndRuns()
    {
        // The canonical #1244 case: ONLY Der[T]'s type-parameter-using override
        // closes Base[T].Handle; Leaf adds no override. Before the fix this failed
        // with GS0387 (Leaf wrongly considered abstract) so it could not be emitted
        // at all. Now it constructs, runs, and the IL verifies.
        var source = """
            package p
            open class Base[T] {
                open func Handle(x T) int32;
            }
            open class Der[T] : Base[T] {
                override func Handle(x T) int32 { return 0 }
            }
            class Leaf : Der[int32] {
                func Plain() int32 { return 42 }
            }
            func Main() {
                let leaf Leaf = Leaf()
                System.Console.WriteLine(leaf.Plain())
            }
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericHierarchyOverride_DispatchesOverriddenValueAtRuntime()
    {
        // Proves runtime vtable dispatch in the same generic hierarchy: Der[T]
        // declares an open override of the type-parameter-using abstract, and the
        // concrete Leaf overrides it again with a concrete signature. Invoking the
        // member must reach Leaf's override and return its value.
        var source = """
            package p
            open class Base[T] {
                open func Handle(x T) int32;
            }
            open class Der[T] : Base[T] {
                open override func Handle(x T) int32 { return -1 }
            }
            class Leaf : Der[int32] {
                override func Handle(x int32) int32 { return x + 1 }
            }
            func Main() {
                let leaf Leaf = Leaf()
                System.Console.WriteLine(leaf.Handle(41))
            }
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void ThreeLevelGenericChain_LeafConstructsAndRuns()
    {
        // FilterBase[T] -> TransformBase[TIn, TOut] (generic derived overriding the
        // type-parameter-using abstract Handle(x TIn)) -> AacFilter (overriding the
        // remaining abstract Perform). The substitution composes across every hop;
        // the concrete leaf constructs and runs, and the IL verifies.
        var source = """
            package p
            open class FilterBase[T] {
                protected open func Handle(x T) int32;
            }
            open class TransformBase[TIn, TOut] : FilterBase[TIn] {
                protected override func Handle(x TIn) int32 { return 0 }
                protected open func Perform(x TIn) TOut;
            }
            open class AacFilter : TransformBase[int32, int32] {
                protected override func Perform(x int32) int32 { return x + 5 }
                func Run(x int32) int32 { return x + 5 }
            }
            func Main() {
                let f AacFilter = AacFilter()
                System.Console.WriteLine(f.Run(37))
            }
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1244_emit_").FullName;
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
