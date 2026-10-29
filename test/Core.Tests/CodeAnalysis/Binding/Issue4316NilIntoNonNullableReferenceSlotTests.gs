// <copyright file="Issue4316NilIntoNonNullableReferenceSlotTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #4316: `nil` assigned into a bare (non-`?`) G#-declared class slot
/// compiled, while the same shape into `string` or an imported class reported
/// GS0155. The maintainer decided that `nil` into ANY non-nullable reference
/// slot is an error.
/// @remarks <b>The contract.</b> `Conversion.Classify(nil, X)` is the one place
/// that answers "can `nil` be assigned to this slot?". It answers yes for a
/// nullable target (`X?`) and for a platform target (`X!`, ADR-0186 §3) and no
/// for every other target, whatever its kind. Assignment, initializers,
/// returns, arguments, fields, elements and generic instantiations reach that
/// answer through `Classify`, so each row below drives one slot kind through
/// the compiler and asserts the diagnostic id and the location of the `nil`.
///
/// <b>Old build.</b> Before the change the rows marked "G#-declared" in
/// the table compiled with no diagnostic: a class, an interface, a
/// reference-constrained type parameter and a type parameter whose dependent
/// bound proves a reference type all accepted `nil`. The `string`, imported
/// class, `object`, slice and struct rows already reported GS0155 and are the
/// controls. The accepted rows (`T?`, `T!`, comparison) compiled before and
/// still compile.
///
/// <b>Mutation witnesses</b> (ADR-0154), each applied to
/// `Conversion.Classify`'s nil arm and run against this class:
/// M1 restores the old predicate (class, interface, reference-constrained and
/// dependent type parameter accept `nil`); M2 admits only a class; M3 admits
/// only an interface; M4 admits only a type parameter; M5 refuses `nil` into
/// `T?` as well. M1 to M4 fail the rows that name their kind and M5 fails every
/// accepted row; the per-row result is in the PR description.
open class Issue4316NilIntoNonNullableReferenceSlotTests {
    /// A `nil` into a non-nullable slot reports the expected diagnostic at the
    /// `nil`; a nullable slot reports nothing.
    /// @param name The row name.
    /// @param source The G# source. A rejected row has exactly one line that holds `nil`.
    /// @param expectedId The diagnostic id, or the empty string for an accepted row.
    @Theory
    @MemberData("Rows")
    func ANilLiteral_IsAssignableOnlyToANullableSlot(name string, source string, expectedId string) {
        let errors = GetErrors(source)
        if expectedId == "" {
            Assert.True(errors.IsEmpty, (`'` + name + `' must compile. Got: ` + Describe(errors)))
            return
        }
        let diagnostic = Assert.Single(errors)
        Assert.Equal(expectedId, diagnostic.Id)
        let text = diagnostic.Location.Text!!.ToString(diagnostic.Location.Span)
        if expectedId != "GS0129" {
            Assert.Contains("nil", text)
        }
        let nilLines = source
            .Split('\n')
            .Select((l string, i int32) -> (l, i))
            .Where((p(string, int32)) -> p.Item1.Contains("nil"))
            .ToArray()
        Assert.Single(nilLines)
        Assert.Equal(nilLines[0].Item2, diagnostic.Location.StartLine)
    }

    /// The type-level answer, below the binder: `nil` converts to `T?` and
    /// `T!` and to nothing bare.
    @Fact
    func Classify_NilConvertsOnlyToNullableAndPlatformTargets() {
        let nilToBare = Conversion.Classify(TypeSymbol.Null, TypeSymbol.String)
        Assert.False(nilToBare.Exists)
        let nilToNullable = Conversion.Classify(TypeSymbol.Null, NullableTypeSymbol.Get(TypeSymbol.String))
        Assert.True(nilToNullable.IsImplicit)
        let nilToPlatform = Conversion.Classify(TypeSymbol.Null, PlatformTypeSymbol.Get(TypeSymbol.String))
        Assert.True(nilToPlatform.IsImplicit)
        Assert.False(nilToPlatform.RequiresPlatformNilCheck)
    }

