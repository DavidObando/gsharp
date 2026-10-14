// <copyright file="Issue4350IndexerOverloadBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// ADR-0187 / issue #4350: a type may declare several indexers that differ by
/// index-parameter signature, and an index access selects one by ordinary
/// overload resolution, exactly like C#.
open class Issue4350IndexerOverloadBindingTests {
    @Fact
    func OverloadsDifferingByParameterType_AreDeclaredAndSelected() {
        let result = EmittedOracle.Evaluate(Table + `
let t = Table()
t[1] + t["k"]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("bk!", result.Value)
    }

    @Fact
    func OverloadsDifferingByArity_AreSelectedByIndexCount() {
        let result = EmittedOracle.Evaluate(Table + `
let t = Table()
t[2, 3]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(23, result.Value)
    }

    @Fact
    func SetterOverload_IsSelectedForWrites() {
        let result = EmittedOracle.Evaluate(Table + `
let t = Table()
t[0] = "z"
t[0]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("z", result.Value)
    }

    @Fact
    func WriteToGetterOnlyOverload_IsRejected() {
        let result = EmittedOracle.Evaluate(Table + `
let t = Table()
t["k"] = "z"`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func BetterConversion_WinsOverWorseConversion() {
        let result = EmittedOracle.Evaluate(`class Pick {
    prop this[value int64] string -> "int64"
    prop this[value float64] string -> "float64"
}
Pick()[1]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("int64", result.Value)
    }

    @Fact
    func GenericStruct_RefReturningOverloads_UseReceiverSubstitution() {
        let result = EmittedOracle.Evaluate(`struct Buffer[T](items []T) {
    prop this[index int32] ref T -> items[index]
    prop this[index System.Index] ref T -> items[index.GetOffset(items.Length)]
    prop this[index int32, fromEnd bool] ref T -> items[if fromEnd { items.Length - index } else { index }]
}
var b = Buffer[int32]([]int32{10, 20, 30})
b[0] = 5
b[^1] = 7
b[0] + b[^2] + b[1, true] + b[2]`)
        Assert.Empty(result.Diagnostics)
        // {10, 20, 30} -> {5, 20, 7}: b[0] + b[^2] + b[1, fromEnd] + b[2].
        Assert.Equal(5 + 20 + 7 + 7, result.Value)
    }

    @Fact
    func InterfaceOverloads_DispatchThroughTheInterface() {
        let result = EmittedOracle.Evaluate(`interface ILookup {
    prop this[index int32] string { get; }
    prop this[key string] string { get; }
}
class Lookup : ILookup {
    prop this[index int32] string -> "i" + index.ToString()
    prop this[key string] string -> "k" + key
}
let l ILookup = Lookup()
l[4] + l["x"]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("i4kx", result.Value)
    }

    @Fact
    func DerivedIndexer_HidesOnlyTheSameSignature() {
        let result = EmittedOracle.Evaluate(`open class Base {
    open prop this[index int32] string -> "base-int"
    prop this[key string] string -> "base-string"
}
class Derived : Base {
    override prop this[index int32] string -> "derived-int"
}
let d = Derived()
d[0] + "," + d["k"]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("derived-int,base-string", result.Value)
    }

    @Fact
    func ExactDuplicateIndexer_IsStillRejected() {
        let result = EmittedOracle.Evaluate(`class Twice {
    prop this[index int32] string -> "a"
    prop this[other int32] string -> "b"
}
0`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
    }

    @Fact
    func DuplicatePlainIndexerAfterExplicitImplementation_IsStillRejected() {
        // Review finding: an explicit-interface indexer earlier in the type
        // must not exempt two plain indexers with the same signature.
        let result = EmittedOracle.Evaluate(`interface IRepo {
    prop this[key int32] string { get; }
}

class Store : IRepo {
    private prop (IRepo) this[key int32] string -> "explicit"
    prop this[index int32] string -> "a"
    prop this[other int32] string -> "b"
}
0`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
    }

    @Fact
    func PlainIndexerBesideExplicitImplementation_IsAccepted() {
        let result = EmittedOracle.Evaluate(`interface IRepo {
    prop this[key int32] string { get; }
}

class Store : IRepo {
    private prop (IRepo) this[key int32] string -> "explicit"
    prop this[index int32] string -> "plain"
}
let store = Store()
let repo IRepo = store
store[0] + "," + repo[0]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("plain,explicit", result.Value)
    }

    @Fact
    func ReadOnlyRefMultiParameterImportedIndexer_RejectsWrites() {
        // Review finding: `ReadOnlySlice<T>.this[int, bool]` returns
        // `ref readonly T`, so a multi-index write through it is rejected
        // while reads still bind.
        let runtime = []string{typeof(Gsharp.Values.Slice[_]).Assembly.Location}
        let write = EmittedOracle.Evaluate(`let values = readonly slice[int32]{1, 2, 3}
values[0, false] = 9
0`, runtime)
        Assert.Contains(write.Diagnostics, (d Diagnostic) -> d.IsError)
        let read = EmittedOracle.Evaluate(
            "let values = readonly slice[int32]{1, 2, 3}\nvalues[1, true] + values[0, false]",
            runtime
        )
        Assert.Empty(read.Diagnostics)
        Assert.Equal(4, read.Value)
    }

    @Fact
    func MultiParameterImportedIndexer_SupportsPostfixIncrement() {
        // Review finding: `slice[i, fromEnd]++` writes through the runtime's
        // `ref T this[int, bool]` and yields the previous element.
        let runtime = []string{typeof(Gsharp.Values.Slice[_]).Assembly.Location}
        let result = EmittedOracle.Evaluate(`let values = slice[int32]{1, 2, 3}
let old = values[1, true]++
--values[0, false]
old * 100 + values[0] * 10 + values[2]`, runtime)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(300 + 0 + 4, result.Value)
    }

    @Fact
    func AmbiguousIndexerCall_ReportsGs0266() {
        let result = EmittedOracle.Evaluate(`class Pair {
    prop this[a int32, b int64] string -> "left"
    prop this[a int64, b int32] string -> "right"
}
Pair()[1, 1]`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0266")
    }

    @Fact
    func NoApplicableIndexer_ReportsGs0267() {
        let result = EmittedOracle.Evaluate(Table + `
let t = Table()
t[1, 2, 3]`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0267")
        Assert.DoesNotContain(result.Diagnostics.Where((d Diagnostic) -> d.IsError), (d Diagnostic) -> d.Id == "GS0102")
    }

    shared {
        private const Table string = `class Table {
    private var values []string = []string{"a", "b", "c"}
    prop this[index int32] string {
        get { return values[index] }
        set { values[index] = value }
    }
    prop this[name string] string {
        get { return name + "!" }
    }
    prop this[row int32, column int32] int32 -> row * 10 + column
}`
    }
}
