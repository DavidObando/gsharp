// <copyright file="Issue1323GenericStaticReceiverEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1323: a generic static member-access receiver
/// <c>Type[TypeArg].StaticMember(...)</c> previously only parsed when
/// <c>TypeArg</c> was a SIMPLE name. When the single type argument was nullable
/// (<c>T?</c>), an array/slice (<c>[]T</c>), or a nested generic
/// (<c>List[T]</c>) the parser failed with GS0005 because the #942 trailing-`.`
/// rule treated <c>Name[singleArg].Member</c> as an indexer-then-member access,
/// and those argument shapes are not legal index expressions.
///
/// The fix commits to a generic call site on a trailing <c>.</c> when the
/// single type argument is unambiguously type-shaped, and emits a
/// <c>GenericNameExpression</c> receiver the binder resolves to the closed
/// construction. These end-to-end tests lock the parse → bind → emit → execute
/// chain for the constructed-generic static-call receiver.
/// </summary>
public class Issue1323GenericStaticReceiverEmitTests
{
    [Fact]
    public void NullableTypeArg_StaticCall_Executes()
    {
        // `Box[int32?].Make(41)` — nullable single type argument.
        var source = """
            package P
            struct Box[T] { shared { func Make(x int32) int32 { return x + 1 } } }
            public var result = Box[int32?].Make(41)
            """;

        Assert.Equal(42, RunAndGetIntResult(source));
    }

    [Fact]
    public void ArrayTypeArg_StaticCall_Executes()
    {
        // `Box[[]int32].Make(9)` — array/slice single type argument.
        var source = """
            package P
            struct Box[T] { shared { func Make(x int32) int32 { return x + 1 } } }
            public var result = Box[[]int32].Make(9)
            """;

        Assert.Equal(10, RunAndGetIntResult(source));
    }

    [Fact]
    public void NestedGenericTypeArg_StaticCall_Executes()
    {
        // `Box[List[int32]].Make(100)` — nested-generic single type argument.
        var source = """
            package P
            import System.Collections.Generic
            struct Box[T] { shared { func Make(x int32) int32 { return x + 1 } } }
            public var result = Box[List[int32]].Make(100)
            """;

        Assert.Equal(101, RunAndGetIntResult(source));
    }

    [Fact]
    public void SimpleTypeArg_StaticCall_StillExecutes()
    {
        // Control: a simple single type argument `Box[int32].Make(7)` keeps
        // working (this resolves through the index-then-member binder path).
        var source = """
            package P
            struct Box[T] { shared { func Make(x int32) int32 { return x + 1 } } }
            public var result = Box[int32].Make(7)
            """;

        Assert.Equal(8, RunAndGetIntResult(source));
    }

    [Fact]
    public void MultiTypeArg_StaticCall_Executes()
    {
        // Control: a multi-type-argument list followed by `.` commits to a
        // generic call site (`Pair[int32, string].Make(21)`).
        var source = """
            package P
            struct Pair[T, U] { shared { func Make(x int32) int32 { return x * 2 } } }
            public var result = Pair[int32, string].Make(21)
            """;

        Assert.Equal(42, RunAndGetIntResult(source));
    }

    private static int RunAndGetIntResult(string source)
    {
        var assembly = CompileToAssembly(source);
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

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1323_emit_").FullName;
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

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
