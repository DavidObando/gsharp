// <copyright file="MethodBodyEmitter.Statements.cs" company="GSharp">
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
import System.Threading.Tasks

/// PR-E-11 partial of (cref:MethodBodyEmitter):
/// statement-level emission — try/catch, scope, select, channel-send, go.
/// See `MethodBodyEmitter.cs` for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
internal partial class MethodBodyEmitter {
    // ADR-0125 / issue #1026: emits a `fixed` (pinning) statement. Pins the
    // managed buffer into a CLR pinned local, derives the unmanaged `*T`
    // pointer to element 0, then emits the body inside a try/finally that
    // releases the pin (nulls the pinned local) on every exit — mirroring
    // C#'s codegen. Pointer /
    // pinned-local IL is unverifiable by design (see ADR-0125 / ADR-0122);
    // the emit tests assert runtime behaviour and ignore the specific ilverify
    // codes the pattern triggers.
    private func EmitFixedStatement(node BoundFixedStatement) {
        let pinnedSlot = this.locals[node.PinnedVariable]
        let pointerSlot = this.locals[node.PointerVariable]
        if node.PinKind == FixedPinKind.Array {
            this.EmitFixedArrayPin(node, pinnedSlot, pointerSlot)
        } else if node.PinKind == FixedPinKind.PinnableReference {
            this.EmitFixedPinnableReferencePin(node, pinnedSlot, pointerSlot)
        } else if node.PinKind == FixedPinKind.FixedBuffer {
            this.EmitFixedBufferPin(node, pinnedSlot, pointerSlot)
        } else {
            this.EmitFixedStringPin(node, pinnedSlot, pointerSlot)
        }
        let tryStart = this.il.DefineLabel()
        let finallyStart = this.il.DefineLabel()
        let finallyEnd = this.il.DefineLabel()
        this.il.MarkLabel(tryStart)
        this.EmitProtectedRegion(cast[BoundBlockStatement](node.Body))
        this.il.Branch(ILOpCode.Leave, finallyEnd)
        this.il.MarkLabel(finallyStart)
        // Release the pin on normal, branch, return, and exceptional exits.
        if (node.PinKind is FixedPinKind.PinnableReference or FixedPinKind.FixedBuffer) {
            // The pinned local is a managed by-ref (`T& pinned`); release it by
            // storing a null managed pointer (`ldc.i4.0; conv.u`), exactly as the
            // C# compiler does for `fixed (T* p = span)` / `fixed (T* p = buf)`.
            this.il.LoadConstantI4(0)
            this.il.OpCode(ILOpCode.Conv_u)
            this.il.StoreLocal(pinnedSlot)
        } else {
            // Array (`T[] pinned`) / string (`string pinned`) release with `ldnull`.
            this.il.OpCode(ILOpCode.Ldnull)
            this.il.StoreLocal(pinnedSlot)
        }
        this.il.OpCode(ILOpCode.Endfinally)
        this.il.MarkLabel(finallyEnd)
        this.ControlFlow.AddFinallyRegion(tryStart, finallyStart, finallyStart, finallyEnd)
    }

    // Array-pin form: pin the array reference (`T[] pinned`) and derive
    // `&a[0]` via `ldelema`, guarding the null / zero-length array (→ null
    // pointer).
    private func EmitFixedArrayPin(node BoundFixedStatement, pinnedSlot int32, pointerSlot int32) {
        let elementType = (cast[PointerTypeSymbol](node.PointerVariable.Type)).PointeeType
        let nullLabel = this.il.DefineLabel()
        let notEmptyLabel = this.il.DefineLabel()
        let afterLabel = this.il.DefineLabel()
        this.EmitExpression(node.PinnedSource) // array reference
        this.il.OpCode(ILOpCode.Dup)
        this.il.StoreLocal(pinnedSlot) // pinned = arr
        this.il.Branch(ILOpCode.Brfalse, nullLabel)
        this.il.LoadLocal(pinnedSlot)
        this.il.OpCode(ILOpCode.Ldlen)
        this.il.OpCode(ILOpCode.Conv_i4)
        this.il.Branch(ILOpCode.Brtrue, notEmptyLabel)
        // Null or zero-length: pointer = null.
        this.il.MarkLabel(nullLabel)
        this.il.LoadConstantI4(0)
        this.il.OpCode(ILOpCode.Conv_u)
        this.il.StoreLocal(pointerSlot)
        this.il.Branch(ILOpCode.Br, afterLabel)
        // Non-empty: pointer = &arr[0].
        this.il.MarkLabel(notEmptyLabel)
        this.il.LoadLocal(pinnedSlot)
        this.il.LoadConstantI4(0)
        this.il.OpCode(ILOpCode.Ldelema)
        this.il.Token(this.outer.memberRefs.GetArrayElementTypeToken(elementType))
        this.EmitManagedPointerAsUnmanagedPointer(elementType, node.Syntax)
        this.il.StoreLocal(pointerSlot)
        this.il.MarkLabel(afterLabel)
    }

