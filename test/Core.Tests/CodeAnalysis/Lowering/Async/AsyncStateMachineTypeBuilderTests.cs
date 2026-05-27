// <copyright file="AsyncStateMachineTypeBuilderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

public class AsyncStateMachineTypeBuilderTests
{
    private static readonly ReferenceResolver Resolver = ReferenceResolver.Default();

    [Fact]
    public void Build_NonAsyncKickoff_Throws()
    {
        var fn = new FunctionSymbol("foo", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);
        var body = new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty);

        Assert.Throws<ArgumentException>(() => AsyncStateMachineTypeBuilder.Build(fn, body, Resolver));
    }

    [Fact]
    public void Build_VoidAsyncKickoff_BindsTaskBuilder()
    {
        var fn = new FunctionSymbol("doIt", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void) { IsAsync = true };
        var body = new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty);

        var sm = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver);

        Assert.NotNull(sm);
        Assert.Equal("<doIt>d__0", sm.Name);
        Assert.Equal(StateMachineContainerKind.Struct, sm.ContainerKind);
        Assert.Equal(AsyncMethodBuilderKind.Task, sm.BuilderInfo.Kind);
        Assert.Equal("System.Runtime.CompilerServices.AsyncTaskMethodBuilder", sm.BuilderInfo.BuilderType.FullName);
    }

    [Fact]
    public void Build_IntAsyncKickoff_BindsGenericTaskBuilder()
    {
        var fn = new FunctionSymbol("compute", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int) { IsAsync = true };
        var body = new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty);

        var sm = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver);

        Assert.NotNull(sm);
        Assert.Equal(AsyncMethodBuilderKind.GenericTask, sm.BuilderInfo.Kind);
        Assert.Equal(typeof(int), sm.BuilderInfo.ResultType);
    }

    [Fact]
    public void Build_PopulatesStateAndBuilderFields_InOrder()
    {
        var fn = new FunctionSymbol("doIt", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void) { IsAsync = true };
        var body = new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty);

        var sm = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver);

        Assert.NotNull(sm.StateField);
        Assert.NotNull(sm.BuilderField);
        Assert.Equal(GeneratedNames.StateField, sm.StateField.Name);
        Assert.Equal(GeneratedNames.BuilderField, sm.BuilderField.Name);
        Assert.Same(sm.StateField, sm.Fields[0]);
        Assert.Same(sm.BuilderField, sm.Fields[1]);
        Assert.Equal(TypeSymbol.Int, sm.StateField.Type);
    }

    [Fact]
    public void Build_AddsParameterProxies_AfterControlFields_InDeclarationOrder()
    {
        var p1 = new ParameterSymbol("a", TypeSymbol.Int);
        var p2 = new ParameterSymbol("b", TypeSymbol.String);
        var fn = new FunctionSymbol("doIt", ImmutableArray.Create(p1, p2), TypeSymbol.Void) { IsAsync = true };
        var body = new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty);

        var sm = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver);

        var fields = sm.Fields;
        Assert.Equal(4, fields.Length);
        Assert.Equal("a", fields[2].Name);
        Assert.Equal(TypeSymbol.Int, fields[2].Type);
        Assert.Equal("b", fields[3].Name);
        Assert.Equal(TypeSymbol.String, fields[3].Type);
    }

    [Fact]
    public void Build_AddsHoistedLocals_WithMangledNames_AfterParameters()
    {
        var fn = new FunctionSymbol("doIt", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void) { IsAsync = true };
        var x = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int);
        var y = new LocalVariableSymbol("y", isReadOnly: false, TypeSymbol.String);
        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(null, x, new BoundLiteralExpression(null, 1)),
            new BoundVariableDeclaration(null, y, new BoundLiteralExpression(null, "hello"))));

        var sm = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver);

        var fields = sm.Fields;
        Assert.Equal(4, fields.Length);
        Assert.Equal("<x>5__1", fields[2].Name);
        Assert.Equal("<y>5__2", fields[3].Name);
    }

    [Fact]
    public void Build_AsyncIterator_PicksClassContainer()
    {
        if (!Resolver.TryResolveType("System.Collections.Generic.IAsyncEnumerable`1", out var iae))
        {
            return;
        }

        var elem = TypeSymbol.FromClrType(typeof(int));
        var fn = new FunctionSymbol("stream", ImmutableArray<ParameterSymbol>.Empty, elem) { IsAsync = true };
        var body = new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty);

        var sm = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver);

        Assert.NotNull(sm);
        Assert.Equal(StateMachineContainerKind.Struct, sm.ContainerKind);
        Assert.Equal(AsyncMethodBuilderKind.GenericTask, sm.BuilderInfo.Kind);
    }

    [Fact]
    public void Build_OrdinalAffectsTypeName()
    {
        var fn = new FunctionSymbol("doIt", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void) { IsAsync = true };
        var body = new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty);

        var sm0 = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver, ordinal: 0);
        var sm3 = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver, ordinal: 3);

        Assert.Equal("<doIt>d__0", sm0.Name);
        Assert.Equal("<doIt>d__3", sm3.Name);
    }

    [Fact]
    public void Build_PopulatedTypeIs_BackLinkable_FromFunctionSymbol()
    {
        var fn = new FunctionSymbol("doIt", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void) { IsAsync = true };
        var body = new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty);

        var sm = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver);
        fn.StateMachineType = sm;

        Assert.Same(sm, fn.StateMachineType);
        Assert.Same(fn, ((SynthesizedStateMachineType)fn.StateMachineType).KickoffMethod);
    }
}
