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
    private static readonly PackageSymbol Package = new("main", declaration: null);
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
        Assert.Collection(
            plan.Operations,
            operation => Assert.Equal(KickoffOperationKind.DeclareStateMachineLocal, operation.Kind),
            operation => Assert.Equal(KickoffOperationKind.InitializeBuilder, operation.Kind),
            operation => Assert.Equal(KickoffOperationKind.InitializeState, operation.Kind),
            operation => Assert.Equal(KickoffOperationKind.StartStateMachine, operation.Kind),
            operation => Assert.Equal(KickoffOperationKind.ReturnBuilderTask, operation.Kind));
    }

    [Fact]
    public void Build_Parameters_PlansParameterFieldCopiesInDeclarationOrder()
    {
        var first = new ParameterSymbol("first", TypeSymbol.Int32);
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
        Assert.Collection(
            plan.Operations,
            operation => Assert.Equal(KickoffOperationKind.DeclareStateMachineLocal, operation.Kind),
            operation => Assert.Equal(KickoffOperationKind.InitializeBuilder, operation.Kind),
            operation =>
            {
                Assert.Equal(KickoffOperationKind.CopyParameter, operation.Kind);
                Assert.Same(first, operation.Parameter);
                Assert.Same(fieldMap.GetParameterField(first), operation.Field);
            },
            operation =>
            {
                Assert.Equal(KickoffOperationKind.CopyParameter, operation.Kind);
                Assert.Same(second, operation.Parameter);
                Assert.Same(fieldMap.GetParameterField(second), operation.Field);
            },
            operation => Assert.Equal(KickoffOperationKind.InitializeState, operation.Kind),
            operation => Assert.Equal(KickoffOperationKind.StartStateMachine, operation.Kind),
            operation => Assert.Equal(KickoffOperationKind.ReturnBuilderTask, operation.Kind));
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
        Assert.Collection(
            plan.Operations,
            operation => Assert.Equal(KickoffOperationKind.DeclareStateMachineLocal, operation.Kind),
            operation => Assert.Equal(KickoffOperationKind.InitializeBuilder, operation.Kind),
            operation =>
            {
                Assert.Equal(KickoffOperationKind.CopyThis, operation.Kind);
                Assert.Same(fieldMap.ThisField, operation.Field);
            },
            operation => Assert.Equal(KickoffOperationKind.InitializeState, operation.Kind),
            operation => Assert.Equal(KickoffOperationKind.StartStateMachine, operation.Kind),
            operation => Assert.Equal(KickoffOperationKind.ReturnBuilderTask, operation.Kind));
    }

    [Fact]
    public void Constructor_NoTaskProperty_PlansVoidReturn()
    {
        var function = new FunctionSymbol("doIt", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package) { IsAsync = true };
        var fieldMap = CreateFieldMap(function, Block());

        var plan = new KickoffBodyPlan(
            new LocalVariableSymbol("<>sm", isReadOnly: false, fieldMap.StructType),
            StateMachineStates.NotStartedOrRunningState,
            fieldMap.StateField,
            fieldMap.BuilderField,
            fieldMap.ThisField,
            ImmutableArray<KickoffParameterCopy>.Empty,
            fieldMap.StateMachine.BuilderInfo.CreateMethod,
            fieldMap.StateMachine.BuilderInfo.StartMethod,
            builderTaskProperty: null);

        Assert.False(plan.ReturnsBuilderTask);
        Assert.Equal(KickoffOperationKind.ReturnVoid, plan.Operations[^1].Kind);
    }

    [Fact]
    public void Operations_CarryOperationTargets()
    {
        var parameter = new ParameterSymbol("value", TypeSymbol.Int32);
        var function = new FunctionSymbol("doIt", ImmutableArray.Create(parameter), TypeSymbol.Void, package: Package) { IsAsync = true };
        var fieldMap = CreateFieldMap(function, Block());

        var plan = KickoffBodyBuilder.Build(function, fieldMap);

        Assert.All(plan.Operations, operation =>
        {
            if (operation.Kind != KickoffOperationKind.ReturnVoid)
            {
                Assert.Same(plan.StateMachineLocal, operation.StateMachineLocal);
            }
        });
        Assert.Same(plan.BuilderField, plan.Operations[1].Field);
        Assert.Same(plan.BuilderCreateMethod, plan.Operations[1].Method);
        Assert.Same(parameter, plan.Operations[2].Parameter);
        Assert.Same(fieldMap.GetParameterField(parameter), plan.Operations[2].Field);
        Assert.Same(plan.StateField, plan.Operations[3].Field);
        Assert.Equal(plan.InitialState, plan.Operations[3].InitialState);
        Assert.Same(plan.BuilderField, plan.Operations[4].Field);
        Assert.Same(plan.BuilderStartMethod, plan.Operations[4].Method);
        Assert.Same(plan.BuilderField, plan.Operations[5].Field);
        Assert.Same(plan.BuilderTaskProperty, plan.Operations[5].Property);
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
        return new BoundBlockStatement(null, statements.ToImmutableArray());
    }
}
