// <copyright file="MethodBodyEmitter.Patterns.cs" company="GSharp">
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
/// pattern-matching emission (BoundPattern, EmitPatternSwitchStatement, EmitSwitchExpression).
/// See <c>MethodBodyEmitter.cs</c> for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
/// </summary>
internal sealed partial class MethodBodyEmitter
{

    // Phase B: emit IL for a BoundPatternSwitchStatement.
    //
    // Lowering shape (mirrors the interpreter's EvaluatePatternSwitchStatement):
    //   * evaluate the discriminant once into the pre-allocated temp slot;
    //   * for each non-default arm: emit pattern match — failure branches
    //     to the next-arm label, success falls through into arm body and
    //     ends with a branch to the end label;
    //   * if a default arm is present, emit its body last;
    //   * mark the end label.
    //
    // Pattern matching is delegated to EmitPattern which threads a
    // "loadValue" delegate so nested patterns (property fields, list
    // elements) compose without intermediate locals.
    private void EmitPatternSwitchStatement(BoundPatternSwitchStatement node)
    {
        var discriminantSlot = this.patternSwitchSlots[node];
        this.EmitExpression(node.Discriminant);
        this.il.StoreLocal(discriminantSlot);

        // Issue #2283: all-terminal switches still emit their uniform dead
        // branches/end label. EmitMethodBody must append a real ret at that
        // label so no branch targets the exact end of the method body.
        var endLabel = this.il.DefineLabel();
        BoundPatternSwitchArm? defaultArm = null;

        foreach (var arm in node.Arms)
        {
            if (arm.IsDefault)
            {
                defaultArm = arm;
                continue;
            }

            var nextArm = this.il.DefineLabel();
            this.EmitPattern(
                arm.Pattern,
                loadValue: () => this.il.LoadLocal(discriminantSlot),
                valueType: node.Discriminant.Type,
                failLabel: nextArm);
            if (arm.Guard != null)
            {
                this.EmitExpression(arm.Guard);
                this.il.Branch(ILOpCode.Brfalse, nextArm);
            }

            this.EmitStatement(arm.Body);
            this.il.Branch(ILOpCode.Br, endLabel);

            this.il.MarkLabel(nextArm);
        }

        if (defaultArm != null)
        {
            this.EmitStatement(defaultArm.Body);
        }

        this.il.MarkLabel(endLabel);
    }

    // Phase C: switch-expression emit. Mirrors the pattern-switch
    // statement shape, but each arm body is a single result expression
    // that is stored into a pre-allocated result temp before branching
    // to the end label. The result temp is loaded once at the end to
    // produce the expression's value.
    private void EmitSwitchExpression(BoundSwitchExpression node)
    {
        var (resultSlot, discrSlot) = this.switchExpressionSlots[node];
        this.EmitExpression(node.Discriminant);
        this.il.StoreLocal(discrSlot);

        var endLabel = this.il.DefineLabel();
        BoundSwitchExpressionArm? defaultArm = null;

        foreach (var arm in node.Arms)
        {
            if (arm.IsDefault)
            {
                defaultArm = arm;
                continue;
            }

            var nextArm = this.il.DefineLabel();
            this.EmitPattern(
                arm.Pattern,
                loadValue: () => this.il.LoadLocal(discrSlot),
                valueType: node.Discriminant.Type,
                failLabel: nextArm);
            if (arm.Guard != null)
            {
                this.EmitExpression(arm.Guard);
                this.il.Branch(ILOpCode.Brfalse, nextArm);
            }

            this.EmitExpression(arm.Result);
            this.il.StoreLocal(resultSlot);
            this.il.Branch(ILOpCode.Br, endLabel);
            this.il.MarkLabel(nextArm);
        }

        if (defaultArm != null)
        {
            this.EmitExpression(defaultArm.Result);
            this.il.StoreLocal(resultSlot);
        }
        else
        {
            const string Message = "Unmatched switch expression value.";
            var constructor = BclMember.Ctor(typeof(InvalidOperationException), typeof(string));
            this.il.LoadString(this.outer.emitCtx.Metadata.GetOrAddUserString(Message));
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.memberRefs.GetCtorReference(constructor));
            this.il.OpCode(ILOpCode.Throw);
        }

