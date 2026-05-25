// <copyright file="SynthesizedStateMachineTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

public class SynthesizedStateMachineTypeTests
{
    [Fact]
    public void Construction_RecordsKickoffAndBuilder()
    {
        var fn = new FunctionSymbol("foo", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int);
        fn.IsAsync = true;
        var builder = AsyncMethodBuilderInfo.Resolve(typeof(Task<int>), resolver: null);
        var sm = new SynthesizedStateMachineType("<foo>d__0", StateMachineContainerKind.Struct, fn, builder);

        Assert.Equal("<foo>d__0", sm.Name);
        Assert.Equal(StateMachineContainerKind.Struct, sm.ContainerKind);
        Assert.Same(fn, sm.KickoffMethod);
        Assert.Same(builder, sm.BuilderInfo);
        Assert.Equal(SymbolKind.Type, sm.Kind);
        Assert.Empty(sm.Fields);
    }

    [Fact]
    public void AddField_PreservesInsertionOrder()
    {
        var fn = new FunctionSymbol("foo", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int);
        var sm = new SynthesizedStateMachineType(
            "<foo>d__0",
            StateMachineContainerKind.Struct,
            fn,
            AsyncMethodBuilderInfo.Resolve(typeof(Task<int>), resolver: null));
        var state = new FieldSymbol(GeneratedNames.StateField, TypeSymbol.Int, Accessibility.Public);
        var builderField = new FieldSymbol(GeneratedNames.BuilderField, TypeSymbol.Int, Accessibility.Public);
        sm.AddField(state);
        sm.AddField(builderField);

        sm.StateField = state;
        sm.BuilderField = builderField;

        Assert.Equal(new[] { GeneratedNames.StateField, GeneratedNames.BuilderField }, new[] { sm.Fields[0].Name, sm.Fields[1].Name });
        Assert.Same(state, sm.StateField);
        Assert.Same(builderField, sm.BuilderField);
    }

    [Fact]
    public void FunctionSymbol_StateMachineType_BackLink()
    {
        var fn = new FunctionSymbol("foo", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int);
        var sm = new SynthesizedStateMachineType(
            "<foo>d__0",
            StateMachineContainerKind.Struct,
            fn,
            AsyncMethodBuilderInfo.Resolve(typeof(Task<int>), resolver: null));
        fn.StateMachineType = sm;
        Assert.Same(sm, fn.StateMachineType);
    }

    [Fact]
    public void MaterializeAsStructSymbol_ProjectsFieldsAndMetadata()
    {
        var package = new PackageSymbol("main", declaration: null);
        var fn = new FunctionSymbol("foo", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int, package: package);
        var sm = new SynthesizedStateMachineType(
            "<foo>d__0",
            StateMachineContainerKind.Struct,
            fn,
            AsyncMethodBuilderInfo.Resolve(typeof(Task<int>), resolver: null));
        var state = new FieldSymbol(GeneratedNames.StateField, TypeSymbol.Int, Accessibility.Public);
        var builder = new FieldSymbol(GeneratedNames.BuilderField, TypeSymbol.Int, Accessibility.Public);
        sm.AddField(state);
        sm.AddField(builder);

        var projected = sm.MaterializeAsStructSymbol();

        Assert.Equal("<foo>d__0", projected.Name);
        Assert.False(projected.IsClass);
        Assert.Equal(Accessibility.Private, projected.Accessibility);
        Assert.Equal("main", projected.PackageName);
        Assert.Equal(2, projected.Fields.Length);
        Assert.Same(state, projected.Fields[0]);
        Assert.Same(builder, projected.Fields[1]);
    }

    [Fact]
    public void MaterializeAsStructSymbol_ReturnsStableProjection()
    {
        var fn = new FunctionSymbol("foo", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int);
        var sm = new SynthesizedStateMachineType(
            "<foo>d__0",
            StateMachineContainerKind.Struct,
            fn,
            AsyncMethodBuilderInfo.Resolve(typeof(Task<int>), resolver: null));

        var first = sm.MaterializeAsStructSymbol();
        var second = sm.MaterializeAsStructSymbol();

        Assert.Same(first, second);
    }

    [Fact]
    public void MaterializeAsStructSymbol_ClassContainerProjectsAsClass()
    {
        var fn = new FunctionSymbol("foo", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int);
        var sm = new SynthesizedStateMachineType(
            "<foo>d__0",
            StateMachineContainerKind.Class,
            fn,
            AsyncMethodBuilderInfo.Resolve(typeof(Task<int>), resolver: null));

        var projected = sm.MaterializeAsStructSymbol();

        Assert.True(projected.IsClass);
    }

    [Fact]
    public void AddField_AfterMaterialization_Throws()
    {
        var fn = new FunctionSymbol("foo", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int);
        var sm = new SynthesizedStateMachineType(
            "<foo>d__0",
            StateMachineContainerKind.Struct,
            fn,
            AsyncMethodBuilderInfo.Resolve(typeof(Task<int>), resolver: null));
        sm.MaterializeAsStructSymbol();

        Assert.Throws<InvalidOperationException>(() => sm.AddField(new FieldSymbol("x", TypeSymbol.Int, Accessibility.Public)));
    }

    [Fact]
    public void MaterializedStruct_CanBackExistingFieldAccessNode()
    {
        var fn = new FunctionSymbol("foo", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int);
        var sm = new SynthesizedStateMachineType(
            "<foo>d__0",
            StateMachineContainerKind.Struct,
            fn,
            AsyncMethodBuilderInfo.Resolve(typeof(Task<int>), resolver: null));
        var field = new FieldSymbol(GeneratedNames.StateField, TypeSymbol.Int, Accessibility.Public);
        sm.AddField(field);
        var projected = sm.MaterializeAsStructSymbol();
        var thisLocal = new LocalVariableSymbol("this", isReadOnly: false, projected);

        var access = new BoundFieldAccessExpression(new BoundVariableExpression(thisLocal), projected, field);

        Assert.Same(projected, access.StructType);
        Assert.Same(field, access.Field);
        Assert.Equal(TypeSymbol.Int, access.Type);
    }
}
