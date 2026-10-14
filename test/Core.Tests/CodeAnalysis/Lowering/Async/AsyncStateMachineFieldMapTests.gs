// <copyright file="AsyncStateMachineFieldMapTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import Xunit

open class AsyncStateMachineFieldMapTests {
    @Fact
    func Create_MaterializesStateMachineStruct() {
        let fn = FunctionSymbol("doIt", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void){IsAsync = true}
        let body = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let sm SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver)
        let map_ = AsyncStateMachineFieldMap.Create(sm!!, body)
        Assert.Same(sm, map_.StateMachine)
        Assert.Equal(sm!!.Name, map_.StructType.Name)
        Assert.False(map_.StructType.IsClass)
        Assert.Same(sm!!.StateField, map_.StateField)
        Assert.Same(sm!!.BuilderField, map_.BuilderField)
    }

    @Fact
    func Create_MapsParametersByCaptureOrder() {
        let p1 = ParameterSymbol("a", TypeSymbol.Int32)
        let p2 = ParameterSymbol("b", TypeSymbol.String)
        let fn = FunctionSymbol("doIt", ImmutableArray.Create(p1, p2), TypeSymbol.Void){IsAsync = true}
        let body = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let sm SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver)
        let map_ = AsyncStateMachineFieldMap.Create(sm!!, body)
        Assert.Equal("a", map_.GetParameterField(p1).Name)
        Assert.Equal(TypeSymbol.Int32, map_.GetParameterField(p1).Type)
        Assert.Equal("b", map_.GetParameterField(p2).Name)
        Assert.Equal(TypeSymbol.String, map_.GetParameterField(p2).Type)
    }

    @Fact
    func Create_MapsHoistedLocalsByCaptureOrder() {
        let fn = FunctionSymbol("doIt", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void){IsAsync = true}
        let x = LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32)
        let y = LocalVariableSymbol("y", isReadOnly: false, TypeSymbol.String)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundVariableDeclaration(nil, x, BoundLiteralExpression(nil, 1)),
                BoundVariableDeclaration(nil, y, BoundLiteralExpression(nil, "hello"))
            )
        )
        let sm SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver)
        let map_ = AsyncStateMachineFieldMap.Create(sm!!, body)
        Assert.Equal("<x>5__1", map_.GetLocalField(x).Name)
        Assert.Equal(TypeSymbol.Int32, map_.GetLocalField(x).Type)
        Assert.Equal("<y>5__2", map_.GetLocalField(y).Name)
        Assert.Equal(TypeSymbol.String, map_.GetLocalField(y).Type)
    }

    @Fact
    func Read_CreatesExistingFieldAccessNode() {
        let fn = FunctionSymbol("doIt", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void){IsAsync = true}
        let body = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let sm SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver)
        let map_ = AsyncStateMachineFieldMap.Create(sm!!, body)
        let receiver = LocalVariableSymbol("this", isReadOnly: false, map_.StructType)
        let access = map_.Read(BoundVariableExpression(nil, receiver), map_.StateField)
        Assert.Same(map_.StructType, access.StructType)
        Assert.Same(map_.StateField, access.Field)
        Assert.Equal(TypeSymbol.Int32, access.Type)
    }

    @Fact
    func Write_CreatesExistingFieldAssignmentNode() {
        let fn = FunctionSymbol("doIt", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void){IsAsync = true}
        let body = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let sm SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver)
        let map_ = AsyncStateMachineFieldMap.Create(sm!!, body)
        let receiver = LocalVariableSymbol("this", isReadOnly: false, map_.StructType)
        let value = BoundLiteralExpression(nil, -1)
        let assignment = map_.Write(receiver, map_.StateField, value)
        Assert.Same(receiver, assignment.Receiver)
        Assert.Same(map_.StructType, assignment.StructType)
        Assert.Same(map_.StateField, assignment.Field)
        Assert.Same(value, assignment.Value)
        Assert.Equal(TypeSymbol.Int32, assignment.Type)
    }

    @Fact
    func Create_FreezesSynthesizedFieldLayout() {
        let fn = FunctionSymbol("doIt", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void){IsAsync = true}
        let body = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let sm SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver)
        AsyncStateMachineFieldMap.Create(sm!!, body)
        Assert.Throws[InvalidOperationException](
            () -> sm!!.AddField(FieldSymbol("late", TypeSymbol.Int32, Accessibility.Public))
        )
    }

    shared {
        private let Resolver ReferenceResolver = ReferenceResolver.Default()
    }
}