        this.il.MarkLabel(endLabel);
        this.il.LoadLocal(resultSlot);
    }

    // Emit IL that branches to failLabel when the pattern does not match
    // the value produced by loadValue, and falls through (with any
    // bindings stored) when it does. valueType is the static type of the
    // value loadValue pushes.
    private void EmitPattern(BoundPattern pattern, Action loadValue, TypeSymbol valueType, LabelHandle failLabel)
    {
        switch (pattern)
        {
            case BoundDiscardPattern:
                // Always matches; emit nothing.
                break;
            case BoundConstantPattern cp:
                this.EmitConstantPattern(cp, loadValue, valueType, failLabel);
                break;
            case BoundTypePattern tp:
                this.EmitTypePattern(tp, loadValue, valueType, failLabel);
                break;
            case BoundPropertyPattern pp:
                this.EmitPropertyPattern(pp, loadValue, valueType, failLabel);
                break;
            case BoundRelationalPattern rp:
                this.EmitRelationalPattern(rp, loadValue, failLabel);
                break;
            case BoundListPattern lp:
                this.EmitListPattern(lp, loadValue, failLabel);
                break;
            case BoundSlicePattern:
                // Slice subpatterns are emitted inline by EmitListPattern with
                // prefix/suffix context; they never reach the generic dispatch.
                throw new InvalidOperationException(
                    "A slice subpattern ('..') is only valid inside a list pattern and is emitted by EmitListPattern.");
            case BoundBinaryPattern bp:
                this.EmitBinaryPattern(bp, loadValue, valueType, failLabel);
                break;
            case BoundNotPattern np:
                this.EmitNotPattern(np, loadValue, valueType, failLabel);
                break;
            default:
                throw new NotSupportedException(
                    $"Pattern kind '{pattern.Kind}' is not yet supported by the emitter.");
        }
    }

    private void EmitConstantPattern(BoundConstantPattern cp, Action loadValue, TypeSymbol valueType, LabelHandle failLabel)
    {
        // Special-case `nil`: compare against null reference.
        if (cp.Value is BoundLiteralExpression lit && lit.Value is null)
        {
            loadValue();
            this.il.Branch(ILOpCode.Brtrue, failLabel);
            return;
        }

        if (IsStringOrNullableStringEmit(valueType))
        {
            loadValue();
            this.EmitExpression(cp.Value);
            this.il.Call(this.outer.wellKnown.GetStringEqualsReference());
            this.il.Branch(ILOpCode.Brfalse, failLabel);
            return;
        }

        // Issue #421 (P2-3): `decimal` is a struct; per ECMA-335 §III.4
        // `ceq` is undefined on struct operands. Route through
        // `decimal.op_Equality` to produce verifiable IL.
        if (valueType == TypeSymbol.Decimal)
        {
            loadValue();
            this.EmitExpression(cp.Value);
            this.TryEmitDecimalBinary(BoundBinaryOperatorKind.Equals);
            this.il.Branch(ILOpCode.Brfalse, failLabel);
            return;
        }

        var isObject = valueType.ClrType?.IsSameAs(typeof(object)) == true;
        var isValueNullable = valueType is NullableTypeSymbol nullable
            && ReflectionMetadataEmitter.IsValueTypeNullable(nullable);
        if (isObject || isValueNullable)
        {
            // PatternBinder adds at most one conversion to the discriminant type.
            // Strip only that carrier; inner conversions determine the runtime value type.
            var patternValue = cp.Value is BoundConversionExpression conversion && conversion.Type == valueType
                ? conversion.Expression
                : cp.Value;
            if (patternValue.Type == TypeSymbol.Float32 || patternValue.Type == TypeSymbol.Float64)
            {
                loadValue();
                if (isValueNullable)
                {
                    this.il.OpCode(ILOpCode.Box);
                    this.il.Token(this.outer.memberRefs.GetElementTypeToken(valueType));
                }

                this.il.OpCode(ILOpCode.Isinst);
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(patternValue.Type));
                var typeMatched = this.il.DefineLabel();
                this.il.OpCode(ILOpCode.Dup);
                this.il.Branch(ILOpCode.Brtrue, typeMatched);
                this.il.OpCode(ILOpCode.Pop);
                this.il.Branch(ILOpCode.Br, failLabel);
                this.il.MarkLabel(typeMatched);
                this.il.OpCode(ILOpCode.Unbox_any);
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(patternValue.Type));
                this.EmitExpression(patternValue);
                this.il.OpCode(ILOpCode.Ceq);
                this.il.Branch(ILOpCode.Brfalse, failLabel);
                return;
            }

            loadValue();
            if (isValueNullable)
            {
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(valueType));
            }

            this.EmitExpression(cp.Value);
            if (isValueNullable)
            {
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(valueType));
            }

            this.il.Call(this.outer.wellKnown.GetObjectStaticEqualsReference());
            this.il.Branch(ILOpCode.Brfalse, failLabel);
            return;
        }

        // int / bool / other primitives lowered to ceq + brfalse.
        loadValue();
        this.EmitExpression(cp.Value);
        this.il.OpCode(ILOpCode.Ceq);
        this.il.Branch(ILOpCode.Brfalse, failLabel);
    }

    private void EmitTypePattern(BoundTypePattern tp, Action loadValue, TypeSymbol sourceType, LabelHandle failLabel)
    {
        // Strategy (uniform for ref + value targets):
        //   loadValue();
        //   if value-typed source: box;
        //   isinst targetType;     // [boxed-or-null]
        //   stloc scratch;
        //   ldloc scratch;
        //   brfalse failLabel;     // empty stack on failure path
        //   ldloc scratch;
        //   (value type) unbox.any | (ref type) leave as-is;
        //   stloc Variable
        //
        // Issue #420 (P3-2): the strategy above is INVALID when the
        // pattern target is `Nullable<T>` over a value type (i.e.
        // `NullableTypeSymbol` wrapping a CLR value type, which
        // `GetElementTypeToken` tokenises as `System.Nullable<T>`).
        // ECMA-335 §I.8.2.4 / §III.4.32 gives `Nullable<T>` special
        // boxing semantics: a non-null nullable boxes as a boxed `T`
        // (not as a boxed `Nullable<T>`), and a null nullable boxes
        // as the null reference. Consequently `isinst Nullable<T>`
        // is effectively never true at run time — a boxed value
        // either presents as `T` (matching `case T`) or as null.
        // Nullable-over-reference-type, by contrast, tokenises as
        // the bare underlying reference type and is handled
        // correctly by the strategy above.
        //
        // The binder today does not narrow a type pattern onto a
        // `Nullable<value-type>` target (type patterns narrow on the
        // underlying type), so this branch is unreachable from
        // surface syntax; this guard exists so that any future binder
        // change that lifts that restriction is forced to revisit the
        // emit strategy before this branch is entered with malformed
        // assumptions.
        if (tp.TargetType is NullableTypeSymbol nullableTarget
            && nullableTarget.UnderlyingType?.ClrType is { IsValueType: true })
        {
            throw new InvalidOperationException(
                $"Type-pattern emit does not support a Nullable<T> target type ('{tp.TargetType.Name}') over a value type. " +
                "Per ECMA-335 the CLR boxes Nullable<T> as a boxed T (or null), so 'isinst Nullable<T>' " +
                "would never match the boxed value; revisit EmitTypePattern before allowing this shape (issue #420 / P3-2).");
        }

        var scratch = this.typePatternScratchSlots[tp];
        loadValue();

        // A value-typed source must be boxed before `isinst`. So must a bare
        // (unconstrained / class-constrained) type-parameter source: `isinst`
        // over an unboxed `!!T` is unverifiable ("Expected an ObjRef on the
        // stack, found T"), and `box !!T` is a verifiable no-op for a
        // reference-type closure — the same rule EmitSimpleTypeIsExpression
        // applies to `value is T`. ADR-0166 routes binding type tests over a
        // type parameter (`if value is IDisposable d`) through this path.
        var boxNeeded = ReflectionMetadataEmitter.IsValueTypeSymbol(sourceType);
        var boxType = sourceType;
        if (!boxNeeded)
        {
            if (sourceType is TypeParameterSymbol)
            {
                boxNeeded = true;
            }
            else if (sourceType is NullableTypeSymbol { UnderlyingType: TypeParameterSymbol underlyingTypeParameter })
            {
                boxNeeded = true;
                boxType = underlyingTypeParameter;
            }
        }

        if (boxNeeded)
        {
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(boxType));
        }

        this.il.OpCode(ILOpCode.Isinst);
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(tp.TargetType));
        this.il.StoreLocal(scratch);
        this.il.LoadLocal(scratch);
        this.il.Branch(ILOpCode.Brfalse, failLabel);

        // Bind the narrowed value into Variable.
        //
        // Issue #2335 (audit follow-up): a bare (any-constraint) open
        // TYPE-PARAMETER pattern target — not just the struct/value-type-
        // constrained shape that motivated this issue — cannot pick between
        // `unbox.any` and `castclass` from its declared constraint alone: an
        // UNCONSTRAINED (or class/interface-constrained) `T` may still close
        // over a value type at a given call site (e.g. `case v is T` inside
        // `func F[T](value object, fallback T) T`, instantiated as
        // `F[int32]`), and `castclass !!T` is invalid IL — and silently wrong
        // at runtime under the JIT's shared generic-code instantiation — for
        // that closure. Per ECMA-335 III.4.32, `unbox.any` degrades to the
        // exact `castclass` behavior when the closed type is a reference
        // type, so it is the single opcode that is correct for every
        // constraint/closure combination. Route every bare type-parameter
        // target through it, in addition to the concrete value-type target
        // shapes `IsValueTypeSymbol` already recognises (struct, enum,
        // tuple, struct-constrained type parameter, etc.).
        this.il.LoadLocal(scratch);
        if (ReflectionMetadataEmitter.IsValueTypeSymbol(tp.TargetType) || tp.TargetType is TypeParameterSymbol)
        {
            this.il.OpCode(ILOpCode.Unbox_any);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(tp.TargetType));
        }
        else if (tp.TargetType.ClrType?.IsSameAs(typeof(object)) != true)
        {
            this.il.OpCode(ILOpCode.Castclass);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(tp.TargetType));
        }

        this.EmitStoreVariable(tp.Variable);

        if (tp.PropertyPattern != null)
        {
            var variableSlot = this.locals[tp.Variable];
            this.EmitPropertyPattern(
                tp.PropertyPattern,
                loadValue: () => this.il.LoadLocal(variableSlot),
                valueType: tp.TargetType,
                failLabel);
        }
    }

    private void EmitPropertyPattern(BoundPropertyPattern pp, Action loadValue, TypeSymbol valueType, LabelHandle failLabel)
    {
        int? receiverSlot = null;
        if (pp.InputVariable != null)
        {
            receiverSlot = this.locals[pp.InputVariable];
            loadValue();
            this.il.StoreLocal(receiverSlot.Value);
        }

        var receiverType = valueType;
        if (valueType is NullableTypeSymbol nullableValueType)
        {
            if (NullableLifting.IsAnyValueTypeNullable(nullableValueType))
            {
                var inputSlot = receiverSlot
                    ?? throw new InvalidOperationException("Nullable value property pattern requires an input slot.");
                this.il.LoadLocal(inputSlot);
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(nullableValueType));
                this.il.Branch(ILOpCode.Brfalse, failLabel);

                // The pattern allocates UnwrappedVariable under exactly the
                // condition tested above, but against its own Type rather than
                // the discriminant's; the two agree by construction.
                var unwrapped = Invariant.Required(
                    pp.UnwrappedVariable,
                    "a property pattern over a nullable value type allocates an unwrapped-value local");
                receiverSlot = this.locals[unwrapped];
                this.il.LoadLocalAddress(inputSlot);
                if (NullableLifting.RequiresSymbolicNullableGetValue(nullableValueType))
                {
                    this.il.OpCode(ILOpCode.Call);
                    this.il.Token(this.outer.memberRefs.GetNullableGetValueMemberRefForUserValueType(nullableValueType));
                }
                else
                {
                    var underlyingClr = nullableValueType.UnderlyingType.ClrType
                        ?? throw new InvalidOperationException(
                            $"Nullable property-pattern input '{nullableValueType}' has no CLR underlying type.");
                    this.il.OpCode(ILOpCode.Call);
                    this.il.Token(this.outer.wellKnown.GetNullableGetValueOrDefaultReference(underlyingClr));
                }

                this.il.StoreLocal(receiverSlot.Value);
            }
            else
            {
                if (receiverSlot.HasValue)
                {
                    this.il.LoadLocal(receiverSlot.Value);
                }
                else
                {
                    loadValue();
                }

                this.il.Branch(ILOpCode.Brfalse, failLabel);
            }

            receiverType = nullableValueType.UnderlyingType;
        }
        else if (!ReflectionMetadataEmitter.IsValueTypeSymbol(valueType))
        {
            // Recursive patterns reject null even when the source annotation is
            // non-nullable; runtime values can still arrive from oblivious code.
            if (receiverSlot.HasValue)
            {
                this.il.LoadLocal(receiverSlot.Value);
            }
            else
            {
                loadValue();
            }

            // A bare type-parameter value is not a verifiable `brfalse` operand
            // (ADR-0166: `value is { } present` over `T`); box it first — a
            // no-op for a reference-type closure, and a value-type closure can
            // never be null so the branch simply falls through.
            if (valueType is TypeParameterSymbol)
            {
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(valueType));
            }

            this.il.Branch(ILOpCode.Brfalse, failLabel);
        }

        Action loadReceiver;
        if (receiverSlot.HasValue)
        {
            var slot = receiverSlot.Value;
            loadReceiver = ReflectionMetadataEmitter.IsValueTypeSymbol(receiverType)
                ? () => this.il.LoadLocalAddress(slot)
                : () => this.il.LoadLocal(slot);
        }
        else
        {
            loadReceiver = loadValue;
        }

        if (receiverType is TupleTypeSymbol tupleType)
        {
            // Issue #1887: cs2gs lowers a C# positional pattern over a raw
            // tuple to a G# property pattern keyed on the tuple's Item1..ItemN
            // fields. ValueTuple exposes those as public fields, so each field
            // is a plain ldfld — same token resolution as EmitTupleElementAccess.
            var tupleClr = tupleType.ClrType;
            foreach (var field in pp.Fields)
            {
                var fieldName = field.Name;
                Action loadTupleChild = () =>
                {
                    if (tupleClr == null)
                    {
                        var index = int.Parse(
                            fieldName.AsSpan("Item".Length),
                            System.Globalization.CultureInfo.InvariantCulture) - 1;
                        this.EmitSymbolicTupleElementAccess(
                            tupleType,
                            index,
                            loadReceiver,
                            takeRestAddress: false);
                    }
                    else
                    {
                        loadReceiver();
                        this.il.OpCode(ILOpCode.Ldfld);
                        if (tupleClr.IsConstructedGenericType)
                        {
                            this.il.Token(this.outer.memberRefs.GetFieldReferenceOnConstructedGeneric(tupleClr, fieldName));
                        }
                        else
                        {
                            var clrField = tupleClr.GetField(fieldName)
                                ?? throw new InvalidOperationException(
                                    $"ValueTuple type '{tupleClr.FullName}' has no public field '{fieldName}'.");
                            this.il.Token(this.outer.memberRefs.GetFieldReference(clrField));
                        }
                    }
                };

                this.EmitPattern(field.Pattern, loadTupleChild, field.Type, failLabel);
            }

            return;
        }

        foreach (var field in pp.Fields)
        {
            if (field.IsProperty)
            {
                this.EmitPropertyPatternMember(field, receiverType, loadReceiver);
                var memberSlot = this.locals[field.ValueVariable];
                this.il.StoreLocal(memberSlot);
                this.EmitPattern(field.Pattern, () => this.il.LoadLocal(memberSlot), field.Type, failLabel);
            }
            else
            {
                Action loadMember = () => this.EmitPropertyPatternMember(field, receiverType, loadReceiver);
                this.EmitPattern(field.Pattern, loadMember, field.Type, failLabel);
            }
        }
    }

    private void EmitPropertyPatternMember(
        BoundPropertyPatternField field,
        TypeSymbol receiverType,
        Action loadReceiver)
    {
        var receiverIsValueType = ReflectionMetadataEmitter.IsValueTypeSymbol(receiverType);
        if (field.ClrMember != null)
        {
            switch (field.ClrMember)
            {
                case PropertyInfo property:
                    var getter = ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(
                        property,
                        wantSetter: false)
                        ?? throw new InvalidOperationException(
                            $"Property '{property.DeclaringType?.FullName}.{property.Name}' has no public getter.");
                    loadReceiver();
                    this.il.OpCode(receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
                    this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(getter, receiverType));
                    if (!this.outer.userTokens.TryGetSymbolicSubstitutedPropertyReturn(receiverType, property, out _))
                    {
                        this.EmitErasedObjectReturnWidening(
                            TypeSymbol.FromClrType(getter.ReturnType),
                            field.Type);
                    }

                    return;
                case FieldInfo clrField:
                    loadReceiver();
                    this.il.OpCode(ILOpCode.Ldfld);
                    this.il.Token(this.outer.memberRefs.GetFieldReference(clrField));
                    return;
                default:
                    throw new NotSupportedException(
                        $"CLR property-pattern member '{field.ClrMember.GetType().Name}' is not supported.");
            }
        }

        if (field.Property != null)
        {
            EntityHandle getterHandle;
            var declaringStruct = field.DeclaringType as StructSymbol;
            var receiverStruct = receiverType as StructSymbol;
            var getterContainer = ResolvePropertyReferenceContainer(
                declaringStruct,
                receiverStruct,
                field.Property);
            if (getterContainer != null)
            {
                getterHandle = this.outer.userTokens.ResolveUserPropertyAccessorToken(
                    getterContainer,
                    field.Property,
                    wantSetter: false);
            }
            else if (this.outer.cache.PropertyAccessorHandles.TryGetValue(field.Property, out var handles)
                && handles.Getter.HasValue)
            {
                getterHandle = handles.Getter.Value;
            }
            else if (declaringStruct?.ClrType != null)
            {
                getterHandle = this.outer.userTokens.ResolveUserPropertyAccessorToken(
                    declaringStruct,
                    field.Property,
                    wantSetter: false);
            }
            else
            {
                throw new InvalidOperationException(
                    $"Property pattern property '{field.Property.Name}' has no emitted getter.");
            }

            loadReceiver();
            this.il.OpCode(receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
            this.il.Token(getterHandle);
            return;
        }

        // Neither the CLR-member nor the property form matched, so this is the
        // field form: every constructor sets exactly one of ClrMember, Property
        // and Field, from a non-nullable parameter.
        var patternField = Invariant.Required(
            field.Field,
            "a property-pattern member that is neither CLR-backed nor property-backed is field-backed");

        EntityHandle fieldHandle;
        var fieldContainer = ResolveFieldReferenceContainer(
            field.DeclaringType as StructSymbol,
            receiverType as StructSymbol,
            patternField);
        if (fieldContainer != null)
        {
            fieldHandle = this.outer.userTokens.ResolveFieldToken(fieldContainer, patternField);
        }
        else if (this.outer.cache.StructFieldDefs.TryGetValue(patternField, out var fieldDefinition))
        {
            fieldHandle = fieldDefinition;
        }
        else
        {
            throw new InvalidOperationException(
                $"Property pattern field '{patternField.Name}' has no emitted field token.");
        }

        loadReceiver();
        this.il.OpCode(ILOpCode.Ldfld);
        this.il.Token(fieldHandle);
    }

    private void EmitRelationalPattern(BoundRelationalPattern rp, Action loadValue, LabelHandle failLabel)
    {
        loadValue();
        this.EmitExpression(rp.Value);

        // For unsigned/char discriminants the signed opcodes mis-order
        // values whose high bit is set (e.g. uint.MaxValue would compare
        // as -1 under Clt). Always use the *_un variants.
        //
        // For float/double, match the IEEE-aware lowering Roslyn uses
        // for C# relational operators: NaN must compare unordered with
        // every value, so strict `<`/`>` keep the signed Clt/Cgt (which
        // return 0 when an operand is NaN), but `<=`/`>=` — which we
        // synthesize as `!(a > b)` / `!(a < b)` — must use the _un
        // forms so the negation produces false for NaN instead of true.
        bool isUnsigned = IsUnsignedOrChar(rp.Type);
        bool isFloat = rp.Type == TypeSymbol.Float32 || rp.Type == TypeSymbol.Float64;
        switch (rp.Op.Kind)
        {
            case BoundBinaryOperatorKind.Equals:
                this.il.OpCode(ILOpCode.Ceq);
                break;
            case BoundBinaryOperatorKind.NotEquals:
                this.il.OpCode(ILOpCode.Ceq);
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
                break;
            case BoundBinaryOperatorKind.Less:
                this.il.OpCode(isUnsigned ? ILOpCode.Clt_un : ILOpCode.Clt);
                break;
            case BoundBinaryOperatorKind.LessOrEquals:
                this.il.OpCode(isUnsigned || isFloat ? ILOpCode.Cgt_un : ILOpCode.Cgt);
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
                break;
            case BoundBinaryOperatorKind.Greater:
                this.il.OpCode(isUnsigned ? ILOpCode.Cgt_un : ILOpCode.Cgt);
                break;
            case BoundBinaryOperatorKind.GreaterOrEquals:
                this.il.OpCode(isUnsigned || isFloat ? ILOpCode.Clt_un : ILOpCode.Clt);
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
                break;
            default:
                throw new NotSupportedException(
                    $"Relational pattern operator '{rp.Op.Kind}' is not supported by the emitter.");
        }

        this.il.Branch(ILOpCode.Brfalse, failLabel);
    }

    private void EmitListPattern(BoundListPattern lp, Action loadValue, LabelHandle failLabel)
    {
        // Issue #1505: a list pattern may contain a single slice ("rest")
        // subpattern. Without a slice, the length is strict-equal to the element
        // count and elements are indexed 0..N-1 from the start. With a slice at
        // index `prefix`, require length >= prefix + suffix, match the prefix
        // elements from the start and the suffix elements from the end, and
        // (for a captured / sub-patterned slice) materialize the middle slice.
        var sliceIndex = -1;
        for (var i = 0; i < lp.Elements.Length; i++)
        {
            if (lp.Elements[i] is BoundSlicePattern)
            {
                sliceIndex = i;
                break;
            }
        }

        if (sliceIndex < 0)
        {
            loadValue();
            this.il.OpCode(ILOpCode.Ldlen);
            this.il.OpCode(ILOpCode.Conv_i4);
            this.il.LoadConstantI4(lp.Elements.Length);
            this.il.OpCode(ILOpCode.Ceq);
            this.il.Branch(ILOpCode.Brfalse, failLabel);

            for (var i = 0; i < lp.Elements.Length; i++)
            {
                var index = i;
                Action loadElement = () =>
                {
                    loadValue();
                    this.il.LoadConstantI4(index);
                    this.EmitLoadElement(lp.ElementType);
                };

                this.EmitPattern(lp.Elements[index], loadElement, lp.ElementType, failLabel);
            }

            return;
        }

        var prefix = sliceIndex;
        var suffix = lp.Elements.Length - sliceIndex - 1;

        // Require length >= prefix + suffix: fail when len < (prefix + suffix).
        loadValue();
        this.il.OpCode(ILOpCode.Ldlen);
        this.il.OpCode(ILOpCode.Conv_i4);
        this.il.LoadConstantI4(prefix + suffix);
        this.il.OpCode(ILOpCode.Clt);
        this.il.Branch(ILOpCode.Brtrue, failLabel);

        // Prefix elements indexed from the start: 0 .. prefix-1.
        for (var i = 0; i < prefix; i++)
        {
            var index = i;
            Action loadElement = () =>
            {
                loadValue();
                this.il.LoadConstantI4(index);
                this.EmitLoadElement(lp.ElementType);
            };

            this.EmitPattern(lp.Elements[index], loadElement, lp.ElementType, failLabel);
        }

        // Suffix elements indexed from the end: element[sliceIndex+1+k] sits at
        // array index len - (suffix - k).
        for (var k = 0; k < suffix; k++)
        {
            var fromEnd = suffix - k;
            var element = lp.Elements[sliceIndex + 1 + k];
            Action loadElement = () =>
            {
                loadValue();
                loadValue();
                this.il.OpCode(ILOpCode.Ldlen);
                this.il.OpCode(ILOpCode.Conv_i4);
                this.il.LoadConstantI4(fromEnd);
                this.il.OpCode(ILOpCode.Sub);
                this.EmitLoadElement(lp.ElementType);
            };

            this.EmitPattern(element, loadElement, lp.ElementType, failLabel);
        }

        var slice = (BoundSlicePattern)lp.Elements[sliceIndex];
        if (slice.Variable != null)
        {
            var elementToken = this.outer.memberRefs.GetElementTypeToken(lp.ElementType);

            // dst = new T[len - (prefix + suffix)]
            loadValue();
            this.il.OpCode(ILOpCode.Ldlen);
            this.il.OpCode(ILOpCode.Conv_i4);
            this.il.LoadConstantI4(prefix + suffix);
            this.il.OpCode(ILOpCode.Sub);
            this.il.OpCode(ILOpCode.Newarr);
            this.il.Token(elementToken);
            this.EmitStoreVariable(slice.Variable);

            // Array.Copy(src, prefix, dst, 0, len - (prefix + suffix))
            loadValue();
            this.il.LoadConstantI4(prefix);
            this.EmitLoadVariable(slice.Variable);
            this.il.LoadConstantI4(0);
            loadValue();
            this.il.OpCode(ILOpCode.Ldlen);
            this.il.OpCode(ILOpCode.Conv_i4);
            this.il.LoadConstantI4(prefix + suffix);
            this.il.OpCode(ILOpCode.Sub);
            this.il.Call(this.outer.wellKnown.GetArrayCopyRangeReference());

            if (slice.Pattern != null)
            {
                var sliceType = SliceTypeSymbol.Get(lp.ElementType);
                this.EmitPattern(slice.Pattern, () => this.EmitLoadVariable(slice.Variable), sliceType, failLabel);
            }
        }
    }

    // Issue #992: combinator emit.
    //
    // `and` (conjunction): both sub-patterns must match. Emit the left with the
    // outer fail label, then the right with the same fail label. Either failing
    // branches to failLabel; falling through both means a match.
    //
    // `or` (disjunction): either sub-pattern matching succeeds (short-circuit).
    // Emit the left with a local "try-right" fail label; if it falls through
    // (match) jump to a local match label. Otherwise emit the right with the
    // outer fail label. A match on either path lands on the match label.
    private void EmitBinaryPattern(BoundBinaryPattern bp, Action loadValue, TypeSymbol valueType, LabelHandle failLabel)
    {
        if (bp.IsConjunction)
        {
            this.EmitPattern(bp.Left, loadValue, valueType, failLabel);
            if (bp.RightInputVariable != null)
            {
                var rightInputSlot = this.locals[bp.RightInputVariable];
                this.EmitPattern(
                    bp.Right,
                    loadValue: () => this.il.LoadLocal(rightInputSlot),
                    valueType: bp.RightInputVariable.Type,
                    failLabel);
            }
            else
            {
                this.EmitPattern(bp.Right, loadValue, valueType, failLabel);
            }

            return;
        }

        var matchLabel = this.il.DefineLabel();
        var tryRight = this.il.DefineLabel();
        this.EmitPattern(bp.Left, loadValue, valueType, tryRight);
        this.il.Branch(ILOpCode.Br, matchLabel);
        this.il.MarkLabel(tryRight);
        this.EmitPattern(bp.Right, loadValue, valueType, failLabel);
        this.il.MarkLabel(matchLabel);
    }

    // `not P` matches when P does not. Emit P with a local "P-did-not-match"
    // label; if P falls through (matched) jump to the outer fail label. The
    // binder forbids variable bindings under `not`, so the sub-pattern stores
    // nothing that could be read on the matched (i.e. failing) path.
    private void EmitNotPattern(BoundNotPattern np, Action loadValue, TypeSymbol valueType, LabelHandle failLabel)
    {
        var notMatched = this.il.DefineLabel();
        this.EmitPattern(np.Pattern, loadValue, valueType, notMatched);
        this.il.Branch(ILOpCode.Br, failLabel);
        this.il.MarkLabel(notMatched);
    }
}
