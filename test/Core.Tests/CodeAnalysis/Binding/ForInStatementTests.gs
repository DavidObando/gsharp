// <copyright file="ForInStatementTests.cs" company="GSharp">
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
import System.Threading.Tasks
import Xunit

/// Phase 7.2 — canonical `for v in collection` and `await for v in stream` binding.
open class ForInStatementTests {
    @Fact
    func ForIn_OverArray_YieldsValuesInSourceOrder() {
        let source = `
var arr = [3]int32{1, 2, 3}
var folded = 0
for v in arr {
    folded = (folded * 10) + v
}
folded
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(123, result.Value)
    }

    @Fact
    func ForIn_OverSlice_YieldsStrings() {
        let source = `
var xs = []string{"a", "b", "c"}
var s = ""
for v in xs {
    s = s + v
}
s
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("abc", result.Value)
    }

    @Fact
    func ForIn_OverDictionary_YieldsKeysAndValues() {
        let source = `
import System.Collections.Generic

var dict = Dictionary[string, int32]()
dict["a"] = 1
dict["bb"] = 2
var total = 0
var keyChars = 0
for k, v in dict {
    total = total + v
    keyChars = keyChars + k.Length
}
(total * 10) + keyChars
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(33, result.Value)
    }

    @Fact
    func ForIn_OverList_UsesEnumerablePath() {
        let source = `
import System.Collections.Generic

var list = List[int32]()
list.Add(4)
list.Add(5)
list.Add(6)
var sum = 0
for v in list {
    sum = sum + v
}
sum
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(15, result.Value)
    }

    @Fact
    func ForIn_OverClrPatternEnumerable_UsesGetEnumeratorPattern() {
        let source = `
import GSharp.Core.Tests.CodeAnalysis.Binding

var sum = 0
for v in PatternEnumerableFixture() {
    sum = sum + v
}
sum
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(12, result.Value)
    }

    @Fact
    func TypedForIn_OverNonGenericEnumerable_CastsEachElement() {
        let source = `
import System.Collections

var values = ArrayList()
values.Add("a")
values.Add("bb")
var total = 0
for value string in values {
    total = total + value.Length
}
total
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func TypedForIn_HeterogeneousEnumerable_ThrowsInvalidCastException() {
        let source = `
import System
import System.Collections

var values = ArrayList()
values.Add("ok")
values.Add(42)
var caught = false
try {
    for value string in values {
    }
} catch (InvalidCastException) {
    caught = true
}
caught
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func TypedForIn_ImpossibleElementConversion_Diagnoses() {
        let source = `
var values = []int32{1}
for value string in values {
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0155")
    }

    @Fact
    func ForIn_OverUserPatternEnumerable_UsesGetEnumeratorPattern() {
        let source = `
class NumberEnumerator(Index int32, Current int32) {
    func MoveNext() bool {
        Index = Index + 1
        if Index <= 3 {
            Current = Index * 2
            return true
        }

        return false
    }
}

class Numbers {
    func GetEnumerator() NumberEnumerator {
        return NumberEnumerator(0, 0)
    }
}

var sum = 0
for v in Numbers{} {
    sum = sum + v
}
sum
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(12, result.Value)
    }

    @Fact
    func AwaitForIn_OverAsyncEnumerable_YieldsValues() {
        let source = `
import GSharp.Core.Tests.CodeAnalysis.Binding

var total = 0
await for v in AsyncStreamFixture.Counts() {
    total = total + v
}
total
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func TypedAwaitForIn_ConvertsEachElement() {
        let source = `
import GSharp.Core.Tests.CodeAnalysis.Binding

var total int64 = 0
await for value int64 in AsyncStreamFixture.Counts() {
    total = total + value
}
total
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6L, result.Value)
    }

    @Fact
    func LegacyForRange_StillBinds() {
        let source = `
var xs = []int32{1, 2, 3}
var sum = 0
for v in xs {
    sum = sum + v
}
sum
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func LegacyAwaitForRange_StillBinds() {
        let source = `
import GSharp.Core.Tests.CodeAnalysis.Binding

var total = 0
await for v in AsyncStreamFixture.Counts() {
    total = total + v
}
total
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func ForIn_OverNonIterable_Diagnoses() {
        let source = `
for v in 42 {
}
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func In_RemainsRegularIdentifier() {
        let source = `
let in = 1
in + 2
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

/// CLR fixture exposing the C# foreach pattern without implementing (cref:IEnumerable{T}).
class PatternEnumerableFixture {
    /// Creates a new pattern enumerator.
    /// @returns The enumerator.
    func GetEnumerator() PatternEnumerator -> PatternEnumerator()
}

/// Enumerator for (cref:PatternEnumerableFixture).
class PatternEnumerator {
    private let values[]int32 = []int32{2, 4, 6}
    private var index int32 = -1

    /// Gets the current element.
    prop Current int32 {
        get;
        private set;
    }

    /// Moves to the next element.
    /// @returns True when an element is available.
    func MoveNext() bool {
        index++
        if index >= values.Length {
            return false
        }
        Current = values[index]
        return true
    }
}
