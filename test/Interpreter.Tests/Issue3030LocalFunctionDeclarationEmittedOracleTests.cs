// <copyright file="Issue3030LocalFunctionDeclarationEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3030: Emitted-oracle coverage for local function declaration.
/// Traceability: issue #3050.
/// </summary>
public class Issue3030LocalFunctionDeclarationEmittedOracleTests
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

        yield return Case(
            """
            data struct Item {
                var Value int32
            }

            let MakeIdentity[T] = func() (T) -> T {
                return (value T) -> value
            }

            let identity = MakeIdentity[Item]()
            Console.WriteLine(identity(Item{ Value: 11 }).Value)
            Console.WriteLine(identity(Item{ Value: 22 }).Value)
            Console.WriteLine(identity(Item{ Value: 33 }).Value)
            """,
            "11\n22\n33\n");
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void GenericLocalFunctionDeclaration_EvaluatesCalls(string source, string expectedOutput)
    {
        var result = EmittedOracle.Evaluate(source);

        Assert.Empty(result.Diagnostics);

        Assert.Equal(expectedOutput, result.Output.ReplaceLineEndings(Environment.NewLine));
    }

    private static object[] Case(string source, string expectedOutput)
        => new object[] { source, expectedOutput };
}
