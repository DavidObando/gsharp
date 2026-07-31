// <copyright file="Issue2943LoopBackEdgeNarrowingInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Interpreter coverage for issue #2943 loop back-edge narrowing.
/// </summary>
public class Issue2943LoopBackEdgeNarrowingInterpreterTests
{
    [Fact]
    public void AssignmentAfterUse_ReportsNullableReceiver()
    {
        const string Source = """
            class C {
                func M() { }
            }

            func run() {
                var c C? = C()
                if c != nil {
                    for var i = 0; i < 2; i++ {
                        c.M()
                        c = nil
                    }
                }
            }

            run()
            """;

        var result = new Compilation(SyntaxTree.Parse(Source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0159");
    }

    [Fact]
    public void LoopConditionReestablishesNarrowing()
    {
        const string Source = """
            class C {
                func M() { }
            }

            func run() int32 {
                var c C? = C()
                var count = 0
                while c != nil {
                    c.M()
                    count++
                    c = nil
                }
                return count
            }

            run()
            """;

        var result = new Compilation(SyntaxTree.Parse(Source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }
}
