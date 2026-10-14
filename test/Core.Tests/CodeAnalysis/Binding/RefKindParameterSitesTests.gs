// <copyright file="RefKindParameterSitesTests.cs" company="GSharp">
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

/// ADR-0060: binding-time tests for `ref`/`out`/`in` parameters at
/// the binder sites beyond free functions: struct instance methods, struct static
/// methods, interface members, class methods, named-delegate-type declarations,
/// constructors, and override / interface-implementation matching (GS0240).
open class RefKindParameterSitesTests {
    @Fact
    func StructInstanceMethod_RefParameter_BindsCleanly() {
        // ADR-0079 (issue #719): the canonical declaration site for owned-
        // type instance methods is the in-body form. Structs don't yet
        // accept in-body methods, so this exercises the receiver-clause
        // form and explicitly ignores the GS0314 warning it emits.
        let source = `
struct Counter {
    var Value int32
}

func (c Counter) Add(ref delta int32) {
    delta = delta + 1
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func ClassStaticMethod_OutParameter_BindsCleanly() {
        // ADR-0017 / ADR-0024: static methods on classes live in a `shared { ... }` block.
        let source = `
class MathHelper {
    shared {
        func TryDouble(input int32, out result int32) bool {
            result = input * 2
            return true
        }
    }
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func InterfaceMember_OutParameter_BindsCleanly() {
        let source = `
interface IParser {
    func TryParse(text string, out result int32) bool;
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ClassConstructor_RefParameter_BindsCleanly() {
        let source = `
class Box {
    var Value int32

    init(seed int32, ref delta int32) {
        delta = delta + 1
        Value = seed + delta
    }
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NamedDelegate_RefOutInParameters_BindsCleanly() {
        let source = `
delegate IntRefAction(ref counter int32, by int32);
delegate IntOutPredicate(out result int32) bool;
delegate StructInObserver(in box int32);
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NamedDelegate_RefKindInvocationMismatches_ReportGS0235NotGS0155() {
        let sources = []string{`
package RefDelegateMismatch

delegate RefAction(ref value int32);
var callback RefAction = (ref value int32) -> { }
var value = 0
callback(out value)
0
`, `
package GenericOutDelegateMismatch

delegate OutAction[T](out value T) bool;
func Bad[T](callback OutAction[T], ref value T) {
    callback(ref value)
}
0
`, `
package GenericInDelegateMismatch

delegate InAction[T](in value T) bool;
func Bad[T](callback InAction[T], ref value T) {
    callback(ref value)
}
0
`}
        for source in sources {
            let result = Evaluate(source)
            Assert.True(
                result.Diagnostics.Any((d Diagnostic) -> d.Id == "GS0235"),
                source + "\n" + string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> "${d.Id}: ${d.Message}"))
            )
            Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
        }
        // Issue #4400: omitting `in` at a delegate's `in` parameter binds
        // like C# (a readonly reference), so it is not a ref-kind mismatch.
        let missingIn = Evaluate(`
package InDelegateMissingModifier

delegate InAction(in value int32) int32;
var callback InAction = (in value int32) -> value * 2
var value = 21
callback(value)
`)
        Assert.Empty(missingIn.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, missingIn.Value)
    }

    @Fact
    func PrimaryCtor_RefParameter_Rejected() {
        let source = `
class Vec(ref x int32) { }
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0424")
    }

    // ----------------------------------------------------------------------
    // Override / interface-implementation ref-kind matching (GS0240).
    // ----------------------------------------------------------------------
    @Fact
    func Override_AddsRefWhereBaseHasNone_ReportsGS0240() {
        let source = `
open class Base {
    open func Adjust(value int32) {
    }
}

class Derived : Base {
    override func Adjust(ref value int32) {
        value = value + 1
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0240")
    }

    @Fact
    func Override_RemovesRef_ReportsGS0240() {
        let source = `
open class Base {
    open func Adjust(ref value int32) {
        value = value + 1
    }
}

class Derived : Base {
    override func Adjust(value int32) {
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0240")
    }

    @Fact
    func Override_ChangesInToRef_ReportsGS0240() {
        let source = `
open class Base {
    open func Observe(in value int32) {
    }
}

class Derived : Base {
    override func Observe(ref value int32) {
        value = value + 1
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0240")
    }

    @Fact
    func Override_ChangesOutToIn_ReportsGS0240() {
        let source = `
open class Base {
    open func Produce(out value int32) {
        value = 0
    }
}

class Derived : Base {
    override func Produce(in value int32) {
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0240")
    }

    @Fact
    func Override_MatchingRefKind_BindsCleanly() {
        let source = `
open class Base {
    open func Adjust(ref value int32) {
        value = value + 1
    }
}

class Derived : Base {
    override func Adjust(ref value int32) {
        value = value + 2
    }
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func InterfaceImpl_MissingOutOnImplementor_ReportsGS0240() {
        let source = `
interface IParser {
    func TryParse(text string, out result int32) bool;
}

class MyParser : IParser {
    func TryParse(text string, result int32) bool {
        return false
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0240")
    }

    @Fact
    func InterfaceImpl_MatchingOut_BindsCleanly() {
        let source = `
interface IParser {
    func TryParse(text string, out result int32) bool;
}

class MyParser : IParser {
    func TryParse(text string, out result int32) bool {
        result = 0
        return false
    }
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func InParameter_MissingCallSiteModifier_PassesReadOnlyReference() {
        // Issue #4400 (ADR-0060 amendment): omitting `in` at the call site
        // binds like C# — the lvalue's own address, or a spilled temp for an
        // rvalue — instead of the former GS0242 error (issue #3501 had made it
        // an error because the argument reached the emitter as GS9998).
        let result = Evaluate(`
func Take(in f int32) int32 {
    return f * 2
}

let x = 3
Take(x) + Take(x + 1)
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(14, result.Value)
    }

    @Fact
    func InParameter_ExplicitModifier_Binds() {
        let result = Evaluate(`
func Take(in f int32) int32 {
    return f * 2
}

let x = 3
Take(in x)
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(6, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
