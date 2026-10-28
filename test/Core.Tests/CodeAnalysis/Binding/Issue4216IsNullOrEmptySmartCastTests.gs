// <copyright file="Issue4216IsNullOrEmptySmartCastTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import Xunit

/// Issue #4216: receiver-style nullable predicates narrow their stable receiver
/// through explicit `[NotNullWhen]` contracts, with a compatibility rule
/// for established unannotated `IsNullOrEmpty` sequence extensions.
open class Issue4216IsNullOrEmptySmartCastTests {
    @Fact
    func NegatedUnannotatedSequencePredicate_NarrowsThenBranch() {
        let result = Evaluate(SequenceExtension + `
func Count(values IEnumerable[int32]?) int32 {
    var count = 0
    if !values.IsNullOrEmpty() {
        for value in values {
            count++
        }
    }
    return count
}

Count([]int32{1, 2, 3})`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func UnannotatedSequencePredicate_NarrowsElseBranch() {
        let result = Evaluate(SequenceExtension + `
func First(values IEnumerable[int32]?) int32 {
    if values.IsNullOrEmpty() {
        return -1
    } else {
        for value in values {
            return value
        }
    }
    return -2
}

First([]int32{7})`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func UnannotatedSequencePredicate_EarlyExitLiftsNarrowing() {
        let result = Evaluate(SequenceExtension + `
func Count(values IEnumerable[int32]?) int32 {
    if values.IsNullOrEmpty() {
        return 0
    }

    var count = 0
    for value in values {
        count++
    }
    return count
}

Count([]int32{1, 2})`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func AnnotatedReceiverPredicate_WithDifferentName_Narrows() {
        let result = Evaluate(`import System.Diagnostics.CodeAnalysis

func (@NotNullWhen(false) value string?) IsMissing() bool {
    return value == nil
}

func Length(value string?) int32 {
    if !value.IsMissing() {
        return value.Length
    }
    return -1
}

Length("hello")`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func IsNullOrEmpty_OnUnrelatedNullableReceiver_DoesNotNarrow() {
        let result = Evaluate(`func (value int32?) IsNullOrEmpty() bool {
    return false
}

func Read(value int32?) int32 {
    if !value.IsNullOrEmpty() {
        return value
    }
    return 0
}

Read(1)`)
        Assert.Contains(
            result.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Message.Contains("Cannot convert type", StringComparison.Ordinal)
        )
    }

    @Fact
    func IsNullOrEmpty_WithAdditionalArgument_DoesNotNarrow() {
        let result = Evaluate(`import System.Collections.Generic

func (values IEnumerable[int32]?) IsNullOrEmpty(flag bool) bool {
    return flag
}

func Count(values IEnumerable[int32]?) int32 {
    if !values.IsNullOrEmpty(false) {
        for value in values {
            return value
        }
    }
    return -1
}

Count([]int32{1})`)
        Assert.Contains(
            result.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Message.Contains("IEnumerable[int32]?", StringComparison.Ordinal)
        )
    }

    @Fact
    func UnannotatedSequencePredicate_NarrowsStableLetFieldPath() {
        let result = Evaluate(SequenceExtension + `
class Box { let Values IEnumerable[int32]? }

func Count(box Box) int32 {
    var count = 0
    if !box.Values.IsNullOrEmpty() {
        for value in box.Values {
            count++
        }
    }
    return count
}

Count(Box{Values: []int32{1, 2, 3}})`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func UnannotatedSequencePredicate_DoesNotNarrowMutableFieldPath() {
        let result = Evaluate(SequenceExtension + `
class Box { var Values IEnumerable[int32]? }

func Count(box Box) int32 {
    var count = 0
    if !box.Values.IsNullOrEmpty() {
        for value in box.Values {
            count++
        }
    }
    return count
}

Count(Box{Values: []int32{1}})`)
        Assert.Contains(
            result.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Message.Contains("IEnumerable[int32]?", StringComparison.Ordinal)
        )
    }

    @Fact
    func ExplicitOppositeReceiverContract_OverridesTheNameRule() {
        // [NotNullWhen(true)] on a method NAMED IsNullOrEmpty must win over the
        // compatibility rule's implied [NotNullWhen(false)], narrowing the
        // opposite arm.
        let result = Evaluate(`import System.Collections.Generic
import System.Diagnostics.CodeAnalysis

func (@NotNullWhen(true) values IEnumerable[int32]?) IsNullOrEmpty() bool {
    return values != nil
}

func Count(values IEnumerable[int32]?) int32 {
    var count = 0
    if values.IsNullOrEmpty() {
        for value in values {
            count++
        }
    }
    return count
}

Count([]int32{1, 2})`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func UnconstrainedGenericReceiver_DoesNotInheritTheNameRule() {
        // Issue #4216 review: eligibility is decided by the DECLARED receiver
        // type. An unconstrained `T?` receiver must not pick up the contract
        // merely because this call site happens to pass a sequence.
        let result = Evaluate(`import System.Collections.Generic

func (value T?) IsNullOrEmpty[T]() bool {
    return value == nil
}

func Count(values IEnumerable[int32]?) int32 {
    var count = 0
    if !values.IsNullOrEmpty() {
        for value in values {
            count++
        }
    }
    return count
}

Count([]int32{1})`)
        Assert.Contains(
            result.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Message.Contains("IEnumerable[int32]?", StringComparison.Ordinal)
        )
    }

    @Fact
    func MemberPathNarrowing_IsLiftedPastAnEarlyReturn() {
        // ADR-0208 row R5 (the decision this test asked for): the join lifts a
        // member path whatever its source, so the predicate form lifts past an
        // early return like the nil-guard form does.
        let result = Evaluate(SequenceExtension + `
class Box { let Values IEnumerable[int32]? }

func Count(box Box) int32 {
    if box.Values.IsNullOrEmpty() {
        return 0
    }

    var count = 0
    for value in box.Values {
        count++
    }
    return count
}

Count(Box{Values: []int32{1, 2}})`)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private const SequenceExtension string = `import System.Collections.Generic
import System.Linq

func (values IEnumerable[T]?) IsNullOrEmpty[T]() bool {
    return values == nil || values.Count() == 0
}`

        private func Evaluate(source string) EmittedOracleResult -> EmittedOracle.Evaluate(source)
    }
}
