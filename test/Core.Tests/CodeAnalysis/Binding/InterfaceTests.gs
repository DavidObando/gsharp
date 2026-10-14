// <copyright file="InterfaceTests.cs" company="GSharp">
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

/// Phase 3.B.4 — `interface` declarations. Per ADR-0085 (which
/// supersedes ADR-0018's deferral) interfaces may carry default-method
/// bodies in addition to abstract signatures. Classes implement interfaces
/// via the `:` clause; the binder accepts inherited defaults when the
/// implementer omits the method, and reports GS0318 when two unrelated
/// interfaces provide conflicting defaults for the same signature.
/// Interface-typed receivers dispatch to the runtime type's implementation,
/// falling back to the interface default when no override exists.
open class InterfaceTests {
    @Fact
    func InterfaceDeclaration_OnlySignatures_Binds() {
        let source = `
interface IShape {
    func Area() int32;
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func InterfaceMethod_NoBody_MissingSemicolon_DiagnosesGS0368() {
        // Issue #881: a bodyless interface func is the no-body (abstract) form
        // and must be terminated with ';' — the universal no-body marker for
        // func declarations (mirroring P/Invoke, ADR-0086). Omitting it is a
        // GS0368 parse error.
        let source = `
interface IShape {
    func Area() int32
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0368")
    }

    @Fact
    func InterfaceMethod_NoBody_WithSemicolon_Binds() {
        // Issue #881: the ';' no-body marker is the canonical bodyless form.
        let source = `
interface IShape {
    func Area() int32;
    func Name() string;
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func InterfaceSharedSlot_NoBody_MissingSemicolon_DiagnosesGS0368() {
        // Issue #881: the rule extends to abstract static slots inside an
        // interface `shared { … }` block (ADR-0089).
        let source = `
interface IAdd {
    shared {
        func Add(a int32, b int32) int32
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0368")
    }

    @Fact
    func InterfaceMethodWithBody_IsAcceptedAsDefaultMethod() {
        // ADR-0085 / issue #726: interface methods MAY carry a body
        // (default-interface method). The previous Phase 3 deferral
        // diagnostic (GS0186) is no longer emitted.
        let source = `
interface IGreeter {
    func Hello() string { return "hi" }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ClassImplementsInterface_Dispatches() {
        let source = `
interface IShape {
    func Area() int32;
}

class Square(Side int32) : IShape {
    func Area() int32 { return Side * Side }
}

var s = Square(4)
s.Area()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(16, result.Value)
    }

    @Fact
    func ClassMissingInterfaceMethod_ReportsDiagnostic() {
        let source = `
interface IShape {
    func Area() int32;
}

class Square(Side int32) : IShape {
}
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func ClassImplementsMultipleInterfaces() {
        let source = `
interface IShape {
    func Area() int32;
}

interface INamed {
    func Name() string;
}

class Square(Side int32) : IShape, INamed {
    func Area() int32 { return Side * Side }
    func Name() string { return "square" }
}

var s = Square(3)
s.Area()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func InterfaceDispatch_PicksRuntimeImpl() {
        let source = `
interface IShape {
    func Area() int32;
}

open class Box(W int32) : IShape {
    open func Area() int32 { return W }
}

class BigBox(W int32) : Box {
    override func Area() int32 { return W * 10 }
}

var b = BigBox(5)
b.Area()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(50, result.Value)
    }

    @Fact
    func SealedInterface_SamePackage_Implementor_Works() {
        let source = `
package GSharp.Tests.Sealed
sealed interface IResult {
    func Ok() bool;
}

class Success : IResult {
    func Ok() bool { return true }
}

var s = Success{}
s.Ok()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func SealedInterface_WithDefaultBody_IsAccepted() {
        // ADR-0085 / issue #726: sealed interfaces may still expose default
        // bodies; the `sealed` modifier only restricts which packages may
        // implement the interface — it does not preclude DIM declarations.
        let source = `
sealed interface IGood {
    func F() int32 { return 0 }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func SealedInterface_DifferentPackage_Implementor_Diagnoses() {
        let t1 = `
package GSharp.Tests.Sealed.A
public sealed interface IResult {
    func Ok() bool;
}
`
        let t2 = `
package GSharp.Tests.Sealed.B
import GSharp.Tests.Sealed.A
class Success : IResult {
    func Ok() bool { return true }
}
`
        let result = EmittedOracle.Evaluate([]string{t1, t2})
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("sealed interface"))
    }

    @Fact
    func GenericClass_Implements_UserGenericInterface_UsingTypeParameter_Binds() {
        let source = `
interface IBox[T any] {
    func Get() T;
}

class Box[T any](value T) : IBox[T] {
    func Get() T { return value }
}

var b = Box[string]("hi")
b.Get()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hi", result.Value)
    }

    @Fact
    func GenericClass_Implements_ClrGenericInterface_ResolvesTypeParameterBaseClause() {
        // This exercises base-clause generic resolution with an in-scope type
        // parameter (`IEnumerable[T]`). The class body is intentionally partial:
        // IEnumerable<T> slot-completeness is validated separately.
        let source = `
import System.Collections
import System.Collections.Generic

class MyGeneric[T any] : IEnumerable[T] {
    func GetEnumerator() IEnumerator[T] { return nil }
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Cannot find type IEnumerable"))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Cannot find type T"))
    }

    @Fact
    func DefaultInterfaceMethod_InheritedByImplementer_IsCallable() {
        // ADR-0085: a class that omits a default interface method inherits
        // the default body via virtual dispatch when invoked through either
        // the class or the interface.
        let source = `
interface IGreeter {
    func Greet() string { return "hello from default" }
}

class Greeter : IGreeter {
}

var g = Greeter{}
g.Greet()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hello from default", result.Value)
    }

    @Fact
    func DefaultInterfaceMethod_OverriddenByImplementer_CallsOverride() {
        let source = `
interface IGreeter {
    func Greet() string { return "default" }
}

class Loud : IGreeter {
    func Greet() string { return "LOUD" }
}

var g = Loud{}
g.Greet()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("LOUD", result.Value)
    }

    @Fact
    func DefaultInterfaceMethod_CalledThroughInterfaceReceiver_DispatchesCorrectly() {
        // ADR-0085: dispatch through an interface-typed receiver routes to
        // the class override when present, otherwise to the interface default.
        let source = `
interface IGreeter {
    func Greet() string { return "default" }
}

class Quiet : IGreeter {
}

class Loud : IGreeter {
    func Greet() string { return "LOUD" }
}

var quiet IGreeter = Quiet{}
var loud  IGreeter = Loud{}
quiet.Greet() + ":" + loud.Greet()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("default:LOUD", result.Value)
    }

    @Fact
    func DefaultInterfaceMethod_AbstractAndDefault_Coexist() {
        // One abstract slot, one default slot — implementer only needs to
        // provide the abstract one.
        let source = `
interface IShape {
    func Area() int32;
    func Describe() string { return "shape" }
}

class Square(side int32) : IShape {
    func Area() int32 { return side * side }
}

var s = Square(3)
s.Area() + s.Describe().Length
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9 + 5, result.Value)
    }

    @Fact
    func ConflictingDefaults_FromTwoInterfaces_DiagnosesGS0318() {
        // ADR-0085 diamond rule: when an implementer inherits two different
        // default bodies for the same signature it must override; otherwise
        // the binder reports GS0318.
        let source = `
interface IA {
    func F() int32 { return 1 }
}

interface IB {
    func F() int32 { return 2 }
}

class C : IA, IB {
}
`
        let result = Evaluate(source)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("GS0318") || d.Message.Contains("conflicting default")
        )
    }

    @Fact
    func ConflictingDefaults_WithExplicitOverride_Compiles() {
        let source = `
interface IA {
    func F() int32 { return 1 }
}

interface IB {
    func F() int32 { return 2 }
}

class C : IA, IB {
    func F() int32 { return 99 }
}

var c = C{}
c.F()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(99, result.Value)
    }

    @Fact
    func AbstractInterfaceMethod_NoImplementer_DiagnosesGS0320() {
        // If an interface has no default and the class fails to provide an
        // override, the binder reports the "missing implementation" form
        // (GS0320), not the conflict form.
        let source = `
interface IMissing {
    func Required() int32;
}

class C : IMissing {
}
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func InterfaceDefaultMethod_StaticModifier_NowAcceptedByParser() {
        // ADR-0089 / issue #755 (issue #865 revision): static-virtual interface
        // members are declared inside a `shared { … }` block (with or without a
        // default body). This test pins the behavior — the source binds with no
        // diagnostics.
        let source = `
interface IStaticy {
    shared {
        func F() int32 { return 1 }
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    // -------------------------------------------------------------------
    // ADR-0090 / issue #756: `private` interface helper methods.
    // -------------------------------------------------------------------
    @Fact
    func PrivateInterfaceHelper_AcceptedByParser_AndCalledFromSiblingDefault() {
        // ADR-0090: a `private func` inside an `interface` is accepted by
        // the parser; another default method on the same interface may call
        // the helper unqualified (implicit `this` dispatch).
        let source = `
interface ICalc {
    func Double(x int32) int32 { return Helper(x) + Helper(x) }
    private func Helper(x int32) int32 { return x }
}

class C : ICalc {
}

var c = C{}
c.Double(3)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func PrivateInterfaceHelper_StaticAndPrivateStaticInSharedBlock_Accepted() {
        // ADR-0090 (issue #865 revision): static-virtual members and private
        // static helpers are declared together in the interface `shared { … }`
        // block. A `private func` inside that block is a private static helper.
        let source = `
interface IStatics {
    shared {
        func Get() int32 { return 7 }
        private func H() int32 { return 1 }
        private func K() int32 { return 2 }
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func PrivateInterfaceHelper_ExternalCallRejected_GS0334() {
        // ADR-0090: external code (a class instance) cannot see the private
        // helper through an interface-typed receiver. GS0334 fires.
        let source = `
interface ICalc {
    func Double(x int32) int32 { return x + x }
    private func Helper(x int32) int32 { return x }
}

class C : ICalc {
}

var c ICalc = C{}
c.Helper(3)
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0334")
    }

    @Fact
    func PrivateInterfaceHelper_WithoutBody_DiagnosesGS0335() {
        // ADR-0090: a `private` interface method must carry a body —
        // private helpers are part of the interface's own implementation.
        let source = `
interface IBad {
    private func Helper(x int32) int32;
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0335")
    }

    @Fact
    func PrivateInterfaceHelper_ImplementerSameSignature_DiagnosesGS0336() {
        // ADR-0090: an implementer cannot override a `private` interface
        // helper — its v-table slot is interface-internal.
        let source = `
interface ICalc {
    func Double(x int32) int32 { return x + x }
    private func Helper(x int32) int32 { return x }
}

class C : ICalc {
    func Helper(x int32) int32 { return x * 10 }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0336")
    }

    @Fact
    func PrivateInterfaceHelper_NotPartOfImplementerContract() {
        // ADR-0090: implementer-contract verification (GS0187 / GS0320)
        // is unaffected by private helpers. A class that omits a private
        // helper is still a valid implementer.
        let source = `
interface IThing {
    func Public() int32 { return 1 }
    private func Internal() int32 { return 99 }
}

class T : IThing {
}

var t = T{}
t.Public()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
