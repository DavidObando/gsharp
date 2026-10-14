// <copyright file="GTypeReference.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

import System.Collections.Generic
import System.Linq
import System.Runtime.InteropServices

/// Base type for a G# type reference appearing in a type clause
/// (ADR-0115 §B.7, §B.8, §B.12).
abstract class GTypeReference : GNode {
    /// Gets a value indicating whether this type reference is nullable. A
    /// nullable type renders with a trailing `?` per the G# spec (§Type
    /// clauses); both C# nullable value types (`T?` / `Nullable<T>`)
    /// and annotated nullable reference types map to this flag (ADR-0115 §B).
    prop IsNullable bool {
        get;
        init;
    }
}

/// A named type, optionally generic-instantiated with bracket type arguments
/// (`Name[T1, T2]`). Width-bearing primitive names (`int32`,
/// `float64`, …) are ordinary named types per ADR-0115 §B.12.
class NamedTypeReference : GTypeReference {
    /// Initializes a new instance of the (cref:NamedTypeReference) class.
    /// @param name The (possibly dotted) type name.
    /// @param typeArguments The bracket type arguments, if any.
    /// @param containingType The constructed containing type for a nested type, if any.
    init(name string, typeArguments IReadOnlyList[GTypeReference]? = nil, containingType GTypeReference? = nil) {
        Name = name
        TypeArguments = typeArguments ?? List[GTypeReference]()
        ContainingType = containingType
    }

    /// Gets the (possibly dotted) type name.
    prop Name string {
        get;
    }

    /// Gets the bracket type arguments.
    prop TypeArguments IReadOnlyList[GTypeReference] {
        get;
    }

    /// Gets the constructed containing type for a nested type, if any.
    prop ContainingType GTypeReference? {
        get;
    }
}

/// A slice/array type rendered as `[]Element`.
class ArrayTypeReference : GTypeReference {
    /// Initializes a new instance of the (cref:ArrayTypeReference) class.
    /// @param elementType The element type.
    /// @param rank Array rank.
    init(elementType GTypeReference, rank int32 = 1) {
        ElementType = elementType
        Rank = rank
    }

    /// Gets the element type.
    prop ElementType GTypeReference {
        get;
    }

    /// Gets array rank.
    prop Rank int32 {
        get;
    }
}

/// A tuple type rendered as `(T1, T2, …)` — or, when element names are
/// present, the ADR-0172 name-first form `(line int32, column int32)`.
/// C# value tuples (named or unnamed) map to this form with their element
/// names preserved; access by name stays by-name in the output (ADR-0115
/// §B.4 as amended by ADR-0172). At least two element types are required.
class TupleTypeReference : GTypeReference {
    /// Initializes a new instance of the (cref:TupleTypeReference) class.
    /// @param elementTypes The ordered element types.
    /// @param elementNames Optional element names parallel to [`elementTypes`](paramref), null where
    /// unnamed; pass null for a fully unnamed tuple.
    init(elementTypes IReadOnlyList[GTypeReference], elementNames IReadOnlyList[string]? = nil) {
        ElementTypes = elementTypes ?? List[GTypeReference]()
        ElementNames = if elementNames != nil && elementNames.Any((n string) -> n != nil) {
            elementNames
        } else {
            default(IReadOnlyList[string]?)
        }
    }

    /// Gets the ordered element types.
    prop ElementTypes IReadOnlyList[GTypeReference] {
        get;
    }

    /// Gets the element names parallel to (cref:ElementTypes) (`null` entries for unnamed positions), or
    /// `null` when fully unnamed (ADR-0172).
    prop ElementNames IReadOnlyList[string]? {
        get;
    }
}

/// A managed-pointer / byref type rendered in the canonical G# <b>prefix</b>
/// form `*Element` (spec §"Byref/pointer syntax exists as `*T`",
/// grammar `'*' TypeClause '?'?`). A C# postfix `T*` (e.g.
/// `byte*`, `int*`, `void*`) maps to this node; `void*`
/// (no element type) maps to the faithful void-element pointer `*void`
/// (ADR-0122 §3 / issue #1033), distinct from the byte pointer `*uint8`.
/// These appear only on the unsafe Win32 P/Invoke interop surface: the form
/// round-trips through the parser, though the binder later steers callers to
/// `ref`/`out`/`in` (GS0243/GS9006) — the excepted unsafe-interop
/// surface (ADR-0115 §G).
class PointerTypeReference : GTypeReference {
    /// Initializes a new instance of the (cref:PointerTypeReference) class.
    /// @param elementType The pointee (element) type.
    init(elementType GTypeReference) {
        ElementType = elementType
    }

    /// Gets the pointee (element) type.
    prop ElementType GTypeReference {
        get;
    }
}

