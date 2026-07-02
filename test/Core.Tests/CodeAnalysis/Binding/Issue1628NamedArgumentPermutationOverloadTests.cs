// <copyright file="Issue1628NamedArgumentPermutationOverloadTests.cs" company="GSharp">
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
/// Issue #1628: Phase-2 exact-match scoring in
/// <c>OverloadResolver.SelectBestUserOverloadCore</c> used to map
/// <c>boundArguments[i]</c> (source order) onto <c>cand.Parameters[i]</c>
/// (declaration order) even when the call used named arguments, so an
/// argument named for parameter <c>c</c> could be scored against a
/// different candidate's parameter that merely sits at the SAME source
/// index. Between two overloads whose parameters are a permutation of each
/// other, this let the wrong overload win by accidental positional type
/// coincidence, with no diagnostic. The fix maps each argument to its real
/// name-resolved parameter slot before scoring.
/// </summary>
public class Issue1628NamedArgumentPermutationOverloadTests
{
    [Fact]
    public void NamedArgs_PermutationOverloads_SelectsNameCorrectCandidate()
    {
        // F_Right(a int32, b string, c bool) is the only candidate that is an
        // EXACT type match for every argument once named args are resolved to
        // their real parameter (b -> string, c -> bool).
        //
        // F_Wrong(a int32, b bool, c string) only looks better under the OLD
        // buggy positional scoring: boundArguments[1] (c: true, a bool value)
        // happens to sit at F_Wrong's declaration slot 1 (also bool), and
        // boundArguments[2] (b: "s", a string value) happens to sit at slot 2
        // (also string) -- an accidental positional coincidence that used to
        // out-score the real match.
        const string source = @"
package p
func F(a int32, b string, c bool) int32 { return 100 }
func F(a int32, b bool, c string) int32 { return 200 }

let x = F(1, c: true, b: ""s"")
x
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(100, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
