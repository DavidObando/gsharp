// <copyright file="ImportedClassSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents an imported class symbol in the language.
/// </summary>
public sealed class ImportedClassSymbol : Symbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ImportedClassSymbol"/> class.
    /// </summary>
    /// <param name="type">The imported class type.</param>
    /// <param name="declaration">The imported class declaration.</param>
    /// <param name="symbolicReceiver">
    /// Issue #1330: when this imported class is the type-erased closed form of a
    /// generic type constructed over an in-scope generic type parameter — e.g.
    /// the <c>Comparer&lt;object&gt;</c> backing a <c>Comparer[TResult]</c>
    /// static-member receiver — the symbolic constructed view (open definition +
    /// symbolic type arguments) used to recover symbolic member/return types and
    /// to emit static member references parented at the constructed
    /// <c>Comparer&lt;!TResult&gt;</c> TypeSpec rather than the erased
    /// <c>Comparer&lt;object&gt;</c>. <c>null</c> for an ordinary imported class.
    /// </param>
    public ImportedClassSymbol(Type type, ExpressionSyntax declaration, ImportedTypeSymbol symbolicReceiver = null)
        : base(type.FullName)
    {
        ClassType = type;
        Declaration = declaration;
        SymbolicReceiver = symbolicReceiver;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.ImportedClass;

    /// <summary>
    /// Gets the imported class type.
    /// </summary>
    public Type ClassType { get; }

    /// <summary>
    /// Gets the symbolic constructed view of this receiver (#1330) when it
    /// is a generic type closed over an in-scope generic type parameter (e.g.
    /// <c>Comparer[TResult]</c>), or <c>null</c> for an ordinary imported class.
    /// Carries the open CLR definition and the symbolic type arguments so static
    /// member access recovers symbolic member types and the emitter parents
    /// static member references at the constructed generic TypeSpec.
    /// </summary>
    public ImportedTypeSymbol SymbolicReceiver { get; }

    /// <summary>
    /// Gets the imported class declaration.
    /// </summary>
    public ExpressionSyntax Declaration { get; }

    /// <summary>
    /// Tries to get a static member (field or property) from this imported
    /// class symbol. Static methods continue to flow through
    /// <see cref="TryLookupFunction(string, CallExpressionSyntax, ImmutableArray{BoundExpression}, out ImportedFunctionSymbol)"/>.
    /// </summary>
    /// <param name="text">The name of the member.</param>
    /// <param name="ne">The name expression (currently unused; reserved for diagnostics).</param>
    /// <param name="member">The resulting member when found.</param>
    /// <returns>Whether we found a matching public static field or property.</returns>
    public bool TryLookupMember(string text, NameExpressionSyntax ne, out MemberInfo member)
    {
        _ = ne;
        var property = ClrTypeUtilities.SafeGetProperty(ClassType, text, BindingFlags.Public | BindingFlags.Static);
        if (property != null && property.GetIndexParameters().Length == 0)
        {
            member = property;
            return true;
        }

        var field = ClrTypeUtilities.SafeGetField(ClassType, text, BindingFlags.Public | BindingFlags.Static);
        if (field != null)
        {
            member = field;
            return true;
        }

        member = null;
        return false;
    }

    /// <summary>
    /// Tries to get a function from this imported class symbol.
    /// </summary>
    /// <param name="text">The name of the function.</param>
    /// <param name="callExpression">The call expression.</param>
    /// <param name="arguments">The bound arguments.</param>
    /// <param name="function">The resulting function, if one is found.</param>
    /// <param name="parameterMapping">
    /// Issue #343: on success, the per-source-argument → parameter-position map
    /// when the call site used named arguments; default when source order already
    /// matches parameter order (the common path).
    /// </param>
    /// <param name="isAmbiguous">Set to true when two or more candidates tied under "better function member" rules.</param>
    /// <param name="explicitTypeArgs">
    /// Issue #311: resolved CLR type arguments from an explicit <c>[T1, T2]</c>
    /// list at the call site (e.g. <c>Array.Empty[string]()</c>), already
    /// projected onto the reference load context; <c>null</c> when the call has
    /// no explicit type arguments.
    /// </param>
    /// <param name="typeArgSymbols">
    /// Issue #320: explicit type-argument symbols in source order (carrying
    /// user-defined types that were closed with a placeholder CLR type), or default.
    /// </param>
    /// <param name="projectTypeArgument">
    /// Issue #321: projects an inferred type argument onto the reference load
    /// context so a generic method (e.g. <c>JsonSerializer.Serialize&lt;T&gt;</c>)
    /// can be closed via <c>MakeGenericMethod</c>. <c>null</c> disables projection.
    /// </param>
    /// <param name="argumentNames">
    /// Issue #343: per-source-argument names parallel to <paramref name="arguments"/>;
    /// <see langword="null"/> entries denote positional arguments. The default
    /// array indicates an all-positional call site (the common path).
    /// </param>
    /// <returns>Whether we found a matching function or not.</returns>
    public bool TryLookupFunction(string text, CallExpressionSyntax callExpression, ImmutableArray<BoundExpression> arguments, out ImportedFunctionSymbol function, out ImmutableArray<int> parameterMapping, out bool isAmbiguous, Type[] explicitTypeArgs = null, ImmutableArray<TypeSymbol> typeArgSymbols = default, Func<Type, Type> projectTypeArgument = null, IReadOnlyList<string> argumentNames = null)
        => TryLookupFunction(text, callExpression, arguments, out function, out parameterMapping, out isAmbiguous, out _, out _, explicitTypeArgs, typeArgSymbols, projectTypeArgument, argumentNames);

    /// <summary>
    /// Issue #506: backwards-compatible overload retaining the issue #505
    /// signature without the <c>isExpanded</c> flag. Discards the expanded
    /// flag.
    /// </summary>
    /// <param name="text">The name of the function.</param>
    /// <param name="callExpression">The call expression.</param>
    /// <param name="arguments">The bound arguments.</param>
    /// <param name="function">The resulting function, if one is found.</param>
    /// <param name="parameterMapping">Per-source-argument → parameter-position map (issue #343); default when none.</param>
    /// <param name="isAmbiguous">Set to <see langword="true"/> when two or more candidates tied under "better function member" rules.</param>
    /// <param name="ambiguousMethods">When <paramref name="isAmbiguous"/> is set, the tied candidates in source-encounter order; otherwise the empty array.</param>
    /// <param name="explicitTypeArgs">Resolved CLR type arguments from an explicit type-argument list.</param>
    /// <param name="typeArgSymbols">Explicit type-argument symbols in source order, or default.</param>
    /// <param name="projectTypeArgument">Projects an inferred type argument onto the reference load context, or <see langword="null"/>.</param>
    /// <param name="argumentNames">Per-source-argument names parallel to <paramref name="arguments"/>.</param>
    /// <returns>Whether we found a matching function or not.</returns>
    public bool TryLookupFunction(string text, CallExpressionSyntax callExpression, ImmutableArray<BoundExpression> arguments, out ImportedFunctionSymbol function, out ImmutableArray<int> parameterMapping, out bool isAmbiguous, out ImmutableArray<MethodInfo> ambiguousMethods, Type[] explicitTypeArgs = null, ImmutableArray<TypeSymbol> typeArgSymbols = default, Func<Type, Type> projectTypeArgument = null, IReadOnlyList<string> argumentNames = null)
        => TryLookupFunction(text, callExpression, arguments, out function, out parameterMapping, out isAmbiguous, out ambiguousMethods, out _, explicitTypeArgs, typeArgSymbols, projectTypeArgument, argumentNames);

    /// <summary>
    /// Issues #505 + #506: extended overload that, on ambiguity, returns the
    /// applicable candidate set (so the caller can surface competing
    /// signatures in the GS0160 diagnostic) and also reports whether the
    /// selected candidate was resolved in <c>params T[]</c> expanded form.
    /// </summary>
    /// <param name="text">The name of the function.</param>
    /// <param name="callExpression">The call expression.</param>
    /// <param name="arguments">The bound arguments.</param>
    /// <param name="function">The resulting function, if one is found.</param>
    /// <param name="parameterMapping">Per-source-argument → parameter-position map (issue #343); default when none.</param>
    /// <param name="isAmbiguous">Set to <see langword="true"/> when two or more candidates tied under "better function member" rules.</param>
    /// <param name="ambiguousMethods">When <paramref name="isAmbiguous"/> is set, the tied candidates in source-encounter order; otherwise the empty array.</param>
    /// <param name="isExpanded">Issue #506: set to <see langword="true"/> when overload resolution selected the candidate in <c>params T[]</c> expanded form, signalling the caller to pack the trailing positional arguments into a synthesised array before emit.</param>
    /// <param name="explicitTypeArgs">Resolved CLR type arguments from an explicit type-argument list.</param>
    /// <param name="typeArgSymbols">Explicit type-argument symbols in source order, or default.</param>
    /// <param name="projectTypeArgument">Projects an inferred type argument onto the reference load context, or <see langword="null"/>.</param>
    /// <param name="argumentNames">Per-source-argument names parallel to <paramref name="arguments"/>.</param>
    /// <returns>Whether we found a matching function or not.</returns>
    public bool TryLookupFunction(string text, CallExpressionSyntax callExpression, ImmutableArray<BoundExpression> arguments, out ImportedFunctionSymbol function, out ImmutableArray<int> parameterMapping, out bool isAmbiguous, out ImmutableArray<MethodInfo> ambiguousMethods, out bool isExpanded, Type[] explicitTypeArgs = null, ImmutableArray<TypeSymbol> typeArgSymbols = default, Func<Type, Type> projectTypeArgument = null, IReadOnlyList<string> argumentNames = null)
    {
        function = null;
        parameterMapping = default;
        isAmbiguous = false;
        ambiguousMethods = ImmutableArray<MethodInfo>.Empty;
        isExpanded = false;
        var methods = ClrTypeUtilities.SafeGetMethods(ClassType, BindingFlags.Static | BindingFlags.Instance | BindingFlags.Public);
        var nameMatches = methods.Where(m => m.Name == text).ToList();
        if (nameMatches.Count == 0)
        {
            return false;
        }

        var argTypes = new Type[arguments.Length];
        var hasUserClassArg = false;
        for (var i = 0; i < arguments.Length; i++)
        {
            // Issue #1391: the untyped `default` literal (bound as a
            // BoundDefaultExpression whose type is the Error sentinel until a
            // target type is known) is convertible to any parameter type. Pass
            // the dedicated overload-resolution sentinel so it stays applicable
            // against an imported generic method closed over an explicit type
            // argument; the concrete-typed default is materialized downstream by
            // BindClrParameterConversions against the resolved parameter type.
            if (arguments[i] is BoundDefaultExpression { Type: var defType } && defType == TypeSymbol.Error)
            {
                argTypes[i] = OverloadResolution.DefaultLiteralArgumentType;
                continue;
            }

            // Issue #1538: an inline `out var`/`out let`/`out _` argument whose
            // type is omitted was bound in the eager first pass to a placeholder
            // address-of over an Error operand (no local declared yet, because
            // the out-parameter type was not known). Feed the dedicated sentinel
            // so overload resolution treats it as matching any by-ref parameter;
            // the caller re-binds the placeholder to the chosen overload's
            // out-parameter (pointee) type via RebindInlineOutVarArguments. This
            // mirrors the imported-instance path (ExpressionBinder.Calls.cs) so a
            // static/overloaded imported call (`int32.TryParse(s, out var n)`)
            // resolves instead of collapsing to GS0159 and poisoning the body.
            if (arguments[i] is BoundAddressOfExpression { Operand.Type: var outVarPointee } && outVarPointee == TypeSymbol.Error)
            {
                argTypes[i] = OverloadResolution.InlineOutVarArgumentType;
                continue;
            }

            // Issue #1599: a pre-declared `out r` (or `ref`) whose pointee is a
            // same-compilation user value type (a user enum or non-class struct)
            // has no reference-context CLR type, so its by-ref erasure cannot
            // match a value-type-constrained generic by-ref parameter such as the
            // `out TEnum` of `Enum.TryParse[Color](string, out r)` (the parameter
            // is closed over an `object`/placeholder erasure). Feed the same
            // "matches any by-ref parameter" sentinel used for inline `out var`
            // so the value-type-constrained generic overload stays applicable;
            // the recovered explicit type-argument symbols drive the constraint
            // check and emit. Without this the call collapses to GS0159.
            // Issue #1601: the same holds when the pointee is a value-type
            // (`struct`) constrained generic type parameter (e.g. a `TEnum`
            // forwarded from an enclosing `[TEnum Enum struct]`), which is also
            // erased to the placeholder and has no reference-context CLR type.
            if (arguments[i] is BoundAddressOfExpression { Operand.Type: var byRefPointee }
                && (byRefPointee is EnumSymbol or StructSymbol { IsClass: false }
                    || byRefPointee is TypeParameterSymbol { HasValueTypeConstraint: true })
                && byRefPointee.ClrType == null)
            {
                argTypes[i] = OverloadResolution.InlineOutVarArgumentType;
                continue;
            }

            // Issue #530: use effective CLR type so nullable value types
            // (e.g. int32?) are matched as Nullable<T> in overload resolution.
            // Issue #533: allow null (nil literal) through; overload resolution
            // now classifies null source as compatible with reference types and
            // Nullable<T>.
            // Issue #658: provide surrogate type for user-defined G# classes.
            var t = NullableTypeSymbol.GetEffectiveClrType(arguments[i].Type);
            if (t == null && arguments[i].Type != TypeSymbol.Null)
            {
                if (arguments[i].Type is StructSymbol { IsClass: true } ss)
                {
                    t = ss.ImportedBaseType?.ClrType ?? typeof(object);
                    hasUserClassArg = true;
                }
                else if (arguments[i].Type is InterfaceSymbol || arguments[i].Type is DelegateTypeSymbol)
                {
                    // Issue #1421 / ADR-0087 §3 R5: a user-defined G# interface or
                    // named delegate argument carries no ClrType during binding
                    // (its TypeDef only exists in the assembly being emitted), so
                    // GetEffectiveClrType returned null above. It rides through the
                    // same `object` boundary as a user struct — an interface value
                    // is reference-convertible to `object` — so overload resolution
                    // can pick an `object`(?) parameter (e.g.
                    // `ArgumentNullException.ThrowIfNull(object?)`). Mirrors
                    // ExpressionBinder.GetEffectiveArgumentClrTypeForOverloadResolution.
                    t = typeof(object);
                }
                else if (arguments[i].Type is EnumSymbol)
                {
                    // Issue #661: user-defined G# enum — backed by int32 at CLR level.
                    t = typeof(int);
                }
                else if (arguments[i].Type is NullableTypeSymbol { UnderlyingType: EnumSymbol })
                {
                    // Issue #661: Nullable<UserEnum> — map to Nullable<int>.
                    t = typeof(int?);
                }
                else if (MemberLookup.TryProjectErasedClrType(arguments[i].Type, out var erased))
                {
                    // Issue #833: argument carries an open method/type
                    // parameter (e.g. `T`, `[]T`, `IEnumerable[T]`). The
                    // overload-resolution layer needs *some* CLR type to
                    // unify against the candidate's open generic parameter,
                    // so project the TP positions to `object` (and slices
                    // to `object[]`). Symbolic recovery for the return
                    // type and MethodSpec args happens via
                    // BuildSymbolicMethodTypeArgs +
                    // ResolveCallReturnTypeFromSymbolicTypeArgs below.
                    t = erased;
                }
                else
                {
                    return false;
                }
            }

            argTypes[i] = t;
        }

        // Issue #658 / #1634: supplementary interface check for user-class args,
        // threaded as a call-local parameter into Resolve instead of a shared
        // static so nested/concurrent binds can't clobber it.
        Func<Type, Type, bool> supplementaryInterfaceCheck = hasUserClassArg
            ? (source, target) => IsUserClassAssignableToInterface(arguments, argTypes, source, target)
            : null;

        // Issue #1325: recover the symbolic type-argument vector per candidate
        // so the generic-constraint check can see through the `object`
        // erasure of same-compilation user value types (a user struct must
        // satisfy `where T : struct`, e.g. MemoryMarshal.Cast/AsBytes).
        var symbolicArgVector = MemberLookup.BuildSymbolicArgTypeVector(
            receiverType: null,
            ImmutableArray.CreateRange(arguments.Select(a => a?.Type)));
        var result = OverloadResolution.Resolve(
            nameMatches,
            argTypes,
            explicitTypeArgs,
            projectTypeArgument,
            ComputeInterpolatedStringArgFlags(callExpression, arguments.Length),
            argumentNames,
            closed => MemberLookup.BuildSymbolicMethodTypeArgs(closed, typeArgSymbols, symbolicArgVector),
            supplementaryInterfaceCheck: supplementaryInterfaceCheck);

        switch (result.Outcome)
        {
            case OverloadResolution.ResolutionOutcome.Resolved:
                // Issue #320: when an imported generic method returns exactly one
                // of its method type parameters and was closed over a user-defined
                // type argument (placeholder CLR type), recover the real return
                // type from the explicit type-argument symbol.
                TypeSymbol returnOverride = null;
                if (!typeArgSymbols.IsDefaultOrEmpty
                    && OverloadResolution.TryGetGenericMethodParameterReturnPosition(result.Best, out var position)
                    && position >= 0
                    && position < typeArgSymbols.Length)
                {
                    returnOverride = typeArgSymbols[position];
                }

                // Issue #833: when the open return type *contains* (but is not
                // exactly) a method type parameter that aligns with an in-scope
                // G# type parameter (e.g. `Enumerable.Empty[T]() IEnumerable[T]`),
                // recover the symbolic projection so the call site doesn't keep
                // the type-erased `IEnumerable<object>`.
                if (returnOverride == null)
                {
                    var symbolicMethodTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(result.Best, typeArgSymbols, symbolicArgVector);
                    returnOverride = MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(result.Best, symbolicMethodTypeArgs, receiverType: null);
                }

                function = new ImportedFunctionSymbol(text, this, result.Best, callExpression, returnOverride);
                parameterMapping = result.ParameterMapping;
                isExpanded = result.IsExpanded;
                return true;
            case OverloadResolution.ResolutionOutcome.Ambiguous:
                isAmbiguous = true;
                ambiguousMethods = result.Ambiguous;
                return false;
            default:
                return false;
        }
    }

    /// <summary>
    /// Backwards-compatible overload retaining the original signature
    /// (without parameter-mapping output). Calls the named-argument-aware
    /// overload with a default mapping.
    /// </summary>
    /// <param name="text">The name of the function.</param>
    /// <param name="callExpression">The call expression.</param>
    /// <param name="arguments">The bound arguments.</param>
    /// <param name="function">The resulting function, if one is found.</param>
    /// <param name="isAmbiguous">Set to true when two or more candidates tied under "better function member" rules.</param>
    /// <param name="explicitTypeArgs">Resolved CLR type arguments from an explicit type-argument list.</param>
    /// <param name="typeArgSymbols">Explicit type-argument symbols in source order, or default.</param>
    /// <param name="projectTypeArgument">Projects an inferred type argument onto the reference load context, or <see langword="null"/>.</param>
    /// <returns>Whether we found a matching function or not.</returns>
    public bool TryLookupFunction(string text, CallExpressionSyntax callExpression, ImmutableArray<BoundExpression> arguments, out ImportedFunctionSymbol function, out bool isAmbiguous, Type[] explicitTypeArgs = null, ImmutableArray<TypeSymbol> typeArgSymbols = default, Func<Type, Type> projectTypeArgument = null)
        => TryLookupFunction(text, callExpression, arguments, out function, out _, out isAmbiguous, explicitTypeArgs, typeArgSymbols, projectTypeArgument);

    /// <summary>
    /// Backwards-compatible overload that drops the ambiguity flag.
    /// </summary>
    /// <param name="text">The name of the function.</param>
    /// <param name="callExpression">The call expression.</param>
    /// <param name="arguments">The bound arguments.</param>
    /// <param name="function">The resulting function, if one is found.</param>
    /// <returns>Whether we found a matching function or not.</returns>
    public bool TryLookupFunction(string text, CallExpressionSyntax callExpression, ImmutableArray<BoundExpression> arguments, out ImportedFunctionSymbol function)
        => TryLookupFunction(text, callExpression, arguments, out function, out _);

    /// <summary>
    /// ADR-0055 Tier 4 (#369): produces the per-argument flags marking which
    /// positional call arguments are interpolated-string literals, so overload
    /// resolution can treat them as convertible to
    /// <c>IFormattable</c>/<c>FormattableString</c> parameters. Returns
    /// <see langword="null"/> when no argument qualifies (the common path).
    /// </summary>
    private static System.Collections.Generic.IReadOnlyList<bool> ComputeInterpolatedStringArgFlags(CallExpressionSyntax callExpression, int count)
    {
        if (callExpression == null)
        {
            return null;
        }

        bool[] flags = null;
        var argumentSyntax = callExpression.Arguments;
        var limit = Math.Min(count, argumentSyntax.Count);
        for (var i = 0; i < limit; i++)
        {
            // Issue #377 sub-item 5: an interpolated string passed as a named
            // argument (`M(arg: $"…")`) is wrapped by NamedArgumentExpressionSyntax.
            // Unwrap before classifying so Tier-4 target typing flows through
            // named arguments as well as positional ones.
            var argSyntax = OverloadResolver.UnwrapNamedArgumentValue(argumentSyntax[i]);
            if (argSyntax is InterpolatedStringExpressionSyntax)
            {
                flags ??= new bool[count];
                flags[i] = true;
            }
        }

        return flags;
    }

    /// <summary>
    /// Issue #658: checks whether a user-defined G# class argument implements
    /// the specified CLR target interface.
    /// </summary>
    private static bool IsUserClassAssignableToInterface(
        ImmutableArray<BoundExpression> boundArguments,
        Type[] argTypes,
        Type source,
        Type target)
    {
        for (var i = 0; i < boundArguments.Length; i++)
        {
            if (!ReferenceEquals(argTypes[i], source))
            {
                continue;
            }

            if (boundArguments[i].Type is StructSymbol { IsClass: true } ss)
            {
                for (var current = ss; current != null; current = current.BaseClass)
                {
                    foreach (var iface in current.ImplementedClrInterfaces)
                    {
                        if (iface.ClrType != null
                            && (ClrTypeUtilities.AreSame(iface.ClrType, target)
                                || ClrTypeUtilities.ImplementsInterfaceByName(iface.ClrType, target)))
                        {
                            return true;
                        }
                    }
                }

                if (ss.ImportedBaseType?.ClrType != null
                    && ClrTypeUtilities.ImplementsInterfaceByName(ss.ImportedBaseType.ClrType, target))
                {
                    return true;
                }
            }
        }

        return false;
    }
}
