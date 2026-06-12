// <copyright file="MethodBodyEmitter.Expressions.cs" company="GSharp">
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
/// expression dispatch and literal/aggregate emission.
/// See <c>MethodBodyEmitter.cs</c> for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
/// </summary>
internal sealed partial class MethodBodyEmitter
{

    private void EmitExpression(BoundExpression expression)
    {
        if (expression.Syntax != null)
        {
            this.currentNode = expression;
        }

        switch (expression)
        {
            case BoundLiteralExpression literal:
                this.EmitLiteral(literal);
                break;
            case BoundVariableExpression v:
                this.EmitLoadVariable(v.Variable);
                this.EmitNarrowingCastIfNeeded(v);
                break;
            case BoundAssignmentExpression a:
                if (a.Variable is ParameterSymbol assignParam && assignParam.RefKind != RefKind.None)
                {
                    // ADR-0060: assign-through-ref-kind-parameter lowers to
                    // `ldarg ptr; value; dup; stloc tmp; stind.*; ldloc tmp`
                    // so the expression result is the assigned value without
                    // a re-read through ldind. The temp slot is pre-allocated
                    // by AssignmentValueSpillCollector and stored in
                    // receiverSpillSlots keyed by the assignment node.
                    var assignArgIndex = this.parameters[assignParam];
                    var assignTmp = this.receiverSpillSlots[a];
                    this.il.LoadArgument(assignArgIndex);
                    this.EmitExpression(a.Expression);
                    this.il.OpCode(ILOpCode.Dup);
                    this.il.StoreLocal(assignTmp);
                    this.EmitStoreIndirect(assignParam.Type);
                    this.il.LoadLocal(assignTmp);
                }
                else if (a.Variable is LocalVariableSymbol assignLocal
                    && assignLocal.RefKind != RefKind.None
                    && this.locals.TryGetValue(assignLocal, out var refLocalSlot))
                {
                    // Issue #491 (ADR-0060 follow-up): assign-through-ref-alias-local lowers to
                    // `ldloc slot; value; dup; stloc tmp; stind.*; ldloc tmp`.
                    // The temp slot is pre-allocated by AssignmentValueSpillCollector.
                    var assignTmp = this.receiverSpillSlots[a];
                    this.il.LoadLocal(refLocalSlot);
                    this.EmitExpression(a.Expression);
                    this.il.OpCode(ILOpCode.Dup);
                    this.il.StoreLocal(assignTmp);
                    this.EmitStoreIndirect(assignLocal.Type);
                    this.il.LoadLocal(assignTmp);
                }
                else
                {
                    this.EmitExpression(a.Expression);
                    this.il.OpCode(ILOpCode.Dup);
                    this.EmitStoreVariable(a.Variable);
                }

                break;
            case BoundIndirectAssignmentExpression ia:
                {
                    // ADR-0060 §5/§13: `*p = v` lowers to
                    // `<pointer>; <value>; dup; stloc tmp; stind.*; ldloc tmp`
                    // so the expression yields the assigned value once.
                    var iaTmp = this.receiverSpillSlots[ia];
                    this.EmitExpression(ia.Pointer);
                    this.EmitExpression(ia.Value);
                    this.il.OpCode(ILOpCode.Dup);
                    this.il.StoreLocal(iaTmp);
                    this.EmitStoreIndirect(ia.Type);
                    this.il.LoadLocal(iaTmp);
                }

                break;
            case BoundUnaryExpression u:
                this.EmitUnary(u);
                break;
            case BoundBinaryExpression b:
                this.EmitBinary(b);
                break;
            case BoundCallExpression call:
                // ADR-0047 §6 / issue #176: a [Conditional("SYMBOL")] call
                // whose symbol is undefined is elided at the call site —
                // emit no IL for arguments or the call itself. The call
                // is a no-op of type void; the enclosing
                // BoundExpressionStatement already skips the Pop because
                // call.Type == Void.
                if (call.IsConditionalElided)
                {
                    break;
                }

                for (int i = 0; i < call.Arguments.Length; i++)
                {
                    var arg = call.Arguments[i];
                    this.EmitExpression(arg);

                    // Phase 4 emit parity (F1, type-erased generics):
                    // a parameter typed as an open T receives System.Object
                    // in the emitted signature. Value-type arguments must
                    // be boxed at the call boundary so the call's stack
                    // shape matches the signature.
                    if (i < call.Function.Parameters.Length
                        && call.Function.Parameters[i].Type is TypeParameterSymbol
                        && arg.Type is not TypeParameterSymbol
                        && ReflectionMetadataEmitter.IsValueTypeSymbol(arg.Type))
                    {
                        this.il.OpCode(ILOpCode.Box);
                        this.il.Token(this.outer.GetElementTypeToken(arg.Type));
                    }
                }

                if (!this.outer.cache.FunctionHandles.TryGetValue(call.Function, out var fnHandle)
                    && !this.outer.cache.MethodHandles.TryGetValue(call.Function, out fnHandle))
                {
                    throw new InvalidOperationException(
                        $"Call to function '{call.Function.Name}' has no emitted MethodDef.");
                }

                this.il.Call(fnHandle);

                this.EmitErasedObjectReturnWidening(call.Function.Type, call.Type);

                break;
            case BoundImportedCallExpression impCall:
                this.EmitImportedCallArguments(impCall.Arguments, impCall.ArgumentRefKinds);
                this.il.Call(this.outer.GetMethodEntityHandle(impCall.Function.Method, impCall.TypeArgumentSymbols));
                this.EmitErasedObjectReturnWidening(
                    TypeSymbol.FromClrType(impCall.Function.Method.ReturnType),
                    impCall.Type);
                break;
            case BoundClrStaticCallExpression staticCall:
                this.EmitImportedCallArguments(staticCall.Arguments, staticCall.ArgumentRefKinds);
                this.il.Call(this.outer.GetMethodEntityHandle(staticCall.Method));
                this.EmitErasedObjectReturnWidening(
                    TypeSymbol.FromClrType(staticCall.Method.ReturnType),
                    staticCall.Type);
                break;
            case BoundImportedInstanceCallExpression instCall:
                {
                    var receiverType = instCall.Receiver.Type is ByRefTypeSymbol byRef
                        ? byRef.PointeeType
                        : instCall.Receiver.Type;
                    var receiverIsValueType = ReflectionMetadataEmitter.IsValueTypeSymbol(receiverType);
                    var receiverIsManagedPointer = instCall.Receiver.Type is ByRefTypeSymbol;

                    // A value-type receiver invoking a method it inherits from a
                    // reference base type (System.Object/ValueType/Enum) — e.g.
                    // GetType(), or ToString()/Equals()/GetHashCode() when the
                    // value type does not override them — must be boxed. The
                    // callee's `this` is an object reference, not a managed
                    // pointer to the value; without the box the raw value bits
                    // are reinterpreted as a reference, producing an
                    // AccessViolationException (or silent corruption) at runtime.
                    var declaringType = instCall.Method.DeclaringType;
                    var receiverNeedsBox = receiverIsValueType
                        && declaringType != null
                        && !declaringType.IsValueType;

                    // A value type calling a method it declares itself receives a
                    // managed pointer (`this` is `ref TStruct`) and uses `call`;
                    // a boxed value or a reference receiver uses `callvirt`.
                    var useCall = receiverIsValueType && !receiverNeedsBox;

                    if (receiverNeedsBox)
                    {
                        // Load the receiver value (not its address) and box it so
                        // the inherited reference-type method receives a proper
                        // object reference.
                        this.EmitExpression(instCall.Receiver);
                        if (receiverIsManagedPointer)
                        {
                            this.EmitLoadIndirect(receiverType);
                        }

                        this.il.OpCode(ILOpCode.Box);
                        this.il.Token(this.outer.GetElementTypeToken(receiverType));
                    }
                    else
                    {
                        this.EmitInstanceReceiver(instCall.Receiver);
                    }

                    this.EmitImportedCallArguments(instCall.Arguments, instCall.ArgumentRefKinds);
                    var instCallHandle = this.outer.GetMethodEntityHandle(instCall.Method, instCall.TypeArgumentSymbols, receiverType);

                    this.il.OpCode(useCall ? ILOpCode.Call : ILOpCode.Callvirt);
                    this.il.Token(instCallHandle);
                    this.EmitErasedObjectReturnWidening(
                        TypeSymbol.FromClrType(instCall.Method.ReturnType),
                        instCall.Type);
                    break;
                }

            case BoundAddressOfExpression addressOf:
                this.EmitAddressOf(addressOf);
                break;
            case BoundConditionalAddressExpression conditionalAddress:
                // ADR-0061: conditional address-of (`cond ? &a : &b`).
                this.EmitConditionalAddress(conditionalAddress);
                break;
            case BoundConditionalExpression conditionalValue:
                // ADR-0062: general two-arm conditional value expression.
                this.EmitConditional(conditionalValue);
                break;
            case BoundDereferenceExpression deref:
                this.EmitDereference(deref);
                break;
            case BoundStateMachineAwaitOnCompleted awaitOnCompleted:
                this.EmitStateMachineAwaitOnCompleted(awaitOnCompleted);
                break;
            case BoundStateMachineBuilderMoveNext builderMoveNext:
                this.EmitAsyncIteratorBuilderMoveNext(builderMoveNext);
                break;
            case BoundConversionExpression conv:
                this.EmitConversion(conv);
                break;
            case BoundArrayCreationExpression arr:
                this.EmitArrayCreation(arr);
                break;
            case BoundIndexExpression idx:
                if (idx.Target.Type is MapTypeSymbol)
                {
                    this.EmitMapIndexRead(idx);
                }
                else if (idx.Target.Type == TypeSymbol.String)
                {
                    // Issue #537: string indexing via get_Chars(int32).
                    this.EmitExpression(idx.Target);
                    this.EmitExpression(idx.Index);
                    this.il.Call(this.outer.wellKnown.GetStringCharsReference());
                }
                else
                {
                    this.EmitExpression(idx.Target);
                    this.EmitExpression(idx.Index);
                    this.EmitLoadElement(idx.Type);
                }

                break;
            case BoundIndexAssignmentExpression ixa:
                var ixaTargetType = ixa.TargetExpression?.Type ?? ixa.Target.Type;
                if (ixaTargetType is MapTypeSymbol)
                {
                    this.EmitMapIndexAssignment(ixa);
                }
                else
                {
                    // Issue #418 (P1-1): evaluate target/index/value exactly once.
                    // dup + stloc tmp + stelem + ldloc tmp leaves the assigned
                    // value on the stack as the expression's result without
                    // re-evaluating the index expression (which may have side
                    // effects, e.g. a function call).
                    var tmp = this.indexAssignmentValueSlots[ixa];
                    if (ixa.TargetExpression != null)
                    {
                        this.EmitExpression(ixa.TargetExpression);
                    }
                    else
                    {
                        this.EmitLoadVariable(ixa.Target);
                    }

                    this.EmitExpression(ixa.Index);
                    this.EmitExpression(ixa.Value);
                    this.il.OpCode(ILOpCode.Dup);
                    this.il.StoreLocal(tmp);
                    this.EmitStoreElement(ixa.Type);
                    this.il.LoadLocal(tmp);
                }

                break;
            case BoundLenExpression len:
                this.EmitLen(len);
                break;
            case BoundTypeOfExpression typeOf:
                this.EmitTypeOf(typeOf);
                break;
            case BoundCapExpression cap:
                this.EmitExpression(cap.Operand);
                this.il.OpCode(ILOpCode.Ldlen);
                this.il.OpCode(ILOpCode.Conv_i4);
                break;
            case BoundAppendExpression app:
                this.EmitAppend(app);
                break;
            case BoundStructLiteralExpression structLit:
                this.EmitStructLiteral(structLit);
                break;
            case BoundBlockExpression blockExpr:
                this.EmitBlockExpression(blockExpr);
                break;
            case BoundSwitchExpression switchExpr:
                this.EmitSwitchExpression(switchExpr);
                break;
            case BoundMakeChannelExpression mkCh:
                this.EmitMakeChannelExpression(mkCh);
                break;
            case BoundChannelReceiveExpression chRecv:
                this.EmitChannelReceiveExpression(chRecv);
                break;
            case BoundChannelCloseExpression chClose:
                this.EmitChannelCloseExpression(chClose);
                break;
            case BoundConstructorCallExpression ctorCall:
                this.EmitConstructorCall(ctorCall);
                break;
            case BoundConstructorChainingExpression ctorChain:
                this.EmitConstructorChaining(ctorChain);
                break;
            case BoundUserInstanceCallExpression uic:
                this.EmitUserInstanceCall(uic);
                break;
            case BoundFieldAccessExpression fa:
                this.EmitFieldAccess(fa);
                break;
            case BoundFieldAssignmentExpression fas:
                this.EmitFieldAssignment(fas);
                break;
            case BoundPropertyAccessExpression propAcc:
                this.EmitPropertyAccess(propAcc);
                break;
            case BoundPropertyAssignmentExpression propAsn:
                this.EmitPropertyAssignment(propAsn);
                break;
            case BoundNullConditionalAccessExpression nc:
                this.EmitNullConditionalAccess(nc);
                break;
            case BoundClrConstructorCallExpression clrCtor:
                this.EmitClrConstructorCall(clrCtor);
                break;
            case BoundClrPropertyAccessExpression clrProp:
                this.EmitClrPropertyAccess(clrProp);
                break;
            case BoundClrPropertyAssignmentExpression clrPropAsn:
                this.EmitClrPropertyAssignment(clrPropAsn);
                break;
            case BoundClrEventSubscriptionExpression clrEventSub:
                this.EmitClrEventSubscription(clrEventSub);
                break;
            case BoundEventSubscriptionExpression userEventSub:
                this.EmitUserEventSubscription(userEventSub);
                break;
            case BoundClrBinaryOperatorExpression clrBinOp:
                this.EmitClrBinaryOperator(clrBinOp);
                break;
            case BoundClrUnaryOperatorExpression clrUnOp:
                this.EmitClrUnaryOperator(clrUnOp);
                break;
            case BoundClrConversionCallExpression clrConv:
                this.EmitClrConversionCall(clrConv);
                break;
            case BoundClrIndexExpression clrIdx:
                this.EmitClrIndex(clrIdx);
                break;
            case BoundClrIndexAssignmentExpression clrIdxAsn:
                this.EmitClrIndexAssignment(clrIdxAsn);
                break;
            case BoundTupleLiteralExpression tupleLit:
                this.EmitTupleLiteral(tupleLit);
                break;
            case BoundTupleElementAccessExpression tupleAcc:
                this.EmitTupleElementAccess(tupleAcc);
                break;
            case BoundFunctionLiteralExpression literal:
                this.EmitFunctionLiteral(literal);
                break;
            case BoundMethodGroupExpression methodGroup:
                this.EmitMethodGroup(methodGroup, overrideDelegateType: null);
                break;
            case BoundClrMethodGroupExpression clrMethodGroup:
                this.EmitClrMethodGroup(clrMethodGroup);
                break;
            case BoundIndirectCallExpression indirect:
                this.EmitIndirectCall(indirect);
                break;
            case BoundMapLiteralExpression mapLit:
                this.EmitMapLiteral(mapLit);
                break;
            case BoundMapDeleteExpression mapDel:
                this.EmitMapDelete(mapDel);
                break;
            case BoundDefaultExpression defaultExpr:
                this.EmitDefault(defaultExpr);
                break;
            case BoundIsExpression isExpr:
                this.EmitIsExpression(isExpr);
                break;
            case BoundAsExpression asExpr:
                this.EmitAsExpression(asExpr);
                break;
            case BoundErrorExpression:
                // GS0268: a BoundErrorExpression leaked from lowering into emit.
                // This typically means the lowerer could not resolve a required
                // method (e.g. GetEnumerator) for a for-in loop. Throw a
                // descriptive exception so BuildEmitFailureDiagnostic surfaces
                // a clear GS9998 message instead of an opaque MSB4181.
                {
                    const string msg = "Internal compiler error (GS0268): a for-in loop over an enumerable type could not be lowered. "
                        + "The collection type may not expose a resolvable GetEnumerator()/MoveNext()/Current pattern.";
                    EmitDiagnosticException.Throw(expression.Syntax, msg);
                }

                break;
            default:
                EmitDiagnosticException.Throw(
                    expression.Syntax,
                    $"Bound expression kind '{expression.Kind}' is not yet supported by the emitter.");
                break;
        }
    }

