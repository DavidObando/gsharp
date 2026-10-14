// <copyright file="Issue1951ListPatternMetadataArrayTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #1951: `BindListPattern` required the discriminant's type to be
/// the in-compilation `ArrayTypeSymbol`/`SliceTypeSymbol`, so a list
/// pattern against a value whose static type arrives as a metadata/imported
/// CLR array (e.g. `Array.Empty[int32]()`, or `string.Split`'s
/// `string[]`) was wrongly rejected even though it is genuinely
/// array-shaped. Fixed by reusing
/// `ExpressionBinder.GetArraySliceElementType` (the same array/CLR-array
/// recognition used for array/span slicing) in `PatternBinder.BindListPattern`.
open class Issue1951ListPatternMetadataArrayTests {
    @Fact
    func EmptyMetadataArray_MatchesEmptyListPattern() {
        AssertEvaluates(`
package P
import System

let a = Array.Empty[int32]()
let x = switch a { case []: 1 default: 0 }
x
`, 1)
    }

    @Fact
    func NonEmptyMetadataArray_FromSplit_BindsElementAndSlice() {
        AssertEvaluates(`
package P
import System

let parts = "a,b,c".Split(",")
let x = switch parts { case [f is string, ..rest]: f + "|" + rest.Length.ToString() default: "no" }
x
`, "a|2")
    }

    @Fact
    func MetadataArray_NotMatchingLength_FallsThroughToDefault() {
        AssertEvaluates(`
package P
import System

let parts = "a,b".Split(",")
let x = switch parts { case [_, _, _]: "three" default: "other" }
x
`, "other")
    }

    shared {
        private func AssertEvaluates(source string, expected object) {
            let result = EmittedOracle.Evaluate(source)
            Assert.Empty(result.Diagnostics)
            Assert.Equal(expected, result.Value)
        }
    }
}
