// <copyright file="Issue1132LetReferenceFieldWriteEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1132: a member write through a <c>let</c> reference-type local
/// mutates the heap object, not the (read-only) binding, so it must compile
/// AND emit correctly. These tests compile+run a snippet to prove the heap
/// mutation actually happens at runtime, not just that it binds.
/// </summary>
public class Issue1132LetReferenceFieldWriteEmitTests
{
    [Fact]
    public void LetClassLocal_FieldWrite_MutatesHeapObject()
    {
        // Acceptance #6: `let b = Box{}; b.Value = 5` mutates the heap object.
        var source = """
            package p
            import System

            class Box { var Value int32 = 0 }

            func makeAndMutate() int32 {
                let b = Box{ }
                b.Value = 5
                return b.Value
            }

            public var result = makeAndMutate()
            """;

        Assert.Equal(5, RunAndGetIntResult(source));
    }

    [Fact]
    public void LetClassLocal_CompoundAndIncrement_MutatesHeapObject()
    {
        // Acceptance #6: compound `+=` and `++` through a `let` class local.
        var source = """
            package p
            import System

            class Counter { var Value int32 = 0 }

            func count() int32 {
                let c = Counter{ }
                c.Value += 4
                c.Value++
                return c.Value
            }

            public var result = count()
            """;

        Assert.Equal(5, RunAndGetIntResult(source));
    }

    [Fact]
    public void LetClassLocal_PropertyWrite_MutatesHeapObject()
    {
        // Acceptance #6: property write through a `let` class local.
        var source = """
            package p
            import System

            class Box {
                var _v int32 = 0
                prop Value int32 {
                    get { return _v }
                    set { _v = value }
                }
            }

            func makeAndMutate() int32 {
                let b = Box{ }
                b.Value = 5
                return b.Value
            }

            public var result = makeAndMutate()
            """;

        Assert.Equal(5, RunAndGetIntResult(source));
    }

    private static int RunAndGetIntResult(string source)
    {
        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod(
            "<Main>$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField(
            "result",
            BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
        return (int)resultField!.GetValue(null)!;
    }

    private static Assembly CompileToAssembly(string source, string target)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1132_emit_").FullName;
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
                "/target:" + target,
                "/targetframework:net10.0",
                srcPath,
            });
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

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
