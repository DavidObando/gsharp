// <copyright file="MethodBodyEmitter.MemberAccess.cs" company="GSharp">
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
/// field/property/index access and assignment plus variable load/store.
/// See <c>MethodBodyEmitter.cs</c> for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
/// </summary>
internal sealed partial class MethodBodyEmitter
{

    private void EmitLoadVariable(VariableSymbol variable)
    {
        // Issue #216: const bindings have no IL slot — inline the literal value.
        if (this.constValues != null && this.constValues.TryGetValue(variable, out var cv))
        {
            this.EmitLiteral(new BoundLiteralExpression(null, cv, variable.Type));
            return;
        }

        if (variable is ParameterSymbol ps && this.parameters.TryGetValue(ps, out var argIndex))
        {
            this.il.LoadArgument(argIndex);
            if (ps.RefKind != RefKind.None)
            {
                // ADR-0060: the parameter slot holds a managed pointer T&; an
                // ordinary read of `p` in the body must dereference it.
                this.EmitLoadIndirect(ps.Type);
            }

            return;
        }

        if (this.locals.TryGetValue(variable, out var slot))
        {
            this.il.LoadLocal(slot);

            // Issue #491 (ADR-0060 follow-up): a ref-aliasing local's slot
            // stores a managed pointer T&; a read of the local in the body
            // must indirect through the pointer to load the pointee value.
            if (variable is LocalVariableSymbol refLocal && refLocal.RefKind != RefKind.None)
            {
                this.EmitLoadIndirect(refLocal.Type);
            }

            return;
        }

        // Issue #191: top-level globals were emitted as static fields on
        // <Program>; load via ldsfld so cross-method access (and reads
        // from other assemblies) share storage.
        if (variable is GlobalVariableSymbol gv
            && this.outer.cache.GlobalFieldDefs.TryGetValue(gv, out var fieldHandle))
        {
            this.il.OpCode(ILOpCode.Ldsfld);
            this.il.Token(fieldHandle);
            return;
        }

        // Issue #503 follow-up (nested-closure transitive capture): the
        // current method is a closure's Invoke and `variable` is one of
        // the enclosing closure's captured outer locals. Load it via
        // `ldarg.0; ldfld <displayClass>::<capField>`.
        if (this.TryLoadFromEnclosingClosure(variable))
        {
            return;
        }

        throw new InvalidOperationException(
            $"Variable '{variable.Name}' has no local slot or parameter index in the current method.");
    }

    private bool TryLoadFromEnclosingClosure(VariableSymbol variable)
    {
        if (this.enclosingClosure == null
            || !this.enclosingClosure.CaptureFields.TryGetValue(variable, out var capField)
            || !this.outer.cache.StructFieldDefs.TryGetValue(capField, out var capFieldHandle))
        {
            return false;
        }

        this.il.OpCode(ILOpCode.Ldarg_0);
        this.il.OpCode(ILOpCode.Ldfld);
        this.il.Token(capFieldHandle);
        return true;
    }

    private bool TryStoreToEnclosingClosure(VariableSymbol variable)
    {
        // The store value is already on the stack; we need to push the
        // closure receiver UNDER it. Use a temp local of the value type
        // to swap stack order without spawning a scratch local field.
        if (this.enclosingClosure == null
            || !this.enclosingClosure.CaptureFields.TryGetValue(variable, out var capField)
            || !this.outer.cache.StructFieldDefs.TryGetValue(capField, out var capFieldHandle))
        {
            return false;
        }

        // Stack on entry: [..., value]
        // Need:            [..., this, value] before stfld.
        // Use a synthesized temp slot: stloc temp; ldarg.0; ldloc temp; stfld.
        // The locals dictionary doesn't support adding synthetic slots
        // after pre-scan, but for the closure-capture case the value is
        // typed identically to the captured variable, so use the
        // dedicated receiverSpillSlots mechanism — fallback: use IL
        // dup/swap via a transient ValueType pattern. Cleanest:
        //   stloc <temp>  // not feasible without pre-allocation
        // Instead emit: dup; ldarg.0; swap-by-stloc/ldloc pair.
        //
        // We don't have a guaranteed scratch slot, so use the simpler
        // pattern: emit a delegate-style store via box-then-cast — no.
        //
        // The pragmatic fix: synthesize a scratch local on first use by
        // appending it to the IL locals signature. The metadata locals
        // signature is sealed before EmitBlock starts, so this path is
        // not viable for stores. As a result, captured-by-enclosing-
        // closure stores are restricted to the rewritten field path
        // (handled in CaptureRewriter for the inner literal body) and
        // never reach EmitStoreVariable from inside the inner Invoke.
        //
        // For the rare case where an outer-closure body assigns to a
        // captured variable that's NOT one of its own locals, we fall
        // through and let EmitStoreVariable's error surface — that
        // shape is currently unreachable from the binder.
        _ = capFieldHandle;
        return false;
    }

    private bool HasStorageSlot(VariableSymbol variable)
    {
        if (variable is ParameterSymbol ps && this.parameters.ContainsKey(ps))
        {
            return true;
        }

        if (this.locals.ContainsKey(variable))
        {
            return true;
        }

        if (variable is GlobalVariableSymbol gv
            && this.outer.cache.GlobalFieldDefs.ContainsKey(gv))
        {
            return true;
        }

        // Issue #503 follow-up: an enclosing closure's display-class
        // field counts as storage for the captured variable when this
        // method is the closure's Invoke.
        if (this.enclosingClosure != null
            && this.enclosingClosure.CaptureFields.ContainsKey(variable))
        {
            return true;
        }

        return false;
    }

    private void EmitStoreVariable(VariableSymbol variable)
    {
        if (variable is ParameterSymbol ps && this.parameters.TryGetValue(ps, out var argIndex))
        {
            this.il.StoreArgument(argIndex);
            return;
        }

        if (this.locals.TryGetValue(variable, out var slot))
        {
            this.il.StoreLocal(slot);
            return;
        }

        // Issue #191: top-level globals store via stsfld into their backing
        // <Program> static field (initialized in declaration order from
        // the entry-point method body).
        if (variable is GlobalVariableSymbol gv
            && this.outer.cache.GlobalFieldDefs.TryGetValue(gv, out var fieldHandle))
        {
            this.il.OpCode(ILOpCode.Stsfld);
            this.il.Token(fieldHandle);
            return;
        }

        throw new InvalidOperationException(
            $"Variable '{variable.Name}' has no local slot or parameter index in the current method.");
    }

