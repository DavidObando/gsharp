// <copyright file="MethodBodyEmitter.Expressions.cs" company="GSharp">
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
import System.Globalization
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

/// PR-E-11 partial of (cref:MethodBodyEmitter):
/// expression dispatch and literal/aggregate emission.
/// See `MethodBodyEmitter.cs` for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
internal partial class MethodBodyEmitter {
    private func EmitExpression(expression BoundExpression) {
        this.EmitExpressionCore(expression)
        if !this.SuppressNativeProtocolValidation {
            this.EmitNativeProtocolValidation(expression.Type)
        }
    }

    private func EmitExpressionCore(expression BoundExpression) {
        if expression.Syntax != nil {
            this.currentNode = expression
        }
        switch expression {
            case utf8 is BoundUtf8StringExpression {
                this.il.OpCode(ILOpCode.Ldtoken)
                this.il.Token(this.outer.utf8Data.GetField(utf8))
                this.il.Call(this.outer.memberRefs.GetMethodEntityHandle(utf8.CreateSpan))
                let slot = this.receiverSpillSlots[utf8]
                this.il.StoreLocal(slot)
                this.il.LoadLocalAddress(slot)
                this.il.LoadConstantI4(0)
                this.il.LoadConstantI4(utf8.Bytes.Length)
                this.il.Call(this.outer.memberRefs.GetMethodEntityHandle(utf8.Slice))
            }
            case literal is BoundLiteralExpression {
                this.EmitLiteral(literal)
            }
            case v is BoundVariableExpression {
                this.EmitLoadVariable(v.Variable)
                this.EmitNarrowingCastIfNeeded(v)
            }
            case a is BoundAssignmentExpression {
                if a.Variable is ParameterSymbol assignParam && assignParam.RefKind != RefKind.None {
                    // ADR-0060: assign-through-ref-kind-parameter lowers to
                    // `ldarg ptr; value; dup; stloc tmp; stind.*; ldloc tmp`
                    // so the expression result is the assigned value without
                    // a re-read through ldind. The temp slot is pre-allocated
                    // by AssignmentValueSpillCollector and stored in
                    // receiverSpillSlots keyed by the assignment node.
                    let assignArgIndex = this.parameters[assignParam]
                    let assignTmp = this.receiverSpillSlots[a]
                    this.il.LoadArgument(assignArgIndex)
                    this.EmitExpression(a.Expression)
                    this.il.OpCode(ILOpCode.Dup)
                    this.il.StoreLocal(assignTmp)
                    this.EmitStoreIndirect(assignParam.Type)
                    this.il.LoadLocal(assignTmp)
                } else if a.Variable is LocalVariableSymbol assignLocal &&
                    assignLocal.RefKind != RefKind.None &&
                    this
                    .locals
                    .TryGetValue(assignLocal, out var refLocalSlot) {
                    // Issue #491 (ADR-0060 follow-up): assign-through-ref-alias-local lowers to
                    // `ldloc slot; value; dup; stloc tmp; stind.*; ldloc tmp`.
                    // The temp slot is pre-allocated by AssignmentValueSpillCollector.
                    let assignTmp = this.receiverSpillSlots[a]
                    this.il.LoadLocal(refLocalSlot)
                    this.EmitExpression(a.Expression)
                    this.il.OpCode(ILOpCode.Dup)
                    this.il.StoreLocal(assignTmp)
                    this.EmitStoreIndirect(assignLocal.Type)
                    this.il.LoadLocal(assignTmp)
                } else {
                    this.EmitExpression(a.Expression)
                    this.il.OpCode(ILOpCode.Dup)
                    this.EmitStoreVariable(a.Variable)
                }
            }
            case ia is BoundIndirectAssignmentExpression {
                {
                    // ADR-0060 §5/§13: `*p = v` lowers to
                    // `<pointer>; <value>; dup; stloc tmp; stind.*; ldloc tmp`
                    // so the expression yields the assigned value once.
                    let iaTmp = this.receiverSpillSlots[ia]
                    this.EmitExpression(ia.Pointer)
                    this.EmitExpression(ia.Value)
                    this.il.OpCode(ILOpCode.Dup)
                    this.il.StoreLocal(iaTmp)
                    this.EmitStoreIndirect(ia.Type)
                    this.il.LoadLocal(iaTmp)
                }
            }
            case u is BoundUnaryExpression {
                this.EmitUnary(u)
            }
            case b is BoundBinaryExpression {
                this.EmitBinary(b)
            }
            case call is BoundCallExpression {
                this.EmitCallExpressionCore(call)
                // ADR-0087 §3 R3+R4: after R2/R3, every G# call (MethodSpec'd
                // or plain MethodDef) returns the method's reified signature.
                // No erasure-widening is required at the call boundary; the
                // surrounding code path (assignment, return, argument
                // conversion) handles any further coercion.
                //
                // Issue #3879: except for the by-ref return, which is a
                // representation difference the call boundary DOES have to
                // settle — a `ref`-returning function or static property
                // accessor leaves `T&` where the bound tree says `T`.
                this.EmitRefReturnDereferenceIfNeeded(call.Function.ReturnRefKind, call.Type)
            }
            case impCall is BoundImportedCallExpression {
                this.EmitImportedCallArguments(impCall.Arguments, impCall.ArgumentRefKinds)
                // Issue #1330: a static call on a generic type constructed over
                // an in-scope generic type parameter (`Comparer[TResult].Create`)
                // must be referenced through a MemberRef parented at the
                // constructed `Comparer<!TResult>` TypeSpec — the symbolic
                // container — rather than the type-erased `Comparer<object>`. The
                // call then leaves the symbolic return (`Comparer<!TResult>`) on
                // the stack, so skip the erased widening exactly as the symbolic
                // instance/extension paths do.
                if impCall.StaticContainerType != nil {
                    // Issue #3868: pass the method type-argument vector too.
                    // The #1330 path never supplied one (it declines generic
                    // methods), but the params/defaulted fallback that now also
                    // carries a symbolic container can, and dropping it would
                    // emit the placeholder-closed MethodSpec.
                    this.il.Call(
                        this
                            .outer
                            .memberRefs
                            .GetMethodEntityHandle(
                            impCall.Function.Method,
                            impCall.TypeArgumentSymbols,
                            impCall.StaticContainerType
                        )
                    )
                    break
                }
                this.il.Call(
                    this.outer.memberRefs.GetMethodEntityHandle(impCall.Function.Method, impCall.TypeArgumentSymbols)
                )
                // Issue #903: when this generic imported (extension) call was
                // closed over a same-compilation user element type, the emitted
                // MethodSpec returns the reprojected type directly on the stack
                // (a raw value for a struct element, a reference for a class) —
                // NOT the type-erased `object` the placeholder-closed
                // `Method.ReturnType` reports. Feeding that erased placeholder
                // into the widening would emit a fatal `unbox.any Check` over a
                // struct value (ilverify StackObjRef + runtime crash) or a
                // redundant `castclass` over a class reference. Skip the
                // widening, mirroring the symbolic instance-method path below.
                if this
                    .outer
                    .userTokens
                    .TryGetSymbolicSubstitutedImportedCallReturn(
                    impCall.Function.Method,
                    impCall.TypeArgumentSymbols,
                    out _
                ) {
                    break
                }
                this.EmitErasedObjectReturnWidening(impCall.Function.Method.ReturnType, impCall.Type)
            }
            case staticCall is BoundClrStaticCallExpression {
                this.EmitImportedCallArguments(staticCall.Arguments, staticCall.ArgumentRefKinds)
                if ManagedReferenceTypes.IsDefinition(staticCall.Method.DeclaringType, out _) &&
                    ManagedReferenceTypes
                    .TryGetElement(staticCall.Type, out _, out _) {
                    this.il.Call(this.outer.memberRefs.GetMethodEntityHandle(staticCall.Method, staticCall.Type))
                } else {
                    this.il.Call(this.outer.memberRefs.GetMethodEntityHandle(staticCall.Method))
                    this.EmitErasedObjectReturnWidening(staticCall.Method.ReturnType, staticCall.Type)
                }
            }
            case instCall is BoundImportedInstanceCallExpression {
                {
                    // Issue #943: a call dispatched through a type parameter's
                    // CLR interface constraint (e.g. `a.CompareTo(b)` with
                    // `T : IComparable[T]`) emits a verifiable
                    // `constrained. !!T  callvirt IComparable`1<!!T>::M(...)`.
                    if instCall.IsConstrainedTypeParameterCall {
                        this.EmitConstrainedTypeParameterReceiver(instCall.Receiver)
                        this.EmitImportedCallArguments(instCall.Arguments, instCall.ArgumentRefKinds)
                        let constrainedHandle = this
                            .outer
                            .memberRefs
                            .GetMethodEntityHandle(
                            instCall.Method,
                            instCall.TypeArgumentSymbols,
                            instCall.ConstrainedInterfaceType
                        )
                        this.il.OpCode(ILOpCode.Constrained)
                        this.il.Token(
                            this.outer.memberRefs.GetElementTypeToken(instCall.ConstrainedReceiverTypeParameter!!)
                        )
                        this.il.OpCode(ILOpCode.Callvirt)
                        this.il.Token(constrainedHandle)
                        break
                    }
                    let receiverType = if instCall.Receiver.Type is ByRefTypeSymbol byRef {
                        byRef.PointeeType
                    } else {
                        instCall.Receiver.Type
                    }
                    let receiverIsValueType = ReflectionMetadataEmitter.IsValueTypeSymbol(receiverType)
                    let receiverIsManagedPointer = instCall.Receiver.Type is ByRefTypeSymbol
                    // A value-type receiver invoking a method it inherits from a
                    // reference base type (System.Object/ValueType/Enum) — e.g.
                    // GetType(), or ToString()/Equals()/GetHashCode() when the
                    // value type does not override them — must be boxed. The
                    // callee's `this` is an object reference, not a managed
                    // pointer to the value; without the box the raw value bits
                    // are reinterpreted as a reference, producing an
                    // AccessViolationException (or silent corruption) at runtime.
                    let receiverNeedsBox = ReflectionMetadataEmitter.ImportedInstanceReceiverRequiresBoxing(
                        receiverType,
                        instCall.Method
                    )
                    // A value type calling a method it declares itself receives a
                    // managed pointer (`this` is `ref TStruct`) and uses `call`;
                    // a boxed value or a reference receiver uses `callvirt`.
                    let useCall = receiverIsValueType && !receiverNeedsBox
                    if receiverNeedsBox {
                        // Load the receiver value (not its address) and box it so
                        // the inherited reference-type method receives a proper
                        // object reference.
                        this.EmitExpression(instCall.Receiver)
                        if receiverIsManagedPointer {
                            this.EmitLoadIndirect(receiverType)
                        }
                        this.il.OpCode(ILOpCode.Box)
                        this.il.Token(this.outer.memberRefs.GetElementTypeToken(receiverType))
                    } else {
                        this.EmitInstanceReceiver(
                            instCall.Receiver,
                            isReadOnlyCall: RefCapabilities.IsReadOnlyMethod(instCall.Method)
                        )
                    }
                    this.EmitImportedCallArguments(instCall.Arguments, instCall.ArgumentRefKinds)
                    let instCallHandle = this
                        .outer
                        .memberRefs
                        .GetMethodEntityHandle(instCall.Method, instCall.TypeArgumentSymbols, receiverType)
                    // Issue #1260: a `base.Member(...)` access into an imported/BCL
                    // base class emits a non-virtual `call` (never `callvirt`),
                    // exactly like C# `base.M(...)`. `callvirt` would re-dispatch
                    // through the v-table and re-enter the derived override.
                    this.il.OpCode(
                        if (useCall || instCall.IsNonVirtualBaseCall) {
                            ILOpCode.Call
                        } else {
                            ILOpCode.Callvirt
                        }
                    )
                    this.il.Token(instCallHandle)
                    // Issue #832: when the receiver is a symbolic open-generic
                    // container (e.g. `Queue[T]` with an in-scope `T`), the
                    // MemberRef is parented at the symbolic instantiation and
                    // the runtime stack value after `callvirt` is the
                    // substituted symbolic return (`!T`) — NOT the closed CLR
                    // `object` that `instCall.Method.ReturnType` reports for
                    // the type-erased close. Skip the erasure-widening so we
                    // don't emit a spurious `unbox.any T` against a stack slot
                    // that already holds `T`. The spurious unbox passed
                    // ilverify at the source method but produced a runtime
                    // NullReferenceException once a state-machine rewrite
                    // (e.g. iterator MoveNext) re-inspected the IL.
                    if this
                        .outer
                        .userTokens
                        .TryGetSymbolicSubstitutedInstanceMethodReturn(receiverType, instCall.Method, out _) {
                        break
                    }
                    // The receiver may be an ordinary imported type while the
                    // METHOD's type argument is a same-compilation symbol — a
                    // `SelectWaiter.TakeValue[Pair]`, say (ADR-0174 D8). The
                    // emitted token already returns `Pair`, so widening it as if
                    // the reflected `object` return had travelled would unbox a
                    // value that was never boxed.
                    if this
                        .outer
                        .userTokens
                        .TryGetSymbolicSubstitutedImportedCallReturn(
                        instCall.Method,
                        instCall.TypeArgumentSymbols,
                        out _
                    ) {
                        break
                    }
                    this.EmitErasedObjectReturnWidening(instCall.Method.ReturnType, instCall.Type)
                }
            }
            case cstatic is BoundConstrainedStaticCallExpression {
                this.EmitConstrainedStaticCall(cstatic)
                // Issue #3879: a `constrained.` static-interface call resolves
                // to a G#-declared interface member when InterfaceMethod is
                // present (the ClrMethod arm is an imported signature, whose
                // by-ref return the imported paths already handle).
                this.EmitRefReturnDereferenceIfNeeded(
                    cstatic.InterfaceMethod?.ReturnRefKind ?? RefKind.None,
                    cstatic.Type
                )
            }
            case addressOf is BoundAddressOfExpression {
                this.EmitAddressOf(addressOf)
            }
            case key is BoundManagedFieldKeyExpression {
                this.EmitManagedFieldKey(key)
            }
            case conditionalAddress is BoundConditionalAddressExpression {
                // ADR-0061: conditional address-of (`cond ? &a : &b`).
                this.EmitConditionalAddress(conditionalAddress)
            }
            case conditionalValue is BoundConditionalExpression {
                // ADR-0062: general two-arm conditional value expression.
                this.EmitConditional(conditionalValue)
            }
            case throwExpr is BoundThrowExpression {
                // Issue #1018: throw-expression in value position. Emit the
                // operand then CIL `throw`, which never returns — no value is
                // left on the evaluation stack and the code after is
                // unreachable. The surrounding `??` / conditional merge point is
                // verifiable because this branch never reaches it.
                this.EmitExpression(throwExpr.Expression)
                this.il.OpCode(ILOpCode.Throw)
            }
            case deref is BoundDereferenceExpression {
                this.EmitDereference(deref)
            }
            case awaitOnCompleted is BoundStateMachineAwaitOnCompleted {
                this.EmitStateMachineAwaitOnCompleted(awaitOnCompleted)
            }
            case builderMoveNext is BoundStateMachineBuilderMoveNext {
                this.EmitAsyncIteratorBuilderMoveNext(builderMoveNext)
            }
            case conv is BoundConversionExpression {
                this.EmitConversion(conv)
            }
            case arr is BoundArrayCreationExpression {
                this.EmitArrayCreation(arr)
            }
            case stackAlloc is BoundStackAllocExpression {
                this.EmitStackAlloc(stackAlloc)
            }
            case idx is BoundIndexExpression {
                if GetRectangularArrayType(idx.Target.Type) is {} rectangular {
                    this.EmitExpression(idx.Target)
                    for index in idx.Indices {
                        this.EmitExpression(index)
                    }
                    this.il.OpCode(ILOpCode.Call)
                    this.il.Token(this.outer.memberRefs.GetRectangularArrayMemberReference(rectangular, "Get"))
                } else if idx.Target.Type is MapTypeSymbol {
                    this.EmitMapIndexRead(idx)
                } else if idx.Target.Type == TypeSymbol.String {
                    // Issue #537: string indexing via get_Chars(int32).
                    this.EmitExpression(idx.Target)
                    this.EmitExpression(idx.Index)
                    this.il.OpCode(ILOpCode.Callvirt)
                    this.il.Token(this.outer.wellKnown.GetStringCharsReference())
                } else {
                    this.EmitExpression(idx.Target)
                    this.EmitExpression(idx.Index)
                    this.EmitLoadElement(idx.Type)
                }
            }
            case ixa is BoundIndexAssignmentExpression {
                let ixaTargetType = ixa.TargetExpression?.Type ?? BoundNodeForm.VariableTarget(ixa).Type
                if ixaTargetType is MapTypeSymbol {
                    this.EmitMapIndexAssignment(ixa)
                } else if GetRectangularArrayType(ixaTargetType) is {} assignmentRectangular {
                    let tmp = this.indexAssignmentValueSlots[ixa]
                    if ixa.TargetExpression != nil {
                        this.EmitExpression(ixa.TargetExpression)
                    } else {
                        this.EmitLoadVariable(BoundNodeForm.VariableTarget(ixa))
                    }
                    for index in ixa.Indices {
                        this.EmitExpression(index)
                    }
                    this.EmitExpression(ixa.Value)
                    this.il.OpCode(ILOpCode.Dup)
                    this.il.StoreLocal(tmp)
                    this.il.OpCode(ILOpCode.Call)
                    this.il.Token(
                        this.outer.memberRefs.GetRectangularArrayMemberReference(assignmentRectangular, "Set")
                    )
                    this.il.LoadLocal(tmp)
                } else {
                    // Issue #418 (P1-1): evaluate target/index/value exactly once.
                    // dup + stloc tmp + stelem + ldloc tmp leaves the assigned
                    // value on the stack as the expression's result without
                    // re-evaluating the index expression (which may have side
                    // effects, e.g. a function call).
                    let tmp = this.indexAssignmentValueSlots[ixa]
                    if ixa.TargetExpression != nil {
                        this.EmitExpression(ixa.TargetExpression)
                    } else {
                        this.EmitLoadVariable(BoundNodeForm.VariableTarget(ixa))
                    }
                    this.EmitExpression(ixa.Index)
                    this.EmitExpression(ixa.Value)
                    this.il.OpCode(ILOpCode.Dup)
                    this.il.StoreLocal(tmp)
                    this.EmitStoreElement(ixa.Type)
                    this.il.LoadLocal(tmp)
                }
            }
            case len is BoundLenExpression {
                this.EmitLen(len)
            }
            case typeOf is BoundTypeOfExpression {
                this.EmitTypeOf(typeOf)
            }
            case sizeOf is BoundSizeOfExpression {
                this.EmitSizeOf(sizeOf)
            }
            case fnFromMethod is BoundFunctionPointerFromMethodExpression {
                this.EmitFunctionPointerFromMethod(fnFromMethod)
            }
            case fnInvoke is BoundFunctionPointerInvocationExpression {
                this.EmitFunctionPointerInvocation(fnInvoke)
            }
            case structLit is BoundStructLiteralExpression {
                this.EmitStructLiteral(structLit)
            }
            case blockExpr is BoundBlockExpression {
                this.EmitBlockExpression(blockExpr)
            }
            case switchExpr is BoundSwitchExpression {
                this.EmitSwitchExpression(switchExpr)
            }
            case ctorCall is BoundConstructorCallExpression {
                this.EmitConstructorCall(ctorCall)
            }
            case ctorChain is BoundConstructorChainingExpression {
                this.EmitConstructorChaining(ctorChain)
            }
            case uic is BoundUserInstanceCallExpression {
                this.EmitUserInstanceCall(uic)
                // Issue #3879: covers a `ref`-returning instance method AND a
                // `ref`-returning INDEXER, whose read binds to a call of the
                // `get_Item` accessor symbol rather than to a property access.
                this.EmitRefReturnDereferenceIfNeeded(uic.Method.ReturnRefKind, uic.Type)
            }
            case bic is BoundBaseInterfaceCallExpression {
                this.EmitBaseInterfaceCall(bic)
                // Issue #3879: `base.RefMethod()` through a default-interface
                // implementation is a source-member call like any other, so it
                // owes the same dereference. Missing it here left `T&` on the
                // stack where the bound node says `T` — the raw-address read
                // this issue exists to fix, just reached by a rarer path.
                this.EmitRefReturnDereferenceIfNeeded(bic.Method.ReturnRefKind, bic.Type)
            }
            case bcc is BoundBaseClassCallExpression {
                this.EmitBaseClassCall(bcc)
                // Issue #3879: the base-class form carries EITHER a method
                // (`base.RefMethod()`) or a property accessor (`base.RefProp`,
                // issue #1347) — never both — so take the ref-kind from
                // whichever is present. A setter accessor pushes nothing to
                // dereference, hence the read-only guard.
                this.EmitRefReturnDereferenceIfNeeded(
                    bcc
                        .Method
                        ?.ReturnRefKind ??
                        (
                        if bcc.IsSetterAccessor {
                            RefKind.None
                        } else {
                            bcc.Property?.ReturnRefKind ?? RefKind.None
                        }
                    ),
                    bcc.Type
                )
            }
            case fa is BoundFieldAccessExpression {
                this.EmitFieldAccess(fa)
            }
            case fas is BoundFieldAssignmentExpression {
                this.EmitFieldAssignment(fas)
            }
            case propAcc is BoundPropertyAccessExpression {
                this.EmitPropertyAccess(propAcc)
            }
            case propAsn is BoundPropertyAssignmentExpression {
                this.EmitPropertyAssignment(propAsn)
            }
            case nc is BoundNullConditionalAccessExpression {
                this.EmitNullConditionalAccess(nc)
            }
            case clrCtor is BoundClrConstructorCallExpression {
                this.EmitClrConstructorCall(clrCtor)
            }
            case clrProp is BoundClrPropertyAccessExpression {
                this.EmitClrPropertyAccess(clrProp)
            }
            case clrPropAsn is BoundClrPropertyAssignmentExpression {
                this.EmitClrPropertyAssignment(clrPropAsn)
            }
            case clrEventSub is BoundClrEventSubscriptionExpression {
                this.EmitClrEventSubscription(clrEventSub)
            }
            case userEventSub is BoundEventSubscriptionExpression {
                this.EmitUserEventSubscription(userEventSub)
            }
            case clrBinOp is BoundClrBinaryOperatorExpression {
                this.EmitClrBinaryOperator(clrBinOp)
            }
            case clrUnOp is BoundClrUnaryOperatorExpression {
                this.EmitClrUnaryOperator(clrUnOp)
            }
            case clrConv is BoundClrConversionCallExpression {
                this.EmitClrConversionCall(clrConv)
            }
            case clrIdx is BoundClrIndexExpression {
                this.EmitClrIndex(clrIdx)
            }
            case clrIdxAsn is BoundClrIndexAssignmentExpression {
                this.EmitClrIndexAssignment(clrIdxAsn)
            }
            case tupleLit is BoundTupleLiteralExpression {
                this.EmitTupleLiteral(tupleLit)
            }
            case tupleAcc is BoundTupleElementAccessExpression {
                this.EmitTupleElementAccess(tupleAcc)
            }
            case literal is BoundFunctionLiteralExpression {
                this.EmitFunctionLiteral(literal)
            }
            case methodGroup is BoundMethodGroupExpression {
                this.EmitMethodGroup(methodGroup, overrideDelegateType: nil)
            }
            case clrMethodGroup is BoundClrMethodGroupExpression {
                this.EmitClrMethodGroup(clrMethodGroup)
            }
            case indirect is BoundIndirectCallExpression {
                this.EmitIndirectCall(indirect)
            }
            case mapLit is BoundMapLiteralExpression {
                this.EmitMapLiteral(mapLit)
            }
            case defaultExpr is BoundDefaultExpression {
                this.EmitDefault(defaultExpr)
            }
            case tpCtor is BoundTypeParameterConstructionExpression {
                this.EmitTypeParameterConstruction(tpCtor)
            }
            case isExpr is BoundIsExpression {
                this.EmitIsExpression(isExpr)
            }
            case asExpr is BoundAsExpression {
                this.EmitAsExpression(asExpr)
            }
            case BoundErrorExpression {
                // A BoundErrorExpression reached emit. This means an earlier
                // phase (binding/lowering) produced an unresolved node that was
                // not reported as a diagnostic. Surface a truthful, location-
                // anchored GS9998 rather than a hard-coded (and frequently
                // wrong) for-in message. This is a defensive emit-phase guard
                // with no DiagnosticBag in scope; the anchor is the node's own
                // syntax when available so the error points at real source.
                {
                    const msg = "Internal compiler error: an unresolved (error) expression reached code emission. " +
                        "This usually indicates an unsupported or mis-bound construct that earlier phases failed to report."
                    EmitDiagnosticException.Throw(expression.Syntax, msg)
                }
            }
            default {
                EmitDiagnosticException.Throw(
                    expression.Syntax,
                    "Bound expression kind '${expression.Kind}' is not yet supported by the emitter."
                )
            }
        }
    }

