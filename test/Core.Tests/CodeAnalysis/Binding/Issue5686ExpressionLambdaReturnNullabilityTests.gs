// <copyright file="Issue5686ExpressionLambdaReturnNullabilityTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #5686: an expression-bodied function literal converts its result to the target delegate's return
/// type, as a block-bodied function literal's `return` statement does. A `T?` result where the target
/// delegate returns a non-null `T` reports `GS0155` at the body expression.
open class Issue5686ExpressionLambdaReturnNullabilityTests {
    @Theory
    @MemberData("RejectedRows")
    func ExpressionLambda_WithNullableResultAtNonNullDelegateReturn_ReportsDiagnostic(
        name string,
        source string,
        expectedSnippet string,
        expectedId string
    ) {
        let errors = GetErrors(source)
        let diagnostic = Assert.Single(errors)
        Assert.True(
            diagnostic.Id == expectedId,
            "'$name' expected $expectedId, got ${diagnostic.Id}: ${diagnostic.Message}"
        )
        let spanText = diagnostic.Location.Text!!.ToString(diagnostic.Location.Span)
        Assert.Equal(expectedSnippet, spanText)
    }

    @Theory
    @MemberData("AcceptedRows")
    func ExpressionLambda_WithCompatibleOrNullableDelegateReturn_BindsCleanly(name string, source string) {
        let errors = GetErrors(source)
        Assert.True(errors.IsEmpty, "'$name' must bind with no errors. Got: " + Describe(errors))
    }

