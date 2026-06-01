// <copyright file="InterpolatedStringHandlerInfo.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #368 / ADR-0055: describes the user-defined interpolated-string-handler
/// target an interpolated string is being converted to when it is passed to a
/// method/constructor parameter whose type is attributed
/// <c>[InterpolatedStringHandler]</c>.
/// </summary>
/// <remarks>
/// When present on a <see cref="BoundInterpolatedStringExpression"/>, the emit
/// lowerer constructs the user handler (with the forwarded arguments resolved by
/// <c>[InterpolatedStringHandlerArgument]</c>) instead of the default
/// <c>DefaultInterpolatedStringHandler</c>, and yields the handler value itself
/// (rather than <c>ToStringAndClear()</c>) as the argument value. Mirrors the
/// C# 10 semantics: the handler constructor receives
/// <c>(int literalLength, int formattedCount [, ...forwarded args] [, out bool shouldAppend])</c>.
/// </remarks>
public sealed class InterpolatedStringHandlerInfo
{
    /// <summary>The CLR name of the <c>[InterpolatedStringHandler]</c> marker attribute.</summary>
    public const string HandlerAttributeName = "System.Runtime.CompilerServices.InterpolatedStringHandlerAttribute";

    /// <summary>The CLR name of the <c>[InterpolatedStringHandlerArgument]</c> attribute.</summary>
    public const string ArgumentAttributeName = "System.Runtime.CompilerServices.InterpolatedStringHandlerArgumentAttribute";

    private InterpolatedStringHandlerInfo(
        System.Type handlerClrType,
        TypeSymbol handlerType,
        ConstructorInfo constructor,
        ImmutableArray<BoundExpression> forwardedArguments,
        bool hasTrailingOutBool)
    {
        HandlerClrType = handlerClrType;
        HandlerType = handlerType;
        Constructor = constructor;
        ForwardedArguments = forwardedArguments;
        HasTrailingOutBool = hasTrailingOutBool;
    }

    /// <summary>Gets the reflection type of the handler.</summary>
    public System.Type HandlerClrType { get; }

    /// <summary>Gets the handler type symbol.</summary>
    public TypeSymbol HandlerType { get; }

    /// <summary>Gets the selected handler constructor.</summary>
    public ConstructorInfo Constructor { get; }

    /// <summary>
    /// Gets the bound expressions forwarded into the constructor after the
    /// <c>(literalLength, formattedCount)</c> pair, in constructor order.
    /// </summary>
    public ImmutableArray<BoundExpression> ForwardedArguments { get; }

    /// <summary>Gets a value indicating whether the constructor ends with an <c>out bool</c> short-circuit parameter.</summary>
    public bool HasTrailingOutBool { get; }

    /// <summary>Returns a copy of this info with rewritten forwarded arguments (used by tree rewriters).</summary>
    /// <param name="forwardedArguments">The replacement forwarded arguments.</param>
    /// <returns>The updated info.</returns>
    public InterpolatedStringHandlerInfo WithForwardedArguments(ImmutableArray<BoundExpression> forwardedArguments)
        => new(HandlerClrType, HandlerType, Constructor, forwardedArguments, HasTrailingOutBool);

