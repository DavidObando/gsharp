// <copyright file="Issue1019StaticInterfacePropertyEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #1019: Emitted-oracle coverage for static interface property.
/// Traceability: ADR-0089.
/// </summary>
public class Issue1019StaticInterfacePropertyEmittedOracleTests
{
    [Fact]
    public void Generic_Read_Through_Constraint_Calls_Implementer_Static_Property()
    {
        var source = """
            import System

            sealed interface IData {
                shared {
                    prop Name string { get; }
                }
            }

            struct AppleData : IData {
                shared {
                    prop Name string { get { return "apple" } }
                }
            }

            func Describe[T IData](witness T) string {
                return T.Name
            }

            Console.WriteLine(Describe(AppleData{}))
            """;

        Assert.Equal($"apple{Environment.NewLine}", Evaluate(source));
    }

    private static string Evaluate(string source)
    {
        var result = EmittedOracle.Evaluate(source);

        var errors = result.Diagnostics.Where(d => d.IsError).ToList();
        Assert.True(
            errors.Count == 0,
            "evaluation failed:\n" + string.Join("\n", errors.Select(d => d.ToString())));
        return result.Output.ReplaceLineEndings(Environment.NewLine);
    }
}
