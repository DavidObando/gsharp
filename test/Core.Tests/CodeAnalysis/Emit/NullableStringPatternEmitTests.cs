// <copyright file="NullableStringPatternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Verifies that string constant patterns use value equality when the
/// discriminant's static type is nullable.
/// </summary>
public class NullableStringPatternEmitTests
{
    [Fact]
    public void SwitchStatement_NullableStringConstant_UsesValueEquality()
    {
        const string Source = """
            package NullableStringSwitchStatement
            import System
            let value string? = string.Concat("System.", "Boolean")
            var result = "miss"
            switch value {
                case "System.Boolean" { result = "hit" }
                default { }
            }
            Console.WriteLine(result)
            """;

        Assert.Contains(
            "hit",
            CompileLoadInvokeCaptureStdout(Source, nameof(SwitchStatement_NullableStringConstant_UsesValueEquality)));
    }

    [Fact]
    public void SwitchExpression_NullableStringConstant_UsesValueEquality()
    {
        const string Source = """
            package NullableStringSwitchExpression
            import System
            let value string? = string.Concat("System.", "Boolean")
            let result = switch value {
                case "System.Boolean": "hit"
                default: "miss"
            }
            Console.WriteLine(result)
            """;

        Assert.Contains(
            "hit",
            CompileLoadInvokeCaptureStdout(Source, nameof(SwitchExpression_NullableStringConstant_UsesValueEquality)));
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var assembly = loadContext.LoadFromStream(peStream);
            var programType = assembly.GetTypes().FirstOrDefault(type => type.Name == "<Program>");
            Assert.NotNull(programType);
            var entryPoint = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entryPoint);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entryPoint!.Invoke(
                    null,
                    entryPoint.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
