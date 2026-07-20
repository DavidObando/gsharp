// <copyright file="Issue2544LiftedUnaryOperatorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

public class Issue2544LiftedUnaryOperatorTests
{
    [Fact]
    public void Interpreter_LiftedUnaryOperatorsMatchNullableSemantics()
    {
        Assert.Equal(true, Evaluate("var value bool? = nil\n(!value) ?? true"));
        Assert.Equal(false, Evaluate("var value bool? = true\n(!value) ?? true"));
        Assert.Equal(-5, Evaluate("var value int32? = 5\n(-value) ?? 0"));
    }

    [Fact]
    public void LiftedUnaryOperators_PropagateNilAndOperateOnPresentValues()
    {
        const string Source = """
            package Issue2544
            import System

            var yes bool? = true
            var noBool bool? = nil
            Console.WriteLine((!yes) ?? true)
            Console.WriteLine((!noBool) ?? false)

            var five int32? = 5
            var noInt int32? = nil
            Console.WriteLine((-five) ?? 42)
            Console.WriteLine((-noInt) ?? 42)
            Console.WriteLine((^five) ?? 0)
            Console.WriteLine((+five) ?? 0)
            """;

        Assert.Equal("False\nFalse\n-5\n42\n-6\n5\n", CompileAndRun(Source));
    }

    [Theory]
    [InlineData("+", "bool?")]
    [InlineData("!", "int32?")]
    [InlineData("-", "uint32?")]
    public void InvalidUnderlyingUnaryOperation_StillReportsGS0128(string op, string type)
    {
        var source = $"package Invalid\nvar value {type} = nil\nvar bad = {op}value\n";
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        using var peStream = new MemoryStream();

        var result = compilation.Emit(peStream);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0128");
    }

    private static string CompileAndRun(string source)
    {
        using var peStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext("Issue2544", isCollectible: true);
        try
        {
            var assembly = loadContext.LoadFromStream(peStream);
            var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
            var entry = program.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var previous = Console.Out;
            using var output = new StringWriter();
            Console.SetOut(output);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(previous);
            }

            return output.ToString().Replace("\r\n", "\n");
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static object Evaluate(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Empty(result.Diagnostics);
        return result.Value;
    }
}
