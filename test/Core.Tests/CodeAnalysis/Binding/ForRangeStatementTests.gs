// <copyright file="ForRangeStatementTests.cs" company="GSharp">
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
import Xunit

/// Phase 4 exit (part 3) — `for k, v := range coll` over arrays,
/// slices, CLR dictionaries, and CLR enumerables.
open class ForRangeStatementTests {
    @Fact
    func ForRange_OverArray_ValueOnly_Binds() {
        let source = `
import System

var arr = [3]int32{10, 20, 30}
for v in arr {
    Console.WriteLine(v)
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ForRange_OverArray_KeyAndValue_Binds() {
        let source = `
import System

var arr = [3]int32{10, 20, 30}
for i, v in arr {
    Console.WriteLine(i)
    Console.WriteLine(v)
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ForRange_OverList_ValueOnly_Binds() {
        let source = `
import System
import System.Collections.Generic

var lst = List[int32]()
lst.Add(1)
lst.Add(2)
for v in lst {
    Console.WriteLine(v)
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ForRange_OverList_KeyAndValue_Binds() {
        let source = `
import System
import System.Collections.Generic

var lst = List[int32]()
lst.Add(7)
for i, v in lst {
    Console.WriteLine(i)
    Console.WriteLine(v)
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ForRange_OverDictionary_KeyAndValue_Binds() {
        let source = `
import System
import System.Collections.Generic

var d = Dictionary[string, int32]()
d["a"] = 1
d["b"] = 2
for k, v in d {
    Console.WriteLine(k)
    Console.WriteLine(v)
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ForRange_BreakAndContinue_Bind() {
        let source = `
import System

var arr = [4]int32{1, 2, 3, 4}
for i, v in arr {
    if v == 2 {
        continue
    }
    if v == 4 {
        break
    }
    Console.WriteLine(v)
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ForRange_OverNonIterable_Diagnoses() {
        let source = `
var x = 42
for v in x {
}
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
