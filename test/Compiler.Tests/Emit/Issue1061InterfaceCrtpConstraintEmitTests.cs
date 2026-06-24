// <copyright file="Issue1061InterfaceCrtpConstraintEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1061: end-to-end CLR emit + ilverify coverage for a self-referential /
/// CRTP constraint on an INTERFACE declaration (the interface's own type
/// parameter constrained by the interface being declared). A missing or garbled
/// GenericParamConstraint metadata row pointing at the interface would fail
/// ilverify, so a clean verification confirms the constraint binds and emits
/// correctly — the same way the class CRTP shape does (issue #1056).
/// </summary>
public class Issue1061InterfaceCrtpConstraintEmitTests
{
    [Fact]
    public void Library_SelfReferentialInterfaceConstraint_BareName_PassesIlVerify()
    {
        var source = """
            package p
            interface IData[T IData] {
                func Write(d int32);
            }
            """;

        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    [Fact]
    public void Library_SelfReferentialInterfaceConstraint_Crtp_PassesIlVerify()
    {
        var source = """
            package p
            interface IData[TData IData[TData]] {
                func Write(d int32);
            }
            """;

        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    [Fact]
    public void Library_CrtpInterfaceWithConcreteImplementer_PassesIlVerify()
    {
        // The CRTP interface together with a concrete implementer that supplies
        // itself as the type argument (`class C : IData[C]`). The implementer
        // must satisfy the self-referential constraint, and the produced
        // assembly (interface TypeDef + GenericParamConstraint + implementing
        // class) must verify.
        var source = """
            package p
            interface IData[T IData[T]] {
                func Write(d int32);
            }
            class C : IData[C] {
                func Write(d int32) { }
            }
            """;

        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1061_lib_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
        {
            "/out:" + outPath,
            "/target:library",
            "/targetframework:net10.0",
            srcPath,
        };

        RunCompiler(args);
        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static void RunCompiler(string[] args)
    {
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
    }

    private static void TryCleanup(string dllPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(dllPath);
            if (dir != null && Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
        }
    }
}
