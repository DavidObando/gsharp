// <copyright file="GlobalVariableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #191 emit tests. Compiles GSharp sources declaring top-level
/// <c>var</c> / <c>let</c> / <c>const</c> and asserts that the resulting PE
/// contains a CLR <c>FieldDef</c> on the entry-point package's
/// <c>&lt;Program&gt;</c> TypeDef carrying the correct accessibility, that
/// load/store sites round-trip through <c>ldsfld</c>/<c>stsfld</c>, and that
/// annotations on globals survive as <c>CustomAttribute</c> rows.
///
/// NOTE: this PR intentionally leaves <c>let</c>/<c>const</c> globals as
/// regular static fields (not <c>initonly</c>). Marking them initonly requires
/// hoisting initialization into a <c>.cctor</c> which would change observable
/// ordering for programs whose top-level <c>let</c> initializers depend on
/// prior side effects (e.g. <c>let v = &lt;-ch</c> after <c>ch &lt;- 1</c>).
/// That is tracked as a #191 follow-up.
/// </summary>
public class GlobalVariableEmitTests
{
    [Fact]
    public void TopLevel_Var_Emits_As_Public_Static_Field_On_Program()
    {
        var source = """
            package P
            import System

            public var counter = 0
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var field = program.GetField("counter", BindingFlags.Public | BindingFlags.Static);

        Assert.NotNull(field);
        Assert.Equal(typeof(int), field.FieldType);
        Assert.True(field.IsStatic);
        Assert.True(field.IsPublic);
        Assert.False(field.IsInitOnly, "let/const are intentionally not initonly for this PR.");
    }

    [Fact]
    public void TopLevel_Internal_Var_Maps_To_Assembly_Visibility()
    {
        var source = """
            package P
            import System

            internal var counter = 0
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var field = program.GetField("counter", BindingFlags.NonPublic | BindingFlags.Static);

        Assert.NotNull(field);
        Assert.True(field.IsAssembly, "internal must map to FieldAttributes.Assembly.");
    }

    [Fact]
    public void TopLevel_Private_Var_Maps_To_Private_Visibility()
    {
        var source = """
            package P
            import System

            private var counter = 0
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var field = program.GetField("counter", BindingFlags.NonPublic | BindingFlags.Static);

        Assert.NotNull(field);
        Assert.True(field.IsPrivate, "private must map to FieldAttributes.Private.");
    }

    [Fact]
    public void TopLevel_Let_And_Const_Emit_As_Static_Fields()
    {
        var source = """
            package P
            import System

            public let greeting = "hi"
            public const answer = 42
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        var greeting = program.GetField("greeting", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(greeting);
        Assert.Equal(typeof(string), greeting.FieldType);

        var answer = program.GetField("answer", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(answer);
        Assert.Equal(typeof(int), answer.FieldType);
    }

    [Fact]
    public void Obsolete_On_Global_Var_Round_Trips_As_CustomAttribute()
    {
        var source = """
            package P
            import System

            @Obsolete("use newCounter")
            public var counter = 0
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var field = program.GetField("counter", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(field);

        var data = field.GetCustomAttributesData()
            .Single(d => d.AttributeType.FullName == "System.ObsoleteAttribute");
        var arg = Assert.Single(data.ConstructorArguments);
        Assert.Equal("use newCounter", arg.Value);
    }

    [Fact]
    public void TopLevel_Var_Mutated_By_Function_Reads_Through_Ldsfld_Stsfld()
    {
        // Smoke test: a top-level var written by a non-entry function then
        // read by another function must round-trip through static-field
        // load/store. If the global were still a local, bump() would write
        // into a temporary slot and the read would return 0.
        var source = """
            package P
            import System

            public var counter = 0

            public func bump() {
                counter = counter + 1
            }

            public func current() int {
                return counter
            }
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var counter = program.GetField("counter", BindingFlags.Public | BindingFlags.Static);
        var bump = program.GetMethod("bump", BindingFlags.Public | BindingFlags.Static);
        var current = program.GetMethod("current", BindingFlags.Public | BindingFlags.Static);

        Assert.NotNull(counter);
        Assert.NotNull(bump);
        Assert.NotNull(current);

        bump!.Invoke(null, null);
        bump!.Invoke(null, null);

        Assert.Equal(2, (int)current!.Invoke(null, null)!);
        Assert.Equal(2, (int)counter!.GetValue(null)!);
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_global_emit_").FullName;
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

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
