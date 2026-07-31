// <copyright file="Issue2928TupleFunctionParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2928: tuple-contained function values execute identically through
/// interpreter and compiled backends.
/// </summary>
public class Issue2928TupleFunctionParityTests
{
    private const string Source = """
        package TupleFunctionInterpreter
        import System

        let handler (int32) -> int32 = (value int32) -> value + 1
        let t = (handler, 0)
        Console.WriteLine(t.Item1(41))
        """;

    [Fact]
    public void TupleFunction_InterpreterAndCompiledOutputsMatch()
    {
        Assert.Equal(CompileAndRun(Source), Interpret(Source));
    }

    [Fact]
    public void TupleFunction_CompiledBackendExecutes()
    {
        Assert.Equal("42\n", CompileAndRun(Source));
    }

    [Fact]
    public void CompileAndRunHarness_PropagatesKnownBadProgram()
    {
        const string KnownBadSource = """
            package TupleFunctionKnownBad
            import System

            throw InvalidOperationException("known bad")
            """;

        var exception = Assert.Throws<TargetInvocationException>(() => CompileAndRun(KnownBadSource));
        Assert.IsType<InvalidOperationException>(exception.InnerException);
    }

    private static string Interpret(string source)
    {
        using var writer = new StringWriter();
        var previous = Console.Out;
        Console.SetOut(writer);
        try
        {
            var result = new Compilation(SyntaxTree.Parse(source))
                .Evaluate(new Dictionary<VariableSymbol, object>());
            Assert.Empty(result.Diagnostics);
        }
        finally
        {
            Console.SetOut(previous);
        }

        return writer.ToString().Replace("\r\n", "\n");
    }

    private static string CompileAndRun(string source)
    {
        using var peStream = new MemoryStream();
        var result = new Compilation(SyntaxTree.Parse(source)).Emit(peStream);
        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.ToString())));

        var assembly = Assembly.Load(peStream.ToArray());
        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);

        using var writer = new StringWriter();
        var previous = Console.Out;
        Console.SetOut(writer);
        try
        {
            entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
        }
        finally
        {
            Console.SetOut(previous);
        }

        return writer.ToString().Replace("\r\n", "\n");
    }
}
