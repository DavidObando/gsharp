// <copyright file="Issue2338GenericInlineStructCompareEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Cluster-A guardrail (self-instantiation token drift): the inline-struct
/// <c>==</c>/<c>!=</c> compare path in <c>MethodBodyEmitter.EmitBinary</c>
/// must resolve its field token through <c>ResolveFieldToken</c> so a
/// <em>generic</em> inline struct emits a self-instantiation
/// <c>MemberRef</c> rather than a bare open <c>FieldDef</c>. A bare
/// <c>FieldDef</c> makes ILVerify report "found ref Box&lt;T0&gt;, expected
/// ref Box". This mirrors the recurring token-drift antipattern fixed at
/// other call sites (#989/#1611/#1055/#2337/#2338).
/// </summary>
public class Issue2338GenericInlineStructCompareEmitTests
{
    [Fact]
    public void GenericInlineStruct_EqualityCompare_EmitsVerifiableIl()
    {
        var source = """
            package MyLib
            import System

            inline struct Box[T](value T)

            func AreEqual(a Box[int32], b Box[int32]) bool -> a == b
            func AreNotEqual(a Box[int32], b Box[int32]) bool -> a != b
            """;

        // CompileAndVerify asserts gsc succeeds AND IlVerifier.Verify passes,
        // which is precisely what the bare-FieldDef bug violated.
        CompileAndVerify(source);
    }

    [Fact]
    public void NonGenericInlineStruct_EqualityCompare_StillVerifies()
    {
        // Control: the non-generic path must keep emitting the bare FieldDef
        // and remain verifiable after the reroute.
        var source = """
            package MyLib
            import System

            inline struct UserId(value int32)

            func AreEqual(a UserId, b UserId) bool -> a == b
            """;

        CompileAndVerify(source);
    }

    private static void CompileAndVerify(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_generic_inline_cmp_").FullName;
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
                "/target:library",
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
    }
}
