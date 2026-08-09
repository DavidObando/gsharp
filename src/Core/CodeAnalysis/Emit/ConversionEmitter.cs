// <copyright file="ConversionEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Conversion-shaped IL emission. Pairs structurally with the binder-side
/// <c>ConversionClassifier</c> (PR-B-3): the classifier produces a typed
/// bound representation of every conversion path; this emitter renders
/// those bound nodes into IL.
/// </summary>
/// <remarks>
/// <para>
/// PR-E-5 introduces this component. Per the decomposition plan, the
/// conversion-emit surface is split between two host types in the
/// pre-refactor source:
/// </para>
/// <list type="bullet">
/// <item>
/// Stateless, top-level helpers on <see cref="ReflectionMetadataEmitter"/>
/// (<c>EmitBoxIfNeeded</c>, <c>EmitDefaultValue</c>) that take an
/// <see cref="InstructionEncoder"/> as a parameter and do not depend on
/// per-method body-emit state. <strong>These move here.</strong>
/// </item>
/// <item>
/// Body-emit-internal methods inside <c>BodyEmitter</c>
/// (<c>EmitConversion</c>, <c>EmitErasedObjectReturnWidening</c>,
/// <c>EmitNarrowingTruncationIfNeeded</c>, <c>EmitSubI4Truncation</c>,
/// <c>EmitDefault</c>, <c>EmitClrConversionCall</c>, <c>EmitZeroInit</c>)
/// that reference <c>BodyEmitter</c>'s private <c>il</c>,
/// <c>defaultExpressionSlots</c>, and call back into <c>EmitExpression</c>
/// and the closure-emit helpers (<c>EmitFunctionToDelegateConversion</c>,
/// <c>EmitFunctionLiteral</c>, <c>EmitMethodGroup</c>,
/// <c>EmitCapturedVariableLoad</c>). <strong>These are deferred to PR-E-11
/// <c>MethodBodyEmitter</c></strong>, where <c>BodyEmitter</c> is promoted
/// to its own top-level type with its own partials (including
/// <c>MethodBodyEmitter.Conversions.cs</c>). Moving them in PR-E-5 would
/// require widening <c>BodyEmitter</c>'s private surface to expose all of
/// those collaborators through an <c>IBodyEmitContext</c> interface, only
/// to take it apart again in PR-E-11 — and the closure-conversion path
/// itself fans out into helpers that belong with PR-E-9
/// <c>ClosureEmitter</c>. Both methods are exercised by
/// <c>RefactoringBaselineTests</c>; the deferral keeps the IL byte-identical
/// gate trivially satisfied here.
/// </item>
/// </list>
/// <para>
/// Like every other PR-E-* component, <c>ConversionEmitter</c> is
/// <c>internal sealed</c> and constructor-injected. It receives the same
/// <see cref="EmitContext"/>, <see cref="MetadataTokenCache"/>, and
/// <see cref="WellKnownReferences"/> as its peers, plus a
/// <c>Func&lt;TypeSymbol, EntityHandle&gt;</c> bound to
/// <c>ReflectionMetadataEmitter</c>'s <c>GetElementTypeToken</c>. That
/// callback mirrors the <c>needsRvalueReceiverSpill</c> delegate that
/// PR-E-4 <see cref="SlotPlanner"/> uses to avoid taking a hard
/// back-reference to the root emitter.
/// </para>
/// </remarks>
internal sealed class ConversionEmitter
{
#pragma warning disable IDE0052 // unused; reserved for the deferred BodyEmitter-internal moves landing in PR-E-11
    private readonly EmitContext emitCtx;
    private readonly MetadataTokenCache cache;
    private readonly WellKnownReferences wellKnown;
#pragma warning restore IDE0052
    private readonly Func<TypeSymbol, EntityHandle> getElementTypeToken;

