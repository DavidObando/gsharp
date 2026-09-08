// <copyright file="TypeParameterSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// A generic type-parameter declared on a generic function or type (Phase 4.1 / ADR-0020).
/// At the binder level it behaves like a stand-in <see cref="TypeSymbol"/>; at call sites
/// it is substituted with a concrete type argument either from an explicit type-argument
/// list or via inference from value arguments.
/// </summary>
public sealed class TypeParameterSymbol : TypeSymbol
{
    /// <summary>Initializes a new instance of the <see cref="TypeParameterSymbol"/> class.</summary>
    /// <param name="name">The type-parameter name (e.g. <c>T</c>).</param>
    /// <param name="ordinal">The zero-based position of this parameter in its declaring list.</param>
    /// <param name="constraint">The constraint kind (Phase 4.1: only <see cref="TypeParameterConstraint.Any"/>; Phase 4.2 widens this).</param>
    /// <param name="variance">The variance modifier (Phase 4.3 / ADR-0021).</param>
    /// <param name="interfaceConstraint">Optional sealed-interface constraint (Phase 4.2b / ADR-0020). When non-<c>null</c>, type arguments must implement this interface and the enum <paramref name="constraint"/> is set to <see cref="TypeParameterConstraint.Any"/> (the interface bound subsumes <c>any</c>).</param>
    public TypeParameterSymbol(string name, int ordinal, TypeParameterConstraint constraint, TypeParameterVariance variance, InterfaceSymbol? interfaceConstraint = null)
        : base(name)
    {
        Ordinal = ordinal;
        Constraint = constraint;
        Variance = variance;
        InterfaceConstraint = interfaceConstraint;
    }

    /// <summary>Gets the zero-based ordinal of this type parameter in its declaring list.</summary>
    public int Ordinal { get; }

    /// <summary>Gets or sets the constraint applied to this type parameter (Phase 4.2 will add comparable / sealed-interface bounds).</summary>
    public TypeParameterConstraint Constraint { get; set; }

    /// <summary>Gets the variance modifier (Phase 4.3 / ADR-0021).</summary>
    public TypeParameterVariance Variance { get; }

    /// <summary>Gets or sets the sealed-interface constraint, if any (Phase 4.2b / ADR-0020). When non-<c>null</c>, type arguments must implement this interface. ADR-0089 allows late patching by the binder when the constraint is a self-referential constructed generic such as <c>[T IAdd[T]]</c>.</summary>
    public InterfaceSymbol? InterfaceConstraint { get; set; }

    /// <summary>
    /// Gets or sets the imported CLR interface constraint, if any (issue #943).
    /// Holds an imported (possibly constructed-generic) CLR interface — e.g.
    /// <c>System.IComparable[T]</c> from <c>[T IComparable[T]]</c> — that a
    /// type argument must implement. Unlike <see cref="InterfaceConstraint"/>
    /// (which models a G#-declared <see cref="InterfaceSymbol"/>), this models a
    /// BCL / reference-assembly interface. Self-referential generic constraints
    /// (the type parameter appears in its own constraint) are supported. The
    /// emitter projects this onto a <c>GenericParamConstraint</c> metadata row
    /// and routes instance calls on the type parameter through it with a
    /// <c>constrained.</c> prefix so the IL is verifiable.
    /// </summary>
    public TypeSymbol? ClrInterfaceConstraint { get; set; }

    /// <summary>
    /// Gets or sets the base-class (non-interface) constraint, if any (issue
    /// #1056). Holds the user-declared class (a <see cref="StructSymbol"/> with
    /// <see cref="StructSymbol.IsClass"/>, possibly a constructed generic such
    /// as the self-referential <c>[T Box[T]]</c>) or an imported reference-type
    /// class that a type argument must derive from (or equal). Mirrors C#'s
    /// <c>where T : BaseClass</c>. C# permits at most one class constraint; G#'s
    /// single legacy constraint slot enforces this structurally. The emitter
    /// projects this onto a <c>GenericParamConstraint</c> metadata row and
    /// dispatches instance members declared on the base class through a normal
    /// <c>callvirt</c> on the (reference-typed) type parameter — no
    /// <c>constrained.</c> prefix is required because the bound proves <c>T</c>
    /// is a reference type.
    /// </summary>
    public TypeSymbol? ClassConstraint { get; set; }

