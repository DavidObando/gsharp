// <copyright file="Issue2818StructTemporaryFieldAssignmentTests.cs" company="GSharp">
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
/// Issue #2818: field writes through non-addressable struct values must fail
/// in binding instead of mutating a discarded emitter spill temporary.
/// </summary>
public class Issue2818StructTemporaryFieldAssignmentTests
{
    [Fact]
    public void FunctionResultFieldAssignment_ReportsGS0499()
    {
        var result = Evaluate("""
            package P

            struct Item {
                var Id int32
            }

            func MakeItem() Item {
                return Item{Id: 1}
            }

            MakeItem().Id = 7
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0499");
    }

    [Fact]
    public void NarrowedOptionalStructFieldAssignment_ReportsGS0499()
    {
        var result = Evaluate("""
            package P

            struct Item {
                var Id int32
            }

            var item Item? = Item{Id: 1}
            if item != nil {
                item.Id = 7
            }
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0499");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