    private func EmitLiteral(literal BoundLiteralExpression) {
        // Issue #4966 (ADR-0202): a void-typed literal is the binder's "no
        // value" placeholder (the missing else of a void `if`, the tail of a
        // void block); it has nothing to push.
        if literal.Type == TypeSymbol.Void {
            return
        }
        // Phase 3.C.2 / ADR-0001: the nil literal is modeled as a null
        // BoundLiteralExpression.Value; on reference-type or nullable
        // targets it emits as ldnull.
        if literal.Value == nil {
            this.il.OpCode(ILOpCode.Ldnull)
            return
        }
        switch literal.Value {
            case s is string {
                this.il.LoadString(this.outer.emitCtx.Metadata.GetOrAddUserString(s))
            }
            case b is bool {
                this.il.LoadConstantI4(
                    if b {
                        1
                    } else {
                        0
                    }
                )
            }
            case sb is int8 {
                this.il.LoadConstantI4(sb)
            }
            case by is uint8 {
                this.il.LoadConstantI4(by)
            }
            case sh is int16 {
                this.il.LoadConstantI4(sh)
            }
            case us is uint16 {
                this.il.LoadConstantI4(us)
            }
            case ch is char {
                this.il.LoadConstantI4(ch)
            }
            case i is int32 {
                this.il.LoadConstantI4(i)
            }
            case ui is uint32 {
                this.il.LoadConstantI4(unchecked(int32(ui)))
            }
            case lng is int64 {
                this.il.LoadConstantI8(lng)
            }
            case ul is uint64 {
                this.il.LoadConstantI8(unchecked(int64(ul)))
            }
            case ni is nint {
                this.il.LoadConstantI8(ni)
                this.il.OpCode(ILOpCode.Conv_i)
            }
            case nu is nuint {
                this.il.LoadConstantI8(unchecked(int64(uint64(nu))))
                this.il.OpCode(ILOpCode.Conv_u)
            }
            case f is float32 {
                this.il.LoadConstantR4(f)
            }
            case d is float64 {
                this.il.LoadConstantR8(d)
            }
            case m is decimal {
                this.EmitDecimalLiteral(m)
            }
            case method is MethodInfo {
                // Issue #2373: expression-tree lowering (ExpressionTreeLowerer)
                // passes a CLR operator/user MethodInfo as a literal-typed
                // argument to Expression factories (Expression.Equal(l, r,
                // liftToNull, method), Expression.Add(l, r, method), the
                // string-concat Add(l, r, method) overload, ...). A MethodInfo
                // cannot be embedded as a metadata constant directly; rebuild
                // it at run time the same way the C# compiler does: `ldtoken
                // method [, ldtoken declaringType] ; call
                // MethodBase.GetMethodFromHandle(...) ; castclass MethodInfo`.
                this.EmitMethodInfoLiteral(method)
            }
            case member is BoundClrPropertyAccessExpression {
                let receiverType = member.ConstrainedInterfaceType ??
                    member.StaticContainerType ??
                    member
                    .Receiver
                    ?.Type
                var owner TypeSymbol? = nil
                if receiverType != nil {
                    var imported = MemberLookup.GetProjectionReceiverImportedType(receiverType)
                    if imported == nil && MemberLookup.TryGetSymbolicOpenReceiverView(
                        receiverType,
                        out var symbolicReceiver
                    ) {
                        imported = symbolicReceiver
                    }
                    if imported != nil {
                        owner = MemberLookup.GetClrMemberDeclaringTypeSymbol(imported, member.Member)
                    }
                }
                if member.Member is PropertyInfo property {
                    var methodReference EntityHandle? = nil
                    if this.GetNullablePropertyGetterReference(property, receiverType) is {} nullableGetter {
                        owner = receiverType
                        methodReference = EntityHandle(nullableGetter)
                    }
                    this.EmitMethodInfoLiteral(
                        Invariant.Required(
                            if property.GetMethod is {IsPublic: true} getter {
                                getter
                            } else {
                                property.SetMethod ?? property.GetMethod
                            },
                            "a selected CLR property has an accessor",
                            expression: "property.GetMethod or property.SetMethod"
                        ),
                        owner,
                        methodReference
                    )
                } else if member.Member is FieldInfo field {
                    this.il.OpCode(ILOpCode.Ldtoken)
                    this.il.Token(
                        if owner != nil {
                            this.outer.memberRefs.GetFieldReference(field, owner)
                        } else {
                            this.outer.memberRefs.GetFieldReference(field)
                        }
                    )
                    this.il.OpCode(ILOpCode.Ldtoken)
                    this.il.Token(
                        if owner != nil {
                            this.outer.memberRefs.GetTypeOfToken(owner)
                        } else {
                            this
                                .outer
                                .memberRefs
                                .GetTypeReference(
                                Invariant.Required(
                                    field.DeclaringType,
                                    "a selected CLR field has a declaring type",
                                    expression: "field.DeclaringType"
                                )
                            )
                        }
                    )
                    this.il.Call(
                        this
                            .outer
                            .memberRefs
                            .GetMethodReference(
                            BclMember.Method(
                                typeof(FieldInfo),
                                "GetFieldFromHandle",
                                typeof(RuntimeFieldHandle),
                                typeof(RuntimeTypeHandle)
                            )
                        )
                    )
                } else {
                    throw NotSupportedException("A CLR member literal requires a property or field.")
                }
            }
            case constructor is BoundConstructorCallExpression {
                // Keep constructor identity and its closed owner until metadata emission.
                let token = if constructor.StructType.ClrType != nil {
                    this
                        .outer
                        .memberRefs
                        .GetCtorReference(
                        Invariant.Required(
                            constructor.StructType.GetDataConstructionConstructor(),
                            "a constructor-owned imported literal has a selected constructor",
                            expression: "constructor.StructType.GetDataConstructionConstructor()"
                        ),
                        constructor.StructType
                    )
                } else {
                    this.outer.userTokens.ResolveUserCtorToken(constructor)
                }
                this.EmitConstructorInfoLiteral(token, constructor.StructType)
            }
            case constructor is BoundClrConstructorCallExpression {
                this.EmitConstructorInfoLiteral(
                    this.outer.memberRefs.GetCtorReference(constructor.Constructor, constructor.Type),
                    constructor.Type
                )
            }
            default {
                throw NotSupportedException("Literal of CLR type '${literal.Value?.GetType()}' is not yet supported.")
            }
        }
    }

