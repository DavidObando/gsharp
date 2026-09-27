// <copyright file="NullabilityImportRule.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0193 §1: what a classified imported position becomes. This is the
/// representation-neutral half of <see cref="NullabilityImportRule"/>'s
/// answer; each type model maps it onto its own types with a thin applier.
/// </summary>
internal enum ImportedReferenceNullability
{
    /// <summary>
    /// Keep the input exactly as it is, including any <c>?</c> or <c>!</c> it
    /// already carries. The answer for a value-type position, and for an open
    /// slot whose nullability arrives with the argument.
    /// </summary>
    Unchanged,

    /// <summary>The bare, non-null <c>T</c>.</summary>
    NotNull,

    /// <summary>The stated-nullable <c>T?</c>.</summary>
    Nullable,

    /// <summary>The platform type <c>T!</c> (ADR-0186).</summary>
    Platform,
}

/// <summary>
/// ADR-0193 §1: what is known about a type argument's kind at the point the
/// rule runs. Deliberately three-valued: an unconstrained type parameter is
/// neither a reference nor a value type, and folding it into either neighbour
/// is the PR #4362 round-1 regression (<c>Min()</c> on an unconstrained
/// <c>T</c> becoming <c>T?</c>).
/// </summary>
internal enum TypeArgumentKind
{
    /// <summary>A reference type, or a type parameter constrained to one (<c>class</c>, a class type).</summary>
    Reference,

    /// <summary>A value type, or a type parameter constrained <c>struct</c> / <c>unmanaged</c>.</summary>
    Value,

    /// <summary>An unconstrained (or interface-only-constrained) type parameter.</summary>
    Unknown,
}

/// <summary>
/// ADR-0193 §1 — <b>the</b> producer choke point: the single decision
/// <em>"a position whose declaration is classified as S, substituted (or not)
/// with argument A, gets which reference nullability?"</em>.
/// <para>
/// The decision (<see cref="DecideConcrete"/>, <see cref="DecideOpenSlot"/>)
/// takes and returns no type-model value, so gsc's <see cref="TypeSymbol"/>
/// walkers and cs2gs's <c>GTypeReference</c> applier share it. gsc's appliers
/// (<see cref="ApplyConcrete"/>, <see cref="ApplyOpenSlot"/>, and the byte-level
/// <see cref="ApplyOpenSlotToFlags"/> the projection reader needs) are the only
/// places a Layer 1 walker turns a classified position into a wrapper.
/// </para>
/// <para>
/// <b>Platform-types semantics only</b> (ADR-0193 owner decision 2). There is
/// no <see cref="NullabilityOptions"/> branch in this class and none may be
/// added: the legacy <c>--nullability=enabled</c> reading is retired by #4372,
/// and the walkers keep their own legacy arm until then.
/// </para>
/// </summary>
internal static class NullabilityImportRule
{
    /// <summary>The C# nullable-metadata byte for a not-annotated position.</summary>
    private const byte NotAnnotatedByte = 1;

    /// <summary>The C# nullable-metadata byte for an annotated position.</summary>
    private const byte AnnotatedByte = 2;

    /// <summary>
    /// ADR-0186 §2's table for a <em>concrete</em> position — one whose type
    /// the declaration itself spells, rather than an open slot a type argument
    /// fills.
    /// </summary>
    /// <param name="state">What the declaration says about the position.</param>
    /// <param name="kind">
    /// The position's kind. A concrete position is a closed type and so is
    /// normally <see cref="TypeArgumentKind.Reference"/> or
    /// <see cref="TypeArgumentKind.Value"/>; a CLR generic parameter read
    /// directly off an open definition (not substituted) is
    /// <see cref="TypeArgumentKind.Unknown"/> and is read as the declaration
    /// spells it, exactly like a reference position.
    /// </param>
    /// <returns>The decision.</returns>
    internal static ImportedReferenceNullability DecideConcrete(ClrNullabilityState state, TypeArgumentKind kind)
    {
        if (kind == TypeArgumentKind.Value)
        {
            return ImportedReferenceNullability.Unchanged;
        }

        return state switch
        {
            ClrNullabilityState.NotAnnotated => ImportedReferenceNullability.NotNull,
            ClrNullabilityState.Annotated => ImportedReferenceNullability.Nullable,
            _ => ImportedReferenceNullability.Platform,
        };
    }