    public ConversionEmitter(
        EmitContext emitCtx,
        MetadataTokenCache cache,
        WellKnownReferences wellKnown,
        Func<TypeSymbol, EntityHandle> getElementTypeToken)
    {
        this.emitCtx = emitCtx ?? throw new ArgumentNullException(nameof(emitCtx));
        this.cache = cache ?? throw new ArgumentNullException(nameof(cache));
        this.wellKnown = wellKnown ?? throw new ArgumentNullException(nameof(wellKnown));
        this.getElementTypeToken = getElementTypeToken ?? throw new ArgumentNullException(nameof(getElementTypeToken));
    }

    /// <summary>
    /// Emits a <c>box T</c> instruction iff <paramref name="type"/> is a
    /// value type symbol. The shape mirrors the conditions the binder
    /// records on every boxing conversion (CLR-object widening, interface
    /// upcast of a value type, generic argument materialization on an
    /// erased generic).
    /// </summary>
    /// <param name="il">Destination instruction encoder.</param>
    /// <param name="type">GSharp type of the value currently on the evaluation stack.</param>
    public void EmitBoxIfNeeded(InstructionEncoder il, TypeSymbol type)
    {
        if (ReflectionMetadataEmitter.IsValueTypeSymbol(type))
        {
            il.OpCode(ILOpCode.Box);
            il.Token(this.getElementTypeToken(type));
            return;
        }

        // ADR-0087 §3 R3: a value of type-parameter type may be a
        // value type or reference type at runtime; for callers that
        // need an `object` (e.g. Object.Equals(object,object),
        // HashCode.Add<object>(object), Convert.ToString(object,...)),
        // the CLR requires `box T` to materialise the boxed slot.
        // The JIT eliminates the box when T is statically a reference
        // type at the JIT site.
        if (type is TypeParameterSymbol)
        {
            il.OpCode(ILOpCode.Box);
            il.Token(this.getElementTypeToken(type));
        }
    }

    /// <summary>
    /// Pushes a CLR-default value for <paramref name="type"/> onto the
    /// evaluation stack. Sits in the conversion-shaped emit surface
    /// alongside <see cref="EmitBoxIfNeeded"/>. The pre-refactor source had
    /// no callers for this helper; it is preserved verbatim for parity.
    /// </summary>
    /// <param name="il">Destination instruction encoder.</param>
    /// <param name="type">CLR type whose default value should be pushed.</param>
    public void EmitDefaultValue(InstructionEncoder il, Type type)
    {
        if (type.IsSameAs(typeof(int)) || type.IsSameAs(typeof(bool)) || type.IsSameAs(typeof(byte))
            || type.IsSameAs(typeof(short)) || type.IsSameAs(typeof(char)))
        {
            il.LoadConstantI4(0);
        }
        else if (type.IsSameAs(typeof(long)))
        {
            il.LoadConstantI8(0);
        }
        else if (type.IsSameAs(typeof(float)))
        {
            il.OpCode(ILOpCode.Ldc_r4);
            il.CodeBuilder.WriteSingle(0.0f);
        }
        else if (type.IsSameAs(typeof(double)))
        {
            il.OpCode(ILOpCode.Ldc_r8);
            il.CodeBuilder.WriteDouble(0.0);
        }
        else if (type.IsValueType)
        {
            // For value types we need initobj pattern but SetResult takes the value
            // by value, not by ref. Use a local initialized to default.
            // Simplified: just push 0 for small structs or use ldloca + initobj.
            // For now, use a simple approach: push ldloca on a temp, initobj, ldloc.
            // Actually, the simplest correct approach: if it's a primitive, handled above.
            // For struct value types, we can't easily push default without a local.
            // Let's use ldloca on the arg slot (but we don't have one).
            // Simplest: we won't support generic Task<CustomStruct> yet.
            // For the common cases (Task<int>, Task<string>, Task<bool>), the above handles it.
            // Fallback: push 0 and hope for the best (works for small value types).
            il.LoadConstantI4(0);
        }
        else
        {
            // Reference types: default is null.
            il.OpCode(ILOpCode.Ldnull);
        }
    }
}
