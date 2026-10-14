// <copyright file="ConversionOperatorTests.cs" company="GSharp">
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

/// Issue #1017 — user-defined implicit/explicit conversion operators declared in
/// G# via `func operator implicit/explicit (x T) U`. They bind as static
/// `op_Implicit`/`op_Explicit` special-name methods and participate in
/// conversion resolution.
open class ConversionOperatorTests {
    @Fact
    func ImplicitConversion_AppliedAtAssignment_BindsAndEvaluates() {
        let source = `
struct Celsius {
    var degrees int32
}

func operator implicit (c Celsius) int32 {
    return c.degrees
}

var c = Celsius{degrees: 42}
var d int32 = c
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ExplicitConversion_AppliedAtCast_BindsAndEvaluates() {
        let source = `
struct Celsius {
    var degrees int32
}

func operator explicit (d int32) Celsius {
    return Celsius{degrees: d}
}

var raw = 7
var c = Celsius(raw)
var back = c.degrees
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func ImplicitConversion_AppliedAtArgument_BindsAndEvaluates() {
        let source = `
struct Celsius {
    var degrees int32
}

func operator implicit (c Celsius) int32 {
    return c.degrees
}

func doubleIt(n int32) int32 {
    return n + n
}

var c = Celsius{degrees: 21}
var r = doubleIt(c)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ConversionOperator_WithMultipleParameters_ReportsGS0393() {
        let source = `
struct Box {
    var v int32
}

func operator implicit (a Box, b int32) int32 {
    return a.v
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0393")
    }

    @Fact
    func ConversionOperator_NeitherTypeIsOwner_ReportsGS0394() {
        let source = `
struct Box {
    var v int32
}

func operator implicit (x int32) string {
    return "x"
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0394")
    }

    @Fact
    func DuplicateConversionOperator_ReportsGS0395() {
        let source = `
struct Box {
    var v int32
}

func operator implicit (b Box) int32 {
    return b.v
}

func operator explicit (b Box) int32 {
    return b.v
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0395")
    }

    @Fact
    func InBodyImplicitConversion_AppliedAtAssignment_BindsAndEvaluates() {
        // Issue #1283: a conversion operator declared INSIDE the struct body
        // (rather than as a free function) is registered as a static
        // op_Implicit and applied implicitly at a target-typed position.
        let source = `
struct Meters {
    var v int32
    func operator implicit (n int32) Meters {
        return Meters{v: n}
    }
}

var m Meters = 5
var got = m.v
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func InBodyImplicitConversion_AppliedAtReturn_BindsAndEvaluates() {
        let source = `
struct Meters {
    var v int32
    func operator implicit (n int32) Meters {
        return Meters{v: n}
    }
}

func make() Meters {
    return 9
}

var got = make().v
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func InBodyExplicitConversion_NotAppliedImplicitly_ReportsGS0155() {
        // Issue #1283: op_Explicit must STILL require the explicit U(x) form.
        // An explicit-only in-body operator at an implicit position errors.
        let source = `
struct Meters {
    var v int32
    func operator explicit (n int32) Meters {
        return Meters{v: n}
    }
}

var m Meters = 5
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func InBodyExplicitConversion_AppliedAtCast_BindsAndEvaluates() {
        let source = `
struct Meters {
    var v int32
    func operator explicit (n int32) Meters {
        return Meters{v: n}
    }
}

var m = Meters(5)
var got = m.v
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func ImplicitConversion_NoOperator_ReportsGS0155() {
        // A source type with NO implicit user conversion to the target still
        // reports GS0155 — real errors are not suppressed by the new lookup.
        let source = `
struct Meters {
    var v int32
}

var m Meters = 5
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func ImplicitConversion_AppliesStandardConversionsBeforeAndAfterOperator() {
        let source = `
struct Meters {
    var value int64
    func operator implicit (n int64) Meters {
        return Meters{value: n}
    }
}

struct Count {
    var value int32
    func operator implicit (c Count) int32 {
        return c.value
    }
}

func make(n int32) Meters {
    return n
}

func takeMeters(m Meters) int64 {
    return m.value
}

func takeLong(n int64) int64 {
    return n
}

func returnLong(c Count) int64 {
    return c
}

let n int32 = 5
let assigned Meters = n
let passed = takeMeters(n)
let returned = make(n).value
let count = Count{value: 7}
let widened int64 = count
let widenedArgument = takeLong(count)
let widenedReturn = returnLong(count)
let lifted int64? = count
var total = assigned.value + passed + returned + widened + widenedArgument + widenedReturn
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(36L, result.Value)
    }

    @Fact
    func ImplicitConversion_AmbiguousStandardAdaptations_DoNotPickDeclarationOrder() {
        let source = `
struct Target {
    var selected int32
    func operator implicit (n int64) Target {
        return Target{selected: 1}
    }
    func operator implicit (n float64) Target {
        return Target{selected: 2}
    }
}

let n int32 = 5
let target Target = n
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