    /// <summary>
    /// ADR-0186 §2's open-type-parameter carve-out plus ADR-0193 owner
    /// decision 1: an open slot widens to <c>T?</c> only for an explicit
    /// <c>[Nullable(2)]</c>, and only when the argument is known to be a
    /// reference type. Every other cell leaves the argument to speak for
    /// itself.
    /// <list type="table">
    /// <listheader><term>Declared</term><description>Reference / Value / Unknown</description></listheader>
    /// <item><term><c>Annotated</c></term><description><c>Nullable</c> / <c>Unchanged</c> / <c>Unchanged</c></description></item>
    /// <item><term><c>NotAnnotated</c></term><description><c>Unchanged</c> in every column</description></item>
    /// <item><term><c>Oblivious</c> / absent</term><description><c>Unchanged</c> in every column</description></item>
    /// </list>
    /// <para>
    /// The <c>Annotated</c> × <c>Unknown</c> cell is <c>Unchanged</c> by the
    /// owner's 2026-09-24 ruling (ADR-0193 Open question 1). Revisiting it as
    /// <c>Platform</c> is #4385, a Phase 3 exit criterion — not this class's
    /// call to make on its own.
    /// </para>
    /// </summary>
    /// <param name="declaredState">What the open declaration says about the slot.</param>
    /// <param name="argumentKind">What is known about the substituted argument.</param>
    /// <returns>The decision.</returns>
    internal static ImportedReferenceNullability DecideOpenSlot(
        ClrNullabilityState declaredState,
        TypeArgumentKind argumentKind)
        => declaredState == ClrNullabilityState.Annotated && argumentKind == TypeArgumentKind.Reference
            ? ImportedReferenceNullability.Nullable
            : ImportedReferenceNullability.Unchanged;

    /// <summary>
    /// gsc's applier for a concrete position: <see cref="DecideConcrete"/>
    /// mapped onto <see cref="TypeSymbol"/>.
    /// </summary>
    /// <param name="baseSymbol">The unwrapped position type.</param>
    /// <param name="state">What the declaration says about the position.</param>
    /// <returns>The nullability-aware type symbol.</returns>
    internal static TypeSymbol ApplyConcrete(TypeSymbol baseSymbol, ClrNullabilityState state)
        => Apply(baseSymbol, DecideConcrete(state, ClassifyArgument(baseSymbol)));

    /// <summary>
    /// gsc's applier for an open slot: <see cref="DecideOpenSlot"/> mapped onto
    /// <see cref="TypeSymbol"/>. <c>Unchanged</c> returns
    /// <paramref name="argument"/> exactly as given — a <c>string?</c>
    /// argument stays <c>string?</c> in every row.
    /// </summary>
    /// <param name="argument">The substituted type argument.</param>
    /// <param name="declaredState">What the open declaration says about the slot.</param>
    /// <returns>The nullability-aware type symbol.</returns>
    internal static TypeSymbol ApplyOpenSlot(TypeSymbol argument, ClrNullabilityState declaredState)
        => Apply(argument, DecideOpenSlot(declaredState, ClassifyArgument(argument)));

    /// <summary>
    /// The inverse of <see cref="ApplyOpenSlot"/>, for method type-argument
    /// inference: given the argument a call passes to an open slot, the type
    /// argument that slot must be closed over. Where <see cref="DecideOpenSlot"/>
    /// widens a <c>Reference</c> argument to <c>T?</c>, a <c>X?</c> argument
    /// passed to that slot supplies <c>T := X</c>. This is C#'s rule:
    /// <c>Required&lt;T&gt;(T? value) where T : class</c> called with a
    /// <c>Type?</c> infers <c>T</c> as <c>Type</c>, so the call returns
    /// <c>Type</c>. Every other cell hands the argument back unchanged. A value
    /// type <c>int?</c> is its own argument (<c>T := int?</c> for an
    /// unconstrained <c>T?</c>), and so is a <c>T!</c> platform value.
    /// </summary>
    /// <param name="argument">The argument's type at the slot.</param>
    /// <param name="declaredState">What the open declaration says about the slot.</param>
    /// <returns>The type the slot's type parameter is inferred as.</returns>
    internal static TypeSymbol InferOpenSlotArgument(TypeSymbol argument, ClrNullabilityState declaredState)
        => argument is NullableTypeSymbol nullable
            && DecideOpenSlot(declaredState, ClassifyArgument(nullable)) == ImportedReferenceNullability.Nullable
                ? nullable.UnderlyingType
                : argument;

