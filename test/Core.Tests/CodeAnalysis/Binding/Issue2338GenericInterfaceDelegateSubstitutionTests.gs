// <copyright file="Issue2338GenericInterfaceDelegateSubstitutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #2338 follow-up: (cref:InterfaceSymbol)'s construction-time
/// substitution helper (`InterfaceSymbol.SubstituteType`, the sibling of
/// (cref:Binder)'s own `SubstituteType` and
/// `StructSymbol.SubstituteTypeForConstruction`) had no case for
/// (cref:DelegateTypeSymbol) (nor (cref:StructSymbol)). A
/// constructed generic interface's method whose return or parameter type was
/// a named delegate — or a plain generic struct/class — over the
/// interface's own type parameter kept exposing the still-open definition
/// type (e.g. `Getter[T]` instead of `Getter[int32]`), which made
/// signature matching against the implementing class's closed type
/// incorrectly fail, misreporting a false-negative GS0187 ("does not
/// implement interface method") for a genuinely correct implementation.
///
/// A second, independent gap in the same area: `InterfaceSymbol`'s
/// per-method substitution (`SubstituteMethod`) never copied the
/// original method's own (method-level) generic type parameters onto the
/// constructed method, so a constructed generic interface's generic method
/// silently lost its arity — causing
/// `DeclarationBinder.TryBuildMethodTypeParameterMap` to see a bogus
/// arity mismatch against any implementation, rejecting it before signature
/// comparison ever ran.
///
/// A third, independent gap: `DeclarationBinder.TypeSignaturesEquivalent`
/// had no case for (cref:DelegateTypeSymbol), so a named delegate
/// constructed over a *method-level* generic parameter (not fixed by
/// substituting the interface's own type arguments) still failed to compare
/// as equivalent to the implementer's own delegate instantiation.
///
/// All three fixes are exercised together here purely at the binder level
/// (no emit/ILVerify); see
/// `Issue2338GenericInterfaceDelegateSubstitutionEmitTests` for the
/// compile + ILVerify + run coverage.
open class Issue2338GenericInterfaceDelegateSubstitutionTests {
    @Fact
    func GenericInterfaceReturningNamedDelegateOverOwnTypeParameter_ImplementationBindsCleanly() {
        const source = `package t
delegate Getter[T any]() T;
interface IFactory[T any] { func Make() Getter[T]; }
class Concrete : IFactory[int32] {
    func Make() Getter[int32] { return func() int32 { return 42 } }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func GenericInterfaceReturningNamedDelegate_ConstructedInterfaceMethodExposesClosedDelegateType() {
        const source = `package t
delegate Getter[T any]() T;
interface IFactory[T any] { func Make() Getter[T]; }
class Concrete : IFactory[int32] {
    func Make() Getter[int32] { return func() int32 { return 42 } }
}`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let structSymbol = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Concrete")
        let constructedIface = structSymbol.Interfaces.Single(
            (i InterfaceSymbol) -> i.Name.StartsWith("IFactory", StringComparison.Ordinal)
        )
        let imethod = constructedIface.Methods.Single((m FunctionSymbol) -> m.Name == "Make")
        // Before the fix this stayed the open `Getter[T]` definition; it must
        // now be the closed `Getter[int32]` instantiation.
        let delegateReturn = Assert.IsType[DelegateTypeSymbol](imethod.Type)
        Assert.False(delegateReturn.TypeArguments.IsDefaultOrEmpty)
        Assert.Same(TypeSymbol.Int32, delegateReturn.TypeArguments[0])
    }

    @Fact
    func GenericInterfaceAcceptingNamedDelegateOverOwnTypeParameter_ImplementationBindsCleanly() {
        const source = `package t
delegate Consumer[T any](item T) void;
interface ISink[T any] { func Accept(c Consumer[T]) void; }
class ConcreteSink : ISink[int32] {
    func Accept(c Consumer[int32]) void { c.Invoke(1) }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func GenericInterfaceReturningPlainGenericClass_ImplementationBindsCleanly() {
        const source = `package t
class Box[T any](Value T)
interface IFactory[T any] { func Make() Box[T]; }
class Concrete : IFactory[int32] {
    func Make() Box[int32] { return Box[int32](1) }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func NonGenericInterfaceWithMethodLevelGenericReturningNamedDelegate_ImplementationBindsCleanly() {
        const source = `package t
delegate Getter[T any]() T;
interface IFactory { func Make[T](seed T) Getter[T]; }
class Concrete : IFactory {
    func Make[T](seed T) Getter[T] { return func() T { return seed } }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func GenericInterfaceMethodOnConstructedInterface_PreservesMethodLevelTypeParameterArity() {
        const source = `package t
delegate Combiner[A any, B any](item A) B;
interface ITransformer[TIn any] { func Transform[TOut](conv Combiner[TIn, TOut]) TOut; }
class Concrete : ITransformer[int32] {
    func Transform[TOut](conv Combiner[int32, TOut]) TOut { return conv.Invoke(1) }
}`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let structSymbol = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Concrete")
        let constructedIface = structSymbol.Interfaces.Single(
            (i InterfaceSymbol) -> i.Name.StartsWith("ITransformer", StringComparison.Ordinal)
        )
        let imethod = constructedIface.Methods.Single((m FunctionSymbol) -> m.Name == "Transform")
        // Before the fix, SubstituteMethod dropped the method's own
        // (method-level) generic type parameters entirely.
        Assert.True(imethod.IsGeneric)
        Assert.Single(imethod.TypeParameters)
        Assert.Equal("TOut", imethod.TypeParameters[0].Name)
    }

    @Fact
    func CombinedInterfaceLevelAndMethodLevelGenericsOverMultiParamDelegate_ImplementationBindsCleanly() {
        const source = `package t
delegate Combiner[A any, B any](item A) B;
interface ITransformer[TIn any] { func Transform[TOut](conv Combiner[TIn, TOut]) TOut; }
class Concrete : ITransformer[int32] {
    func Transform[TOut](conv Combiner[int32, TOut]) TOut { return conv.Invoke(1) }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func GenericClassImplementingGenericInterfaceWithCombinedGenericsOverDelegate_BindsCleanly() {
        // Containing-type generics: the implementing class is itself generic
        // (class-level TIn, not yet a concrete type at the class declaration)
        // combined with a method-level type parameter (TOut) inside the same
        // delegate signature.
        const source = `package t
delegate Combiner[A any, B any](item A) B;
interface ITransformer[TIn any] { func Transform[TOut](conv Combiner[TIn, TOut]) TOut; }
class GenericConcrete[TIn any](Seed TIn) : ITransformer[TIn] {
    func Transform[TOut](conv Combiner[TIn, TOut]) TOut { return conv.Invoke(Seed) }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func NestedGenericDelegateSignature_ImplementationBindsCleanly() {
        // The delegate's own type argument is itself a constructed generic
        // class over the interface's type parameter: Getter[Box[T]].
        const source = `package t
class Box[T any](Value T)
delegate Getter[T any]() T;
interface IFactory[T any] { func Make() Getter[Box[T]]; }
class Concrete : IFactory[int32] {
    func Make() Getter[Box[int32]] { return func() Box[int32] { return Box[int32](1) } }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func MismatchedDelegateTypeArgument_StillReportsGS0187() {
        const source = `package t
delegate Getter[T any]() T;
interface IFactory[T any] { func Make() Getter[T]; }
class WrongConcrete : IFactory[int32] {
    func Make() Getter[string] { return func() string { return "oops" } }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0187")
    }

    @Fact
    func DifferentNamedDelegateType_StillReportsGS0187() {
        const source = `package t
delegate Getter[T any]() T;
delegate Setter[T any](value T) void;
interface IFactory { func Make[T](seed T) Getter[T]; }
class WrongConcrete : IFactory {
    func Make[T](seed T) Setter[T] { return func(value T) void { } }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0187")
    }

    @Fact
    func GenuineMethodLevelArityMismatchOnConstructedInterface_StillReportsGS0187() {
        const source = `package t
delegate Combiner[A any, B any](item A) B;
interface ITransformer[TIn any] { func Transform[TOut](conv Combiner[TIn, TOut]) TOut; }
class WrongArity : ITransformer[int32] {
    func Transform[TOut, TExtra](conv Combiner[int32, TOut]) TOut { return conv.Invoke(1) }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0187")
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.GlobalScope.Diagnostics.ToList()
        }
    }
}
