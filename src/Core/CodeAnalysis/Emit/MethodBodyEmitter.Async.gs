// <copyright file="MethodBodyEmitter.Async.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Lowering.Iterators
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Runtime.CompilerServices

/// PR-E-11 partial of (cref:MethodBodyEmitter):
/// state-machine helpers absorbed from PR-E-10 Option B (EmitStateMachineAwaitOnCompleted,
/// EmitAsyncIteratorBuilderMoveNext).
/// See `MethodBodyEmitter.cs` for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
internal partial class MethodBodyEmitter {
    /// Emits the `builder.AwaitUnsafeOnCompleted<TAwaiter, TSM>(ref awaiter, ref this)`
    /// call that requires a MethodSpec with the synthesized SM TypeDef.
    private func EmitStateMachineAwaitOnCompleted(node BoundStateMachineAwaitOnCompleted) {
        this
            .outer
            .stateMachines
            .EmitAwaitOnCompletedCall(this.il, this.locals, this.parameters, node, this.asyncPlan, this.iteratorEmitCtx)
    }

    /// Emits `builder.MoveNext<TSM>(ref this)` for async iterator SM classes.
    /// Constructs a MethodSpec for the generic MoveNext method.
    private func EmitAsyncIteratorBuilderMoveNext(node BoundStateMachineBuilderMoveNext) {
        // ldarg.0 (this)
        // ldflda builder
        let builderFieldHandle = this.outer.userTokens.ResolveFieldToken(node.SmClass, node.BuilderField)
        this.il.OpCode(ILOpCode.Ldarg_0)
        this.il.OpCode(ILOpCode.Ldflda)
        this.il.Token(builderFieldHandle)
        // ldarga.0 (ref this — managed pointer to the 'this' parameter slot)
        this.il.OpCode(ILOpCode.Ldarga_s)
        this.il.CodeBuilder.WriteByte(0)
        // call instance void AsyncIteratorMethodBuilder::MoveNext<SM>(ref SM)
        let builderClrType = typeof(AsyncIteratorMethodBuilder)
        var openMoveNext MethodInfo? = nil
        for method in builderClrType.GetMethods(BindingFlags.Public | BindingFlags.Instance) {
            if method.Name == "MoveNext" && method.IsGenericMethodDefinition && method.GetParameters().Length == 1 {
                openMoveNext = method
                break
            }
        }
        openMoveNext = Invariant.Required(
            openMoveNext,
            "AsyncIteratorMethodBuilder.MoveNext<TStateMachine> is available",
            expression: "openMoveNext"
        )
        let openRef = this.outer.memberRefs.GetMethodReference(openMoveNext)
        let sigBlob = BlobBuilder()
        let argsEncoder = BlobEncoder(sigBlob).MethodSpecificationSignature(1)
        this
            .outer
            .userTokens
            .EncodeTypeSymbolIntoSignature(argsEncoder.AddArgument(), node.SmClass) // class, not struct
        let methodSpec = this
            .outer
            .emitCtx
            .MetadataRows
            .AddMethodSpecification(openRef, this.outer.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(methodSpec)
    }
}