    private func EmitConstructorInfoLiteral(token EntityHandle, owner TypeSymbol) {
        this.il.OpCode(ILOpCode.Ldtoken)
        this.il.Token(token)
        this.il.OpCode(ILOpCode.Ldtoken)
        this.il.Token(this.outer.memberRefs.GetTypeOfToken(owner))
        this.il.Call(this.outer.wellKnown.GetMethodFromHandleWithDeclaringTypeReference())
        this.il.OpCode(ILOpCode.Castclass)
        this.il.Token(this.outer.memberRefs.GetTypeReference(typeof(ConstructorInfo)))
    }

    private func EmitMethodInfoLiteral(
        method MethodInfo,
        containingTypeSymbol TypeSymbol? = nil,
        methodReference EntityHandle? = nil
    ) {
        this.il.OpCode(ILOpCode.Ldtoken)
        this.il.Token(methodReference ?? this.outer.memberRefs.GetMethodEntityHandle(method, containingTypeSymbol))
        // The CLR requires the 2-arg GetMethodFromHandle(RuntimeMethodHandle,
        // RuntimeTypeHandle) overload whenever the declaring type is a
        // generic instantiation (e.g. a user operator on `Money<Currency>`);
        // the 1-arg overload throws ArgumentException at run time for those.
        // Symbolic owners supply their constructed TypeSpec below.
        if containingTypeSymbol != nil {
            this.il.OpCode(ILOpCode.Ldtoken)
            this.il.Token(this.outer.memberRefs.GetTypeOfToken(containingTypeSymbol))
            this.il.Call(this.outer.wellKnown.GetMethodFromHandleWithDeclaringTypeReference())
        } else if method.DeclaringType is {IsGenericType: true} declaringType {
            this.il.OpCode(ILOpCode.Ldtoken)
            this.il.Token(this.outer.memberRefs.GetTypeReference(declaringType))
            this.il.Call(this.outer.wellKnown.GetMethodFromHandleWithDeclaringTypeReference())
        } else {
            this.il.Call(this.outer.wellKnown.GetMethodFromHandleReference())
        }
        // GetMethodFromHandle returns MethodBase; these callers need MethodInfo.
        this.il.OpCode(ILOpCode.Castclass)
        this.il.Token(this.outer.memberRefs.GetTypeReference(typeof(MethodInfo)))
    }

    // ADR-0044 decimal literal lowering. IL has no `ldc.decimal`, so each
    // literal is materialised by calling the
    // `Decimal(int, int, int, bool, byte)` ctor with the bit pattern
    // returned by `decimal.GetBits`. Common small values (0, 1, -1) and
    // any value that fits in `int` use the cheaper one-int ctors.
    private func EmitDecimalLiteral(value decimal) {
        if value == decimal.Zero {
            this.EmitDecimalStaticField("Zero")
            return
        }
        if value == decimal.One {
            this.EmitDecimalStaticField("One")
            return
        }
        if value == decimal.MinusOne {
            this.EmitDecimalStaticField("MinusOne")
            return
        }
        // Try int ctor for small whole values.
        if decimal.Truncate(value) == value && value >= decimal(int32.MinValue) && value <= decimal(int32.MaxValue) {
            let asInt = int32(value)
            this.il.LoadConstantI4(asInt)
            let ctor = BclMember.Ctor(typeof(decimal), typeof(int32))
            this.il.OpCode(ILOpCode.Newobj)
            this.il.Token(this.outer.memberRefs.GetCtorReference(ctor))
            return
        }
        // Try long ctor.
        if decimal.Truncate(value) == value && value >= decimal(int64.MinValue) && value <= decimal(int64.MaxValue) {
            let asLong = int64(value)
            this.il.LoadConstantI8(asLong)
            let ctor = BclMember.Ctor(typeof(decimal), typeof(int64))
            this.il.OpCode(ILOpCode.Newobj)
            this.il.Token(this.outer.memberRefs.GetCtorReference(ctor))
            return
        }
        // General case: Decimal(int lo, int mid, int hi, bool isNegative, byte scale).
        let bits = decimal.GetBits(value)
        let lo = bits[0]
        let mid = bits[1]
        let hi = bits[2]
        let flags = bits[3]
        let isNegative = (flags & unchecked(int32(0x80000000U))) != 0
        let scale = uint8(((flags >> 16) & 0x7F))
        this.il.LoadConstantI4(lo)
        this.il.LoadConstantI4(mid)
        this.il.LoadConstantI4(hi)
        this.il.LoadConstantI4(
            if isNegative {
                1
            } else {
                0
            }
        )
        this.il.LoadConstantI4(scale)
        let bigCtor = BclMember.Ctor(
            typeof(decimal),
            typeof(int32),
            typeof(int32),
            typeof(int32),
            typeof(bool),
            typeof(uint8)
        )
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(this.outer.memberRefs.GetCtorReference(bigCtor))
    }

    private func EmitDecimalStaticField(name string) {
        let field = BclMember.Field(typeof(decimal), name)
        this.il.OpCode(ILOpCode.Ldsfld)
        this.il.Token(this.outer.memberRefs.GetFieldReference(field))
    }

    private func EmitArrayCreation(arr BoundArrayCreationExpression) {
        if arr.ContainerType is RectangularArrayTypeSymbol rectangular {
            for dimension in arr.DimensionExpressions {
                this.EmitExpression(dimension)
            }
            this.il.OpCode(ILOpCode.Newobj)
            this.il.Token(this.outer.memberRefs.GetRectangularArrayMemberReference(rectangular, ".ctor"))
            if !arr.Elements.IsDefaultOrEmpty && arr.RectangularLengths.Length == rectangular.Rank {
                for var flatIndex = 0; flatIndex < arr.Elements.Length; flatIndex++ {
                    this.il.OpCode(ILOpCode.Dup)
                    var remainder = flatIndex
                    for var dimension = 0; dimension < arr.RectangularLengths.Length; dimension++ {
                        var stride = 1
                        for var trailing = dimension + 1; trailing < arr.RectangularLengths.Length; trailing++ {
                            stride *= arr.RectangularLengths[trailing]
                        }
                        let index = if stride == 0 {
                            0
                        } else {
                            remainder / stride
                        }
                        remainder = if stride == 0 {
                            0
                        } else {
                            remainder % stride
                        }
                        this.il.LoadConstantI4(index)
                    }
                    this.EmitExpression(arr.Elements[flatIndex])
                    this.il.OpCode(ILOpCode.Call)
                    this.il.Token(this.outer.memberRefs.GetRectangularArrayMemberReference(rectangular, "Set"))
                }
            }
            return
        }
        // Issue #1016: a runtime-length, zero-initialised array/slice (slice
        // backing allocation). `newarr` already zero-inits every element, so no
        // per-element store loop is required.
        if arr.LengthExpression != nil {
            this.EmitExpression(arr.LengthExpression)
            this.il.OpCode(ILOpCode.Newarr)
            this.il.Token(this.outer.memberRefs.GetExactTypeToken(arr.ElementType))
            return
        }
        this.il.LoadConstantI4(arr.Elements.Length)
        this.il.OpCode(ILOpCode.Newarr)
        this.il.Token(this.outer.memberRefs.GetExactTypeToken(arr.ElementType))
        for var i = 0; i < arr.Elements.Length; i++ {
            this.il.OpCode(ILOpCode.Dup)
            this.il.LoadConstantI4(i)
            this.EmitExpression(arr.Elements[i])
            this.EmitStoreElement(arr.ElementType)
        }
    }

    // ADR-0124 / issues #1024, #1057, #1041: emits a `stackalloc [n]T`
    // expression as a CIL `localloc` over `n * sizeof(T)` bytes. The element
    // count is evaluated once into a pre-allocated int32 scratch slot
    // (receiverSpillSlots[node]), then read back for the byte-size computation
    // and — for the safe Span<T> form — the `Span<T>(void*, int)` length
    // argument. When an initializer is present, each element is stored into the
    // block through the `localloc` pointer via a scaled indirect write
    // (`dup` keeps the base pointer beneath each store so no extra local is
    // needed). The localloc'd memory is zero-initialised because every emitted
    // method body sets the `.locals init` (InitLocals) flag, matching C#'s
    // safe-stackalloc guarantee. The pointer form simply leaves the raw
    // `void*`/`T*` on the stack. localloc IL is unverifiable by design (see
    // ADR-0124 / ADR-0122).
    private func EmitStackAlloc(node BoundStackAllocExpression) {
        // Issue #1522: a `stackalloc` that was spilled by the method-body
        // planner (any non-statement-root position) has already had its
        // `localloc` + result materialised into a pre-allocated local at an
        // empty-stack point (see MaterializeSpilledStackAllocs). At the operand
        // position we simply load that local, keeping the evaluation stack legal
        // for the surrounding call/operator. The materialisation guard tolerates
        // the (unexpected) case of a spilled node reached before its statement's
        // pre-pass ran by materialising in place — still correct, only the IL
        // legality that spilling guarantees would be lost on that path.
        if this.stackAllocResultSlots.TryGetValue(node, out var resultSlot) {
            if this.materializedStackAllocs.Add(node) {
                this.EmitStackAllocCore(node)
                this.il.StoreLocal(resultSlot)
            }
            this.il.LoadLocal(resultSlot)
            return
        }
        this.EmitStackAllocCore(node)
    }

    private func EmitStackAllocCore(node BoundStackAllocExpression) {
        if !this.receiverSpillSlots.TryGetValue(node, out var countSlot) {
            throw InvalidOperationException(
                "stackalloc count scratch slot was not pre-allocated by the method-body planner."
            )
        }
        let elementToken = this.outer.memberRefs.GetElementTypeToken(node.ElementType)
        // count -> scratch slot (single evaluation).
        this.EmitExpression(node.Count)
        this.il.StoreLocal(countSlot)
        // bytes = count * sizeof(T); localloc -> void* (native int).
        this.il.LoadLocal(countSlot)
        this.il.OpCode(ILOpCode.Sizeof)
        this.il.Token(elementToken)
        this.il.OpCode(ILOpCode.Mul)
        this.il.OpCode(ILOpCode.Conv_u)
        this.il.OpCode(ILOpCode.Localloc)
        // Issue #1041: store each initializer element into the block. The base
        // pointer is kept on the bottom of the stack across the whole sequence:
        // `dup` copies it for each element store (CIL has no swap and a scratch
        // pointer local would otherwise be required), and the scaled
        // `stind`/`stobj` consumes (addr, value) leaving the base pointer again.
        if node.HasInitializer {
            for var i = 0; i < node.InitializerElements.Length; i++ {
                this.il.OpCode(ILOpCode.Dup)
                if i > 0 {
                    // addr = base + i * sizeof(T).
                    this.il.LoadConstantI4(i)
                    this.il.OpCode(ILOpCode.Sizeof)
                    this.il.Token(elementToken)
                    this.il.OpCode(ILOpCode.Mul)
                    this.il.OpCode(ILOpCode.Conv_i)
                    this.il.OpCode(ILOpCode.Add)
                }
                this.EmitExpression(node.InitializerElements[i])
                this.EmitStoreIndirect(node.ElementType)
            }
        }
        if node.IsPointerForm {
            // The raw localloc pointer IS the result (`T*`).
            return
        }
        // Safe form: construct a Span<T> over [ptr, count].
        this.il.LoadLocal(countSlot)
        let spanClr = node
            .ResultType
            .ClrType ??
            throw InvalidOperationException(
            "stackalloc result type '${node.ResultType.Name}' has no CLR reflection shape."
        )
        let voidPointer = this.outer.emitCtx.References.MapClrTypeToReferences(typeof(Void).MakePointerType())
        let spanCtor = spanClr.GetConstructor([]Type{voidPointer!!, this.outer.emitCtx.CoreInt32Type}) ??
            throw InvalidOperationException("'${node.ResultType.Name}' has no (void*, int) constructor.")
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(this.outer.memberRefs.GetCtorReference(spanCtor, node.ResultType))
    }