    /// <summary>
    /// Determines whether <paramref name="type"/> is attributed
    /// <c>[InterpolatedStringHandler]</c>. Uses <see cref="CustomAttributeData"/>
    /// so it is safe under a <c>MetadataLoadContext</c>.
    /// </summary>
    /// <param name="type">The candidate parameter type (already by-ref peeled).</param>
    /// <returns><see langword="true"/> when the type is a handler.</returns>
    public static bool IsHandlerType(System.Type type)
    {
        if (type == null)
        {
            return false;
        }

        if (type.IsByRef)
        {
            type = type.GetElementType();
            if (type == null)
            {
                return false;
            }
        }

        try
        {
            foreach (var attribute in type.GetCustomAttributesData())
            {
                if (string.Equals(attribute.AttributeType?.FullName, HandlerAttributeName, System.StringComparison.Ordinal))
                {
                    return true;
                }
            }
        }
        catch (System.Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
        {
            return false;
        }

        return false;
    }

    /// <summary>
    /// Reads the forwarded-argument names declared by an
    /// <c>[InterpolatedStringHandlerArgument]</c> attribute on
    /// <paramref name="parameter"/>. Returns an empty array when none is present
    /// (the handler constructor then takes only <c>(literalLength, formattedCount)</c>).
    /// </summary>
    /// <param name="parameter">The handler-typed parameter.</param>
    /// <returns>The forwarded names in declaration order; <c>""</c> denotes the receiver.</returns>
    public static ImmutableArray<string> ReadForwardedNames(ParameterInfo parameter)
    {
        foreach (var attribute in parameter.GetCustomAttributesData())
        {
            if (!string.Equals(attribute.AttributeType?.FullName, ArgumentAttributeName, System.StringComparison.Ordinal))
            {
                continue;
            }

            if (attribute.ConstructorArguments.Count != 1)
            {
                continue;
            }

            var arg = attribute.ConstructorArguments[0];

            // The string overload: [InterpolatedStringHandlerArgument("name")].
            if (arg.Value is string single)
            {
                return ImmutableArray.Create(single);
            }

            // The params string[] overload: [InterpolatedStringHandlerArgument("a", "b")].
            if (arg.Value is IReadOnlyList<CustomAttributeTypedArgument> many)
            {
                var builder = ImmutableArray.CreateBuilder<string>(many.Count);
                foreach (var element in many)
                {
                    builder.Add(element.Value as string);
                }

                return builder.ToImmutable();
            }
        }

        return ImmutableArray<string>.Empty;
    }

    /// <summary>
    /// Builds the handler info for a handler-typed parameter, resolving the
    /// forwarded sibling arguments / receiver and selecting the matching
    /// constructor. Returns <see langword="null"/> when no compatible
    /// constructor exists or a referenced argument name cannot be resolved
    /// (the caller then reports a diagnostic / leaves the argument as-is).
    /// </summary>
    /// <param name="handlerClrType">The handler parameter type (by-ref peeled).</param>
    /// <param name="parameter">The handler-typed parameter (source of the forwarding attribute).</param>
    /// <param name="parameters">All parameters of the resolved method/constructor.</param>
    /// <param name="arguments">The bound positional arguments aligned with <paramref name="parameters"/>.</param>
    /// <param name="receiver">The instance receiver for the call, or <see langword="null"/>.</param>
    /// <param name="failure">A human-readable reason when the result is <see langword="null"/>.</param>
    /// <returns>The resolved handler info, or <see langword="null"/>.</returns>
    public static InterpolatedStringHandlerInfo TryCreate(
        System.Type handlerClrType,
        ParameterInfo parameter,
        ParameterInfo[] parameters,
        ImmutableArray<BoundExpression> arguments,
        BoundExpression receiver,
        out string failure)
    {
        failure = null;

        var names = ReadForwardedNames(parameter);
        var forwarded = ImmutableArray.CreateBuilder<BoundExpression>(names.Length);
        foreach (var name in names)
        {
            if (string.IsNullOrEmpty(name))
            {
                if (receiver == null)
                {
                    failure = "the handler argument references the receiver ('') but the call has no instance receiver";
                    return null;
                }

                forwarded.Add(receiver);
                continue;
            }

            var index = System.Array.FindIndex(parameters, p => string.Equals(p.Name, name, System.StringComparison.Ordinal));
            if (index < 0 || index >= arguments.Length)
            {
                failure = $"the handler argument references parameter '{name}', which is not a preceding argument of this call";
                return null;
            }

            forwarded.Add(arguments[index]);
        }

        var forwardedArgs = forwarded.ToImmutable();
        var constructor = SelectConstructor(handlerClrType, forwardedArgs, out var hasOutBool);
        if (constructor == null)
        {
            failure = $"'{handlerClrType.Name}' has no interpolated-string-handler constructor matching the forwarded arguments";
            return null;
        }

        return new InterpolatedStringHandlerInfo(
            handlerClrType,
            TypeSymbol.FromClrType(handlerClrType),
            constructor,
            forwardedArgs,
            hasOutBool);
    }

    private static ConstructorInfo SelectConstructor(
        System.Type handlerClrType,
        ImmutableArray<BoundExpression> forwardedArgs,
        out bool hasOutBool)
    {
        hasOutBool = false;
        ConstructorInfo match = null;
        var matchOutBool = false;

        foreach (var ctor in handlerClrType.GetConstructors(BindingFlags.Public | BindingFlags.Instance))
        {
            var ps = ctor.GetParameters();

            // The shape is (int literalLength, int formattedCount, <forwarded...>, [out bool]).
            if (ps.Length < 2 + forwardedArgs.Length)
            {
                continue;
            }

            if (!IsInt32(ps[0].ParameterType) || !IsInt32(ps[1].ParameterType))
            {
                continue;
            }

            var ok = true;
            for (var i = 0; i < forwardedArgs.Length; i++)
            {
                var paramType = ps[2 + i].ParameterType;
                if (paramType.IsByRef)
                {
                    paramType = paramType.GetElementType();
                }

                var argType = forwardedArgs[i].Type?.ClrType;
                if (argType != null
                    && OverloadResolution.ClassifyImplicit(paramType, argType) == OverloadResolution.ImplicitConversionKind.None)
                {
                    ok = false;
                    break;
                }
            }

            if (!ok)
            {
                continue;
            }

            var remaining = ps.Length - (2 + forwardedArgs.Length);
            bool ctorOutBool;
            if (remaining == 0)
            {
                ctorOutBool = false;
            }
            else if (remaining == 1 && ps[ps.Length - 1].IsOut && IsBoolean(ps[ps.Length - 1].ParameterType))
            {
                ctorOutBool = true;
            }
            else
            {
                continue;
            }

            // Prefer the constructor that does not need the out-bool gate when
            // both are present (fewer parameters), matching C#'s preference.
            if (match == null || (matchOutBool && !ctorOutBool))
            {
                match = ctor;
                matchOutBool = ctorOutBool;
            }
        }

        hasOutBool = matchOutBool;
        return match;
    }

    private static bool IsInt32(System.Type t)
        => string.Equals(t.FullName, "System.Int32", System.StringComparison.Ordinal);

    private static bool IsBoolean(System.Type t)
    {
        if (t.IsByRef)
        {
            t = t.GetElementType();
        }

        return string.Equals(t?.FullName, "System.Boolean", System.StringComparison.Ordinal);
    }
}
