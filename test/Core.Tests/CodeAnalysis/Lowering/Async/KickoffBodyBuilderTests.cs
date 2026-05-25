// <copyright file="KickoffBodyBuilderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

public class KickoffBodyBuilderTests
{
    private static readonly PackageSymbol Package = new PackageSymbol("main", declaration: null);
    private static readonly ReferenceResolver Resolver = ReferenceResolver.Default();

    [Fact]
    public void Build_TaskReturningMethod_PlansCanonicalKickoffShape()
    {
        var function = new FunctionSymbol("doIt", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package) { IsAsync = true };
        var fieldMap = CreateFieldMap(function, Block());

        var plan = KickoffBodyBuilder.Build(function, fieldMap);

        Assert.Equal("<>sm", plan.StateMachineLocal.Name);
        Assert.Equal(fieldMap.StructType, plan.StateMachineLocal.Type);
        Assert.Equal(StateMachineStates.NotStartedOrRunningState, plan.InitialState);
        Assert.Same(fieldMap.StateField, plan.StateField);
        Assert.Same(fieldMap.BuilderField, plan.BuilderField);
        Assert.Null(plan.ThisField);
        Assert.Empty(plan.ParameterCopies);
        Assert.Equal("Create", plan.BuilderCreateMethod.Name);
        Assert.Equal("Start", plan.BuilderStartMethod.Name);
        Assert.True(plan.ReturnsBuilderTask);
        Assert.Equal("Task", plan.BuilderTaskProperty.Name);
    }

    [Fact]
    public void Build_Parameters_PlansParameterFieldCopiesInDeclarationOrder()
    {
        var first = new ParameterSymbol("first", TypeSymbol.Int);
        var second = new ParameterSymbol("second", TypeSymbol.String);
        var function = new FunctionSymbol("doIt", ImmutableArray.Create(first, second), TypeSymbol.Void, package: Package) { IsAsync = true };
        var fieldMap = CreateFieldMap(function, Block());

        var plan = KickoffBodyBuilder.Build(function, fieldMap);

        Assert.Collection(
            plan.ParameterCopies,
            copy =>
            {
                Assert.Same(first, copy.Parameter);
                Assert.Same(fieldMap.GetParameterField(first), copy.Field);
                Assert.Equal("first", copy.Field.Name);
            },
            copy =>
            {
                Assert.Same(second, copy.Parameter);
                Assert.Same(fieldMap.GetParameterField(second), copy.Field);
                Assert.Equal("second", copy.Field.Name);
            });
    }

    [Fact]
    public void Build_InstanceMethod_PlansThisFieldCopy()
    {
        var receiver = new StructSymbol("Receiver", ImmutableArray<FieldSymbol>.Empty, Accessibility.Public, declaration: null, packageName: Package.Name);
        var function = new FunctionSymbol(
            "doIt",
            ImmutableArray<ParameterSymbol>.Empty,
            TypeSymbol.Void,
            declaration: null,
            package: Package,
            accessibility: Accessibility.Public,
            receiverType: receiver)
        {
            IsAsync = true,
        };
        var fieldMap = CreateFieldMap(function, Block());

        var plan = KickoffBodyBuilder.Build(function, fieldMap);

        Assert.Same(fieldMap.ThisField, plan.ThisField);
        Assert.Equal(GeneratedNames.ThisField, plan.ThisField.Name);
        Assert.Equal(receiver, plan.ThisField.Type);
    }

    [Fact]
    public void Build_NullFunction_Throws()
    {
        var function = new FunctionSymbol("doIt", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package) { IsAsync = true };
        var fieldMap = CreateFieldMap(function, Block());

        Assert.Throws<System.ArgumentNullException>(() => KickoffBodyBuilder.Build(null, fieldMap));
    }

    [Fact]
    public void Build_NullFieldMap_Throws()
    {
        var function = new FunctionSymbol("doIt", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package) { IsAsync = true };

        Assert.Throws<System.ArgumentNullException>(() => KickoffBodyBuilder.Build(function, null));
    }

    private static AsyncStateMachineFieldMap CreateFieldMap(FunctionSymbol function, BoundBlockStatement body)
    {
        var stateMachine = AsyncStateMachineTypeBuilder.Build(function, body, Resolver);
        Assert.NotNull(stateMachine);
        return AsyncStateMachineFieldMap.Create(stateMachine, body);
    }

    private static BoundBlockStatement Block(params BoundStatement[] statements)
    {
        return new BoundBlockStatement(statements.ToImmutableArray());
    }
}
