// <copyright file="Adr0174SelectArmOperandParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// A select arm's operand sits immediately before the arm's body brace, so a
/// call- or indexer-tailed operand used to read that brace as its own object
/// initializer and swallow the body — issue #1023's defect (fixed there for a
/// C-style <c>for</c>'s increment) in another position, found while rebuilding
/// <c>select</c> for ADR-0174 D8.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that parses the operand with the
/// ordinary expression parser (no trailing-initializer suppression) reports
/// <c>GS0005</c> here — the brace is consumed as an initializer and the arm's
/// statements are read as member assignments.
/// </remarks>
public class Adr0174SelectArmOperandParserTests
{
    [Theory]
    [InlineData("case ch <- Pair(41) {\n        used = 1\n    }")]
    [InlineData("case ch <- values[0] {\n        used = 1\n    }")]
    [InlineData("case let got = <-boxes[0] {\n        used = got\n    }")]
    [InlineData("case <-boxes[0] {\n        used = 1\n    }")]
    public void AnArmOperandDoesNotSwallowTheArmBody(string arm)
    {
        var source = $$"""
            package P
            data struct Pair(Value int32)

            func run(values []Pair, boxes []chan[int32], ch chan[Pair]) int32 {
                var used = 0
                select {
                {{arm}}
                }

                return used
            }
            """;

        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics.Where(diagnostic => diagnostic.IsError));
    }
}
