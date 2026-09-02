// <copyright file="Issue2831NegativeAttributeArgumentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2831: a negative numeric literal parses as a
/// <c>UnaryExpressionSyntax</c>, which <c>DeclarationBinder.TryBindAttributeArgument</c>
/// did not recognise, so every negative attribute argument — scalar or array
/// element — was rejected with GS0202 ("attribute argument must be a
/// compile-time constant"). These tests drive <c>gsc</c> against the host's real
/// <c>xunit.core.dll</c> (the exact shape that blocked
/// <c>corpus/L3-Library</c>) and assert both that the source binds and that the
/// emitted <c>CustomAttribute</c> blob round-trips the negative values.
/// </summary>
public class Issue2831NegativeAttributeArgumentEmitTests
{
    [Fact]
    public void NegativeLiterals_InScalarAndArrayArguments_RoundTrip()
    {
        // The exact repro shape from corpus/L3-Library's AdvancedTests.
        var source = """
            package P
            import System
            import Xunit

            public class Facts {
                @Theory
                @InlineData([]int32{-2, -7, -1}, -1)
                public func Smallest(values []int32, expected int32) {
                }
            }
            """;

        var arguments = SingleInlineDataArguments(source, "Smallest");

        Assert.Equal(new[] { -2, -7, -1 }, ArrayArgument(arguments[0]));
        Assert.Equal(-1, arguments[1].Value);
    }

    [Fact]
    public void MixedSignLiterals_RoundTrip()
    {
        var source = """
            package P
            import System
            import Xunit

            public class Facts {
                @Theory
                @InlineData([]int32{3, -4, 0}, 7)
                public func Mixed(values []int32, expected int32) {
                }
            }
            """;

        var arguments = SingleInlineDataArguments(source, "Mixed");

        Assert.Equal(new[] { 3, -4, 0 }, ArrayArgument(arguments[0]));
        Assert.Equal(7, arguments[1].Value);
    }

    [Fact]
    public void NegativeFloatingPointLiteral_RoundTrips()
    {
        var source = """
            package P
            import System
            import Xunit

            public class Facts {
                @Theory
                @InlineData(-2.5, -1.25)
                public func Scaled(value float64, expected float64) {
                }
            }
            """;

        var arguments = SingleInlineDataArguments(source, "Scaled");

        Assert.Equal(-2.5d, arguments[0].Value);
        Assert.Equal(-1.25d, arguments[1].Value);
    }

    private static int[] ArrayArgument(CustomAttributeTypedArgument argument)
    {
        var elements = Assert.IsAssignableFrom<ReadOnlyCollection<CustomAttributeTypedArgument>>(argument.Value);
        return elements.Select(e => (int)e.Value).ToArray();
    }

    private static IList<CustomAttributeTypedArgument> SingleInlineDataArguments(string source, string methodName)
    {
        var assembly = CompileToAssembly(source);
        var facts = assembly.GetTypes().Single(t => t.Name == "Facts");
        var method = facts.GetMethod(methodName, BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(method);

        var data = method.GetCustomAttributesData()
            .Single(d => d.AttributeType.Name == "InlineDataAttribute");

        // xUnit's InlineDataAttribute takes a single `params object[]`, so the
        // whole argument list arrives as one array-typed constructor argument.
        return Assert.IsAssignableFrom<ReadOnlyCollection<CustomAttributeTypedArgument>>(
            Assert.Single(data.ConstructorArguments).Value);
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_negattr_emit_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var testDir = Path.GetDirectoryName(typeof(Issue2831NegativeAttributeArgumentEmitTests).Assembly.Location);
        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:library",
            "/targetframework:net10.0",
        };

        foreach (var name in new[] { "xunit.core.dll", "xunit.abstractions.dll" })
        {
            var path = Path.Combine(testDir, name);
            Assert.True(File.Exists(path), $"prerequisite missing: '{path}'");
            args.Add("/reference:" + path);
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        return EmittedFixture.Load(outPath);
    }
}
