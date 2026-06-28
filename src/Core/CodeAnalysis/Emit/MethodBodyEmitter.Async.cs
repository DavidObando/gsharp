#nullable disable

// <copyright file="MethodBodyEmitter.Async.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1028 // trailing whitespace
#pragma warning disable SA1116 // parameters begin on line after declaration
#pragma warning disable SA1117 // parameters on same line
#pragma warning disable SA1214 // readonly fields before non-readonly
#pragma warning disable SA1515 // single-line comment preceded by blank line
#pragma warning disable SA1201 // method should not follow a class
#pragma warning disable SA1505 // opening brace should not be followed by a blank line — partial classes ship with a leading blank for readability
#pragma warning disable SA1202 // 'internal' members should come before 'private' members

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Lowering.Iterators;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-11 partial of <see cref="MethodBodyEmitter"/>:
/// state-machine helpers absorbed from PR-E-10 Option B (EmitStateMachineAwaitOnCompleted, EmitAsyncIteratorBuilderMoveNext).
/// See <c>MethodBodyEmitter.cs</c> for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
/// </summary>
internal sealed partial class MethodBodyEmitter
{

    /// <summary>
    /// Emits the <c>builder.AwaitUnsafeOnCompleted&lt;TAwaiter, TSM&gt;(ref awaiter, ref this)</c>
    /// call that requires a MethodSpec with the synthesized SM TypeDef.
    /// </summary>
    private void EmitStateMachineAwaitOnCompleted(BoundStateMachineAwaitOnCompleted node)
    {
        this.outer.stateMachines.EmitAwaitOnCompletedCall(this.il, this.locals, this.parameters, node, this.asyncPlan, this.asyncIteratorEmitCtx);
    }

    /// <summary>
    /// Emits <c>builder.MoveNext&lt;TSM&gt;(ref this)</c> for async iterator SM classes.
    /// Constructs a MethodSpec for the generic MoveNext method.
    /// </summary>
    private void EmitAsyncIteratorBuilderMoveNext(BoundStateMachineBuilderMoveNext node)
    {
        // ldarg.0 (this)
        // ldflda builder
        var builderFieldHandle = this.outer.cache.StructFieldDefs[node.BuilderField];
        this.il.OpCode(ILOpCode.Ldarg_0);
        this.il.OpCode(ILOpCode.Ldflda);
        this.il.Token(builderFieldHandle);

        // ldarga.0 (ref this — managed pointer to the 'this' parameter slot)
        this.il.OpCode(ILOpCode.Ldarga_s);
        this.il.CodeBuilder.WriteByte(0);

        // call instance void AsyncIteratorMethodBuilder::MoveNext<SM>(ref SM)
        var builderClrType = typeof(System.Runtime.CompilerServices.AsyncIteratorMethodBuilder);
        var openMoveNext = builderClrType.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance)
            .First(m => m.Name == "MoveNext" && m.IsGenericMethodDefinition && m.GetParameters().Length == 1);
        var openRef = this.outer.GetMethodReference(openMoveNext.GetGenericMethodDefinition());

        var smTypeDef = this.outer.cache.StructTypeDefs[node.SmClass];

        var sigBlob = new BlobBuilder();
        var argsEncoder = new BlobEncoder(sigBlob).MethodSpecificationSignature(1);
        argsEncoder.AddArgument().Type(smTypeDef, isValueType: false); // class, not struct

        var methodSpec = this.outer.emitCtx.Metadata.AddMethodSpecification(openRef, this.outer.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(methodSpec);
    }
}
