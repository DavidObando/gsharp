// <copyright file="AsyncStateMachineFieldMapTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

public class AsyncStateMachineFieldMapTests
{
    private static readonly ReferenceResolver Resolver = ReferenceResolver.Default();

    [Fact]
    public void Create_MaterializesStateMachineStruct()
    {
        var fn = new FunctionSymbol("doIt", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void) { IsAsync = true };
        var body = new BoundBlockStatement(ImmutableArray<BoundStatement>.Empty);
        var sm = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver);

        var map = AsyncStateMachineFieldMap.Create(sm, body);

        Assert.Same(sm, map.StateMachine);
        Assert.Equal(sm.Name, map.StructType.Name);
        Assert.False(map.StructType.IsClass);
        Assert.Same(sm.StateField, map.StateField);
        Assert.Same(sm.BuilderField, map.BuilderField);
    }

    [Fact]
    public void Create_MapsParametersByCaptureOrder()
    {
        var p1 = new ParameterSymbol("a", TypeSymbol.Int);
        var p2 = new ParameterSymbol("b", TypeSymbol.String);
        var fn = new FunctionSymbol("doIt", ImmutableArray.Create(p1, p2), TypeSymbol.Void) { IsAsync = true };
        var body = new BoundBlockStatement(ImmutableArray<BoundStatement>.Empty);
        var sm = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver);

        var map = AsyncStateMachineFieldMap.Create(sm, body);

        Assert.Equal("a", map.GetParameterField(p1).Name);
        Assert.Equal(TypeSymbol.Int, map.GetParameterField(p1).Type);
        Assert.Equal("b", map.GetParameterField(p2).Name);
        Assert.Equal(TypeSymbol.String, map.GetParameterField(p2).Type);
    }

    [Fact]
    public void Create_MapsHoistedLocalsByCaptureOrder()
    {
        var fn = new FunctionSymbol("doIt", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void) { IsAsync = true };
        var x = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int);
        var y = new LocalVariableSymbol("y", isReadOnly: false, TypeSymbol.String);
        var body = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(x, new BoundLiteralExpression(1)),
            new BoundVariableDeclaration(y, new BoundLiteralExpression("hello"))));
        var sm = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver);

        var map = AsyncStateMachineFieldMap.Create(sm, body);

        Assert.Equal("<x>5__1", map.GetLocalField(x).Name);
        Assert.Equal(TypeSymbol.Int, map.GetLocalField(x).Type);
        Assert.Equal("<y>5__2", map.GetLocalField(y).Name);
        Assert.Equal(TypeSymbol.String, map.GetLocalField(y).Type);
    }

    [Fact]
    public void Read_CreatesExistingFieldAccessNode()
    {
        var fn = new FunctionSymbol("doIt", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void) { IsAsync = true };
        var body = new BoundBlockStatement(ImmutableArray<BoundStatement>.Empty);
        var sm = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver);
        var map = AsyncStateMachineFieldMap.Create(sm, body);
        var receiver = new LocalVariableSymbol("this", isReadOnly: false, map.StructType);

        var access = map.Read(new BoundVariableExpression(receiver), map.StateField);

        Assert.Same(map.StructType, access.StructType);
        Assert.Same(map.StateField, access.Field);
        Assert.Equal(TypeSymbol.Int, access.Type);
    }

    [Fact]
    public void Write_CreatesExistingFieldAssignmentNode()
    {
        var fn = new FunctionSymbol("doIt", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void) { IsAsync = true };
        var body = new BoundBlockStatement(ImmutableArray<BoundStatement>.Empty);
        var sm = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver);
        var map = AsyncStateMachineFieldMap.Create(sm, body);
        var receiver = new LocalVariableSymbol("this", isReadOnly: false, map.StructType);
        var value = new BoundLiteralExpression(-1);

        var assignment = map.Write(receiver, map.StateField, value);

        Assert.Same(receiver, assignment.Receiver);
        Assert.Same(map.StructType, assignment.StructType);
        Assert.Same(map.StateField, assignment.Field);
        Assert.Same(value, assignment.Value);
        Assert.Equal(TypeSymbol.Int, assignment.Type);
    }

    [Fact]
    public void Create_FreezesSynthesizedFieldLayout()
    {
        var fn = new FunctionSymbol("doIt", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void) { IsAsync = true };
        var body = new BoundBlockStatement(ImmutableArray<BoundStatement>.Empty);
        var sm = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver);

        AsyncStateMachineFieldMap.Create(sm, body);

        Assert.Throws<System.InvalidOperationException>(() => sm.AddField(new FieldSymbol("late", TypeSymbol.Int, Accessibility.Public)));
    }
}