    /// <summary>
    /// ADR-0193 amendment (2026-09-26, #4451, owner decision): an explicit
    /// method type argument that closes an open slot the declaration leaves
    /// oblivious reads as <c>T!</c>. <c>Ob.WrapList[string](x)</c> over an
    /// oblivious <c>List&lt;T&gt; WrapList&lt;T&gt;(T value)</c> binds
    /// <c>T = string!</c>: its parameter takes a nil unchecked, as the C#
    /// does, and its return is <c>List[string!]</c>, so a nil element is
    /// checked where it is read. This narrows <see cref="DecideOpenSlot"/>'s
    /// <c>Unchanged</c> only for an explicit reference type argument at an
    /// oblivious slot; an annotated or enabled slot, a value-type argument,
    /// and an argument that already states its nullability (<c>string?</c>,
    /// <c>string!</c>) are unchanged. Inference reaches the same answer on
    /// its own (#4459: an oblivious slot keeps the argument's <c>T!</c>).
    /// </summary>
    /// <param name="argument">The explicit type argument.</param>
    /// <param name="declaredState">What the open declaration says about the slot the type parameter fills.</param>
    /// <returns>The type the type parameter is bound to.</returns>
    internal static TypeSymbol ApplyExplicitOpenSlotArgument(TypeSymbol argument, ClrNullabilityState declaredState)
        => declaredState == ClrNullabilityState.Oblivious
            && argument is not NullableTypeSymbol
            && argument is not PlatformTypeSymbol
            && ClassifyArgument(argument) == TypeArgumentKind.Reference
                ? Apply(argument, ImportedReferenceNullability.Platform)
                : argument;

    /// <summary>
    /// Issue #4403: the direct parameter reader lifts a reference parameter
    /// whose default value is <c>null</c> to <c>T?</c>. That is a G#-side
    /// inference from the default value, not a classified metadata position,
    /// so it is named here rather than passed off as an <c>Annotated</c>
    /// state. Only <c>ClrNullability.GetParameterTypeSymbol</c> applies it
    /// today; #4403 decides whether the other readers should.
    /// </summary>
    /// <param name="parameterType">The parameter's already-read type.</param>
    /// <returns>The parameter type, stated nullable.</returns>
    internal static TypeSymbol ApplyNullDefaultLift(TypeSymbol parameterType)
        => NullableTypeSymbol.Get(parameterType);

    /// <summary>
    /// The <see cref="ImportedReferenceNullability.Unchanged"/> decision for a
    /// walker that peeled its input's own <c>?</c> to rebuild the core under
    /// it (merging the arguments of a <c>List[string]?</c>, say): the rebuilt
    /// core gets the input's <c>?</c> back, whether it was a reference or a
    /// value-type one. No metadata byte is consulted — the input already
    /// stated it.
    /// </summary>
    /// <param name="rebuiltCore">The rebuilt, unwrapped core.</param>
    /// <returns>The core, stated nullable again.</returns>
    internal static TypeSymbol RestorePeeledNullable(TypeSymbol rebuiltCore)
        => NullableTypeSymbol.Get(rebuiltCore);

