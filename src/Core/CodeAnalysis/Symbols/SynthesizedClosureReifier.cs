// <copyright file="SynthesizedClosureReifier.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Issue #1477: shared helper that makes a synthesized closure / capture-box
/// class generic over the enclosing generic type / method type parameters its
/// members reference. When a lambda inside a generic type (or generic method)
/// captures a value whose type references an enclosing type parameter (a
/// <c>T</c>-typed value, or <c>this</c> of <c>G&lt;T&gt;</c>), the synthesized
/// display / box class must declare its OWN type parameters that mirror those
/// enclosing parameters 1:1; otherwise its capture field's <c>VAR</c> slot has
/// no generic parameter in scope, producing an illegal field type
/// (<c>System.TypeLoadException</c> at load) and unverifiable IL.
/// </summary>
/// <remarks>
/// The reification mirrors the iterator / async state-machine treatment
/// (<c>RegisterStateMachineEnclosingGenerics</c>): the synthesized class is
/// reified over fresh class-level type parameters that clone each referenced
/// enclosing parameter, and the original parameters are recorded on
/// <see cref="StructSymbol.ReifiedFromTypeParameters"/> so the emitter can build
/// the outer-TP → own-TP-ordinal remap that routes every member signature
/// through a valid <c>VAR(idx)</c> slot. A constructed instance carrying the
/// original parameters as type arguments is returned for use at the capture
/// site (so the <c>newobj</c> / field stores reference
/// <c>DisplayClass&lt;…enclosing args…&gt;</c>).
/// </remarks>
internal static class SynthesizedClosureReifier
{
    /// <summary>
    /// Collects, in a stable canonical order (enclosing TYPE parameters first
    /// by ordinal, then enclosing METHOD parameters by ordinal), the distinct
    /// type parameters referenced by <paramref name="types"/>.
    /// </summary>
    /// <param name="types">The member / signature types to scan.</param>
    /// <returns>The ordered distinct referenced type parameters; empty when none.</returns>
    public static ImmutableArray<TypeParameterSymbol> CollectOrdered(IEnumerable<TypeSymbol> types)
    {
        var referenced = new List<TypeParameterSymbol>();
        foreach (var t in types)
        {
            TypeSymbol.CollectReferencedTypeParameters(t, referenced);
        }

        if (referenced.Count == 0)
        {
            return ImmutableArray<TypeParameterSymbol>.Empty;
        }

        // Canonical order: class type parameters (Var) before method type
        // parameters (MVar), each by their original ordinal. This keeps the
        // synthesized class's parameter list deterministic regardless of the
        // member-scan order.
        referenced.Sort(static (a, b) =>
        {
            var ak = a.IsMethodTypeParameter ? 1 : 0;
            var bk = b.IsMethodTypeParameter ? 1 : 0;
            if (ak != bk)
            {
                return ak - bk;
            }

            return a.Ordinal - b.Ordinal;
        });

        return referenced.ToImmutableArray();
    }

    /// <summary>
    /// Clones <paramref name="src"/> as a class-level type parameter at
    /// <paramref name="ordinal"/> (carrying its constraints), suitable for
    /// declaration on a synthesized closure / box class.
    /// </summary>
    /// <param name="src">The original enclosing type parameter.</param>
    /// <param name="ordinal">The ordinal for the fresh class type parameter.</param>
    /// <returns>The cloned class type parameter.</returns>
    public static TypeParameterSymbol CloneAsClassTypeParameter(TypeParameterSymbol src, int ordinal)
    {
        return new TypeParameterSymbol(
            src.Name,
            ordinal,
            src.Constraint,
            src.Variance,
            src.InterfaceConstraint)
        {
            HasReferenceTypeConstraint = src.HasReferenceTypeConstraint,
            HasValueTypeConstraint = src.HasValueTypeConstraint,
            HasDefaultConstructorConstraint = src.HasDefaultConstructorConstraint,
            ClrInterfaceConstraint = src.ClrInterfaceConstraint,
            ClassConstraint = src.ClassConstraint,
            IsMethodTypeParameter = false,
        };
    }

    /// <summary>
    /// Reifies <paramref name="definition"/> generic over the
    /// <paramref name="origTPs"/> it references: declares fresh class type
    /// parameters that clone them 1:1, records the originals via
    /// <see cref="StructSymbol.SetReifiedFromTypeParameters"/>, and returns a
    /// constructed instance whose type arguments are the originals (for use at
    /// the capture site). The definition's member signatures continue to
    /// reference the original parameters; the emitter's remap routes them
    /// through the new class slots.
    /// </summary>
    /// <param name="definition">The synthesized closure / box class definition.</param>
    /// <param name="origTPs">The ordered referenced enclosing type parameters.</param>
    /// <returns>The constructed instance over the original parameters.</returns>
    public static StructSymbol Reify(StructSymbol definition, ImmutableArray<TypeParameterSymbol> origTPs)
    {
        var clones = ImmutableArray.CreateBuilder<TypeParameterSymbol>(origTPs.Length);
        for (var i = 0; i < origTPs.Length; i++)
        {
            clones.Add(CloneAsClassTypeParameter(origTPs[i], i));
        }

        definition.SetTypeParameters(clones.MoveToImmutable());
        definition.SetReifiedFromTypeParameters(origTPs);

        var args = ImmutableArray.CreateBuilder<TypeSymbol>(origTPs.Length);
        foreach (var tp in origTPs)
        {
            args.Add(tp);
        }

        return StructSymbol.Construct(definition, args.MoveToImmutable());
    }
}
