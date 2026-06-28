// <copyright file="Issue1319OptionalDefaultCallSiteEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1319 — end-to-end emit + IL-verify + execute coverage proving that an
/// omitted trailing optional argument on a user-defined <em>instance</em> method
/// or constructor is materialized from the captured default value in the
/// generated IL (so the value is actually passed at runtime). Before the fix the
/// binder rejected such call sites with GS0144; the emit side never received a
/// synthesized default argument.
/// </summary>
public class Issue1319OptionalDefaultCallSiteEmitTests
{
    [Fact]
    public void InstanceMethod_OmittedOptional_PassesDefaultAtRuntime()
    {
        var source = """
            package Probe

            class C {
                func F(x int32 = 7) int32 { return x }
            }

            public var result = C().F()
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(7, GetField<int>(assembly, "result"));
    }

    [Fact]
    public void InstanceMethod_SuppliedOptional_OverridesDefaultAtRuntime()
    {
        var source = """
            package Probe

            class C {
                func F(x int32 = 7) int32 { return x }
            }

            public var result = C().F(5)
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(5, GetField<int>(assembly, "result"));
    }

    [Fact]
    public void InstanceMethod_MultipleTrailingOptionals_OmitTwo_PassesDefaults()
    {
        var source = """
            package Probe

            class C {
                func F(a int32, b int32 = 1, c int32 = 2) int32 { return a + b + c }
            }

            public var result = C().F(10)
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(13, GetField<int>(assembly, "result"));
    }

    [Fact]
    public void InstanceMethod_MultipleTrailingOptionals_OmitOne_PassesDefault()
    {
        var source = """
            package Probe

            class C {
                func F(a int32, b int32 = 1, c int32 = 2) int32 { return a + b + c }
            }

            public var result = C().F(10, 20)
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(32, GetField<int>(assembly, "result"));
    }

    [Fact]
    public void Constructor_OmittedOptional_PassesDefaultAtRuntime()
    {
        var source = """
            package Probe

            class C {
                var X int32
                init(x int32 = 100) { X = x }
            }

            public var result = C().X
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(100, GetField<int>(assembly, "result"));
    }

    [Fact]
    public void InstanceMethod_StringDefault_OmittedOptional_PassesDefaultAtRuntime()
    {
        var source = """
            package Probe

            class C {
                func Tag(s string = "hello") string { return s }
            }

            public var result = C().Tag()
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal("hello", GetField<string>(assembly, "result"));
    }

    private static Assembly CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1319_").FullName;
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

        IlVerifier.Verify(outPath);

        var bytes = File.ReadAllBytes(outPath);
        var assembly = Assembly.Load(bytes);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });

        return assembly;
    }

    private static T GetField<T>(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var resultField = program.GetField(name, BindingFlags.Public | BindingFlags.Static);
        return (T)resultField!.GetValue(null)!;
    }
}