    /// <summary>
    /// The byte-domain applier for an open slot, for the projection reader
    /// (<c>ClrNullability.ProjectNullableFlags</c>), which rewrites a flag
    /// array rather than building a <see cref="TypeSymbol"/>. The argument is
    /// an erased closed CLR type and so states no nullability of its own:
    /// every position in it reads as not-annotated, which is how the merge
    /// reader reads the same argument after <see cref="TypeSymbol.FromClrType"/>.
    /// A <c>Nullable</c> decision annotates the argument's root only — never
    /// its inner positions, which belong to the argument, not the slot.
    /// </summary>
    /// <param name="argument">The substituted closed CLR argument.</param>
    /// <param name="declaredState">What the open declaration says about the slot.</param>
    /// <returns>One byte per nullable-metadata position of <paramref name="argument"/>.</returns>
    internal static ImmutableArray<byte> ApplyOpenSlotToFlags(Type argument, ClrNullabilityState declaredState)
    {
        var flags = ClrNullability.ExpandNullableFlags(argument, ImmutableArray.Create(NotAnnotatedByte));
        if (DecideOpenSlot(declaredState, ClassifyArgument(argument)) != ImportedReferenceNullability.Nullable
            || flags.IsEmpty)
        {
            return flags;
        }

        // Only a Reference argument decides `Nullable`, and a reference type
        // always owns byte 0 of its own subtree.
        var builder = flags.ToBuilder();
        builder[0] = AnnotatedByte;
        return builder.MoveToImmutable();
    }

    /// <summary>
    /// Whether <paramref name="argument"/> is not a substitution at all but the
    /// open slot's own generic parameter left in place — a method-level
    /// <c>T</c> read with no method type arguments to map it through, or the
    /// same parameter reached through a closed declaring type. Nothing arrived
    /// to speak for such a slot, so the walkers read it as the declaration
    /// spells it (a concrete position, <see cref="DecideConcrete"/>), exactly
    /// as the direct reader reads the open definition, rather than as an
    /// <see cref="TypeArgumentKind.Unknown"/> argument.
    /// </summary>
    /// <param name="argument">The CLR type found at the slot.</param>
    /// <param name="slot">The open slot's generic parameter.</param>
    /// <returns><see langword="true"/> when no substitution happened.</returns>
    internal static bool IsUnsubstitutedSlot(Type argument, Type slot)
    {
        if (!argument.IsGenericParameter
            || !slot.IsGenericParameter
            || argument.GenericParameterPosition != slot.GenericParameterPosition)
        {
            return false;
        }

        // A TYPE's parameter is the same slot only when the declaring types
        // share a generic definition: `Base<T>` and `Derived<T>` both declare
        // a type-level `T` at ordinal 0, and an inherited `Base<T>` member
        // read through `Derived<T>` IS a substitution.
        //
        // A METHOD's parameter cannot be compared by owner here. The argument
        // reaches the walkers as `ImportedTypeSymbol.Get(parameter).ClrType`,
        // and that cache keys generic parameters structurally, so the Type it
        // hands back may be a different method's same-named parameter. A
        // method-level parameter is never substituted by another method's
        // parameter (method substitution supplies symbols), so the name and
        // ordinal are the identity that survives.
        if (argument.DeclaringMethod != null || slot.DeclaringMethod != null)
        {
            return argument.DeclaringMethod != null
                && slot.DeclaringMethod != null
                && string.Equals(argument.Name, slot.Name, StringComparison.Ordinal);
        }

        return argument.DeclaringType is { } argumentOwner
            && slot.DeclaringType is { } slotOwner
            && ClrTypeUtilities.AreSame(
                argumentOwner.IsGenericType ? argumentOwner.GetGenericTypeDefinition() : argumentOwner,
                slotOwner.IsGenericType ? slotOwner.GetGenericTypeDefinition() : slotOwner);
    }

