// <copyright file="DeclarationBinder.Interfaces.3.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Extracted from <see cref="Binder"/> in PR-B-8. Owns every per-declaration-kind
/// binder: type aliases, named delegates, enums, structs (including the large
/// <c>BindStructDeclarationBody</c> driver and its interface-implementation
/// verification pass), interfaces, free / member / extension functions,
/// constructors (<c>init</c>) plus the <c>: base(...)</c> initializer
/// resolver, the two symbol-construction <c>BindVariableDeclaration</c>
/// overloads, generic-parameter binding (<c>BindTypeParameterList</c>), the
/// declaration-side attribute binder (<c>BindAttributes</c>/<c>BindAttribute</c>),
/// and the queue of pending struct→interface implementation checks. The
/// expression binder and most type-name resolution remain on
/// <see cref="Binder"/> and are invoked via the delegate callbacks supplied to
/// the constructor; the same is true for <c>BindBlockStatement</c>-driven
/// body binding (which happens later, in <c>BindProgram</c>, not here).
/// </summary>

internal sealed partial class DeclarationBinder
{


    /// <summary>
    /// Resolves a non-keyword type-parameter constraint (anything other than
    /// <c>any</c> / <c>comparable</c>) as an interface bound and records it on
    /// <paramref name="symbol"/>.
    /// <para>
    /// Phase 4.2b / ADR-0020 originally accepted only a G#-declared sealed
    /// interface. ADR-0089 added constructed generic G# interfaces carrying
    /// static-virtual members (e.g. <c>[T IAdd[T]]</c>). Issue #943 generalised
    /// this to any imported CLR interface — generic or not. Issue #1052 removes
    /// the last restriction: ANY user-declared interface (sealed or not, generic
    /// or not, including the self-referential <c>[T IFace[T]]</c> shape) is a
    /// legal constraint, so the canonical C# <c>where T : IComparable&lt;T&gt;</c>
    /// shape binds, dispatches instance members, and emits verifiable IL. The
    /// constraint type clause is bound through the regular type binder, so a
    /// self-referential type argument (the type parameter appearing in its own
    /// constraint) resolves against the in-flight scope published by
    /// <see cref="BindTypeParameterList(TypeParameterListSyntax)"/>.
    /// </para>
    /// </summary>
    /// <param name="p">The type-parameter syntax carrying the constraint.</param>
    /// <param name="symbol">The bare type-parameter symbol to annotate.</param>
    private void ResolveInterfaceConstraint(TypeParameterSyntax p, TypeParameterSymbol symbol)
    {
        var constraintClause = new TypeClauseSyntax(
            p.SyntaxTree,
            openBracketToken: null,
            lengthToken: null,
            closeBracketToken: null,
            identifier: p.Constraint,
            typeArgumentOpenBracketToken: p.ConstraintTypeArgumentOpenBracketToken,
            typeArguments: p.ConstraintTypeArguments,
            typeArgumentCloseBracketToken: p.ConstraintTypeArgumentCloseBracketToken,
            questionToken: null);

        var resolved = bindTypeClause(constraintClause);
        if (resolved == null || ReferenceEquals(resolved, TypeSymbol.Error))
        {
            // bindTypeClause already reported the failure (e.g. undefined type).
            return;
        }

        if (resolved is InterfaceSymbol iface)
        {
            // Issue #1052: ANY user-declared interface — sealed or not, generic
            // or not, including the self-referential `[T IFace[T]]` shape — is a
            // legal constraint, matching imported CLR interfaces and C#'s
            // `where T : IFoo`. The former `sealed`-only gate (Phase 4.2b /
            // ADR-0020) was a stale restriction; instance members still bind on
            // `T` via the constraint and a GenericParamConstraint metadata row is
            // emitted pointing at the interface TypeDef so the IL verifies.
            symbol.InterfaceConstraint = iface;
            return;
        }

        // Issue #943: an imported CLR interface (generic or not). Reference-set
        // interfaces are universally implementable, so no sealedness rule
        // applies; the GenericParamConstraint metadata row carries the bound.
        if (resolved.ClrType is { IsInterface: true })
        {
            symbol.ClrInterfaceConstraint = resolved;
            return;
        }

        // Issue #1056: a base-class (non-interface) constraint, mirroring C#'s
        // `where T : BaseClass`. The single legacy constraint slot structurally
        // enforces C#'s at-most-one-class rule. Accept a user-declared class
        // (a `StructSymbol` with `IsClass`, open or sealed, generic or not —
        // including the self-referential `[T Box]` / `[T Box[T]]` shapes) and an
        // imported reference-type class. Instance members declared on the base
        // class bind on values of `T` and a GenericParamConstraint metadata row
        // is emitted pointing at the class so the IL verifies. A value type
        // (struct/enum) is still rejected (C# forbids `where T : SomeStruct`).
        if (resolved is StructSymbol { IsClass: true })
        {
            symbol.ClassConstraint = resolved;
            return;
        }

        if (resolved.ClrType is { IsClass: true, IsValueType: false })
        {
            symbol.ClassConstraint = resolved;
            return;
        }

        // Resolved to something that is not a legal constraint (a struct, enum,
        // or other value type).
        Diagnostics.ReportConstraintNotInterface(p.Constraint.Location, resolved.Name);
    }
}
