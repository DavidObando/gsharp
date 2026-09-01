// <copyright file="ConditionalReturnNarrowing.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #3802: applies the <c>[return: NotNullIfNotNull(nameof(p))]</c>
/// conditional post-condition of an imported (CLR) method at a CALL SITE.
///
/// <para>
/// The BCL declares members such as
/// <c>[return: NotNullIfNotNull(nameof(path))] static string? ChangeExtension(string? path, string? extension)</c>.
/// The declared return type really is nullable — narrowing it in the
/// declaration reader would restore the imported-nullability unsoundness that
/// #3705 family 2 removed — but at any call whose <c>path</c> argument is known
/// non-null, the result is known non-null too. That makes this a FLOW FACT
/// about one call, which is why it lives here and is applied to the bound call
/// node's type rather than to <see cref="ImportedFunctionSymbol.Type"/>.
/// </para>
///
/// <para>
/// The narrowing is deliberately conservative: it fires only when the argument
/// bound at the named parameter's position has a statically non-nullable type.
/// A nullable argument (including one that has not been flow-narrowed to
/// non-null) leaves the declared nullable return in place, so
/// <c>Path.ChangeExtension(maybeNil, ".gs")</c> is still rejected where a
/// non-nullable <c>string</c> is required.
/// </para>
/// </summary>
internal static class ConditionalReturnNarrowing
{
    /// <summary>
    /// Returns <paramref name="declaredReturn"/> stripped of its top-level
    /// nullable annotation when <paramref name="method"/> carries a
    /// <c>[return: NotNullIfNotNull]</c> naming a parameter whose argument at
    /// this call site is known non-null; otherwise returns
    /// <paramref name="declaredReturn"/> unchanged.
    /// </summary>
    /// <param name="method">The imported method being called.</param>
    /// <param name="arguments">The bound arguments, in parameter order.</param>
    /// <param name="declaredReturn">The declared (reader-derived) return type.</param>
    /// <returns>The call-site return type.</returns>
    public static TypeSymbol Apply(
        MethodInfo? method,
        ImmutableArray<BoundExpression> arguments,
        TypeSymbol declaredReturn)
    {
        // Only a declared-nullable reference return has anything to narrow.
        if (method == null || declaredReturn is not NullableTypeSymbol nullableReturn)
        {
            return declaredReturn;
        }

        if (arguments.IsDefaultOrEmpty)
        {
            return declaredReturn;
        }

        var names = ClrNullability.GetNotNullIfNotNullParameters(method);
        if (names.Count == 0)
        {
            return declaredReturn;
        }

        var parameters = method.GetParameters();
        foreach (var name in names)
        {
            for (var i = 0; i < parameters.Length && i < arguments.Length; i++)
            {
                if (!string.Equals(parameters[i].Name, name, System.StringComparison.Ordinal))
                {
                    continue;
                }

                if (IsKnownNonNull(arguments[i]))
                {
                    return nullableReturn.UnderlyingType;
                }

                break;
            }
        }

        return declaredReturn;
    }

    private static bool IsKnownNonNull(BoundExpression argument)
    {
        if (StatementBinder.IsNilLiteral(argument))
        {
            return false;
        }

        // Peel a pure ANNOTATION widening (`T` converted to `T?`, which is how a
        // non-nil argument reaches a `T?`-typed parameter — including a generic
        // parameter whose type argument inference already closed over `T?`, as
        // in `Interlocked.Exchange(&slot, v)` where `slot` is `T?`). Such a
        // conversion changes the annotation, never the value, so a non-nullable
        // operand underneath it is still known non-nil. Only this exact shape is
        // peeled: a user-defined or representation-changing conversion could
        // legitimately produce nil from a non-nil operand.
        while (argument is BoundConversionExpression conversion
            && conversion.Type is NullableTypeSymbol widened
            && conversion.Expression.Type != null
            && widened.UnderlyingType == conversion.Expression.Type)
        {
            argument = conversion.Expression;
        }

        var type = argument.Type;

        // A `ref`/`out` argument's nullability is the POINTEE's — issue #3727's
        // `Volatile.Read(&r)` is annotated `[return: NotNullIfNotNull(nameof(location))]`
        // and passes `ref Result?`, which must NOT narrow: the location holds
        // nil. Reading the byref wrapper as "not a NullableTypeSymbol" would
        // narrow every such call and re-break `Volatile.Read(&r) != nil`.
        while (type is ByRefTypeSymbol byRef)
        {
            type = byRef.PointeeType;
        }

        return type != null
            && type is not NullableTypeSymbol
            && !ReferenceEquals(type, TypeSymbol.Null);
    }
}
