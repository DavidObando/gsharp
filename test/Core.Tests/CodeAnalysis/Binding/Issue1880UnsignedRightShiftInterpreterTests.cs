// <copyright file="Issue1880UnsignedRightShiftInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1880 follow-up: <c>Evaluator.NumericShrUnsigned</c> zero-extended
/// <c>sbyte</c>/<c>short</c> operands to 8/16 bits before shifting, while the
/// emitted IL always sign-extends the operand onto the 32-bit eval stack
/// before <c>shr.un</c> (per ECMA-335). For a negative <c>sbyte</c>/<c>short</c>
/// this meant the interpreter (and REPL) silently disagreed with the compiled
/// assembly. Asserts the interpreter now matches the compiled behaviour
/// exercised by <c>Issue1880UnsignedRightShiftEmitTests</c>.
/// </summary>
public class Issue1880UnsignedRightShiftInterpreterTests
{
    [Fact]
    public void SByte_NegativeOne_UnsignedShiftRight_MatchesCompiledIl()
    {
        var result = Evaluate("var v sbyte = -1\nv >>> 1");
        Assert.Empty(result.Diagnostics);
        Assert.Equal((sbyte)-1, result.Value);
    }

    [Fact]
    public void Short_NegativeOne_UnsignedShiftRight_MatchesCompiledIl()
    {
        var result = Evaluate("var v short = -1\nv >>> 1");
        Assert.Empty(result.Diagnostics);
        Assert.Equal((short)-1, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
