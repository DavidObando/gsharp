// <copyright file="SynthesizedStateMachineTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Threading.Tasks
import Xunit

open class SynthesizedStateMachineTypeTests {
    @Fact
    func Construction_RecordsKickoffAndBuilder() {
        let fn = FunctionSymbol("foo", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Int32)
        fn.IsAsync = true
        let builder AsyncMethodBuilderInfo? = AsyncMethodBuilderInfo.Resolve(typeof(Task[int32]), resolver: nil)
        let sm = SynthesizedStateMachineType("<foo>d__0", StateMachineContainerKind.Struct, fn, builder!!)
        Assert.Equal("<foo>d__0", sm.Name)
        Assert.Equal(StateMachineContainerKind.Struct, sm.ContainerKind)
        Assert.Same(fn, sm.KickoffMethod)
        Assert.Same(builder, sm.BuilderInfo)
        Assert.Equal(SymbolKind.Type, sm.Kind)
        Assert.Empty(sm.Fields)
    }

    @Fact
    func AddField_PreservesInsertionOrder() {
        let fn = FunctionSymbol("foo", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Int32)
        let sm = SynthesizedStateMachineType(
            "<foo>d__0",
            StateMachineContainerKind.Struct,
            fn,
            AsyncMethodBuilderInfo.Resolve(typeof(Task[int32]), resolver: nil)!!
        )
        let state = FieldSymbol(GeneratedNames.StateField, TypeSymbol.Int32, Accessibility.Public)
        let builderField = FieldSymbol(GeneratedNames.BuilderField, TypeSymbol.Int32, Accessibility.Public)
        sm.AddField(state)
        sm.AddField(builderField)
        sm.StateField = state
        sm.BuilderField = builderField
        Assert.Equal(
            []string{GeneratedNames.StateField, GeneratedNames.BuilderField},
            []string{sm.Fields[0].Name, sm.Fields[1].Name}
        )
        Assert.Same(state, sm.StateField)
        Assert.Same(builderField, sm.BuilderField)
    }

    @Fact
    func FunctionSymbol_StateMachineType_BackLink() {
        let fn = FunctionSymbol("foo", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Int32)
        let sm = SynthesizedStateMachineType(
            "<foo>d__0",
            StateMachineContainerKind.Struct,
            fn,
            AsyncMethodBuilderInfo.Resolve(typeof(Task[int32]), resolver: nil)!!
        )
        fn.StateMachineType = sm
        Assert.Same(sm, fn.StateMachineType)
    }

    @Fact
    func MaterializeAsStructSymbol_ProjectsFieldsAndMetadata() {
        let package_ = PackageSymbol("main", declaration: nil)
        let fn = FunctionSymbol("foo", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Int32, $package: package_)
        let sm = SynthesizedStateMachineType(
            "<foo>d__0",
            StateMachineContainerKind.Struct,
            fn,
            AsyncMethodBuilderInfo.Resolve(typeof(Task[int32]), resolver: nil)!!
        )
        let state = FieldSymbol(GeneratedNames.StateField, TypeSymbol.Int32, Accessibility.Public)
        let builder = FieldSymbol(GeneratedNames.BuilderField, TypeSymbol.Int32, Accessibility.Public)
        sm.AddField(state)
        sm.AddField(builder)
        let projected = sm.MaterializeAsStructSymbol()
        Assert.Equal("<foo>d__0", projected.Name)
        Assert.False(projected.IsClass)
        Assert.Equal(Accessibility.Private, projected.Accessibility)
        Assert.Equal("main", projected.PackageName)
        Assert.Equal(2, projected.Fields.Length)
        Assert.Same(state, projected.Fields[0])
        Assert.Same(builder, projected.Fields[1])
    }

    @Fact
    func MaterializeAsStructSymbol_ReturnsStableProjection() {
        let fn = FunctionSymbol("foo", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Int32)
        let sm = SynthesizedStateMachineType(
            "<foo>d__0",
            StateMachineContainerKind.Struct,
            fn,
            AsyncMethodBuilderInfo.Resolve(typeof(Task[int32]), resolver: nil)!!
        )
        let first = sm.MaterializeAsStructSymbol()
        let second = sm.MaterializeAsStructSymbol()
        Assert.Same(first, second)
    }

    @Fact
    func MaterializeAsStructSymbol_ClassContainerProjectsAsClass() {
        let fn = FunctionSymbol("foo", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Int32)
        let sm = SynthesizedStateMachineType(
            "<foo>d__0",
            StateMachineContainerKind.Class,
            fn,
            AsyncMethodBuilderInfo.Resolve(typeof(Task[int32]), resolver: nil)!!
        )
        let projected = sm.MaterializeAsStructSymbol()
        Assert.True(projected.IsClass)
    }

    @Fact
    func AddField_AfterMaterialization_Throws() {
        let fn = FunctionSymbol("foo", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Int32)
        let sm = SynthesizedStateMachineType(
            "<foo>d__0",
            StateMachineContainerKind.Struct,
            fn,
            AsyncMethodBuilderInfo.Resolve(typeof(Task[int32]), resolver: nil)!!
        )
        sm.MaterializeAsStructSymbol()
        Assert.Throws[InvalidOperationException](
            () -> sm.AddField(FieldSymbol("x", TypeSymbol.Int32, Accessibility.Public))
        )
    }

    @Fact
    func MaterializedStruct_CanBackExistingFieldAccessNode() {
        let fn = FunctionSymbol("foo", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Int32)
        let sm = SynthesizedStateMachineType(
            "<foo>d__0",
            StateMachineContainerKind.Struct,
            fn,
            AsyncMethodBuilderInfo.Resolve(typeof(Task[int32]), resolver: nil)!!
        )
        let field = FieldSymbol(GeneratedNames.StateField, TypeSymbol.Int32, Accessibility.Public)
        sm.AddField(field)
        let projected = sm.MaterializeAsStructSymbol()
        let thisLocal = LocalVariableSymbol("this", isReadOnly: false, projected)
        let access = BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisLocal), projected, field)
        Assert.Same(projected, access.StructType)
        Assert.Same(field, access.Field)
        Assert.Equal(TypeSymbol.Int32, access.Type)
    }
}
