// <copyright file="SmartCastStability.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0069 addendum / issue #1180: the Kotlin-parity stability rules that
/// decide whether a member-access chain may participate in smart-cast flow
/// narrowing. A narrowing on a member path is only sound when every link is
/// guaranteed not to change between the test and the use — i.e. an immutable
/// member (no settable setter, no custom getter, not overridable) declared in
/// the current compilation, read through a stable receiver chain.
/// </summary>
internal static class SmartCastStability
{
    /// <summary>
    /// Returns whether <paramref name="variable"/> can root a stable access
    /// path. Mirrors the receiver-stability rule of ADR-0069's switch addendum:
    /// locals and parameters (including the synthetic <c>this</c> receiver) and
    /// read-only top-level <c>let</c> globals. Mutable globals are excluded —
    /// they may be reassigned between the test and the use.
    /// </summary>
    /// <param name="variable">The candidate root variable.</param>
    /// <returns><c>true</c> when the variable is a stable root.</returns>
    public static bool IsStableRoot(VariableSymbol variable)
    {
        return variable switch
        {
            // ParameterSymbol derives from LocalVariableSymbol and is covered here.
            LocalVariableSymbol => true,
            GlobalVariableSymbol g => g.IsReadOnly,
            _ => false,
        };
    }

    /// <summary>
    /// Returns whether <paramref name="field"/> is an immutable instance field
    /// (declared with <c>let</c>, hence emitted <c>initonly</c>, or a <c>const</c>)
    /// that may appear as a stable link. A <c>var</c> field is excluded.
    /// </summary>
    /// <param name="field">The field read in the chain.</param>
    /// <returns><c>true</c> when the field is a stable link.</returns>
    public static bool IsStableField(FieldSymbol field)
    {
        return field != null && field.IsReadOnly && !field.IsStatic;
    }

    /// <summary>
    /// Returns whether <paramref name="property"/> is a stable link. Following
    /// Kotlin, this requires an auto-property (no custom getter, so the read is
    /// idempotent), that is effectively immutable (no setter, or an
    /// <c>init</c>-only setter that cannot run after construction), and that is
    /// not overridable (neither <c>open</c>/virtual nor an override — an
    /// override could change the observed value through dynamic dispatch).
    /// </summary>
    /// <param name="property">The property read in the chain.</param>
    /// <returns><c>true</c> when the property is a stable link.</returns>
    public static bool IsStableProperty(PropertySymbol property)
    {
        return property != null
            && property.HasGetter
            && property.IsAutoProperty
            && !property.IsVirtual
            && !property.IsOverride
            && !property.IsStatic
            && (!property.HasSetter || property.IsInitOnly);
    }

    /// <summary>
    /// Attempts to derive the stable <see cref="AccessPath"/> that
    /// <paramref name="expr"/> reads. Returns <c>null</c> unless the whole chain
    /// is stable: a stable root variable optionally followed by immutable
    /// field / property links read through stable receivers. Reads of
    /// imported / CLR members (<see cref="BoundClrPropertyAccessExpression"/>),
    /// mutable members, computed properties, indexers, and method results are
    /// never stable, so the recursion bottoms out at <c>null</c> for them.
    /// </summary>
    /// <param name="expr">The candidate access expression.</param>
    /// <returns>The stable access path, or <c>null</c>.</returns>
    public static AccessPath TryGetStablePath(BoundExpression expr)
    {
        switch (expr)
        {
            case BoundVariableExpression bve when IsStableRoot(bve.Variable):
                return AccessPath.ForVariable(bve.Variable);

            case BoundFieldAccessExpression fa when fa.Receiver != null && fa.InterfaceType == null && IsStableField(fa.Field):
                {
                    var parent = TryGetStablePath(fa.Receiver);
                    return parent?.Append(fa.Field);
                }

            case BoundPropertyAccessExpression pa when pa.Receiver != null && IsStableProperty(pa.Property):
                {
                    var parent = TryGetStablePath(pa.Receiver);
                    return parent?.Append(pa.Property);
                }

            default:
                return null;
        }
    }

    /// <summary>
    /// Attempts to derive a stable <em>member</em> access path (a path with at
    /// least one member link) for <paramref name="expr"/>, together with the
    /// expression's current (pre-narrowing) static type. Returns <c>false</c>
    /// for plain variables (handled by the existing variable-narrowing path) and
    /// for any unstable chain.
    /// </summary>
    /// <param name="expr">The candidate access expression.</param>
    /// <param name="path">The resulting stable member path, when successful.</param>
    /// <param name="currentType">The current static type of the read.</param>
    /// <returns><c>true</c> when a stable member path was derived.</returns>
    public static bool TryGetStableMemberPath(BoundExpression expr, out AccessPath path, out TypeSymbol currentType)
    {
        path = TryGetStablePath(expr);
        if (path != null && path.HasMembers)
        {
            currentType = expr.Type;
            return true;
        }

        path = null;
        currentType = null;
        return false;
    }
}
