// <copyright file="GTypeReference.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// Base type for a G# type reference appearing in a type clause
/// (ADR-0115 §B.7, §B.8, §B.12).
/// </summary>
public abstract class GTypeReference : GNode
{
    /// <summary>
    /// Gets a value indicating whether this type reference is nullable. A
    /// nullable type renders with a trailing <c>?</c> per the G# spec (§Type
    /// clauses); both C# nullable value types (<c>T?</c> / <c>Nullable&lt;T&gt;</c>)
    /// and annotated nullable reference types map to this flag (ADR-0115 §B).
    /// </summary>
    public bool IsNullable { get; init; }
}

/// <summary>
/// A named type, optionally generic-instantiated with bracket type arguments
/// (<c>Name[T1, T2]</c>). Width-bearing primitive names (<c>int32</c>,
/// <c>float64</c>, …) are ordinary named types per ADR-0115 §B.12.
/// </summary>
public sealed class NamedTypeReference : GTypeReference
{
    /// <summary>
    /// Initializes a new instance of the <see cref="NamedTypeReference"/> class.
    /// </summary>
    /// <param name="name">The (possibly dotted) type name.</param>
    /// <param name="typeArguments">The bracket type arguments, if any.</param>
    public NamedTypeReference(string name, IReadOnlyList<GTypeReference> typeArguments = null)
    {
        Name = name;
        TypeArguments = typeArguments ?? new List<GTypeReference>();
    }

    /// <summary>Gets the (possibly dotted) type name.</summary>
    public string Name { get; }

    /// <summary>Gets the bracket type arguments.</summary>
    public IReadOnlyList<GTypeReference> TypeArguments { get; }
}

/// <summary>
/// A slice/array type rendered as <c>[]Element</c>.
/// </summary>
public sealed class ArrayTypeReference : GTypeReference
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ArrayTypeReference"/> class.
    /// </summary>
    /// <param name="elementType">The element type.</param>
    public ArrayTypeReference(GTypeReference elementType)
    {
        ElementType = elementType;
    }

    /// <summary>Gets the element type.</summary>
    public GTypeReference ElementType { get; }
}

/// <summary>
/// A positional tuple type rendered as <c>(T1, T2, …)</c> (spec §Type syntax,
/// the <c>"(" TypeClause { "," TypeClause } ")"</c> production). C# value tuples
/// (named or unnamed) map to this form; G# tuples are positional, so C# element
/// names are dropped and named element access lowers to <c>.Item1</c>/<c>.Item2</c>
/// (ADR-0115 §B.4). At least two element types are required for a tuple type.
/// </summary>
public sealed class TupleTypeReference : GTypeReference
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TupleTypeReference"/> class.
    /// </summary>
    /// <param name="elementTypes">The ordered element types.</param>
    public TupleTypeReference(IReadOnlyList<GTypeReference> elementTypes)
    {
        ElementTypes = elementTypes ?? new List<GTypeReference>();
    }

    /// <summary>Gets the ordered element types.</summary>
    public IReadOnlyList<GTypeReference> ElementTypes { get; }
}

/// <summary>
/// A managed-pointer / byref type rendered in the canonical G# <b>prefix</b>
/// form <c>*Element</c> (spec §"Byref/pointer syntax exists as <c>*T</c>",
/// grammar <c>'*' TypeClause '?'?</c>). A C# postfix <c>T*</c> (e.g.
/// <c>byte*</c>, <c>int*</c>, <c>void*</c>) maps to this node; <c>void*</c>
/// (no element type) maps to the faithful void-element pointer <c>*void</c>
/// (ADR-0122 §3 / issue #1033), distinct from the byte pointer <c>*uint8</c>.
/// These appear only on the unsafe Win32 P/Invoke interop surface: the form
/// round-trips through the parser, though the binder later steers callers to
/// <c>ref</c>/<c>out</c>/<c>in</c> (GS0243/GS9006) — the excepted unsafe-interop
/// surface (ADR-0115 §G).
/// </summary>
public sealed class PointerTypeReference : GTypeReference
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PointerTypeReference"/> class.
    /// </summary>
    /// <param name="elementType">The pointee (element) type.</param>
    public PointerTypeReference(GTypeReference elementType)
    {
        ElementType = elementType;
    }

    /// <summary>Gets the pointee (element) type.</summary>
    public GTypeReference ElementType { get; }
}

/// <summary>
/// A delegate type in the canonical arrow form <c>(A, B) -&gt; R</c>
/// (ADR-0075, ADR-0115 §B.8). A multi-value return spells <c>-&gt; (T1, T2)</c>;
/// a void return spells <c>-&gt; void</c>; an async delegate spells
/// <c>async (T) -&gt; R</c>.
/// </summary>
public sealed class ArrowTypeReference : GTypeReference
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ArrowTypeReference"/> class.
    /// </summary>
    /// <param name="parameterTypes">The parameter types.</param>
    /// <param name="returnTypes">The return type(s); more than one renders as a tuple.</param>
    /// <param name="isAsync">Whether the delegate carries the <c>async</c> modifier.</param>
    public ArrowTypeReference(
        IReadOnlyList<GTypeReference> parameterTypes,
        IReadOnlyList<GTypeReference> returnTypes,
        bool isAsync = false)
    {
        ParameterTypes = parameterTypes ?? new List<GTypeReference>();
        ReturnTypes = returnTypes ?? new List<GTypeReference>();
        IsAsync = isAsync;
    }

    /// <summary>Gets the parameter types.</summary>
    public IReadOnlyList<GTypeReference> ParameterTypes { get; }

    /// <summary>Gets the return type(s). More than one renders as a parenthesized tuple.</summary>
    public IReadOnlyList<GTypeReference> ReturnTypes { get; }

    /// <summary>Gets a value indicating whether the delegate is asynchronous.</summary>
    public bool IsAsync { get; }
}