    // String-pin form: pin the `string` reference (`string pinned`) and derive
    // the char-data pointer through `GetPinnableReference`, guarding null
    // (→ null pointer).
    private func EmitFixedStringPin(node BoundFixedStatement, pinnedSlot int32, pointerSlot int32) {
        let nullLabel = this.il.DefineLabel()
        let afterLabel = this.il.DefineLabel()
        this.EmitExpression(node.PinnedSource) // string reference
        this.il.OpCode(ILOpCode.Dup)
        this.il.StoreLocal(pinnedSlot) // pinned = s
        this.il.Branch(ILOpCode.Brfalse, nullLabel)
        this.il.LoadLocal(pinnedSlot)
        // Issue #3755: probe the TARGET framework's `System.String`, not the
        // host's. `EmitContext.CoreStringType` is already resolved from the
        // reference closure; only this member probe still read off the host —
        // the #3705 shape, one arm of a pair updated and the other not.
        //
        // `String.GetPinnableReference()` is genuinely absent from
        // NETStandard.Library.Ref/2.1.0 even though `System.String` is present,
        // so the host probe used to succeed and emit a MemberRef naming a
        // method the target does not declare: a MissingMethodException at the
        // target's runtime, with no diagnostic at compile time. #3755 ranked
        // this site as hygiene on the grounds that its TYPE is never absent,
        // which is true and beside the point — the member is what varies.
        if !PinningShapes.TryGetStringGetPinnableReference(
            this.outer.emitCtx.CoreStringType,
            out var getPinnableReference
        ) {
            EmitDiagnosticException.ThrowTargetFrameworkMemberUnavailable(
                node.Syntax,
                PinningShapes.StringGetPinnableReferenceSignature
            )
        }
        this.il.Call(this.outer.memberRefs.GetMethodReference(getPinnableReference!!))
        this.EmitManagedPointerAsUnmanagedPointer(TypeSymbol.Char, node.Syntax)
        this.il.StoreLocal(pointerSlot)
        this.il.Branch(ILOpCode.Br, afterLabel)
        this.il.MarkLabel(nullLabel)
        this.il.LoadConstantI4(0)
        this.il.OpCode(ILOpCode.Conv_u)
        this.il.StoreLocal(pointerSlot)
        this.il.MarkLabel(afterLabel)
    }

    // Span-like pin form (ADR-0125 / issue #1043): pin the `T&` returned by a
    // public instance `ref T GetPinnableReference()` (e.g. `System.Span[T]` /
    // `System.ReadOnlySpan[T]`) into a `T& pinned` local, then derive `*T` via
    // `Unsafe.AsPointer<T>`. `GetPinnableReference()` already returns the data
    // pointer for an empty span (a ref to where element 0 would be), so no
    // null/empty guard is required.
    private func EmitFixedPinnableReferencePin(node BoundFixedStatement, pinnedSlot int32, pointerSlot int32) {
        let sourceVariable = Invariant.Required(
            node.SourceVariable,
            "the binder gives every PinnableReference-form fixed statement a source local; the caller dispatched on that PinKind to reach here",
            expression: "node.SourceVariable"
        )
        let sourceSlot = this.locals[sourceVariable]
        let sourceClr = node
            .PinnedSource
            .Type
            ?.ClrType ??
            throw InvalidOperationException("Span-like fixed source '${node.PinnedSource.Type?.Name}' has no CLR type.")
        let getPinnableReference = sourceClr.GetMethod(
            "GetPinnableReference",
            BindingFlags.Public | BindingFlags.Instance,
            binder: nil,
            types: Type.EmptyTypes,
            modifiers: nil
        ) ??
            throw InvalidOperationException(
            "Type '${sourceClr.FullName}' has no public instance GetPinnableReference() method."
        )
        // Spill the source value to a local so its address can feed the
        // instance call (`this` of a value-type method is a managed pointer).
        this.EmitExpression(node.PinnedSource)
        this.il.StoreLocal(sourceSlot)
        this.il.LoadLocalAddress(sourceSlot)
        this.il.OpCode(ILOpCode.Call)
        // Issue #2838: encode the parent through the SYMBOLIC source type, not
        // the `MethodInfo` alone. For `fixed p *T = span` inside a generic
        // method, `sourceClr` is the erased `Span<object>` (an open type
        // argument has no reference-context CLR type), so the plain MemberRef
        // path emitted `Span<object>::GetPinnableReference()` against a
        // `Span<!!T>` receiver — verifier-rejected `StackUnexpected`.
        // `GetMethodEntityHandle` re-encodes the parent TypeSpec from the
        // symbol's real type arguments, and falls through to the plain
        // MemberRef when the container is non-generic or fully closed.
        this.il.Token(
            this.outer.memberRefs.GetMethodEntityHandle(getPinnableReference, node.PinnedSource.Type)
        ) // -> T&
        this.il.StoreLocal(pinnedSlot) // T& pinned = ref
        this.il.LoadLocal(pinnedSlot)
        this.EmitManagedPointerAsUnmanagedPointer(
            (cast[PointerTypeSymbol](node.PointerVariable.Type)).PointeeType,
            node.Syntax
        )
        this.il.StoreLocal(pointerSlot) // p = (T*)ref

    }