    /// <summary>
    /// Gets or sets the DEPENDENT bound — another type parameter this one must
    /// derive from, satisfy, or equal (issue #4043). Mirrors C#'s
    /// <c>where TDerived : TBase</c>, spelled <c>[TBase, TDerived TBase]</c> in
    /// G#. The bound may be declared on the same list (a method's or a type's
    /// own parameters) or on the ENCLOSING type when a generic method's
    /// parameter names the class's — <c>class Box[T] { func Accept[U T](u U) }</c>.
    /// <para>Deliberately a SEPARATE slot from <see cref="ClassConstraint"/>.
    /// Roughly forty consumers read <c>ClassConstraint != null</c> as "this
    /// parameter is a reference type" (nil acceptance, boxing decisions,
    /// <c>callvirt</c> without a <c>constrained.</c> prefix). A dependent bound
    /// proves nothing of the sort — <c>TBase</c> may itself be unconstrained,
    /// so <c>TDerived</c> can be instantiated with a struct — and reusing the
    /// slot would admit <c>nil</c> at a value-type slot, which is the #4027
    /// unverifiable-<c>ldnull</c> defect one release later.</para>
    /// <para>The emitter projects this onto a <c>GenericParamConstraint</c>
    /// metadata row whose <c>TypeDefOrRefOrSpec</c> is a TypeSpec naming
    /// <c>VAR(n)</c> / <c>MVAR(n)</c> — the encoding Roslyn emits for the same
    /// C# shape — through the existing <c>TypeParameterSymbol</c> branch of
    /// <c>ImportedMemberRefFactory.GetElementTypeToken</c>.</para>
    /// </summary>
    public TypeParameterSymbol? TypeParameterBound { get; set; }

    /// <summary>
    /// Gets a value indicating whether this parameter's DEPENDENT bound chain
    /// proves it is a reference type in every instantiation (issue #4062) —
    /// <c>[TBase class, TDerived TBase]</c>, or a longer chain, whose ROOT
    /// carries <c>class</c> or a base-class bound. C# propagates a bounding
    /// parameter's special constraints to the bounded one, so <c>csc</c>
    /// accepts <c>TDerived x = null;</c> there; before this, G# reported
    /// <c>GS0155</c>.
    /// </summary>
    /// <remarks>
    /// <para>Deliberately a SEPARATE question from
    /// <see cref="HasReferenceTypeConstraint"/> / <see cref="ClassConstraint"/>
    /// rather than a widening of either slot. Roughly forty consumers read
    /// <c>ClassConstraint != null</c> as "this parameter is a reference type"
    /// AND as "this is the type it derives from" — the second reading drives
    /// boxing and <c>callvirt</c> decisions in the emitter, and a dependent
    /// bound supplies no such type. Merging the slots is #4027's defect shape;
    /// this property answers only the reference-ness half, and exactly one
    /// consumer reads it (<c>Conversion.IsNilAssignableWithoutNullableWrapper</c>).</para>
    /// <para>Terminated by VISITED-SYMBOL cycle detection, not by a depth
    /// limit (review of PR #4088). A semantic depth cap answers "no" for a
    /// chain that is merely long — <c>[T0 class, T1 T0, … T33 T32]</c> proves
    /// <c>T33</c> is a reference type after 33 hops, and a 32-hop cap would
    /// report <c>GS0155</c> on it — so the only thing that may stop the walk
    /// is actually revisiting a parameter. #4043 already rejects and CLEARS a
    /// cyclic bound (<c>GS0581</c>,
    /// <c>DeclarationBinder.Functions.cs</c>), so this set is belt-and-braces
    /// for a chain reached before that clearing.</para>
    /// <para>The set is keyed on REFERENCE identity, which is well-defined for
    /// an open type parameter and needs no name at all. That is deliberate:
    /// PR #4068's first attempt at the same replacement keyed on
    /// <c>ClrTypeUtilities.IsSameAs</c>, whose <c>Type.FullName</c> is
    /// <see langword="null"/> for an open constructed generic, so every nested
    /// <c>List&lt;…&gt;</c> compared equal and a FALSE cycle fired at the first
    /// argument — strictly worse than the cap it replaced while looking like a
    /// fix. A <see cref="TypeParameterSymbol"/> is a single binder-allocated
    /// instance per declared parameter, so identity is exactly the right key
    /// and no name is consulted. This is the same idiom
    /// <c>Binder.SatisfiesClassConstraint</c> adopted for #4091/#4102 — a
    /// DIFFERENT question (does this argument satisfy one named base class,
    /// following <c>ClassConstraint ?? TypeParameterBound</c>) reached
    /// independently, so the two walks stay separate but agree on how a chain
    /// is terminated.</para>
    /// </remarks>
    public bool DependentBoundProvesReferenceType
    {
        get
        {
            var bound = TypeParameterBound;
            if (bound == null)
            {
                return false;
            }

            // Allocated only once a chain is actually being walked, and only
            // grown past the first hop — the overwhelmingly common shape is
            // `[TBase class, TDerived TBase]`, one hop, which answers before
            // the set is ever added to twice.
            HashSet<TypeParameterSymbol>? visited = null;
            while (bound != null)
            {
                if (bound.HasReferenceTypeConstraint || bound.ClassConstraint != null)
                {
                    return true;
                }

                visited ??= new HashSet<TypeParameterSymbol>(ReferenceEqualityComparer.Instance);
                if (!visited.Add(bound))
                {
                    // Revisited: the chain is cyclic. #4043 reports GS0581 for
                    // this and clears the bound; answering "no" here is the
                    // conservative direction — `nil` stays refused rather than
                    // being admitted on the strength of a chain that has no
                    // root.
                    return false;
                }

                bound = bound.TypeParameterBound;
            }

            return false;
        }
    }

