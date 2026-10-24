// <copyright file="MethodBodyEmitter.MemberAccess.cs" company="GSharp">
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
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

/// PR-E-11 partial of (cref:MethodBodyEmitter):
/// field/property/index access and assignment plus variable load/store.
/// See `MethodBodyEmitter.cs` for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
internal partial class MethodBodyEmitter {
    private func EmitLoadVariable(variable VariableSymbol) {
        // Issue #216: const bindings have no IL slot — inline the literal value.
        if this.constValues != nil && this.constValues.TryGetValue(variable, out var cv) {
            this.EmitLiteral(BoundLiteralExpression(nil, cv, variable.Type))
            return
        }
        // Issue #3519: package constants are visible from every emitted body,
        // not only the entry-point body that contains their declarations.
        if variable is GlobalVariableSymbol{IsConst: true} globalConst {
            this.EmitLiteral(BoundLiteralExpression(nil, globalConst.ConstantValue, globalConst.Type))
            return
        }
        // Issue #2771: emitter-owned variable operations (notably `?.`
        // captures) bypass MoveNextBodyRewriter's bound-node substitution.
        if this.asyncFieldMap != nil && this.asyncFieldMap.TryGetHoistedField(variable, out var hoistedField) {
            this.il.OpCode(ILOpCode.Ldarg_0)
            this.il.OpCode(ILOpCode.Ldfld)
            this.il.Token(this.ResolveCurrentStateMachineFieldToken(hoistedField!!))
            return
        }
        if variable is ParameterSymbol ps && this.parameters.TryGetValue(ps, out var argIndex) {
            this.il.LoadArgument(argIndex)
            if ps.RefKind != RefKind.None || object.ReferenceEquals(ps, this.structThisParameter) {
                // Ref parameters and value-type `this` slots hold managed
                // pointers; an ordinary value read must dereference them.
                this.EmitLoadIndirect(ps.Type)
            }
            return
        }
        if this.locals.TryGetValue(variable, out var slot) {
            this.il.LoadLocal(slot)
            // Issue #491 (ADR-0060 follow-up): a ref-aliasing local's slot
            // stores a managed pointer T&; a read of the local in the body
            // must indirect through the pointer to load the pointee value.
            if variable is LocalVariableSymbol refLocal && refLocal.RefKind != RefKind.None {
                this.EmitLoadIndirect(refLocal.Type)
            }
            return
        }
        // Issue #191: top-level globals were emitted as static fields on
        // <Program>; load via ldsfld so cross-method access (and reads
        // from other assemblies) share storage.
        if variable is GlobalVariableSymbol gv &&
            this
            .outer
            .cache
            .GlobalFieldDefs
            .TryGetValue(gv, out var fieldHandle) {
            this.il.OpCode(ILOpCode.Ldsfld)
            this.il.Token(fieldHandle)
            return
        }
        // Issue #503 follow-up (nested-closure transitive capture): the
        // current method is a closure's Invoke (or issue #2727's async
        // MoveNext for that Invoke) and `variable` is one of the enclosing
        // closure's captured outer locals.
        if this.TryLoadFromEnclosingClosure(variable) {
            return
        }
        throw InvalidOperationException(
            "Variable '${variable.Name}' has no local slot or parameter index in the current method."
        )
    }

    private func TryLoadFromEnclosingClosure(variable VariableSymbol) bool {
        let enclosingClosure = this.enclosingClosure
        if enclosingClosure == nil || !enclosingClosure.CaptureFields.TryGetValue(variable, out var capField) {
            return false
        }
        this.il.OpCode(ILOpCode.Ldarg_0)
        // In MoveNext, arg0 is the state machine. Follow its hoisted `this`
        // field to the closure before loading the captured value.
        if this.asyncFieldMap?.ThisField is FieldSymbol thisField {
            this.il.OpCode(ILOpCode.Ldfld)
            this.il.Token(this.ResolveCurrentStateMachineFieldToken(thisField))
        }
        this.il.OpCode(ILOpCode.Ldfld)
        this.il.Token(this.outer.userTokens.ResolveFieldToken(enclosingClosure.ConstructedClassSym, capField))
        return true
    }

    private func TryStoreToEnclosingClosure(variable VariableSymbol) bool {
        // The store value is already on the stack; we need to push the
        // closure receiver UNDER it. Use a temp local of the value type
        // to swap stack order without spawning a scratch local field.
        if this.enclosingClosure == nil ||
            !this
            .enclosingClosure
            .CaptureFields
            .TryGetValue(variable, out var capField) ||
            !this
            .outer
            .cache
            .StructFieldDefs
            .TryGetValue(capField, out var capFieldHandle) {
            return false
        }
        return false
    }

    private func HasStorageSlot(variable VariableSymbol) bool {
        if variable is ParameterSymbol ps && this.parameters.ContainsKey(ps) {
            return true
        }
        if this.locals.ContainsKey(variable) {
            return true
        }
        if variable is GlobalVariableSymbol{IsConst: false} gv && this.outer.cache.GlobalFieldDefs.ContainsKey(gv) {
            return true
        }
        // Issue #503 follow-up: an enclosing closure's display-class
        // field counts as storage for the captured variable when this
        // method is the closure's Invoke.
        if this.enclosingClosure != nil && this.enclosingClosure.CaptureFields.ContainsKey(variable) {
            return true
        }
        return false
    }

    private func EmitStoreVariable(variable VariableSymbol) {
        if (this.asyncFieldMap != nil && this.asyncFieldMap.TryGetHoistedField(variable, out var hoistedField)) ||
            (this.iteratorEmitCtx != nil && this.iteratorEmitCtx.FieldMap.TryGetValue(variable, out hoistedField)) {
            // stfld needs the receiver below the value; the planned fallback
            // local provides the stack reorder without changing value identity.
            let valueSlot = this.locals[variable]
            this.il.StoreLocal(valueSlot)
            this.il.OpCode(ILOpCode.Ldarg_0)
            this.il.LoadLocal(valueSlot)
            this.il.OpCode(ILOpCode.Stfld)
            this.il.Token(this.ResolveCurrentStateMachineFieldToken(hoistedField!!))
            return
        }
        if variable is ParameterSymbol ps && this.parameters.TryGetValue(ps, out var argIndex) {
            this.il.StoreArgument(argIndex)
            return
        }
        if this.locals.TryGetValue(variable, out var slot) {
            this.il.StoreLocal(slot)
            return
        }
        // Issue #191: top-level globals store via stsfld into their backing
        // <Program> static field (initialized in declaration order from
        // the entry-point method body).
        if variable is GlobalVariableSymbol gv &&
            (!gv.IsConst || this.outer.emitCtx.CurrentStaticConstructorOwner is PackageSymbol) &&
            this
            .outer
            .cache
            .GlobalFieldDefs
            .TryGetValue(gv, out var fieldHandle) {
            this.il.OpCode(ILOpCode.Stsfld)
            this.il.Token(fieldHandle)
            return
        }
        throw InvalidOperationException(
            "Variable '${variable.Name}' has no local slot or parameter index in the current method."
        )
    }

    private func EmitLoadElement(elementType TypeSymbol) {
        // Issue #520: prefer the typed short-form ldelem opcodes for
        // every CIL primitive. `ldelem <token>` for small ints leaves a
        // sub-int32 value on the eval stack and ilverify rejects it
        // ([StackUnexpected]: found Short/Byte). The short forms widen
        // to int32 as ECMA-335 requires for arithmetic continuation.
        if elementType == TypeSymbol.Int32 {
            this.il.OpCode(ILOpCode.Ldelem_i4)
        } else if elementType == TypeSymbol.UInt32 {
            this.il.OpCode(ILOpCode.Ldelem_u4)
        } else if elementType == TypeSymbol.Int64 || elementType == TypeSymbol.UInt64 {
            this.il.OpCode(ILOpCode.Ldelem_i8)
        } else if elementType == TypeSymbol.Int16 {
            this.il.OpCode(ILOpCode.Ldelem_i2)
        } else if elementType == TypeSymbol.UInt16 || elementType == TypeSymbol.Char {
            this.il.OpCode(ILOpCode.Ldelem_u2)
        } else if elementType == TypeSymbol.Int8 {
            this.il.OpCode(ILOpCode.Ldelem_i1)
        } else if elementType == TypeSymbol.UInt8 || elementType == TypeSymbol.Bool {
            this.il.OpCode(ILOpCode.Ldelem_u1)
        } else if elementType == TypeSymbol.Float32 {
            this.il.OpCode(ILOpCode.Ldelem_r4)
        } else if elementType == TypeSymbol.Float64 {
            this.il.OpCode(ILOpCode.Ldelem_r8)
        } else if elementType == TypeSymbol.NInt || elementType == TypeSymbol.NUInt {
            this.il.OpCode(ILOpCode.Ldelem_i)
        } else if elementType == TypeSymbol.String || IsReferenceTypeElement(elementType) {
            // Reference-type element (string or any other class/interface):
            // ldelem.ref is the only correct form.
            this.il.OpCode(ILOpCode.Ldelem_ref)
        } else {
            // Arbitrary value type — enums (whose underlying type the JIT
            // honors), structs, etc. `ldelem <token>` works for these
            // because the verifier matches the static element type.
            this.il.OpCode(ILOpCode.Ldelem)
            this.il.Token(this.outer.memberRefs.GetExactTypeToken(elementType))
        }
    }

    private func EmitStoreElement(elementType TypeSymbol) {
        // Issue #520: mirror EmitLoadElement — use the typed short-form
        // stelem opcodes for every CIL primitive so the stack truncation
        // rules match what the verifier expects.
        if elementType == TypeSymbol.Int32 || elementType == TypeSymbol.UInt32 {
            this.il.OpCode(ILOpCode.Stelem_i4)
        } else if elementType == TypeSymbol.Int64 || elementType == TypeSymbol.UInt64 {
            this.il.OpCode(ILOpCode.Stelem_i8)
        } else if elementType == TypeSymbol.Int16 ||
            elementType == TypeSymbol.UInt16 ||
            elementType == TypeSymbol.Char {
            this.il.OpCode(ILOpCode.Stelem_i2)
        } else if elementType == TypeSymbol.Int8 || elementType == TypeSymbol.UInt8 || elementType == TypeSymbol.Bool {
            this.il.OpCode(ILOpCode.Stelem_i1)
        } else if elementType == TypeSymbol.Float32 {
            this.il.OpCode(ILOpCode.Stelem_r4)
        } else if elementType == TypeSymbol.Float64 {
            this.il.OpCode(ILOpCode.Stelem_r8)
        } else if elementType == TypeSymbol.NInt || elementType == TypeSymbol.NUInt {
            this.il.OpCode(ILOpCode.Stelem_i)
        } else if elementType == TypeSymbol.String || IsReferenceTypeElement(elementType) {
            this.il.OpCode(ILOpCode.Stelem_ref)
        } else {
            this.il.OpCode(ILOpCode.Stelem)
            this.il.Token(this.outer.memberRefs.GetExactTypeToken(elementType))
        }
    }