    // Fixed-size buffer pin form (ADR-0125 amendment / issue #4378): the binder
    // lowered the source to the managed reference
    // `ref recv.name.FixedElementField`, which emits as the `ldflda` chain C#
    // produces for `fixed (T* p = recv.name)`. Store it into the `T& pinned`
    // local (pinning the buffer's containing object), then derive `*T` via
    // `Unsafe.AsPointer<T>`. A buffer is never null or empty, so no guard.
    private func EmitFixedBufferPin(node BoundFixedStatement, pinnedSlot int32, pointerSlot int32) {
        // Address the buffer field exactly as its `*T` decay does (so every
        // receiver shape the decay supports pins the same storage), then step
        // to the element field at offset 0.
        let elementAccess = cast[BoundFieldAccessExpression](
            (cast[BoundAddressOfExpression](node.PinnedSource)).Operand
        )
        let bufferAccess = Invariant.Required(
            elementAccess.Receiver as BoundFieldAccessExpression,
            "the binder roots a fixed-buffer pin at the buffer field access",
            expression: "elementAccess.Receiver as BoundFieldAccessExpression"
        )
        this.EmitFieldAddress(bufferAccess) // &recv.name
        this.il.OpCode(ILOpCode.Ldflda)
        this.il.Token(this.ResolveFieldAddressHandle(elementAccess)) // &recv.name.FixedElementField
        this.il.StoreLocal(pinnedSlot) // T& pinned = ref recv.name.FixedElementField
        this.il.LoadLocal(pinnedSlot)
        this.EmitManagedPointerAsUnmanagedPointer(
            (cast[PointerTypeSymbol](node.PointerVariable.Type)).PointeeType,
            node.Syntax
        )
        this.il.StoreLocal(pointerSlot) // p = (T*)ref

    }

    private func EmitManagedPointerAsUnmanagedPointer(pointeeType TypeSymbol, anchor SyntaxNode?) {
        // Issue #3755 (issue #3705, family 3): resolve `Unsafe` from the
        // compilation's reference closure, not from the SDK hosting gsc.
        //
        // #3755 ranked this site as hygiene because "none of the types involved
        // is plausibly absent from a target framework". Measured, that is
        // false: `System.Runtime.CompilerServices.Unsafe` is absent from
        // NETStandard.Library.Ref/2.1.0 — it is a NuGet package there, not part
        // of the framework. With the host `typeof` this probe always succeeded,
        // #3729's GetTypeReference projection had nothing to project onto, and
        // EVERY `fixed` statement compiled against a netstandard2.x closure
        // emitted `System.Runtime.CompilerServices.Unsafe` scoped to the host's
        // `System.Private.CoreLib` while the compile reported success. That is
        // #3730's defect, on a different member.
        if !PinningShapes.TryGetUnsafeAsPointer(this.outer.emitCtx.References, out var openAsPointer) {
            EmitDiagnosticException.ThrowTargetFrameworkMemberUnavailable(
                anchor,
                PinningShapes.UnsafeAsPointerSignature
            )
        }
        // CloseOver projects the type argument into the resolved definition's
        // reflection context first: the pointee is frequently a built-in
        // TypeSymbol wrapping a host RuntimeType while `openAsPointer` now
        // belongs to the reference closure, and closing across contexts yields
        // a MethodBuilderInstantiation whose GetParameters() answers the
        // unsubstituted `T` (the #3752 artefact) instead of failing loudly.
        let closedAsPointer = PinningShapes.CloseOver(openAsPointer!!, pointeeType.ClrType ?? typeof(object))
        let symbolicTypeArguments = ImmutableArray.Create[TypeSymbol?](pointeeType)
        this.il.Call(
            this.outer.memberRefs.GetMethodEntityHandle(closedAsPointer, typeArgSymbols: symbolicTypeArguments)
        )
    }