    private void EmitLiteral(BoundLiteralExpression literal)
    {
        // Phase 3.C.2 / ADR-0001: the nil literal is modeled as a null
        // BoundLiteralExpression.Value; on reference-type or nullable
        // targets it emits as ldnull.
        if (literal.Value is null)
        {
            this.il.OpCode(ILOpCode.Ldnull);
            return;
        }

        switch (literal.Value)
        {
            case string s:
                this.il.LoadString(this.outer.emitCtx.Metadata.GetOrAddUserString(s));
                break;
            case bool b:
                this.il.LoadConstantI4(b ? 1 : 0);
                break;
            case sbyte sb:
                this.il.LoadConstantI4(sb);
                break;
            case byte by:
                this.il.LoadConstantI4(by);
                break;
            case short sh:
                this.il.LoadConstantI4(sh);
                break;
            case ushort us:
                this.il.LoadConstantI4(us);
                break;
            case char ch:
                this.il.LoadConstantI4(ch);
                break;
            case int i:
                this.il.LoadConstantI4(i);
                break;
            case uint ui:
                this.il.LoadConstantI4(unchecked((int)ui));
                break;
            case long lng:
                this.il.LoadConstantI8(lng);
                break;
            case ulong ul:
                this.il.LoadConstantI8(unchecked((long)ul));
                break;
            case nint ni:
                this.il.LoadConstantI8(ni);
                this.il.OpCode(ILOpCode.Conv_i);
                break;
            case nuint nu:
                this.il.LoadConstantI8(unchecked((long)(ulong)nu));
                this.il.OpCode(ILOpCode.Conv_u);
                break;
            case float f:
                this.il.LoadConstantR4(f);
                break;
            case double d:
                this.il.LoadConstantR8(d);
                break;
            case decimal m:
                this.EmitDecimalLiteral(m);
                break;
            default:
                throw new NotSupportedException(
                    $"Literal of CLR type '{literal.Value?.GetType()}' is not yet supported.");
        }
    }