    /// <summary>
    /// Gets the single interface bound carried by this type parameter, if any —
    /// either the G# <see cref="InterfaceConstraint"/> or the imported
    /// <see cref="ClrInterfaceConstraint"/> (issue #943). Used by the emitter to
    /// emit the <c>GenericParamConstraint</c> row and by the binder to enforce
    /// constraint satisfaction at call sites.
    /// </summary>
    public TypeSymbol? ConstraintInterfaceType => InterfaceConstraint ?? ClrInterfaceConstraint;

    /// <summary>
    /// Gets the single TypeDefOrRefOrSpec bound this type parameter projects onto
    /// a <c>GenericParamConstraint</c> metadata row — the interface bound
    /// (<see cref="ConstraintInterfaceType"/>) or the base-class bound
    /// (<see cref="ClassConstraint"/>, issue #1056), or the dependent bound on
    /// another type parameter (<see cref="TypeParameterBound"/>, issue #4043).
    /// At most one of these is set for a given type parameter.
    /// </summary>
    public TypeSymbol? ConstraintReferenceType => ConstraintInterfaceType ?? ClassConstraint ?? TypeParameterBound;

    /// <summary>
    /// Gets or sets a value indicating whether this type parameter carries a
    /// reference-type (<c>class</c>) constraint (ADR-0097 / issue #775).
    /// Type arguments must be a reference type
    /// (<c>!IsValueType</c> at the CLR level). Maps to
    /// <see cref="System.Reflection.GenericParameterAttributes.ReferenceTypeConstraint"/>
    /// in emitted IL.
    /// </summary>
    public bool HasReferenceTypeConstraint { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether this type parameter carries a
    /// value-type (<c>struct</c>) constraint (ADR-0097 / issue #775).
    /// Type arguments must be a non-nullable value type. Maps to
    /// <see cref="System.Reflection.GenericParameterAttributes.NotNullableValueTypeConstraint"/>
    /// in emitted IL. A <c>struct</c> constraint implies the
    /// <c>init()</c> (default-constructor) flag at the CLR level — the
    /// emitter sets both bits automatically per ECMA-335 II.10.1.7.
    /// </summary>
    public bool HasValueTypeConstraint { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether this type parameter carries
    /// the default-constructor (<c>init()</c>) constraint (ADR-0097 /
    /// issue #775; spelled <c>new()</c> before issue #997). Type arguments
    /// must either be a value type or expose a
    /// public parameterless constructor. Maps to
    /// <see cref="System.Reflection.GenericParameterAttributes.DefaultConstructorConstraint"/>
    /// in emitted IL.
    /// </summary>
    public bool HasDefaultConstructorConstraint { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether this type parameter carries an
    /// <c>unmanaged</c> constraint (issue #1336). Type arguments must be an
    /// unmanaged type — a non-nullable value type whose fields are recursively
    /// unmanaged (blittable primitives, enums, pointers, or other unmanaged
    /// structs). The <c>unmanaged</c> constraint implies the value-type
    /// (<c>struct</c>) and default-constructor flags at the CLR level, and the
    /// emitter additionally projects a <c>GenericParamConstraint</c> to
    /// <c>System.ValueType</c> carrying a required custom modifier
    /// (<c>modreq</c>) of
    /// <c>System.Runtime.InteropServices.UnmanagedType</c> — the exact metadata
    /// shape C# emits for <c>where T : unmanaged</c>. That modreq is what makes
    /// a pointer to the type parameter (<c>*T</c>) and <c>sizeof(T)</c> over it
    /// verifiable.
    /// </summary>
    public bool HasUnmanagedConstraint { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether this type parameter is declared
    /// on a generic method (as opposed to a generic type). When
    /// <see langword="true"/> the emitter encodes it as
    /// <c>MVAR(<see cref="Ordinal"/>)</c>; when <see langword="false"/> as
    /// <c>VAR(<see cref="Ordinal"/>)</c> (ADR-0087 §3, R2).
    /// </summary>
    /// <remarks>
    /// Set by the binder when the type parameter is attached to a
    /// <c>FunctionSymbol</c>. Type-type parameters keep the default
    /// <see langword="false"/>.
    /// </remarks>
    public bool IsMethodTypeParameter { get; set; }
}
