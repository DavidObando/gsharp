// <copyright file="ImportedClassSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
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
    public ImportedClassSymbol(Type type, ExpressionSyntax declaration)
        : base(type.FullName)
    {
        ClassType = type;
        Declaration = declaration;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.ImportedClass;

    /// <summary>
    /// Gets the imported class type.
    /// </summary>
    public Type ClassType { get; }

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
    /// <returns>Whether we found a matching function or not.</returns>
    public bool TryLookupFunction(string text, CallExpressionSyntax callExpression, ImmutableArray<BoundExpression> arguments, out ImportedFunctionSymbol function, out bool isAmbiguous, Type[] explicitTypeArgs = null, ImmutableArray<TypeSymbol> typeArgSymbols = default, Func<Type, Type> projectTypeArgument = null)
    {
        function = null;
        isAmbiguous = false;
        var methods = ClrTypeUtilities.SafeGetMethods(ClassType, BindingFlags.Static | BindingFlags.Instance | BindingFlags.Public);
        var nameMatches = methods.Where(m => m.Name == text).ToList();
        if (nameMatches.Count == 0)
        {
            return false;
        }

        var argTypes = new Type[arguments.Length];
        for (var i = 0; i < arguments.Length; i++)
        {
            var t = arguments[i].Type?.ClrType;
            if (t == null)
            {
                return false;
            }

            argTypes[i] = t;
        }

        var result = OverloadResolution.Resolve(nameMatches, argTypes, explicitTypeArgs, projectTypeArgument, ComputeInterpolatedStringArgFlags(callExpression, arguments.Length));
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

                function = new ImportedFunctionSymbol(text, this, result.Best, callExpression, returnOverride);
                return true;
            case OverloadResolution.ResolutionOutcome.Ambiguous:
                isAmbiguous = true;
                return false;
            default:
                return false;
        }
    }

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
            if (argumentSyntax[i] is InterpolatedStringExpressionSyntax)
            {
                flags ??= new bool[count];
                flags[i] = true;
            }
        }

        return flags;
    }
}
