// <copyright file="LetFieldEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0067 / issue #694: emit tests for `let` fields on user-declared types.
/// A `let` field maps to a CLR <c>initonly</c> field, mirroring how
/// <c>readonly</c> fields behave in C#.
/// </summary>
public class LetFieldEmitTests
{
    [Fact]
    public void LetField_OnClass_EmitsAsInitOnly()
    {
        var source = """
            package P
            import System

            class Holder {
                public let Name string = "x"
                init() {}
            }
            """;

        var assembly = CompileToAssembly(source, target: "library");
        var holder = assembly.GetTypes().Single(t => t.Name == "Holder");
        var field = holder.GetField("Name", BindingFlags.Public | BindingFlags.Instance);

        Assert.NotNull(field);
        Assert.Equal(typeof(string), field.FieldType);
        Assert.True(field.IsInitOnly, "`let` field should emit as CLR initonly.");
    }

    [Fact]
    public void VarField_OnClass_IsNotInitOnly()
    {
        var source = """
            package P
            import System

            class Holder {
                public var Name string = "x"
                init() {}
            }
            """;

        var assembly = CompileToAssembly(source, target: "library");
        var holder = assembly.GetTypes().Single(t => t.Name == "Holder");
        var field = holder.GetField("Name", BindingFlags.Public | BindingFlags.Instance);

        Assert.NotNull(field);
        Assert.False(field.IsInitOnly, "`var` field should NOT be initonly.");
    }

    private static Assembly CompileToAssembly(string source, string target)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_let_field_emit_").FullName;
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
