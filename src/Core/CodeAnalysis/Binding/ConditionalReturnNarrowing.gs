// <copyright file="ConditionalReturnNarrowing.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Reflection

/// Issue #3802: applies the `[return: NotNullIfNotNull(nameof(p))]`
/// conditional post-condition of an imported (CLR) method at a CALL SITE.
///
/// The BCL declares members such as
/// `[return: NotNullIfNotNull(nameof(path))] static string? ChangeExtension(string? path, string? extension)`.
/// The declared return type really is nullable — narrowing it in the
/// declaration reader would restore the imported-nullability unsoundness that
/// #3705 family 2 removed — but at any call whose `path` argument is known
/// non-null, the result is known non-null too. That makes this a FLOW FACT
/// about one call, which is why it lives here and is applied to the bound call
/// node's type rather than to (cref:ImportedFunctionSymbol.Type).
///
/// The narrowing is deliberately conservative: it fires only when the argument
/// bound at the named parameter's position has a statically non-nullable type.
/// A nullable argument (including one that has not been flow-narrowed to
/// non-null) leaves the declared nullable return in place, so
/// `Path.ChangeExtension(maybeNil, ".gs")` is still rejected where a
/// non-nullable `string` is required.
internal shared class ConditionalReturnNarrowing {
    /// Returns [`declaredReturn`](paramref) stripped of its top-level
    /// nullable annotation when [`method`](paramref) carries a
    /// `[return: NotNullIfNotNull]` naming a parameter whose argument at
    /// this call site is known non-null; otherwise returns
    /// [`declaredReturn`](paramref) unchanged.
    /// @param method The imported method being called.
    /// @param arguments The bound arguments, in parameter order.
    /// @param declaredReturn The declared (reader-derived) return type.
    /// @returns The call-site return type.
    func Apply(method MethodInfo?, arguments ImmutableArray[BoundExpression], declaredReturn TypeSymbol) TypeSymbol {
        // Only a declared-nullable reference return has anything to narrow.
        if method == nil || declaredReturn is not NullableTypeSymbol nullableReturn {
            return declaredReturn
        }
        if arguments.IsDefaultOrEmpty {
            return declaredReturn
        }
        let names = ClrNullability.GetNotNullIfNotNullParameters(method)
        if names.Count == 0 {
            return declaredReturn
        }
        let parameters = method.GetParameters()
        for name in names {
            for var i = 0; i < parameters.Length && i < arguments.Length; i++ {
                if !string.Equals(parameters[i].Name, name, StringComparison.Ordinal) {
                    continue
                }
                if IsKnownNonNull(arguments[i]) {
                    return nullableReturn.UnderlyingType
                }
                break
            }
        }
        return declaredReturn
    }

    private func IsKnownNonNull(argument BoundExpression) bool {
        var argument = argument
        if StatementBinder.IsNilLiteral(argument) {
            return false
        }
        // Peel a pure ANNOTATION widening (`T` converted to `T?`, which is how a
        // non-nil argument reaches a `T?`-typed parameter — including a generic
        // parameter whose type argument inference already closed over `T?`, as
        // in `Interlocked.Exchange(&slot, v)` where `slot` is `T?`). Such a
        // conversion changes the annotation, never the value, so a non-nullable
        // operand underneath it is still known non-nil. Only this exact shape is
        // peeled: a user-defined or representation-changing conversion could
        // legitimately produce nil from a non-nil operand.
        while argument is BoundConversionExpression conversion &&
            conversion.Type is NullableTypeSymbol widened &&
            conversion
            .Expression
            .Type != nil &&
            widened.UnderlyingType == conversion
            .Expression
            .Type {
            argument = conversion.Expression
        }
        var type TypeSymbol? = argument.Type
        // A `ref`/`out` argument's nullability is the POINTEE's — issue #3727's
        // `Volatile.Read(&r)` is annotated `[return: NotNullIfNotNull(nameof(location))]`
        // and passes `ref Result?`, which must NOT narrow: the location holds
        // nil. Reading the byref wrapper as "not a NullableTypeSymbol" would
        // narrow every such call and re-break `Volatile.Read(&r) != nil`.
        while type is ByRefTypeSymbol byRef {
            type = byRef.PointeeType
        }
        return type != nil && !(type is NullableTypeSymbol) && !object.ReferenceEquals(type, TypeSymbol.Null)
    }
}
