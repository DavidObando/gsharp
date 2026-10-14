// <copyright file="ConversionEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

/// Conversion-shaped IL emission. Pairs structurally with the binder-side
/// `ConversionClassifier` (PR-B-3): the classifier produces a typed
/// bound representation of every conversion path; this emitter renders
/// those bound nodes into IL.
/// @remarks PR-E-5 introduces this component. Per the decomposition plan, the
/// conversion-emit surface is split between two host types in the
/// pre-refactor source:
///
/// - Stateless, top-level helpers on (cref:ReflectionMetadataEmitter) (`EmitBoxIfNeeded`,
/// `EmitDefaultValue`) that take an (cref:InstructionEncoder) as a parameter and do not depend on
/// per-method body-emit state. <strong>These move here.</strong>
/// - Body-emit-internal methods inside `BodyEmitter` (`EmitConversion`,
/// `EmitErasedObjectReturnWidening`, `EmitNarrowingTruncationIfNeeded`, `EmitSubI4Truncation`,
/// `EmitDefault`, `EmitClrConversionCall`, `EmitZeroInit`) that reference `BodyEmitter`'s private `il`,
/// `defaultExpressionSlots`, and call back into `EmitExpression` and the closure-emit helpers
/// (`EmitFunctionToDelegateConversion`, `EmitFunctionLiteral`, `EmitMethodGroup`,
/// `EmitCapturedVariableLoad`). <strong>These are deferred to PR-E-11
/// <c>MethodBodyEmitter</c></strong>, where `BodyEmitter` is promoted to its own top-level type with
/// its own partials (including `MethodBodyEmitter.Conversions.cs`). Moving them in PR-E-5 would require
/// widening `BodyEmitter`'s private surface to expose all of those collaborators through an
/// `IBodyEmitContext` interface, only to take it apart again in PR-E-11 — and the closure-conversion
/// path itself fans out into helpers that belong with PR-E-9 `ClosureEmitter`. Both methods are
/// exercised by `RefactoringBaselineTests`; the deferral keeps the IL byte-identical gate trivially
/// satisfied here.
///
/// Like every other PR-E-* component, `ConversionEmitter` is
/// `internal sealed` and constructor-injected. It receives the same
/// (cref:EmitContext), (cref:MetadataTokenCache), and
/// (cref:WellKnownReferences) as its peers, plus a
/// `Func<TypeSymbol, EntityHandle>` bound to
/// `ReflectionMetadataEmitter`'s `GetElementTypeToken`. That
/// callback mirrors the `needsRvalueReceiverSpill` delegate that
/// PR-E-4 (cref:SlotPlanner) uses to avoid taking a hard
/// back-reference to the root emitter.
internal class ConversionEmitter {
    private let emitCtx EmitContext
    private let cache MetadataTokenCache
    private let wellKnown WellKnownReferences
    private let getElementTypeToken(TypeSymbol) -> EntityHandle

    init(
        emitCtx EmitContext,
        cache MetadataTokenCache,
        wellKnown WellKnownReferences,
        getElementTypeToken(TypeSymbol) -> EntityHandle
    ) {
        this.emitCtx = emitCtx ?? throw ArgumentNullException("emitCtx")
        this.cache = cache ?? throw ArgumentNullException("cache")
        this.wellKnown = wellKnown ?? throw ArgumentNullException("wellKnown")
        this.getElementTypeToken = getElementTypeToken ?? throw ArgumentNullException("getElementTypeToken")
    }

    /// Emits a `box T` instruction iff [`type`](paramref) is a
    /// value type symbol. The shape mirrors the conditions the binder
    /// records on every boxing conversion (CLR-object widening, interface
    /// upcast of a value type, generic argument materialization on an
    /// erased generic).
    /// @param il Destination instruction encoder.
    /// @param type GSharp type of the value currently on the evaluation stack.
    func EmitBoxIfNeeded(il InstructionEncoder, type TypeSymbol) {
        if ReflectionMetadataEmitter.IsValueTypeSymbol(type) {
            il.OpCode(ILOpCode.Box)
            il.Token(this.getElementTypeToken(type))
            return
        }
        // ADR-0087 §3 R3: a value of type-parameter type may be a
        // value type or reference type at runtime; for callers that
        // need an `object` (e.g. Object.Equals(object,object),
        // HashCode.Add<object>(object), Convert.ToString(object,...)),
        // the CLR requires `box T` to materialise the boxed slot.
        // The JIT eliminates the box when T is statically a reference
        // type at the JIT site.
        if type.StripToBareShape() is TypeParameterSymbol parameter {
            il.OpCode(ILOpCode.Box)
            il.Token(this.getElementTypeToken(parameter))
        }
    }

    /// Pushes a CLR-default value for [`type`](paramref) onto the
    /// evaluation stack. Sits in the conversion-shaped emit surface
    /// alongside (cref:EmitBoxIfNeeded). The pre-refactor source had
    /// no callers for this helper; it is preserved verbatim for parity.
    /// @param il Destination instruction encoder.
    /// @param type CLR type whose default value should be pushed.
    func EmitDefaultValue(il InstructionEncoder, type Type) {
        if type.IsSameAs(typeof(int32)) || type.IsSameAs(typeof(bool)) || type.IsSameAs(typeof(uint8)) || type.IsSameAs(
            typeof(int16)
        ) ||
            type.IsSameAs(typeof(char)) {
            il.LoadConstantI4(0)
        } else if type.IsSameAs(typeof(int64)) {
            il.LoadConstantI8(0)
        } else if type.IsSameAs(typeof(float32)) {
            il.OpCode(ILOpCode.Ldc_r4)
            il.CodeBuilder.WriteSingle(0.0f)
        } else if type.IsSameAs(typeof(float64)) {
            il.OpCode(ILOpCode.Ldc_r8)
            il.CodeBuilder.WriteDouble(0.0)
        } else if type.IsValueType {
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
            il.LoadConstantI4(0)
        } else {
            // Reference types: default is null.
            il.OpCode(ILOpCode.Ldnull)
        }
    }
}
