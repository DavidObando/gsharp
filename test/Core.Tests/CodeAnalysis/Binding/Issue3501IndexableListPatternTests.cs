// <copyright file="Issue3501IndexableListPatternTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3501: list patterns accept indexable non-array discriminants — any
/// imported type with an int32 <c>Length</c>/<c>Count</c> getter and a
/// <c>this[int]</c> indexer, e.g. <c>ImmutableArray[T]</c>. The rest
/// subpattern must be a pure <c>..</c> discard (no middle-slice
/// materialization exists for an arbitrary indexable).
/// </summary>
public class Issue3501IndexableListPatternTests
{
    [Fact]
    public void ImmutableArray_PrefixBindingAndRestDiscard_Matches()
    {
        var source = @"
import System.Collections.Immutable

func First(items ImmutableArray[string]) string {
    if items is [var first, ..] {
        return first
    }
    return ""empty""
}

First(ImmutableArray.Create[string](""hello"", ""world"")) + ""|"" + First(ImmutableArray[string].Empty)
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("hello|empty", result.Value);
    }

    [Fact]
    public void ImmutableArray_StrictSingleElement_ChecksLength()
    {
        var source = @"
import System.Collections.Immutable

func Only(items ImmutableArray[int32]) int32 {
    if items is [var x] {
        return x
    }
    return -1
}

Only(ImmutableArray.Create[int32](7)) * 10 + Only(ImmutableArray.Create[int32](1, 2))
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(69, result.Value);
    }

    [Fact]
    public void ImmutableArray_SuffixElement_IndexesFromTheEnd()
    {
        var source = @"
import System.Collections.Immutable

func Last(items ImmutableArray[int32]) int32 {
    if items is [.., var last] {
        return last
    }
    return -1
}

Last(ImmutableArray.Create[int32](1, 2, 3))
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ImmutableArray_RestCapture_IsRejected()
    {
        var source = @"
import System.Collections.Immutable

func F(items ImmutableArray[int32]) int32 {
    if items is [var x, ..rest] {
        return x
    }
    return -1
}

F(ImmutableArray.Create[int32](7))
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0175");
    }

    [Fact]
    public void ParamsForwarding_WithConstructedUserGenericMiddleArgs_IsNotAmbiguous()
    {
        // Issue #3501 (GS0266): constructed imported generics over user type
        // arguments are freshly allocated, so the identity classification
        // missed and a normal-form slot tied with a params-expanded sibling.
        var source = @"
import System.Collections.Immutable

class Loc {
}

class Diag {
    shared {
        func Create(name string, code int32, messageArguments ...object?) string {
            return Create(name, code, ImmutableArray[Loc].Empty, ImmutableDictionary[string, string?].Empty, messageArguments)
        }

        func Create(name string, code int32, locations ImmutableArray[Loc], properties ImmutableDictionary[string, string?]?, messageArguments ...object?) string {
            return name + code.ToString() + messageArguments.Length.ToString()
        }
    }
}

Diag.Create(""d"", 1, ""a"", ""b"")
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("d12", result.Value);
    }

    [Fact]
    public void NonIndexableDiscriminant_StillReportsGS0175()
    {
        var source = @"
func F(value int32) bool {
    return value is [1]
}

F(1)
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0175");
    }
}
