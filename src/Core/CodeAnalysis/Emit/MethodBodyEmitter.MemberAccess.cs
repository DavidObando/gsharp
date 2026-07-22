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
        // current method is a closure's Invoke (or issue #2727's async
        // MoveNext for that Invoke) and `variable` is one of the enclosing
        // closure's captured outer locals.
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
            || !this.enclosingClosure.CaptureFields.TryGetValue(variable, out var capField))
        {
            return false;
        }

        this.il.OpCode(ILOpCode.Ldarg_0);
        // In MoveNext, arg0 is the state machine. Follow its hoisted `this`
        // field to the closure before loading the captured value.
        if (this.asyncFieldMap?.ThisField is FieldSymbol thisField)
        {
            if (!this.outer.cache.StructFieldDefs.TryGetValue(thisField, out var thisFieldHandle))
            {
                throw new InvalidOperationException(
                    $"Hoisted field '{thisField.Name}' has no emitted FieldDef.");
            }

            this.il.OpCode(ILOpCode.Ldfld);
            this.il.Token(thisFieldHandle);
        }

        this.il.OpCode(ILOpCode.Ldfld);
        this.il.Token(this.outer.userTokens.ResolveFieldToken(this.enclosingClosure.ConstructedClassSym, capField));
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
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(elementType));
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
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(elementType));
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
        this.il.Token(this.outer.memberRefs.GetMethodReference(tryGet));

        // Issue #1714: TryGetValue zero-initialises the out V parameter via the
        // CLR default when the key is missing — for V == string that CLR
        // default is `null`, but G# gives `string` Go-style value semantics
        // where the zero value is `""` (matching the interpreter's
        // Evaluator.DefaultValue). Branch on the returned `found` bool (still
        // on the stack) so a miss yields `""` instead of the CLR-default
        // `null`, while every other V keeps the CLR-default fast path.
        if (mapType.ValueType == TypeSymbol.String)
        {
            var found = this.il.DefineLabel();
            var end = this.il.DefineLabel();
            this.il.Branch(ILOpCode.Brtrue, found);
            this.il.LoadString(this.outer.emitCtx.Metadata.GetOrAddUserString(string.Empty));
            this.il.Branch(ILOpCode.Br, end);
            this.il.MarkLabel(found);
            this.il.LoadLocal(slot);
            this.il.MarkLabel(end);
            return;
        }

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
        this.il.Token(this.outer.memberRefs.GetMethodReference(setItem));
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
        // Issue #1254 + #1467: resolve the struct symbol to parent the field
        // reference at. A constructed generic receiver uses its own TypeSpec;
        // an inherited field declared on a generic base reached through a
        // derived receiver — whether the bound declaring type is recorded as
        // the OPEN generic base or as a non-generic leaf — uses the CONSTRUCTED
        // base instantiation so the reference is not a dangling `<!0>`.
        var fieldContainer = ResolveFieldReferenceContainer(
            fa.StructType as StructSymbol,
            fa.Receiver?.Type as StructSymbol,
            fa.Field);
        if (this.enclosingClosure?.CaptureFields.ContainsValue(fa.Field) == true)
        {
            fieldContainer = this.enclosingClosure.ConstructedClassSym;
        }

        EntityHandle fieldHandle;
        if (fa.InterfaceType != null)
        {
            // ADR-0089 / issue #1030: interface static field read. A generic
            // interface routes through a TypeSpec-parented MemberRef (per
            // construction); a non-generic interface uses the bare FieldDef.
            fieldHandle = this.outer.userTokens.ResolveInterfaceFieldToken(fa.InterfaceType, fa.Field);
        }
        else if (fieldContainer != null)
        {
            fieldHandle = this.outer.userTokens.ResolveFieldToken(fieldContainer, fa.Field);
        }
        else if (fa.Receiver?.Type is StructSymbol receiverStruct)
        {
            fieldHandle = this.outer.userTokens.ResolveFieldToken(receiverStruct, fa.Field);
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
            this.EmitNarrowingCastIfNeeded(GetEffectiveFieldType(fa), fa.NarrowedType);
            return;
        }

        // Issue #1235: a field read on a receiver whose static type is a type
        // parameter constrained to a class (`t.F` with `t : T`, `T : Base`).
        // A reference-type-constrained `!!T` value is boxed (a no-op at runtime
        // that yields the object reference typed as the constraint) so the
        // verifier accepts the subsequent `ldfld` against the constraint class —
        // the same shape the C# compiler emits for `t.field`.
        if (fa.Receiver.Type is TypeParameterSymbol fieldReceiverTp)
        {
            this.EmitExpression(fa.Receiver);
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(fieldReceiverTp));
            this.il.OpCode(ILOpCode.Ldfld);
            this.il.Token(fieldHandle);
            this.EmitNarrowingCastIfNeeded(GetEffectiveFieldType(fa), fa.NarrowedType);
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
        else if (!receiverIsClass && fa.Receiver is BoundVariableExpression bv && this.TryLoadStructVariableAddress(bv))
        {
            // address is on the stack
        }
        else if (!this.TryEmitCachedReceiver(fa.Receiver, needAddress: false))
        {
            // Issue #1688: TryEmitCachedReceiver returns false when this
            // receiver isn't the shared receiver of a compound assignment
            // (no planned slot) — fall back to a plain evaluation.
            this.EmitExpression(fa.Receiver);
        }

        this.il.OpCode(ILOpCode.Ldfld);
        this.il.Token(fieldHandle);
        this.EmitNarrowingCastIfNeeded(GetEffectiveFieldType(fa), fa.NarrowedType);
    }

    private static TypeSymbol GetEffectiveFieldType(BoundFieldAccessExpression access)
        => access.StructType is StructSymbol owner
            ? owner.SubstituteMemberType(access.Field.Type)
            : access.Field.Type;

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

        // ADR-0087 §3 R3 + issue #1254/#1467: route via a TypeSpec-parented
        // MemberRef when the field is on a generic type — constructed receiver,
        // or an inherited field on a generic base reached through a derived
        // receiver (use the constructed base, never the open `<!0>`).
        var fieldContainer = ResolveFieldReferenceContainer(
            fas.StructType as StructSymbol,
            fas.Receiver?.Type as StructSymbol,
            fas.Field);
        if (this.enclosingClosure?.CaptureFields.ContainsValue(fas.Field) == true)
        {
            fieldContainer = this.enclosingClosure.ConstructedClassSym;
        }

        EntityHandle fieldHandle;
        if (fas.InterfaceType != null)
        {
            // ADR-0089 / issue #1030: interface static field write — generic
            // interface via TypeSpec MemberRef, non-generic via bare FieldDef.
            fieldHandle = this.outer.userTokens.ResolveInterfaceFieldToken(fas.InterfaceType, fas.Field);
        }
        else if (fieldContainer != null)
        {
            fieldHandle = this.outer.userTokens.ResolveFieldToken(fieldContainer, fas.Field);
        }
        else if (fas.Receiver?.Type is StructSymbol receiverStruct)
        {
            fieldHandle = this.outer.userTokens.ResolveFieldToken(receiverStruct, fas.Field);
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

            // Issue #1614: the receiver is an arbitrary expression (e.g. a
            // method-call result) and may have side effects, so it must be
            // evaluated exactly once. Previously the receiver was emitted a
            // second time after the store to re-read the field for the
            // expression result — re-running any side effect and, worse,
            // reading the field off a freshly re-evaluated (possibly
            // different) object. Mirror the property-assignment fix (issue
            // #418 P1-2): dup the assigned value into a pre-planned temp
            // before the `stfld` and load the temp back as the result —
            // no second receiver evaluation, no re-read.
            if (!this.receiverSpillSlots.TryGetValue(fas, out var valueSlot))
            {
                throw new InvalidOperationException(
                    $"No slot populated for {fas.Kind} on field '{fas.Field.Name}' — "
                    + "walker pre-pass missed this child? "
                    + "Check AssignmentValueSpillCollector and its ancestor walker.");
            }

            // Issue #1688: this receiver is a plain value push for `stfld`
            // (not an address), so needAddress: false — TryEmitCachedReceiver
            // falls back to a normal EmitExpression when no compound-reuse
            // slot was planned (the common #1614 simple-assignment case).
            if (!this.TryEmitCachedReceiver(addressReceiver ?? fas.ReceiverExpression, needAddress: false))
            {
                this.EmitExpression(addressReceiver ?? fas.ReceiverExpression);
            }

            // Issue #1235 (object-initializer follow-up): a `T{Field: value}`
            // literal on a class-constrained type parameter lowers to an
            // expression-receiver field write against the freshly constructed
            // `!!T` value — box it (a runtime no-op for a reference-type
            // instantiation) so the subsequent `stfld` is verifiable, mirroring
            // the read/variable-receiver-write paths.
            if (addressReceiver == null && fas.ReceiverExpression.Type is TypeParameterSymbol fieldExprAssnTp)
            {
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(fieldExprAssnTp));
            }

            this.EmitExpression(fas.Value);
            this.il.OpCode(ILOpCode.Dup);
            this.il.StoreLocal(valueSlot);
            this.il.OpCode(ILOpCode.Stfld);
            this.il.Token(fieldHandle);

            // Expression result: the value we just stored — no second
            // receiver evaluation, no second field read.
            this.il.LoadLocal(valueSlot);
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

        // Issue #1235 (write side): a field write on a receiver whose static
        // type is a type parameter constrained to a class (`t.F = v` with
        // `t : T`, `T : Base`). Mirrors EmitFieldAccess's read-side
        // `box !!T; ldfld` with `box !!T; stfld`.
        if (fas.Receiver.Type is TypeParameterSymbol fieldAssnTp)
        {
            this.EmitLoadVariable(fas.Receiver);
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(fieldAssnTp));
            this.EmitExpression(fas.Value);
            this.il.OpCode(ILOpCode.Stfld);
            this.il.Token(fieldHandle);

            this.EmitLoadVariable(fas.Receiver);
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(fieldAssnTp));
            this.il.OpCode(ILOpCode.Ldfld);
            this.il.Token(fieldHandle);
            return;
        }

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

        // Issue #1988 (follow-up to #1917/#1982): the four `TryLoadVariableAddress(fas.Receiver)`
        // calls below (not `TryLoadStructVariableAddress`) are intentional, not
        // an unmigrated oversight. `fas.Receiver` is a bare `VariableSymbol`,
        // which — unlike `BoundVariableExpression` — carries no `NarrowedType`.
        // The binder (`BindFieldAssignmentExpression`) dispatches to this
        // struct-field-write branch using the receiver's raw DECLARED type
        // (`variable.Type is StructSymbol`), never a smart-cast-narrowed type,
        // so a narrowed struct local (e.g. `object oa` narrowed by `oa is
        // Money`) can never reach here as a struct receiver: `oa.Cents = v`
        // instead resolves `oa`'s declared `object` type and fails to find
        // member `Cents` (GS0158) before emission — see
        // Issue1988NarrowedStructFieldAssignmentBinderTests. `fas.Receiver` is
        // therefore always the variable's own struct-typed storage, so the
        // direct `ldarga`/`ldloca` path is correct and the unbox helper does
        // not apply.
        //
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
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(defaultExpr.Type));

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
        var getterContainer = ResolvePropertyReferenceContainer(
            access.StructType as StructSymbol,
            access.Receiver?.Type as StructSymbol,
            access.Property);
        if (getterContainer != null)
        {
            getterHandle = this.outer.userTokens.ResolveUserPropertyAccessorToken(getterContainer, access.Property, wantSetter: false);
        }
        else if (this.outer.cache.PropertyAccessorHandles.TryGetValue(access.Property, out var handles) && handles.Getter.HasValue)
        {
            getterHandle = handles.Getter.Value;
        }
        else if ((access.StructType as StructSymbol)?.ClrType != null)
        {
            // Issue #2291: a property on an IMPORTED type (e.g. a C# record's
            // auto-property) has no planned PropertyAccessorHandles entry —
            // resolve its getter MethodRef directly off the imported CLR type.
            getterHandle = this.outer.userTokens.ResolveUserPropertyAccessorToken(access.StructType as StructSymbol, access.Property, wantSetter: false);
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

        // Issue #1235: a property read on a receiver whose static type is a type
        // parameter constrained to a class or interface (`t.P` with `t : T`,
        // `T : Base`). A reference-type-constrained `!!T` value is boxed (a
        // runtime no-op yielding the object reference typed as the constraint)
        // and the getter dispatched with `callvirt get_P` — the same verifiable
        // shape the C# compiler emits for a property read through a type
        // parameter.
        if (access.Receiver.Type is TypeParameterSymbol tpReceiver)
        {
            this.EmitExpression(access.Receiver);
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(tpReceiver));
            this.il.OpCode(ILOpCode.Callvirt);
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
        var setterContainer = ResolvePropertyReferenceContainer(
            assn.StructType as StructSymbol,
            assn.Receiver?.Type as StructSymbol,
            assn.Property);
        if (setterContainer != null)
        {
            setterHandle = this.outer.userTokens.ResolveUserPropertyAccessorToken(setterContainer, assn.Property, wantSetter: true);
        }
        else if (this.outer.cache.PropertyAccessorHandles.TryGetValue(assn.Property, out var handles) && handles.Setter.HasValue)
        {
            setterHandle = handles.Setter.Value;
        }
        else if ((assn.StructType as StructSymbol)?.ClrType != null)
        {
            // Issue #2291: mirrors the getter fallback above for IMPORTED
            // properties with no planned PropertyAccessorHandles entry.
            setterHandle = this.outer.userTokens.ResolveUserPropertyAccessorToken(assn.StructType as StructSymbol, assn.Property, wantSetter: true);
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

        // Issue #1235 (write side): a property write on a receiver whose
        // static type is a type parameter constrained to a class or interface
        // (`t.P = v` with `t : T`). Mirrors EmitPropertyAccess's read-side
        // `box !!T; callvirt get_P` with `box !!T; callvirt set_P(value)`.
        if (assn.Receiver.Type is TypeParameterSymbol tpAssnReceiver)
        {
            this.EmitExpression(assn.Receiver);
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(tpAssnReceiver));
            this.EmitExpression(assn.Value);
            this.il.OpCode(ILOpCode.Dup);
            this.il.StoreLocal(valueSlot);
            this.il.OpCode(ILOpCode.Callvirt);
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
        if (access.IsConstrainedTypeParameterAccess)
        {
            if (access.Member is not PropertyInfo constrainedProperty)
            {
                throw new NotSupportedException("Imported interface constraints cannot expose instance fields.");
            }

            var constrainedGetter = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(
                constrainedProperty,
                wantSetter: false)
                ?? throw new InvalidOperationException(
                    $"Property '{constrainedProperty.DeclaringType?.FullName}.{constrainedProperty.Name}' has no public getter.");
            this.EmitConstrainedTypeParameterReceiver(access.Receiver);
            this.il.OpCode(ILOpCode.Constrained);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(access.ConstrainedReceiverTypeParameter));
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(
                constrainedGetter,
                access.ConstrainedInterfaceType));
            return;
        }

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
                // Issue #1582: an inherited property from a metadata base may
                // expose only a `protected` / `protected internal` getter. Try
                // the public accessor first (unchanged IL for existing samples),
                // then fall back to the non-public getter for inherited members.
                var getter = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(property, wantSetter: false)
                    ?? ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(property, wantSetter: false, nonPublic: true)
                    ?? throw new InvalidOperationException(
                        $"Property '{property.DeclaringType?.FullName}.{property.Name}' has no accessible getter.");
                // Issue #671: when the receiver is a symbolic constructed
                // generic (e.g. List[MyGs] with a user-defined type arg),
                // route the getter through the receiver-aware overload so
                // the MemberRef parent is the constructed type with the
                // real user-type tokens instead of the type-erased
                // List<object>. Static getters and CLR receivers fall back
                // to the plain MemberRef path inside the overload.
                var getterRef = isStatic
                    ? (access.StaticContainerType != null
                        ? this.outer.memberRefs.GetMethodEntityHandle(getter, access.StaticContainerType)
                        : (EntityHandle)this.outer.memberRefs.GetMethodReference(getter))
                    : this.outer.memberRefs.GetMethodEntityHandle(getter, access.Receiver.Type);
                this.il.OpCode(isStatic || receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
                this.il.Token(getterRef);

                // Issue #1330: when the static read is parented at a symbolic
                // constructed container (`Comparer[TResult].Default`), the
                // MemberRef encodes the call against the open generic property,
                // so the runtime stack value is the substituted symbolic type
                // (`Comparer<!TResult>`), not the erased `object`. Skip widening
                // exactly as the instance symbolic-container path does below.
                if (isStatic && access.StaticContainerType != null)
                {
                    break;
                }

                // Issue #774: when the receiver is a symbolic open container,
                // the symbolic MemberRef encodes the call against the open
                // generic property — the runtime stack value is therefore the
                // substituted symbolic type, not the closed CLR `object` that
                // `getter.ReturnType` reports. Skip widening so we don't emit
                // a verifier-breaking `unbox.any T` against a value type T
                // (the stack already holds the substituted `!!0`).
                if (!isStatic
                    && this.outer.userTokens.TryGetSymbolicSubstitutedPropertyReturn(access.Receiver.Type, property, out _))
                {
                    break;
                }

                this.EmitErasedObjectReturnWidening(
                    TypeSymbol.FromClrType(getter.ReturnType),
                    access.Type);
                break;
            case FieldInfo field:
                var fieldRef = access.StaticContainerType != null
                    ? this.outer.memberRefs.GetFieldReference(field, access.StaticContainerType)
                    : this.outer.memberRefs.GetFieldReference(field);
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

        if (assn.IsConstrainedTypeParameterAccess)
        {
            if (assn.Member is not PropertyInfo constrainedProperty)
            {
                throw new NotSupportedException("Imported interface constraints cannot expose instance fields.");
            }

            var constrainedSetter = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(
                constrainedProperty,
                wantSetter: true)
                ?? throw new InvalidOperationException(
                    $"Property '{constrainedProperty.DeclaringType?.FullName}.{constrainedProperty.Name}' has no public setter.");
            this.EmitConstrainedTypeParameterReceiver(assn.Receiver);
            this.EmitExpression(assn.Value);
            this.il.OpCode(ILOpCode.Dup);
            this.il.StoreLocal(valueSlot);
            this.il.OpCode(ILOpCode.Constrained);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(assn.ConstrainedReceiverTypeParameter));
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(
                constrainedSetter,
                assn.ConstrainedInterfaceType));
            this.il.LoadLocal(valueSlot);
            return;
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
                // Issue #1582: fall back to a non-public setter for an inherited
                // metadata-base property (public accessor tried first so existing
                // sample IL is unchanged).
                var setter = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(property, wantSetter: true)
                    ?? ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(property, wantSetter: true, nonPublic: true)
                    ?? throw new InvalidOperationException(
                        $"Property '{property.DeclaringType?.FullName}.{property.Name}' has no public setter.");
                this.il.OpCode(isStatic || receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
                // Issue #671: route through the receiver-aware overload so the
                // setter MemberRef parent is the constructed symbolic type when
                // applicable. Falls back to the plain MemberRef path otherwise.
                this.il.Token(isStatic
                    ? (EntityHandle)this.outer.memberRefs.GetMethodReference(setter)
                    : this.outer.memberRefs.GetMethodEntityHandle(setter, assn.Receiver.Type));
                break;
            case FieldInfo field:
                this.il.OpCode(isStatic ? ILOpCode.Stsfld : ILOpCode.Stfld);
                this.il.Token(this.outer.memberRefs.GetFieldReference(field));
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
        if (idx.IsConstrainedTypeParameterAccess)
        {
            var constrainedGetter = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(
                idx.Indexer,
                wantSetter: false)
                ?? throw new InvalidOperationException(
                    $"Indexer on '{idx.Indexer.DeclaringType?.FullName}' has no public getter.");
            this.EmitConstrainedTypeParameterReceiver(idx.Target);
            foreach (var arg in idx.Arguments)
            {
                this.EmitExpression(arg);
            }

            this.il.OpCode(ILOpCode.Constrained);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(idx.ConstrainedReceiverTypeParameter));
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(
                constrainedGetter,
                idx.ConstrainedInterfaceType));
            return;
        }

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
                this.il.Token((EntityHandle)this.outer.memberRefs.GetTypeReference(typeof(System.Collections.IList)));
                this.EmitExpression(idx.Arguments[0]);
                var iListGetter = typeof(System.Collections.IList)
                    .GetProperty("Item")
                    .GetGetMethod();
                this.il.OpCode(ILOpCode.Callvirt);
                this.il.Token(this.outer.memberRefs.GetMethodReference(iListGetter));
                this.EmitErasedObjectReturnWidening(TypeSymbol.Object, idx.Type);
                return;
            }

            if (typeof(System.Collections.IDictionary).IsAssignableFrom(erasedClr))
            {
                this.EmitInstanceReceiver(idx.Target);
                this.il.OpCode(ILOpCode.Castclass);
                this.il.Token((EntityHandle)this.outer.memberRefs.GetTypeReference(typeof(System.Collections.IDictionary)));
                this.EmitExpression(idx.Arguments[0]);
                if (ReflectionMetadataEmitter.IsValueTypeSymbol(idx.Arguments[0].Type))
                {
                    this.il.OpCode(ILOpCode.Box);
                    this.il.Token(this.outer.memberRefs.GetElementTypeToken(idx.Arguments[0].Type));
                }

                var iDictGetter = typeof(System.Collections.IDictionary)
                    .GetProperty("Item")
                    .GetGetMethod();
                this.il.OpCode(ILOpCode.Callvirt);
                this.il.Token(this.outer.memberRefs.GetMethodReference(iDictGetter));
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

        var getter = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(idx.Indexer, wantSetter: false)
            ?? throw new InvalidOperationException(
                $"Indexer on '{idx.Indexer.DeclaringType?.FullName}' has no public getter.");
        var receiverIsValueType = ReflectionMetadataEmitter.IsValueTypeSymbol(idx.Target.Type);
        this.il.OpCode(receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
        // Issue #671: route through the receiver-aware overload so the indexer
        // getter MemberRef parent is the constructed symbolic type when the
        // target is a generic with G# user-defined type arguments.
        this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(getter, idx.Target.Type));

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
        if (this.outer.userTokens.TryGetSymbolicSubstitutedPropertyReturn(idx.Target.Type, idx.Indexer, out _))
        {
            return;
        }

        this.EmitErasedObjectReturnWidening(TypeSymbol.FromClrType(getter.ReturnType), idx.Type);
    }

    private void EmitClrIndexAssignment(BoundClrIndexAssignmentExpression ixa)
    {
        var setter = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(ixa.Indexer, wantSetter: true);

        if (ixa.IsConstrainedTypeParameterAccess)
        {
            if (setter == null)
            {
                throw new InvalidOperationException(
                    $"Indexer on '{ixa.Indexer.DeclaringType?.FullName}' has no public setter.");
            }

            BoundExpression constrainedReceiver = ixa.TargetExpression
                ?? new BoundVariableExpression(null, ixa.Target);
            var constrainedValueSlot = this.indexAssignmentValueSlots[ixa];
            this.EmitConstrainedTypeParameterReceiver(constrainedReceiver);
            foreach (var arg in ixa.Arguments)
            {
                this.EmitExpression(arg);
            }

            this.EmitExpression(ixa.Value);
            this.il.OpCode(ILOpCode.Dup);
            this.il.StoreLocal(constrainedValueSlot);
            this.il.OpCode(ILOpCode.Constrained);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(ixa.ConstrainedReceiverTypeParameter));
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(
                setter,
                ixa.ConstrainedInterfaceType));
            this.il.LoadLocal(constrainedValueSlot);
            return;
        }

        // ADR-0056 §2: span element write. `Span[T]` has no setter; its
        // indexer getter returns `ref T`. Obtain the managed pointer via
        // `get_Item`, then store the value through it (`stobj`/`stind.*`).
        // Issue #418 (P1-1): spill v to a temp before the stobj so the
        // expression's result (the assigned value) does not need a second
        // get_Item that would re-evaluate the index arguments.
        if (setter == null)
        {
            var refGetter = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(ixa.Indexer, wantSetter: false)
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

            // Span-like value types require a direct call; ref-returning
            // interface indexers still dispatch virtually (#2525).
            this.il.OpCode(ReflectionMetadataEmitter.IsValueTypeSymbol(receiver.Type)
                ? ILOpCode.Call
                : ILOpCode.Callvirt);
            // Issue #671: receiver-aware MemberRef for symbolic constructed generics.
            this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(refGetter, receiver.Type));
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
        this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(setter, targetType));
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
                && this.TryLoadStructVariableAddress(bve))
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
            // Issue #1688: if this exact receiver instance is ALSO the
            // shared receiver of a compound member assignment, it was (or
            // will be) cached once via TryEmitCachedReceiver — reuse that
            // cache instead of re-evaluating the receiver a second time.
            if (this.TryEmitCachedReceiver(receiver, needAddress: true))
            {
                return;
            }

            throw new InvalidOperationException(
                $"No slot populated for {receiver.Kind} receiver of type '{receiver.Type}' — "
                + "walker pre-pass missed this child? "
                + "Check ReceiverSpillCollector and its ancestor walker.");
        }

        // Issue #1688: a reference-type receiver shared between the read and
        // write side of a compound member assignment (`getObj().F += x` /
        // `getObj().P += x`) must be evaluated exactly once. Route through
        // the cache before falling back to a plain re-emit.
        if (this.TryEmitCachedReceiver(receiver, needAddress: false))
        {
            return;
        }

        this.EmitExpression(receiver);
    }

    /// <summary>
    /// Issue #1688: when <paramref name="receiver"/> was flagged by
    /// <c>SlotPlanner.ReceiverSpillCollector.AddIfCompoundReused</c> — i.e. it
    /// is the shared receiver of a compound field/property assignment
    /// (<c>getObj().F += x</c> / <c>getObj().P += x</c>) — evaluates it
    /// exactly once into its planned slot and loads from the slot on every
    /// subsequent encounter of the SAME node instance, instead of re-running
    /// the (potentially side-effecting) receiver expression for each of the
    /// read and write sides.
    /// </summary>
    /// <param name="receiver">The receiver expression to emit or reuse from cache.</param>
    /// <param name="needAddress">Whether the caller needs the receiver's address (value-type <c>this</c>) rather than its value.</param>
    /// <returns><see langword="true"/> when the receiver was handled via the cache (planned slot found); <see langword="false"/> when no slot was planned and the caller should fall back to its own emission.</returns>
    private bool TryEmitCachedReceiver(BoundExpression receiver, bool needAddress)
    {
        if (!this.receiverSpillSlots.TryGetValue(receiver, out var slot))
        {
            return false;
        }

        if (this.spilledCompoundReceivers.Add(receiver))
        {
            this.EmitExpression(receiver);
            this.il.StoreLocal(slot);
        }

        if (needAddress)
        {
            this.il.LoadLocalAddress(slot);
        }
        else
        {
            this.il.LoadLocal(slot);
        }

        return true;
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
    /// <remarks>
    /// Issue #2335 (audit follow-up): a NARROWED variable receiver
    /// (ADR-0069 smart-cast — <c>bve.NarrowedType != null</c>, e.g. <c>if x is
    /// T { x.ToString() }</c> narrowing an <c>object</c>-typed
    /// parameter/local to a type-parameter view <c>T</c>) must NOT take the
    /// fast "own address" path even though it IS a
    /// <see cref="BoundVariableExpression"/>: the narrowed view still
    /// physically lives in the wider DECLARED storage slot (e.g. an
    /// <c>object</c> field/parameter/local), so <c>ldarga</c>/<c>ldloca</c>
    /// on that slot yields <c>&lt;declared&gt;&amp;</c> (e.g.
    /// <c>object&amp;</c>) — NOT the <c>!!T&amp;</c> the <c>constrained.</c>
    /// prefix requires. ilverify rejects the mismatch
    /// (<c>StackUnexpected</c>), and the wrong pointer shape would
    /// misinterpret the receiver's bytes at runtime for shared generic code.
    /// <see cref="SlotPlanner.ReceiverSpillCollector"/> plans a spill slot
    /// (typed as the NARROWED type, since <c>BoundVariableExpression.Type</c>
    /// reports <c>NarrowedType ?? Variable.Type</c>) for exactly this case, so
    /// falling through to the general rvalue-spill path below —
    /// <see cref="EmitExpression"/> re-materializes the correctly narrowed
    /// <c>!!T</c> value via <c>EmitNarrowingCastIfNeeded</c> — produces a
    /// verifiable, correctly-addressed receiver.
    /// </remarks>
    /// <param name="receiver">The constrained type-parameter receiver expression.</param>
    private void EmitConstrainedTypeParameterReceiver(BoundExpression receiver)
    {
        if (receiver is BoundVariableExpression bve
            && bve.NarrowedType == null
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
            // Issue #1525: mirror ReflectionMetadataEmitter
            // .IsAddressableFieldAccessForReceiverSpill — a static field is
            // addressable via ldsflda except for an initonly (readonly) static
            // value-type field outside its declaring type's .cctor, which must
            // be spilled to a temp (defensive copy) to keep the IL verifiable.
            // These two predicates MUST stay in sync: if they disagree the
            // emitter looks up a spill slot the planner never reserved.
            return this.outer.IsStaticFieldAddressLegalHere(fa.Field);
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

    /// <summary>
    /// Loads the address of a struct-typed receiver that is a bare variable
    /// read, honoring ADR-0069 smart-cast narrowing (issue #1917). When the
    /// variable's OWN declared type already agrees with the receiver's
    /// (possibly narrowed) struct type, the address is the variable's own
    /// storage — delegates to <see cref="TryLoadVariableAddress"/>
    /// (ldarga/ldloca). When the receiver is a NARROWED read of a variable
    /// declared as a REFERENCE type (e.g. an `object`/interface-typed
    /// parameter smart-cast to a struct by an <c>is</c> test — `obj is Money
    /// &amp;&amp; obj.Cents`), the variable's slot holds a boxed reference, not
    /// struct storage: taking its address directly pushes the address of
    /// the `object` SLOT, which a subsequent `ldfld`/`ldflda Money::…`
    /// rejects at verification time (ilverify: "found address of 'object',
    /// expected readonly address of 'Money'" — the CLR JIT tolerates the
    /// mismatched stack shape, but ilverify's stricter typed-stack model does
    /// not). The correct sequence loads the boxed reference then
    /// <c>unbox</c>es it: this yields a controlled-mutability (read-only)
    /// managed pointer directly to the embedded value — matching both what
    /// ilverify expects and what csc emits for the equivalent C# pattern.
    /// </summary>
    /// <param name="bve">The struct-typed variable-read receiver.</param>
    /// <returns><see langword="true"/> once the address (or unboxed pointer) is on the stack.</returns>
    private bool TryLoadStructVariableAddress(BoundVariableExpression bve)
    {
        var declaredType = bve.Variable.Type;
        var effectiveType = bve.Type;
        if (bve.NarrowedType == null
            || ReflectionMetadataEmitter.IsValueTypeSymbol(declaredType)
            || declaredType?.ClrType?.IsValueType == true)
        {
            // No boxing narrowing involved (or the variable's own slot is
            // already a value type) — safe to take the variable's own address.
            return this.TryLoadVariableAddress(bve.Variable);
        }

        this.EmitLoadVariable(bve.Variable);
        this.il.OpCode(ILOpCode.Unbox);
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(effectiveType));
        return true;
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
        // Issue #1465: a field declared on a generic user struct (e.g. an async
        // state-machine reified over its enclosing class's type parameters) must
        // be addressed through a MemberRef parented at the constructed self
        // TypeSpec (`SM`1<!T>`), not the raw open FieldDef. Mirror the
        // generic-aware resolution used by the value-read path so `ldflda`
        // (struct builder SetResult/SetException etc.) matches verification.
        EntityHandle fieldHandle;
        var fieldContainer = ResolveFieldReferenceContainer(
            fa.StructType as StructSymbol,
            fa.Receiver?.Type as StructSymbol,
            fa.Field);
        if (fieldContainer != null)
        {
            fieldHandle = this.outer.userTokens.ResolveFieldToken(fieldContainer, fa.Field);
        }
        else if (this.outer.cache.StructFieldDefs.TryGetValue(fa.Field, out var defHandle))
        {
            fieldHandle = defHandle;
        }
        else
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
        else if (!receiverIsClass && fa.Receiver is BoundVariableExpression bv && this.TryLoadStructVariableAddress(bv))
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
        var token = this.outer.memberRefs.GetElementTypeToken(elementType ?? TypeSymbol.FromClrType(typeof(object)));
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
        else if (clrType.IsSameAs(typeof(short)))
        {
            this.il.OpCode(ILOpCode.Ldind_i2);
        }
        else if (clrType.IsSameAs(typeof(ushort)) || clrType.IsSameAs(typeof(char)))
        {
            // Issue #1613: ldind.i2 sign-extends to int32. ushort/char are
            // unsigned pointees — mirror EmitLoadElement (issue #520) and use
            // the unsigned form so values >= 0x8000 don't come back negative.
            this.il.OpCode(ILOpCode.Ldind_u2);
        }
        else if (clrType.IsSameAs(typeof(sbyte)))
        {
            this.il.OpCode(ILOpCode.Ldind_i1);
        }
        else if (clrType.IsSameAs(typeof(byte)) || clrType.IsSameAs(typeof(bool)))
        {
            // Issue #1613: same fix for byte/bool — ldind.u1 zero-extends.
            this.il.OpCode(ILOpCode.Ldind_u1);
        }
        else if (pointeeType is StructSymbol { IsClass: false } || (clrType != null && clrType.IsValueType))
        {
            this.il.OpCode(ILOpCode.Ldobj);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(pointeeType));
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
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(pointeeType));
        }
        else
        {
            this.il.OpCode(ILOpCode.Stind_ref);
        }
    }

    // Issue #1254: when an inherited property is accessed through a (non-generic)
    // derived receiver but the property is declared on a generic base type, the
    // accessor must be referenced via a MemberRef parented at the CONSTRUCTED
    // base TypeSpec. Returns that constructed base, or null when the property is
    // not inherited from a generic base.
    private static StructSymbol ResolveInheritedGenericBaseForProperty(StructSymbol receiver, PropertySymbol property)
    {
        if (receiver == null || property == null)
        {
            return null;
        }

        return receiver.FindConstructedGenericBase(def => DefDeclaresProperty(def, property));
    }

    private static bool DefDeclaresProperty(StructSymbol def, PropertySymbol property)
    {
        var set = property.IsStatic ? def.StaticProperties : def.Properties;
        if (set.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var candidate in set)
        {
            if (candidate.Name == property.Name && candidate.IsIndexer == property.IsIndexer)
            {
                return true;
            }
        }

        return false;
    }

    // Issue #1254: the field analogue of ResolveInheritedGenericBaseForProperty.
    private static StructSymbol ResolveInheritedGenericBaseForField(StructSymbol receiver, FieldSymbol field)
    {
        if (receiver == null || field == null)
        {
            return null;
        }

        return receiver.FindConstructedGenericBase(def => DefDeclaresField(def, field));
    }

    private static bool DefDeclaresField(StructSymbol def, FieldSymbol field)
    {
        if (def.Fields.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var candidate in def.Fields)
        {
            if (candidate.Name == field.Name)
            {
                return true;
            }
        }

        return false;
    }

    // Issue #1467: resolves the struct symbol to parent a field reference at.
    // The bound member-access node carries the field's DECLARING type
    // (<paramref name="declaringType"/>). When that declaring type is an OPEN
    // generic base (it carries no concrete type arguments, e.g.
    // `FrameFilterBase`1` reached from a non-generic leaf override), encoding
    // the reference against it produces a dangling `<!0>` instantiation that
    // the verifier rejects. Resolve the CONSTRUCTED base instantiation
    // reachable from the receiver's hierarchy instead — this yields the
    // concrete base (`FrameFilterBase`1<int32>`) for a non-generic leaf and the
    // self-instantiation (`FrameFilterBase`1<!0>`) when accessed from within the
    // generic type itself. Returns null when the bare FieldDef should be used
    // (a non-generic declaring type with no generic base in scope).
    private static StructSymbol ResolveFieldReferenceContainer(StructSymbol declaringType, StructSymbol receiver, FieldSymbol field)
    {
        if (declaringType == null)
        {
            return null;
        }

        // Prefer the constructed base instantiation reachable from the receiver.
        // FindConstructedGenericBase walks the receiver's hierarchy (including
        // itself) resolving type arguments through the running substitution, so
        // it yields the self-instantiation (`Base`1<!0>`) when the field is
        // accessed from within the generic type and the concrete instantiation
        // (`Base`1<int32>`) when reached through a non-generic leaf — even when
        // the bound declaring type was recorded as the open self carrying its
        // own type parameters as arguments.
        var constructed = ResolveInheritedGenericBaseForField(receiver, field);
        if (constructed != null)
        {
            return constructed;
        }

        // No receiver-reachable constructed base (e.g. a null/static receiver):
        // fall back to the declaring type when it is itself generic.
        if (!declaringType.TypeArguments.IsDefaultOrEmpty)
        {
            return declaringType;
        }

        var def = declaringType.Definition ?? declaringType;
        return def.TypeParameters.IsDefaultOrEmpty ? null : declaringType;
    }

    // Issue #1467: the property analogue of ResolveFieldReferenceContainer.
    private static StructSymbol ResolvePropertyReferenceContainer(StructSymbol declaringType, StructSymbol receiver, PropertySymbol property)
    {
        if (declaringType == null)
        {
            return null;
        }

        var constructed = ResolveInheritedGenericBaseForProperty(receiver, property);
        if (constructed != null)
        {
            return constructed;
        }

        if (!declaringType.TypeArguments.IsDefaultOrEmpty)
        {
            return declaringType;
        }

        var def = declaringType.Definition ?? declaringType;
        return def.TypeParameters.IsDefaultOrEmpty ? null : declaringType;
    }
}
