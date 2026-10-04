// <copyright file="Issue4757RecursiveDelegateTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

public sealed class Issue4757RecursiveDelegateTests
{
    [Fact]
    public void MutualRecursion_QueriesStillFindTheNonRecursiveOpenBranch()
    {
        var first = Shell("First");
        var second = Shell("Second");
        first.SetSignature(Parameters(second), first);
        second.SetSignature(Parameters(first), second);
        Assert.False(TypeSymbol.ContainsTypeParameter(first));
        Assert.False(TypeSymbol.AnyTypeParameter(first, _ => true));
        var sink = new List<TypeParameterSymbol>();
        TypeSymbol.CollectReferencedTypeParameters(first, sink);
        Assert.Empty(sink);

        var outer = Tp("Outer");
        second.SetSignature(Parameters(first), PlatformTypeSymbol.Get(outer));
        Assert.True(TypeSymbol.ContainsTypeParameter(first));
        Assert.True(TypeSymbol.AnyTypeParameter(first, parameter => parameter == outer));
        Assert.False(TypeSymbol.AnyTypeParameter(first, parameter => parameter == Tp("Other")));
        Assert.True(TypeSymbol.ContainsOuterMethodTypeParameter(first, ImmutableArray.Create(outer)));
        TypeSymbol.CollectReferencedTypeParameters(first, sink);
        Assert.Equal(new[] { outer }, sink);
    }

    [Fact]
    public void ExpandingConstruction_IsNominalAndRefreshesEarlySignatureProjections()
    {
        var parameter = Tp("T");
        var definition = Shell("Growing");
        definition.SetTypeParameters(ImmutableArray.Create(parameter));
        var open = Construct(definition, parameter);
        Assert.Empty(open.Parameters);
        Assert.Same(TypeSymbol.Void, open.ReturnType);
        var earlyFunction = open.EquivalentFunctionType;
        definition.SetSignature(Parameters(open), Construct(definition, open));

        var closed = Construct(definition, TypeSymbol.Int32);
        Assert.Same(open, Assert.Single(open.Parameters).Type);
        Assert.NotSame(earlyFunction, open.EquivalentFunctionType);
        Assert.Same(closed, Assert.Single(closed.Parameters).Type);
        Assert.Same(closed, Assert.Single(closed.EquivalentFunctionType.ParameterTypes));
        Assert.Same(parameter, Assert.Single(closed.TypeParameters));
        Assert.Same(definition, closed.Definition);
        Assert.Same(closed, Construct(definition, TypeSymbol.Int32));
        Assert.NotSame(closed, Construct(ShellWithParameter("Growing", parameter), TypeSymbol.Int32));

        var cursor = closed;
        for (var i = 0; i < 8; i++)
        {
            var next = Assert.IsType<DelegateTypeSymbol>(cursor.ReturnType);
            Assert.Same(cursor, Assert.Single(next.TypeArguments));
            Assert.Same(next, Assert.Single(next.Parameters).Type);
            Assert.False(TypeSymbol.ContainsTypeParameter(next));
            var sink = new List<TypeParameterSymbol>();
            TypeSymbol.CollectReferencedTypeParameters(next, sink);
            Assert.Empty(sink);
            cursor = next;
        }

        var actual = Tp("Actual");
        var partiallyOpen = Construct(definition, NullableTypeSymbol.Get(actual));
        Assert.True(TypeSymbol.AnyTypeParameter(partiallyOpen, candidate => candidate == actual));
        Assert.False(TypeSymbol.AnyTypeParameter(partiallyOpen, candidate => candidate == parameter));
        Assert.True(TypeSymbol.ContainsOuterMethodTypeParameter(partiallyOpen, ImmutableArray.Create(actual)));
        var referenced = new List<TypeParameterSymbol>();
        TypeSymbol.CollectReferencedTypeParameters(partiallyOpen, referenced);
        Assert.Equal(new[] { actual }, referenced);
    }

    [Fact]
    public void RevisitedDefinition_StillInspectsUnusedActualArgumentsAndPreservesSignatureOrder()
    {
        var parameter = Tp("T");
        var definition = ShellWithParameter("Phantom", parameter);
        var outer = Tp("Outer");
        definition.SetSignature(Parameters(definition), PlatformTypeSymbol.Get(outer));
        var actual = Tp("Actual");
        var function = FunctionTypeSymbol.Get(
            ImmutableArray.Create<TypeSymbol>(Construct(definition, TypeSymbol.Int32), Construct(definition, actual)),
            TypeSymbol.Void);
        Assert.True(TypeSymbol.AnyTypeParameter(function, candidate => candidate == actual));
        Assert.True(TypeSymbol.AnyTypeParameter(function, candidate => candidate == outer));
        Assert.False(TypeSymbol.AnyTypeParameter(function, candidate => candidate == parameter));
        var sink = new List<TypeParameterSymbol>();
        TypeSymbol.CollectReferencedTypeParameters(function, sink);
        Assert.Equal(new[] { outer, actual }, sink);

        var recursive = ShellWithParameter("Revisited", parameter);
        recursive.SetSignature(
            Parameters(Construct(recursive, TypeSymbol.Int32)),
            Construct(recursive, actual));
        var closedArgument = Construct(recursive, TypeSymbol.Int32);
        Assert.True(TypeSymbol.AnyTypeParameter(closedArgument, candidate => candidate == actual));
        Assert.False(TypeSymbol.AnyTypeParameter(closedArgument, candidate => candidate == parameter));
        sink.Clear();
        TypeSymbol.CollectReferencedTypeParameters(closedArgument, sink);
        Assert.Equal(new[] { actual }, sink);
    }

