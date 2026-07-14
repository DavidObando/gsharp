// <copyright file="Issue2338GenericInterfaceDelegateSubstitutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2338 follow-up: <see cref="InterfaceSymbol"/>'s construction-time
/// substitution helper (<c>InterfaceSymbol.SubstituteType</c>, the sibling of
/// <see cref="Binder"/>'s own <c>SubstituteType</c> and
/// <c>StructSymbol.SubstituteTypeForConstruction</c>) had no case for
/// <see cref="DelegateTypeSymbol"/> (nor <see cref="StructSymbol"/>). A
/// constructed generic interface's method whose return or parameter type was
/// a named delegate — or a plain generic struct/class — over the
/// interface's own type parameter kept exposing the still-open definition
/// type (e.g. <c>Getter[T]</c> instead of <c>Getter[int32]</c>), which made
/// signature matching against the implementing class's closed type
/// incorrectly fail, misreporting a false-negative GS0187 ("does not
/// implement interface method") for a genuinely correct implementation.
///
/// A second, independent gap in the same area: <c>InterfaceSymbol</c>'s
/// per-method substitution (<c>SubstituteMethod</c>) never copied the
/// original method's own (method-level) generic type parameters onto the
/// constructed method, so a constructed generic interface's generic method
/// silently lost its arity — causing
/// <c>DeclarationBinder.TryBuildMethodTypeParameterMap</c> to see a bogus
/// arity mismatch against any implementation, rejecting it before signature
/// comparison ever ran.
///
/// A third, independent gap: <c>DeclarationBinder.TypeSignaturesEquivalent</c>
/// had no case for <see cref="DelegateTypeSymbol"/>, so a named delegate
/// constructed over a *method-level* generic parameter (not fixed by
/// substituting the interface's own type arguments) still failed to compare
/// as equivalent to the implementer's own delegate instantiation.
///
/// All three fixes are exercised together here purely at the binder level
/// (no emit/ILVerify); see
/// <c>Issue2338GenericInterfaceDelegateSubstitutionEmitTests</c> for the
/// compile + ILVerify + run coverage.
/// </summary>
public class Issue2338GenericInterfaceDelegateSubstitutionTests
{
    [Fact]
    public void GenericInterfaceReturningNamedDelegateOverOwnTypeParameter_ImplementationBindsCleanly()
    {
        const string source = """
            package t
            type Getter[T any] = delegate func() T
            interface IFactory[T any] { func Make() Getter[T]; }
            class Concrete : IFactory[int32] {
                func Make() Getter[int32] { return func() int32 { return 42 } }
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void GenericInterfaceReturningNamedDelegate_ConstructedInterfaceMethodExposesClosedDelegateType()
    {
        const string source = """
            package t
            type Getter[T any] = delegate func() T
            interface IFactory[T any] { func Make() Getter[T]; }
            class Concrete : IFactory[int32] {
                func Make() Getter[int32] { return func() int32 { return 42 } }
            }
            """;
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var structSymbol = compilation.GlobalScope.Structs.Single(s => s.Name == "Concrete");
        var constructedIface = structSymbol.Interfaces.Single(i => i.Name.StartsWith("IFactory", System.StringComparison.Ordinal));
        var imethod = constructedIface.Methods.Single(m => m.Name == "Make");

        // Before the fix this stayed the open `Getter[T]` definition; it must
        // now be the closed `Getter[int32]` instantiation.
        var delegateReturn = Assert.IsType<DelegateTypeSymbol>(imethod.Type);
        Assert.False(delegateReturn.TypeArguments.IsDefaultOrEmpty);
        Assert.Same(TypeSymbol.Int32, delegateReturn.TypeArguments[0]);
    }

    [Fact]
    public void GenericInterfaceAcceptingNamedDelegateOverOwnTypeParameter_ImplementationBindsCleanly()
    {
        const string source = """
            package t
            type Consumer[T any] = delegate func(item T) void
            interface ISink[T any] { func Accept(c Consumer[T]) void; }
            class ConcreteSink : ISink[int32] {
                func Accept(c Consumer[int32]) void { c.Invoke(1) }
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void GenericInterfaceReturningPlainGenericClass_ImplementationBindsCleanly()
    {
        const string source = """
            package t
            class Box[T any](Value T)
            interface IFactory[T any] { func Make() Box[T]; }
            class Concrete : IFactory[int32] {
                func Make() Box[int32] { return Box[int32](1) }
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void NonGenericInterfaceWithMethodLevelGenericReturningNamedDelegate_ImplementationBindsCleanly()
    {
        const string source = """
            package t
            type Getter[T any] = delegate func() T
            interface IFactory { func Make[T](seed T) Getter[T]; }
            class Concrete : IFactory {
                func Make[T](seed T) Getter[T] { return func() T { return seed } }
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void GenericInterfaceMethodOnConstructedInterface_PreservesMethodLevelTypeParameterArity()
    {
        const string source = """
            package t
            type Combiner[A any, B any] = delegate func(item A) B
            interface ITransformer[TIn any] { func Transform[TOut](conv Combiner[TIn, TOut]) TOut; }
            class Concrete : ITransformer[int32] {
                func Transform[TOut](conv Combiner[int32, TOut]) TOut { return conv.Invoke(1) }
            }
            """;
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var structSymbol = compilation.GlobalScope.Structs.Single(s => s.Name == "Concrete");
        var constructedIface = structSymbol.Interfaces.Single(i => i.Name.StartsWith("ITransformer", System.StringComparison.Ordinal));
        var imethod = constructedIface.Methods.Single(m => m.Name == "Transform");

        // Before the fix, SubstituteMethod dropped the method's own
        // (method-level) generic type parameters entirely.
        Assert.True(imethod.IsGeneric);
        Assert.Single(imethod.TypeParameters);
        Assert.Equal("TOut", imethod.TypeParameters[0].Name);
    }

    [Fact]
    public void CombinedInterfaceLevelAndMethodLevelGenericsOverMultiParamDelegate_ImplementationBindsCleanly()
    {
        const string source = """
            package t
            type Combiner[A any, B any] = delegate func(item A) B
            interface ITransformer[TIn any] { func Transform[TOut](conv Combiner[TIn, TOut]) TOut; }
            class Concrete : ITransformer[int32] {
                func Transform[TOut](conv Combiner[int32, TOut]) TOut { return conv.Invoke(1) }
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void GenericClassImplementingGenericInterfaceWithCombinedGenericsOverDelegate_BindsCleanly()
    {
        // Containing-type generics: the implementing class is itself generic
        // (class-level TIn, not yet a concrete type at the class declaration)
        // combined with a method-level type parameter (TOut) inside the same
        // delegate signature.
        const string source = """
            package t
            type Combiner[A any, B any] = delegate func(item A) B
            interface ITransformer[TIn any] { func Transform[TOut](conv Combiner[TIn, TOut]) TOut; }
            class GenericConcrete[TIn any](Seed TIn) : ITransformer[TIn] {
                func Transform[TOut](conv Combiner[TIn, TOut]) TOut { return conv.Invoke(Seed) }
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void NestedGenericDelegateSignature_ImplementationBindsCleanly()
    {
        // The delegate's own type argument is itself a constructed generic
        // class over the interface's type parameter: Getter[Box[T]].
        const string source = """
            package t
            class Box[T any](Value T)
            type Getter[T any] = delegate func() T
            interface IFactory[T any] { func Make() Getter[Box[T]]; }
            class Concrete : IFactory[int32] {
                func Make() Getter[Box[int32]] { return func() Box[int32] { return Box[int32](1) } }
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void MismatchedDelegateTypeArgument_StillReportsGS0187()
    {
        const string source = """
            package t
            type Getter[T any] = delegate func() T
            interface IFactory[T any] { func Make() Getter[T]; }
            class WrongConcrete : IFactory[int32] {
                func Make() Getter[string] { return func() string { return "oops" } }
            }
            """;
        Assert.Contains(Bind(source), d => d.Id == "GS0187");
    }

    [Fact]
    public void DifferentNamedDelegateType_StillReportsGS0187()
    {
        const string source = """
            package t
            type Getter[T any] = delegate func() T
            type Setter[T any] = delegate func(value T) void
            interface IFactory { func Make[T](seed T) Getter[T]; }
            class WrongConcrete : IFactory {
                func Make[T](seed T) Setter[T] { return func(value T) void { } }
            }
            """;
        Assert.Contains(Bind(source), d => d.Id == "GS0187");
    }

    [Fact]
    public void GenuineMethodLevelArityMismatchOnConstructedInterface_StillReportsGS0187()
    {
        const string source = """
            package t
            type Combiner[A any, B any] = delegate func(item A) B
            interface ITransformer[TIn any] { func Transform[TOut](conv Combiner[TIn, TOut]) TOut; }
            class WrongArity : ITransformer[int32] {
                func Transform[TOut, TExtra](conv Combiner[int32, TOut]) TOut { return conv.Invoke(1) }
            }
            """;
        Assert.Contains(Bind(source), d => d.Id == "GS0187");
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.GlobalScope.Diagnostics.ToList();
    }
}
