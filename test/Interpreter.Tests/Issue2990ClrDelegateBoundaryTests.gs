// <copyright file="Issue2990ClrDelegateBoundaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Tests
import System
import Xunit

/// Issue #2990: closures whose signatures contain G# types must be coerced to
/// the delegate type expected by each CLR boundary. The tests that drove the
/// tree-walking `Evaluator`'s private reflection-call machinery directly
/// (`InvokeClrCtor`, `EvaluateClrStaticCallExpression`,
/// `BuildRefSlots`) retired with the evaluator in ADR-0156 Phase 3c
/// (#3176) — under emitted execution delegate conversion is real IL and is
/// pinned here through the observable end-to-end shapes.
open class Issue2990ClrDelegateBoundaryTests {
    @Fact
    func ImportedStaticCall_CoercesTypedAndUntypedClosures() {
        const Source = `import System
import System.Linq

data struct Item {
    var V int32
}

var items = []Item{Item{V: 11}, Item{V: 22}, Item{V: 33}}
Console.WriteLine(items.Where((item) -> item.V != 22).First().V)
Console.WriteLine(items.Where((item Item) -> item.V == 22).First().V)`
        Assert.Equal("11${Environment.NewLine}22${Environment.NewLine}", Evaluate(Source))
    }

    @Fact
    func ImportedInstanceCall_CoercesTypedAndUntypedClosures() {
        const Source = `import System
import System.Collections.Generic

data struct Item {
    var V int32
}

var items = List[Item]()
items.Add(Item{V: 33})
items.Add(Item{V: 44})
items.Add(Item{V: 55})
Console.WriteLine(items.Find((item) -> item.V == 44).V)
Console.WriteLine(items.Find((item Item) -> item.V == 55).V)`
        Assert.Equal("44${Environment.NewLine}55${Environment.NewLine}", Evaluate(Source))
    }

    @Fact
    func ClrConstructor_CoercesClosureWithUserTypeReturn() {
        const Source = `import System

data struct Item {
    var V int32
}

var item = Lazy[Item](() -> Item{V: 66}).Value
Console.WriteLine(item.V)`
        Assert.Equal("66${Environment.NewLine}", Evaluate(Source))
    }

    @Fact
    func UserFunctionCall_PreservesRawClosure() {
        const Source = `import System

data struct Item {
    var V int32
}

func Pick(items []Item, predicate (Item) -> bool) int32 {
    for item in items {
        if predicate(item) {
            return item.V
        }
    }
    return -1
}

var items = []Item{Item{V: 77}, Item{V: 88}, Item{V: 99}}
Console.WriteLine(Pick(items, (item) -> item.V == 88))`
        Assert.Equal("88${Environment.NewLine}", Evaluate(Source))
    }

    shared {
        private func Evaluate(source string) string {
            let result = EmittedOracle.Evaluate(source)
            Assert.Empty(result.Diagnostics)
            return result.Output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
