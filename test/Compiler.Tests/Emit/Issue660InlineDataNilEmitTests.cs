// <copyright file="Issue660InlineDataNilEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #660: verifies that <c>nil</c> in <c>@InlineData</c> compiles
/// correctly when the corresponding method parameter is a nullable
/// reference type, and that the attribute blob contains the expected
/// null reference.
/// </summary>
public class Issue660InlineDataNilEmitTests
{
    [Fact]
    public void NilInInlineData_WithNullableParam_Compiles_And_EmitsNull()
    {
        // Case 1: @InlineData(nil, ...) with string? parameter → success
        var source = """
            package Probe.Tests
            import Xunit

            class Tests {
                @Theory
                @InlineData(nil, "abc", false)
                @InlineData("abc", "abc", true)
                func Equal_Compare(a string?, b string, expected bool) {
                    Assert.Equal(expected, a == b)
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var testsType = assembly.GetTypes().Single(t => t.Name == "Tests");
        var method = testsType.GetMethod("Equal_Compare", BindingFlags.Public | BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(method);

        // Verify InlineData attributes are emitted
        var inlineDataAttrs = method.GetCustomAttributesData()
            .Where(d => d.AttributeType.Name == "InlineDataAttribute")
            .ToList();
        Assert.Equal(2, inlineDataAttrs.Count);

        // The first InlineData should have null as first element in the object[] blob
        var firstArgs = inlineDataAttrs[0].ConstructorArguments;
        Assert.Single(firstArgs);
        var firstArray = firstArgs[0].Value as System.Collections.ObjectModel.ReadOnlyCollection<CustomAttributeTypedArgument>;
        Assert.NotNull(firstArray);
        Assert.Equal(3, firstArray.Count);
        Assert.Null(firstArray[0].Value); // nil → null in the blob
        Assert.Equal("abc", firstArray[1].Value);
    }

    [Fact]
    public void NilInInlineData_WithNonNullableParam_Reports_GS0274()
    {
        // Case 2: @InlineData(nil, ...) with non-nullable string → GS0274
        var source = """
            package Probe.Tests
            import Xunit

            class Tests {
                @Theory
                @InlineData(nil, "abc", false)
                func Equal_Compare(a string, b string, expected bool) {
                    Assert.Equal(expected, a == b)
                }
            }
            """;

        var (exitCode, stdout, stderr) = CompileRaw(source);
        var output = stdout + stderr;
        Assert.Contains("GS0274", output);
        Assert.Contains("nil", output);
        Assert.Contains("string?", output);
    }

    [Fact]
    public void NullIdentifier_InInlineData_Reports_GS0273()
    {
        // Case 3: @InlineData(null, ...) → GS0273 suggesting nil
        var source = """
            package Probe.Tests
            import Xunit

            class Tests {
                @Theory
                @InlineData(null, "abc", false)
                func Equal_Compare(a string?, b string, expected bool) {
                    Assert.Equal(expected, a == b)
                }
            }
            """;

        var (exitCode, stdout, stderr) = CompileRaw(source);
        var output = stdout + stderr;
        Assert.Contains("GS0273", output);
        Assert.Contains("nil", output);
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue660_").FullName;
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

    private static (int ExitCode, string Stdout, string Stderr) CompileRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue660_diag_").FullName;
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

        return (compileExit, compileOut.ToString(), compileErr.ToString());
    }
}