    private func EmitLen(len BoundLenExpression) {
        this.EmitExpression(len.Operand)
        if len.Operand.Type == TypeSymbol.String {
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(this.outer.wellKnown.GetStringLengthReference())
        } else if len.Operand.Type is MapTypeSymbol mapType {
            // Phase 3.A.4 emit: `len(m)` -> `callvirt Dictionary<K,V>.get_Count`.
            // Issue #3301: same-compilation user-struct key/value — no erased
            // CLR Dictionary<,> to reflect on; use the #1481-style symbolic
            // TypeSpec-parented MemberRef instead.
            let getCountRef = if mapType.ClrType is {} dictType {
                this
                    .outer
                    .memberRefs
                    .GetMethodReference(
                    dictType.GetMethod("get_Count") ??
                        throw InvalidOperationException(
                        "Dictionary type '${dictType.FullName}' has no get_Count method."
                    )
                )
            } else {
                this.outer.memberRefs.GetMapGetCountReference(mapType)
            }
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(getCountRef)
        } else if len
            .Operand
            .Type is RectangularArrayTypeSymbol ||
            (len.Operand.Type.ClrType is {IsArray: true} clrArray && clrArray.GetArrayRank() > 1) {
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(this.outer.wellKnown.GetArrayLengthReference())
        } else {
            this.il.OpCode(ILOpCode.Ldlen)
            this.il.OpCode(ILOpCode.Conv_i4)
        }
    }

    private func EmitTypeOf(typeOf BoundTypeOfExpression) {
        // Issue #143: `typeof(T)` -> ldtoken <T> ; call Type::GetTypeFromHandle.
        this.il.OpCode(ILOpCode.Ldtoken)
        this.il.Token(this.outer.memberRefs.GetTypeOfToken(typeOf.OperandType))
        this.il.Call(this.outer.wellKnown.GetTypeFromHandleReference())
    }

