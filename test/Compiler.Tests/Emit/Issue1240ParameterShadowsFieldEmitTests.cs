// <copyright file="Issue1240ParameterShadowsFieldEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1240 — emit + IL-verify coverage proving that a method/constructor
/// parameter named like an instance field (or property) shadows that member for
/// unqualified (bare) reads, matching C# semantics. The member remains reachable
/// via <c>this.</c>. These tests execute the emitted IL and assert that the
/// PARAMETER value is the one observed, not the field/property value.
/// </summary>
public class Issue1240ParameterShadowsFieldEmitTests
{
    [Fact]
    public void Method_BareParam_ShadowsField_ReturnsParameter()
    {
        var source = """
            package Probe

            class C {
                var iv int32
                init() {
                    iv = 100
                }
                func M(iv int32) int32 {
                    return iv
                }
            }

            public var result = C().M(7)
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(7, GetField<int>(assembly, "result"));
    }

    [Fact]
    public void Method_ThisField_AndBareParam_AreDistinct()
    {
        // `this.iv` (field = 100) + bare `iv` (parameter = 7) = 107.
        var source = """
            package Probe

            class C {
                var iv int32
                init() {
                    iv = 100
                }
                func M(iv int32) int32 {
                    return this.iv + iv
                }
            }

            public var result = C().M(7)
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(107, GetField<int>(assembly, "result"));
    }

    [Fact]
    public void Constructor_BareParam_ShadowsField_AssignsFromParameter()
    {
        // `this.iv = iv` stores the parameter into the field; Get() reads it back.
        var source = """
            package Probe

            class C {
                var iv int32
                init(iv int32) {
                    this.iv = iv
                }
                func Get() int32 {
                    return this.iv
                }
            }

            public var result = C(5).Get()
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(5, GetField<int>(assembly, "result"));
    }

    private static Assembly CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1240_").FullName;
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
