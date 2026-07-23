// <copyright file="AsyncIteratorDetection.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Single source of truth for "is this an async iterator?" detection and
/// element-type extraction across the async/iterator lowering pipeline.
/// </summary>
/// <remarks>
/// <para>Issue #1489: the async-iterator pipeline historically carried three
/// divergent copies of this predicate. The <see cref="Iterators.AsyncIteratorRewriter"/>
/// recognised the symbolic <see cref="AsyncSequenceTypeSymbol"/> form (issue
/// #798) and the open <see cref="ImportedTypeSymbol"/> form (issue #1002),
/// while <see cref="AsyncStateMachineRewriter"/> and
/// <see cref="AsyncEmitPrecheck"/> keyed off a <em>closed</em> CLR
/// <c>IAsyncEnumerable`1</c> / <c>IAsyncEnumerator`1</c> return type only.</para>
/// <para>For a GENERIC async iterator (<c>async func gen[T](x T) sequence[T]</c>)
/// the return type is an <see cref="AsyncSequenceTypeSymbol"/> over an open
/// type parameter whose <see cref="TypeSymbol.ClrType"/> is <see langword="null"/>,
/// so the CLR-only copies failed to recognise it. The function was then
/// mis-routed into the plain-async state-machine pass (where the method builder
/// could not be resolved) and ultimately reported as <c>GS0190</c>. Routing
/// every site through this helper keeps the three checks in lock-step so the
/// symbolic open-generic form is recognised consistently.</para>
/// </remarks>
public static class AsyncIteratorDetection
{
    /// <summary>
    /// Determines whether <paramref name="function"/> is an async iterator —
    /// one whose body contains <c>yield</c> and whose declared return type is <c>sequence[T]</c>
    /// (<see cref="AsyncSequenceTypeSymbol"/>) or
    /// <c>IAsyncEnumerable[T]</c> / <c>IAsyncEnumerator[T]</c> in any of its
    /// closed-CLR, open-imported, or user-element forms.
    /// </summary>
    /// <param name="function">The function symbol to inspect.</param>
    /// <param name="body">The function's bound body.</param>
    /// <returns><see langword="true"/> when the function is an async iterator.</returns>
    public static bool IsAsyncIteratorFunction(FunctionSymbol function, BoundStatement body)
        => function != null
            && GetElementType(function.Type) != null
            && IteratorDetection.ContainsYield(body);

    /// <summary>
    /// Determines whether <paramref name="type"/> is an async-iterator return
    /// type (see <see cref="IsAsyncIteratorFunction"/>).
    /// </summary>
    /// <param name="type">The candidate return type.</param>
    /// <returns><see langword="true"/> when the type is an async-iterator return type.</returns>
    public static bool IsAsyncIteratorReturnType(TypeSymbol type) => GetElementType(type) != null;

    /// <summary>
    /// Determines whether <paramref name="type"/> is an
    /// <c>IAsyncEnumerable[T]</c> async-iterator return type (as opposed to
    /// <c>IAsyncEnumerator[T]</c>) — only the enumerable form exposes
    /// <c>GetAsyncEnumerator</c>. Recognises the symbolic <c>sequence[T]</c>
    /// alias (<see cref="AsyncSequenceTypeSymbol"/>) and the open
    /// <see cref="ImportedTypeSymbol"/> form so an open type parameter is not
    /// misclassified via the null/erased CLR projection (issue #1489).
    /// </summary>
    /// <param name="type">The candidate async-iterator return type.</param>
    /// <returns><see langword="true"/> for the enumerable form.</returns>
    public static bool IsAsyncEnumerable(TypeSymbol type)
    {
        // sequence[T] in an async return position aliases IAsyncEnumerable<T>.
        if (type is AsyncSequenceTypeSymbol)
        {
            return true;
        }

        if (type is ImportedTypeSymbol imported
            && imported.OpenDefinition?.FullName == "System.Collections.Generic.IAsyncEnumerable`1")
        {
            return true;
        }

        var clr = type?.ClrType;
        if (clr == null || !clr.IsGenericType)
        {
            return false;
        }

        return clr.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IAsyncEnumerable`1";
    }

    /// <summary>
    /// Extracts the element type from an async-iterator return type, honouring
    /// the symbolic forms (issue #798 <see cref="AsyncSequenceTypeSymbol"/>,
    /// issue #1002 open <see cref="ImportedTypeSymbol"/>) so an open type
    /// parameter is preserved rather than collapsed to <c>object</c> via the
    /// CLR-erased projection.
    /// </summary>
    /// <param name="type">The candidate async-iterator return type.</param>
    /// <returns>The element type, or <see langword="null"/> when
    /// <paramref name="type"/> is not an async-iterator return type.</returns>
    public static TypeSymbol GetElementType(TypeSymbol type)
    {
        // Issue #798: `async sequence[T]` (AsyncSequenceTypeSymbol) carries
        // its element symbolically; honor it directly so an open T does not
        // collapse via the ClrType branch.
        if (type is AsyncSequenceTypeSymbol aseq)
        {
            return aseq.ElementType;
        }

        // Issue #1002 (parallel to #990): `IAsyncEnumerable[Shape]` /
        // `IAsyncEnumerator[Shape]` where `Shape` is a same-compilation user
        // class — or any open type parameter — is modelled as an
        // ImportedTypeSymbol carrying the element symbolically in
        // `TypeArguments`. Its `ClrType` is the erased
        // `IAsyncEnumerable<object>`; honour the symbolic argument so the
        // state machine emits the strongly-typed interface rows.
        if (type is ImportedTypeSymbol imported
            && imported.OpenDefinition != null
            && !imported.TypeArguments.IsDefaultOrEmpty
            && imported.TypeArguments.Length == 1
            && (imported.OpenDefinition.FullName == "System.Collections.Generic.IAsyncEnumerable`1"
                || imported.OpenDefinition.FullName == "System.Collections.Generic.IAsyncEnumerator`1"))
        {
            return imported.TypeArguments[0];
        }

        var clr = type?.ClrType;
        if (clr == null || !clr.IsGenericType || clr.IsGenericTypeDefinition)
        {
            return null;
        }

        var def = clr.GetGenericTypeDefinition();
        var fullName = def?.FullName;
        if (fullName == "System.Collections.Generic.IAsyncEnumerable`1"
            || fullName == "System.Collections.Generic.IAsyncEnumerator`1")
        {
            return TypeSymbol.FromClrType(clr.GetGenericArguments()[0]);
        }

        return null;
    }
}
