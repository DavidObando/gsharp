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

    /// <summary>
    /// ADR-0069 addendum / issues #700/#712/#1180/#1545: recognises the leaf
    /// nil-guard comparison (<c>x == nil</c> / <c>x != nil</c>) where the
    /// non-nil operand is a stable, narrowable target of <see
    /// cref="NullableTypeSymbol"/> type. The target may be a bare local or
    /// parameter, or a stable immutable member path. This is the single shared
    /// leaf used by BOTH the if-condition classifier
    /// (<c>StatementBinder.TryClassifyNilGuard</c>) and the short-circuit
    /// operand classifier (<c>ExpressionBinder.ClassifyTypeTestNarrowing</c>)
    /// so the two nil-guard classifiers stay consistent.
    /// </summary>
    /// <param name="condition">The candidate comparison expression.</param>
    /// <param name="restrictBareVariableToLocalsAndParams">
    /// When <c>true</c>, a bare variable target is only accepted when it is a
    /// local or parameter, matching the soundness restriction the type-test
    /// (<c>x is T</c>) short-circuit classifier applies — a mutable global could
    /// be reassigned by a side effect between the guard and the use across
    /// <c>&amp;&amp;</c>/<c>||</c>. When <c>false</c> (the if-statement
    /// classifier, which has flow-based mutation invalidation), any variable is
    /// accepted. Stable member paths are always subject to their own
    /// stable-root rules regardless of this flag.
    /// </param>
    /// <param name="referenceNullableOnly">
    /// When <c>true</c> (the <c>&amp;&amp;</c>/<c>||</c> short-circuit
    /// classifier), a nullable VALUE type (e.g. <c>int32?</c>) is rejected
    /// because narrowing it to its non-nullable form is not an IL no-op and the
    /// variable-load path does not emit the required unwrap (issue #1545). When
    /// <c>false</c> (the if-statement classifier), value-type nullables are
    /// accepted, preserving that path's pre-existing behaviour.
    /// </param>
    /// <param name="target">The narrowed access path, when successful.</param>
    /// <param name="underlying">The non-nullable underlying type to narrow to.</param>
    /// <param name="nonNilWhenTrue">
    /// <c>true</c> for <c>x != nil</c> (the target is non-nil when the
    /// comparison is true); <c>false</c> for <c>x == nil</c> (the target is
    /// non-nil when the comparison is false).
    /// </param>
    /// <returns><c>true</c> when a nil-guard leaf was recognised.</returns>
    public static bool TryClassifyNilGuardLeaf(BoundExpression condition, bool restrictBareVariableToLocalsAndParams, bool referenceNullableOnly, out AccessPath target, out TypeSymbol underlying, out bool nonNilWhenTrue)
    {
        target = null;
        underlying = null;
        nonNilWhenTrue = false;

        if (condition is not BoundBinaryExpression be)
        {
            return false;
        }

        if (be.Op.Kind is not (BoundBinaryOperatorKind.Equals or BoundBinaryOperatorKind.NotEquals))
        {
            return false;
        }

        TypeSymbol targetType = null;
        if (be.Left is BoundVariableExpression lv && IsAcceptableBareVariable(lv.Variable, restrictBareVariableToLocalsAndParams) && StatementBinder.IsNilLiteral(be.Right))
        {
            target = lv.Variable;
            targetType = lv.Variable.Type;
        }
        else if (be.Right is BoundVariableExpression rv && IsAcceptableBareVariable(rv.Variable, restrictBareVariableToLocalsAndParams) && StatementBinder.IsNilLiteral(be.Left))
        {
            target = rv.Variable;
            targetType = rv.Variable.Type;
        }
        else if (StatementBinder.IsNilLiteral(be.Right) && TryGetStableMemberPath(be.Left, out var leftPath, out var leftType))
        {
            target = leftPath;
            targetType = leftType;
        }
        else if (StatementBinder.IsNilLiteral(be.Left) && TryGetStableMemberPath(be.Right, out var rightPath, out var rightType))
        {
            target = rightPath;
            targetType = rightType;
        }

        if (target == null || targetType is not NullableTypeSymbol nullable)
        {
            target = null;
            return false;
        }

        // Issue #1545: narrowing a nullable VALUE type (`int32?` → `int32`)
        // requires an unwrap the variable-load path does not currently emit, so
        // the narrowed static type and the `System.Nullable<T>` storage diverge
        // and the method fails ilverify (a pre-existing latent gap; see the
        // separately-tracked value-type nil-narrowing emit bug). For a nullable
        // REFERENCE type the narrowed type and its storage are the same CLR type,
        // so narrowing is an IL no-op and is safe. The short-circuit
        // (`&&`/`||`) caller passes `referenceNullableOnly: true` to stay on the
        // safe side; the statement classifier keeps its pre-existing behaviour.
        if (referenceNullableOnly && NullableLifting.IsValueTypeNullable(nullable))
        {
            target = null;
            return false;
        }

        underlying = nullable.UnderlyingType;
        nonNilWhenTrue = be.Op.Kind == BoundBinaryOperatorKind.NotEquals;
        return true;
    }

    private static bool IsAcceptableBareVariable(VariableSymbol variable, bool restrictToLocalsAndParams)
    {
        // ParameterSymbol derives from LocalVariableSymbol and is covered here.
        return !restrictToLocalsAndParams || variable is LocalVariableSymbol;
    }
}
