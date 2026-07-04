// <copyright file="Issue1951ListPatternMetadataArrayTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1951: <c>BindListPattern</c> required the discriminant's type to be
/// the in-compilation <c>ArrayTypeSymbol</c>/<c>SliceTypeSymbol</c>, so a list
/// pattern against a value whose static type arrives as a metadata/imported
/// CLR array (e.g. <c>Array.Empty[int32]()</c>, or <c>string.Split</c>'s
/// <c>string[]</c>) was wrongly rejected even though it is genuinely
/// array-shaped. Fixed by reusing
/// <c>ExpressionBinder.GetArraySliceElementType</c> (the same array/CLR-array
/// recognition used for array/span slicing) in <c>PatternBinder.BindListPattern</c>.
/// </summary>
public class Issue1951ListPatternMetadataArrayTests
{
    [Fact]
    public void EmptyMetadataArray_MatchesEmptyListPattern()
    {
        AssertEvaluates(@"
package P
import System

let a = Array.Empty[int32]()
let x = switch a { case []: 1 default: 0 }
x
", 1);
    }

    [Fact]
    public void NonEmptyMetadataArray_FromSplit_BindsElementAndSlice()
    {
        AssertEvaluates(@"
package P
import System

let parts = ""a,b,c"".Split("","")
let x = switch parts { case [f is string, ..rest]: f + ""|"" + rest.Length.ToString() default: ""no"" }
x
", "a|2");
    }

    [Fact]
    public void MetadataArray_NotMatchingLength_FallsThroughToDefault()
    {
        AssertEvaluates(@"
package P
import System

let parts = ""a,b"".Split("","")
let x = switch parts { case [_, _, _]: ""three"" default: ""other"" }
x
", "other");
    }

    private static void AssertEvaluates(string source, object expected)
    {
        var tree = SyntaxTree.Parse(source);
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Empty(result.Diagnostics);
        Assert.Equal(expected, result.Value);
    }
}