    private func EmitTryStatement(node BoundTryStatement) {
        this.tryDepth++
        try {
            this.EmitTryStatementCore(node)
        } finally {
            this.tryDepth--
        }
    }

    private func EmitTryStatementCore(node BoundTryStatement) {
        let endLabel = this.il.DefineLabel()
        let hasCatches = node.CatchClauses.Length > 0
        let finallyBlock BoundStatement? = node.FinallyBlock
        if hasCatches && finallyBlock != nil {
            // Nested: outer try-finally wrapping inner try-catch.
            let outerTryStart = this.il.DefineLabel()
            let innerTryStart = this.il.DefineLabel()
            let finallyStart = this.il.DefineLabel()
            let finallyEnd = this.il.DefineLabel()
            this.il.MarkLabel(outerTryStart)
            this.il.MarkLabel(innerTryStart)
            this.EmitProtectedRegion(cast[BoundBlockStatement](node.TryBlock))
            let innerTryEnd = this.il.DefineLabel()
            this.il.Branch(ILOpCode.Leave, endLabel)
            this.il.MarkLabel(innerTryEnd)
            this.EmitCatchClauses(node.CatchClauses, innerTryStart, innerTryEnd, leaveTarget: endLabel)
            this.il.MarkLabel(finallyStart)
            this.EmitProtectedRegion(cast[BoundBlockStatement](finallyBlock))
            this.il.OpCode(ILOpCode.Endfinally)
            this.il.MarkLabel(finallyEnd)
            this.ControlFlow.AddFinallyRegion(outerTryStart, finallyStart, finallyStart, finallyEnd)
        } else if hasCatches {
            let tryStart = this.il.DefineLabel()
            this.il.MarkLabel(tryStart)
            this.EmitProtectedRegion(cast[BoundBlockStatement](node.TryBlock))
            let tryEnd = this.il.DefineLabel()
            this.il.Branch(ILOpCode.Leave, endLabel)
            this.il.MarkLabel(tryEnd)
            this.EmitCatchClauses(node.CatchClauses, tryStart, tryEnd, leaveTarget: endLabel)
        } else {
            // finally only
            let tryStart = this.il.DefineLabel()
            let finallyStart = this.il.DefineLabel()
            let finallyEnd = this.il.DefineLabel()
            this.il.MarkLabel(tryStart)
            this.EmitProtectedRegion(cast[BoundBlockStatement](node.TryBlock))
            this.il.Branch(ILOpCode.Leave, finallyEnd)
            this.il.MarkLabel(finallyStart)
            this.EmitProtectedRegion(
                cast[BoundBlockStatement](
                    Invariant.Required(
                        finallyBlock,
                        "this is the no-catch branch, and the binder does not produce a try with neither catch nor finally",
                        expression: "finallyBlock"
                    )
                )
            )
            this.il.OpCode(ILOpCode.Endfinally)
            this.il.MarkLabel(finallyEnd)
            this.ControlFlow.AddFinallyRegion(tryStart, finallyStart, finallyStart, finallyEnd)
        }
        this.il.MarkLabel(endLabel)
    }

