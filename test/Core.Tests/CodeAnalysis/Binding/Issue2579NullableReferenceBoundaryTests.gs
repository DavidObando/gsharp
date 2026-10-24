// <copyright file="Issue2579NullableReferenceBoundaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

class Issue2579NullableReferenceBoundaryTests {
    @Fact
    func GuardsAndAssertions_EnableReferenceUsesAcrossAllBoundaries() {
        let result = Evaluate(`import System
import System.Collections.Generic

func Length(value string) int32 -> value.Length

// A call may assign a top-level variable (ADR-0208 R11), so the guarded variables are locals.
func Run() int32 {
    var value string? = "key"
    var list = List[string]()
    list.Add("a")
    list.Add("b")
    var values IEnumerable[string]? = list
    var dict = Dictionary[string, int32]()
    var total = 0

    if value != nil {
        var assigned string = value
        total += Length(value)
        dict[value] = assigned.Length
    }

    if !String.IsNullOrEmpty(value) {
        total += Length(value)
    }

    if values != nil {
        for item in values {
            total += item.Length
        }
    }

    total += Length(value!!)
    return total
}

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(11, result.Value)
    }

    @Fact
    func UnguardedNullableReferencesRemainHardErrors() {
        let result = Evaluate(`import System.Collections.Generic

func Consume(value string) {}

var value string? = nil
var values IEnumerable[string]? = nil
var dict = Dictionary[string, int32]()
var assigned string = value
Consume(value)
var length = value.Length
var indexed = dict[value]
for item in values {}`)
        Assert.True(result.Diagnostics.Count() >= 5)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0158")
        Assert.Contains(
            result.Diagnostics,
            (diagnostic Diagnostic) -> (diagnostic.Id is "GS0154" or "GS0155" or "GS0156")
        )
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0116")
    }

    @Fact
    func NullableValuesAndInvalidReferenceConversionsRemainHardErrors() {
        let result = Evaluate(`interface IService {}
class Service : IService {}
class Other {}

func NeedInt(value int32) {}
func NeedService(value IService) {}

var number int32? = 1
var service Service? = nil
var other = Other()
NeedInt(number)
NeedService(service)
NeedService(other)`)
        Assert.True(result.Diagnostics.Count() >= 3)
        Assert.All(
            result.Diagnostics,
            (diagnostic Diagnostic) -> Assert.Contains(diagnostic.Id, []string{"GS0154", "GS0155", "GS0156"})
        )
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