    /// <summary>
    /// Classifies a <see cref="TypeSymbol"/> into <see cref="TypeArgumentKind"/>.
    /// The one classifier the appliers and <see cref="PlatformTypeSymbol.Get"/>'s
    /// value-type normalisation share, so the two cannot disagree about what a
    /// value type is.
    /// </summary>
    /// <param name="type">The type to classify.</param>
    /// <returns>What is known about its kind.</returns>
    internal static TypeArgumentKind ClassifyArgument(TypeSymbol type)
    {
        switch (type)
        {
            case NullableTypeSymbol nullable:
                return NullableLifting.IsAnyValueTypeNullable(nullable)
                    ? TypeArgumentKind.Value
                    : ClassifyArgument(nullable.UnderlyingType);
            case PlatformTypeSymbol platform:
                return ClassifyArgument(platform.UnderlyingType);
            case NullabilityAnnotatedTypeSymbol annotated:
                return ClassifyArgument(annotated.BaseType);
            case TypeParameterSymbol parameter:
                if (parameter.HasValueTypeConstraint || parameter.HasUnmanagedConstraint)
                {
                    return TypeArgumentKind.Value;
                }

                return parameter.HasReferenceTypeConstraint
                    || parameter.ClassConstraint != null
                    || parameter.DependentBoundProvesReferenceType
                        ? TypeArgumentKind.Reference
                        : TypeArgumentKind.Unknown;
            case TupleTypeSymbol tuple:
                // A G# tuple is a ValueTuple, and a symbolic one has no
                // ClrType to say so. But issue #1922 also maps the reference
                // type `System.Tuple<…>` onto TupleTypeSymbol, and that one is
                // a reference position — its ClrType is the authority when
                // there is one.
                return tuple.ClrType is { IsValueType: false }
                    ? TypeArgumentKind.Reference
                    : TypeArgumentKind.Value;
            case PointerTypeSymbol:
            case FunctionPointerTypeSymbol:
                // Pointers are not reference types (issue #2176).
                return TypeArgumentKind.Value;
            case ImportedTypeSymbol imported when imported.OpenDefinition?.IsValueType == true:
                return TypeArgumentKind.Value;
            case StructSymbol or EnumSymbol:
                return type.IsValueType ? TypeArgumentKind.Value : TypeArgumentKind.Reference;
        }

        return type.ClrType is { } clr ? ClassifyArgument(clr) : TypeArgumentKind.Reference;
    }

    /// <summary>
    /// Classifies a reflected CLR type into <see cref="TypeArgumentKind"/>.
    /// </summary>
    /// <param name="type">The CLR type to classify.</param>
    /// <returns>What is known about its kind.</returns>
    internal static TypeArgumentKind ClassifyArgument(Type type)
    {
        if (type.IsGenericParameter)
        {
            return ClassifyGenericParameter(type, visited: null);
        }

        return type.IsValueType || type.IsPointer || type.IsFunctionPointer
            ? TypeArgumentKind.Value
            : TypeArgumentKind.Reference;
    }

    /// <summary>
    /// Classifies a reflected generic parameter from its constraints, following
    /// a dependent bound (<c>where T : U</c>) transitively. C# propagates a
    /// bounding parameter's <c>class</c>/<c>struct</c> constraint to the
    /// bounded one, which is exactly what
    /// <see cref="TypeParameterSymbol.DependentBoundProvesReferenceType"/>
    /// answers for the <see cref="TypeSymbol"/> overload; the two must agree.
    /// A cycle is broken by visited-set, answering <c>Unknown</c>.
    /// </summary>
    private static TypeArgumentKind ClassifyGenericParameter(Type parameter, HashSet<Type>? visited)
    {
        var attributes = parameter.GenericParameterAttributes;
        if ((attributes & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0)
        {
            return TypeArgumentKind.Value;
        }

        if ((attributes & GenericParameterAttributes.ReferenceTypeConstraint) != 0)
        {
            return TypeArgumentKind.Reference;
        }

        foreach (var constraint in parameter.GetGenericParameterConstraints())
        {
            if (constraint.IsGenericParameter)
            {
                visited ??= new HashSet<Type>(ReferenceEqualityComparer.Instance) { parameter };
                if (visited.Add(constraint)
                    && ClassifyGenericParameter(constraint, visited) == TypeArgumentKind.Reference)
                {
                    return TypeArgumentKind.Reference;
                }

                continue;
            }

            if (constraint.IsClass
                && constraint.FullName is not ("System.Object" or "System.ValueType" or "System.Enum"))
            {
                return TypeArgumentKind.Reference;
            }
        }

        return TypeArgumentKind.Unknown;
    }

    private static TypeSymbol Apply(TypeSymbol symbol, ImportedReferenceNullability decision) => decision switch
    {
        ImportedReferenceNullability.Nullable => NullableTypeSymbol.Get(symbol),
        ImportedReferenceNullability.Platform => PlatformTypeSymbol.Get(symbol),

        // `NotNull` is the bare symbol, and every walker hands the rule an
        // already-unwrapped position type, so it is the input itself.
        _ => symbol,
    };
}
