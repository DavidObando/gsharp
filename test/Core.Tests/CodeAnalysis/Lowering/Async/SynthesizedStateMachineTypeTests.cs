// <copyright file="SynthesizedStateMachineTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Threading.Tasks;
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
}
