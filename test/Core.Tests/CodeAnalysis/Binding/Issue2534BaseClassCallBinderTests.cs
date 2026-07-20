// <copyright file="Issue2534BaseClassCallBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Issue #2534: binding and evaluation coverage for canonical base calls.</summary>
public class Issue2534BaseClassCallBinderTests
{
    [Fact]
    public void DerivedOverride_BaseCallResultChain_BindsAndRuns()
    {
        const string source = """
            open class Formatter {
                open func Format(value int32) string { return "number" }
            }

            class LoudFormatter() : Formatter {
                override func Format(value int32) string {
                    return base.Format(value).ToUpperInvariant()
                }
            }

            LoudFormatter().Format(1)
            """;

        var result = Evaluate(source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("NUMBER", result.Value);
    }

    [Fact]
    public void DerivedOverride_BaseCall_SelectsMatchingOverload()
    {
        const string source = """
            open class Formatter {
                open func Format(value int32) string { return "number" }
                open func Format(value string) string { return "text" }
            }

            class DerivedFormatter() : Formatter {
                override func Format(value int32) string {
                    return base.Format(value)
                }
            }

            DerivedFormatter().Format(1)
            """;

        var result = Evaluate(source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("number", result.Value);
    }

    [Fact]
    public void ValueNamedBase_MemberCall_RemainsOrdinaryCall()
    {
        const string source = """
            class Helper {
                func Value() int32 { return 42 }
            }

            var base = Helper()
            base.Value()
            """;

        var result = Evaluate(source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