    private func EmitMapIndexRead(idx BoundIndexExpression) {
        // Phase 3.A.4 emit: `m[k]` lowers to `Dictionary<K,V>::TryGetValue(K, out V)`
        // — we then pop the returned bool and load the out value. TryGetValue
        // zero-initialises the out parameter when the key is missing, matching
        // the interpreter's Go zero-value semantics rather than throwing as
        // `get_Item` would.
        let mapType = cast[MapTypeSymbol](idx.Target.Type)
        let dictType Type? = mapType.ClrType
        // Issue #3301: a map keyed or valued by a same-compilation user
        // struct has no erased CLR Dictionary<,> to reflect on
        // (MapTypeSymbol.ClrType is null until after emission — the #409
        // symbol-only value types), so the reflection lookup below would
        // NRE. Route the call through the reified TypeSpec-parented
        // MemberRef instead, mirroring the #1481 symbolic map-literal path.
        //
        // Issue #4015: the closed `Dictionary<K, V>` can also EXIST and still
        // refuse to answer. `MapTypeSymbol.MakeClrType` builds it with
        // `typeof(Dictionary<,>).MakeGenericType(…)`, which hands back a
        // `TypeBuilderInstantiation` whenever a type argument is not itself a
        // host `RuntimeType` — true of every CLR type resolved through the
        // reference load context, so `map[string, DateTime]` as much as
        // `map[string, ImportedBase]`. Its `GetMethod` throws
        // `NotSupportedException`, which surfaced as the internal-error GS9998.
        // The symbolic MemberRef is the right answer in that case too.
        var tryGetRef MemberReferenceHandle
        if dictType == nil {
            tryGetRef = this.outer.memberRefs.GetMapTryGetValueReference(mapType)
        } else {
            // Issue #4023: take the overload's parameter types from the
            // dictionary's OWN generic arguments rather than from the map
            // symbol's key/value ClrTypes. Now that a map over an imported
            // key or value carries a context-correct closed
            // `Dictionary<K, V>` (MapTypeSymbol.TryMakeClrTypeInReferenceContext),
            // the two can disagree about reflection context — a
            // MetadataLoadContext `Dictionary<string, ImportedBase>` asked for
            // an overload described by the HOST `typeof(string)` answers
            // `ArgumentException: Type must be a type provided by the
            // MetadataLoadContext`, which surfaced as GS9998 on a plain
            // `m[k]`. The carrier's own arguments are in the carrier's context
            // by construction. The catch keeps both cross-context shapes on
            // the symbolic MemberRef rather than crashing.
            var tryGet MethodInfo?
            try {
                let dictionaryArguments = if dictType.IsGenericType && !dictType.IsGenericTypeDefinition {
                    dictType.GetGenericArguments()
                } else {
                    default([]?Type)
                }
                let keyParameter = if dictionaryArguments != nil && dictionaryArguments.Length == 2 {
                    dictionaryArguments[0]
                } else {
                    Invariant.Required(
                        NullableLifting.GetEffectiveClrType(mapType.KeyType),
                        "a map key has a CLR representation",
                        expression: "NullableLifting.GetEffectiveClrType(mapType.KeyType)"
                    )
                }
                let valueParameter = if dictionaryArguments != nil && dictionaryArguments.Length == 2 {
                    dictionaryArguments[1]
                } else {
                    Invariant.Required(
                        NullableLifting.GetEffectiveClrType(mapType.ValueType),
                        "a map value has a CLR representation",
                        expression: "NullableLifting.GetEffectiveClrType(mapType.ValueType)"
                    )
                }
                tryGet = dictType.GetMethod("TryGetValue", []Type{keyParameter, valueParameter.MakeByRefType()})
            } catch (e Exception) when e is NotSupportedException || e is ArgumentException {
                tryGet = nil
            }
            tryGetRef = if tryGet == nil {
                this.outer.memberRefs.GetMapTryGetValueReference(mapType)
            } else {
                this.outer.memberRefs.GetMethodReference(tryGet)
            }
        }
        let slot = this.mapIndexSlots[idx]
        this.EmitExpression(idx.Target)
        this.EmitExpression(idx.Index)
        this.il.LoadLocalAddress(slot)
        this.il.OpCode(ILOpCode.Callvirt)
        this.il.Token(tryGetRef)
        // Issue #1714: TryGetValue zero-initialises the out V parameter via the
        // CLR default when the key is missing — for V == string that CLR
        // default is `null`, but G# gives `string` Go-style value semantics
        // where the zero value is `""` (matching the interpreter's
        // Evaluator.DefaultValue). Branch on the returned `found` bool (still
        // on the stack) so a miss yields `""` instead of the CLR-default
        // `null`, while every other V keeps the CLR-default fast path.
        if mapType.ValueType == TypeSymbol.String {
            let found = this.il.DefineLabel()
            let end = this.il.DefineLabel()
            this.il.Branch(ILOpCode.Brtrue, found)
            this.il.LoadString(this.outer.emitCtx.Metadata.GetOrAddUserString(string.Empty))
            this.il.Branch(ILOpCode.Br, end)
            this.il.MarkLabel(found)
            this.il.LoadLocal(slot)
            this.il.MarkLabel(end)
            return
        }
        this.il.OpCode(ILOpCode.Pop)
        this.il.LoadLocal(slot)
    }

    private func EmitMapIndexAssignment(ixa BoundIndexAssignmentExpression) {
        // Phase 3.A.4 emit: `m[k] = v` lowers to `Dictionary<K,V>::set_Item(K, V)`.
        // Issue #418 (P1-1): spill v to a temp before the callvirt so the
        // expression's result (the assigned value) does not require a
        // re-evaluation of k or a get_Item re-read. set_Item is void, so we
        // dup the value just before the call, save the dup to a scratch
        // local, then push it back as the expression result.
        let targetType = ixa.TargetExpression?.Type ?? BoundNodeForm.VariableTarget(ixa).Type
        let mapType = cast[MapTypeSymbol](targetType)
        let dictType Type? = mapType.ClrType
        // Issue #3301: same-compilation user-struct key/value — no erased
        // CLR Dictionary<,> to reflect on; use the #1481 symbolic MemberRef.
        // Issue #4015: and the same when the closed type EXISTS but is a
        // `TypeBuilderInstantiation` that refuses to resolve members — see
        // `EmitMapIndexRead`.
        var setItem MethodInfo? = nil
        if dictType != nil {
            try {
                setItem = dictType.GetMethod("set_Item")
            } catch (NotSupportedException) {
                // `setItem` stays null: fall through to the symbolic MemberRef.

            }
        }
        let setItemRef = if setItem == nil {
            this.outer.memberRefs.GetMapSetItemReference(mapType)
        } else {
            this.outer.memberRefs.GetMethodReference(setItem)
        }
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
        this.il.OpCode(ILOpCode.Callvirt)
        this.il.Token(setItemRef)
        this.il.LoadLocal(tmp)
    }

    private func EmitFieldAccess(fa BoundFieldAccessExpression) {
        // Issue #948: inline const-field reads from their compile-time value.
        // Decimal retains C#-style runtime metadata storage for interop, but
        // source reads still inline and never depend on initialization order.
        if fa.Field.IsConst {
            this.EmitLiteral(BoundLiteralExpression(nil, fa.Field.ConstantValue, fa.Field.Type))
            return
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
        var fieldContainer StructSymbol? = ResolveFieldReferenceContainer(
            fa.StructType as StructSymbol,
            fa.Receiver?.Type as StructSymbol,
            fa.Field
        )
        if this.enclosingClosure?.CaptureFields.ContainsValue(fa.Field) == true {
            fieldContainer = this.enclosingClosure!!.ConstructedClassSym
        }
        var fieldHandle EntityHandle
        if fa.InterfaceType != nil {
            // ADR-0089 / issue #1030: interface static field read. A generic
            // interface routes through a TypeSpec-parented MemberRef (per
            // construction); a non-generic interface uses the bare FieldDef.
            fieldHandle = this.outer.userTokens.ResolveInterfaceFieldToken(fa.InterfaceType, fa.Field)
        } else if fieldContainer != nil {
            fieldHandle = this.outer.userTokens.ResolveFieldToken(fieldContainer, fa.Field)
        } else if fa.Receiver?.Type is StructSymbol receiverStruct {
            fieldHandle = this.outer.userTokens.ResolveFieldToken(receiverStruct, fa.Field)
        } else if this.outer.cache.StructFieldDefs.TryGetValue(fa.Field, out var defHandle) {
            fieldHandle = defHandle
        } else {
            throw InvalidOperationException("Struct field '${fa.Field.Name}' has no emitted FieldDef.")
        }
        // ADR-0053: static field access — no receiver, use ldsfld.
        if fa.Receiver == nil {
            this.il.OpCode(ILOpCode.Ldsfld)
            this.il.Token(fieldHandle)
            this.EmitNarrowingCastIfNeeded(GetEffectiveFieldType(fa), fa.NarrowedType)
            return
        }
        // Issue #1235: a field read on a receiver whose static type is a type
        // parameter constrained to a class (`t.F` with `t : T`, `T : Base`).
        // A reference-type-constrained `!!T` value is boxed (a no-op at runtime
        // that yields the object reference typed as the constraint) so the
        // verifier accepts the subsequent `ldfld` against the constraint class —
        // the same shape the C# compiler emits for `t.field`.
        if fa.Receiver!!.Type is TypeParameterSymbol fieldReceiverTp {
            this.EmitExpression(fa.Receiver!!)
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(fieldReceiverTp))
            this.il.OpCode(ILOpCode.Ldfld)
            this.il.Token(fieldHandle)
            this.EmitNarrowingCastIfNeeded(GetEffectiveFieldType(fa), fa.NarrowedType)
            return
        }
        // Class receivers are references: load the value (the ref) and ldfld.
        // For struct receivers, load by address when the receiver is a
        // simple variable (avoids a copy and is verifier-friendly); fall
        // back to value form otherwise (CLI permits ldfld on a value-type
        // value on stack).
        let receiverIsClass = fa.Receiver!!.Type is StructSymbol rs && rs.IsClass
        if !receiverIsClass && fa.Receiver is BoundDereferenceExpression deref && TypeSymbol.IsUnmanagedPointer(
            deref.Operand.Type
        ) {
            // ADR-0122 §4 / issue #1034: `(*p).field` / `p->field` read. The
            // pointer value IS the struct's address, so load the pointer and
            // `ldfld` directly — avoiding a wasteful `ldobj` of the whole struct.
            this.EmitInstanceReceiver(deref.Operand)
        } else if !receiverIsClass && fa.Receiver is BoundVariableExpression bv && this.TryLoadStructVariableAddress(
            bv
        ) {
            // address is on the stack

        } else if !this.TryEmitCachedReceiver(fa.Receiver!!, needAddress: false) {
            // Issue #1688: TryEmitCachedReceiver returns false when this
            // receiver isn't the shared receiver of a compound assignment
            // (no planned slot) — fall back to a plain evaluation.
            this.EmitExpression(fa.Receiver!!)
        }
        this.il.OpCode(ILOpCode.Ldfld)
        this.il.Token(fieldHandle)
        this.EmitNarrowingCastIfNeeded(GetEffectiveFieldType(fa), fa.NarrowedType)
    }

