// <copyright file="AsyncStateMachineTypeBuilderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Linq
import Xunit

open class AsyncStateMachineTypeBuilderTests {
    @Fact
    func Build_NonAsyncKickoff_Throws() {
        let fn = FunctionSymbol("foo", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void)
        let body = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        Assert.Throws[ArgumentException](
            func () object? {
                return AsyncStateMachineTypeBuilder.Build(fn, body, Resolver)
            }
        )
    }

    @Fact
    func Build_VoidAsyncKickoff_BindsTaskBuilder() {
        let fn = FunctionSymbol("doIt", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void){IsAsync = true}
        let body = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let sm SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver)
        Assert.NotNull(sm)
        Assert.Equal("<doIt>d__0", sm!!.Name)
        Assert.Equal(StateMachineContainerKind.Struct, sm!!.ContainerKind)
        Assert.Equal(AsyncMethodBuilderKind.Task, sm!!.BuilderInfo.Kind)
        Assert.Equal("System.Runtime.CompilerServices.AsyncTaskMethodBuilder", sm!!.BuilderInfo.BuilderType.FullName)
    }

    @Fact
    func Build_IntAsyncKickoff_BindsGenericTaskBuilder() {
        let fn = FunctionSymbol("compute", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Int32){IsAsync = true}
        let body = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let sm SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver)
        Assert.NotNull(sm)
        Assert.Equal(AsyncMethodBuilderKind.GenericTask, sm!!.BuilderInfo.Kind)
        Assert.Equal(typeof(int32), sm!!.BuilderInfo.ResultType)
    }

    @Fact
    func Build_PopulatesStateAndBuilderFields_InOrder() {
        let fn = FunctionSymbol("doIt", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void){IsAsync = true}
        let body = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let sm SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver)
        Assert.NotNull(sm!!.StateField)
        Assert.NotNull(sm!!.BuilderField)
        Assert.Equal(GeneratedNames.StateField, sm!!.StateField!!.Name)
        Assert.Equal(GeneratedNames.BuilderField, sm!!.BuilderField!!.Name)
        Assert.Same(sm!!.StateField, sm!!.Fields[0])
        Assert.Same(sm!!.BuilderField, sm!!.Fields[1])
        Assert.Equal(TypeSymbol.Int32, sm!!.StateField!!.Type)
    }

    @Fact
    func Build_AddsParameterProxies_AfterControlFields_InDeclarationOrder() {
        let p1 = ParameterSymbol("a", TypeSymbol.Int32)
        let p2 = ParameterSymbol("b", TypeSymbol.String)
        let fn = FunctionSymbol("doIt", ImmutableArray.Create(p1, p2), TypeSymbol.Void){IsAsync = true}
        let body = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let sm SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver)
        let fields = sm!!.Fields
        Assert.Equal(4, fields.Length)
        Assert.Equal("a", fields[2].Name)
        Assert.Equal(TypeSymbol.Int32, fields[2].Type)
        Assert.Equal("b", fields[3].Name)
        Assert.Equal(TypeSymbol.String, fields[3].Type)
    }

    @Fact
    func Build_AddsHoistedLocals_WithMangledNames_AfterParameters() {
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
        let fields = sm!!.Fields
        Assert.Equal(4, fields.Length)
        Assert.Equal("<x>5__1", fields[2].Name)
        Assert.Equal("<y>5__2", fields[3].Name)
    }

    @Fact
    func Build_AsyncIterator_PicksClassContainer() {
        if !Resolver.TryResolveType("System.Collections.Generic.IAsyncEnumerable`1", out var iae) {
            return
        }
        let elem = TypeSymbol.FromClrType(typeof(int32))
        let fn = FunctionSymbol("stream", ImmutableArray[ParameterSymbol].Empty, elem){IsAsync = true}
        let body = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let sm SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver)
        Assert.NotNull(sm)
        Assert.Equal(StateMachineContainerKind.Struct, sm!!.ContainerKind)
        Assert.Equal(AsyncMethodBuilderKind.GenericTask, sm!!.BuilderInfo.Kind)
    }

    @Fact
    func Build_OrdinalAffectsTypeName() {
        let fn = FunctionSymbol("doIt", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void){IsAsync = true}
        let body = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let sm0 SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver, ordinal: 0)
        let sm3 SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver, ordinal: 3)
        Assert.Equal("<doIt>d__0", sm0!!.Name)
        Assert.Equal("<doIt>d__3", sm3!!.Name)
    }

    @Fact
    func Build_PopulatedTypeIs_BackLinkable_FromFunctionSymbol() {
        let fn = FunctionSymbol("doIt", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void){IsAsync = true}
        let body = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let sm SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(fn, body, Resolver)
        fn.StateMachineType = sm
        Assert.Same(sm, fn.StateMachineType)
        Assert.Same(fn, (cast[SynthesizedStateMachineType](fn.StateMachineType)).KickoffMethod)
    }

    shared {
        private let Resolver ReferenceResolver = ReferenceResolver.Default()
    }
}
