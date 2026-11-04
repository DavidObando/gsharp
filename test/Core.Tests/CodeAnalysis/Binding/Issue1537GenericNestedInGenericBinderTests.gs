// <copyright file="Issue1537GenericNestedInGenericBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1537: member access on a <b>generic</b> type nested inside a
/// <b>generic</b> type, constructed externally through the per-segment
/// type-clause syntax (`Outer[int32].Middle[string]`), failed at bind time
/// with `GS0159 Cannot find function` because the produced
/// (cref:StructSymbol) did not expose members whose signatures substitute
/// BOTH the enclosing type arguments (`U → int32`) and the nested type's
/// own arguments (`T → string`).
///
/// These tests assert the resolution binds without diagnostics AND that the
/// member types are substituted correctly: a function whose declared return
/// type equals the expected substituted member type only binds cleanly when the
/// substitution is correct (a wrong substitution surfaces a conversion
/// diagnostic). Symbol-level assertions confirm the constructed nested symbol
/// carries the enclosing arguments separately from its own arguments.
///
/// Each test uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed and not cleared between tests.
open class Issue1537GenericNestedInGenericBinderTests {
    @Fact
    func BaseRepro_MemberAccessOnGenericNestedInGeneric_BindsWithoutGs0159() {
        // The verbatim issue repro: before the fix this reported
        // `GS0159 Cannot find function Hello` (and a cascade for WriteLine).
        let diagnostics = GetDiagnostics(`package Issue1537BinderBase
import System
struct Issue1537BOuter[U any] {
    struct Issue1537BMiddle[T any] {
        var Label string
        func Hello() string { return "hi" }
    }
}
func Main() {
    var m = Issue1537BOuter[int32].Issue1537BMiddle[string]{Label: "x"}
    System.Console.WriteLine(m.Hello())
    System.Console.WriteLine(m.Label)
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func OwnTypeArgument_SubstitutesToConcreteType() {
        // The nested type's OWN parameter `T` must surface as `string` on the
        // construction: a field typed `T` read into a `string` return only
        // binds cleanly when `T → string`.
        let diagnostics = GetDiagnostics(`package Issue1537BinderOwn
struct Issue1537OwnOuter[U any] {
    struct Issue1537OwnMiddle[T any] {
        var Own T
    }
}
func GetOwn(m Issue1537OwnOuter[int32].Issue1537OwnMiddle[string]) string {
    return m.Own
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func EnclosingTypeArgument_SubstitutesToConcreteType() {
        // The ENCLOSING parameter `U` referenced by a nested member must surface
        // as `int32` on the construction: a field typed `U` read into an `int32`
        // return only binds cleanly when `U → int32` (a wrong `U → object`
        // substitution would report a conversion diagnostic).
        let diagnostics = GetDiagnostics(`package Issue1537BinderEnclosing
struct Issue1537EncOuter[U any] {
    struct Issue1537EncMiddle[T any] {
        var FromU U
        func Combine() U { return FromU }
    }
}
func GetFromU(m Issue1537EncOuter[int32].Issue1537EncMiddle[string]) int32 {
    return m.FromU
}
func GetCombine(m Issue1537EncOuter[int32].Issue1537EncMiddle[string]) int32 {
    return m.Combine()
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func MultiArityAtEachLevel_BindsWithoutDiagnostics() {
        let diagnostics = GetDiagnostics(`package Issue1537BinderMultiArity
struct Issue1537MAOuter[A any, B any] {
    struct Issue1537MAMiddle[C any, D any] {
        var First A
        var Third C
    }
}
func GetFirst(m Issue1537MAOuter[int32, bool].Issue1537MAMiddle[string, int64]) int32 {
    return m.First
}
func GetThird(m Issue1537MAOuter[int32, bool].Issue1537MAMiddle[string, int64]) string {
    return m.Third
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func TripleNesting_GenericInnermost_BindsWithoutDiagnostics() {
        let diagnostics = GetDiagnostics(`package Issue1537BinderTriple
struct Issue1537TOuter[U any] {
    struct Issue1537TMiddle[T any] {
        struct Issue1537TInner[W any] {
            var FromU U
            var FromT T
            var Own W
        }
    }
}
func GetU(i Issue1537TOuter[int32].Issue1537TMiddle[string].Issue1537TInner[bool]) int32 {
    return i.FromU
}
func GetT(i Issue1537TOuter[int32].Issue1537TMiddle[string].Issue1537TInner[bool]) string {
    return i.FromT
}
func GetOwn(i Issue1537TOuter[int32].Issue1537TMiddle[string].Issue1537TInner[bool]) bool {
    return i.Own
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Issue1521NonOwnParamsGuard_StillBindsWithoutDiagnostics() {
        // Guard: the #1521 case (a NON-generic nested type of a generic) must
        // keep binding — the #1537 combined-vector threading must not regress
        // the enclosing-only path.
        let diagnostics = GetDiagnostics(`package Issue1537BinderGuard
struct Issue1537GBox[T any] {
    var Value T
    struct Issue1537GTag { var Name string }
}
func GrabName(t Issue1537GBox[int32].Issue1537GTag) string {
    return t.Name
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func DeepestSegment_CarriesEnclosingAndOwnArguments() {
        // Symbol-level assertion: the constructed deepest segment
        // (`Outer[int32].Middle[string]`) is a constructed-nested reference that
        // carries the enclosing argument (`int32`) on EnclosingTypeArguments AND
        // its own argument (`string`) on TypeArguments, sharing the open nested
        // definition and the open enclosing type as its ContainingType.
        let scope_ = BindGlobalScope(`package Issue1537BinderSymbol
struct Issue1537SOuter[U any] {
    struct Issue1537SMiddle[T any] {
        var Own T
        var FromU U
    }
}
func Use(m Issue1537SOuter[int32].Issue1537SMiddle[string]) { }`)
        Assert.Empty(scope_.Diagnostics)
        let use = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "Use")
        let paramStruct = Assert.IsType[StructSymbol](use.Parameters.Single().Type)
        Assert.True(paramStruct.IsConstructedNestedType)
        Assert.Equal("Issue1537SMiddle", paramStruct.Name)
        let enclosingArg = Assert.Single(paramStruct.EnclosingTypeArguments)
        Assert.Equal("int32", enclosingArg.Name)
        let ownArg = Assert.Single(paramStruct.TypeArguments)
        Assert.Equal("string", ownArg.Name)
    }

    @Fact
    func Issue4750_ClosedEnclosingGenericNestedClass_RejectsMismatchedOrOpenEnclosingTypeArguments() {
        let mismatchedDiagnostics = GetDiagnostics(`package Issue4750BinderMismatch
class Issue4750MOuter[T] {
    class Issue4750MInner { }
    func RunOpen() int32 -> Issue4750MProbe.Consume(Issue4750MInner())
}
class Issue4750MProbe {
    shared {
        func Consume(value Issue4750MOuter[int32].Issue4750MInner) int32 -> 42
        func RunMismatch() int32 -> Issue4750MProbe.Consume(Issue4750MOuter[string].Issue4750MInner())
    }
}`)
        let errors = mismatchedDiagnostics.Where((d Diagnostic) -> d.IsError).ToArray()
        Assert.Equal(2, errors.Length)
        Assert.All(errors, (d Diagnostic) -> Assert.Equal("GS0154", d.Id))

        let unclosedOutsideOwnerDiagnostics = GetDiagnostics(`package Issue4774BinderUnclosed
class Outer[T] {
    public struct Inner(Value int32) {
        private var Seed int32 = 5
        public func Read() int32 -> Seed
    }
}
func BadUnqualifiedLiteral() {
    let item = Inner{Value: 7}
}
func BadUnconstructedOuterLiteral() {
    let item = Outer.Inner{Value: 7}
}
func BadUnqualifiedTypeClause(item Inner) { }
func BadUnconstructedOuterTypeClause(item Outer.Inner) { }
open class Base[T] {
    public struct InheritedInner { }
}
class Derived[U] : Base[U] { }
func BadInheritedTypeClause(item Derived.InheritedInner) { }
func BadInheritedLiteral() {
    let item = Derived.InheritedInner{}
}
class InterfaceOwner[T] {
    public interface I[U] { }
}
func BadNestedInterfaceOwnerMismatch(x InterfaceOwner[string].I[int32]) InterfaceOwner[int32].I[int32] -> x`)
        let unclosedErrors = unclosedOutsideOwnerDiagnostics.Where((d Diagnostic) -> d.IsError).ToArray()
        Assert.Equal(7, unclosedErrors.Length)
        Assert.Equal(3, unclosedErrors.Count((d Diagnostic) -> d.Id == "GS0157"))
        Assert.Equal(3, unclosedErrors.Count((d Diagnostic) -> d.Id == "GS0113"))
        Assert.Equal(1, unclosedErrors.Count((d Diagnostic) -> d.Id == "GS0156"))

        let validScopedAndConstructedDiagnostics = GetDiagnostics(`package Issue4774BinderValid
class Outer[T] {
    public struct Inner(Value int32) {
        private var Seed int32 = 5
        public func Read() int32 -> Seed + Value
    }
    public interface IPlain {
        func Echo(v T) T;
    }
    public interface IGeneric[U] {
        func Combine(a T, b U) string;
    }
    public func Inside() int32 {
        let item = Inner{Value: 7}
        return item.Read()
    }
}
open class Base[T] {
    public struct InheritedInner(Value int32) {
        public func Read() int32 -> Value
    }
}
class Derived[U] : Base[U] {
    public func InsideDerived() int32 {
        let item = Derived.InheritedInner{Value: 11}
        return item.Read()
    }
}
func Outside(plain Outer[string].IPlain, generic Outer[int32].IGeneric[string], inherited Derived[int32].InheritedInner) string {
    let item = Outer[string].Inner{Value: 7}
    return plain.Echo("ok") + ":" + generic.Combine(item.Read(), "x") + ":" + inherited.Read().ToString()
}`)
        Assert.Empty(validScopedAndConstructedDiagnostics)

        let derivedMismatchDiagnostics = GetDiagnostics(`package Issue4750BinderDerivedMismatch
class Issue4750DOuter[T] {
    open class Issue4750DInner { }
}
class Issue4750DSub : Issue4750DOuter[int32].Issue4750DInner { }
func AcceptGood(v Issue4750DSub) Issue4750DOuter[int32].Issue4750DInner -> v
func AcceptBad(v Issue4750DSub) Issue4750DOuter[string].Issue4750DInner -> v`)
        let derivedError = Assert.Single(derivedMismatchDiagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("GS0155", derivedError.Id)

        let siblingUpcastGoodDiagnostics = GetDiagnostics(`package Issue4750BinderSiblingUpcastGood
class Issue4750SliceGoodOuter[T] {
    open class Base { }
    class Derived : Base { }
    shared {
        func UpcastGood(value Issue4750SliceGoodOuter[[]T].Derived) Issue4750SliceGoodOuter[[]T].Base -> value
    }
}`)
        Assert.Empty(siblingUpcastGoodDiagnostics)

        let siblingUpcastBadDiagnostics = GetDiagnostics(`package Issue4750BinderSiblingUpcastBad
class Issue4750SliceBadOuter[T] {
    open class Base { }
    class Derived : Base { }
    shared {
        func UpcastBad(value Issue4750SliceBadOuter[[]T].Derived) Issue4750SliceBadOuter[[][]T].Base -> value
    }
}`)
        let siblingError = Assert.Single(siblingUpcastBadDiagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("GS0155", siblingError.Id)

        let openOwnerInferenceDiagnostics = GetDiagnostics(`package Issue4750BinderOpenOwnerInference
class Issue4750OpenOuter[T] {
    class Inner {
        shared {
            func InnerPick[U](x Issue4750OpenOuter[T].Inner, seed U) T -> default(T)
        }
    }
    shared {
        func Pick[U](x Issue4750OpenOuter[T].Inner, seed U) T -> default(T)
        func BadOuterQualified() int32 -> Issue4750OpenOuter.Pick(Issue4750OpenOuter[int32].Inner(), 0)
        func BadInnerQualified() int32 -> Inner.InnerPick(Issue4750OpenOuter[int32].Inner(), 0)
        func BadBare() int32 -> Pick(Issue4750OpenOuter[int32].Inner(), 0)
    }
}`)
        let openOwnerErrors = openOwnerInferenceDiagnostics.Where((d Diagnostic) -> d.IsError).ToArray()
        Assert.Equal(3, openOwnerErrors.Count((d Diagnostic) -> d.Id == "GS0154"))
        Assert.Equal(3, openOwnerErrors.Count((d Diagnostic) -> d.Id == "GS0155"))

        let nullableSlotDiagnostics = GetDiagnostics(`package Issue4750BinderNullableSlotMismatch
class Issue4750NullBox[T](Value T) { }
class Issue4750NullOuter[T] {
    class Inner(Value T) { }
    class PlainInner { }
}
func BadBox(x Issue4750NullBox[string?]) Issue4750NullBox[string] -> x
func BadNested(x Issue4750NullOuter[string?].Inner) Issue4750NullOuter[string].Inner -> x
func BadPlainNested(x Issue4750NullOuter[string?].PlainInner) Issue4750NullOuter[string].PlainInner -> x`)
        let nullableSlotErrors = nullableSlotDiagnostics.Where((d Diagnostic) -> d.IsError).ToArray()
        Assert.Equal(3, nullableSlotErrors.Length)
        Assert.Equal(2, nullableSlotErrors.Count((d Diagnostic) -> d.Id == "GS0490"))
        Assert.Equal(1, nullableSlotErrors.Count((d Diagnostic) -> d.Id == "GS0155"))
    }

    @Fact
    func Issue4750_ClosedEnclosingGenericNestedClass_StaticMethodAndGenericInference_PreservesEnclosingArguments() {
        let diagnostics = GetDiagnostics(`package Issue4750BinderStaticAndInference
class Issue4750SOuter[T] {
    class Issue4750SInner {
        shared {
            func Create() Issue4750SInner -> Issue4750SInner()
            func Echo(value T) T -> value
        }
    }
}
class Issue4750SProbe {
    shared {
        private func Consume(value Issue4750SOuter[int32].Issue4750SInner) int32 -> 40
        private func InferEnclosing[U](value Issue4750SOuter[U].Issue4750SInner, seed U) U -> seed
        func Run() int32 {
            let created = Issue4750SOuter[int32].Issue4750SInner.Create()
            let echoed = Issue4750SOuter[int32].Issue4750SInner.Echo(2)
            let inferred = Issue4750SProbe.InferEnclosing(Issue4750SOuter[int32].Issue4750SInner(), echoed)
            return Issue4750SProbe.Consume(created) + inferred
        }
    }
}`)
        Assert.Empty(diagnostics)

        let topLevelInheritedNestedDiagnostics = GetDiagnostics(`package Issue4750BinderTopLevelInheritedNested
open class Issue4750TopBase[U] {
    class N(Tag U) { }
}
class Issue4750TopOuter[T] {
    class Derived[V] : Issue4750TopBase[V] { }
}
func ConvertToBase(value Issue4750TopOuter[int32].Derived[string].N) Issue4750TopBase[string].N -> value
func ConvertFromBase(value Issue4750TopBase[string].N) Issue4750TopOuter[int32].Derived[string].N -> value`)
        Assert.Empty(topLevelInheritedNestedDiagnostics)
    }

    shared {
        private func GetDiagnostics(source string) IReadOnlyList[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics
        }

        private func BindGlobalScope(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }
    }
}