    [Fact]
    public void SiblingConstructions_PreserveEachSignaturesParameterOrder()
    {
        var t = Tp("T");
        var u = Tp("U");
        var definition = Shell("Swap");
        definition.SetTypeParameters(ImmutableArray.Create(t, u));
        definition.SetSignature(Parameters(u), t);
        var x = Tp("X");
        var y = Tp("Y");
        var z = Tp("Z");
        var w = Tp("W");
        var closed = DelegateTypeSymbol.Construct(
            definition, ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32, TypeSymbol.String));
        var first = DelegateTypeSymbol.Construct(
            definition, ImmutableArray.Create<TypeSymbol>(x, y));
        var second = DelegateTypeSymbol.Construct(
            definition, ImmutableArray.Create<TypeSymbol>(z, w));
        var sink = new List<TypeParameterSymbol>();
        TypeSymbol.CollectReferencedTypeParameters(
            FunctionTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(closed, first), TypeSymbol.Void),
            sink);
        Assert.Equal(new[] { y, x }, sink);
        sink.Clear();
        TypeSymbol.CollectReferencedTypeParameters(
            FunctionTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(first, second), TypeSymbol.Void),
            sink);
        Assert.Equal(new[] { y, x, w, z }, sink);

        definition.SetSignature(
            Parameters(DelegateTypeSymbol.Construct(
                definition, ImmutableArray.Create<TypeSymbol>(u, t))),
            t);
        sink.Clear();
        TypeSymbol.CollectReferencedTypeParameters(
            FunctionTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(first, second), TypeSymbol.Void),
            sink);
        Assert.Equal(new[] { y, x, w, z }, sink);
    }

    [Fact]
    public void SignatureSubstitution_PreservesNullableAndPlatformWrappersAndParameterMetadata()
    {
        var parameter = Tp("T");
        var definition = ShellWithParameter("Wrapped", parameter);
        var sourceParameter = new ParameterSymbol("value", PlatformTypeSymbol.Get(parameter), false);
        sourceParameter.SetExplicitDefaultValue(null);
        definition.SetSignature(
            ImmutableArray.Create(sourceParameter),
            NullableTypeSymbol.Get(parameter));
        var constructed = Construct(definition, TypeSymbol.String);
        var projected = Assert.Single(constructed.Parameters);
        Assert.Same(TypeSymbol.String, Assert.IsType<PlatformTypeSymbol>(projected.Type).UnderlyingType);
        Assert.Same(TypeSymbol.String, Assert.IsType<NullableTypeSymbol>(constructed.ReturnType).UnderlyingType);
        Assert.Equal("value", projected.Name);
        Assert.True(projected.HasExplicitDefaultValue);
        Assert.Null(projected.ExplicitDefaultValue);
        Assert.Same(projected, Assert.Single(constructed.Parameters));
        Assert.False(TypeSymbol.ContainsTypeParameter(constructed));
    }

    [Fact]
    public void RecursiveActualArguments_KeepOpenAndClosedContainingContextsDistinct()
    {
        var tree = SyntaxTree.Parse(SourceText.From("""
            package P
            class Outer[T] { class Inner { } }
            delegate D[X](other D[X]) D[D[X]];
            func Open[T](value D[Outer[T].Inner]) { }
            func Closed(value D[Outer[int32].Inner]) { }
            """));
        var compilation = new Compilation(tree) { IsLibrary = true };
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(diagnostic => diagnostic.IsError));
        var open = compilation.GlobalScope.Functions.Single(function => function.Name == "Open");
        var closed = compilation.GlobalScope.Functions.Single(function => function.Name == "Closed");
        var openType = Assert.Single(open.Parameters).Type;
        var closedType = Assert.Single(closed.Parameters).Type;
        var parameter = Assert.Single(open.TypeParameters);
        Assert.True(TypeSymbol.ContainsTypeParameter(openType));
        Assert.True(TypeSymbol.ContainsOuterMethodTypeParameter(openType, open.TypeParameters));
        Assert.False(TypeSymbol.ContainsTypeParameter(closedType));
        var sink = new List<TypeParameterSymbol>();
        TypeSymbol.CollectReferencedTypeParameters(openType, sink);
        Assert.Equal(new[] { parameter }, sink);
        sink.Clear();
        TypeSymbol.CollectReferencedTypeParameters(closedType, sink);
        Assert.Empty(sink);
    }

    [Fact]
    public void TupleWrappedRecursion_QueriesDoNotForceConstructedSignatureProjection()
    {
        var parameter = Tp("T");
        var definition = ShellWithParameter("TupleRecursive", parameter);
        var open = Construct(definition, parameter);
        var list = ImportedTypeSymbol.GetConstructed(
            typeof(List<object>),
            typeof(List<>),
            ImmutableArray.Create<TypeSymbol>(open));
        definition.SetSignature(
            Parameters(open),
            TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(list, TypeSymbol.Int32)));
        var closed = Construct(definition, TypeSymbol.Int32);
        Assert.False(TypeSymbol.ContainsTypeParameter(closed));
        var projected = Assert.IsType<TupleTypeSymbol>(closed.ReturnType);
        var projectedList = Assert.IsType<ImportedTypeSymbol>(projected.ElementTypes[0]);
        Assert.Same(closed, Assert.Single(closed.Parameters).Type);
        Assert.Same(closed, Assert.Single(projectedList.TypeArguments));
        Assert.False(projectedList.HasTypeParameterArgument);
        Assert.True(TypeSymbol.RequiresSymbolicProjection(projectedList));
        Assert.Null(projected.ClrType);
        var sink = new List<TypeParameterSymbol>();
        TypeSymbol.CollectReferencedTypeParameters(closed, sink);
        Assert.Empty(sink);
        Assert.True(TypeSymbol.ContainsTypeParameter(open));
        TypeSymbol.CollectReferencedTypeParameters(open, sink);
        Assert.Equal(new[] { parameter }, sink);
    }

    [Fact]
    public void DefinitionSignatures_KeepFormalAndFreeParametersInTheirOwnScopes()
    {
        var parameter = Tp("T");
        var definition = ShellWithParameter("Definition", parameter);
        definition.SetSignature(Parameters(parameter), TypeSymbol.Void);
        var actual = Tp("Actual");
        var function = FunctionTypeSymbol.Get(
            ImmutableArray.Create<TypeSymbol>(Construct(definition, actual), definition),
            TypeSymbol.Void);
        Assert.True(TypeSymbol.AnyTypeParameter(function, candidate => candidate == parameter));
        Assert.True(TypeSymbol.AnyTypeParameter(function, candidate => candidate == actual));
        var sink = new List<TypeParameterSymbol>();
        TypeSymbol.CollectReferencedTypeParameters(function, sink);
        Assert.Equal(new[] { actual, parameter }, sink);

        var unused = ShellWithParameter("Unused", parameter);
        Assert.False(TypeSymbol.ContainsTypeParameter(unused));
        sink.Clear();
        TypeSymbol.CollectReferencedTypeParameters(unused, sink);
        Assert.Empty(sink);

        var nestedParameter = Tp("U");
        var nested = ShellWithParameter("Nested", nestedParameter);
        nested.SetSignature(Parameters(nestedParameter), parameter);
        definition.SetSignature(Parameters(Construct(nested, parameter)), TypeSymbol.Void);
        var closed = Construct(definition, TypeSymbol.Int32);
        var projectedNested = Assert.IsType<DelegateTypeSymbol>(Assert.Single(closed.Parameters).Type);
        Assert.Same(TypeSymbol.Int32, Assert.Single(projectedNested.Parameters).Type);
        Assert.Same(parameter, projectedNested.ReturnType);
        Assert.True(TypeSymbol.AnyTypeParameter(closed, candidate => candidate == parameter));
        TypeSymbol.CollectReferencedTypeParameters(closed, sink);
        Assert.Equal(new[] { parameter }, sink);
    }

    private static TypeParameterSymbol Tp(string name)
        => new(name, 0, TypeParameterConstraint.Any, TypeParameterVariance.None);

    private static DelegateTypeSymbol Shell(string name)
        => new(name, "P", Accessibility.Public, ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, null);

    private static DelegateTypeSymbol ShellWithParameter(string name, TypeParameterSymbol parameter)
    {
        var definition = Shell(name);
        definition.SetTypeParameters(ImmutableArray.Create(parameter));
        return definition;
    }

    private static DelegateTypeSymbol Construct(DelegateTypeSymbol definition, TypeSymbol argument)
        => DelegateTypeSymbol.Construct(definition, ImmutableArray.Create(argument));

    private static ImmutableArray<ParameterSymbol> Parameters(TypeSymbol type)
        => ImmutableArray.Create(new ParameterSymbol("other", type, false));
}