    private func EmitFieldAssignment(fas BoundFieldAssignmentExpression) {
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
            fas.Receiver == nil || !ValueExpressionMutatesReceiver(fas.Value, fas.Receiver),
            "EmitFieldAssignment precondition violated: BoundFieldAssignmentExpression value must not reassign the receiver variable for field '${fas.Field.Name}' — see issue #420 / P3-4."
        )
        // ADR-0087 §3 R3 + issue #1254/#1467: route via a TypeSpec-parented
        // MemberRef when the field is on a generic type — constructed receiver,
        // or an inherited field on a generic base reached through a derived
        // receiver (use the constructed base, never the open `<!0>`).
        var fieldContainer StructSymbol? = ResolveFieldReferenceContainer(
            fas.StructType as StructSymbol,
            fas.Receiver?.Type as StructSymbol,
            fas.Field
        )
        if this.enclosingClosure?.CaptureFields.ContainsValue(fas.Field) == true {
            fieldContainer = this.enclosingClosure!!.ConstructedClassSym
        }
        var fieldHandle EntityHandle
        if fas.InterfaceType != nil {
            // ADR-0089 / issue #1030: interface static field write — generic
            // interface via TypeSpec MemberRef, non-generic via bare FieldDef.
            fieldHandle = this.outer.userTokens.ResolveInterfaceFieldToken(fas.InterfaceType, fas.Field)
        } else if fieldContainer != nil {
            fieldHandle = this.outer.userTokens.ResolveFieldToken(fieldContainer, fas.Field)
        } else if fas.Receiver?.Type is StructSymbol receiverStruct {
            fieldHandle = this.outer.userTokens.ResolveFieldToken(receiverStruct, fas.Field)
        } else if this.outer.cache.StructFieldDefs.TryGetValue(fas.Field, out var defHandle) {
            fieldHandle = defHandle
        } else {
            throw InvalidOperationException("Struct field '${fas.Field.Name}' has no emitted FieldDef.")
        }
        // ADR-0053: static field assignment — no receiver, use stsfld/ldsfld.
        if fas.Receiver == nil && fas.ReceiverExpression == nil {
            this.EmitExpression(fas.Value)
            this.il.OpCode(ILOpCode.Stsfld)
            this.il.Token(fieldHandle)
            // Leave the assigned value on the stack as the expression result.
            this.il.OpCode(ILOpCode.Ldsfld)
            this.il.Token(fieldHandle)
            return
        }
        // Issue #567: expression-based receiver (closure boxing lowered
        // `variable.Field = value` to `boxLocal.Value.Field = value`).
        // The receiver is an arbitrary BoundExpression that produces the
        // instance reference on the stack.
        if fas.ReceiverExpression != nil {
            // ADR-0122 §4 / issue #1034: `(*p).field = v` / `p->field = v`. When
            // the receiver is a dereference of an unmanaged pointer to a value
            // struct, the pointer value IS the struct's address, so store the
            // field through that address (`<p>; <v>; stfld`). Emitting the
            // dereference itself (`ldobj`) would push a transient struct *copy*,
            // and `stfld` against a value on the stack would be invalid / lose
            // the write. The field is re-read through the address afterwards to
            // leave the assigned value as the expression result.
            let addressReceiver BoundExpression? = if fas.ReceiverExpression is BoundDereferenceExpression drefRecv &&
                !BoundNodeForm
                .DeclaringType(fas).IsClass && TypeSymbol.IsUnmanagedPointer(drefRecv.Operand.Type) {
                drefRecv.Operand
            } else {
                default(BoundExpression?)
            }
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
            if !this.receiverSpillSlots.TryGetValue(fas, out var valueSlot) {
                throw InvalidOperationException(
                    "No slot populated for ${fas.Kind} on field '${fas.Field.Name}' — " +
                        "walker pre-pass missed this child? " +
                        "Check AssignmentValueSpillCollector and its ancestor walker."
                )
            }
            // Issue #2818: stfld needs an object reference for a class
            // receiver, but a managed pointer for a value-type receiver.
            // EmitInstanceReceiver preserves both shapes and routes nested
            // addressable field chains through the shared-receiver cache.
            this.EmitInstanceReceiver((addressReceiver ?? fas.ReceiverExpression)!!)
            // Issue #1235 (object-initializer follow-up): a `T{Field: value}`
            // literal on a class-constrained type parameter lowers to an
            // expression-receiver field write against the freshly constructed
            // `!!T` value — box it (a runtime no-op for a reference-type
            // instantiation) so the subsequent `stfld` is verifiable, mirroring
            // the read/variable-receiver-write paths.
            if addressReceiver == nil && fas.ReceiverExpression!!.Type is TypeParameterSymbol fieldExprAssnTp {
                this.il.OpCode(ILOpCode.Box)
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(fieldExprAssnTp))
            }
            this.EmitExpression(fas.Value)
            this.il.OpCode(ILOpCode.Dup)
            this.il.StoreLocal(valueSlot)
            this.il.OpCode(ILOpCode.Stfld)
            this.il.Token(fieldHandle)
            // Expression result: the value we just stored — no second
            // receiver evaluation, no second field read.
            this.il.LoadLocal(valueSlot)
            return
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
        // Every static form returned above, so the receiver is present from
        // here down -- which is exactly what the comment already states.
        let fieldReceiver = Invariant.Required(
            fas.Receiver,
            "the static and expression-receiver field-write forms all returned above, leaving only the variable-receiver form",
            expression: "fas.Receiver"
        )
        Debug.Assert(
            !ValueExpressionMutatesReceiver(fas.Value, fieldReceiver),
            "EmitFieldAssignment: value expression for field '${fas.Field.Name}' must not reassign the receiver variable '${fieldReceiver.Name}'."
        )
        // Issue #1235 (write side): a field write on a receiver whose static
        // type is a type parameter constrained to a class (`t.F = v` with
        // `t : T`, `T : Base`). Mirrors EmitFieldAccess's read-side
        // `box !!T; ldfld` with `box !!T; stfld`.
        if fieldReceiver.Type is TypeParameterSymbol fieldAssnTp {
            this.EmitLoadVariable(fieldReceiver)
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(fieldAssnTp))
            this.EmitExpression(fas.Value)
            this.il.OpCode(ILOpCode.Stfld)
            this.il.Token(fieldHandle)
            this.EmitLoadVariable(fieldReceiver)
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(fieldAssnTp))
            this.il.OpCode(ILOpCode.Ldfld)
            this.il.Token(fieldHandle)
            return
        }
        // Class field assignment: load the reference, evaluate the value,
        // stfld through the reference. Re-load the receiver + ldfld to
        // leave the new value on the stack as the expression result.
        if BoundNodeForm.DeclaringType(fas).IsClass {
            this.EmitLoadVariable(fieldReceiver)
            this.EmitExpression(fas.Value)
            this.il.OpCode(ILOpCode.Stfld)
            this.il.Token(fieldHandle)
            this.EmitLoadVariable(fieldReceiver)
            this.il.OpCode(ILOpCode.Ldfld)
            this.il.Token(fieldHandle)
            return
        }
        // Issue #1988 (follow-up to #1917/#1982): the four `TryLoadVariableAddress(fieldReceiver)`
        // calls below (not `TryLoadStructVariableAddress`) are intentional, not
        // an unmigrated oversight. `fieldReceiver` is a bare `VariableSymbol`,
        // which — unlike `BoundVariableExpression` — carries no `NarrowedType`.
        // The binder (`BindFieldAssignmentExpression`) dispatches to this
        // struct-field-write branch using the receiver's raw DECLARED type
        // (`variable.Type is StructSymbol`), never a smart-cast-narrowed type,
        // so a narrowed struct local (e.g. `object oa` narrowed by `oa is
        // Money`) can never reach here as a struct receiver: `oa.Cents = v`
        // instead resolves `oa`'s declared `object` type and fails to find
        // member `Cents` (GS0158) before emission — see
        // Issue1988NarrowedStructFieldAssignmentBinderTests. `fieldReceiver` is
        // therefore always the variable's own struct-typed storage, so the
        // direct `ldarga`/`ldloca` path is correct and the unbox helper does
        // not apply.
        //
        // Optimized path: storing default(T) into a value-type field uses
        // ldflda + initobj instead of pushing a value + stfld. This avoids
        // the invalid ldnull;stfld<ValueType> pattern and removes the need
        // for a temp local.
        if fas.Value is BoundDefaultExpression defaultExpr && ReflectionMetadataEmitter.IsValueTypeSymbol(
            defaultExpr.Type
        ) {
            // Emit: receiver-address; ldflda field; initobj T
            if !this.TryLoadVariableAddress(fieldReceiver) {
                throw InvalidOperationException(
                    "Cannot take the address of variable '${fieldReceiver.Name}' for field assignment."
                )
            }
            this.il.OpCode(ILOpCode.Ldflda)
            this.il.Token(fieldHandle)
            this.il.OpCode(ILOpCode.Initobj)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(defaultExpr.Type))
            // Leave the assigned value on the stack as the expression result.
            if !this.TryLoadVariableAddress(fieldReceiver) {
                throw InvalidOperationException(
                    "Cannot take the address of variable '${fieldReceiver.Name}' for field assignment."
                )
            }
            this.il.OpCode(ILOpCode.Ldfld)
            this.il.Token(fieldHandle)
            return
        }
        // Binder guarantees the receiver is a simple variable for Phase 3.B.1.
        if !this.TryLoadVariableAddress(fieldReceiver) {
            throw InvalidOperationException(
                "Cannot take the address of variable '${fieldReceiver.Name}' for field assignment."
            )
        }
        this.EmitExpression(fas.Value)
        this.il.OpCode(ILOpCode.Stfld)
        this.il.Token(fieldHandle)
        // Leave the assigned value on the stack as the expression result.
        if !this.TryLoadVariableAddress(fieldReceiver) {
            throw InvalidOperationException(
                "Cannot take the address of variable '${fieldReceiver.Name}' for field assignment."
            )
        }
        this.il.OpCode(ILOpCode.Ldfld)
        this.il.Token(fieldHandle)
    }

    // ADR-0051 Phase 6: emit IL for BoundPropertyAccessExpression (computed properties).
    // Auto-properties are lowered to BoundFieldAccessExpression by the Lowerer,
    // so this only fires for computed properties that still reference the accessor.
    /// @param access The property read to emit.
    /// @param addressOnly Issue #4224: when `true`, leaves the getter's raw
    /// result on the stack without the read tail's dereference/narrowing-cast
    /// — used by `EmitAddressOf` to take the address of a ref-returning
    /// property instead of loading through it.
    private func EmitPropertyAccess(access BoundPropertyAccessExpression, addressOnly bool = false) {
        // Issue #989: when the receiver is a constructed generic user type the
        // accessor must be reached through a MemberRef parented at the
        // constructed TypeSpec so a property whose type mentions the class type
        // parameter is read with the substitution applied. The non-generic case
        // keeps using the plain accessor MethodDef.
        var getterHandle EntityHandle
        if access.InterfaceType != nil {
            getterHandle = this
                .outer
                .userTokens
                .ResolveUserPropertyAccessorToken(access.InterfaceType, access.Property, wantSetter: false)
        } else {
            let getterContainer StructSymbol? = ResolvePropertyReferenceContainer(
                access.StructType as StructSymbol,
                access.Receiver?.Type as StructSymbol,
                access.Property
            )
            if getterContainer != nil {
                getterHandle = this
                    .outer
                    .userTokens
                    .ResolveUserPropertyAccessorToken(getterContainer, access.Property, wantSetter: false)
            } else if this
                .outer
                .cache
                .PropertyAccessorHandles
                .TryGetValue(access.Property, out var handles) &&
                (handles.Getter != nil) {
                getterHandle = handles.Getter!!
            } else if access.StructType is {ClrType: not nil} importedGetterContainer {
                // Issue #2291: a property on an IMPORTED type (e.g. a C# record's
                // auto-property) has no planned PropertyAccessorHandles entry —
                // resolve its getter MethodRef directly off the imported CLR type.
                getterHandle = this
                    .outer
                    .userTokens
                    .ResolveUserPropertyAccessorToken(importedGetterContainer, access.Property, wantSetter: false)
            } else {
                throw InvalidOperationException("Property '${access.Property.Name}' has no emitted getter MethodDef.")
            }
        }
        // Issue #263: static property access — no receiver to load.
        if access.Receiver == nil {
            this.il.OpCode(ILOpCode.Call)
            this.il.Token(getterHandle)
            this.EmitPropertyReadTail(access, addressOnly)
            return
        }
        // Issue #1235: constrained dispatch handles both reference- and
        // value-type substitutions without boxing a value-type receiver.
        if access.Receiver!!.Type is TypeParameterSymbol tpReceiver {
            this.EmitConstrainedTypeParameterReceiver(access.Receiver!!)
            this.il.OpCode(ILOpCode.Constrained)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(tpReceiver))
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(getterHandle)
            this.EmitPropertyReadTail(access, addressOnly)
            return
        }
        // Load receiver. Issue #418 (P1-5): route through
        // EmitInstanceReceiver so non-variable struct receivers
        // (method-call results, indexer reads, tuple elements, etc.) are
        // spilled to a temp and addressed via `ldloca` rather than left as
        // a value on the stack (unverifiable / SIGSEGV).
        // Issue #4312: the opcode follows the same predicate that decides how the
        // receiver was just loaded (see InstanceAccessorOpCode).
        this.EmitInstanceReceiver(access.Receiver!!)
        this.il.OpCode(InstanceAccessorOpCode(access.Receiver!!))
        this.il.Token(getterHandle)
        this.EmitPropertyReadTail(access, addressOnly)
    }

    // Issue #3879 / ADR-0069: the tail of every property READ, in the one order
    // the two adjustments can happen in — dereference the getter's managed
    // pointer FIRST (a `ref`-returning property leaves `T&` on the stack), then
    // apply any smart-cast narrowing to the resulting value.
    private func EmitPropertyReadTail(access BoundPropertyAccessExpression, addressOnly bool = false) {
        if addressOnly {
            // Issue #4224: EmitAddressOf wants the raw managed pointer the
            // getter left on the stack, not the dereferenced/narrowed value.
            return
        }
        let effectiveType = GetEffectivePropertyType(access)
        this.EmitRefReturnDereferenceIfNeeded(access.Property.ReturnRefKind, effectiveType)
        this.EmitNarrowingCastIfNeeded(effectiveType, access.NarrowedType)
    }

    // ADR-0051 Phase 6: emit IL for BoundPropertyAssignmentExpression (computed properties).
    private func EmitPropertyAssignment(assn BoundPropertyAssignmentExpression) {
        // Issue #989: route generic constructed receivers through the
        // TypeSpec-parented MemberRef (mirrors EmitPropertyAccess).
        var setterHandle EntityHandle
        if assn.InterfaceType != nil {
            setterHandle = this
                .outer
                .userTokens
                .ResolveUserPropertyAccessorToken(assn.InterfaceType, assn.Property, wantSetter: true)
        } else {
            let setterContainer StructSymbol? = ResolvePropertyReferenceContainer(
                assn.StructType as StructSymbol,
                assn.Receiver?.Type as StructSymbol,
                assn.Property
            )
            if setterContainer != nil {
                setterHandle = this
                    .outer
                    .userTokens
                    .ResolveUserPropertyAccessorToken(setterContainer, assn.Property, wantSetter: true)
            } else if this
                .outer
                .cache
                .PropertyAccessorHandles
                .TryGetValue(assn.Property, out var handles) &&
                (handles.Setter != nil) {
                setterHandle = handles.Setter!!
            } else if assn.StructType is StructSymbol structType && structType.ClrType != nil {
                // Issue #2291: mirrors the getter fallback above for IMPORTED
                // properties with no planned PropertyAccessorHandles entry.
                setterHandle = this
                    .outer
                    .userTokens
                    .ResolveUserPropertyAccessorToken(structType, assn.Property, wantSetter: true)
            } else {
                throw InvalidOperationException("Property '${assn.Property.Name}' has no emitted setter MethodDef.")
            }
        }
        // Issue #418 (P1-2): spill the assigned value to a temp so the
        // expression result (`dup; stloc tmp; ... ; ldloc tmp`) does not
        // require a second getter call — which would also re-evaluate any
        // side-effecting receiver. Static and instance paths share the
        // same dup/stloc/ldloc pattern.
        if !this.receiverSpillSlots.TryGetValue(assn, out var valueSlot) {
            throw InvalidOperationException(
                "No slot populated for ${assn.Kind} on property '${assn.Property.Name}' — " +
                    "walker pre-pass missed this child? " +
                    "Check AssignmentValueSpillCollector and its ancestor walker."
            )
        }
        // Issue #263: static property assignment — no receiver.
        if assn.Receiver == nil {
            this.EmitExpression(assn.Value)
            this.il.OpCode(ILOpCode.Dup)
            this.il.StoreLocal(valueSlot)
            this.il.OpCode(ILOpCode.Call)
            this.il.Token(setterHandle)
            this.il.LoadLocal(valueSlot)
            return
        }
        // Issue #1235 (write side): constrained dispatch preserves writes when
        // T is a value type and avoids boxing when T is a reference type.
        if assn.Receiver!!.Type is TypeParameterSymbol tpAssnReceiver {
            this.EmitConstrainedTypeParameterReceiver(assn.Receiver!!)
            this.EmitExpression(assn.Value)
            this.il.OpCode(ILOpCode.Dup)
            this.il.StoreLocal(valueSlot)
            this.il.OpCode(ILOpCode.Constrained)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(tpAssnReceiver))
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(setterHandle)
            this.il.LoadLocal(valueSlot)
            return
        }
        // Load receiver, emit value, call setter. Issue #418 (P1-5):
        // route through EmitInstanceReceiver so non-variable struct
        // receivers spill to a temp and pass `ldloca` as `this` instead
        // of leaving a value on the stack.
        // Issue #4312: see InstanceAccessorOpCode.
        this.EmitInstanceReceiver(assn.Receiver!!)
        this.EmitExpression(assn.Value)
        this.il.OpCode(ILOpCode.Dup)
        this.il.StoreLocal(valueSlot)
        this.il.OpCode(InstanceAccessorOpCode(assn.Receiver!!))
        this.il.Token(setterHandle)
        // Expression result: the value we just stored — no second receiver
        // evaluation, no getter call.
        this.il.LoadLocal(valueSlot)
    }

    private func EmitClrPropertyAccess(access BoundClrPropertyAccessExpression) {
        if access.IsConstrainedTypeParameterAccess {
            if access.Member is not PropertyInfo constrainedProperty {
                throw NotSupportedException("Imported interface constraints cannot expose instance fields.")
            }
            let constrainedGetter = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(
                constrainedProperty,
                wantSetter: false
            ) ??
                throw InvalidOperationException(
                "Property '${constrainedProperty.DeclaringType?.FullName}.${constrainedProperty.Name}' has no public getter."
            )
            this.EmitConstrainedTypeParameterReceiver(
                Invariant.Required(
                    access.Receiver,
                    "a constrained property access has a receiver",
                    expression: "access.Receiver"
                )
            )
            this.il.OpCode(ILOpCode.Constrained)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(access.ConstrainedReceiverTypeParameter!!))
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(
                this.outer.memberRefs.GetMethodEntityHandle(constrainedGetter, access.ConstrainedInterfaceType)
            )
            return
        }
        // Phase 4 / Stream B: property or field read on a CLR receiver.
        // Properties dispatch to their `get_X` accessor (callvirt for
        // reference types, call for value types); fields use `ldfld`.
        // When `Receiver` is null the access is static: emit `ldsfld` /
        // `call get_X` with no receiver instead.
        let receiver BoundExpression? = access.Receiver
        let isStatic = receiver == nil
        if receiver != nil {
            let isReadOnlyAccess = access.Member is FieldInfo ||
                (
                access.Member is PropertyInfo{GetMethod: {} readGetter} && RefCapabilities.IsReadOnlyMethod(readGetter)
            )
            this.EmitInstanceReceiver(receiver, isReadOnlyCall: isReadOnlyAccess)
        }
        // Issue #454: use IsValueTypeSymbol — same predicate that
        // EmitInstanceReceiver uses — so user-declared structs (ClrType
        // null until emission completes) are recognised as value-type
        // receivers and dispatched via `call` instead of `callvirt`.
        // EmitInstanceReceiver already loaded `ldloca` for them; emitting
        // `callvirt` against a value-type method with a managed-pointer
        // receiver produces invalid IL.
        let receiverIsValueType = receiver != nil && ReflectionMetadataEmitter.IsValueTypeSymbol(receiver.Type)
        switch access.Member {
            case property is PropertyInfo {
                // Issue #1582: an inherited property from a metadata base may
                // expose only a `protected` / `protected internal` getter. Try
                // the public accessor first (unchanged IL for existing samples),
                // then fall back to the non-public getter for inherited members.
                let getter = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(property, wantSetter: false) ??
                    ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(
                    property,
                    wantSetter: false,
                    nonPublic: true
                ) ??
                    throw InvalidOperationException(
                    "Property '${property.DeclaringType?.FullName}.${property.Name}' has no accessible getter."
                )
                // Issue #671: when the receiver is a symbolic constructed
                // generic (e.g. List[MyGs] with a user-defined type arg),
                // route the getter through the receiver-aware overload so
                // the MemberRef parent is the constructed type with the
                // real user-type tokens instead of the type-erased
                // List<object>. Static getters and CLR receivers fall back
                // to the plain MemberRef path inside the overload.
                // Issue #4986: `Value` / `HasValue` on a same-compilation
                // struct's or enum's `Nullable<T>` bind against the open
                // `Nullable<>` (the underlying has no ClrType while binding).
                // Its getter MemberRef must be parented at the constructed
                // `Nullable<T>` TypeSpec, as the `!!` unwrap's is.
                let symbolicNullable = receiver?.Type as NullableTypeSymbol
                let propertyOwner = property.DeclaringType
                if symbolicNullable != nil && NullableLifting.RequiresSymbolicNullableGetValue(symbolicNullable) &&
                    propertyOwner != nil &&
                    propertyOwner.IsGenericType &&
                    propertyOwner
                    .GetGenericTypeDefinition()
                    .FullName == "System.Nullable`1" &&
                    (property.Name == "Value" || property.Name == "HasValue") {
                    this.il.OpCode(ILOpCode.Call)
                    this.il.Token(
                        if property.Name == "Value" {
                            this.GetNullableValueRef(symbolicNullable)
                        } else {
                            this.GetNullableHasValueRef(symbolicNullable)
                        }
                    )
                    break
                }
                let getterRef = if isStatic {
                    (
                        if access.StaticContainerType != nil {
                            this.outer.memberRefs.GetMethodEntityHandle(getter, access.StaticContainerType)
                        } else {
                            EntityHandle(this.outer.memberRefs.GetMethodReference(getter))
                        }
                    )
                } else {
                    this
                        .outer
                        .memberRefs
                        .GetMethodEntityHandle(
                        getter,
                        Invariant.Required(
                            receiver,
                            "an instance property access has a receiver",
                            expression: "receiver"
                        )
                            .Type
                    )
                }
                this.il.OpCode(
                    if isStatic || receiverIsValueType {
                        ILOpCode.Call
                    } else {
                        ILOpCode.Callvirt
                    }
                )
                this.il.Token(getterRef)
                // Issue #1330: when the static read is parented at a symbolic
                // constructed container (`Comparer[TResult].Default`), the
                // MemberRef encodes the call against the open generic property,
                // so the runtime stack value is the substituted symbolic type
                // (`Comparer<!TResult>`), not the erased `object`. Skip widening
                // exactly as the instance symbolic-container path does below.
                if isStatic && access.StaticContainerType != nil {
                    break
                }
                // Issue #774: when the receiver is a symbolic open container,
                // the symbolic MemberRef encodes the call against the open
                // generic property — the runtime stack value is therefore the
                // substituted symbolic type, not the closed CLR `object` that
                // `getter.ReturnType` reports. Skip widening so we don't emit
                // a verifier-breaking `unbox.any T` against a value type T
                // (the stack already holds the substituted `!!0`).
                if !isStatic &&
                    this
                    .outer
                    .userTokens
                    .TryGetSymbolicSubstitutedPropertyReturn(
                    Invariant.Required(receiver, "an instance property access has a receiver", expression: "receiver")
                        .Type,
                    property,
                    out _
                ) {
                    break
                }
                this.EmitErasedObjectReturnWidening(getter.ReturnType, access.Type)
            }
            case field is FieldInfo {
                let fieldRef = if access.StaticContainerType != nil {
                    this.outer.memberRefs.GetFieldReference(field, access.StaticContainerType)
                } else {
                    this.outer.memberRefs.GetFieldReference(field)
                }
                this.il.OpCode(
                    if isStatic {
                        ILOpCode.Ldsfld
                    } else {
                        ILOpCode.Ldfld
                    }
                )
                this.il.Token(fieldRef)
            }
            default {
                throw NotSupportedException(
                    "CLR member '${access.Member.GetType().Name}' is not yet supported by the emitter."
                )
            }
        }
    }

    private func EmitClrPropertyAssignment(assn BoundClrPropertyAssignmentExpression) {
        // Stream B emit parity: property/field write on a CLR receiver.
        // Issue #418 (P1-2): the expression result is the assigned value.
        // Spill the value to a pre-allocated temp via `dup; stloc` so we
        // can produce the result with `ldloc` instead of re-evaluating the
        // receiver and calling the getter — the previous shape called any
        // side-effecting receiver expression (e.g. `Make().P = v`) twice.
        let receiver BoundExpression? = assn.Receiver
        let isStatic = receiver == nil
        if !this.receiverSpillSlots.TryGetValue(assn, out var valueSlot) {
            throw InvalidOperationException(
                "No slot populated for ${assn.Kind} on CLR property '${assn.Member.Name}' — " +
                    "walker pre-pass missed this child? " +
                    "Check AssignmentValueSpillCollector and its ancestor walker."
            )
        }
        if assn.IsConstrainedTypeParameterAccess {
            if assn.Member is not PropertyInfo constrainedProperty {
                throw NotSupportedException("Imported interface constraints cannot expose instance fields.")
            }
            let constrainedSetter = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(
                constrainedProperty,
                wantSetter: true
            ) ??
                throw InvalidOperationException(
                "Property '${constrainedProperty.DeclaringType?.FullName}.${constrainedProperty.Name}' has no public setter."
            )
            this.EmitConstrainedTypeParameterReceiver(
                Invariant.Required(
                    assn.Receiver,
                    "a constrained type-parameter property write dispatches on a receiver",
                    expression: "assn.Receiver"
                )
            )
            this.EmitExpression(assn.Value)
            this.il.OpCode(ILOpCode.Dup)
            this.il.StoreLocal(valueSlot)
            this.il.OpCode(ILOpCode.Constrained)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(assn.ConstrainedReceiverTypeParameter!!))
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(constrainedSetter, assn.ConstrainedInterfaceType))
            this.il.LoadLocal(valueSlot)
            return
        }
        if receiver != nil {
            this.EmitInstanceReceiver(receiver)
        }
        this.EmitExpression(assn.Value)
        this.il.OpCode(ILOpCode.Dup)
        this.il.StoreLocal(valueSlot)
        let receiverIsValueType = receiver != nil && ReflectionMetadataEmitter.IsValueTypeSymbol(receiver.Type)
        switch assn.Member {
            case property is PropertyInfo {
                // Issue #1582: fall back to a non-public setter for an inherited
                // metadata-base property (public accessor tried first so existing
                // sample IL is unchanged).
                let setter = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(property, wantSetter: true) ??
                    ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(
                    property,
                    wantSetter: true,
                    nonPublic: true
                ) ??
                    throw InvalidOperationException(
                    "Property '${property.DeclaringType?.FullName}.${property.Name}' has no public setter."
                )
                this.il.OpCode(
                    if isStatic || receiverIsValueType {
                        ILOpCode.Call
                    } else {
                        ILOpCode.Callvirt
                    }
                )
                // Issue #671: route through the receiver-aware overload so the
                // setter MemberRef parent is the constructed symbolic type when
                // applicable. Falls back to the plain MemberRef path otherwise.
                this.il.Token(
                    if isStatic {
                        (
                            if assn.StaticContainerType != nil {
                                this.outer.memberRefs.GetMethodEntityHandle(setter, assn.StaticContainerType)
                            } else {
                                EntityHandle(this.outer.memberRefs.GetMethodReference(setter))
                            }
                        )
                    } else {
                        this.outer.memberRefs.GetMethodEntityHandle(setter, receiver?.Type)
                    }
                )
            }
            case field is FieldInfo {
                this.il.OpCode(
                    if isStatic {
                        ILOpCode.Stsfld
                    } else {
                        ILOpCode.Stfld
                    }
                )
                this.il.Token(
                    if assn.StaticContainerType != nil {
                        this.outer.memberRefs.GetFieldReference(field, assn.StaticContainerType)
                    } else {
                        this.outer.memberRefs.GetFieldReference(field)
                    }
                )
            }
            default {
                throw NotSupportedException(
                    "CLR member '${assn.Member.GetType().Name}' is not yet supported by the emitter."
                )
            }
        }
        // Expression result: the value we just stored. No second receiver
        // evaluation, no getter call.
        this.il.LoadLocal(valueSlot)
    }

    private func EmitClrIndex(idx BoundClrIndexExpression) {
        if idx.IsConstrainedTypeParameterAccess {
            let constrainedGetter = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(
                idx.Indexer,
                wantSetter: false
            ) ??
                throw InvalidOperationException(
                "Indexer on '${idx.Indexer.DeclaringType?.FullName}' has no public getter."
            )
            this.EmitConstrainedTypeParameterReceiver(idx.Target)
            for arg in idx.Arguments {
                this.EmitExpression(arg)
            }
            this.il.OpCode(ILOpCode.Constrained)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(idx.ConstrainedReceiverTypeParameter!!))
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(constrainedGetter, idx.ConstrainedInterfaceType))
            return
        }
        // #313: indexing an erased generic over a type parameter (e.g.
        // `items[0]` where `items: List[T]`, or `map["k"]` where
        // `map: Dictionary[string, T]`). At runtime the receiver is a closed
        // generic (e.g. `List<int32>`) but is typed as the erased
        // `List<object>`; a `callvirt List<object>::get_Item` would fail.
        // Route the read through the non-generic System.Collections.IList /
        // IDictionary interfaces, which return the element as System.Object —
        // exactly the erased shape of the type parameter.
        if idx
            .Target
            .Type is ImportedTypeSymbol erasedGen &&
            erasedGen.HasTypeParameterArgument &&
            idx
            .Target
            .Type
            .ClrType is Type erasedClr &&
            idx
            .Arguments
            .Length == 1 {
            // Issue #3705 (family 3): `erasedClr` is an imported type, so it is
            // a MetadataLoadContext type on every `/reference:` compile — a
            // host `typeof(IList).IsAssignableFrom(...)` is silently false
            // there and the erasure below is skipped, emitting a
            // `callvirt List<object>::get_Item` that cannot bind at runtime.
            if ClrLoadContext.Satisfies(erasedClr, typeof(IList)) && idx.Arguments[0].Type == TypeSymbol.Int32 {
                this.EmitInstanceReceiver(idx.Target)
                this.il.OpCode(ILOpCode.Castclass)
                this.il.Token(EntityHandle(this.outer.memberRefs.GetTypeReference(typeof(IList))))
                this.EmitExpression(idx.Arguments[0])
                let iListGetter = BclMember.Getter(typeof(IList), "Item")
                this.il.OpCode(ILOpCode.Callvirt)
                this.il.Token(this.outer.memberRefs.GetMethodReference(iListGetter))
                this.EmitErasedObjectReturnWidening(TypeSymbol.Object, idx.Type)
                return
            }
            if ClrLoadContext.Satisfies(erasedClr, typeof(IDictionary)) {
                this.EmitInstanceReceiver(idx.Target)
                this.il.OpCode(ILOpCode.Castclass)
                this.il.Token(EntityHandle(this.outer.memberRefs.GetTypeReference(typeof(IDictionary))))
                this.EmitExpression(idx.Arguments[0])
                if ReflectionMetadataEmitter.IsValueTypeSymbol(idx.Arguments[0].Type) {
                    this.il.OpCode(ILOpCode.Box)
                    this.il.Token(this.outer.memberRefs.GetElementTypeToken(idx.Arguments[0].Type))
                }
                let iDictGetter = BclMember.Getter(typeof(IDictionary), "Item")
                this.il.OpCode(ILOpCode.Callvirt)
                this.il.Token(this.outer.memberRefs.GetMethodReference(iDictGetter))
                this.EmitErasedObjectReturnWidening(TypeSymbol.Object, idx.Type)
                return
            }
        }
        // Phase 4 emit parity: indexer read. `d[k]` -> `callvirt get_Item(k)`.
        this.EmitInstanceReceiver(
            idx.Target,
            isReadOnlyCall: idx.Indexer.GetMethod is {} readGetter && RefCapabilities.IsReadOnlyMethod(readGetter)
        )
        for arg in idx.Arguments {
            this.EmitExpression(arg)
        }
        // Issue #3705: fall back to the non-public accessor exactly as the
        // plain-property arms above do — the binder has already decided that a
        // friend assembly's `internal` indexer accessor is callable here.
        let getter = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(idx.Indexer, wantSetter: false) ??
            ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(
            idx.Indexer,
            wantSetter: false,
            nonPublic: true
        ) ??
            throw InvalidOperationException("Indexer on '${idx.Indexer.DeclaringType?.FullName}' has no getter.")
        let receiverIsValueType = ReflectionMetadataEmitter.IsValueTypeSymbol(idx.Target.Type)
        this.il.OpCode(
            if receiverIsValueType {
                ILOpCode.Call
            } else {
                ILOpCode.Callvirt
            }
        )
        // Issue #671: route through the receiver-aware overload so the indexer
        // getter MemberRef parent is the constructed symbolic type when the
        // target is a generic with G# user-defined type arguments.
        this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(getter, idx.Target.Type))
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
        if this.outer.userTokens.TryGetSymbolicSubstitutedPropertyReturn(idx.Target.Type, idx.Indexer, out _) {
            return
        }
        this.EmitErasedObjectReturnWidening(getter.ReturnType, idx.Type)
    }

    private func EmitClrIndexAssignment(ixa BoundClrIndexAssignmentExpression) {
        // Issue #3705: see EmitClrIndexAccess — the indexer arm honours a
        // friend-visible `internal` accessor like its property siblings.
        let setter MethodInfo? = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(
            ixa.Indexer,
            wantSetter: true
        ) ??
            ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(ixa.Indexer, wantSetter: true, nonPublic: true)
        if ixa.IsConstrainedTypeParameterAccess {
            if setter == nil {
                throw InvalidOperationException(
                    "Indexer on '${ixa.Indexer.DeclaringType?.FullName}' has no public setter."
                )
            }
            let constrainedReceiver = ixa.TargetExpression ??
                BoundVariableExpression(nil, BoundNodeForm.VariableTarget(ixa))
            let constrainedValueSlot = this.indexAssignmentValueSlots[ixa]
            this.EmitConstrainedTypeParameterReceiver(constrainedReceiver)
            for arg in ixa.Arguments {
                this.EmitExpression(arg)
            }
            this.EmitExpression(ixa.Value)
            this.il.OpCode(ILOpCode.Dup)
            this.il.StoreLocal(constrainedValueSlot)
            this.il.OpCode(ILOpCode.Constrained)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(ixa.ConstrainedReceiverTypeParameter!!))
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(setter, ixa.ConstrainedInterfaceType))
            this.il.LoadLocal(constrainedValueSlot)
            return
        }
        // ADR-0056 §2: span element write. `Span[T]` has no setter; its
        // indexer getter returns `ref T`. Obtain the managed pointer via
        // `get_Item`, then store the value through it (`stobj`/`stind.*`).
        // Issue #418 (P1-1): spill v to a temp before the stobj so the
        // expression's result (the assigned value) does not need a second
        // get_Item that would re-evaluate the index arguments.
        if setter == nil {
            let refGetter = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(
                ixa.Indexer,
                wantSetter: false
            ) ??
                ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(
                ixa.Indexer,
                wantSetter: false,
                nonPublic: true
            ) ??
                throw InvalidOperationException(
                "Indexer on '${ixa.Indexer.DeclaringType?.FullName}' has no setter or getter."
            )
            let receiver = ixa.TargetExpression ?? BoundVariableExpression(nil, BoundNodeForm.VariableTarget(ixa))
            let tmp = this.indexAssignmentValueSlots[ixa]
            // store: <receiver-addr> <index...> get_Item(ref T) <value> dup stloc tmp stobj/stind
            this.EmitInstanceReceiver(receiver)
            for arg in ixa.Arguments {
                this.EmitExpression(arg)
            }
            // Span-like value types require a direct call; ref-returning
            // interface indexers still dispatch virtually (#2525).
            this.il.OpCode(
                if ReflectionMetadataEmitter.IsValueTypeSymbol(receiver.Type) {
                    ILOpCode.Call
                } else {
                    ILOpCode.Callvirt
                }
            )
            // Issue #671: receiver-aware MemberRef for symbolic constructed generics.
            this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(refGetter, receiver.Type))
            this.EmitExpression(ixa.Value)
            this.il.OpCode(ILOpCode.Dup)
            this.il.StoreLocal(tmp)
            this.EmitStoreIndirect(ixa.Type)
            // expression result: the spilled value.
            this.il.LoadLocal(tmp)
            return
        }
        // Phase 4 emit parity: indexer write. `d[k] = v` -> `callvirt set_Item(k, v)`.
        // Issue #418 (P1-5): route through EmitInstanceReceiver so a
        // value-type target (`ldloca`) and reference-type target (`ldloc`)
        // are both addressed correctly. For value-type indexers we also
        // need `call` instead of `callvirt`.
        // Issue #418 (P1-1): spill v to a temp before the call so the result
        // is the assigned value without a re-read via get_Item (which would
        // re-evaluate every index argument).
        let writeReceiver = ixa.TargetExpression ?? BoundVariableExpression(nil, BoundNodeForm.VariableTarget(ixa))
        let targetType = ixa.TargetExpression?.Type ?? BoundNodeForm.VariableTarget(ixa).Type
        let targetIsValueType = ReflectionMetadataEmitter.IsValueTypeSymbol(targetType)
        let slot = this.indexAssignmentValueSlots[ixa]
        this.EmitInstanceReceiver(writeReceiver)
        for arg in ixa.Arguments {
            this.EmitExpression(arg)
        }
        this.EmitExpression(ixa.Value)
        this.il.OpCode(ILOpCode.Dup)
        this.il.StoreLocal(slot)
        this.il.OpCode(
            if targetIsValueType {
                ILOpCode.Call
            } else {
                ILOpCode.Callvirt
            }
        )
        // Issue #671: receiver-aware MemberRef for symbolic constructed generics.
        this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(setter, targetType))
        this.il.LoadLocal(slot)
    }

    /// Issue #4312: the one decision that picks `call` or `callvirt` for an
    /// instance accessor on a bound receiver.
    /// @remarks It is the complement of the predicate EmitInstanceReceiver uses to
    /// decide how the receiver is loaded: a value-type receiver was loaded as a
    /// managed pointer and takes `call`; every other receiver is a reference at
    /// run time and takes `callvirt`, so the CLR performs the null check on the
    /// receiver and an `override` accessor dispatches on the run-time type. The
    /// earlier tests (`is StructSymbol {IsClass: true}` or `is InterfaceSymbol`)
    /// answered `call` for any reference receiver whose type symbol was wrapped.
    /// A `base.` access never reaches this: it is lowered to a synthesized
    /// forwarder, which emits its own non-virtual `call`.
    /// @param receiver The bound receiver the accessor is invoked on.
    /// @returns `call` for a value-type receiver, `callvirt` otherwise.
    private func InstanceAccessorOpCode(receiver BoundExpression) ILOpCode {
        if ReflectionMetadataEmitter.IsValueTypeSymbol(receiver.Type) {
            return ILOpCode.Call
        }
        return ILOpCode.Callvirt
    }

    private func EmitInstanceReceiver(receiver BoundExpression, isReadOnlyCall bool = false) {
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
        if ReflectionMetadataEmitter.IsValueTypeSymbol(receiver.Type) {
            // ADR-0184 amendment: the defensive-copy rule now lives in ONE
            // place, shared with the binder's ref-safe-scope walk, so the two
            // cannot disagree about which receivers get copied (they did, and
            // the disagreement returned dangling references — see GS0591).
            if RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy(receiver, isReadOnlyCall) &&
                this.TryEmitCachedReceiver(receiver, needAddress: true) {
                return
            }
            if receiver is BoundDereferenceExpression dereference {
                this.EmitExpression(dereference.Operand)
                return
            }
            if receiver is BoundVariableExpression bve && this.TryLoadStructVariableAddress(bve) {
                return
            }
            if receiver is BoundTupleElementAccessExpression tuple &&
                RefCapabilities.IsDirectlyAddressableForImplicitIn(tuple) {
                this.EmitTupleElementAccess(tuple, addressOnly: true)
                return
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
            // Addressability is a property of the storage chain, not of the
            // FieldSymbol instance. Constructed generic members carry
            // substituted symbols that are absent from StructFieldDefs; the
            // generic-aware token resolver below maps them to the open field.
            if receiver is BoundFieldAccessExpression fa && this.IsAddressableFieldAccess(fa) {
                this.EmitFieldAddress(fa)
                return
            }
            // CLR field chains, including captured reference owners, retain
            // their storage. Use the same addressability rule as slot planning.
            if receiver is BoundClrPropertyAccessExpression clrChain && this.TryEmitAddressableClrFieldAddress(
                clrChain
            ) {
                return
            }
            // Issue #3292: a value-typed element of an array-backed
            // collection (`ps[0]` over `[N]T`, `[]T`, or an imported CLR
            // array) is real heap storage. Load the element's address
            // (`ldelema`) so member writes and mutating instance calls hit
            // the stored element in place instead of a spilled copy —
            // mirroring the `ldsflda` chains issue #3185 established for
            // submission globals and exactly what C# emits for
            // `arr[i].M()` / `arr[i].X = v`. Map and CLR-indexer elements
            // (no element address) keep the spill-to-temp copy path below.
            if receiver is BoundIndexExpression elementReceiver && elementReceiver.IsArrayBackedElementAccess {
                this.EmitElementAddress(elementReceiver)
                return
            }
            // Issue #4224: a call to a native ref-returning function/method,
            // or a read of a native ref-returning property/indexer getter, is
            // real addressable storage — the callee already computed a
            // managed pointer, so take it directly via EmitAddressOf (which
            // knows these node kinds) instead of falling through to the
            // spill-to-temp path below. This receiver shape was unreachable
            // here before this issue made such calls/properties lvalues, so
            // ReceiverSpillCollector never needed to plan a slot for it.
            if RefCapabilities.IsNativeRefReturningCall(receiver) {
                this.EmitAddressOf(BoundAddressOfExpression(nil, receiver, unmanaged: false))
                return
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
            if this.TryEmitCachedReceiver(receiver, needAddress: true) {
                return
            }
            throw InvalidOperationException(
                "No slot populated for ${receiver.Kind} receiver of type '${receiver.Type}' — " +
                    "walker pre-pass missed this child? " +
                    "Check ReceiverSpillCollector and its ancestor walker."
            )
        }
        // Issue #1688: a reference-type receiver shared between the read and
        // write side of a compound member assignment (`getObj().F += x` /
        // `getObj().P += x`) must be evaluated exactly once. Route through
        // the cache before falling back to a plain re-emit.
        if this.TryEmitCachedReceiver(receiver, needAddress: false) {
            return
        }
        this.EmitExpression(receiver)
    }

    /// Issue #1688: when [`receiver`](paramref) was flagged by
    /// `SlotPlanner.ReceiverSpillCollector.AddIfCompoundReused` — i.e. it
    /// is the shared receiver of a compound field/property assignment
    /// (`getObj().F += x` / `getObj().P += x`) — evaluates it
    /// exactly once into its planned slot and loads from the slot on every
    /// subsequent encounter of the SAME node instance, instead of re-running
    /// the (potentially side-effecting) receiver expression for each of the
    /// read and write sides.
    /// @param receiver The receiver expression to emit or reuse from cache.
    /// @param needAddress Whether the caller needs the receiver's address (value-type `this`) rather than
    /// its value.
    /// @returns `true` when the receiver was handled via the cache (planned slot found); `false` when no
    /// slot was planned and the caller should fall back to its own emission.
    private func TryEmitCachedReceiver(receiver BoundExpression, needAddress bool) bool {
        if !this.receiverSpillSlots.TryGetValue(receiver, out var slot) {
            return false
        }
        if this.spilledCompoundReceivers.Add(receiver) {
            this.EmitExpression(receiver)
            this.il.StoreLocal(slot)
        }
        if needAddress {
            this.il.LoadLocalAddress(slot)
        } else {
            this.il.LoadLocal(slot)
        }
        return true
    }

    /// Issue #943: loads the address of a receiver whose static type is a type
    /// parameter constrained to a CLR interface, so it can feed a
    /// `constrained.` prefix on the subsequent `callvirt`. A managed
    /// pointer is required regardless of whether the type argument is ultimately
    /// a value type or a reference type — the `constrained.` opcode handles
    /// both. Addressable variables (parameters, locals, globals) load directly;
    /// non-addressable rvalue receivers are spilled to a pre-planned local.
    /// @remarks Issue #2335 (audit follow-up): a NARROWED variable receiver
    /// (ADR-0069 smart-cast — `bve.NarrowedType != null`, e.g. `if x is
    /// T { x.ToString() }` narrowing an `object`-typed
    /// parameter/local to a type-parameter view `T`) must NOT take the
    /// fast "own address" path even though it IS a
    /// (cref:BoundVariableExpression): the narrowed view still
    /// physically lives in the wider DECLARED storage slot (e.g. an
    /// `object` field/parameter/local), so `ldarga`/`ldloca`
    /// on that slot yields `<declared>&` (e.g.
    /// `object&`) — NOT the `!!T&` the `constrained.`
    /// prefix requires. ilverify rejects the mismatch
    /// (`StackUnexpected`), and the wrong pointer shape would
    /// misinterpret the receiver's bytes at runtime for shared generic code.
    /// (cref:SlotPlanner.ReceiverSpillCollector) plans a spill slot
    /// (typed as the NARROWED type, since `BoundVariableExpression.Type`
    /// reports `NarrowedType ?? Variable.Type`) for exactly this case, so
    /// falling through to the general rvalue-spill path below —
    /// (cref:EmitExpression) re-materializes the correctly narrowed
    /// `!!T` value via `EmitNarrowingCastIfNeeded` — produces a
    /// verifiable, correctly-addressed receiver.
    /// @param receiver The constrained type-parameter receiver expression.
    private func EmitConstrainedTypeParameterReceiver(receiver BoundExpression) {
        // ADR-0184 amendment: shared with the binder — see
        // RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy. The absent
        // `isReadOnlyCall` opt-out is deliberate, not an oversight: a
        // `constrained.`-prefixed receiver is addressed through a temp
        // regardless of whether the target member is a `readonly` member, so
        // this site always passes the default `false`.
        if RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy(receiver) && this.TryEmitCachedReceiver(
            receiver,
            needAddress: true
        ) {
            return
        }
        if receiver is BoundDereferenceExpression dereference {
            this.EmitExpression(dereference.Operand)
            return
        }
        if receiver is BoundVariableExpression bve && bve.NarrowedType == nil && this.TryLoadVariableAddress(
            bve.Variable
        ) {
            return
        }
        // Slot planning deliberately skips receivers whose field address can be
        // loaded directly; mirror that decision instead of demanding a spill.
        if receiver is BoundFieldAccessExpression fieldAccess && this.IsAddressableFieldAccess(fieldAccess) {
            this.EmitFieldAddress(fieldAccess)
            return
        }
        if receiver is not BoundVariableExpression &&
            receiver is not BoundFieldAccessExpression &&
            RefCapabilities
            .IsDirectlyAddressableForImplicitIn(receiver) {
            this.EmitAddressOf(BoundAddressOfExpression(nil, receiver))
            return
        }
        this.EmitExpression(receiver)
        if !this.receiverSpillSlots.TryGetValue(receiver, out var slot) {
            throw InvalidOperationException(
                "No slot populated for constrained type-parameter receiver of kind " +
                    "'${receiver.Kind}' — walker pre-pass missed this child? " +
                    "Check ReceiverSpillCollector and constrained receiver addressability."
            )
        }
        this.il.StoreLocal(slot)
        this.il.LoadLocalAddress(slot)
    }

    /// Returns `true` when [`fa`](paramref) is addressable —
    /// i.e. `ldflda` against its receiver yields a valid managed
    /// pointer. Static fields are always addressable; instance fields on
    /// class receivers are addressable (the receiver is an object
    /// reference); instance fields on value-type receivers are addressable
    /// only if the receiver itself is addressable (a variable, or another
    /// addressable field access).
    private func IsAddressableFieldAccess(fa BoundFieldAccessExpression) bool {
        if fa.Receiver == nil {
            // Issue #1525: mirror ReflectionMetadataEmitter
            // .IsAddressableFieldAccessForReceiverSpill — a static field is
            // addressable via ldsflda except for an initonly (readonly) static
            // value-type field outside its declaring type's .cctor, which must
            // be spilled to a temp (defensive copy) to keep the IL verifiable.
            // These two predicates MUST stay in sync: if they disagree the
            // emitter looks up a spill slot the planner never reserved.
            return this.outer.IsStaticFieldAddressLegalHere(fa.Field)
        }
        if fa.Receiver!!.Type is StructSymbol rs && rs.IsClass {
            return true
        }
        if fa.Receiver!!.Type?.ClrType != nil && !fa.Receiver!!.Type.ClrType!!.IsValueType {
            return true
        }
        if fa.Receiver is BoundVariableExpression bv && this.CanLoadVariableAddress(bv.Variable) {
            return true
        }
        if fa.Receiver is BoundFieldAccessExpression nested {
            return this.IsAddressableFieldAccess(nested)
        }
        if fa.Receiver is BoundTupleElementAccessExpression tuple {
            return RefCapabilities.IsDirectlyAddressableForImplicitIn(tuple)
        }
        // Issue #3185: a prior-cell submission global (or a value-type CLR
        // field chain rooted at one) is addressable storage.
        if fa.Receiver is BoundClrPropertyAccessExpression clrReceiver {
            return ReflectionMetadataEmitter.IsAddressableClrFieldChain(clrReceiver)
        }
        // Issue #3292: an array-backed element is addressable via `ldelema`
        // regardless of how the collection reference itself was produced
        // (the array reference is the storage root).
        if fa.Receiver is BoundIndexExpression elementReceiver {
            return elementReceiver.IsArrayBackedElementAccess
        }
        return false
    }

    /// Issue #3185: emits the managed-pointer address of an addressable CLR
    /// field chain (see (cref:ReflectionMetadataEmitter.IsAddressableClrFieldChain)):
    /// `ldsflda` for the submission-global root, `ldflda` per
    /// value-type field link, and a plain object-reference load for a
    /// reference-typed link. Returns `false` without emitting
    /// when the chain is not addressable.
    /// @param access The CLR member access whose address to load.
    /// @returns `true` once the address is on the stack.
    private func TryEmitAddressableClrFieldAddress(access BoundClrPropertyAccessExpression) bool {
        if !ReflectionMetadataEmitter.IsAddressableClrFieldChain(access) {
            return false
        }
        this.EmitAddressOf(BoundAddressOfExpression(nil, access))
        return true
    }

    /// Issue #3292: emits the managed-pointer address of an array-backed
    /// element (`<collection>; <index>; ldelema T`). The
    /// collection reference and index are each evaluated exactly once here;
    /// duplicating contexts (compound member writes sharing this receiver
    /// between their read and write sides) have any side-effecting
    /// collection/index sub-expression pre-spilled into temp locals by
    /// `SideEffectSpiller`, so re-emitting this chain is observably
    /// pure there.
    /// @param element The array-backed element access.
    private func EmitElementAddress(element BoundIndexExpression) {
        this.EmitExpression(element.Target)
        if GetRectangularArrayType(element.Target.Type) is {} rectangular {
            for index in element.Indices {
                this.EmitExpression(index)
            }
            this.il.OpCode(ILOpCode.Call)
            this.il.Token(this.outer.memberRefs.GetRectangularArrayMemberReference(rectangular, "Address"))
            return
        }
        this.EmitExpression(element.Index)
        this.EmitLoadElementAddress(element.Type)
    }

    private func CanLoadVariableAddress(variable VariableSymbol) bool {
        if variable is ParameterSymbol ps && this.parameters.ContainsKey(ps) {
            return true
        }
        if this.locals.ContainsKey(variable) {
            return true
        }
        if variable is GlobalVariableSymbol{IsConst: false} gv && this.outer.cache.GlobalFieldDefs.ContainsKey(gv) {
            return true
        }
        return false
    }

    /// Loads the address of a struct-typed receiver that is a bare variable
    /// read, honoring ADR-0069 smart-cast narrowing (issue #1917). When the
    /// variable's OWN declared type already agrees with the receiver's
    /// (possibly narrowed) struct type, the address is the variable's own
    /// storage — delegates to (cref:TryLoadVariableAddress)
    /// (ldarga/ldloca). When the receiver is a NARROWED read of a variable
    /// declared as a REFERENCE type (e.g. an `object`/interface-typed
    /// parameter smart-cast to a struct by an `is` test — `obj is Money
    /// && obj.Cents`), the variable's slot holds a boxed reference, not
    /// struct storage: taking its address directly pushes the address of
    /// the `object` SLOT, which a subsequent `ldfld`/`ldflda Money::…`
    /// rejects at verification time (ilverify: "found address of 'object',
    /// expected readonly address of 'Money'" — the CLR JIT tolerates the
    /// mismatched stack shape, but ilverify's stricter typed-stack model does
    /// not). The correct sequence loads the boxed reference then
    /// `unbox`es it: this yields a controlled-mutability (read-only)
    /// managed pointer directly to the embedded value — matching both what
    /// ilverify expects and what csc emits for the equivalent C# pattern.
    /// @param bve The struct-typed variable-read receiver.
    /// @returns `true` once the address (or unboxed pointer) is on the stack.
    private func TryLoadStructVariableAddress(bve BoundVariableExpression) bool {
        let declaredType = bve.Variable.Type
        let effectiveType = bve.Type
        if bve.NarrowedType == nil || ReflectionMetadataEmitter.IsValueTypeSymbol(declaredType) ||
            declaredType
            ?.ClrType
            ?.IsValueType == true ||
            !(
            ReflectionMetadataEmitter.IsValueTypeSymbol(effectiveType) || effectiveType?.ClrType?.IsValueType == true
        ) {
            // No boxing narrowing involved (or the variable's own slot is
            // already a value type) — safe to take the variable's own address.
            return this.TryLoadVariableAddress(bve.Variable)
        }
        this.EmitLoadVariable(bve.Variable)
        this.il.OpCode(ILOpCode.Unbox)
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(effectiveType))
        return true
    }

    private func TryLoadVariableAddress(variable VariableSymbol) bool {
        if variable is ParameterSymbol ps && this.parameters.TryGetValue(ps, out var argIndex) {
            // In a struct instance method, arg0 is already a managed pointer
            // (ref TStruct). Loading the arg value gives the address directly;
            // ldarga would give a pointer-to-pointer which is wrong for
            // ldfld/stfld/ldflda on the struct.
            if argIndex == 0 && this.structThisParameter != nil && object.ReferenceEquals(
                ps,
                this.structThisParameter
            ) {
                this.il.LoadArgument(0)
            } else if ps.RefKind != RefKind.None {
                // ADR-0060: a ref/out/in parameter slot already holds the
                // managed pointer T&; loading the arg value gives the
                // address directly. Ldarga would yield T&* which is wrong.
                this.il.LoadArgument(argIndex)
            } else {
                this.il.LoadArgumentAddress(argIndex)
            }
            return true
        }
        if this.locals.TryGetValue(variable, out var slot) {
            // Issue #491 (ADR-0060 follow-up): a ref-aliasing local's slot
            // already stores a managed pointer T&; load the slot value, not
            // its address (ldloca would yield T&* which is wrong).
            if variable is LocalVariableSymbol refLocal && refLocal.RefKind != RefKind.None {
                this.il.LoadLocal(slot)
            } else {
                this.il.LoadLocalAddress(slot)
            }
            return true
        }
        // Issue #408 / #191: top-level globals are emitted as static fields
        // on <Program>; their address is taken with ldsflda.
        if variable is GlobalVariableSymbol{IsConst: false} gv &&
            this
            .outer
            .cache
            .GlobalFieldDefs
            .TryGetValue(gv, out var fieldHandle) {
            this.il.OpCode(ILOpCode.Ldsflda)
            this.il.Token(fieldHandle)
            return true
        }
        return false
    }

    /// ADR-0039: Emits the field address (ldflda) for a user struct field.
    private func EmitFieldAddress(fa BoundFieldAccessExpression) {
        let fieldHandle = this.ResolveFieldAddressHandle(fa)
        // ADR-0053: static field address — use ldsflda.
        if fa.Receiver == nil {
            this.il.OpCode(ILOpCode.Ldsflda)
            this.il.Token(fieldHandle)
            return
        }
        // Load receiver address, then ldflda.
        let receiverIsClass = fa.Receiver!!.Type is StructSymbol rs && rs.IsClass
        if !receiverIsClass && fa.Receiver is BoundDereferenceExpression deref && TypeSymbol.IsUnmanagedPointer(
            deref.Operand.Type
        ) {
            // ADR-0122 §4/§10: `(*p).field` / `p->field`. The pointer value IS
            // the struct's address, so load the pointer directly before ldflda.
            this.EmitInstanceReceiver(deref.Operand)
        } else if !receiverIsClass && fa.Receiver is BoundVariableExpression bv && this.TryLoadStructVariableAddress(
            bv
        ) {
            // address already on stack

        } else if !receiverIsClass && fa.Receiver is BoundFieldAccessExpression nested && this.IsAddressableFieldAccess(
            nested
        ) {
            this.EmitFieldAddress(nested)
        } else if !receiverIsClass &&
            fa.Receiver is BoundClrPropertyAccessExpression clrChainReceiver &&
            this
            .TryEmitAddressableClrFieldAddress(clrChainReceiver) {
            // Issue #3185: the receiver is a prior-cell submission global (or
            // a CLR field chain rooted at one); its address is on the stack.

        } else if !receiverIsClass &&
            fa.Receiver is BoundIndexExpression elementReceiver &&
            elementReceiver
            .IsArrayBackedElementAccess {
            // Issue #3292: the receiver is an array/slice element — root the
            // address chain at the element (`ldelema`) so the field write
            // mutates the stored element in place.
            this.EmitElementAddress(elementReceiver)
        } else {
            // Issue #2818: an addressable value-type field chain may have a
            // side-effecting reference-type root shared by compound read/write
            // (`GetHolder().Value.Id += 5`). Route the owner through the
            // receiver cache instead of evaluating that root again.
            this.EmitInstanceReceiver(fa.Receiver!!, isReadOnlyCall: true)
        }
        this.il.OpCode(ILOpCode.Ldflda)
        this.il.Token(fieldHandle)
    }

    // Resolves the field token `ldflda`/`ldsflda` uses for a user field access.
    private func ResolveFieldAddressHandle(fa BoundFieldAccessExpression) EntityHandle {
        // Issue #1465: a field declared on a generic user struct (e.g. an async
        // state-machine reified over its enclosing class's type parameters) must
        // be addressed through a MemberRef parented at the constructed self
        // TypeSpec (`SM`1<!T>`), not the raw open FieldDef. Mirror the
        // generic-aware resolution used by the value-read path so `ldflda`
        // (struct builder SetResult/SetException etc.) matches verification.
        let fieldContainer StructSymbol? = ResolveFieldReferenceContainer(
            fa.StructType as StructSymbol,
            fa.Receiver?.Type as StructSymbol,
            fa.Field
        )
        if fieldContainer != nil {
            return this.outer.userTokens.ResolveFieldToken(fieldContainer, fa.Field)
        }
        if this.outer.cache.StructFieldDefs.TryGetValue(fa.Field, out var defHandle) {
            return defHandle
        }
        throw InvalidOperationException("Cannot take address of field '${fa.Field.Name}': no emitted FieldDef.")
    }

    /// ADR-0039: Emits ldelema for array element address.
    private func EmitLoadElementAddress(elementType TypeSymbol) {
        let clrType = elementType?.ClrType ?? typeof(object)
        let token = this
            .outer
            .memberRefs
            .GetExactTypeToken(
            elementType ?? TypeSymbol.FromClrTypeWithoutNullability(typeof(object), NullabilityFreeReason.TypeLiteral)
        )
        this.il.OpCode(ILOpCode.Ldelema)
        this.il.Token(token)
    }

    /// Issue #3879 (ADR-0060 amendment, ADR-0056 §1): a call to a
    /// `ref`-returning G# member leaves a managed pointer (`T&`) on
    /// the stack, but the bound tree types the read as the POINTEE `T` —
    /// G#'s ref-alias binder does not accept a call result as an lvalue (the
    /// documented #1900 limit), so every G# read of such a member is a value
    /// read. Load through the pointer so the stack matches the bound type.
    ///
    /// Without this the IL is either unverifiable (`InvalidProgramException`
    /// when the pointer flows into a by-value parameter) or a silent wrong
    /// answer (the raw address printed as an `int32`). That is the
    /// pre-existing shape of issue #490's deferred "consume a ref return at a
    /// G# call site", which a `ref`-returning PROPERTY would otherwise
    /// inherit — and a property read is far more common than a method-call read,
    /// so it is closed here rather than left to surface as new behaviour.
    ///
    /// The (cref:ByRefTypeSymbol) guard is load-bearing: an IMPORTED
    /// ref-returning member is already surfaced as `ByRefTypeSymbol` and
    /// dereferenced by the binder
    /// (`ConversionClassifier.AutoDereferenceRefReturn`), and
    /// `BaseCallForwarderRewriter` synthesizes a forwarder
    /// (cref:FunctionSymbol) that keeps that by-ref result type while
    /// also setting (cref:FunctionSymbol.ReturnRefKind). Dereferencing
    /// there too would be a double load.
    /// @param returnRefKind The callee's return ref-kind.
    /// @param resultType The type the bound tree gives the read.
    private func EmitRefReturnDereferenceIfNeeded(returnRefKind RefKind, resultType TypeSymbol?) {
        if returnRefKind == RefKind.None ||
            resultType == nil ||
            resultType is ByRefTypeSymbol ||
            resultType == TypeSymbol.Void ||
            resultType == TypeSymbol.Error {
            return
        }
        this.EmitLoadIndirect(resultType)
    }

    /// ADR-0039: Emits ldind.* or ldobj for loading a value through a managed pointer.
    private func EmitLoadIndirect(pointeeType TypeSymbol) {
        // Issue #3501: a value-type `T?` pointee (e.g. an `out x int32?`
        // parameter) stores/loads the full Nullable<T> struct, but
        // NullableTypeSymbol borrows the UNDERLYING type's ClrType, so the
        // primitive arms below would pick the bare-T ldind/stind form and
        // desynchronize the stack from the Nullable<T> slot (ilverify
        // StackUnexpected). Route through ldobj/stobj with the wrapper token.
        if pointeeType is NullableTypeSymbol loadNullable && NullableLifting.IsAnyValueTypeNullable(loadNullable) {
            this.il.OpCode(ILOpCode.Ldobj)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(pointeeType))
            return
        }
        // Issue #4236: `T?` over an OPEN, unconstrained type parameter (e.g.
        // an `out value T?` parameter inside a `class C[T]` with no `struct`
        // constraint) is neither caught by the `IsAnyValueTypeNullable` arm
        // above (T's value-type-ness isn't provable) nor by the bare
        // `TypeParameterSymbol` arm below (pointeeType is the NullableTypeSymbol
        // wrapper, not the parameter itself) — it fell through to `ldind.ref`,
        // which is invalid IL once T is JIT-instantiated as a real value type
        // (InvalidProgramException at runtime, past ILVerify). GetElementTypeToken
        // already resolves this shape correctly (ADR-0084 §L5 / issue #814):
        // `Nullable<T>` when T is struct-constrained, bare `T` otherwise. Route
        // through ldobj with that token exactly like the provable-value-type arm.
        if pointeeType is NullableTypeSymbol loadOpenTp && loadOpenTp.UnderlyingType is TypeParameterSymbol {
            this.il.OpCode(ILOpCode.Ldobj)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(pointeeType))
            return
        }
        let clrType = pointeeType.ClrType
        if clrType.IsSameAs(typeof(int32)) || clrType.IsSameAs(typeof(uint32)) {
            this.il.OpCode(ILOpCode.Ldind_i4)
        } else if clrType.IsSameAs(typeof(int64)) || clrType.IsSameAs(typeof(uint64)) {
            this.il.OpCode(ILOpCode.Ldind_i8)
        } else if clrType.IsSameAs(typeof(float32)) {
            this.il.OpCode(ILOpCode.Ldind_r4)
        } else if clrType.IsSameAs(typeof(float64)) {
            this.il.OpCode(ILOpCode.Ldind_r8)
        } else if clrType.IsSameAs(typeof(int16)) {
            this.il.OpCode(ILOpCode.Ldind_i2)
        } else if clrType.IsSameAs(typeof(uint16)) || clrType.IsSameAs(typeof(char)) {
            // Issue #1613: ldind.i2 sign-extends to int32. ushort/char are
            // unsigned pointees — mirror EmitLoadElement (issue #520) and use
            // the unsigned form so values >= 0x8000 don't come back negative.
            this.il.OpCode(ILOpCode.Ldind_u2)
        } else if clrType.IsSameAs(typeof(int8)) {
            this.il.OpCode(ILOpCode.Ldind_i1)
        } else if clrType.IsSameAs(typeof(uint8)) || clrType.IsSameAs(typeof(bool)) {
            // Issue #1613: same fix for byte/bool — ldind.u1 zero-extends.
            this.il.OpCode(ILOpCode.Ldind_u1)
        } else if pointeeType is TypeParameterSymbol || ReflectionMetadataEmitter.IsValueTypeSymbol(pointeeType) {
            this.il.OpCode(ILOpCode.Ldobj)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(pointeeType))
        } else {
            this.il.OpCode(ILOpCode.Ldind_ref)
        }
    }

    /// ADR-0056 §2: Emits stind.* or stobj to store a value through a managed pointer.
    private func EmitStoreIndirect(pointeeType TypeSymbol) {
        // Issue #3501: see EmitLoadIndirect — a value-type `T?` pointee needs
        // the Nullable<T> stobj, not the underlying primitive's stind.
        if pointeeType is NullableTypeSymbol storeNullable && NullableLifting.IsAnyValueTypeNullable(storeNullable) {
            this.il.OpCode(ILOpCode.Stobj)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(pointeeType))
            return
        }
        // Issue #4236: mirror of the EmitLoadIndirect arm above — `T?` over an
        // OPEN, unconstrained type parameter falls through both the
        // provable-value-type check and the bare-TypeParameterSymbol check, so
        // storing through the pointer used `stind.ref` (a reference-slot store)
        // for what can be an exact value-type instantiation at runtime, which
        // is invalid IL the JIT rejects (InvalidProgramException) even though
        // ILVerify's abstract-over-open-T checking does not catch it. Reproduced
        // via `Gsharp.Concurrency.Chan<T>.ReceiveOrPark`'s `out T? value`
        // parameter self-hosted with T a non-primitive struct.
        if pointeeType is NullableTypeSymbol storeOpenTp && storeOpenTp.UnderlyingType is TypeParameterSymbol {
            this.il.OpCode(ILOpCode.Stobj)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(pointeeType))
            return
        }
        let clrType = pointeeType.ClrType
        if clrType.IsSameAs(typeof(int32)) || clrType.IsSameAs(typeof(uint32)) {
            this.il.OpCode(ILOpCode.Stind_i4)
        } else if clrType.IsSameAs(typeof(int64)) || clrType.IsSameAs(typeof(uint64)) {
            this.il.OpCode(ILOpCode.Stind_i8)
        } else if clrType.IsSameAs(typeof(float32)) {
            this.il.OpCode(ILOpCode.Stind_r4)
        } else if clrType.IsSameAs(typeof(float64)) {
            this.il.OpCode(ILOpCode.Stind_r8)
        } else if clrType.IsSameAs(typeof(int16)) || clrType.IsSameAs(typeof(uint16)) || clrType.IsSameAs(
            typeof(char)
        ) {
            this.il.OpCode(ILOpCode.Stind_i2)
        } else if clrType.IsSameAs(typeof(uint8)) || clrType.IsSameAs(typeof(int8)) || clrType.IsSameAs(typeof(bool)) {
            this.il.OpCode(ILOpCode.Stind_i1)
        } else if pointeeType is TypeParameterSymbol || ReflectionMetadataEmitter.IsValueTypeSymbol(pointeeType) {
            this.il.OpCode(ILOpCode.Stobj)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(pointeeType))
        } else {
            this.il.OpCode(ILOpCode.Stind_ref)
        }
    }

    shared {
        private func GetEffectiveFieldType(access BoundFieldAccessExpression) TypeSymbol -> access.SubstitutedType ??
            (
            if access.StructType is StructSymbol owner {
                owner.SubstituteMemberType(access.Field.Type)!!
            } else {
                access.Field.Type
            }
        )

        private func GetEffectivePropertyType(
            access BoundPropertyAccessExpression
        ) TypeSymbol -> access.SubstitutedType ??
            (
            if access.StructType is StructSymbol owner {
                owner.SubstituteMemberType(access.Property.Type)!!
            } else {
                access.Property.Type
            }
        )

        // Issue #1254: when an inherited property is accessed through a (non-generic)
        // derived receiver but the property is declared on a generic base type, the
        // accessor must be referenced via a MemberRef parented at the CONSTRUCTED
        // base TypeSpec. Returns that constructed base, or null when the property is
        // not inherited from a generic base.
        private func ResolveInheritedGenericBaseForProperty(
            receiver StructSymbol?,
            property PropertySymbol?
        ) StructSymbol? {
            if receiver == nil || property == nil {
                return nil
            }
            // Issue #4481: the bound expression carries the exact PropertySymbol,
            // so find the hierarchy level that DECLARES it (by reference, at every
            // level, generic or not) and read through that level's accessor. The
            // name-based walk below matches the first GENERIC level declaring any
            // property of that name, so it picked an overridden base declaration
            // whenever an override sat on a level it skipped — for a covariant
            // override that accessor returns the base's wider type, leaving the
            // wrong type on the stack.
            if FindDeclaringLevel(receiver, property) is {} declaringLevel {
                if !declaringLevel.IsConstructedNestedType && !ReflectionMetadataEmitter.IsUserGenericTypeReference(
                    declaringLevel
                ) {
                    // A non-generic declaring type: its own accessor MethodDef.
                    return nil
                }
                // The declaring generic type as seen from the receiver, with the
                // receiver's type arguments composed through the chain.
                let declaringDefinition = declaringLevel.Definition ?? declaringLevel
                return receiver.FindConstructedGenericBase(
                    (def StructSymbol) -> object.ReferenceEquals(def, declaringDefinition)
                ) ??
                    declaringLevel
            }
            return receiver.FindConstructedGenericBase(
                (def StructSymbol) -> {
                    return DefDeclaresProperty(def, property)
                }
            )
        }

        // Issue #4481: the level of `receiver`'s hierarchy whose property list
        // holds `property` itself — as constructed from the receiver, or in its
        // open definition (constructed members are position-parallel copies of
        // the definition's). Null when no level holds that exact symbol.
        private func FindDeclaringLevel(receiver StructSymbol, property PropertySymbol) StructSymbol? {
            for level in receiver.GetHierarchy() {
                if HoldsProperty(level, property) || HoldsProperty(level.Definition ?? level, property) {
                    return level
                }
            }
            return nil
        }

        private func HoldsProperty(type StructSymbol, property PropertySymbol) bool {
            let declared = if property.IsStatic {
                type.StaticProperties
            } else {
                type.Properties
            }
            if declared.IsDefaultOrEmpty {
                return false
            }
            for candidate in declared {
                if object.ReferenceEquals(candidate, property) {
                    return true
                }
            }
            return false
        }

        private func DefDeclaresProperty(def StructSymbol, property PropertySymbol) bool {
            let set = if property.IsStatic {
                def.StaticProperties
            } else {
                def.Properties
            }
            if set.IsDefaultOrEmpty {
                return false
            }
            for candidate in set {
                if candidate.Name == property.Name && candidate.IsIndexer == property.IsIndexer {
                    return true
                }
            }
            return false
        }

        // Issue #1254: the field analogue of ResolveInheritedGenericBaseForProperty.
        private func ResolveInheritedGenericBaseForField(receiver StructSymbol?, field FieldSymbol?) StructSymbol? {
            if receiver == nil || field == nil {
                return nil
            }
            return receiver.FindConstructedGenericBase(
                (def StructSymbol) -> {
                    return DefDeclaresField(def, field)
                }
            )
        }

        private func DefDeclaresField(def StructSymbol, field FieldSymbol) bool {
            if def.Fields.IsDefaultOrEmpty {
                return false
            }
            for candidate in def.Fields {
                if candidate.Name == field.Name {
                    return true
                }
            }
            return false
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
        // generic type itself. A non-generic declaring type is returned unchanged;
        // ResolveFieldToken will then select its bare FieldDef instead of guessing
        // from a generic derived receiver.
        private func ResolveFieldReferenceContainer(
            declaringType StructSymbol?,
            receiver StructSymbol?,
            field FieldSymbol
        ) StructSymbol? {
            if declaringType == nil {
                return nil
            }
            // Prefer the constructed base instantiation reachable from the receiver.
            // FindConstructedGenericBase walks the receiver's hierarchy (including
            // itself) resolving type arguments through the running substitution, so
            // it yields the self-instantiation (`Base`1<!0>`) when the field is
            // accessed from within the generic type and the concrete instantiation
            // (`Base`1<int32>`) when reached through a non-generic leaf — even when
            // the bound declaring type was recorded as the open self carrying its
            // own type parameters as arguments.
            let constructed StructSymbol? = ResolveInheritedGenericBaseForField(receiver, field)
            if constructed != nil {
                return constructed
            }
            return declaringType
        }

        // Issue #1467: the property analogue of ResolveFieldReferenceContainer.
        private func ResolvePropertyReferenceContainer(
            declaringType StructSymbol?,
            receiver StructSymbol?,
            property PropertySymbol
        ) StructSymbol? {
            if declaringType == nil {
                return nil
            }
            let constructed StructSymbol? = ResolveInheritedGenericBaseForProperty(receiver, property)
            if constructed != nil {
                return constructed
            }
            if !declaringType.TypeArguments.IsDefaultOrEmpty {
                return declaringType
            }
            let def = declaringType.Definition ?? declaringType
            return if def.TypeParameters.IsDefaultOrEmpty {
                default(StructSymbol?)
            } else {
                declaringType
            }
        }
    }
}