    private func EmitSizeOf(sizeOf BoundSizeOfExpression) {
        // ADR-0122 §4 / issue #1034: `sizeof(T)` -> CIL `sizeof <T>`, pushing
        // the unmanaged byte size of the (struct) pointee as an int32. Used to
        // scale unmanaged pointer arithmetic by a struct size that is not known
        // at G# compile time.
        this.il.OpCode(ILOpCode.Sizeof)
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(sizeOf.MeasuredType))
    }

    private func EmitFunctionPointerFromMethod(node BoundFunctionPointerFromMethodExpression) {
        // ADR-0122 §9 / issue #1035: `&StaticMethod` -> CIL `ldftn <method>`,
        // pushing the method's entry-point address as a managed function
        // pointer value. `node.Method` is a top-level package function
        // (registered in FunctionHandles) OR a class/struct shared method
        // (registered in MethodHandles, e.g. issue #1906's `shared { func
        // Square(...) }`) — check both caches, mirroring GetMethodReference's
        // own FunctionHandles/MethodHandles fallback below.
        if !this
            .outer
            .cache
            .FunctionHandles
            .TryGetValue(node.Method, out var methodHandle) &&
            !this
            .outer
            .cache
            .MethodHandles
            .TryGetValue(node.Method, out methodHandle) {
            throw InvalidOperationException(
                "Function '${node.Method.Name}' has no emitted MethodDef for '&${node.Method.Name}' (ldftn)."
            )
        }
        this.il.OpCode(ILOpCode.Ldftn)
        this.il.Token(methodHandle)
    }

    private func EmitFunctionPointerInvocation(node BoundFunctionPointerInvocationExpression) {
        // ADR-0122 §9 / issue #1035: `fp(args)` -> push arguments, push the
        // function-pointer value, then CIL `calli <signature>`.
        for arg in node.Arguments {
            this.EmitExpression(arg)
        }
        this.EmitExpression(node.Pointer)
        let sig = this.outer.signatures.GetFunctionPointerCallSiteSignature(node.FunctionPointerType)
        this.il.CallIndirect(sig)
    }

    private func EmitMapLiteral(literal BoundMapLiteralExpression) {
        // ADR-0104 emit: `map[K,V]{k1: v1, ...}` lowers to
        // `newobj Dictionary<K,V>::.ctor()` then a (dup; key; value; callvirt set_Item)
        // sequence per entry. Using set_Item rather than Add so duplicate keys
        // overwrite (matching Go semantics; ParseMapEntries does not dedup).
        let dictType Type? = literal.MapType.ClrType
        // Issue #1481: when the map's key or value structurally references an
        // in-scope type parameter (e.g. `map[string, T]`), the erased CLR
        // `Dictionary<…>` type is unavailable (ClrType is null). Route the
        // construction through the reified TypeSpec-parented MemberRefs so the
        // value verifies against the iterator state machine's reified
        // `Dictionary<…, !0>` field — mirrors the symbolic tuple-literal path.
        if dictType == nil {
            this.EmitMapLiteralSymbolic(literal)
            return
        }
        // Issue #4015: `MapTypeSymbol.MakeClrType` builds this type as
        // `typeof(Dictionary<,>).MakeGenericType(key.ClrType, value.ClrType)`,
        // and `RuntimeType.MakeGenericType` hands back a
        // `System.Reflection.Emit.TypeBuilderInstantiation` the moment ANY type
        // argument is not itself a `RuntimeType` — which is every CLR type the
        // compiler resolved through its reference load context, i.e. everything
        // except the handful of G# primitives bound to a host `typeof(...)`.
        // `TypeBuilderInstantiation.GetConstructor` and `.GetMethod` both throw
        // `NotSupportedException` ("…does not support resolving members"), which
        // the compiler surfaced as the internal-error GS9998 for map literals as
        // ordinary as `map[string, DateTime]{}`.
        //
        // The symbolic MemberRefs #1481 built for the `ClrType == null` case are
        // exactly the right answer here — parented at the reified TypeSpec, with
        // `!0`/`!1` parameter signatures — so fall through to them rather than
        // teaching this site a second reflection technique. The precedent is
        // #1449's `GetDelegateCtorReference`, which catches the same exception
        // from the same cause.
        var ctor ConstructorInfo?
        var setItem MethodInfo?
        try {
            ctor = dictType.GetConstructor(Type.EmptyTypes)
            setItem = if literal.Entries.Length == 0 {
                default(MethodInfo?)
            } else {
                dictType.GetMethod("set_Item")
            }
        } catch (NotSupportedException) {
            this.EmitMapLiteralSymbolic(literal)
            return
        }
        if ctor == nil {
            throw InvalidOperationException("Dictionary type '${dictType.FullName}' has no parameterless constructor.")
        }
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(this.outer.memberRefs.GetCtorReference(ctor))
        if literal.Entries.Length == 0 {
            return
        }
        if setItem == nil {
            throw InvalidOperationException("Dictionary type '${dictType.FullName}' has no set_Item method.")
        }
        let setItemRef = this.outer.memberRefs.GetMethodReference(setItem)
        for entry in literal.Entries {
            this.il.OpCode(ILOpCode.Dup)
            this.EmitExpression(entry.Key)
            this.EmitExpression(entry.Value)
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(setItemRef)
        }
    }

    /// Emits a `map[K, V]{…}` literal through the reified TypeSpec-parented
    /// MemberRefs (issue #1481), for the two cases where the closed CLR
    /// `Dictionary<K, V>` cannot answer a member query: it does not
    /// exist at all (an open key or value type, #1481), or it exists as a
    /// `TypeBuilderInstantiation` that refuses to resolve members (#4015).
    /// @param literal The map literal.
    private func EmitMapLiteralSymbolic(literal BoundMapLiteralExpression) {
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(this.outer.memberRefs.GetMapCtorReference(literal.MapType))
        if literal.Entries.Length == 0 {
            return
        }
        let symbolicSetItemRef = this.outer.memberRefs.GetMapSetItemReference(literal.MapType)
        for entry in literal.Entries {
            this.il.OpCode(ILOpCode.Dup)
            this.EmitExpression(entry.Key)
            this.EmitExpression(entry.Value)
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(symbolicSetItemRef)
        }
    }

    private func EmitStructLiteralPrimaryArguments(
        literal BoundStructLiteralExpression,
        consumed HashSet[BoundFieldInitializer]
    ) {
        for parameter in literal.StructType.PrimaryConstructorParameters {
            let value = Invariant.Required(
                literal.GetPrimaryArgument(parameter.Name),
                "primary literal arguments, including defaults, are prepared before planning",
                expression: "literal.GetPrimaryArgument(parameter.Name)"
            )
            consumed.Add(value)
            this.EmitExpression(value.Value)
        }
    }

    private func EmitStructLiteral(literal BoundStructLiteralExpression) {
        if literal.CopySource != nil && literal.StructType.IsClass {
            this.EmitExpression(literal.CopySource)
            if literal.StructType.IsClass {
                this.il.OpCode(ILOpCode.Callvirt)
                this.il.Token(this.outer.userTokens.ResolveDataClassCloneToken(literal.StructType))
            }
            return
        }
        // ADR-0087 §3 R3+R4: when the literal target is a user-defined
        // generic type, every body reference (initobj/newobj/stfld) must
        // be routed through a TypeSpec-parented MemberRef. The box bridge
        // that R0/R1 erasure required (`box T` before stfld) is dropped:
        // the field's signature is VAR(idx) and resolves to the correct
        // concrete type at the construction site.
        let typeDef = if literal.ResultType != nil {
            this.outer.memberRefs.GetElementTypeToken(literal.Type)
        } else {
            this.outer.userTokens.ResolveUserTypeToken(literal.StructType)
        }
        let isGeneric = ReflectionMetadataEmitter.IsUserGenericTypeReference(literal.StructType)
        let structDefinition = literal.StructType.Definition ?? literal.StructType
        let callsPrimary = literal.CallsPrimaryConstructor
        let primaryValues = HashSet[BoundFieldInitializer]()
        // Class literal: newobj <ctor>; (dup; <value>; stfld) per init.
        if literal.StructType.IsClass {
            // Issue #2291: an imported C# `record class` has NO public
            // parameterless constructor — only its positional primary
            // constructor and a synthesized copy constructor
            // (`.ctor(SameType)`). #2263's parameterless-ctor + per-member
            // stfld/setter strategy cannot construct it at all. Detect that
            // shape up front and construct through the positional primary
            // constructor instead, passing each member's already-resolved
            // value (explicit override or a copy read off the temp
            // variable) as a constructor argument in declaration order.
            if !isGeneric &&
                !this
                .outer
                .cache
                .ClassCtorHandles
                .ContainsKey(literal.StructType) &&
                literal
                .StructType
                .ClrType is {} importedClrTypeForCtorCheck &&
                importedClrTypeForCtorCheck.GetConstructor(Type.EmptyTypes) == nil {
                this.EmitImportedPositionalRecordLiteral(literal, importedClrTypeForCtorCheck)
                return
            }
            if literal.CopySource != nil {
                this.EmitExpression(literal.CopySource)
                let definition = literal.StructType.Definition ?? literal.StructType
                let clone = this.outer.cache.DataClassCloneHandles[definition]
                var cloneToken EntityHandle = clone
                if isGeneric {
                    let signature = BlobBuilder()
                    BlobEncoder(signature).MethodSignature(isInstanceMethod: true).Parameters(
                        0,
                        (result ReturnTypeEncoder) -> this
                            .outer
                            .userTokens
                            .EncodeTypeSymbolIntoSignature(result.Type(), definition),
                        (_ ParametersEncoder) -> { }
                    )
                    cloneToken = this
                        .outer
                        .userTokens
                        .GetUserStructMethodRef(literal.StructType, clone, "<Clone>$$", signature)
                }
                this.il.OpCode(ILOpCode.Callvirt)
                this.il.Token(cloneToken)
            } else {
                var ctorHandle EntityHandle
                if callsPrimary {
                    this.EmitStructLiteralPrimaryArguments(literal, primaryValues)
                    ctorHandle = this.outer.userTokens.ResolveUserCtorTokenForPrimary(literal.StructType)
                } else if isGeneric {
                    ctorHandle = this.outer.userTokens.ResolveUserCtorTokenForDefault(literal.StructType)
                } else if this.outer.cache.ClassCtorHandles.TryGetValue(literal.StructType, out var ctorDef) {
                    ctorHandle = ctorDef
                } else if literal.StructType.ClrType != nil {
                    // Issue #2263: an imported `data class` — construct via its real
                    // emitted parameterless `.ctor()` (a `data class` always emits
                    // both a parameterless and a primary constructor), then set each
                    // overridden/copied field below. Mirrors the imported field /
                    // setter resolution branches already gated on ClrType != null.
                    let clrCtor = literal
                        .StructType
                        .ClrType
                        .GetConstructor(Type.EmptyTypes) ??
                        throw InvalidOperationException(
                        "Imported data class '${literal.StructType.Name}' has no parameterless constructor."
                    )
                    ctorHandle = this.outer.memberRefs.GetCtorReference(clrCtor)
                } else {
                    throw InvalidOperationException("Class '${literal.StructType.Name}' has no emitted default ctor.")
                }
                this.il.OpCode(ILOpCode.Newobj)
                this.il.Token(ctorHandle)
            }
            for init in literal.Initializers {
                if primaryValues.Contains(init) {
                    continue
                }
                // Issue #1211: a `prop` member is set through its setter/init
                // accessor (`dup; <value>; callvirt set_X`) rather than a stfld.
                if init.Property != nil {
                    let setterHandle = this.ResolveStructLiteralSetter(
                        literal.StructType,
                        init.Property,
                        isGeneric || literal.StructType.ClrType != nil
                    )
                    this.il.OpCode(ILOpCode.Dup)
                    this.EmitExpression(init.Value)
                    this.il.OpCode(ILOpCode.Callvirt)
                    this.il.Token(setterHandle)
                    continue
                }
                var fieldHandle EntityHandle
                let initField = Invariant.Required(
                    init.Field,
                    "a field initializer targets either a field or a property, and the property form is handled above",
                    expression: "init.Field"
                )
                if init.FieldDeclaringType != nil {
                    fieldHandle = this.ResolveStructLiteralFieldToken(literal, init)
                } else if isGeneric || literal.StructType.ClrType != nil {
                    fieldHandle = this.outer.userTokens.ResolveFieldToken(literal.StructType, initField, literal.Type)
                } else if this.outer.cache.StructFieldDefs.TryGetValue(initField, out var defHandle) {
                    fieldHandle = defHandle
                } else {
                    fieldHandle = this.outer.userTokens.ResolveFieldToken(literal.StructType, initField, literal.Type)
                }
                this.il.OpCode(ILOpCode.Dup)
                this.EmitExpression(init.Value)
                this.il.OpCode(ILOpCode.Stfld)
                this.il.Token(fieldHandle)
            }
            return
        }
        if !this.structLiteralSlots.TryGetValue(literal, out var slot) {
            throw InvalidOperationException(
                "No slot populated for ${literal.Kind} of type '${literal.StructType.Name}' — " +
                    "walker pre-pass missed this child? " +
                    "Check StructLiteralCollector and its ancestor walker."
            )
        }
        // Issue #3219: a value struct with a NON-public declared field
        // initializer cannot be materialized by initobj + raw stfld — the
        // private-field store executes outside the type (FieldAccessException).
        // Such a struct carries a synthesized parameterless .ctor (see
        // ConstructorBodyEmitter.NeedsSynthesizedValueStructDefaultCtor) that
        // zero-initializes and runs ALL declared initializers in-type;
        // construct through it and skip the literal's injected
        // declaration-origin entries, whose provenance survives lowering,
        // so initializer side effects run once while authored overrides remain.
        let usesOwningInitializerConstructor = this
            .outer
            .cache
            .ClassCtorHandles
            .ContainsKey(structDefinition) &&
            ConstructorBodyEmitter.NeedsSynthesizedValueStructDefaultCtor(structDefinition)
        if literal.CopySource != nil {
            this.EmitExpression(literal.CopySource)
            this.il.StoreLocal(slot)
        } else if literal.CallsDataConstructor {
            if literal.StructType.ClrType != nil && literal.StructType.GetDataConstructionConstructor() == nil {
                this.il.LoadLocalAddress(slot)
                this.il.OpCode(ILOpCode.Initobj)
                this.il.Token(typeDef)
            } else {
                if callsPrimary {
                    this.EmitStructLiteralPrimaryArguments(literal, primaryValues)
                }
                let constructor = literal.StructType.GetDataConstructionConstructor()
                let token = if constructor != nil {
                    this.outer.memberRefs.GetCtorReference(constructor, literal.StructType)
                } else {
                    this.outer.userTokens.ResolveUserCtorTokenForPrimary(literal.StructType)
                }
                this.il.OpCode(ILOpCode.Newobj)
                this.il.Token(token)
                this.il.StoreLocal(slot)
            }
        } else if callsPrimary {
            this.il.LoadLocalAddress(slot)
            this.il.OpCode(ILOpCode.Initobj)
            this.il.Token(typeDef)
            this.il.LoadLocalAddress(slot)
            this.EmitStructLiteralPrimaryArguments(literal, primaryValues)
            this.il.OpCode(ILOpCode.Call)
            this.il.Token(this.outer.userTokens.ResolveUserCtorTokenForPrimary(literal.StructType))
        }
        // ldloca slot; initobj typedef — zero-initializes the value type —
        // or, for a #3219 struct, ldloca slot; call .ctor() (which zeroes and
        // runs the declared initializers in-type).
        if literal.CopySource == nil && !callsPrimary && !literal.CallsDataConstructor {
            this.il.LoadLocalAddress(slot)
            if usesOwningInitializerConstructor {
                for var marker = 0; marker < structDefinition.LiteralInitializerMarkerCount; marker++ {
                    this.il.LoadConstantI4(0)
                }
                this.il.OpCode(ILOpCode.Call)
                this.il.Token(this.outer.userTokens.ResolveUserCtorTokenForDefault(literal.StructType))
            } else {
                this.il.OpCode(ILOpCode.Initobj)
                this.il.Token(typeDef)
            }
        }
        // For each initializer: ldloca slot; <emit value>; stfld fieldHandle.
        for init in literal.Initializers {
            if literal.IsInTypeZeroInitializer(init) {
                // Skip only the definition-owned zero stores that actually ran.
                continue
            }
            if primaryValues.Contains(init) {
                continue
            }
            // Issue #3219: the synthesized ctor already ran this declared
            // initializer in-type.
            if usesOwningInitializerConstructor && init.IsDeclarationInitializer {
                continue
            }
            // Issue #1211: a `prop` member on a value type is set through its
            // setter/init accessor (`ldloca slot; <value>; call set_X`). The
            // managed-pointer receiver means a non-virtual `call`.
            if init.Property != nil {
                let setterHandle = this.ResolveStructLiteralSetter(
                    literal.StructType,
                    init.Property,
                    isGeneric || literal.StructType.ClrType != nil
                )
                this.il.LoadLocalAddress(slot)
                this.EmitExpression(init.Value)
                this.il.OpCode(ILOpCode.Call)
                this.il.Token(setterHandle)
                continue
            }
            var fieldHandle EntityHandle
            let initField = Invariant.Required(
                init.Field,
                "a field initializer targets either a field or a property, and the property form is handled above",
                expression: "init.Field"
            )
            if init.FieldDeclaringType != nil {
                fieldHandle = this.ResolveStructLiteralFieldToken(literal, init)
            } else if isGeneric || literal.StructType.ClrType != nil {
                fieldHandle = this.outer.userTokens.ResolveFieldToken(literal.StructType, initField, literal.Type)
            } else if this.outer.cache.StructFieldDefs.TryGetValue(initField, out var defHandle) {
                fieldHandle = defHandle
            } else {
                throw InvalidOperationException("Struct field '${initField.Name}' has no emitted FieldDef.")
            }
            this.il.LoadLocalAddress(slot)
            this.EmitExpression(init.Value)
            this.il.OpCode(ILOpCode.Stfld)
            this.il.Token(fieldHandle)
        }
        // Leave the constructed struct value on the stack.
        this.il.LoadLocal(slot)
    }

    private func ResolveStructLiteralFieldToken(
        literal BoundStructLiteralExpression,
        initializer BoundFieldInitializer
    ) EntityHandle {
        let fieldContainer = ResolveFieldReferenceContainer(
            initializer.FieldDeclaringType,
            literal.StructType,
            Invariant.Required(
                initializer.Field,
                "a field initializer targets either a field or a property, and the property form is handled above",
                expression: "initializer.Field"
            )
        )
        return this
            .outer
            .userTokens
            .ResolveFieldToken(
            Invariant.Required(
                fieldContainer,
                "every caller reaches here only after testing FieldDeclaringType, and ResolveFieldReferenceContainer returns null only for a null declaring type",
                expression: "fieldContainer"
            ),
            Invariant.Required(
                initializer.Field,
                "a field initializer targets either a field or a property, and the property form is handled above",
                expression: "initializer.Field"
            )
        )
    }

    /// Issue #2291: constructs an imported C# `record class` — which has no
    /// public parameterless constructor, only its positional primary
    /// constructor and a synthesized copy constructor — by calling the
    /// primary constructor directly with each positional member's resolved
    /// value (an explicit `with` override, or a copy read off the source
    /// instance) as an argument, in declaration order. Any remaining
    /// initializer not covered by a primary-constructor parameter (e.g. an
    /// ordinary non-positional field or property) is still applied
    /// afterwards via `dup`+`stfld`/setter call, exactly like the
    /// parameterless-ctor path in (cref:EmitStructLiteral).
    private func EmitImportedPositionalRecordLiteral(literal BoundStructLiteralExpression, importedClrType Type) {
        let parameters = literal.StructType.PrimaryConstructorParameters
        if parameters.IsDefaultOrEmpty {
            throw InvalidOperationException(
                "Imported data class '${literal.StructType.Name}' has no parameterless constructor and no positional primary-constructor shape to construct through."
            )
        }
        let primaryCtor = ResolveImportedPositionalConstructor(importedClrType, parameters.Length) ??
            throw InvalidOperationException(
            "Imported data class '${literal.StructType.Name}' has no positional constructor matching its ${parameters.Length}-member shape."
        )
        let initializersByName = Dictionary[string, BoundFieldInitializer](StringComparer.Ordinal)
        for init in literal.Initializers {
            initializersByName[init.MemberName] = init
        }
        let consumed = HashSet[BoundFieldInitializer]()
        for parameter in parameters {
            if !initializersByName.TryGetValue(parameter.Name, out var init) {
                throw InvalidOperationException(
                    "Imported data class '${literal.StructType.Name}' is missing a value for positional member '${parameter.Name}'."
                )
            }
            this.EmitExpression(init.Value)
            consumed.Add(init)
        }
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(this.outer.memberRefs.GetCtorReference(primaryCtor))
        for init in literal.Initializers {
            if consumed.Contains(init) {
                continue
            }
            if init.Property != nil {
                let setterHandle = this.ResolveStructLiteralSetter(literal.StructType, init.Property, isGeneric: true)
                this.il.OpCode(ILOpCode.Dup)
                this.EmitExpression(init.Value)
                this.il.OpCode(ILOpCode.Callvirt)
                this.il.Token(setterHandle)
                continue
            }
            // This branch executes but resolves to the same token as the else-arm for every
            // expressible program. The !isGeneric guard above excludes imported and user-authored
            // generics, so both that guard and generic-record support must change before this discriminates.
            let initField = Invariant.Required(
                init.Field,
                "a field initializer targets either a field or a property, and the property form is handled above",
                expression: "init.Field"
            )
            let fieldHandle = if init.FieldDeclaringType != nil {
                this.ResolveStructLiteralFieldToken(literal, init)
            } else {
                this.outer.userTokens.ResolveFieldToken(literal.StructType, initField)
            }
            this.il.OpCode(ILOpCode.Dup)
            this.EmitExpression(init.Value)
            this.il.OpCode(ILOpCode.Stfld)
            this.il.Token(fieldHandle)
        }
    }

    /// Issue #1211: resolves the setter/init accessor MethodDef (or
    /// TypeSpec-parented MemberRef for a constructed generic) for a property
    /// targeted by a composite-literal initializer.
    private func ResolveStructLiteralSetter(
        structType StructSymbol,
        property PropertySymbol,
        isGeneric bool
    ) EntityHandle {
        if isGeneric {
            return this.outer.userTokens.ResolveUserPropertyAccessorToken(structType, property, wantSetter: true)
        }
        if this.outer.cache.PropertyAccessorHandles.TryGetValue(property, out var handles) && (handles.Setter != nil) {
            return handles.Setter!!
        }
        throw InvalidOperationException("Property '${property.Name}' has no emitted setter MethodDef.")
    }

    private func EmitNullConditionalAccess(nc BoundNullConditionalAccessExpression) {
        // Issue #1213: a `void`-typed null-conditional (e.g. the event-raise
        // form `evt?.Invoke(args)` where the delegate returns `void`) leaves no
        // value on the stack. Emit a plain null-guarded access: evaluate the
        // receiver into the capture, skip the access when null, otherwise run
        // the (value-less) access. Neither branch pushes a result, so the stack
        // stays balanced (the generic path below would push a `null` on the nil
        // branch with no matching value on the not-null branch).
        if object.ReferenceEquals(nc.Type, TypeSymbol.Void) {
            let endVoid = this.il.DefineLabel()
            let nonNullVoid = this.il.DefineLabel()
            this.EmitNullConditionalReceiverProbe(nc, nonNullVoid)
            this.il.Branch(ILOpCode.Br, endVoid)
            this.il.MarkLabel(nonNullVoid)
            this.EmitExpression(nc.WhenNotNull)
            this.il.MarkLabel(endVoid)
            return
        }
        // Phase 3.C.3b / ADR-0001: evaluate the receiver once into a
        // synthetic capture local. If the captured value is null, leave
        // null on the stack and skip the access; otherwise evaluate the
        // access sub-tree, which references the capture local in place
        // of the original receiver.
        let end = this.il.DefineLabel()
        let nonNull = this.il.DefineLabel()
        this.EmitNullConditionalReceiverProbe(nc, nonNull)
        if nc.ResultSlot != nil {
            // P2-7 / Issue #421: value-type access result. The bound type
            // is Nullable<T> but the access sub-tree pushes a raw T. The
            // nil branch must materialize `default(Nullable<T>)` and the
            // not-null branch must wrap T via `Nullable<T>::.ctor(!0)`
            // so both branches leave the same Nullable<T> stack shape.
            //
            // ADR-0073 / issue #710: when WhenNotNull is itself already a
            // Nullable<T> (e.g. inner `?[]`/`?.` produced a lifted value),
            // we must NOT re-wrap with another `newobj Nullable<T>::.ctor`
            // — both branches just need to leave a Nullable<T> on the
            // stack. The nil branch still uses the slot to materialize
            // `default(Nullable<T>)`.
            let slot = this.locals[nc.ResultSlot]
            let nullableType = cast[NullableTypeSymbol](nc.Type)
            let underlying = nullableType.UnderlyingType
            // Issue #1475: a user-declared value-type underlying (enum or
            // struct) has no runtime `ClrType`, so the BCL-backed
            // `TryConstructNullable` path below cannot fire. Materialise the
            // nil-branch `default(Nullable<UserT>)` and the not-null-branch
            // `newobj Nullable<UserT>::.ctor(!0)` purely from emitted
            // TypeDef/TypeSpec tokens — mirroring the issue #1298 enum lift in
            // MethodBodyEmitter.Conversions. The same token path also serves a
            // value-constrained open type parameter (issue #814).
            if NullableLifting.RequiresSymbolicNullableGetValue(nullableType) ||
                underlying?.ClrType is not{IsValueType: true} {
                let nullableToken = this.outer.memberRefs.GetElementTypeToken(nullableType)
                // nil branch: ldloca slot; initobj Nullable<UserT>; ldloc slot
                this.il.LoadLocalAddress(slot)
                this.il.OpCode(ILOpCode.Initobj)
                this.il.Token(nullableToken)
                this.il.LoadLocal(slot)
                this.il.Branch(ILOpCode.Br, end)
                // not-null branch: produce UserT then wrap, or — when
                // WhenNotNull already produces Nullable<UserT> (ADR-0073 /
                // issue #710 chained `?.`/`?[]`) — emit it directly.
                this.il.MarkLabel(nonNull)
                this.EmitExpression(nc.WhenNotNull)
                if !(nc.WhenNotNull.Type is NullableTypeSymbol) {
                    let ctorToken = if underlying is TypeParameterSymbol {
                        this.outer.memberRefs.GetNullableCtorMemberRefForOpenTypeParameter(nullableType)
                    } else {
                        this.outer.memberRefs.GetNullableCtorMemberRefForUserValueType(nullableType)
                    }
                    this.il.OpCode(ILOpCode.Newobj)
                    this.il.Token(ctorToken)
                }
                this.il.MarkLabel(end)
                return
            }
            let innerClr = underlying.ClrType
            // Issue #571: construct Nullable<T> through the ReferenceResolver so
            // the open generic definition lives in the same load context as the
            // (possibly MLC-backed) inner value type. See MethodBodyEmitter.Conversions.
            if !NullableLifting.TryConstructNullable(this.outer.emitCtx.References, innerClr, out var nullableClr) {
                throw InvalidOperationException(
                    "Cannot construct Nullable<${innerClr!!.FullName}>: System.Nullable`1 is not resolvable in the reference set."
                )
            }
            let nullableInnerArg = nullableClr.GetGenericArguments()[0]
            // nil branch: ldloca slot; initobj Nullable<T>; ldloc slot
            this.il.LoadLocalAddress(slot)
            this.il.OpCode(ILOpCode.Initobj)
            this.il.Token(this.outer.memberRefs.GetTypeHandleForMember(nullableClr))
            this.il.LoadLocal(slot)
            this.il.Branch(ILOpCode.Br, end)
            // not-null branch: produce T (then wrap), or — when WhenNotNull
            // already produces Nullable<T> — emit it directly.
            this.il.MarkLabel(nonNull)
            this.EmitExpression(nc.WhenNotNull)
            if !(nc.WhenNotNull.Type is NullableTypeSymbol) {
                let ctor = nullableClr.GetConstructor([]Type{nullableInnerArg}) ??
                    throw InvalidOperationException(
                    "Nullable<${nullableInnerArg.FullName}> has no single-arg constructor."
                )
                this.il.OpCode(ILOpCode.Newobj)
                this.il.Token(this.outer.memberRefs.GetCtorReference(ctor))
            }
            this.il.MarkLabel(end)
            return
        }
        // Reference-typed access result: nullable<ref> shares the CLR
        // representation of T, so ldnull is a valid Nullable<T> value.
        this.il.OpCode(ILOpCode.Ldnull)
        this.il.Branch(ILOpCode.Br, end)
        this.il.MarkLabel(nonNull)
        this.EmitExpression(nc.WhenNotNull)
        this.il.MarkLabel(end)
    }

    // Issue #1700: evaluates a null-conditional access's receiver and
    // branches to <paramref name="nonNullTarget"/> when it has a value,
    // otherwise falls through (the caller supplies the nil-path code
    // immediately after this call). On the has-value path, `nc.Capture` is
    // populated so the (unchanged) `WhenNotNull` sub-tree — bound against
    // `nc.Capture` as its receiver — sees the same value it always has.
    //
    // A value-type `Nullable<T>` receiver (BCL, user struct/enum, or a
    // struct-constrained open type parameter) cannot reuse `nc.Capture`'s
    // slot for the raw receiver value: that slot is declared as the
    // unwrapped `T` (so member-access binding resolves `Add`/etc. against
    // `T`, not `Nullable<T>`), but the receiver expression pushes the real
    // `Nullable<T>` wrapper. Storing that wrapper into the `T`-typed capture
    // slot, then `brtrue`-ing the reloaded `T` struct, is invalid IL
    // (ilverify StackUnexpected) — this is the actual root cause, reachable
    // with or without an `await` inside the access. Route the wrapper
    // through the pre-allocated `Nullable<T>`-typed scratch slot
    // (`receiverSpillSlots[nc.Receiver]`, planned in
    // `MethodBodyPlanner.CollectLocalsAndLabels`) instead: probe `HasValue`
    // via `box; brtrue` (ECMA-335 §I.8.2.4 — boxing `Nullable<T>` yields
    // `null` when empty, a boxed `T` otherwise, giving a legally
    // branchable object reference), and only unwrap into `nc.Capture` once
    // the has-value path is confirmed.
    private func EmitNullConditionalReceiverProbe(nc BoundNullConditionalAccessExpression, nonNullTarget LabelHandle) {
        if nc.Receiver.Type is NullableTypeSymbol receiverNullable && NullableLifting.IsAnyValueTypeNullable(
            receiverNullable
        ) {
            let wrapperSlot = this.receiverSpillSlots[nc.Receiver]
            this.EmitExpression(nc.Receiver)
            this.il.StoreLocal(wrapperSlot)
            this.il.LoadLocal(wrapperSlot)
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(receiverNullable))
            let nilFallthrough = this.il.DefineLabel()
            this.il.Branch(ILOpCode.Brfalse, nilFallthrough)
            this.il.LoadLocalAddress(wrapperSlot)
            if NullableLifting.RequiresSymbolicNullableGetValue(receiverNullable) {
                this.il.OpCode(ILOpCode.Call)
                this.il.Token(this.outer.memberRefs.GetNullableGetValueMemberRefForUserValueType(receiverNullable))
            } else {
                let innerClr = receiverNullable
                    .UnderlyingType
                    .ClrType ??
                    throw InvalidOperationException(
                    "Value-type Nullable<${receiverNullable.UnderlyingType.Name}> null-conditional receiver has no CLR underlying type."
                )
                this.il.OpCode(ILOpCode.Call)
                this.il.Token(this.outer.wellKnown.GetNullableGetValueOrDefaultReference(innerClr))
            }
            this.EmitStoreVariable(nc.Capture)
            this.il.Branch(ILOpCode.Br, nonNullTarget)
            this.il.MarkLabel(nilFallthrough)
            return
        }
        // Reference-typed (or non-nullable-collapse) receiver: `nc.Capture`
        // shares the CLR representation of `nc.Receiver`, so a direct
        // store/reload/brtrue is valid IL.
        this.EmitExpression(nc.Receiver)
        this.EmitStoreVariable(nc.Capture)
        this.EmitLoadVariable(nc.Capture)
        // Issue #3867: an OPEN type parameter receiver (`func F[T](v T)` then
        // `v?.M()`) is neither a `NullableTypeSymbol` nor a known reference
        // type, so it fell through to here and `brtrue`-d a raw `!!T` stack
        // slot. `!!T` is not a branchable object reference — ilverify rejects
        // it (StackUnexpected), and at runtime the null probe degenerates into
        // a value test, so `F[int32](0)` took the NIL path and silently
        // produced `nil` instead of calling `M()` on `0`. `box !!T` first
        // (ECMA-335 §III.4.1: boxing an unconstrained type parameter yields
        // `null` only for an empty `Nullable<T>`, a real object reference for
        // every other value type, and the reference itself when `T` is a
        // reference type) — exactly csc's lowering of `v?.M()`.
        let probeBoxType TypeSymbol? = GetOpenTypeParameterProbeBoxType(nc.Receiver.Type)
        if probeBoxType != nil {
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(probeBoxType))
        }
        this.il.Branch(ILOpCode.Brtrue, nonNullTarget)
    }

    private func EmitTupleLiteral(tuple BoundTupleLiteralExpression) {
        // Phase 4.5 emit parity: `(e1, e2, ...)` lowers to
        // `newobj ValueTuple<T1, T2, ...>::.ctor(T1, T2, ...)`. The CLR
        // backing type is set by TupleTypeSymbol.BuildClrType; arity 8+
        // recursively constructs the CLR's canonical TRest chain.
        let clrType Type? = tuple.TupleType.ClrType
        let arity = tuple.TupleType.Arity
        if clrType == nil {
            // Issues #649/#3087: build every canonical ValueTuple node
            // symbolically when an element lacks a CLR type.
            this.EmitSymbolicTupleLiteral(tuple.Elements, tuple.TupleType, 0, arity)
            return
        }
        this.EmitTupleLiteral(tuple.Elements, 0, tuple.Elements.Length, clrType)
    }

    private func EmitSymbolicTupleLiteral(
        elements ImmutableArray[BoundExpression],
        tupleType TupleTypeSymbol,
        start int32,
        count int32
    ) {
        let directCount = Math.Min(count, 7)
        for var i = 0; i < directCount; i++ {
            this.EmitExpression(elements[start + i])
        }
        if count > 7 {
            this.EmitSymbolicTupleLiteral(elements, tupleType, start + 7, count - 7)
        }
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(this.outer.memberRefs.GetTupleCtorReference(tupleType, start, count))
    }

    private func EmitTupleElementAccess(access BoundTupleElementAccessExpression, addressOnly bool = false) {
        // Tuple elements are fields. Member writes need ldflda so a setter
        // updates the stored struct instead of a copy (issue #5023).
        var clrType Type? = access.TupleType.ClrType
        if clrType == nil {
            // Issues #649/#3087: traverse canonical Rest nodes using
            // symbolic TypeSpecs when an element lacks a CLR type.
            this.EmitSymbolicTupleElementAccess(
                access.TupleType,
                access.Index,
                () -> this.EmitInstanceReceiver(access.Receiver, isReadOnlyCall: addressOnly),
                addressOnly: addressOnly
            )
            return
        }
        this.EmitInstanceReceiver(access.Receiver, isReadOnlyCall: addressOnly)
        var remainingIndex = access.Index
        while remainingIndex >= 7 {
            this.il.OpCode(ILOpCode.Ldflda)
            this.il.Token(this.outer.memberRefs.GetFieldReferenceOnConstructedGeneric(clrType!!, "Rest"))
            clrType = clrType!!.GetGenericArguments()[7]
            remainingIndex -= 7
        }
        let fieldName = "Item" + (remainingIndex + 1).ToString(CultureInfo.InvariantCulture)
        this.il.OpCode(
            if addressOnly {
                ILOpCode.Ldflda
            } else {
                ILOpCode.Ldfld
            }
        )
        if clrType!!.IsConstructedGenericType {
            this.il.Token(this.outer.memberRefs.GetFieldReferenceOnConstructedGeneric(clrType!!, fieldName))
            return
        }
        let field = clrType!!.GetField(fieldName) ??
            throw InvalidOperationException("ValueTuple type '${clrType!!.FullName}' has no public field '$fieldName'.")
        this.il.Token(this.outer.memberRefs.GetFieldReference(field))
    }

    private func EmitSymbolicTupleElementAccess(
        tupleType TupleTypeSymbol,
        index int32,
        emitReceiver() -> void,
        takeRestAddress bool = true,
        addressOnly bool = false
    ) {
        var index = index
        emitReceiver()
        var start = 0
        var count = tupleType.Arity
        while index >= 7 {
            this.il.OpCode(
                if takeRestAddress {
                    ILOpCode.Ldflda
                } else {
                    ILOpCode.Ldfld
                }
            )
            this.il.Token(this.outer.memberRefs.GetTupleFieldReference(tupleType, start, count, "Rest"))
            start += 7
            count -= 7
            index -= 7
        }
        let fieldName = "Item" + (index + 1).ToString(CultureInfo.InvariantCulture)
        this.il.OpCode(
            if addressOnly {
                ILOpCode.Ldflda
            } else {
                ILOpCode.Ldfld
            }
        )
        this.il.Token(this.outer.memberRefs.GetTupleFieldReference(tupleType, start, count, fieldName))
    }

    private func EmitTupleLiteral(elements ImmutableArray[BoundExpression], start int32, count int32, clrType Type) {
        let directCount = Math.Min(count, 7)
        for var i = 0; i < directCount; i++ {
            this.EmitExpression(elements[start + i])
        }
        if count > 7 {
            let restType = clrType.GetGenericArguments()[7]
            this.EmitTupleLiteral(elements, start + 7, count - 7, restType)
        }
        let parameterCount = if count > 7 {
            8
        } else {
            count
        }
        this.il.OpCode(ILOpCode.Newobj)
        if clrType.IsConstructedGenericType {
            this.il.Token(this.outer.memberRefs.GetCtorReferenceOnConstructedGeneric(clrType, parameterCount))
            return
        }
        var ctor ConstructorInfo? = nil
        for candidate in clrType.GetConstructors() {
            if candidate.GetParameters().Length == parameterCount {
                ctor = candidate
                break
            }
        }
        if ctor == nil {
            throw InvalidOperationException(
                "ValueTuple type '${clrType.FullName}' has no constructor of arity $parameterCount."
            )
        }
        this.il.Token(this.outer.memberRefs.GetCtorReference(ctor))
    }

    /// Issue #4224: emits a call to a native (same-compilation) function,
    /// leaving whatever the callee's signature returns on the stack — a
    /// managed pointer `T&` for a `ref`-returning function,
    /// otherwise `T`. Extracted from the (cref:BoundCallExpression)
    /// case of (cref:EmitExpression) so (cref:EmitAddressOf) can
    /// reuse it without the trailing (cref:EmitRefReturnDereferenceIfNeeded)
    /// dereference — taking the address of a ref-returning call/property
    /// keeps the raw `T&` instead of loading through it.
    private func EmitCallExpressionCore(call BoundCallExpression) {
        // ADR-0047 §6 / issue #176: a [Conditional("SYMBOL")] call whose
        // symbol is undefined is elided at the call site — emit no IL for
        // arguments or the call itself. The call is a no-op of type void; the
        // enclosing BoundExpressionStatement already skips the Pop because
        // call.Type == Void.
        if call.IsConditionalElided {
            return
        }
        // Issue #3226: an unconstrained `T?` slot (e.g. the receiver of
        // `func (self T?) MyOrElse[T](fb T) T`) erases to the bare MVAR
        // `!!T`, so a value-type instantiation must be lifted to
        // `Nullable<X>` — see TryPlanUnconstrainedNullableLift.
        let nullableLift UnconstrainedNullableLiftPlan? = this.TryPlanUnconstrainedNullableLift(call)
        if this.outer.closures.GenericLocalClosures.TryGetValue(call.Function, out var genericLocal) {
            this.EmitGenericLocalClosureInstance(genericLocal.Literal, genericLocal.Info)
            for var i = 0; i < call.Arguments.Length; i++ {
                this.EmitExpression(call.Arguments[i])
                if nullableLift?.ArgumentWraps[i] is {} liftWrap {
                    this.EmitUnconstrainedNullableLiftWrap(liftWrap)
                }
            }
            if !this.outer.cache.MethodHandles.TryGetValue(genericLocal.Info.InvokeMethod, out var invokeHandle) {
                throw InvalidOperationException(
                    "Closure invoke method '${genericLocal.Info.InvokeMethod.Name}' has no emitted MethodDef."
                )
            }
            // Issue #4341 follow-up: when the closure class was reified over
            // its GENERIC lexical encloser's own type parameters (nested to
            // preserve private/protected access), the open MethodDef is not
            // a valid call target — a MemberRef parented at the constructed
            // closure TypeSpec is required first, matching
            // ResolveUserInstanceMethodToken's ADR-0087 §3 R3 handling.
            var invokeToken = if ReflectionMetadataEmitter.IsUserGenericTypeReference(
                genericLocal.Info.ConstructedClassSym
            ) {
                this
                    .outer
                    .userTokens
                    .ResolveUserInstanceMethodToken(
                    genericLocal.Info.ConstructedClassSym,
                    genericLocal.Info.InvokeMethod,
                    invokeHandle
                )
            } else {
                invokeHandle
            }
            if call.Function.IsGeneric && !call.Function.TypeParameters.IsDefaultOrEmpty {
                invokeToken = if nullableLift != nil {
                    this.outer.userTokens.BuildMethodSpecForLiftedGenericCall(invokeToken, nullableLift.TypeArguments)
                } else {
                    this.outer.userTokens.BuildMethodSpecForGenericCall(invokeToken, call)
                }
            }
            this.il.OpCode(ILOpCode.Call)
            this.il.Token(invokeToken)
            return
        }
        for var i = 0; i < call.Arguments.Length; i++ {
            let arg = call.Arguments[i]
            this.EmitExpression(arg)
            if nullableLift?.ArgumentWraps[i] is {} liftWrap {
                this.EmitUnconstrainedNullableLiftWrap(liftWrap)
            }
        }
        // The OWNER token: which entity the call names. Three shapes —
        // a `shared` method on a constructed generic INTERFACE
        // (`IBox[int32].Make()`, issue #1433) or on a constructed
        // generic user TYPE (`Box[int32].Make()`, issue #1209) must be
        // referenced through a MemberRef parented at the construction's
        // TypeSpec; everything else is the bare MethodDef.
        var callTokenToEmit EntityHandle
        if call.StaticGenericInterfaceOwnerType != nil && ReflectionMetadataEmitter.IsUserGenericInterfaceReference(
            call.StaticGenericInterfaceOwnerType
        ) {
            // The substituted method is not in the handle cache, so this
            // resolves without the generic-struct/cache lookups below.
            callTokenToEmit = this
                .outer
                .userTokens
                .ResolveUserInterfaceStaticMethodToken(call.StaticGenericInterfaceOwnerType!!, call.Function)
        } else {
            if !this
                .outer
                .cache
                .FunctionHandles
                .TryGetValue(call.Function, out var fnHandle) &&
                !this
                .outer
                .cache
                .MethodHandles
                .TryGetValue(call.Function, out fnHandle) {
                throw InvalidOperationException("Call to function '${call.Function.Name}' has no emitted MethodDef.")
            }
            callTokenToEmit = if call.StaticGenericOwnerType != nil &&
                ReflectionMetadataEmitter
                .IsUserGenericTypeReference(call.StaticGenericOwnerType) {
                this.outer.userTokens.ResolveUserStaticMethodToken(call.StaticGenericOwnerType!!, call.Function)
            } else {
                fnHandle
            }
        }
        // ADR-0087 §3 R3+R4: when the target is a generic function,
        // every call must reference it via a MethodSpec carrying
        // the substituted type arguments — bare MethodDef tokens
        // would carry MVAR slots and fail ilverify against the
        // concrete argument types.
        //
        // Issue #3939: this MUST be applied on TOP of whatever owner
        // token was selected above, not INSTEAD of it. The two are
        // independent axes — the owner token says which type the method
        // belongs to, the MethodSpec says how the METHOD is
        // instantiated — and a `shared func Make[U]()` on a generic
        // `Box[T]` / `IBox[T]` needs both. Selecting one or the other
        // (which is what an `else if` did here through #1209 and #1433)
        // emitted `call Box`1<int32>::Make(!!0)` naming the OPEN generic
        // method: `[found ref 'string'][expected ref '!!0']` from
        // ILVerify and `InvalidOperationException: Could not execute the
        // method because either the method itself or the containing type
        // is not fully instantiated` at the first call. The INSTANCE
        // sibling (`EmitUserInstanceCall` in MethodBodyEmitter.Calls.cs)
        // has always done both, sequentially: it resolves a
        // TypeSpec-parented MemberRef for a generic receiver and THEN
        // wraps it in a MethodSpec whenever `call.Method.IsGeneric`.
        // This is the static path catching up.
        if call.Function.IsGeneric && !call.Function.TypeParameters.IsDefaultOrEmpty {
            // Issue #3226: a lifted call instantiates the MethodSpec at
            // Nullable<X> so the erased `!!T` slots really carry the
            // nullable representation the T? contract promises.
            callTokenToEmit = if nullableLift != nil {
                this.outer.userTokens.BuildMethodSpecForLiftedGenericCall(callTokenToEmit, nullableLift.TypeArguments)
            } else {
                this.outer.userTokens.BuildMethodSpecForGenericCall(callTokenToEmit, call)
            }
        }
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(callTokenToEmit)
        // Issue #3226: a lifted call whose declared return is the bare
        // lifted T leaves Nullable<X> on the stack; unwrap it back to
        // the X the bound tree types the call as.
        if nullableLift?.ReturnUnwrap is {} liftUnwrap {
            this.EmitUnconstrainedNullableLiftUnwrap(liftUnwrap)
        }
    }

    /// ADR-0039: Emits address-of by dispatching on the operand shape.
    private func EmitAddressOf(node BoundAddressOfExpression) {
        switch node.Operand {
            case block is BoundBlockExpression {
                // Issue #3355: execute prefix statements, then take the
                // address of the trailing lvalue. Keeping address-of as the
                // outer bound shape preserves ref/out call classification.
                this.EmitBlockExpressionPrefix(block)
                this.EmitAddressOf(
                    BoundAddressOfExpression(node.Syntax, block.Expression, node.IsUnmanaged, node.IsReadOnly)
                )
            }
            case conditional is BoundConditionalExpression {
                this.EmitConditionalAddress(
                    BoundConditionalAddressExpression(
                        conditional.Syntax,
                        conditional.Condition,
                        conditional.WhenTrue,
                        conditional.WhenFalse,
                        conditional.Type
                    )
                )
            }
            case bve is BoundVariableExpression {
                // Issue #1988 (follow-up to #1917/#1982): route through the
                // narrowing-aware helper so `&narrowedStructLocal` (a
                // smart-cast-narrowed struct read of a reference-typed slot,
                // ADR-0069) unboxes instead of taking the address of the
                // underlying `object` slot — see TryLoadStructVariableAddress.
                if !this.TryLoadStructVariableAddress(bve) {
                    throw InvalidOperationException("Cannot take address of variable '${bve.Variable.Name}'.")
                }
            }
            case fa is BoundFieldAccessExpression {
                this.EmitFieldAddress(fa)
            }
            case tuple is BoundTupleElementAccessExpression {
                this.EmitTupleElementAccess(tuple, addressOnly: true)
            }
            case BoundClrPropertyAccessExpression{Member: FieldInfo field} access {
                if access.Receiver != nil {
                    this.EmitInstanceReceiver(access.Receiver, isReadOnlyCall: true)
                }
                this.il.OpCode(
                    if field.IsStatic {
                        ILOpCode.Ldsflda
                    } else {
                        ILOpCode.Ldflda
                    }
                )
                this.il.Token(
                    if access.StaticContainerType != nil {
                        this.outer.memberRefs.GetFieldReference(field, access.StaticContainerType)
                    } else {
                        this.outer.memberRefs.GetFieldReference(field)
                    }
                )
            }
            case idx is BoundIndexExpression {
                this.EmitExpression(idx.Target)
                if GetRectangularArrayType(idx.Target.Type) is {} rectangular {
                    for index in idx.Indices {
                        this.EmitExpression(index)
                    }
                    this.il.OpCode(ILOpCode.Call)
                    this.il.Token(this.outer.memberRefs.GetRectangularArrayMemberReference(rectangular, "Address"))
                } else {
                    this.EmitExpression(idx.Index)
                    this.EmitLoadElementAddress(idx.Type)
                }
            }
            case deref is BoundDereferenceExpression {
                // &(*p) = p — just emit the pointer value.
                this.EmitExpression(deref.Operand)
            }
            case call is BoundCallExpression {
                this.EmitCallExpressionCore(call)
            }
            case uic is BoundUserInstanceCallExpression {
                this.EmitUserInstanceCall(uic)
            }
            case propAcc is BoundPropertyAccessExpression {
                this.EmitPropertyAccess(propAcc, addressOnly: true)
            }
            case baseInterface is BoundBaseInterfaceCallExpression {
                this.EmitBaseInterfaceCall(baseInterface)
            }
            case BoundBaseClassCallExpression{Method: not nil} baseClass {
                this.EmitBaseClassCall(baseClass)
            }
            case constrainedStatic is BoundConstrainedStaticCallExpression {
                this.EmitConstrainedStaticCall(constrainedStatic)
            }
            default {
                throw InvalidOperationException(
                    "Cannot take address of expression kind '${node.Operand.GetType().Name}'."
                )
            }
        }
    }

    /// ADR-0061: Emits a conditional address-of (`cond ? &a : &b`) as
    /// a CIL branch that selects one of two address-of forms onto the
    /// evaluation stack. The result is a managed pointer (`T&`)
    /// with the same verifier type as either branch.
    /// @param node The conditional address-of bound node.
    private func EmitConditionalAddress(node BoundConditionalAddressExpression) {
        let falseLabel = this.il.DefineLabel()
        let doneLabel = this.il.DefineLabel()
        // <cond>
        this.EmitExpression(node.Condition)
        // brfalse falseLabel
        this.il.Branch(ILOpCode.Brfalse, falseLabel)
        // <addr of WhenTrue>
        this.EmitAddressOf(BoundAddressOfExpression(nil, node.WhenTrueOperand))
        // br doneLabel
        this.il.Branch(ILOpCode.Br, doneLabel)
        // falseLabel:
        this.il.MarkLabel(falseLabel)
        // <addr of WhenFalse>
        this.EmitAddressOf(BoundAddressOfExpression(nil, node.WhenFalseOperand))
        // doneLabel:
        this.il.MarkLabel(doneLabel)
    }

    /// ADR-0062: Emits a general two-arm conditional (ternary) as a CIL
    /// branch that selects one of two value-producing arms onto the
    /// evaluation stack. Both arms have already been converted to the
    /// node's result type by the binder.
    /// @param node The conditional expression bound node.
    private func EmitConditional(node BoundConditionalExpression) {
        let falseLabel = this.il.DefineLabel()
        let doneLabel = this.il.DefineLabel()
        this.EmitExpression(node.Condition)
        this.il.Branch(ILOpCode.Brfalse, falseLabel)
        this.EmitExpression(node.WhenTrue)
        this.EmitInterfaceMergeCastIfNeeded(node.WhenTrue, node.Type)
        this.il.Branch(ILOpCode.Br, doneLabel)
        this.il.MarkLabel(falseLabel)
        this.EmitExpression(node.WhenFalse)
        this.EmitInterfaceMergeCastIfNeeded(node.WhenFalse, node.Type)
        this.il.MarkLabel(doneLabel)
    }

    /// Issue #1480: when a conditional/if-expression or null-coalescing (`??`)
    /// result type is an interface (or a nullable interface), a class branch that
    /// implements that interface is a reference-level no-op at emit time — the
    /// value left on the stack is the concrete class, not the interface. At the
    /// branches' merge point the CLR verifier computes the least-common type of
    /// the two branch classes, which is their shared <em>base class</em> (the
    /// verifier merge never yields an interface), so the merged value fails to
    /// satisfy the interface-typed consumer
    /// (`StackUnexpected [found ref 'Base'][expected ref 'IShape']`) →
    /// unverifiable IL / (cref:System.InvalidProgramException). Emit an
    /// explicit `castclass` to the interface on each value branch so both
    /// branches leave exactly the interface reference and the merge is the
    /// interface itself. The cast is verifiable because the binder already proved
    /// every branch implicitly converts to the interface. A `never` (throw)
    /// or `nil` branch leaves no class value to realign and is skipped.
    /// @param branch The bound branch expression.
    /// @param resultType The conditional/coalesce result type.
    private func EmitInterfaceMergeCastIfNeeded(branch BoundExpression, resultType TypeSymbol) {
        let castTarget = if resultType is NullableTypeSymbol nrt {
            nrt.UnderlyingType
        } else {
            resultType
        }
        if !IsInterfaceTargetType(castTarget) {
            return
        }
        let branchType = branch?.Type
        if branchType == TypeSymbol.Never || branchType == TypeSymbol.Null {
            return
        }
        this.il.OpCode(ILOpCode.Castclass)
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(castTarget))
    }

    /// ADR-0039: Emits a dereference (load indirect) from a managed pointer.
    private func EmitDereference(node BoundDereferenceExpression) {
        this.EmitExpression(node.Operand)
        if !TypeSymbol.TryGetPointeeType(node.Operand.Type, out var pointeeType) {
            throw InvalidOperationException("Cannot dereference non-pointer type '${node.Operand.Type}'.")
        }
        this.EmitLoadIndirect(pointeeType)
    }

    /// ADR-0069 / issue #700: when a variable read carries a narrowed type
    /// distinct from the variable's declared type, emit a single
    /// conversion opcode so the IL stack matches the narrower type:
    /// - `unbox.any T` when the narrowed type is a value type — the load left a boxed reference on the
    /// stack and we need the native value-type representation back.
    /// - `castclass T` when the narrowed type is a reference type — the load left a base-class or interface
    /// reference on the stack and we need the derived reference. The CLR-level cast is guaranteed to
    /// succeed because the binder placed it inside a region where an `is` test already verified the runtime
    /// type at the same site.
    ///
    /// The cast is suppressed when the narrowing is a pure nullable strip
    /// (e.g. `string? → string`) — the underlying CLR representation
    /// is identical, and emitting `castclass` would still be sound
    /// but pointlessly grows the body.
    private func EmitNarrowingCastIfNeeded(v BoundVariableExpression) {
        this.EmitNarrowingCastIfNeeded(v.Variable.Type, v.NarrowedType)
    }

    /// ADR-0069 / issue #1180: emit the single conversion opcode that realigns
    /// the IL stack to a smart-cast narrowed type. Shared by narrowed variable
    /// reads and narrowed stable member-access reads (field / property). A pure
    /// nullable strip (`T? → T`) or a same-runtime-type alias needs no IL.
    /// @param declared The statically declared type of the read.
    /// @param narrowed The narrowed type, or `null` when not narrowed.
    private func EmitNarrowingCastIfNeeded(declared TypeSymbol, narrowed TypeSymbol?) {
        if narrowed == nil {
            return
        }
        if declared == narrowed {
            return
        }
        // Pure nullable strip (`T? → T`) needs no IL change: the CLR
        // representation is identical for reference-type nullables, and
        // value-type nullables route through the existing
        // <c>EmitConversion</c> path before reaching here.
        //
        // Issue #4943: that routing is the binder's job
        // (`ExpressionBinder.BuildNarrowedRead` wraps the read in a `!!`
        // unwrap). A narrowed node that reaches here over value-type
        // `Nullable<T>` storage would leave the `Nullable<T>` on the stack
        // where `T` is expected — for a function pointer, `calli` then
        // jumped to a garbage address. Fail loudly instead of emitting it.
        if declared is NullableTypeSymbol valueNullable && NullableLifting.IsAnyValueTypeNullable(valueNullable) &&
            !(narrowed is NullableTypeSymbol) {
            throw InvalidOperationException(
                "A smart-cast read of value-type nullable storage '${declared.Name}' narrowed to '${narrowed.Name}' " +
                    "reached emit without its Nullable<T> unwrap; build narrowed reads with " +
                    "ExpressionBinder.BuildNarrowedRead (issue #4943)."
            )
        }
        if declared is NullableTypeSymbol nts && nts.UnderlyingType == narrowed {
            return
        }
        // Skip when both sides are non-null CLR types that resolve to the
        // same runtime type (e.g. an imported alias).
        if declared?.ClrType != nil && narrowed.ClrType != nil && declared.ClrType == narrowed.ClrType {
            return
        }
        // Issue #2165: an UNCONSTRAINED type-parameter operand (e.g. `x T`
        // narrowed to a tested interface `IInit`) sits on the stack as a bare
        // `!!T` slot, not an ObjRef — `castclass`/`unbox.any` both require an
        // ObjRef and would fail ilverify (`StackObjRef`). Box the type parameter
        // first (a no-op for reference-constrained T, matching the operand
        // boxing already applied by `EmitIsExpression`) so the following
        // reference/value cast operates on a boxed reference.
        // Issue #2171: a NULLABLE type-parameter operand (`x T?`) has the same
        // bare-slot representation over its underlying type parameter, so box
        // the underlying type parameter in that case too.
        if declared is TypeParameterSymbol {
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(declared))
        } else if declared is NullableTypeSymbol declaredNullable &&
            declaredNullable.UnderlyingType is TypeParameterSymbol underlyingTypeParameter {
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(underlyingTypeParameter))
        }
        // Issue #2335 (audit follow-up): mirrors the identical generalization
        // in EmitTypePattern — a bare (ANY-constraint, including fully
        // unconstrained) `narrowed` TYPE PARAMETER cannot pick between
        // `unbox.any` and `castclass` from `IsValueTypeSymbol`/`ClrType`
        // alone, since an unconstrained (or class/interface-constrained) `T`
        // can still close over a value type at a given instantiation (e.g.
        // narrowing an `object`-typed variable to `T` inside
        // `func F[T](x object) { if x is T { return x } }`, closed over
        // `int32`). `castclass !!T` is invalid/silently-wrong IL for that
        // closure. Per ECMA-335 III.4.32, `unbox.any` degrades to the exact
        // `castclass` behavior when the closed type turns out to be a
        // reference type, so it is the single opcode correct for every
        // constraint/closure combination — route every bare type-parameter
        // narrowing target through it, in addition to the concrete
        // value-type shapes `IsValueTypeSymbol` already recognizes.
        if narrowed is TypeParameterSymbol || ReflectionMetadataEmitter.IsValueTypeSymbol(narrowed) ||
            (narrowed.ClrType != nil && narrowed.ClrType.IsValueType) {
            this.il.OpCode(ILOpCode.Unbox_any)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(narrowed))
            return
        }
        this.il.OpCode(ILOpCode.Castclass)
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(narrowed))
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Issue #575: expression-level `is` / `as` operators.
    // ──────────────────────────────────────────────────────────────────────
    /// Emits `expr is pattern` → `bool`:
    /// ```
    /// input = expr
    /// EmitPattern(pattern, input, fail)
    /// true
    /// br done
    /// fail:
    /// false
    /// done:
    /// ```
    private func EmitIsExpression(node BoundIsExpression) {
        // ADR-0166: a type test that binds a pattern variable takes the general
        // path so the matched value is stored into the variable's slot.
        if node.IsSimpleTypeTest && node.Pattern is BoundTypePattern typePattern {
            this.EmitSimpleTypeIsExpression(node.Expression, typePattern.TargetType)
            return
        }
        let inputSlot = this.locals[node.InputVariable]
        this.EmitExpression(node.Expression)
        this.il.StoreLocal(inputSlot)
        let failLabel = this.il.DefineLabel()
        let doneLabel = this.il.DefineLabel()
        this.EmitPattern(
            node.Pattern,
            loadValue: () -> this.il.LoadLocal(inputSlot),
            valueType: node.Expression.Type,
            failLabel
        )
        this.il.LoadConstantI4(1)
        this.il.Branch(ILOpCode.Br, doneLabel)
        this.il.MarkLabel(failLabel)
        this.il.LoadConstantI4(0)
        this.il.MarkLabel(doneLabel)
    }

    private func EmitSimpleTypeIsExpression(expression BoundExpression, targetType TypeSymbol) {
        this.EmitExpression(expression)
        // Preserve the issue #575 type-test lowering byte-for-byte for source
        // compatibility and stable emitted baselines. General patterns use the
        // value-producing EmitPattern wrapper above.
        let operandType = expression.Type
        var boxNeeded = ReflectionMetadataEmitter.IsValueTypeSymbol(operandType)
        var boxType = operandType
        if !boxNeeded {
            if operandType is TypeParameterSymbol {
                boxNeeded = true
            } else if operandType is NullableTypeSymbol nullableOperand &&
                nullableOperand.UnderlyingType is TypeParameterSymbol underlyingTp {
                boxNeeded = true
                boxType = underlyingTp
            }
        }
        if boxNeeded {
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(boxType))
        }
        let isinstTarget = if targetType is NullableTypeSymbol nullableTarget {
            nullableTarget.UnderlyingType
        } else {
            targetType
        }
        this.il.OpCode(ILOpCode.Isinst)
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(isinstTarget))
        this.il.OpCode(ILOpCode.Ldnull)
        this.il.OpCode(ILOpCode.Cgt_un)
    }

    /// Emits `expr as T` → `T` (reference type) or `T?` (nullable value type):
    /// ```
    /// [expr]
    /// box (if value type source)
    /// isinst T
    /// unbox.any T (if T is value type — produces Nullable<T>)
    /// ```
    /// For reference-type targets, `isinst` alone suffices (yields the
    /// cast reference or null).
    private func EmitAsExpression(node BoundAsExpression) {
        this.EmitExpression(node.Expression)
        // Box value-type operands. Issue #1467: an unconstrained type-parameter
        // operand (or `T?` over one) also sits unboxed on the stack and must be
        // boxed before `isinst`.
        let operandType = node.Expression.Type
        var boxNeeded = ReflectionMetadataEmitter.IsValueTypeSymbol(operandType)
        var boxType = operandType
        if !boxNeeded {
            if operandType is TypeParameterSymbol {
                boxNeeded = true
            } else if operandType is NullableTypeSymbol nullableOperand &&
                nullableOperand.UnderlyingType is TypeParameterSymbol underlyingTp {
                boxNeeded = true
                boxType = underlyingTp
            }
        }
        if boxNeeded {
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(boxType))
        }
        // Determine the isinst target type. For any `as T?` (nullable target),
        // `isinst` targets the underlying type T (reference nullability is not a
        // distinct CLR type, and a value-type `Nullable<T>` is never the isinst
        // operand). For value-type targets we additionally unbox.any to Nullable<T>.
        //
        // Issue #4241: a same-compilation user value type (struct/enum) has no
        // `ClrType` at emit time, so the raw `ClrType is { IsValueType: true }`
        // probe missed it and `unbox.any` was skipped entirely — the `isinst`
        // result (a boxed-object reference or null) was left on the stack and
        // stored straight into the `Nullable<T>`-typed spill slot, reinterpreting
        // the pointer's bytes as the struct's fields. `IsAnyValueTypeNullable`
        // additionally recognises symbolic user value types (and other
        // ClrType-less value-type underlyings), matching the emit-side
        // `GetElementTypeToken`/`NullableValueTypeUnwrapCollector` predicate.
        let isNullableValueTarget = node.TargetType is NullableTypeSymbol nts2 &&
            NullableLifting.IsAnyValueTypeNullable(nts2)
        let isinstTarget = if node.TargetType is NullableTypeSymbol nts3 {
            nts3.UnderlyingType
        } else {
            node.TargetType
        }
        this.il.OpCode(ILOpCode.Isinst)
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(isinstTarget))
        if isNullableValueTarget {
            // Unbox to Nullable<T> — converts the boxed T (or null) to a Nullable<T> value.
            this.il.OpCode(ILOpCode.Unbox_any)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(node.TargetType))
        } else if isinstTarget is TypeParameterSymbol {
            // Issue #1467: `expr as T` where T is a type parameter must convert
            // the boxed `isinst` result back to the `!i`/`!!i` value form via
            // `unbox.any`, otherwise the stack carries a reference where the
            // type-parameter value slot is expected.
            this.il.OpCode(ILOpCode.Unbox_any)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(isinstTarget))
        }
    }

    shared {
        private func GetRectangularArrayType(type TypeSymbol) RectangularArrayTypeSymbol? {
            if type is RectangularArrayTypeSymbol rectangular {
                return rectangular
            }
            return if type.ClrType is {IsArray: true} clrArray && clrArray.GetArrayRank() > 1 {
                RectangularArrayTypeSymbol.Get(
                    TypeSymbol.FromClrTypeWithoutNullability(
                        clrArray.GetElementType(),
                        NullabilityFreeReason.TypeStructure
                    ),
                    clrArray.GetArrayRank()
                )
            } else {
                default(RectangularArrayTypeSymbol?)
            }
        }

        /// Issue #2291: finds the public instance constructor on an imported
        /// record class matching its positional shape — [`parameterCount`](paramref)
        /// parameters, excluding the synthesized copy constructor
        /// (`.ctor(SameType)`, recognizable as a single parameter whose type is
        /// the declaring type itself).
        private func ResolveImportedPositionalConstructor(importedClrType Type, parameterCount int32) ConstructorInfo? {
            for ctor in ClrTypeUtilities.SafeGetConstructors(
                importedClrType,
                BindingFlags.Public | BindingFlags.Instance
            ) {
                let ctorParameters = ctor.GetParameters()
                if ctorParameters.Length != parameterCount {
                    continue
                }
                if ctorParameters.Length == 1 && ClrTypeUtilities.AreSame(
                    ctorParameters[0].ParameterType,
                    importedClrType
                ) {
                    continue
                }
                return ctor
            }
            return nil
        }

        // Issue #3867: the type to `box` before a null-conditional receiver's
        // `brtrue` probe, or null when the receiver already occupies the stack as
        // an object reference. Only OPEN type parameters need it: `T` (whose CLR
        // representation is unknown at emit time) and `T?` over an open `T` that
        // the `NullableTypeSymbol` branch above did not claim — boxing the
        // underlying `T` there is still correct, since an empty `Nullable<T>`
        // boxes to `null`.
        private func GetOpenTypeParameterProbeBoxType(receiverType TypeSymbol?) TypeSymbol? {
            return switch receiverType {
                case typeParameter is TypeParameterSymbol: typeParameter
                case NullableTypeSymbol{UnderlyingType: TypeParameterSymbol underlying}: underlying
                default: default(TypeParameterSymbol?)
            }
        }
    }
}