    private void EmitLoadElement(TypeSymbol elementType)
    {
        // Issue #520: prefer the typed short-form ldelem opcodes for
        // every CIL primitive. `ldelem <token>` for small ints leaves a
        // sub-int32 value on the eval stack and ilverify rejects it
        // ([StackUnexpected]: found Short/Byte). The short forms widen
        // to int32 as ECMA-335 requires for arithmetic continuation.
        if (elementType == TypeSymbol.Int32)
        {
            this.il.OpCode(ILOpCode.Ldelem_i4);
        }
        else if (elementType == TypeSymbol.UInt32)
        {
            this.il.OpCode(ILOpCode.Ldelem_u4);
        }
        else if (elementType == TypeSymbol.Int64 || elementType == TypeSymbol.UInt64)
        {
            this.il.OpCode(ILOpCode.Ldelem_i8);
        }
        else if (elementType == TypeSymbol.Int16)
        {
            this.il.OpCode(ILOpCode.Ldelem_i2);
        }
        else if (elementType == TypeSymbol.UInt16 || elementType == TypeSymbol.Char)
        {
            this.il.OpCode(ILOpCode.Ldelem_u2);
        }
        else if (elementType == TypeSymbol.Int8)
        {
            this.il.OpCode(ILOpCode.Ldelem_i1);
        }
        else if (elementType == TypeSymbol.UInt8 || elementType == TypeSymbol.Bool)
        {
            this.il.OpCode(ILOpCode.Ldelem_u1);
        }
        else if (elementType == TypeSymbol.Float32)
        {
            this.il.OpCode(ILOpCode.Ldelem_r4);
        }
        else if (elementType == TypeSymbol.Float64)
        {
            this.il.OpCode(ILOpCode.Ldelem_r8);
        }
        else if (elementType == TypeSymbol.NInt || elementType == TypeSymbol.NUInt)
        {
            this.il.OpCode(ILOpCode.Ldelem_i);
        }
        else if (elementType == TypeSymbol.String || IsReferenceTypeElement(elementType))
        {
            // Reference-type element (string or any other class/interface):
            // ldelem.ref is the only correct form.
            this.il.OpCode(ILOpCode.Ldelem_ref);
        }
        else
        {
            // Arbitrary value type — enums (whose underlying type the JIT
            // honors), structs, etc. `ldelem <token>` works for these
            // because the verifier matches the static element type.
            this.il.OpCode(ILOpCode.Ldelem);
            this.il.Token(this.outer.GetElementTypeToken(elementType));
        }
    }

    private void EmitStoreElement(TypeSymbol elementType)
    {
        // Issue #520: mirror EmitLoadElement — use the typed short-form
        // stelem opcodes for every CIL primitive so the stack truncation
        // rules match what the verifier expects.
        if (elementType == TypeSymbol.Int32 || elementType == TypeSymbol.UInt32)
        {
            this.il.OpCode(ILOpCode.Stelem_i4);
        }
        else if (elementType == TypeSymbol.Int64 || elementType == TypeSymbol.UInt64)
        {
            this.il.OpCode(ILOpCode.Stelem_i8);
        }
        else if (elementType == TypeSymbol.Int16 ||
                 elementType == TypeSymbol.UInt16 ||
                 elementType == TypeSymbol.Char)
        {
            this.il.OpCode(ILOpCode.Stelem_i2);
        }
        else if (elementType == TypeSymbol.Int8 ||
                 elementType == TypeSymbol.UInt8 ||
                 elementType == TypeSymbol.Bool)
        {
            this.il.OpCode(ILOpCode.Stelem_i1);
        }
        else if (elementType == TypeSymbol.Float32)
        {
            this.il.OpCode(ILOpCode.Stelem_r4);
        }
        else if (elementType == TypeSymbol.Float64)
        {
            this.il.OpCode(ILOpCode.Stelem_r8);
        }
        else if (elementType == TypeSymbol.NInt || elementType == TypeSymbol.NUInt)
        {
            this.il.OpCode(ILOpCode.Stelem_i);
        }
        else if (elementType == TypeSymbol.String || IsReferenceTypeElement(elementType))
        {
            this.il.OpCode(ILOpCode.Stelem_ref);
        }
        else
        {
            this.il.OpCode(ILOpCode.Stelem);
            this.il.Token(this.outer.GetElementTypeToken(elementType));
        }
    }

