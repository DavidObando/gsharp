// <copyright file="Issue1019StaticInterfacePropertyInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0089 / issue #1019 — interpreter parity for static-virtual interface
/// *properties*. The evaluator must dispatch a <c>T.Prop</c> read (a
/// <c>BoundConstrainedStaticCallExpression</c> against the property's getter
/// accessor) to the implementer's static property getter at runtime, using
/// the witness-T value to resolve the concrete implementer.
/// </summary>
public class Issue1019StaticInterfacePropertyInterpreterTests
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

        Assert.Equal("apple\n", Evaluate(source));
    }

    private static string Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(source);
        var compilation = new Compilation(tree);

        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var variables = new Dictionary<VariableSymbol, object>();
            var result = compilation.Evaluate(variables);

            var errors = result.Diagnostics.Where(d => d.IsError).ToList();
            Assert.True(
                errors.Count == 0,
                "evaluation failed:\n" + string.Join("\n", errors.Select(d => d.ToString())));
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return outWriter.ToString().Replace("\r\n", "\n");
    }
}
