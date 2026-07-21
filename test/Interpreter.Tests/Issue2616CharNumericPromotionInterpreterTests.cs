// <copyright file="Issue2616CharNumericPromotionInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>Issue #2616 interpreter parity for promoted char values.</summary>
public class Issue2616CharNumericPromotionInterpreterTests
{
    [Fact]
    public void UnaryBinaryAndCompoundCharArithmetic_EvaluatesPromotedValues()
    {
        const string Source = """
            var a char = '5'
            var b char = '1'
            var difference = a - b
            var unary = -a + ^b + +a
            var value char = 'A'
            value += 2
            var lifted char? = 'C'
            lifted -= 'A'
            """;

        var variables = new Dictionary<VariableSymbol, object>();
        var result = new Compilation(SyntaxTree.Parse(SourceText.From(Source))).Evaluate(variables);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, Value("difference"));
        Assert.Equal(-(int)'5' + ~(int)'1' + (int)'5', Value("unary"));
        Assert.Equal('C', Value("value"));
        Assert.Equal((char)2, Value("lifted"));

        object Value(string name) => variables.Single(pair => pair.Key.Name == name).Value;
    }

    [Fact]
    public void CheckedLiftedCharCompound_ThrowsOnNarrowingOverflow()
    {
        const string Source = """
            var value char? = 'A'
            var narrowingCaught = "no"
            var operatorCaught = "no"
            var decimalCaught = "no"
            checked {
                try {
                    value += 65536
                } catch (e OverflowException) {
                    narrowingCaught = "yes"
                }
                try {
                    value += uint32(4294967295)
                } catch (e OverflowException) {
                    operatorCaught = "yes"
                }
                try {
                    value += decimal(65536)
                } catch (e OverflowException) {
                    decimalCaught = "yes"
                }
            }
            """;

        var variables = new Dictionary<VariableSymbol, object>();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(Source)));
        var result = compilation.Evaluate(variables);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("yes", Value("narrowingCaught"));
        Assert.Equal("yes", Value("operatorCaught"));
        Assert.Equal("yes", Value("decimalCaught"));

        object Value(string name) => variables.Single(pair => pair.Key.Name == name).Value;
    }
}