    shared {
        private const Prelude string = `package Demo
import System
import System.Collections.Generic
import System.Linq
import System.Linq.Expressions
import System.Threading.Tasks
import Lib5686

class Box {
    var Value int32
    prop MaybeName string? { get; set; }
}

interface IThing {
    func M() int32;
}

delegate StringFunc() string;
delegate NullableStringFunc() string?;
delegate BoxFunc() Box;
delegate IntMapFunc(x int32) string;

class Holder {
    var Callback () -> string = () -> "init"
    prop Prop () -> string { get; set; }
}

func Maybe() string? -> nil
func MaybeArgException() ArgumentException? -> nil
func MaybeRef[T class]() T? -> nil
func MaybeList[T]() List[T]? -> nil
func MaybeBox() Box? -> nil
func MaybeThing() IThing? -> nil
func MaybeInt() int32? -> nil
func MaybePair() (string, int32)? -> nil
func MaybePairElement() (string?, int32) -> (nil, 0)
func MaybeNullablePairElement() (string?, int32)? -> (nil, 0)
func TakeFunc(f () -> string) string -> f()
func TakeClrFunc(f Func[string]) string -> f()
func TakeNamedDelegate(f StringFunc) string -> f()
func TakeNullableDelegate(f (() -> string)?) string -> if f != nil { f() } else { "" }
`

        func RejectedRows() sequence[[]object] {
            yield Row("repro-expression-arrow", `func Run() string {
    let f () -> string = () -> Maybe()
    return f()
}`, "Maybe()")
            yield Row("repro-block-return-control", `func Run() string {
    let g () -> string = () -> { return Maybe() }
    return g()
}`, "Maybe()")
            yield Row("block-trailing-expression", `func Run() string {
    let f () -> string = () -> {
        let _ = 1
        Maybe()
    }
    return f()
}`, "Maybe()")
            yield Row("clr-func-target", `func Run() string {
    let f Func[string] = () -> Maybe()
    return f()
}`, "Maybe()")
            yield Row("named-delegate-target", `func Run() string {
    let f StringFunc = () -> Maybe()
    return f()
}`, "Maybe()")
            yield Row("imported-strict-delegate-target", `func Run() string {
    let f StrictDelegate5686 = () -> Maybe()
    return f()
}`, "Maybe()")
            yield Row("nullable-arrow-delegate-local", `func Run() {
    let f (() -> string)? = () -> Maybe()
}`, "Maybe()")
            yield Row("nullable-clr-func-local", `func Run() {
    let f Func[string]? = () -> Maybe()
}`, "Maybe()")
            yield Row("nullable-named-delegate-local", `func Run() {
    let f StringFunc? = () -> Maybe()
}`, "Maybe()")
            yield Row("parenthesized-local-initializer", `func Run() string {
    let f () -> string = (() -> Maybe())
    return f()
}`, "Maybe()")
            yield Row("assignment-to-local", `func Run() string {
    var f () -> string = () -> "ok"
    f = () -> Maybe()
    return f()
}`, "Maybe()")
            yield Row("assignment-parenthesized", `func Run() string {
    var f () -> string = () -> "ok"
    f = (() -> Maybe())
    return f()
}`, "Maybe()")
            yield Row("assignment-to-nullable-delegate", `func Run() {
    var f (() -> string)? = nil
    f = () -> Maybe()
}`, "Maybe()")
            yield Row("assignment-to-field", `func Run(h Holder) {
    h.Callback = () -> Maybe()
}`, "Maybe()")
            yield Row("assignment-to-property", `func Run(h Holder) {
    h.Prop = () -> Maybe()
}`, "Maybe()")
            yield Row("return-statement", `func Run() () -> string {
    return () -> Maybe()
}`, "Maybe()")
            yield Row("return-checked-wrapper", `func Run() () -> string {
    return checked(() -> Maybe())
}`, "Maybe()")
            yield Row("return-unchecked-wrapper", `func Run() () -> string {
    return unchecked(() -> Maybe())
}`, "Maybe()")
            yield Row("cast-arrow-delegate", `func Run() string {
    let f = cast[() -> string](() -> Maybe())
    return f()
}`, "Maybe()")
            yield Row("cast-named-delegate", `func Run() string {
    let f = cast[StringFunc](() -> Maybe())
    return f()
}`, "Maybe()")
            yield Row("return-nullable-delegate", `func Run() (() -> string)? {
    return () -> Maybe()
}`, "Maybe()")
            yield Row("expression-bodied-function-return", `func Run() () -> string -> () -> Maybe()`, "Maybe()")
            yield Row("argument-source-function", `func Run() string -> TakeFunc(() -> Maybe())`, "Maybe()")
            yield Row("argument-clr-func", `func Run() string -> TakeClrFunc(() -> Maybe())`, "Maybe()")
            yield Row("argument-named-delegate", `func Run() string -> TakeNamedDelegate(() -> Maybe())`, "Maybe()")
            yield Row(
                "argument-nullable-delegate",
                `func Run() string -> TakeNullableDelegate(() -> Maybe())`,
                "Maybe()"
            )
            yield Row(
                "argument-imported-strict-method",
                `func Run() string -> StrictSink5686.Take(() -> Maybe())`,
                "Maybe()"
            )
            yield Row(
                "argument-imported-generic-receiver",
                `func Run(b StrictGenericBox5686[Box]) string -> b.Run((x Box) -> Maybe())`,
                "Maybe()"
            )
            yield Row("instance-field-initializer", `class FieldSample {
    var f () -> string = () -> Maybe()
}`, "Maybe()")
            yield Row("static-field-initializer", `class StaticFieldSample {
    shared {
        var f () -> string = () -> Maybe()
    }
}`, "Maybe()")
            yield Row("field-conditional-lambda-initializer", `class C {
    var f () -> string = true ? (() -> Maybe()) : (() -> "ok")
}`, "Maybe()")
            yield Row("shared-field-conditional-lambda-initializer", `class C {
    shared {
        var f () -> string = true ? (() -> Maybe()) : (() -> "ok")
    }
}`, "Maybe()")
            yield Row("interface-static-field-conditional-lambda-initializer", `interface I {
    shared {
        var f () -> string = true ? (() -> Maybe()) : (() -> "ok")
    }
}`, "Maybe()")
            yield Row(
                "imported-generic-receiver-nullable-param-passthrough",
                `func Run(b StrictGenericBox5686[Box]) string -> b.RunWithNullableParam((box, s) -> s)`,
                "s"
            )
            yield Row("slice-element", `func Run() []() -> string -> []() -> string{() -> Maybe()}`, "Maybe()")
            yield Row("map-value", `func Run() {
    let m = map[int32, () -> string]{1: () -> Maybe()}
}`, "Maybe()")
            yield Row("tuple-element", `func Run() {
    let t (() -> string, int32) = (() -> Maybe(), 1)
}`, "Maybe()")
            yield Row("nested-tuple-element", `func Run() {
    let t ((() -> string, int32), int32) = ((() -> Maybe(), 1), 2)
}`, "Maybe()")
            yield Row("conditional-tuple-element", `func Run(c bool) {
    let t (() -> string, int32) = (c ? (() -> Maybe()) : (() -> "ok"), 0)
}`, "Maybe()")
            yield Row("nullable-tuple-local-lambda-element", `func Run() {
    let t (() -> string, int32)? = (() -> Maybe(), 0)
}`, "Maybe()")
            yield Row("nullable-tuple-return-lambda-element", `func Run() {
    let make () -> (() -> string, int32)? = () -> (() -> Maybe(), 0)
}`, "Maybe()")
            yield Row("tuple-conversion-after-narrowing-invalidation", `struct Token {
    shared {
        func operator implicit(t Token) float64 -> 1.0
    }
}
var guardedGlobal string? = "ok"
func Run(token Token) {
    if guardedGlobal != nil {
        let t (float64, () -> string) = (token, () -> Maybe())
    }
}`, "Maybe()")
            yield Row("outer-lambda-tuple-element-capturing-param", `func Run() {
    let f (string?) -> (() -> string, int32) = (x string?) -> (() -> x, 0)
}`, "x")
            yield Row("field-init-int-lambda", `class C {
    var f int32 = () -> 1
}`, "() -> 1")
            yield Row("nullable-delegate-arity-mismatch-fallback", `func Run() {
    let f ((int32, int32) -> string)? = (x int32) -> "ok"
}`, `(x int32) -> "ok"`)
            yield Row("nullable-delegate-incompatible-param-and-return-fallback", `func Run() {
    let f ((int32) -> string)? = (s string) -> Maybe()
}`, `(s string) -> Maybe()`)
            yield Row(
                "imported-annotated-arg-delegate-nonnull-return",
                `func Run() string -> StrictSink5686.TakeArg((x) -> Maybe())`,
                "Maybe()"
            )
            yield Row("object-initializer-member", `func Run() Holder -> Holder{Callback: () -> Maybe()}`, "Maybe()")
            yield Row("conditional-arm", `func Run(c bool) () -> string -> c ? () -> Maybe() : () -> "ok"`, "Maybe()")
            yield Row(
                "if-expression-arm",
                `func Run(c bool) () -> string -> if c { () -> Maybe() } else { () -> "ok" }`,
                "Maybe()"
            )
            yield Row("async-expression-lambda", `func Run() () -> Task[string] -> async () -> Maybe()`, "Maybe()")
            yield Row("nested-expression-lambda", `func Run() () -> () -> string -> () -> () -> Maybe()`, "Maybe()")
            yield Row("parameterized-inferred-lambda", `func Run() (int32) -> string -> (x) -> Maybe()`, "Maybe()")
            yield Row("parameterized-explicit-lambda", `func Run() IntMapFunc -> (x int32) -> Maybe()`, "Maybe()")
            yield Row("gsharp-class-return", `func Run() BoxFunc -> () -> MaybeBox()`, "MaybeBox()")
            yield Row("interface-return", `func Run() () -> IThing -> () -> MaybeThing()`, "MaybeThing()")
            yield Row(
                "value-type-nullable-return",
                `func Run() () -> int32 -> () -> MaybeInt()`,
                "MaybeInt()",
                "GS0156"
            )
            yield Row("nullable-tuple-return", `func Run() (string, int32) {
    let f () -> (string, int32) = () -> MaybePair()
    return f()
}`, "MaybePair()")
            yield Row("tuple-nil-element-return", `func Run() (string, int32) {
    let f () -> (string, int32) = () -> (nil, 1)
    return f()
}`, "(nil, 1)")
            yield Row("nil-literal-return", `func Run() () -> string -> () -> nil`, "nil")
            yield Row("checked-wrapper-local-let", `func Run() string {
    let f () -> string = checked(() -> Maybe())
    return f()
}`, "Maybe()")
            yield Row("unchecked-wrapper-local-let", `func Run() string {
    let f () -> string = unchecked(() -> Maybe())
    return f()
}`, "Maybe()")
            yield Row("checked-wrapper-assignment", `func Run() string {
    var f () -> string = () -> "ok"
    f = checked(() -> Maybe())
    return f()
}`, "Maybe()")
            yield Row("unchecked-wrapper-assignment", `func Run() string {
    var f () -> string = () -> "ok"
    f = unchecked(() -> Maybe())
    return f()
}`, "Maybe()")
            yield Row(
                "checked-wrapper-source-argument",
                `func Run() string -> TakeFunc(checked(() -> Maybe()))`,
                "Maybe()"
            )
            yield Row(
                "unchecked-wrapper-source-argument",
                `func Run() string -> TakeFunc(unchecked(() -> Maybe()))`,
                "Maybe()"
            )
            yield Row(
                "checked-wrapper-imported-argument",
                `func Run() string -> StrictSink5686.Take(checked(() -> Maybe()))`,
                "Maybe()"
            )
            yield Row(
                "unchecked-wrapper-imported-argument",
                `func Run() string -> StrictSink5686.Take(unchecked(() -> Maybe()))`,
                "Maybe()"
            )
            yield Row(
                "nullable-tuple-element-mismatch",
                `func Make() () -> (string, int32)? -> () -> (Maybe(), 0)`,
                "(Maybe(), 0)"
            )
            yield Row(
                "nullable-tuple-value-element-mismatch",
                `func Make() () -> (string, int32)? -> () -> MaybePairElement()`,
                "MaybePairElement()"
            )
            yield Row(
                "nullable-tuple-source-element-mismatch",
                `func Make() () -> (string, int32)? -> () -> MaybeNullablePairElement()`,
                "MaybeNullablePairElement()"
            )
            yield Row(
                "mixed-nullable-tuple-literal-delegate-and-expression-tree-overload",
                `func Run() (string, int32)? -> StrictSink5686.PickNullableTuple(() -> (Maybe(), 0), 1)`,
                "(Maybe(), 0)"
            )
            yield Row(
                "mixed-nullable-tuple-value-delegate-and-expression-tree-overload",
                `func Run() (string, int32)? -> StrictSink5686.PickNullableTuple(() -> MaybePairElement(), 1)`,
                "MaybePairElement()"
            )
            yield Row(
                "mixed-nullable-tuple-source-delegate-and-expression-tree-overload",
                `func Run() (string, int32)? -> StrictSink5686.PickNullableTuple(() -> MaybeNullablePairElement(), 1)`,
                "MaybeNullablePairElement()"
            )
            yield Row(
                "mixed-delegate-and-expression-tree-overload",
                `func Run() string -> StrictSink5686.Pick(() -> Maybe(), 1)`,
                "Maybe()"
            )
            yield Row(
                "mixed-delegate-and-expression-tree-arg-overload",
                `func Run() string -> StrictSink5686.PickArg((x) -> Maybe(), 1)`,
                "Maybe()"
            )
            yield Row(
                "mixed-custom-generic-delegate-and-expression-tree-overload",
                `func Run() string -> StrictSink5686.PickCustomDelegate((x) -> Maybe(), 1)`,
                "Maybe()"
            )
            yield Row(
                "mixed-explicit-param-custom-generic-delegate-and-expression-tree-overload",
                `func Run() string -> StrictSink5686.PickCustomDelegate((x int32) -> Maybe(), 1)`,
                "Maybe()"
            )
            yield Row(
                "mixed-disagreeing-nullability-delegate-and-expression-tree-overload",
                `func Run() string -> StrictSink5686.PickMixedNullability(() -> Maybe(), 1)`,
                "Maybe()"
            )
            yield Row(
                "mixed-delegate-and-params-expression-tree-overload",
                `func Run() string -> StrictSink5686.PickParams(1, () -> Maybe())`,
                "Maybe()"
            )
            yield Row(
                "mixed-custom-delegate-and-params-expression-tree-overload",
                `func Run() string -> StrictSink5686.PickCustomParams(1, (x) -> Maybe())`,
                "Maybe()"
            )
            yield Row(
                "mixed-fixed-and-inferred-tuple-delegate-return",
                `func Run() (string, Box) -> StrictSink5686.UseMixedTuple(Box(), (x) -> (Maybe(), x))`,
                "(Maybe(), x)"
            )
            yield Row(
                "generic-in-scope-mixed-tuple-delegate-return",
                `func Run[T](seed T) (string, T) -> StrictSink5686.UseMixedTuple(seed, (x) -> (Maybe(), x))`,
                "(Maybe(), x)"
            )
            yield Row(
                "explicit-method-type-parameter-return",
                `func Run[T class]() T -> StrictSink5686.Eval[T](() -> MaybeRef[T]())`,
                "MaybeRef[T]()"
            )
            yield Row(
                "generic-receiver-fixed-list-return",
                `func Run[T](b StrictGenericBox5686[T]) List[T] -> b.RunList((x) -> MaybeList[T]())`,
                "MaybeList[T]()"
            )
            yield Row(
                "mixed-object-delegate-and-expression-tree-overload",
                `func Run() object -> StrictSink5686.PickObject(() -> MaybeThing(), 1)`,
                "MaybeThing()",
                "GS0156"
            )
            yield Row(
                "mixed-class-type-param-to-object-delegate-and-expression-tree-overload",
                `func Run[T class]() object -> StrictSink5686.PickObject(() -> MaybeRef[T](), 1)`,
                "MaybeRef[T]()",
                "GS0155"
            )
            yield Row(
                "mixed-class-to-object-delegate-and-expression-tree-overload",
                `func Run() object -> StrictSink5686.PickObject(() -> MaybeBox(), 1)`,
                "MaybeBox()",
                "GS0156"
            )
            yield Row(
                "mixed-base-delegate-and-expression-tree-overload",
                `func Run() Exception -> StrictSink5686.PickException(() -> MaybeArgException(), 1)`,
                "MaybeArgException()",
                "GS0156"
            )
            yield Row(
                "mixed-interface-delegate-and-expression-tree-overload",
                `func Run() IComparable -> StrictSink5686.PickComparable(() -> Maybe(), 1)`,
                "Maybe()",
                "GS0156"
            )
            yield Row(
                "mixed-async-delegate-and-expression-tree-overload",
                `func Run() Task[string] -> StrictSink5686.PickAsync(async () -> Maybe(), 1)`,
                "Maybe()"
            )
            yield Row(
                "mixed-tuple-literal-delegate-and-expression-tree-overload",
                `func Run() (string, int32) -> StrictSink5686.PickTuple(() -> (Maybe(), 0), 1)`,
                "(Maybe(), 0)"
            )
            yield Row(
                "mixed-tuple-value-delegate-and-expression-tree-overload",
                `func Run() (string, int32) -> StrictSink5686.PickTuple(() -> MaybePairElement(), 1)`,
                "MaybePairElement()"
            )
        }

        func AcceptedRows() sequence[[]object] {
            yield AcceptedRow("ok-nullable-arrow-return", `func Run() () -> string? -> () -> Maybe()`)
            yield AcceptedRow("ok-nullable-clr-func-return", `func Run() Func[string?] -> () -> Maybe()`)
            yield AcceptedRow("ok-nullable-named-delegate-return", `func Run() NullableStringFunc -> () -> Maybe()`)
            yield AcceptedRow("ok-nullable-nil-return", `func Run() () -> string? -> () -> nil`)
            yield AcceptedRow("ok-nullable-tuple-nil-return", `func Run() () -> (string, int32)? -> () -> nil`)
            yield AcceptedRow("ok-nonnull-return", `func Run() () -> string -> () -> "ok"`)
            yield AcceptedRow("ok-nonnull-into-nullable-return", `func Run() () -> string? -> () -> "ok"`)
            yield AcceptedRow(
                "ok-platform-return-into-nonnull",
                `func Run() () -> string -> () -> ObliviousSink5686.Get()`
            )
            yield AcceptedRow(
                "ok-oblivious-delegate-parameter",
                `func Run(b ObliviousGenericBox5686[Box]) string -> b.Run((x Box) -> Maybe())`
            )
            yield AcceptedRow(
                "ok-oblivious-expression-tree-parameter",
                `func Run(b ObliviousGenericBox5686[Box]) -> b.Index((x Box) -> x.MaybeName)`
            )
            yield AcceptedRow(
                "ok-imported-nullable-generic-receiver",
                `func Run(b StrictGenericBox5686[Box]) string? -> b.RunNullable((x Box) -> Maybe())`
            )
            yield AcceptedRow(
                "ok-linq-thenby-inferred-key",
                `func Run(xs []Box) []IGrouping[int32, Box] -> xs.GroupBy((x Box) -> x.Value).OrderByDescending((g IGrouping[int32, Box]) -> g.Count()).ThenBy((g IGrouping[int32, Box]) -> g.Min((x Box) -> x.ToString()), StringComparer.Ordinal).ToArray()`
            )
            yield AcceptedRow("ok-field-init-object-lambda", `class C {
    var f object = () -> 1
    var d Delegate = () -> 1
}`)
            yield AcceptedRow("ok-outer-lambda-tuple-capturing-param", `func Run() {
    let f (int32) -> (() -> int64, int32) = (x int32) -> (() -> x, 0)
    let g (int32) -> (() -> int64, int32) = (x int32) -> {
        return (() -> x, 0)
    }
}`)
            yield AcceptedRow("ok-imported-annotated-nullable-delegate", `func CheckInferred[T class]() T? -> StrictSink5686.Eval(() -> MaybeRef[T]())
func Run() string? {
    let a = StrictSink5686.TakeNullable(() -> Maybe())
    let b = StrictSink5686.TakeNullableArg((x) -> Maybe())
    let c = StrictSink5686.TakeNullableExpression(() -> Box().MaybeName)
    let d = StrictSink5686.Eval(() -> Maybe())
    let e = StrictSink5686.PickNullableCustomDelegate((x) -> Maybe(), 1)
    let f = StrictSink5686.PickNullableCustomDelegate((x) -> Box().MaybeName, true)
    let g = StrictSink5686.UseMixedTuple(MaybeBox(), (x) -> ("ok", x))
    let h = CheckInferred[string]()
    return a ?? b ?? c ?? d ?? e ?? f ?? g.Item1 ?? h
}`)
            yield AcceptedRow("ok-fixed-expression-tree-return", `class StaticTree5686 {
    var TakeField (Expression[Func[int32, string]]) -> string? = (e Expression[Func[int32, string]]) -> e.Compile()(1)
    shared {
        func Take(e Expression[Func[int32, string]]) string? -> e.Compile()(1)
        func TakeInt(e Expression[Func[int32, int32]]) int32 -> e.Compile()(1)
    }
}
func TakeLocalExpression(e Expression[Func[int32, string]]) string? -> e.Compile()(1)
func Run() string? {
    let e Expression[Func[string]] = () -> Box().MaybeName
    let p = StrictSink5686.TakeExpression(() -> Box().MaybeName)
    let q = StrictSink5686.TakeExpressionArg((x) -> Box().MaybeName)
    let r = TakeLocalExpression((x) -> Box().MaybeName)
    let s = StrictSink5686.Pick(() -> Box().MaybeName, true)
    let t = StrictSink5686.PickArg((x) -> Box().MaybeName, true)
    let u = StrictSink5686.PickExpressionOrInt(() -> Box().MaybeName, 1)
    let v = StrictSink5686.PickCustomDelegate((x int32) -> Box().MaybeName, true)
    let w = StrictSink5686.PickMixedNullability(() -> Box().MaybeName, true)
    let x = StrictSink5686.PickParams(true, () -> Box().MaybeName)
    let y = StrictSink5686.PickCustomParams(true, (a int32) -> Box().MaybeName)
    let z1 = StaticTree5686.Take((a) -> Box().MaybeName)
    let z2 = StaticTree5686.Take(checked((a) -> Box().MaybeName))
    let _ = StaticTree5686.TakeInt(checked((a) -> a))
    let z3 = StaticTree5686().TakeField((a) -> Box().MaybeName)
    return e.Compile()() ?? p ?? q ?? r ?? s ?? t ?? u ?? v ?? w ?? x ?? y ?? z1 ?? z2 ?? z3
}`)
            yield AcceptedRow("ok-issue-5883-nullable-delegate-user-defined-return-conversion", `class Node5883 {
    var Id int32 = 1
}
class Other5883 {}
data struct Card5883 {
    var Id int32 = 2
    func Build() Node5883 -> Node5883{Id: Id}
    func operator implicit (c Card5883) Node5883 -> c.Build()
}
data struct Shell5883 {
    var Make Func[Node5883]?
}
func Pick5883(f Func[Node5883]?) int32 -> f!!().Id
func Pick5883(f Func[Other5883]?) int32 -> 0
func PickAction5883(f Func[Node5883]?) int32 -> f!!().Id
func PickAction5883(f Action?) int32 -> 0
func Run() int32 {
    let a = Shell5883{Make: () -> Card5883{Id: 3}}
    let b = Shell5883{Make: () -> { return Card5883{Id: 4} }}
    let fallback Func[Node5883]? = nil
    var s = Shell5883{}
    s.Make = (() -> Card5883{Id: 5}) ?? fallback
    s.Make = (true ? (() -> Card5883{Id: 6}) : nil)
    let c = Shell5883{Make: (() -> Card5883{Id: 7}) ?? fallback}
    let d = Shell5883{Make: fallback ?? (() -> Card5883{Id: 8})}
    return a.Make!!().Id + b.Make!!().Id + s.Make!!().Id + c.Make!!().Id + d.Make!!().Id + Pick5883(() -> Card5883{Id: 9}) + PickAction5883(() -> { return Card5883{Id: 10} })
}`)
        }

        private func Row(
            name string,
            snippet string,
            expectedSnippet string,
            expectedId string = "GS0155"
        )[]object -> []object{name, Prelude + "\n" + snippet, expectedSnippet, expectedId}

        private func AcceptedRow(name string, snippet string)[]object -> []object{name, Prelude + "\n" + snippet}

        private let LibraryPath string = EmitLibrary()

        private func GetErrors(source string) ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic] {
            using let resolver = ReferenceResolver.WithReferences([]string{LibraryPath})
            let tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(source))
            let compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, tree)
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
                .ToImmutableArray()
        }

        private func Describe(diagnostics ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic]) string -> string.Join(
            "; ",
            diagnostics.Select(
                (
                    d GSharp.Core.CodeAnalysis.Diagnostic
                ) -> "${d.Id}@${d.Location.StartLine}:${d.Location.StartCharacter}: ${d.Message}"
            )
        )

        private func EmitLibrary() string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue5686Binding")
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "Lib5686_v17.dll")
            const csharpSource = `#nullable enable
using System;
using System.Collections.Generic;
using System.Linq.Expressions;
using System.Threading.Tasks;

namespace Lib5686
{
    public delegate string StrictDelegate5686();
    public delegate T CustomGenericDelegate5686<T>(int x);

    public static class StrictSink5686
    {
        public static string Take(Func<string> f) => f();
        public static string TakeArg(Func<int, string> f) => f(1);
        public static T Eval<T>(Func<T> f) => f();
        public static (string, T) UseMixedTuple<T>(T seed, Func<T, (string, T)> f) => f(seed);
        public static string? TakeExpression(Expression<Func<string>> f) => f.Compile()();
        public static string? TakeExpressionArg(Expression<Func<int, string>> f) => f.Compile()(1);
        public static string Pick(Func<string> f, int n) => f();
        public static string? Pick(Expression<Func<string>> f, bool b) => f.Compile()();
        public static string PickParams(int n, Func<string> f) => f();
        public static string? PickParams(bool b, params Expression<Func<string>>[] fs) => fs[0].Compile()();
        public static string PickCustomParams(int n, CustomGenericDelegate5686<string> f) => f(n);
        public static string? PickCustomParams(bool b, params Expression<CustomGenericDelegate5686<string>>[] fs) => fs[0].Compile()(1);
        public static string PickMixedNullability(Func<string> f, int n) => f();
        public static string? PickMixedNullability(Expression<Func<string?>> f, bool b) => f.Compile()();
        public static string PickCustomDelegate(CustomGenericDelegate5686<string> f, int n) => f(n);
        public static string? PickCustomDelegate(Expression<CustomGenericDelegate5686<string>> f, bool b) => f.Compile()(1);
        public static string? PickNullableCustomDelegate(CustomGenericDelegate5686<string?> f, int n) => f(n);
        public static string? PickNullableCustomDelegate(Expression<CustomGenericDelegate5686<string?>> f, bool b) => f.Compile()(1);
        public static object PickObject(Func<object> f, int n) => f();
        public static object? PickObject(Expression<Func<object>> f, bool b) => f.Compile()();
        public static Exception PickException(Func<Exception> f, int n) => f();
        public static Exception? PickException(Expression<Func<Exception>> f, bool b) => f.Compile()();
        public static IComparable PickComparable(Func<IComparable> f, int n) => f();
        public static IComparable? PickComparable(Expression<Func<IComparable>> f, bool b) => f.Compile()();
        public static Task<string> PickAsync(Func<Task<string>> f, int n) => f();
        public static Task<string>? PickAsync(Expression<Func<Task<string>>> f, bool b) => f.Compile()();
        public static (string, int) PickTuple(Func<(string, int)> f, int n) => f();
        public static (string, int) PickTuple(Expression<Func<(string, int)>> f, bool b) => f.Compile()();
        public static (string, int)? PickNullableTuple(Func<(string, int)?> f, int n) => f();
        public static (string, int)? PickNullableTuple(Expression<Func<(string, int)?>> f, bool b) => f.Compile()();
        public static (Exception, int) PickExceptionTuple(Func<(Exception, int)> f, int n) => f();
        public static (Exception, int) PickExceptionTuple(Expression<Func<(Exception, int)>> f, bool b) => f.Compile()();
        public static string? PickExpressionOrInt(Expression<Func<string>> f, int n) => f.Compile()();
        public static string? PickExpressionOrInt(int f, bool b) => null;
        public static string PickArg(Func<int, string> f, int n) => f(n);
        public static string? PickArg(Expression<Func<int, string>> f, bool b) => f.Compile()(1);
        public static string? TakeNullable(Func<string?> f) => f();
        public static string? TakeNullableArg(Func<int, string?> f) => f(1);
        public static string? TakeNullableExpression(Expression<Func<string?>> f) => f.Compile()();
    }

    public class StrictGenericBox5686<T>
    {
        public string Run(Func<T, string> f) => "";
        public string? RunNullable(Func<T, string?> f) => null;
        public string RunWithNullableParam(Func<T, string?, string> f) => "";
        public List<T> RunList(Func<T, List<T>> f) => new List<T>();
    }
}

#nullable disable
namespace Lib5686
{
    public static class ObliviousSink5686
    {
        public static string Get() => "oblivious";
    }

    public class ObliviousGenericBox5686<T>
    {
        public string Run(Func<T, string> f) => "";
        public void Index(Expression<Func<T, string>> f) { }
    }
}`
            let syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, CSharpParseOptions(LanguageVersion.Latest))
            let referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(
                Path.PathSeparator
            ) ??
                Array.Empty[string]()
            let references = referencePaths
                .Where(File.Exists)
                .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
            let compilation = CSharpCompilation.Create(
                "Lib5686",
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            {
                using let peStream = File.Create(libraryPath)
                let emitResult = compilation.Emit(peStream)
                Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            }
            return libraryPath
        }
    }
}
