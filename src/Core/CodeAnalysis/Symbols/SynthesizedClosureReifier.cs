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
    /// Issue #1499: clones <paramref name="origTPs"/> 1:1 as class-level type
    /// parameters whose constraint reference types are remapped from the
    /// originals onto the freshly cloned set. Uses a TWO-PASS approach:
    /// (1) create every clone (name / ordinal / kind / reference-, value- and
    /// default-constructor-constraint flags / variance) and build the
    /// <c>original → clone</c> substitution map; (2) for each clone substitute
    /// that map into the original's <see cref="TypeParameterSymbol.InterfaceConstraint"/>,
    /// <see cref="TypeParameterSymbol.ClrInterfaceConstraint"/> and
    /// <see cref="TypeParameterSymbol.ClassConstraint"/> so a constraint that
    /// references an original parameter (self-referential <c>T IComparable[T]</c>,
    /// cross-referential <c>T IEnumerable[U]</c> / <c>T Base[U]</c>, or nested
    /// <c>T Base[Dict[T, U]]</c>) instead references the corresponding clone(s).
    /// Because all clones exist before any constraint is rebuilt, interdependent
    /// constraints across the set resolve correctly. Reuses the symbol layer's
    /// <see cref="StructSymbol.SubstituteTypeParameters"/> so the remap walks
    /// generic arguments recursively rather than hand-rolling a partial clone.
    /// </summary>
    /// <param name="origTPs">The ordered enclosing type parameters to clone.</param>
    /// <returns>The cloned type parameters with remapped constraints.</returns>
    public static ImmutableArray<TypeParameterSymbol> CloneWithRemappedConstraints(ImmutableArray<TypeParameterSymbol> origTPs)
    {
        if (origTPs.IsDefaultOrEmpty)
        {
            return ImmutableArray<TypeParameterSymbol>.Empty;
        }

        var clones = new TypeParameterSymbol[origTPs.Length];
        var subst = new Dictionary<TypeParameterSymbol, TypeSymbol>(origTPs.Length);
        for (var i = 0; i < origTPs.Length; i++)
        {
            var src = origTPs[i];

            // Pass 1: create the clone with its simple flags. Constraint
            // reference types are deferred to pass 2 so cross-referential
            // constraints can see every clone before being rebuilt.
            clones[i] = new TypeParameterSymbol(
                src.Name,
                i,
                src.Constraint,
                src.Variance)
            {
                HasReferenceTypeConstraint = src.HasReferenceTypeConstraint,
                HasValueTypeConstraint = src.HasValueTypeConstraint,
                HasDefaultConstructorConstraint = src.HasDefaultConstructorConstraint,
                HasUnmanagedConstraint = src.HasUnmanagedConstraint,
                IsMethodTypeParameter = false,
            };
            subst[src] = clones[i];
        }

        for (var i = 0; i < origTPs.Length; i++)
        {
            var src = origTPs[i];
            var clone = clones[i];

            if (src.InterfaceConstraint != null)
            {
                clone.InterfaceConstraint =
                    StructSymbol.SubstituteTypeParameters(src.InterfaceConstraint, subst) as InterfaceSymbol
                    ?? src.InterfaceConstraint;
            }

            clone.ClrInterfaceConstraint =
                StructSymbol.SubstituteTypeParameters(src.ClrInterfaceConstraint, subst);
            clone.ClassConstraint =
                StructSymbol.SubstituteTypeParameters(src.ClassConstraint, subst);
        }

        return ImmutableArray.Create(clones);
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
    /// <param name="mapClrType">
    /// Issue #2037: optional projector applied to the constructed instance's
    /// CLR type arguments before <c>MakeGenericType</c> (mirrors #1958's
    /// <see cref="StructSymbol.Construct(StructSymbol, ImmutableArray{TypeSymbol}, System.Func{System.Type, System.Type})"/>
    /// fix). Needed when a hoisted capture/state field is typed as an
    /// imported constructed generic over one of <paramref name="origTPs"/>
    /// and the compilation runs under a cross-reflection-context (MLC)
    /// reference set (cs2gs); <see langword="null"/> preserves the
    /// erase-on-mismatch fallback for same-compilation-only callers.
    /// </param>
    /// <returns>The constructed instance over the original parameters.</returns>
    public static StructSymbol Reify(StructSymbol definition, ImmutableArray<TypeParameterSymbol> origTPs, System.Func<System.Type, System.Type> mapClrType = null)
    {
        var clones = CloneWithRemappedConstraints(origTPs);

        definition.SetTypeParameters(clones);
        definition.SetReifiedFromTypeParameters(origTPs);

        var args = ImmutableArray.CreateBuilder<TypeSymbol>(origTPs.Length);
        foreach (var tp in origTPs)
        {
            args.Add(tp);
        }

        return StructSymbol.Construct(definition, args.MoveToImmutable(), mapClrType);
    }
}