    shared {
        private let Prelude string = `package p
import System
import System.Collections.Generic
class Box {
    var v int32
}
interface IThing {
    func M() int32;
}
class Gen[T](item T) { }
struct S {
    var a int32
}
class Holder {
    var slot Box?
    var item Box
    prop Item Box { get; set; }
}
func Take(b Box) int32 -> 0
func TakeI(i IThing) int32 -> 0
func TakeOk(b Box?) int32 -> 0
`

        /// Gets the contract table: one row per slot kind and type kind.
        func Rows() sequence[[]object] {
            // Slot kinds, G#-declared class. The first two are the issue's repros.
            yield Row("repro-assignment", `func F() {
    var b Box = Box()
    b = nil
}`, "GS0155")
            yield Row("repro-return", `func A4() Box -> nil`, "GS0155")
            yield Row("initializer", `func F() {
    let b Box = nil
}`, "GS0155")
            yield Row("return-statement", `func F() Box {
    return nil
}`, "GS0155")
            yield Row("argument", `func F() int32 -> Take(nil)`, "GS0154")
            yield Row("named-argument", `func F() int32 -> Take(b: nil)`, "GS0154")
            yield Row("constructor-argument", `class C(b Box) { }
func F() {
    let c = C(nil)
}`, "GS0154")
            yield Row("field-initializer", `class N {
    var next N = nil
}`, "GS0155")
            yield Row("field-assignment", `func F(h Holder) {
    h.item = nil
}`, "GS0155")
            yield Row("property-assignment", `func F(h Holder) {
    h.Item = nil
}`, "GS0155")
            yield Row("slice-element-literal", `func F() []Box -> []Box{nil}`, "GS0155")
            yield Row("slice-element-assignment", `func F(a []Box) {
    a[0] = nil
}`, "GS0155")
            yield Row("map-value-literal", `func F() {
    let m = map[string, Box]{"a": nil}
}`, "GS0155")
            yield Row("map-element-assignment", `func F() {
    var m = map[string, Box]{}
    m["a"] = nil
}`, "GS0155")
            yield Row("channel-send", `func F() {
    let ch = chan[Box](1)
    ch <- nil
}`, "GS0155")
            yield Row("tuple-element-in-imported-generic-call", `func F() {
    let xs = List[(Box, int32)]()
    xs.Add((nil, 1))
}`, "GS0155")
            yield Row("tuple-element-string-in-imported-generic-call", `func F() {
    let xs = List[(string, int32)]()
    xs.Add((nil, 1))
}`, "GS0155")
            yield Row("ok-tuple-element-nullable-in-imported-generic-call", `func F() {
    let xs = List[(Box?, int32)]()
    xs.Add((nil, 1))
}`, "")
            yield Row("tuple-element", `func F() (Box, int32) -> (nil, 1)`, "GS0155")
            yield Row("if-expression-arm", `func F(c bool) Box -> if c { nil } else { Box() }`, "GS0155")
            yield Row("lambda-return", `func F() Func[Box] {
    return func() Box { return nil }
}`, "GS0155")
            yield Row("yield", `func F() sequence[Box] {
    yield nil
}`, "GS0155")
            yield Row("generic-instantiation-add", `func F() {
    let l = List[Box]()
    l.Add(nil)
}`, "GS0155")
            yield Row("generic-instantiation-constructor", `func F() Gen[Box] -> Gen[Box](nil)`, "GS0154")
            yield Row("generic-class-return", `func F() Gen[Box] -> nil`, "GS0155")
            yield Row("generic-class-closed-over-value", `func F() Gen[int32] -> nil`, "GS0155")
            // Type kinds, G#-declared interface.
            yield Row("interface-return", `func F() IThing -> nil`, "GS0155")
            yield Row("interface-argument", `func F() int32 -> TakeI(nil)`, "GS0154")
            // Type parameters.
            yield Row("typeparam-class-return", `class Fixture {
    shared {
        func F[T class]() T -> nil
    }
}`, "GS0155")
            yield Row("typeparam-class-local", `class Fixture {
    shared {
        func F[T class]() {
            var y T = nil
        }
    }
}`, "GS0155")
            yield Row("typeparam-class-argument", `class Fixture {
    shared {
        func Sink[T class](x T) int32 -> 0
        func F[T class]() int32 -> Sink[T](nil)
    }
}`, "GS0154")
            yield Row("typeparam-class-list-add", `class Fixture {
    shared {
        func F[T class]() {
            let l = List[T]()
            l.Add(nil)
        }
    }
}`, "GS0155")
            yield Row("typeparam-dependent-bound", `class Fixture {
    shared {
        func F[A class, B A]() B -> nil
    }
}`, "GS0155")
            yield Row("typeparam-class-base-bound", `class Fixture {
    shared {
        func F[T Box]() T -> nil
    }
}`, "GS0155")
            yield Row("typeparam-unconstrained", `class Fixture {
    shared {
        func F[T]() T -> nil
    }
}`, "GS0155")
            yield Row("typeparam-generic-class-of-t", `class Fixture {
    shared {
        func F[T class]() Gen[T] -> nil
    }
}`, "GS0155")
            // Controls: kinds that already reported GS0155 on the old build.
            yield Row("control-string", `func F() string -> nil`, "GS0155")
            yield Row("control-imported-class", `func F() System.Text.StringBuilder -> nil`, "GS0155")
            yield Row("control-object", `func F() object -> nil`, "GS0155")
            yield Row("control-slice", `func F() []Box -> nil`, "GS0155")
            yield Row("control-struct", `func F() S -> nil`, "GS0155")
            yield Row("control-string-argument", `func Sink(s string) int32 -> 0
func F() int32 -> Sink(nil)`, "GS0154")
            // `x ?? nil` on a nullable reference is `x` (the join of `T?` and `nil` is `T?`).
            yield Row("ok-coalesce-nil-operand", `func F() {
    let x Box? = Box()
    let y = x ?? nil
}`, "")
            // Accepted: the slot declares that it holds nil.
            yield Row("ok-nullable-return", `func F() Box? -> nil`, "")
            yield Row("ok-nullable-assignment", `func F() {
    var b Box? = Box()
    b = nil
}`, "")
            yield Row("ok-nullable-field-and-argument", `func F(h Holder) int32 {
    h.slot = nil
    return TakeOk(nil)
}`, "")
            yield Row("ok-nullable-interface", `func F() IThing? -> nil`, "")
            yield Row("ok-nullable-generic-class", `func F() Gen[Box]? -> nil`, "")
            yield Row("ok-nullable-string", `func F() string? -> nil`, "")
            yield Row("ok-nullable-element", `func F() []Box? -> []Box?{nil}`, "")
            yield Row("ok-nullable-default-argument", `func D(b Box? = nil) int32 -> 0`, "")
            yield Row("ok-nullable-value-type", `func F() S? -> nil`, "")
            yield Row("ok-typeparam-class-nullable", `class Fixture {
    shared {
        func F[T class]() T? -> nil
    }
}`, "")
            yield Row("ok-typeparam-unconstrained-nullable", `class Fixture {
    shared {
        func F[T]() T? -> nil
    }
}`, "")
            yield Row("ok-typeparam-struct-nullable", `class Fixture {
    shared {
        func F[T struct]() T? -> nil
    }
}`, "")
            yield Row("ok-comparison-stays-legal", `func F(b Box) bool {
    return b == nil || b != nil
}`, "")
            // A `nil` arm of a branchy field initializer takes the field's nullable type.
            yield Row("ok-field-initializer-conditional-nil-arm", `class Flags {
    shared {
        public var R bool
    }
}
class H {
    public var f Box? = Flags.R ? Box() : nil
}`, "")
            yield Row("ok-static-field-initializer-if-nil-arm", `class Flags {
    shared {
        public var R bool
    }
}
class H {
    shared {
        public var f Box? = if Flags.R { Box() } else { nil }
    }
}`, "")
            yield Row("ok-field-initializer-parenthesized-nil-arm", `class Flags {
    shared {
        public var R bool
    }
}
class H {
    public var f Box? = (Flags.R ? Box() : nil)
}`, "")
            yield Row("ok-lambda-expression-body-nil-arm", `func F(c bool) {
    let f () -> Box? = () -> c ? Box() : nil
}`, "")
            yield Row("ok-lambda-block-tail-nil-arm", `func F(c bool) {
    let f () -> Box? = () -> { if c { Box() } else { nil } }
}`, "")
            yield Row("ok-parenthesized-local-nil-arm", `func F(c bool) {
    let b Box? = (c ? Box() : nil)
}`, "")
            yield Row("ok-parenthesized-assignment-nil-arm", `func F(c bool) {
    var b Box? = Box()
    b = (if c { Box() } else { nil })
}`, "")
            yield Row("ok-function-typed-field-lambda-nil-arm", `class H {
    public var f () -> Box? = () -> true ? Box() : nil
    shared {
        public var g () -> Box? = () -> true ? Box() : nil
    }
}`, "")
            yield Row("ok-generic-lambda-nil-arm", `class Fixture {
    shared {
        func F[T class](c bool, value T) {
            let f () -> T? = () -> c ? value : nil
            let g () -> T? = () -> { if c { value } else { nil } }
        }
    }
}`, "")
            yield Row("ok-switch-expression-nil-arm", `func F(i int32) {
    let b Box? = switch i {
        case 0: Box()
        default: nil
    }
}`, "")
            yield Row("ok-untargeted-join-is-nullable", `func F(c bool) {
    let b = c ? Box() : nil
    if b != nil {
        let n = b.v
    }
}`, "")
            yield Row("ok-coalesce-nil-in-field-initializer", `class H(value Box?) {
    public var f Box? = value ?? nil
}`, "")
            yield Row("ok-dependent-bound-join", `class Fixture {
    shared {
        func F[A class, B A](c bool, value B) {
            let x = c ? value : nil
            let y B? = x
        }
    }
}`, "")
            yield Row("field-initializer-conditional-bare-field", `class Flags {
    shared {
        public var R bool
    }
}
class H {
    public var f Box = Flags.R ? Box() : nil
}`, "GS0155")
            yield Row("ok-initializer-less-var", `func F() {
    var b Box
    var s S
}`, "")
            yield Row("ok-default-of-class", `func F() Box -> default(Box)`, "")
            // A default argument of `nil` for a bare class was already refused (GS0265).
            yield Row("default-argument-bare-class", `func D(b Box = nil) int32 -> 0`, "GS0265")
        }

        private func Row(name string, body string, expectedId string)[]object -> []object{
            name,
            Prelude + body,
            expectedId
        }

        private func Describe(errors ImmutableArray[Diagnostic]) string {
            return string.Join("; ", errors.Select((d Diagnostic) -> d.Id + " " + d.Message))
        }

        private func GetErrors(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree){IsLibrary = true}
            let parseDiagnostics = tree.Diagnostics
            let bindDiagnostics = compilation.GlobalScope.Diagnostics
            let programDiagnostics = compilation.BoundProgram.Diagnostics
            return parseDiagnostics
                .Concat(bindDiagnostics)
                .Concat(programDiagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToImmutableArray()
        }
    }
}