    // ADR-0044 decimal literal lowering. IL has no `ldc.decimal`, so each
    // literal is materialised by calling the
    // `Decimal(int, int, int, bool, byte)` ctor with the bit pattern
    // returned by `decimal.GetBits`. Common small values (0, 1, -1) and
    // any value that fits in `int` use the cheaper one-int ctors.
    private void EmitDecimalLiteral(decimal value)
    {
        if (value == decimal.Zero)
        {
            this.EmitDecimalStaticField(nameof(decimal.Zero));
            return;
        }

        if (value == decimal.One)
        {
            this.EmitDecimalStaticField(nameof(decimal.One));
            return;
        }

        if (value == decimal.MinusOne)
        {
            this.EmitDecimalStaticField(nameof(decimal.MinusOne));
            return;
        }

        // Try int ctor for small whole values.
        if (decimal.Truncate(value) == value && value >= int.MinValue && value <= int.MaxValue)
        {
            var asInt = (int)value;
            this.il.LoadConstantI4(asInt);
            var ctor = typeof(decimal).GetConstructor(new[] { typeof(int) });
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(ctor));
            return;
        }

        // Try long ctor.
        if (decimal.Truncate(value) == value && value >= long.MinValue && value <= long.MaxValue)
        {
            var asLong = (long)value;
            this.il.LoadConstantI8(asLong);
            var ctor = typeof(decimal).GetConstructor(new[] { typeof(long) });
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(ctor));
            return;
        }

        // General case: Decimal(int lo, int mid, int hi, bool isNegative, byte scale).
        var bits = decimal.GetBits(value);
        var lo = bits[0];
        var mid = bits[1];
        var hi = bits[2];
        var flags = bits[3];
        var isNegative = (flags & unchecked((int)0x80000000)) != 0;
        var scale = (byte)((flags >> 16) & 0x7F);

        this.il.LoadConstantI4(lo);
        this.il.LoadConstantI4(mid);
        this.il.LoadConstantI4(hi);
        this.il.LoadConstantI4(isNegative ? 1 : 0);
        this.il.LoadConstantI4(scale);

        var bigCtor = typeof(decimal).GetConstructor(new[]
        {
            typeof(int), typeof(int), typeof(int), typeof(bool), typeof(byte),
        });
        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(this.outer.GetCtorReference(bigCtor));
    }

    private void EmitDecimalStaticField(string name)
    {
        var field = typeof(decimal).GetField(name);
        this.il.OpCode(ILOpCode.Ldsfld);
        this.il.Token(this.outer.GetFieldReference(field));
    }

    private void EmitArrayCreation(BoundArrayCreationExpression arr)
    {
        this.il.LoadConstantI4(arr.Elements.Length);
        this.il.OpCode(ILOpCode.Newarr);
        this.il.Token(this.outer.GetElementTypeToken(arr.ElementType));

        for (var i = 0; i < arr.Elements.Length; i++)
        {
            this.il.OpCode(ILOpCode.Dup);
            this.il.LoadConstantI4(i);
            this.EmitExpression(arr.Elements[i]);
            this.EmitStoreElement(arr.ElementType);
        }
    }

    private void EmitLen(BoundLenExpression len)
    {
        this.EmitExpression(len.Operand);
        if (len.Operand.Type == TypeSymbol.String)
        {
            this.il.Call(this.outer.wellKnown.GetStringLengthReference());
        }
        else if (len.Operand.Type is MapTypeSymbol mapType)
        {
            // Phase 3.A.4 emit: `len(m)` -> `callvirt Dictionary<K,V>.get_Count`.
            var dictType = mapType.ClrType;
            var getCount = dictType.GetMethod("get_Count")
                ?? throw new InvalidOperationException(
                    $"Dictionary type '{dictType.FullName}' has no get_Count method.");
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(getCount));
        }
        else
        {
            this.il.OpCode(ILOpCode.Ldlen);
            this.il.OpCode(ILOpCode.Conv_i4);
        }
    }

    private void EmitTypeOf(BoundTypeOfExpression typeOf)
    {
        // Issue #143: `typeof(T)` -> ldtoken <T> ; call Type::GetTypeFromHandle.
        this.il.OpCode(ILOpCode.Ldtoken);
        this.il.Token(this.outer.GetTypeOfToken(typeOf.OperandType));
        this.il.Call(this.outer.wellKnown.GetTypeFromHandleReference());
    }

    private void EmitAppend(BoundAppendExpression app)
    {
        // Issue #418 (P1-3): name the bound-node context in the message
        // when a slot is missing so a regression in a pre-pass walker
        // surfaces an actionable error instead of a generic KeyNotFound.
        if (!this.appendSlots.TryGetValue(app, out var slots))
        {
            throw new InvalidOperationException(
                $"No slot populated for {app.Kind} on slice type '{app.SliceType?.Name}' — "
                + "walker pre-pass missed this child? "
                + "Check AppendCollector and its ancestor walker.");
        }

        var element = app.SliceType.ElementType;
        var elementToken = this.outer.GetElementTypeToken(element);

        // src = slice
        this.EmitExpression(app.Slice);
        this.il.StoreLocal(slots.Src);

        // dst = new T[src.Length + 1]
        this.il.LoadLocal(slots.Src);
        this.il.OpCode(ILOpCode.Ldlen);
        this.il.OpCode(ILOpCode.Conv_i4);
        this.il.LoadConstantI4(1);
        this.il.OpCode(ILOpCode.Add);
        this.il.OpCode(ILOpCode.Newarr);
        this.il.Token(elementToken);
        this.il.StoreLocal(slots.Dst);

        // Array.Copy(src, dst, src.Length)
        this.il.LoadLocal(slots.Src);
        this.il.LoadLocal(slots.Dst);
        this.il.LoadLocal(slots.Src);
        this.il.OpCode(ILOpCode.Ldlen);
        this.il.OpCode(ILOpCode.Conv_i4);
        this.il.Call(this.outer.wellKnown.GetArrayCopyReference());

        // dst[src.Length] = element
        this.il.LoadLocal(slots.Dst);
        this.il.LoadLocal(slots.Src);
        this.il.OpCode(ILOpCode.Ldlen);
        this.il.OpCode(ILOpCode.Conv_i4);
        this.EmitExpression(app.Element);
        this.EmitStoreElement(element);

        // Leave dst on stack
        this.il.LoadLocal(slots.Dst);
    }

    private void EmitMapLiteral(BoundMapLiteralExpression literal)
    {
        // Phase 3.A.4 emit: `map[K]V{k1: v1, ...}` lowers to
        // `newobj Dictionary<K,V>::.ctor()` then a (dup; key; value; callvirt set_Item)
        // sequence per entry. Using set_Item rather than Add so duplicate keys
        // overwrite (matching Go semantics; ParseMapEntries does not dedup).
        var dictType = literal.MapType.ClrType;
        var ctor = dictType.GetConstructor(Type.EmptyTypes)
            ?? throw new InvalidOperationException(
                $"Dictionary type '{dictType.FullName}' has no parameterless constructor.");
        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(this.outer.GetCtorReference(ctor));

        if (literal.Entries.Length == 0)
        {
            return;
        }

        var setItem = dictType.GetMethod("set_Item")
            ?? throw new InvalidOperationException(
                $"Dictionary type '{dictType.FullName}' has no set_Item method.");
        var setItemRef = this.outer.GetMethodReference(setItem);

        foreach (var entry in literal.Entries)
        {
            this.il.OpCode(ILOpCode.Dup);
            this.EmitExpression(entry.Key);
            this.EmitExpression(entry.Value);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(setItemRef);
        }
    }

    private void EmitMapDelete(BoundMapDeleteExpression del)
    {
        // Phase 3.A.4 emit: `delete(m, k)` lowers to `callvirt Dictionary<K,V>::Remove(K)`
        // and pops the returned bool — `delete` is typed as void.
        var mapType = (MapTypeSymbol)del.Map.Type;
        var dictType = mapType.ClrType;
        var remove = dictType.GetMethod("Remove", new[] { mapType.KeyType.ClrType })
            ?? throw new InvalidOperationException(
                $"Dictionary type '{dictType.FullName}' has no Remove(K) method.");

        this.EmitExpression(del.Map);
        this.EmitExpression(del.Key);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(remove));
        this.il.OpCode(ILOpCode.Pop);
    }

    private void EmitStructLiteral(BoundStructLiteralExpression literal)
    {
        if (!this.outer.cache.StructTypeDefs.TryGetValue(literal.StructType, out var typeDef))
        {
            throw new InvalidOperationException(
                $"Struct '{literal.StructType.Name}' has no emitted TypeDef.");
        }

        // Class literal: newobj <ctor>; (dup; <value>; stfld) per init.
        if (literal.StructType.IsClass)
        {
            if (!this.outer.cache.ClassCtorHandles.TryGetValue(literal.StructType, out var ctorHandle))
            {
                throw new InvalidOperationException(
                    $"Class '{literal.StructType.Name}' has no emitted default ctor.");
            }

            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(ctorHandle);

            var classDef = literal.StructType.Definition ?? literal.StructType;
            foreach (var init in literal.Initializers)
            {
                if (!this.outer.cache.StructFieldDefs.TryGetValue(init.Field, out var fieldHandle))
                {
                    throw new InvalidOperationException(
                        $"Class field '{init.Field.Name}' has no emitted FieldDef.");
                }

                this.il.OpCode(ILOpCode.Dup);
                this.EmitExpression(init.Value);

                // Phase 4 emit parity (F2, type-erased): box when the
                // definition's field is open (T) and the assigned value
                // is a value type. Same boundary semantics as the
                // primary-ctor and call-site box passes.
                if (classDef != literal.StructType)
                {
                    FieldSymbol df = null;
                    foreach (var f in classDef.Fields)
                    {
                        if (f.Name == init.Field.Name)
                        {
                            df = f;
                            break;
                        }
                    }

                    if (df != null
                        && df.Type is TypeParameterSymbol
                        && init.Value.Type is not TypeParameterSymbol
                        && ReflectionMetadataEmitter.IsValueTypeSymbol(init.Value.Type))
                    {
                        this.il.OpCode(ILOpCode.Box);
                        this.il.Token(this.outer.GetElementTypeToken(init.Value.Type));
                    }
                }

                this.il.OpCode(ILOpCode.Stfld);
                this.il.Token(fieldHandle);
            }

            return;
        }

        if (!this.structLiteralSlots.TryGetValue(literal, out var slot))
        {
            throw new InvalidOperationException(
                $"No slot populated for {literal.Kind} of type '{literal.StructType.Name}' — "
                + "walker pre-pass missed this child? "
                + "Check StructLiteralCollector and its ancestor walker.");
        }

        // ldloca slot; initobj typedef — zero-initializes the value type.
        this.il.LoadLocalAddress(slot);
        this.il.OpCode(ILOpCode.Initobj);
        this.il.Token(typeDef);

        // For each initializer: ldloca slot; <emit value>; stfld fieldHandle.
        var structDef = literal.StructType.Definition ?? literal.StructType;
        foreach (var init in literal.Initializers)
        {
            if (!this.outer.cache.StructFieldDefs.TryGetValue(init.Field, out var fieldHandle))
            {
                throw new InvalidOperationException(
                    $"Struct field '{init.Field.Name}' has no emitted FieldDef.");
            }

            this.il.LoadLocalAddress(slot);
            this.EmitExpression(init.Value);

            if (structDef != literal.StructType)
            {
                FieldSymbol df = null;
                foreach (var f in structDef.Fields)
                {
                    if (f.Name == init.Field.Name)
                    {
                        df = f;
                        break;
                    }
                }

                if (df != null
                    && df.Type is TypeParameterSymbol
                    && init.Value.Type is not TypeParameterSymbol
                    && ReflectionMetadataEmitter.IsValueTypeSymbol(init.Value.Type))
                {
                    this.il.OpCode(ILOpCode.Box);
                    this.il.Token(this.outer.GetElementTypeToken(init.Value.Type));
                }
            }

            this.il.OpCode(ILOpCode.Stfld);
            this.il.Token(fieldHandle);
        }

        // Leave the constructed struct value on the stack.
        this.il.LoadLocal(slot);
    }

    private void EmitNullConditionalAccess(BoundNullConditionalAccessExpression nc)
    {
        // Phase 3.C.3b / ADR-0001: evaluate the receiver once into a
        // synthetic capture local. If the captured value is null, leave
        // null on the stack and skip the access; otherwise evaluate the
        // access sub-tree, which references the capture local in place
        // of the original receiver.
        this.EmitExpression(nc.Receiver);
        this.EmitStoreVariable(nc.Capture);
        this.EmitLoadVariable(nc.Capture);
        var end = this.il.DefineLabel();
        var nonNull = this.il.DefineLabel();
        this.il.Branch(ILOpCode.Brtrue, nonNull);

        if (nc.ResultSlot != null)
        {
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
            var slot = this.locals[nc.ResultSlot];
            var nullableType = (NullableTypeSymbol)nc.Type;
            var innerClr = nullableType.UnderlyingType.ClrType
                ?? throw new InvalidOperationException(
                    $"Null-conditional value-type result '{nullableType.UnderlyingType.Name}' has no CLR type.");

            // Issue #571: construct Nullable<T> through the ReferenceResolver so
            // the open generic definition lives in the same load context as the
            // (possibly MLC-backed) inner value type. See MethodBodyEmitter.Conversions.
            if (!NullableLifting.TryConstructNullable(this.outer.emitCtx.References, innerClr, out var nullableClr))
            {
                throw new InvalidOperationException(
                    $"Cannot construct Nullable<{innerClr.FullName}>: System.Nullable`1 is not resolvable in the reference set.");
            }

            var nullableInnerArg = nullableClr.GetGenericArguments()[0];

            // nil branch: ldloca slot; initobj Nullable<T>; ldloc slot
            this.il.LoadLocalAddress(slot);
            this.il.OpCode(ILOpCode.Initobj);
            this.il.Token(this.outer.GetTypeHandleForMember(nullableClr));
            this.il.LoadLocal(slot);
            this.il.Branch(ILOpCode.Br, end);

            // not-null branch: produce T (then wrap), or — when WhenNotNull
            // already produces Nullable<T> — emit it directly.
            this.il.MarkLabel(nonNull);
            this.EmitExpression(nc.WhenNotNull);
            if (nc.WhenNotNull.Type is not NullableTypeSymbol)
            {
                var ctor = nullableClr.GetConstructor(new[] { nullableInnerArg })
                    ?? throw new InvalidOperationException(
                        $"Nullable<{nullableInnerArg.FullName}> has no single-arg constructor.");
                this.il.OpCode(ILOpCode.Newobj);
                this.il.Token(this.outer.GetCtorReference(ctor));
            }

            this.il.MarkLabel(end);
            return;
        }

        // Reference-typed access result: nullable<ref> shares the CLR
        // representation of T, so ldnull is a valid Nullable<T> value.
        this.il.OpCode(ILOpCode.Ldnull);
        this.il.Branch(ILOpCode.Br, end);
        this.il.MarkLabel(nonNull);
        this.EmitExpression(nc.WhenNotNull);
        this.il.MarkLabel(end);
    }

    private void EmitTupleLiteral(BoundTupleLiteralExpression tuple)
    {
        // Phase 4.5 emit parity: `(e1, e2, ...)` lowers to
        // `newobj ValueTuple<T1, T2, ...>::.ctor(T1, T2, ...)`. The CLR
        // backing type is set by TupleTypeSymbol.BuildClrType for arities
        // 2–7; higher arities have a null ClrType when element types include
        // G#-defined types (StructSymbol) that don't yet have a runtime Type.
        var clrType = tuple.TupleType.ClrType;
        var arity = tuple.TupleType.Arity;

        if (clrType == null && arity >= 2 && arity <= 7)
        {
            // Issue #649: G#-defined types lack a ClrType, so we build the
            // tuple TypeSpec and ctor MemberRef symbolically.
            foreach (var elem in tuple.Elements)
            {
                this.EmitExpression(elem);
            }

            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetTupleCtorReference(tuple.TupleType));
            return;
        }

        if (clrType == null)
        {
            throw new NotSupportedException(
                $"Tuple of arity {arity} has no CLR backing type; emit not supported.");
        }

        foreach (var elem in tuple.Elements)
        {
            this.EmitExpression(elem);
        }

        this.il.OpCode(ILOpCode.Newobj);

        // Issue #649: When a tuple's type arguments include a type loaded via
        // MetadataLoadContext (e.g. a project-referenced CLR class), calling
        // .GetConstructors() on the closed generic throws NotSupportedException.
        // Resolve the ctor from the open generic type definition instead.
        if (clrType.IsConstructedGenericType)
        {
            this.il.Token(this.outer.GetCtorReferenceOnConstructedGeneric(clrType, tuple.Elements.Length));
        }
        else
        {
            ConstructorInfo ctor = null;
            foreach (var c in clrType.GetConstructors())
            {
                if (c.GetParameters().Length == tuple.Elements.Length)
                {
                    ctor = c;
                    break;
                }
            }

            if (ctor == null)
            {
                throw new InvalidOperationException(
                    $"ValueTuple type '{clrType.FullName}' has no constructor of arity {tuple.Elements.Length}.");
            }

            this.il.Token(this.outer.GetCtorReference(ctor));
        }
    }

    private void EmitTupleElementAccess(BoundTupleElementAccessExpression access)
    {
        // Phase 4.5 emit parity: `t.ItemN`. ValueTuple<...> exposes the
        // elements as public *fields* (Item1..Item7), not properties, so
        // the access is a plain `ldfld`. Both struct-on-stack and
        // managed-pointer receivers are valid operands for ldfld; the
        // common cases (locals/params/temps) go through
        // EmitInstanceReceiver to prefer the address form.
        var clrType = access.TupleType.ClrType;
        var arity = access.TupleType.Arity;
        var fieldName = "Item" + (access.Index + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);

        if (clrType == null && arity >= 2 && arity <= 7)
        {
            // Issue #649: G#-defined types lack a ClrType, so we build the
            // tuple TypeSpec and field MemberRef symbolically.
            this.EmitInstanceReceiver(access.Receiver);
            this.il.OpCode(ILOpCode.Ldfld);
            this.il.Token(this.outer.GetTupleFieldReference(access.TupleType, fieldName));
            return;
        }

        if (clrType == null)
        {
            throw new NotSupportedException(
                $"Tuple of arity {arity} has no CLR backing type; emit not supported.");
        }

        this.EmitInstanceReceiver(access.Receiver);
        this.il.OpCode(ILOpCode.Ldfld);

        // Issue #649: When a tuple's type arguments include a type loaded via
        // MetadataLoadContext (e.g. a project-referenced CLR class), calling
        // .GetField() on the closed generic throws NotSupportedException.
        // Resolve the field from the open generic type definition instead.
        if (clrType.IsConstructedGenericType)
        {
            this.il.Token(this.outer.GetFieldReferenceOnConstructedGeneric(clrType, fieldName));
        }
        else
        {
            var field = clrType.GetField(fieldName)
                ?? throw new InvalidOperationException(
                    $"ValueTuple type '{clrType.FullName}' has no public field '{fieldName}'.");
            this.il.Token(this.outer.GetFieldReference(field));
        }
    }

    /// <summary>ADR-0039: Emits address-of by dispatching on the operand shape.</summary>
    private void EmitAddressOf(BoundAddressOfExpression node)
    {
        switch (node.Operand)
        {
            case BoundVariableExpression bve:
                if (!this.TryLoadVariableAddress(bve.Variable))
                {
                    throw new InvalidOperationException($"Cannot take address of variable '{bve.Variable.Name}'.");
                }

                break;

            case BoundFieldAccessExpression fa:
                this.EmitFieldAddress(fa);
                break;

            case BoundIndexExpression idx:
                this.EmitExpression(idx.Target);
                this.EmitExpression(idx.Index);
                this.EmitLoadElementAddress(idx.Type);
                break;

            case BoundDereferenceExpression deref:
                // &(*p) = p — just emit the pointer value.
                this.EmitExpression(deref.Operand);
                break;

            default:
                throw new InvalidOperationException($"Cannot take address of expression kind '{node.Operand.GetType().Name}'.");
        }
    }

    /// <summary>
    /// ADR-0061: Emits a conditional address-of (`cond ? &amp;a : &amp;b`) as
    /// a CIL branch that selects one of two address-of forms onto the
    /// evaluation stack. The result is a managed pointer (<c>T&amp;</c>)
    /// with the same verifier type as either branch.
    /// </summary>
    /// <param name="node">The conditional address-of bound node.</param>
    private void EmitConditionalAddress(BoundConditionalAddressExpression node)
    {
        var falseLabel = this.il.DefineLabel();
        var doneLabel = this.il.DefineLabel();

        // <cond>
        this.EmitExpression(node.Condition);

        // brfalse falseLabel
        this.il.Branch(ILOpCode.Brfalse, falseLabel);

        // <addr of WhenTrue>
        this.EmitAddressOf(new BoundAddressOfExpression(null, node.WhenTrueOperand));

        // br doneLabel
        this.il.Branch(ILOpCode.Br, doneLabel);

        // falseLabel:
        this.il.MarkLabel(falseLabel);

        // <addr of WhenFalse>
        this.EmitAddressOf(new BoundAddressOfExpression(null, node.WhenFalseOperand));

        // doneLabel:
        this.il.MarkLabel(doneLabel);
    }

    /// <summary>
    /// ADR-0062: Emits a general two-arm conditional (ternary) as a CIL
    /// branch that selects one of two value-producing arms onto the
    /// evaluation stack. Both arms have already been converted to the
    /// node's result type by the binder.
    /// </summary>
    /// <param name="node">The conditional expression bound node.</param>
    private void EmitConditional(BoundConditionalExpression node)
    {
        var falseLabel = this.il.DefineLabel();
        var doneLabel = this.il.DefineLabel();

        this.EmitExpression(node.Condition);
        this.il.Branch(ILOpCode.Brfalse, falseLabel);
        this.EmitExpression(node.WhenTrue);
        this.il.Branch(ILOpCode.Br, doneLabel);
        this.il.MarkLabel(falseLabel);
        this.EmitExpression(node.WhenFalse);
        this.il.MarkLabel(doneLabel);
    }

    /// <summary>ADR-0039: Emits a dereference (load indirect) from a managed pointer.</summary>
    private void EmitDereference(BoundDereferenceExpression node)
    {
        this.EmitExpression(node.Operand);
        var pointeeType = ((ByRefTypeSymbol)node.Operand.Type).PointeeType;
        this.EmitLoadIndirect(pointeeType);
    }

    /// <summary>
    /// ADR-0069 / issue #700: when a variable read carries a narrowed type
    /// distinct from the variable's declared type, emit a single
    /// conversion opcode so the IL stack matches the narrower type:
    /// <list type="bullet">
    ///   <item><description><c>unbox.any T</c> when the narrowed type is a
    ///     value type — the load left a boxed reference on the stack and we
    ///     need the native value-type representation back.</description></item>
    ///   <item><description><c>castclass T</c> when the narrowed type is a
    ///     reference type — the load left a base-class or interface
    ///     reference on the stack and we need the derived reference.
    ///     The CLR-level cast is guaranteed to succeed because the binder
    ///     placed it inside a region where an <c>is</c> test already
    ///     verified the runtime type at the same site.</description></item>
    /// </list>
    /// <para>
    /// The cast is suppressed when the narrowing is a pure nullable strip
    /// (e.g. <c>string? → string</c>) — the underlying CLR representation
    /// is identical, and emitting <c>castclass</c> would still be sound
    /// but pointlessly grows the body.
    /// </para>
    /// </summary>
    private void EmitNarrowingCastIfNeeded(BoundVariableExpression v)
    {
        var narrowed = v.NarrowedType;
        if (narrowed == null)
        {
            return;
        }

        var declared = v.Variable.Type;
        if (declared == narrowed)
        {
            return;
        }

        // Pure nullable strip (`T? → T`) needs no IL change: the CLR
        // representation is identical for reference-type nullables, and
        // value-type nullables route through the existing
        // <c>EmitConversion</c> path before reaching here.
        if (declared is NullableTypeSymbol nts && nts.UnderlyingType == narrowed)
        {
            return;
        }

        // Skip when both sides are non-null CLR types that resolve to the
        // same runtime type (e.g. an imported alias).
        if (declared?.ClrType != null && narrowed.ClrType != null
            && declared.ClrType == narrowed.ClrType)
        {
            return;
        }

        if (ReflectionMetadataEmitter.IsValueTypeSymbol(narrowed)
            || (narrowed.ClrType != null && narrowed.ClrType.IsValueType))
        {
            this.il.OpCode(ILOpCode.Unbox_any);
            this.il.Token(this.outer.GetElementTypeToken(narrowed));
            return;
        }

        this.il.OpCode(ILOpCode.Castclass);
        this.il.Token(this.outer.GetElementTypeToken(narrowed));
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Issue #575: expression-level `is` / `as` operators.
    // ──────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Emits <c>expr is T</c> → <c>bool</c>:
    /// <code>
    ///   [expr]
    ///   box (if value type)
    ///   isinst T
    ///   ldnull
    ///   cgt.un
    /// </code>
    /// </summary>
    private void EmitIsExpression(BoundIsExpression node)
    {
        this.EmitExpression(node.Expression);

        // Box value-type operands so that `isinst` can operate on them.
        if (ReflectionMetadataEmitter.IsValueTypeSymbol(node.Expression.Type))
        {
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.GetElementTypeToken(node.Expression.Type));
        }

        // Determine the isinst target. For nullable targets, test against the underlying type.
        var isinstTarget = node.TargetType is NullableTypeSymbol nts ? nts.UnderlyingType : node.TargetType;

        this.il.OpCode(ILOpCode.Isinst);
        this.il.Token(this.outer.GetElementTypeToken(isinstTarget));

        // Convert the object-or-null result to bool.
        this.il.OpCode(ILOpCode.Ldnull);
        this.il.OpCode(ILOpCode.Cgt_un);
    }

    /// <summary>
    /// Emits <c>expr as T</c> → <c>T</c> (reference type) or <c>T?</c> (nullable value type):
    /// <code>
    ///   [expr]
    ///   box (if value type source)
    ///   isinst T
    ///   unbox.any T (if T is value type — produces Nullable&lt;T&gt;)
    /// </code>
    /// For reference-type targets, <c>isinst</c> alone suffices (yields the
    /// cast reference or null).
    /// </summary>
    private void EmitAsExpression(BoundAsExpression node)
    {
        this.EmitExpression(node.Expression);

        // Box value-type operands.
        if (ReflectionMetadataEmitter.IsValueTypeSymbol(node.Expression.Type))
        {
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.GetElementTypeToken(node.Expression.Type));
        }

        // Determine the isinst target type. For `as T?` where T is a value type,
        // `isinst` targets T (not Nullable<T>), and then we unbox.any to Nullable<T>.
        var isNullableValueTarget = node.TargetType is NullableTypeSymbol nts2
            && nts2.UnderlyingType?.ClrType is { IsValueType: true };

        var isinstTarget = isNullableValueTarget
            ? ((NullableTypeSymbol)node.TargetType).UnderlyingType
            : node.TargetType;

        this.il.OpCode(ILOpCode.Isinst);
        this.il.Token(this.outer.GetElementTypeToken(isinstTarget));

        if (isNullableValueTarget)
        {
            // Unbox to Nullable<T> — converts the boxed T (or null) to a Nullable<T> value.
            this.il.OpCode(ILOpCode.Unbox_any);
            this.il.Token(this.outer.GetElementTypeToken(node.TargetType));
        }
    }
}
