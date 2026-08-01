// <copyright file="Issue3030LocalFunctionDeclarationInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3030: generic local-function declarations are evaluator no-ops.
/// </summary>
public class Issue3030LocalFunctionDeclarationInterpreterTests
{
    public static IEnumerable<object[]> Cases()
    {
        yield return Case(
            """
            let Identity[T] = func(value T) T {
                return value
            }

            Console.WriteLine(Identity(17))
            Console.WriteLine(Identity("top-level"))
            """,
            "17\ntop-level\n");

        yield return Case(
            """
            func PrintValues() {
                let First[T] = func(first T, second T) T {
                    return first
                }

                Console.WriteLine(First(42, 99))
                Console.WriteLine(First("nested", "other"))
            }

            PrintValues()
            """,
            "42\nnested\n");
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void GenericLocalFunctionDeclaration_EvaluatesCalls(string source, string expectedOutput)
    {
        using var writer = new StringWriter();
        var previousOut = Console.Out;
        Console.SetOut(writer);
        try
        {
            var result = new Compilation(SyntaxTree.Parse(source))
                .Evaluate(new Dictionary<VariableSymbol, object>());

            Assert.Empty(result.Diagnostics);
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        Assert.Equal(expectedOutput, writer.ToString().Replace("\r\n", "\n", StringComparison.Ordinal));
    }

    private static object[] Case(string source, string expectedOutput)
        => new object[] { source, expectedOutput };
}
