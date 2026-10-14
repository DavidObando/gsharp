// <copyright file="Issue3501IndexableListPatternTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3501: list patterns accept indexable non-array discriminants — any
/// imported type with an int32 `Length`/`Count` getter and a
/// `this[int]` indexer, e.g. `ImmutableArray[T]`. The rest
/// subpattern must be a pure `..` discard (no middle-slice
/// materialization exists for an arbitrary indexable).
open class Issue3501IndexableListPatternTests {
    @Fact
    func ImmutableArray_PrefixBindingAndRestDiscard_Matches() {
        let source = `
import System.Collections.Immutable

func First(items ImmutableArray[string]) string {
    if items is [var first, ..] {
        return first
    }
    return "empty"
}

First(ImmutableArray.Create[string]("hello", "world")) + "|" + First(ImmutableArray[string].Empty)
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("hello|empty", result.Value)
    }

    @Fact
    func ImmutableArray_StrictSingleElement_ChecksLength() {
        let source = `
import System.Collections.Immutable

func Only(items ImmutableArray[int32]) int32 {
    if items is [var x] {
        return x
    }
    return -1
}

Only(ImmutableArray.Create[int32](7)) * 10 + Only(ImmutableArray.Create[int32](1, 2))
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(69, result.Value)
    }

    @Fact
    func ImmutableArray_SuffixElement_IndexesFromTheEnd() {
        let source = `
import System.Collections.Immutable

func Last(items ImmutableArray[int32]) int32 {
    if items is [.., var last] {
        return last
    }
    return -1
}

Last(ImmutableArray.Create[int32](1, 2, 3))
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ImmutableArray_RestCapture_IsRejected() {
        let source = `
import System.Collections.Immutable

func F(items ImmutableArray[int32]) int32 {
    if items is [var x, ..rest] {
        return x
    }
    return -1
}

F(ImmutableArray.Create[int32](7))
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0175")
    }

    @Fact
    func ParamsForwarding_WithConstructedUserGenericMiddleArgs_IsNotAmbiguous() {
        // Issue #3501 (GS0266): constructed imported generics over user type
        // arguments are freshly allocated, so the identity classification
        // missed and a normal-form slot tied with a params-expanded sibling.
        let source = `
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

Diag.Create("d", 1, "a", "b")
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("d12", result.Value)
    }

    @Fact
    func NonIndexableDiscriminant_StillReportsGS0175() {
        let source = `
func F(value int32) bool {
    return value is [1]
}

F(1)
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0175")
    }
}