    private void EmitMapIndexRead(BoundIndexExpression idx)
    {
        // Phase 3.A.4 emit: `m[k]` lowers to `Dictionary<K,V>::TryGetValue(K, out V)`
        // — we then pop the returned bool and load the out value. TryGetValue
        // zero-initialises the out parameter when the key is missing, matching
        // the interpreter's Go zero-value semantics rather than throwing as
        // `get_Item` would.
        var mapType = (MapTypeSymbol)idx.Target.Type;
        var dictType = mapType.ClrType;
        var tryGet = dictType.GetMethod(
            "TryGetValue",
            new[] { mapType.KeyType.ClrType, mapType.ValueType.ClrType.MakeByRefType() })
            ?? throw new InvalidOperationException(
                $"Dictionary type '{dictType.FullName}' has no TryGetValue(K, out V) method.");

        var slot = this.mapIndexSlots[idx];
        this.EmitExpression(idx.Target);
        this.EmitExpression(idx.Index);
        this.il.LoadLocalAddress(slot);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(tryGet));
        this.il.OpCode(ILOpCode.Pop);
        this.il.LoadLocal(slot);
    }

    private void EmitMapIndexAssignment(BoundIndexAssignmentExpression ixa)
    {
        // Phase 3.A.4 emit: `m[k] = v` lowers to `Dictionary<K,V>::set_Item(K, V)`.
        // Issue #418 (P1-1): spill v to a temp before the callvirt so the
        // expression's result (the assigned value) does not require a
        // re-evaluation of k or a get_Item re-read. set_Item is void, so we
        // dup the value just before the call, save the dup to a scratch
        // local, then push it back as the expression result.
        var targetType = ixa.TargetExpression?.Type ?? ixa.Target.Type;
        var mapType = (MapTypeSymbol)targetType;
        var dictType = mapType.ClrType;
        var setItem = dictType.GetMethod("set_Item")
            ?? throw new InvalidOperationException(
                $"Dictionary type '{dictType.FullName}' has no set_Item method.");

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
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(setItem));
        this.il.LoadLocal(tmp);
    }

    private void EmitFieldAccess(BoundFieldAccessExpression fa)
    {
        // Issue #948: a const field has no runtime storage — its read is
        // inlined as the compile-time constant value (matching C# semantics
        // and the literal field's lack of an ldsfld-able location).
        if (fa.Field.IsConst)
        {
            this.EmitLiteral(new BoundLiteralExpression(null, fa.Field.ConstantValue, fa.Field.Type));
            return;
        }

        // ADR-0087 §3 R3+R4: when the receiver is a constructed
        // generic user type, the ldfld must reference the field via
        // a MemberRef parented at the TypeSpec. With the field
        // signature now encoding VAR(idx), the value read off `stfld`
        // is already the correct concrete type, so the unbox.any /
        // castclass bridge that R0/R1 erasure required is dropped.
        var containing = fa.StructType;
        bool isGeneric = ReflectionMetadataEmitter.IsUserGenericTypeReference(containing);

        EntityHandle fieldHandle;
        if (fa.InterfaceType != null)
        {
            // ADR-0089 / issue #1030: interface static field read. A generic
            // interface routes through a TypeSpec-parented MemberRef (per
            // construction); a non-generic interface uses the bare FieldDef.
            fieldHandle = this.outer.ResolveInterfaceFieldToken(fa.InterfaceType, fa.Field);
        }
        else if (isGeneric)
        {
            fieldHandle = this.outer.ResolveFieldToken(containing, fa.Field);
        }
        else if (this.outer.cache.StructFieldDefs.TryGetValue(fa.Field, out var defHandle))
        {
            fieldHandle = defHandle;
        }
        else
        {
            throw new InvalidOperationException(
                $"Struct field '{fa.Field.Name}' has no emitted FieldDef.");
        }

        // ADR-0053: static field access — no receiver, use ldsfld.
        if (fa.Receiver == null)
        {
            this.il.OpCode(ILOpCode.Ldsfld);
            this.il.Token(fieldHandle);
            this.EmitNarrowingCastIfNeeded(fa.Field.Type, fa.NarrowedType);
            return;
        }

        // Class receivers are references: load the value (the ref) and ldfld.
        // For struct receivers, load by address when the receiver is a
        // simple variable (avoids a copy and is verifier-friendly); fall
        // back to value form otherwise (CLI permits ldfld on a value-type
        // value on stack).
        var receiverIsClass = fa.Receiver.Type is StructSymbol rs && rs.IsClass;
        if (!receiverIsClass
            && fa.Receiver is BoundDereferenceExpression deref
            && Symbols.TypeSymbol.IsUnmanagedPointer(deref.Operand.Type))
        {
            // ADR-0122 §4 / issue #1034: `(*p).field` / `p->field` read. The
            // pointer value IS the struct's address, so load the pointer and
            // `ldfld` directly — avoiding a wasteful `ldobj` of the whole struct.
            this.EmitExpression(deref.Operand);
        }
        else if (!receiverIsClass && fa.Receiver is BoundVariableExpression bv && this.TryLoadVariableAddress(bv.Variable))
        {
            // address is on the stack
        }
        else
        {
            this.EmitExpression(fa.Receiver);
        }

        this.il.OpCode(ILOpCode.Ldfld);
        this.il.Token(fieldHandle);
        this.EmitNarrowingCastIfNeeded(fa.Field.Type, fa.NarrowedType);
    }

    private void EmitFieldAssignment(BoundFieldAssignmentExpression fas)
    {
        // Issue #420 / #455 (P3-4): top-of-method precondition. The
        // non-static paths below evaluate `fas.Value` between two reads of
        // `fas.Receiver`. That is only safe when the value expression does
        // not reassign the receiver variable. The binder does not produce
        // such shapes today (see ValueExpressionMutatesReceiver helper).
        // Repeat the check at the top of the method so the invariant is
        // visible without scrolling past the static-field fast path; the
        // per-receiver assertion further down remains for the targeted
        // diagnostic message.
        Debug.Assert(
            fas.Receiver == null || !ValueExpressionMutatesReceiver(fas.Value, fas.Receiver),
            $"EmitFieldAssignment precondition violated: BoundFieldAssignmentExpression value must not reassign the receiver variable for field '{fas.Field.Name}' — see issue #420 / P3-4.");

        // ADR-0087 §3 R3: route via TypeSpec MemberRef when generic.
        var containing = fas.StructType;
        bool isGeneric = ReflectionMetadataEmitter.IsUserGenericTypeReference(containing);

        EntityHandle fieldHandle;
        if (fas.InterfaceType != null)
        {
            // ADR-0089 / issue #1030: interface static field write — generic
            // interface via TypeSpec MemberRef, non-generic via bare FieldDef.
            fieldHandle = this.outer.ResolveInterfaceFieldToken(fas.InterfaceType, fas.Field);
        }
        else if (isGeneric)
        {
            fieldHandle = this.outer.ResolveFieldToken(containing, fas.Field);
        }
        else if (this.outer.cache.StructFieldDefs.TryGetValue(fas.Field, out var defHandle))
        {
            fieldHandle = defHandle;
        }
        else
        {
            throw new InvalidOperationException(
                $"Struct field '{fas.Field.Name}' has no emitted FieldDef.");
        }

        // ADR-0053: static field assignment — no receiver, use stsfld/ldsfld.
        if (fas.Receiver == null && fas.ReceiverExpression == null)
        {
            this.EmitExpression(fas.Value);
            this.il.OpCode(ILOpCode.Stsfld);
            this.il.Token(fieldHandle);

            // Leave the assigned value on the stack as the expression result.
            this.il.OpCode(ILOpCode.Ldsfld);
            this.il.Token(fieldHandle);
            return;
        }

        // Issue #567: expression-based receiver (closure boxing lowered
        // `variable.Field = value` to `boxLocal.Value.Field = value`).
        // The receiver is an arbitrary BoundExpression that produces the
        // instance reference on the stack.
        if (fas.ReceiverExpression != null)
        {
            // ADR-0122 §4 / issue #1034: `(*p).field = v` / `p->field = v`. When
            // the receiver is a dereference of an unmanaged pointer to a value
            // struct, the pointer value IS the struct's address, so store the
            // field through that address (`<p>; <v>; stfld`). Emitting the
            // dereference itself (`ldobj`) would push a transient struct *copy*,
            // and `stfld` against a value on the stack would be invalid / lose
            // the write. The field is re-read through the address afterwards to
            // leave the assigned value as the expression result.
            var addressReceiver = fas.ReceiverExpression is BoundDereferenceExpression drefRecv
                && !fas.StructType.IsClass
                && Symbols.TypeSymbol.IsUnmanagedPointer(drefRecv.Operand.Type)
                ? drefRecv.Operand
                : null;

            this.EmitExpression(addressReceiver ?? fas.ReceiverExpression);
            this.EmitExpression(fas.Value);
            this.il.OpCode(ILOpCode.Stfld);
            this.il.Token(fieldHandle);

            // Leave the assigned value on the stack as the expression result.
            this.EmitExpression(addressReceiver ?? fas.ReceiverExpression);
            this.il.OpCode(ILOpCode.Ldfld);
            this.il.Token(fieldHandle);
            return;
        }

        // Issue #420 (P3-4): the non-static paths below emit the receiver
        // twice — once for the `stfld`, and once again after the store to
        // reload the field for the expression result. This is only safe
        // when evaluating `fas.Value` cannot mutate `fas.Receiver`. For
        // class receivers a re-assignment of the receiver variable in the
        // value expression would make the post-store reload observe the
        // mutated reference and read the field off the wrong object; for
        // struct receivers the address would still be stable, but a
        // self-write inside `fas.Value` would race with `stfld`. Today the
        // binder (Binder.BindFieldAssignmentExpression) does not produce
        // such shapes: nested `BoundAssignmentExpression` writing back to
        // the same receiver variable is not a pattern the front end emits
        // for field-assignment values. The assertion below makes that
        // invariant explicit so any future binder change that introduces
        // self-mutating value expressions trips loudly in Debug instead of
        // silently miscompiling.
        Debug.Assert(
            !ValueExpressionMutatesReceiver(fas.Value, fas.Receiver),
            $"EmitFieldAssignment: value expression for field '{fas.Field.Name}' must not reassign the receiver variable '{fas.Receiver.Name}'.");

        // Class field assignment: load the reference, evaluate the value,
        // stfld through the reference. Re-load the receiver + ldfld to
        // leave the new value on the stack as the expression result.
        if (fas.StructType.IsClass)
        {
            this.EmitLoadVariable(fas.Receiver);
            this.EmitExpression(fas.Value);
            this.il.OpCode(ILOpCode.Stfld);
            this.il.Token(fieldHandle);

            this.EmitLoadVariable(fas.Receiver);
            this.il.OpCode(ILOpCode.Ldfld);
            this.il.Token(fieldHandle);
            return;
        }

        // Optimized path: storing default(T) into a value-type field uses
        // ldflda + initobj instead of pushing a value + stfld. This avoids
        // the invalid ldnull;stfld<ValueType> pattern and removes the need
        // for a temp local.
        if (fas.Value is BoundDefaultExpression defaultExpr && ReflectionMetadataEmitter.IsValueTypeSymbol(defaultExpr.Type))
        {
            // Emit: receiver-address; ldflda field; initobj T
            if (!this.TryLoadVariableAddress(fas.Receiver))
            {
                throw new InvalidOperationException(
                    $"Cannot take the address of variable '{fas.Receiver.Name}' for field assignment.");
            }

            this.il.OpCode(ILOpCode.Ldflda);
            this.il.Token(fieldHandle);
            this.il.OpCode(ILOpCode.Initobj);
            this.il.Token(this.outer.GetElementTypeToken(defaultExpr.Type));

            // Leave the assigned value on the stack as the expression result.
            if (!this.TryLoadVariableAddress(fas.Receiver))
            {
                throw new InvalidOperationException(
                    $"Cannot take the address of variable '{fas.Receiver.Name}' for field assignment.");
            }

            this.il.OpCode(ILOpCode.Ldfld);
            this.il.Token(fieldHandle);
            return;
        }

        // Binder guarantees the receiver is a simple variable for Phase 3.B.1.
        if (!this.TryLoadVariableAddress(fas.Receiver))
        {
            throw new InvalidOperationException(
                $"Cannot take the address of variable '{fas.Receiver.Name}' for field assignment.");
        }

        this.EmitExpression(fas.Value);
        this.il.OpCode(ILOpCode.Stfld);
        this.il.Token(fieldHandle);

        // Leave the assigned value on the stack as the expression result.
        if (!this.TryLoadVariableAddress(fas.Receiver))
        {
            throw new InvalidOperationException(
                $"Cannot take the address of variable '{fas.Receiver.Name}' for field assignment.");
        }

        this.il.OpCode(ILOpCode.Ldfld);
        this.il.Token(fieldHandle);
    }

    // ADR-0051 Phase 6: emit IL for BoundPropertyAccessExpression (computed properties).
    // Auto-properties are lowered to BoundFieldAccessExpression by the Lowerer,
    // so this only fires for computed properties that still reference the accessor.
    private void EmitPropertyAccess(BoundPropertyAccessExpression access)
    {
        // Issue #989: when the receiver is a constructed generic user type the
        // accessor must be reached through a MemberRef parented at the
        // constructed TypeSpec so a property whose type mentions the class type
        // parameter is read with the substitution applied. The non-generic case
        // keeps using the plain accessor MethodDef.
        EntityHandle getterHandle;
        if (ReflectionMetadataEmitter.IsUserGenericTypeReference(access.StructType))
        {
            getterHandle = this.outer.ResolveUserPropertyAccessorToken(access.StructType, access.Property, wantSetter: false);
        }
        else if (this.outer.cache.PropertyAccessorHandles.TryGetValue(access.Property, out var handles) && handles.Getter.HasValue)
        {
            getterHandle = handles.Getter.Value;
        }
        else
        {
            throw new InvalidOperationException(
                $"Property '{access.Property.Name}' has no emitted getter MethodDef.");
        }

        // Issue #263: static property access — no receiver to load.
        if (access.Receiver == null)
        {
            this.il.OpCode(ILOpCode.Call);
            this.il.Token(getterHandle);
            this.EmitNarrowingCastIfNeeded(access.Property.Type, access.NarrowedType);
            return;
        }

        // Load receiver. Issue #418 (P1-5): route through
        // EmitInstanceReceiver so non-variable struct receivers
        // (method-call results, indexer reads, tuple elements, etc.) are
        // spilled to a temp and addressed via `ldloca` rather than left as
        // a value on the stack (unverifiable / SIGSEGV).
        var receiverIsClass = access.Receiver.Type is StructSymbol rs && rs.IsClass;

        // Issue #1068: an interface-typed receiver dispatches the property
        // accessor virtually (`callvirt get_X`) against the abstract interface
        // accessor MethodDef.
        var receiverIsInterface = access.Receiver.Type is InterfaceSymbol;
        this.EmitInstanceReceiver(access.Receiver);

        this.il.OpCode(receiverIsClass || receiverIsInterface ? ILOpCode.Callvirt : ILOpCode.Call);
        this.il.Token(getterHandle);
        this.EmitNarrowingCastIfNeeded(access.Property.Type, access.NarrowedType);
    }

    // ADR-0051 Phase 6: emit IL for BoundPropertyAssignmentExpression (computed properties).
    private void EmitPropertyAssignment(BoundPropertyAssignmentExpression assn)
    {
        // Issue #989: route generic constructed receivers through the
        // TypeSpec-parented MemberRef (mirrors EmitPropertyAccess).
        EntityHandle setterHandle;
        if (ReflectionMetadataEmitter.IsUserGenericTypeReference(assn.StructType))
        {
            setterHandle = this.outer.ResolveUserPropertyAccessorToken(assn.StructType, assn.Property, wantSetter: true);
        }
        else if (this.outer.cache.PropertyAccessorHandles.TryGetValue(assn.Property, out var handles) && handles.Setter.HasValue)
        {
            setterHandle = handles.Setter.Value;
        }
        else
        {
            throw new InvalidOperationException(
                $"Property '{assn.Property.Name}' has no emitted setter MethodDef.");
        }

        // Issue #418 (P1-2): spill the assigned value to a temp so the
        // expression result (`dup; stloc tmp; ... ; ldloc tmp`) does not
        // require a second getter call — which would also re-evaluate any
        // side-effecting receiver. Static and instance paths share the
        // same dup/stloc/ldloc pattern.
        if (!this.receiverSpillSlots.TryGetValue(assn, out var valueSlot))
        {
            throw new InvalidOperationException(
                $"No slot populated for {assn.Kind} on property '{assn.Property.Name}' — "
                + "walker pre-pass missed this child? "
                + "Check AssignmentValueSpillCollector and its ancestor walker.");
        }

        // Issue #263: static property assignment — no receiver.
        if (assn.Receiver == null)
        {
            this.EmitExpression(assn.Value);
            this.il.OpCode(ILOpCode.Dup);
            this.il.StoreLocal(valueSlot);
            this.il.OpCode(ILOpCode.Call);
            this.il.Token(setterHandle);
            this.il.LoadLocal(valueSlot);
            return;
        }

        // Load receiver, emit value, call setter. Issue #418 (P1-5):
        // route through EmitInstanceReceiver so non-variable struct
        // receivers spill to a temp and pass `ldloca` as `this` instead
        // of leaving a value on the stack.
        var receiverIsClass = assn.Receiver.Type is StructSymbol rs && rs.IsClass;

        // Issue #1068: an interface-typed receiver dispatches the property
        // setter virtually (`callvirt set_X`) against the abstract interface
        // accessor MethodDef.
        var receiverIsInterface = assn.Receiver.Type is InterfaceSymbol;
        this.EmitInstanceReceiver(assn.Receiver);

        this.EmitExpression(assn.Value);
        this.il.OpCode(ILOpCode.Dup);
        this.il.StoreLocal(valueSlot);
        this.il.OpCode(receiverIsClass || receiverIsInterface ? ILOpCode.Callvirt : ILOpCode.Call);
        this.il.Token(setterHandle);

        // Expression result: the value we just stored — no second receiver
        // evaluation, no getter call.
        this.il.LoadLocal(valueSlot);
    }

    private void EmitClrPropertyAccess(BoundClrPropertyAccessExpression access)
    {
        // Phase 4 / Stream B: property or field read on a CLR receiver.
        // Properties dispatch to their `get_X` accessor (callvirt for
        // reference types, call for value types); fields use `ldfld`.
        // When `Receiver` is null the access is static: emit `ldsfld` /
        // `call get_X` with no receiver instead.
        var isStatic = access.Receiver == null;
        if (!isStatic)
        {
            this.EmitInstanceReceiver(access.Receiver);
        }

        // Issue #454: use IsValueTypeSymbol — same predicate that
        // EmitInstanceReceiver uses — so user-declared structs (ClrType
        // null until emission completes) are recognised as value-type
        // receivers and dispatched via `call` instead of `callvirt`.
        // EmitInstanceReceiver already loaded `ldloca` for them; emitting
        // `callvirt` against a value-type method with a managed-pointer
        // receiver produces invalid IL.
        var receiverIsValueType = !isStatic && ReflectionMetadataEmitter.IsValueTypeSymbol(access.Receiver.Type);
        switch (access.Member)
        {
            case PropertyInfo property:
                var getter = property.GetGetMethod(nonPublic: false)
                    ?? throw new InvalidOperationException(
                        $"Property '{property.DeclaringType?.FullName}.{property.Name}' has no public getter.");
                // Issue #671: when the receiver is a symbolic constructed
                // generic (e.g. List[MyGs] with a user-defined type arg),
                // route the getter through the receiver-aware overload so
                // the MemberRef parent is the constructed type with the
                // real user-type tokens instead of the type-erased
                // List<object>. Static getters and CLR receivers fall back
                // to the plain MemberRef path inside the overload.
                var getterRef = isStatic
                    ? (EntityHandle)this.outer.GetMethodReference(getter)
                    : this.outer.GetMethodEntityHandle(getter, access.Receiver.Type);
                this.il.OpCode(isStatic || receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
                this.il.Token(getterRef);

                // Issue #774: when the receiver is a symbolic open container,
                // the symbolic MemberRef encodes the call against the open
                // generic property — the runtime stack value is therefore the
                // substituted symbolic type, not the closed CLR `object` that
                // `getter.ReturnType` reports. Skip widening so we don't emit
                // a verifier-breaking `unbox.any T` against a value type T
                // (the stack already holds the substituted `!!0`).
                if (!isStatic
                    && this.outer.TryGetSymbolicSubstitutedPropertyReturn(access.Receiver.Type, property, out _))
                {
                    break;
                }

                this.EmitErasedObjectReturnWidening(
                    TypeSymbol.FromClrType(getter.ReturnType),
                    access.Type);
                break;
            case FieldInfo field:
                var fieldRef = this.outer.GetFieldReference(field);
                this.il.OpCode(isStatic ? ILOpCode.Ldsfld : ILOpCode.Ldfld);
                this.il.Token(fieldRef);
                break;
            default:
                throw new NotSupportedException(
                    $"CLR member '{access.Member.GetType().Name}' is not yet supported by the emitter.");
        }
    }

    private void EmitClrPropertyAssignment(BoundClrPropertyAssignmentExpression assn)
    {
        // Stream B emit parity: property/field write on a CLR receiver.
        // Issue #418 (P1-2): the expression result is the assigned value.
        // Spill the value to a pre-allocated temp via `dup; stloc` so we
        // can produce the result with `ldloc` instead of re-evaluating the
        // receiver and calling the getter — the previous shape called any
        // side-effecting receiver expression (e.g. `Make().P = v`) twice.
        var isStatic = assn.Receiver == null;
        if (!this.receiverSpillSlots.TryGetValue(assn, out var valueSlot))
        {
            throw new InvalidOperationException(
                $"No slot populated for {assn.Kind} on CLR property '{assn.Member.Name}' — "
                + "walker pre-pass missed this child? "
                + "Check AssignmentValueSpillCollector and its ancestor walker.");
        }

        if (!isStatic)
        {
            this.EmitInstanceReceiver(assn.Receiver);
        }

        this.EmitExpression(assn.Value);
        this.il.OpCode(ILOpCode.Dup);
        this.il.StoreLocal(valueSlot);

        var receiverIsValueType = !isStatic && ReflectionMetadataEmitter.IsValueTypeSymbol(assn.Receiver.Type);
        switch (assn.Member)
        {
            case PropertyInfo property:
                var setter = property.GetSetMethod(nonPublic: false)
                    ?? throw new InvalidOperationException(
                        $"Property '{property.DeclaringType?.FullName}.{property.Name}' has no public setter.");
                this.il.OpCode(isStatic || receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
                // Issue #671: route through the receiver-aware overload so the
                // setter MemberRef parent is the constructed symbolic type when
                // applicable. Falls back to the plain MemberRef path otherwise.
                this.il.Token(isStatic
                    ? (EntityHandle)this.outer.GetMethodReference(setter)
                    : this.outer.GetMethodEntityHandle(setter, assn.Receiver.Type));
                break;
            case FieldInfo field:
                this.il.OpCode(isStatic ? ILOpCode.Stsfld : ILOpCode.Stfld);
                this.il.Token(this.outer.GetFieldReference(field));
                break;
            default:
                throw new NotSupportedException(
                    $"CLR member '{assn.Member.GetType().Name}' is not yet supported by the emitter.");
        }

        // Expression result: the value we just stored. No second receiver
        // evaluation, no getter call.
        this.il.LoadLocal(valueSlot);
    }

    private void EmitClrIndex(BoundClrIndexExpression idx)
    {
        // #313: indexing an erased generic over a type parameter (e.g.
        // `items[0]` where `items: List[T]`, or `map["k"]` where
        // `map: Dictionary[string, T]`). At runtime the receiver is a closed
        // generic (e.g. `List<int32>`) but is typed as the erased
        // `List<object>`; a `callvirt List<object>::get_Item` would fail.
        // Route the read through the non-generic System.Collections.IList /
        // IDictionary interfaces, which return the element as System.Object —
        // exactly the erased shape of the type parameter.
        if (idx.Target.Type is ImportedTypeSymbol erasedGen
            && erasedGen.HasTypeParameterArgument
            && idx.Target.Type.ClrType is System.Type erasedClr
            && idx.Arguments.Length == 1)
        {
            if (typeof(System.Collections.IList).IsAssignableFrom(erasedClr)
                && idx.Arguments[0].Type == TypeSymbol.Int32)
            {
                this.EmitInstanceReceiver(idx.Target);
                this.il.OpCode(ILOpCode.Castclass);
                this.il.Token((EntityHandle)this.outer.GetTypeReference(typeof(System.Collections.IList)));
                this.EmitExpression(idx.Arguments[0]);
                var iListGetter = typeof(System.Collections.IList)
                    .GetProperty("Item")
                    .GetGetMethod();
                this.il.OpCode(ILOpCode.Callvirt);
                this.il.Token(this.outer.GetMethodReference(iListGetter));
                this.EmitErasedObjectReturnWidening(TypeSymbol.Object, idx.Type);
                return;
            }

            if (typeof(System.Collections.IDictionary).IsAssignableFrom(erasedClr))
            {
                this.EmitInstanceReceiver(idx.Target);
                this.il.OpCode(ILOpCode.Castclass);
                this.il.Token((EntityHandle)this.outer.GetTypeReference(typeof(System.Collections.IDictionary)));
                this.EmitExpression(idx.Arguments[0]);
                if (ReflectionMetadataEmitter.IsValueTypeSymbol(idx.Arguments[0].Type))
                {
                    this.il.OpCode(ILOpCode.Box);
                    this.il.Token(this.outer.GetElementTypeToken(idx.Arguments[0].Type));
                }

                var iDictGetter = typeof(System.Collections.IDictionary)
                    .GetProperty("Item")
                    .GetGetMethod();
                this.il.OpCode(ILOpCode.Callvirt);
                this.il.Token(this.outer.GetMethodReference(iDictGetter));
                this.EmitErasedObjectReturnWidening(TypeSymbol.Object, idx.Type);
                return;
            }
        }

        // Phase 4 emit parity: indexer read. `d[k]` -> `callvirt get_Item(k)`.
        this.EmitInstanceReceiver(idx.Target);
        foreach (var arg in idx.Arguments)
        {
            this.EmitExpression(arg);
        }

        var getter = idx.Indexer.GetGetMethod(nonPublic: false)
            ?? throw new InvalidOperationException(
                $"Indexer on '{idx.Indexer.DeclaringType?.FullName}' has no public getter.");
        var receiverIsValueType = ReflectionMetadataEmitter.IsValueTypeSymbol(idx.Target.Type);
        this.il.OpCode(receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
        // Issue #671: route through the receiver-aware overload so the indexer
        // getter MemberRef parent is the constructed symbolic type when the
        // target is a generic with G# user-defined type arguments.
        this.il.Token(this.outer.GetMethodEntityHandle(getter, idx.Target.Type));

        // Issue #957: when the receiver is a symbolic open-generic container
        // closed over a same-compilation user type (e.g. `List[Item]` where
        // `Item` is a `data struct` still being compiled), the receiver-aware
        // MemberRef above encodes the `get_Item` call against the constructed
        // symbolic type, so the runtime stack value is the substituted element
        // type (`Item`), NOT the type-erased CLR `object` that the open
        // `get_Item` return (`T`) reports. Feeding that erased return into the
        // widening would emit a spurious `unbox.any Item` against a stack slot
        // that already holds a raw `Item` value — an ilverify StackUnexpected
        // and a runtime SIGSEGV. Skip the widening, mirroring the property,
        // instance-method, and imported-call variants.
        if (this.outer.TryGetSymbolicSubstitutedPropertyReturn(idx.Target.Type, idx.Indexer, out _))
        {
            return;
        }

        this.EmitErasedObjectReturnWidening(TypeSymbol.FromClrType(getter.ReturnType), idx.Type);
    }

    private void EmitClrIndexAssignment(BoundClrIndexAssignmentExpression ixa)
    {
        var setter = ixa.Indexer.GetSetMethod(nonPublic: false);

        // ADR-0056 §2: span element write. `Span[T]` has no setter; its
        // indexer getter returns `ref T`. Obtain the managed pointer via
        // `get_Item`, then store the value through it (`stobj`/`stind.*`).
        // Issue #418 (P1-1): spill v to a temp before the stobj so the
        // expression's result (the assigned value) does not need a second
        // get_Item that would re-evaluate the index arguments.
        if (setter == null)
        {
            var refGetter = ixa.Indexer.GetGetMethod(nonPublic: false)
                ?? throw new InvalidOperationException(
                    $"Indexer on '{ixa.Indexer.DeclaringType?.FullName}' has no public setter or getter.");
            BoundExpression receiver = ixa.TargetExpression ?? new BoundVariableExpression(null, ixa.Target);
            var tmp = this.indexAssignmentValueSlots[ixa];

            // store: <receiver-addr> <index...> get_Item(ref T) <value> dup stloc tmp stobj/stind
            this.EmitInstanceReceiver(receiver);
            foreach (var arg in ixa.Arguments)
            {
                this.EmitExpression(arg);
            }

            this.il.OpCode(ILOpCode.Call);
            // Issue #671: receiver-aware MemberRef for symbolic constructed generics.
            this.il.Token(this.outer.GetMethodEntityHandle(refGetter, receiver.Type));
            this.EmitExpression(ixa.Value);
            this.il.OpCode(ILOpCode.Dup);
            this.il.StoreLocal(tmp);
            this.EmitStoreIndirect(ixa.Type);

            // expression result: the spilled value.
            this.il.LoadLocal(tmp);
            return;
        }

        // Phase 4 emit parity: indexer write. `d[k] = v` -> `callvirt set_Item(k, v)`.
        // Issue #418 (P1-5): route through EmitInstanceReceiver so a
        // value-type target (`ldloca`) and reference-type target (`ldloc`)
        // are both addressed correctly. For value-type indexers we also
        // need `call` instead of `callvirt`.
        // Issue #418 (P1-1): spill v to a temp before the call so the result
        // is the assigned value without a re-read via get_Item (which would
        // re-evaluate every index argument).
        BoundExpression writeReceiver = ixa.TargetExpression ?? new BoundVariableExpression(null, ixa.Target);
        var targetType = ixa.TargetExpression?.Type ?? ixa.Target.Type;
        var targetIsValueType = ReflectionMetadataEmitter.IsValueTypeSymbol(targetType);
        var slot = this.indexAssignmentValueSlots[ixa];

        this.EmitInstanceReceiver(writeReceiver);
        foreach (var arg in ixa.Arguments)
        {
            this.EmitExpression(arg);
        }

        this.EmitExpression(ixa.Value);
        this.il.OpCode(ILOpCode.Dup);
        this.il.StoreLocal(slot);
        this.il.OpCode(targetIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
        // Issue #671: receiver-aware MemberRef for symbolic constructed generics.
        this.il.Token(this.outer.GetMethodEntityHandle(setter, targetType));
        this.il.LoadLocal(slot);
    }

    private void EmitInstanceReceiver(BoundExpression receiver)
    {
        // Value-type receivers need a managed pointer (the implicit `this`
        // of an instance method on a value type is a `ref` parameter). For
        // the common case where the receiver is a local/parameter, we can
        // emit `ldloca`/`ldarga`. Other shapes are not yet exercised by the
        // emit pipeline.
        //
        // Issue #409: user-defined struct symbols have ClrType == null
        // until after emission, so a same-package receiver method like
        // `func (p Point) Distance() int32` would fall through to a value
        // load (`ldsfld`/`ldloc`) and pass garbage as `this` to the
        // instance call (SIGSEGV at runtime). IsValueTypeSymbol recognises
        // these symbol-only value types alongside enums and built-ins.
        if (ReflectionMetadataEmitter.IsValueTypeSymbol(receiver.Type))
        {
            if (receiver is BoundVariableExpression bve
                && this.TryLoadVariableAddress(bve.Variable))
            {
                return;
            }

            // ADR-0056 §4 (#375): a value-type *field* used as an instance
            // receiver (e.g. `w.data.Length` where `data` is a closed
            // constructed generic value type like `ReadOnlySpan[int32]`)
            // must be loaded by address (`ldflda`), not by value (`ldfld`).
            // Calling an instance method on a value type requires a managed
            // pointer as `this`; pushing the value instead reinterprets the
            // struct's bits as the `this` pointer and corrupts the stack
            // (AccessViolationException). The field signature already
            // carries the real constructed-generic layout, so the address
            // form is both correct and safe — *as long as the containing
            // field chain is itself addressable*. Otherwise `ldflda` on a
            // value on the evaluation stack produces invalid IL
            // (InvalidProgramException at JIT time).
            if (receiver is BoundFieldAccessExpression fa
                && this.outer.cache.StructFieldDefs.ContainsKey(fa.Field)
                && this.IsAddressableFieldAccess(fa))
            {
                this.EmitFieldAddress(fa);
                return;
            }

            // Issue #409 follow-up: a value-type receiver computed as an
            // rvalue (e.g. `makePoint(5, 6).Sum()` or
            // `makeOuter().Inner.Sum()` or `(a + b).Method()`) has no
            // addressable storage. Spill it to a pre-declared local and
            // pass `ldloca` as `this`; this is valid for ordinary structs
            // and by-ref-like `ref struct` values, which cannot be boxed.
            this.EmitExpression(receiver);
            if (!this.receiverSpillSlots.TryGetValue(receiver, out var slot))
            {
                throw new InvalidOperationException(
                    $"No slot populated for {receiver.Kind} receiver of type '{receiver.Type}' — "
                    + "walker pre-pass missed this child? "
                    + "Check ReceiverSpillCollector and its ancestor walker.");
            }

            this.il.StoreLocal(slot);
            this.il.LoadLocalAddress(slot);
            return;
        }

        this.EmitExpression(receiver);
    }

    /// <summary>
    /// Issue #943: loads the address of a receiver whose static type is a type
    /// parameter constrained to a CLR interface, so it can feed a
    /// <c>constrained.</c> prefix on the subsequent <c>callvirt</c>. A managed
    /// pointer is required regardless of whether the type argument is ultimately
    /// a value type or a reference type — the <c>constrained.</c> opcode handles
    /// both. Addressable variables (parameters, locals, globals) load directly;
    /// non-addressable rvalue receivers are spilled to a pre-planned local.
    /// </summary>
    /// <param name="receiver">The constrained type-parameter receiver expression.</param>
    private void EmitConstrainedTypeParameterReceiver(BoundExpression receiver)
    {
        if (receiver is BoundVariableExpression bve
            && this.TryLoadVariableAddress(bve.Variable))
        {
            return;
        }

        this.EmitExpression(receiver);
        if (!this.receiverSpillSlots.TryGetValue(receiver, out var slot))
        {
            throw new InvalidOperationException(
                $"No slot populated for constrained type-parameter receiver of kind "
                + $"'{receiver.Kind}' — walker pre-pass missed this child? "
                + "Check ReceiverSpillCollector.VisitImportedInstanceCallExpression.");
        }

        this.il.StoreLocal(slot);
        this.il.LoadLocalAddress(slot);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="fa"/> is addressable —
    /// i.e. <c>ldflda</c> against its receiver yields a valid managed
    /// pointer. Static fields are always addressable; instance fields on
    /// class receivers are addressable (the receiver is an object
    /// reference); instance fields on value-type receivers are addressable
    /// only if the receiver itself is addressable (a variable, or another
    /// addressable field access).
    /// </summary>
    private bool IsAddressableFieldAccess(BoundFieldAccessExpression fa)
    {
        if (fa.Receiver == null)
        {
            return true;
        }

        if (fa.Receiver.Type is StructSymbol rs && rs.IsClass)
        {
            return true;
        }

        if (fa.Receiver.Type?.ClrType != null && !fa.Receiver.Type.ClrType.IsValueType)
        {
            return true;
        }

        if (fa.Receiver is BoundVariableExpression bv && this.CanLoadVariableAddress(bv.Variable))
        {
            return true;
        }

        if (fa.Receiver is BoundFieldAccessExpression nested
            && this.outer.cache.StructFieldDefs.ContainsKey(nested.Field))
        {
            return this.IsAddressableFieldAccess(nested);
        }

        return false;
    }

    private bool CanLoadVariableAddress(VariableSymbol variable)
    {
        if (variable is ParameterSymbol ps && this.parameters.ContainsKey(ps))
        {
            return true;
        }

        if (this.locals.ContainsKey(variable))
        {
            return true;
        }

        if (variable is GlobalVariableSymbol gv && this.outer.cache.GlobalFieldDefs.ContainsKey(gv))
        {
            return true;
        }

        return false;
    }

    private bool TryLoadVariableAddress(VariableSymbol variable)
    {
        if (variable is ParameterSymbol ps && this.parameters.TryGetValue(ps, out var argIndex))
        {
            // In a struct instance method, arg0 is already a managed pointer
            // (ref TStruct). Loading the arg value gives the address directly;
            // ldarga would give a pointer-to-pointer which is wrong for
            // ldfld/stfld/ldflda on the struct.
            if (argIndex == 0 && this.structThisParameter != null
                && ReferenceEquals(ps, this.structThisParameter))
            {
                this.il.LoadArgument(0);
            }
            else if (ps.RefKind != RefKind.None)
            {
                // ADR-0060: a ref/out/in parameter slot already holds the
                // managed pointer T&; loading the arg value gives the
                // address directly. Ldarga would yield T&* which is wrong.
                this.il.LoadArgument(argIndex);
            }
            else
            {
                this.il.LoadArgumentAddress(argIndex);
            }

            return true;
        }

        if (this.locals.TryGetValue(variable, out var slot))
        {
            // Issue #491 (ADR-0060 follow-up): a ref-aliasing local's slot
            // already stores a managed pointer T&; load the slot value, not
            // its address (ldloca would yield T&* which is wrong).
            if (variable is LocalVariableSymbol refLocal && refLocal.RefKind != RefKind.None)
            {
                this.il.LoadLocal(slot);
            }
            else
            {
                this.il.LoadLocalAddress(slot);
            }

            return true;
        }

        // Issue #408 / #191: top-level globals are emitted as static fields
        // on <Program>; their address is taken with ldsflda.
        if (variable is GlobalVariableSymbol gv
            && this.outer.cache.GlobalFieldDefs.TryGetValue(gv, out var fieldHandle))
        {
            this.il.OpCode(ILOpCode.Ldsflda);
            this.il.Token(fieldHandle);
            return true;
        }

        return false;
    }

    /// <summary>ADR-0039: Emits the field address (ldflda) for a user struct field.</summary>
    private void EmitFieldAddress(BoundFieldAccessExpression fa)
    {
        if (!this.outer.cache.StructFieldDefs.TryGetValue(fa.Field, out var fieldHandle))
        {
            throw new InvalidOperationException(
                $"Cannot take address of field '{fa.Field.Name}': no emitted FieldDef.");
        }

        // ADR-0053: static field address — use ldsflda.
        if (fa.Receiver == null)
        {
            this.il.OpCode(ILOpCode.Ldsflda);
            this.il.Token(fieldHandle);
            return;
        }

        // Load receiver address, then ldflda.
        var receiverIsClass = fa.Receiver.Type is StructSymbol rs && rs.IsClass;
        if (!receiverIsClass
            && fa.Receiver is BoundDereferenceExpression deref
            && Symbols.TypeSymbol.IsUnmanagedPointer(deref.Operand.Type))
        {
            // ADR-0122 §4/§10: `(*p).field` / `p->field`. The pointer value IS
            // the struct's address, so load the pointer directly before ldflda.
            this.EmitExpression(deref.Operand);
        }
        else if (!receiverIsClass && fa.Receiver is BoundVariableExpression bv && this.TryLoadVariableAddress(bv.Variable))
        {
            // address already on stack
        }
        else if (!receiverIsClass
            && fa.Receiver is BoundFieldAccessExpression nested
            && this.outer.cache.StructFieldDefs.ContainsKey(nested.Field)
            && this.IsAddressableFieldAccess(nested))
        {
            this.EmitFieldAddress(nested);
        }
        else
        {
            this.EmitExpression(fa.Receiver);
        }

        this.il.OpCode(ILOpCode.Ldflda);
        this.il.Token(fieldHandle);
    }

    /// <summary>ADR-0039: Emits ldelema for array element address.</summary>
    private void EmitLoadElementAddress(TypeSymbol elementType)
    {
        var clrType = elementType?.ClrType ?? typeof(object);
        var token = this.outer.GetElementTypeToken(elementType ?? TypeSymbol.FromClrType(typeof(object)));
        this.il.OpCode(ILOpCode.Ldelema);
        this.il.Token(token);
    }

    /// <summary>ADR-0039: Emits ldind.* or ldobj for loading a value through a managed pointer.</summary>
    private void EmitLoadIndirect(TypeSymbol pointeeType)
    {
        var clrType = pointeeType?.ClrType;
        if (clrType.IsSameAs(typeof(int)) || clrType.IsSameAs(typeof(uint)))
        {
            this.il.OpCode(ILOpCode.Ldind_i4);
        }
        else if (clrType.IsSameAs(typeof(long)) || clrType.IsSameAs(typeof(ulong)))
        {
            this.il.OpCode(ILOpCode.Ldind_i8);
        }
        else if (clrType.IsSameAs(typeof(float)))
        {
            this.il.OpCode(ILOpCode.Ldind_r4);
        }
        else if (clrType.IsSameAs(typeof(double)))
        {
            this.il.OpCode(ILOpCode.Ldind_r8);
        }
        else if (clrType.IsSameAs(typeof(short)) || clrType.IsSameAs(typeof(ushort)) || clrType.IsSameAs(typeof(char)))
        {
            this.il.OpCode(ILOpCode.Ldind_i2);
        }
        else if (clrType.IsSameAs(typeof(byte)) || clrType.IsSameAs(typeof(sbyte)) || clrType.IsSameAs(typeof(bool)))
        {
            this.il.OpCode(ILOpCode.Ldind_i1);
        }
        else if (pointeeType is StructSymbol { IsClass: false } || (clrType != null && clrType.IsValueType))
        {
            this.il.OpCode(ILOpCode.Ldobj);
            this.il.Token(this.outer.GetElementTypeToken(pointeeType));
        }
        else
        {
            this.il.OpCode(ILOpCode.Ldind_ref);
        }
    }

    /// <summary>ADR-0056 §2: Emits stind.* or stobj to store a value through a managed pointer.</summary>
    private void EmitStoreIndirect(TypeSymbol pointeeType)
    {
        var clrType = pointeeType?.ClrType;
        if (clrType.IsSameAs(typeof(int)) || clrType.IsSameAs(typeof(uint)))
        {
            this.il.OpCode(ILOpCode.Stind_i4);
        }
        else if (clrType.IsSameAs(typeof(long)) || clrType.IsSameAs(typeof(ulong)))
        {
            this.il.OpCode(ILOpCode.Stind_i8);
        }
        else if (clrType.IsSameAs(typeof(float)))
        {
            this.il.OpCode(ILOpCode.Stind_r4);
        }
        else if (clrType.IsSameAs(typeof(double)))
        {
            this.il.OpCode(ILOpCode.Stind_r8);
        }
        else if (clrType.IsSameAs(typeof(short)) || clrType.IsSameAs(typeof(ushort)) || clrType.IsSameAs(typeof(char)))
        {
            this.il.OpCode(ILOpCode.Stind_i2);
        }
        else if (clrType.IsSameAs(typeof(byte)) || clrType.IsSameAs(typeof(sbyte)) || clrType.IsSameAs(typeof(bool)))
        {
            this.il.OpCode(ILOpCode.Stind_i1);
        }
        else if (pointeeType is StructSymbol { IsClass: false } || (clrType != null && clrType.IsValueType))
        {
            this.il.OpCode(ILOpCode.Stobj);
            this.il.Token(this.outer.GetElementTypeToken(pointeeType));
        }
        else
        {
            this.il.OpCode(ILOpCode.Stind_ref);
        }
    }
}