/// A delegate type in the canonical arrow form `(A, B) -> R`
/// (ADR-0075, ADR-0115 §B.8). A multi-value return spells `-> (T1, T2)`;
/// a void return spells `-> void`; an async delegate spells
/// `async (T) -> R`.
class ArrowTypeReference : GTypeReference {
    /// Initializes a new instance of the (cref:ArrowTypeReference) class.
    /// @param parameterTypes The parameter types.
    /// @param returnTypes The return type(s); more than one renders as a tuple.
    /// @param isAsync Whether the delegate carries the `async` modifier.
    init(
        parameterTypes IReadOnlyList[GTypeReference],
        returnTypes IReadOnlyList[GTypeReference],
        isAsync bool = false
    ) {
        ParameterTypes = parameterTypes ?? List[GTypeReference]()
        ReturnTypes = returnTypes ?? List[GTypeReference]()
        IsAsync = isAsync
    }

    /// Gets the parameter types.
    prop ParameterTypes IReadOnlyList[GTypeReference] {
        get;
    }

    /// Gets the return type(s). More than one renders as a parenthesized tuple.
    prop ReturnTypes IReadOnlyList[GTypeReference] {
        get;
    }

    /// Gets a value indicating whether the delegate is asynchronous.
    prop IsAsync bool {
        get;
    }
}

/// A C# unsafe function-pointer type (`delegate*<...>`, issue #1906),
/// rendered in one of G#'s two function-pointer forms: the <b>managed</b> form
/// `*func(T1, T2) R` (ADR-0122 §9, callable directly via `calli`), or
/// the <b>unmanaged</b> raw form `unmanaged[CC] (T1, T2) -> R`
/// (ADR-0095), whose ABI is given by (cref:CallingConvention).
class FunctionPointerTypeReference : GTypeReference {
    /// Initializes a new instance of the (cref:FunctionPointerTypeReference) class.
    /// @param isManaged Whether this is the managed `*func(T) R` form.
    /// @param callingConvention The unmanaged calling convention; ignored when [`isManaged`](paramref) is
    /// `true`.
    /// @param parameterTypes The function pointer's parameter types.
    /// @param returnType The return type, or `null` for a void-returning pointer.
    init(
        isManaged bool,
        callingConvention CallingConvention,
        parameterTypes IReadOnlyList[GTypeReference],
        returnType GTypeReference
    ) {
        UnmanagedConventions = List[string]()
        IsManaged = isManaged
        CallingConvention = callingConvention
        ParameterTypes = parameterTypes ?? List[GTypeReference]()
        ReturnType = returnType
    }

    /// Initializes a new instance of the (cref:FunctionPointerTypeReference) class
    /// for the open CLR calling-convention model (ADR-0095 v2 / issue #3611):
    /// bare `unmanaged (T) -> R` when [`unmanagedConventions`](paramref)
    /// is empty, otherwise `unmanaged[CC, ...] (T) -> R` with the
    /// convention short names in source order.
    /// @param unmanagedConventions The convention short names in source order (may be empty for the
    /// platform default).
    /// @param parameterTypes The function pointer's parameter types.
    /// @param returnType The return type, or `null` for a void-returning pointer.
    init(
        unmanagedConventions IReadOnlyList[string],
        parameterTypes IReadOnlyList[GTypeReference],
        returnType GTypeReference
    ) {
        UnmanagedConventions = List[string]()
        IsManaged = false
        IsUnmanagedExtended = true
        UnmanagedConventions = unmanagedConventions ?? List[string]()
        ParameterTypes = parameterTypes ?? List[GTypeReference]()
        ReturnType = returnType
    }

    /// Gets a value indicating whether this is the managed `*func(T) R` form.
    prop IsManaged bool {
        get;
    }

    /// Gets a value indicating whether this is the open-model unmanaged form (ADR-0095 v2 / issue #3611):
    /// bare platform-default or a `CallConv*` convention list.
    prop IsUnmanagedExtended bool {
        get;
    }

    /// Gets the open-model convention short names in source order; empty for the bare platform-default
    /// form. Meaningful only when (cref:IsUnmanagedExtended) is `true`.
    prop UnmanagedConventions IReadOnlyList[string] {
        get;
    }

    /// Gets the unmanaged calling convention. Ignored when (cref:IsManaged) or (cref:IsUnmanagedExtended)
    /// is `true`.
    prop CallingConvention CallingConvention {
        get;
    }

    /// Gets the function pointer's parameter types.
    prop ParameterTypes IReadOnlyList[GTypeReference] {
        get;
    }

    /// Gets the return type, or `null` for a void-returning pointer.
    prop ReturnType GTypeReference? {
        get;
    }
}
