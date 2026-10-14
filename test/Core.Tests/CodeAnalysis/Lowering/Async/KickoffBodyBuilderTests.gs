// <copyright file="KickoffBodyBuilderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import Xunit

open class KickoffBodyBuilderTests {
    @Fact
    func Build_TaskReturningMethod_PlansCanonicalKickoffShape() {
        let function = FunctionSymbol(
            "doIt",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        let fieldMap = CreateFieldMap(function, Block())
        let plan = KickoffBodyBuilder.Build(function, fieldMap)
        Assert.Equal("<>sm", plan.StateMachineLocal.Name)
        Assert.Equal(fieldMap.StructType, plan.StateMachineLocal.Type)
        Assert.Equal(StateMachineStates.NotStartedOrRunningState, plan.InitialState)
        Assert.Same(fieldMap.StateField, plan.StateField)
        Assert.Same(fieldMap.BuilderField, plan.BuilderField)
        Assert.Null(plan.ThisField)
        Assert.Empty(plan.ParameterCopies)
        Assert.Equal("Create", plan.BuilderCreateMethod.Name)
        Assert.Equal("Start", plan.BuilderStartMethod.Name)
        Assert.True(plan.ReturnsBuilderTask)
        Assert.Equal("Task", plan.BuilderTaskProperty!!.Name)
        Assert.Collection(
            plan.Operations,
            (operation KickoffOperation) -> Assert.Equal(KickoffOperationKind.DeclareStateMachineLocal, operation.Kind),
            (operation KickoffOperation) -> Assert.Equal(KickoffOperationKind.InitializeBuilder, operation.Kind),
            (operation KickoffOperation) -> Assert.Equal(KickoffOperationKind.InitializeState, operation.Kind),
            (operation KickoffOperation) -> Assert.Equal(KickoffOperationKind.StartStateMachine, operation.Kind),
            (operation KickoffOperation) -> Assert.Equal(KickoffOperationKind.ReturnBuilderTask, operation.Kind)
        )
    }

    @Fact
    func Build_Parameters_PlansParameterFieldCopiesInDeclarationOrder() {
        let first = ParameterSymbol("first", TypeSymbol.Int32)
        let second = ParameterSymbol("second", TypeSymbol.String)
        let function = FunctionSymbol("doIt", ImmutableArray.Create(first, second), TypeSymbol.Void, $package: Package){
            IsAsync = true
        }
        let fieldMap = CreateFieldMap(function, Block())
        let plan = KickoffBodyBuilder.Build(function, fieldMap)
        Assert.Collection(
            plan.ParameterCopies,
            (copy KickoffParameterCopy) -> {
                Assert.Same(first, copy.Parameter)
                Assert.Same(fieldMap.GetParameterField(first), copy.Field)
                Assert.Equal("first", copy.Field.Name)
            },
            (copy KickoffParameterCopy) -> {
                Assert.Same(second, copy.Parameter)
                Assert.Same(fieldMap.GetParameterField(second), copy.Field)
                Assert.Equal("second", copy.Field.Name)
            }
        )
        Assert.Collection(
            plan.Operations,
            (operation KickoffOperation) -> Assert.Equal(KickoffOperationKind.DeclareStateMachineLocal, operation.Kind),
            (operation KickoffOperation) -> Assert.Equal(KickoffOperationKind.InitializeBuilder, operation.Kind),
            (operation KickoffOperation) -> {
                Assert.Equal(KickoffOperationKind.CopyParameter, operation.Kind)
                Assert.Same(first, operation.Parameter)
                Assert.Same(fieldMap.GetParameterField(first), operation.Field)
            },
            (operation KickoffOperation) -> {
                Assert.Equal(KickoffOperationKind.CopyParameter, operation.Kind)
                Assert.Same(second, operation.Parameter)
                Assert.Same(fieldMap.GetParameterField(second), operation.Field)
            },
            (operation KickoffOperation) -> Assert.Equal(KickoffOperationKind.InitializeState, operation.Kind),
            (operation KickoffOperation) -> Assert.Equal(KickoffOperationKind.StartStateMachine, operation.Kind),
            (operation KickoffOperation) -> Assert.Equal(KickoffOperationKind.ReturnBuilderTask, operation.Kind)
        )
    }

    @Fact
    func Build_InstanceMethod_PlansThisFieldCopy() {
        let receiver = StructSymbol(
            "Receiver",
            ImmutableArray[FieldSymbol].Empty,
            Accessibility.Public,
            declaration: nil,
            packageName: Package.Name
        )
        let function = FunctionSymbol(
            "doIt",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            declaration: nil,
            $package: Package,
            accessibility: Accessibility.Public,
            receiverType: receiver
        ){IsAsync = true}
        let fieldMap = CreateFieldMap(function, Block())
        let plan = KickoffBodyBuilder.Build(function, fieldMap)
        Assert.Same(fieldMap.ThisField, plan.ThisField)
        Assert.Equal(GeneratedNames.ThisField, plan.ThisField!!.Name)
        Assert.Equal(receiver, plan.ThisField!!.Type)
        Assert.Collection(
            plan.Operations,
            (operation KickoffOperation) -> Assert.Equal(KickoffOperationKind.DeclareStateMachineLocal, operation.Kind),
            (operation KickoffOperation) -> Assert.Equal(KickoffOperationKind.InitializeBuilder, operation.Kind),
            (operation KickoffOperation) -> {
                Assert.Equal(KickoffOperationKind.CopyThis, operation.Kind)
                Assert.Same(fieldMap.ThisField, operation.Field)
            },
            (operation KickoffOperation) -> Assert.Equal(KickoffOperationKind.InitializeState, operation.Kind),
            (operation KickoffOperation) -> Assert.Equal(KickoffOperationKind.StartStateMachine, operation.Kind),
            (operation KickoffOperation) -> Assert.Equal(KickoffOperationKind.ReturnBuilderTask, operation.Kind)
        )
    }

    @Fact
    func Constructor_NoTaskProperty_PlansVoidReturn() {
        let function = FunctionSymbol(
            "doIt",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        let fieldMap = CreateFieldMap(function, Block())
        let plan = KickoffBodyPlan(
            LocalVariableSymbol("<>sm", isReadOnly: false, fieldMap.StructType),
            StateMachineStates.NotStartedOrRunningState,
            fieldMap.StateField,
            fieldMap.BuilderField,
            fieldMap.ThisField,
            ImmutableArray[KickoffParameterCopy].Empty,
            fieldMap.StateMachine.BuilderInfo.CreateMethod!!,
            fieldMap.StateMachine.BuilderInfo.StartMethod!!,
            builderTaskProperty: nil
        )
        Assert.False(plan.ReturnsBuilderTask)
        Assert.Equal(KickoffOperationKind.ReturnVoid, plan.Operations[^1].Kind)
    }

    @Fact
    func Operations_CarryOperationTargets() {
        let parameter = ParameterSymbol("value", TypeSymbol.Int32)
        let function = FunctionSymbol("doIt", ImmutableArray.Create(parameter), TypeSymbol.Void, $package: Package){
            IsAsync = true
        }
        let fieldMap = CreateFieldMap(function, Block())
        let plan = KickoffBodyBuilder.Build(function, fieldMap)
        Assert.All(
            plan.Operations,
            (operation KickoffOperation) -> {
                if operation.Kind != KickoffOperationKind.ReturnVoid {
                    Assert.Same(plan.StateMachineLocal, operation.StateMachineLocal)
                }
            }
        )
        Assert.Same(plan.BuilderField, plan.Operations[1].Field)
        Assert.Same(plan.BuilderCreateMethod, plan.Operations[1].Method)
        Assert.Same(parameter, plan.Operations[2].Parameter)
        Assert.Same(fieldMap.GetParameterField(parameter), plan.Operations[2].Field)
        Assert.Same(plan.StateField, plan.Operations[3].Field)
        Assert.Equal(plan.InitialState, plan.Operations[3].InitialState)
        Assert.Same(plan.BuilderField, plan.Operations[4].Field)
        Assert.Same(plan.BuilderStartMethod, plan.Operations[4].Method)
        Assert.Same(plan.BuilderField, plan.Operations[5].Field)
        Assert.Same(plan.BuilderTaskProperty, plan.Operations[5].Property)
    }

    @Fact
    func Build_NullFunction_Throws() {
        let function = FunctionSymbol(
            "doIt",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        let fieldMap = CreateFieldMap(function, Block())
        Assert.Throws[ArgumentNullException](
            func () object? {
                return KickoffBodyBuilder.Build(nil, fieldMap)
            }
        )
    }

    @Fact
    func Build_NullFieldMap_Throws() {
        let function = FunctionSymbol(
            "doIt",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        Assert.Throws[ArgumentNullException](
            func () object? {
                return KickoffBodyBuilder.Build(function, nil)
            }
        )
    }

    shared {
        private let Package PackageSymbol = PackageSymbol("main", declaration: nil)
        private let Resolver ReferenceResolver = ReferenceResolver.Default()

        private func CreateFieldMap(function FunctionSymbol, body BoundBlockStatement) AsyncStateMachineFieldMap {
            let stateMachine SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(function, body, Resolver)
            Assert.NotNull(stateMachine)
            return AsyncStateMachineFieldMap.Create(stateMachine!!, body)
        }

        private func Block(statements ...BoundStatement) BoundBlockStatement {
            return BoundBlockStatement(nil, statements.ToImmutableArray())
        }
    }
}