    private func EmitCatchClauses(
        clauses ImmutableArray[BoundCatchClause],
        tryStart LabelHandle,
        tryEnd LabelHandle,
        leaveTarget LabelHandle
    ) {
        for clause in clauses {
            // ADR-0177 B: a `when` filter becomes a real CLR filter region, not
            // a test at the top of the handler. That difference is observable:
            // the filter runs in the exception system's *first* pass, so it sees
            // the stack before any intervening `finally` unwinds it, and a false
            // result declines this clause and resumes the search at the next
            // sibling handler rather than swallowing-and-rethrowing.
            //
            // A filter region carries no type token — the CLR hands the filter
            // the exception object and asks a yes/no question — so the type test
            // the catch type would otherwise express has to be emitted inline,
            // ahead of the user's condition:
            //
            //     filterStart:  isinst <catchType>
            //                   dup
            //                   brtrue  matched
            //                   pop
            //                   ldc.i4.0            ; wrong type: decline
            //                   br      done
            //     matched:      stloc   <variable>  ; or pop when unbound
            //                   <filter expression>
            //     done:         endfilter
            //     handlerStart: pop                 ; CLR re-pushes the exception
            //
            // The handler always pops, because the filter already stored the
            // exception into the clause variable on the matched path.
            var filterStart = default(LabelHandle)
            if clause.Filter != nil {
                filterStart = this.il.DefineLabel()
                this.il.MarkLabel(filterStart)
                let matched = this.il.DefineLabel()
                let done = this.il.DefineLabel()
                this.il.OpCode(ILOpCode.Isinst)
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(clause.ExceptionType))
                this.il.OpCode(ILOpCode.Dup)
                this.il.Branch(ILOpCode.Brtrue, matched)
                this.il.OpCode(ILOpCode.Pop)
                this.il.OpCode(ILOpCode.Ldc_i4_0)
                this.il.Branch(ILOpCode.Br, done)
                this.il.MarkLabel(matched)
                if clause.Variable == nil || !this.HasStorageSlot(clause.Variable) {
                    this.il.OpCode(ILOpCode.Pop)
                } else {
                    this.EmitStoreVariable(clause.Variable)
                }
                this.EmitExpression(clause.Filter!!)
                this.il.MarkLabel(done)
                this.il.OpCode(ILOpCode.Endfilter)
            }
            let handlerStart = this.il.DefineLabel()
            let handlerEnd = this.il.DefineLabel()
            this.il.MarkLabel(handlerStart)
            // ADR-0174 P3-8: a MoveNext body's outermost catch is the
            // builder's SetException route; the async-stepping blob names it.
            if this.tryDepth == 1 && this.outermostCatchHandlerOffset < 0 {
                this.outermostCatchHandlerOffset = this.il.Offset
            }
            // Stack contains the caught exception; store into the catch variable.
            // Issue #420 (P3-6): the binder is currently expected to always
            // provide a catch variable with an allocated slot, but if a future
            // binder pass elides an unused catch variable (or leaves it without
            // a slot) we still need to consume the exception object the CLR
            // pushed onto the evaluation stack on entry to the handler --
            // otherwise the handler starts with an unbalanced stack and the
            // generated IL becomes unverifiable. Defensively emit `pop` in
            // that case instead of dereferencing a null variable.
            //
            // ADR-0177: an unbound `catch (Type)` / bare `catch` reaches the
            // same `pop` by design rather than defensively, and so does every
            // filtered clause, whose filter already did the store.
            if clause.Filter != nil || clause.Variable == nil || !this.HasStorageSlot(clause.Variable) {
                this.il.OpCode(ILOpCode.Pop)
            } else {
                this.EmitStoreVariable(clause.Variable)
            }
            this.EmitProtectedRegion(cast[BoundBlockStatement](clause.Body))
            this.il.Branch(ILOpCode.Leave, leaveTarget)
            this.il.MarkLabel(handlerEnd)
            if clause.Filter != nil {
                this.ControlFlow.AddFilterRegion(tryStart, tryEnd, handlerStart, handlerEnd, filterStart)
                continue
            }
            // Issue #421 (P2-6): user-defined exception classes have ClrType == null
            // at emit time, so fall back to the emitter's user-defined type registry
            // via GetElementTypeToken (which handles both CLR-backed and source-defined
            // types) instead of dereferencing ClrType directly.
            let catchTypeHandle = this.outer.memberRefs.GetElementTypeToken(clause.ExceptionType)
            this.ControlFlow.AddCatchRegion(tryStart, tryEnd, handlerStart, handlerEnd, catchTypeHandle)
        }
    }

    // Emits a block as a protected region: pushes the lexical label set so
    // gotos targeting labels outside the region are translated to `leave`.
    private func EmitProtectedRegion(block BoundBlockStatement) {
        let labelSet = HashSet[BoundLabel]()
        this.CollectLabels(block, labelSet)
        this.protectedRegionStack.Push(labelSet)
        try {
            this.EmitBlock(block)
        } finally {
            this.protectedRegionStack.Pop()
        }
    }

    private func EmitGoStatement(node BoundGoStatement) {
        // ADR-0174 D5: newobj <go_N>(captures); ldftn InvokeAction; newobj
        // Func<ValueTask>; <sink or null>; call GoroutineRuntime.Start. The
        // runtime's work item registers with the sink before queueing and
        // consumes the body's ValueTask exactly once; no Task is allocated.
        this.EmitGoAction(node)
        if node.Sink != nil {
            this.EmitExpression(node.Sink)
        } else {
            this.il.OpCode(ILOpCode.Ldnull)
        }
        if !this
            .outer
            .emitCtx
            .References
            .TryResolveType(
            "Gsharp.Concurrency.GoroutineRuntime",
            requireExternalVisibility: false,
            out var runtimeType
        ) ||
            runtimeType == nil {
            throw InvalidOperationException(
                "The channel runtime (Gsharp.Concurrency.GoroutineRuntime) is not in the reference set; the binder should have reported GS0546."
            )
        }
        let start = runtimeType.GetMethods(BindingFlags.Public | BindingFlags.Static).Single(
            (m MethodInfo) -> m.Name == "Start" && m.GetParameters().Length == 2
        )
        this.il.Call(this.outer.memberRefs.GetMethodEntityHandle(start))
    }

    private func EmitGoAction(node BoundGoStatement) {
        if !this.outer.closures.TryGetGoClosure(node, out var closure) {
            throw InvalidOperationException("Go statement has no synthesized display class.")
        }
        if !this.outer.cache.ClassCtorHandles.TryGetValue(closure!!.ClassSym, out var ctorHandle) {
            throw InvalidOperationException("Go display class '${closure!!.ClassSym.Name}' has no emitted constructor.")
        }
        if !this.outer.cache.MethodHandles.TryGetValue(closure!!.InvokeMethod, out var invokeHandle) {
            throw InvalidOperationException(
                "Go display invoke method '${closure!!.InvokeMethod.Name}' has no emitted MethodDef."
            )
        }
        let constructedClosure = closure!!.ConstructedClassSym
        let closureIsGeneric = ReflectionMetadataEmitter.IsUserGenericTypeReference(constructedClosure)
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(
            if closureIsGeneric {
                this.outer.userTokens.ResolveUserCtorTokenForDefault(constructedClosure)
            } else {
                ctorHandle
            }
        )
        for captured in closure!!.CaptureFields.Keys {
            let field = closure!!.CaptureFields[captured]
            var fieldToken EntityHandle
            if closureIsGeneric {
                fieldToken = this.outer.userTokens.ResolveFieldToken(constructedClosure, field)
            } else if this.outer.cache.StructFieldDefs.TryGetValue(field, out var fieldHandle) {
                fieldToken = fieldHandle
            } else {
                throw InvalidOperationException("Go display field '${field.Name}' has no emitted FieldDef.")
            }
            this.il.OpCode(ILOpCode.Dup)
            this.EmitExpression(BoundVariableExpression(nil, captured))
            this.il.OpCode(ILOpCode.Stfld)
            this.il.Token(fieldToken)
        }
        let invokeToken = if closureIsGeneric {
            this
                .outer
                .userTokens
                .ResolveClosureInvokeFtnToken(constructedClosure, closure!!.ClassSym, closure!!.InvokeMethod)
        } else {
            invokeHandle
        }
        let funcValueTaskCtor = BclMember.Ctor(typeof(() -> ValueTask), typeof(object), typeof(nint))
        this.il.OpCode(ILOpCode.Ldftn)
        this.il.Token(invokeToken)
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(this.outer.memberRefs.GetCtorReference(funcValueTaskCtor))
    }

    private func EmitChannelReaderView(chType ChannelTypeSymbol, getReader MethodInfo) {
        if chType.Direction == ChannelDirection.Both {
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(this.GetChannelMethodEntityHandle(getReader, chType.ElementType))
        }
    }

    private func EmitChannelWriterView(chType ChannelTypeSymbol, getWriter MethodInfo) {
        if chType.Direction == ChannelDirection.Both {
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(this.GetChannelMethodEntityHandle(getWriter, chType.ElementType))
        }
    }
}
