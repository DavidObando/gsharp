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
        bool hasTrailingOutBool,
        ImmutableArray<int> forwardedSourceIndices,
        RefKind handlerRefKind)
    {
        HandlerClrType = handlerClrType;
        HandlerType = handlerType;
        Constructor = constructor;
        ForwardedArguments = forwardedArguments;
        HasTrailingOutBool = hasTrailingOutBool;
        ForwardedSourceIndices = forwardedSourceIndices;
        HandlerRefKind = handlerRefKind;
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

    /// <summary>
    /// Gets, for each entry in <see cref="ForwardedArguments"/>, the index of
    /// the originating sibling parameter (<c>-1</c> denotes the instance
    /// receiver). Issue #377 sub-item 2: used by the call binder to capture
    /// each forwarded source into a single temp shared by the parent
    /// argument slot and the handler constructor so the source expression
    /// is evaluated exactly once.
    /// </summary>
    public ImmutableArray<int> ForwardedSourceIndices { get; }

    /// <summary>
    /// Gets the <see cref="RefKind"/> of the handler-typed parameter
    /// (<see cref="RefKind.None"/>, <see cref="RefKind.Ref"/>,
    /// <see cref="RefKind.In"/>, or <see cref="RefKind.Out"/>). Issue #377
    /// sub-item 1: the lowerer uses this to feed the constructed handler
    /// local by-ref/in/out to the consuming method.
    /// </summary>
    public RefKind HandlerRefKind { get; }

    /// <summary>Returns a copy of this info with rewritten forwarded arguments (used by tree rewriters).</summary>
    /// <param name="forwardedArguments">The replacement forwarded arguments.</param>
    /// <returns>The updated info.</returns>
    public InterpolatedStringHandlerInfo WithForwardedArguments(ImmutableArray<BoundExpression> forwardedArguments)
        => new(HandlerClrType, HandlerType, Constructor, forwardedArguments, HasTrailingOutBool, ForwardedSourceIndices, HandlerRefKind);

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
        => TryCreate(
            handlerClrType,
            parameter,
            parameters,
            arguments,
            receiver,
            ImmutableArray<BoundInterpolatedStringPart>.Empty,
            out failure);

    internal static InterpolatedStringHandlerInfo TryCreate(
        System.Type handlerClrType,
        ParameterInfo parameter,
        ParameterInfo[] parameters,
        ImmutableArray<BoundExpression> arguments,
        BoundExpression receiver,
        ImmutableArray<BoundInterpolatedStringPart> parts,
        out string failure)
    {
        failure = null;

        // Issue #377 sub-item 1: a `[InterpolatedStringHandler]` parameter
        // may be byref (typical for `ref struct` handlers such as
        // DefaultInterpolatedStringHandler). Peel the byref before walking
        // attributes / constructors, and capture the RefKind so the call
        // emitter feeds the constructed handler local by-ref/in/out.
        var paramType = parameter.ParameterType;
        var peeled = paramType.IsByRef ? paramType.GetElementType() : (handlerClrType ?? paramType);

        var names = ReadForwardedNames(parameter);
        var forwarded = ImmutableArray.CreateBuilder<BoundExpression>(names.Length);
        var sources = ImmutableArray.CreateBuilder<int>(names.Length);
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
                sources.Add(-1);
                continue;
            }

            var index = System.Array.FindIndex(parameters, p => string.Equals(p.Name, name, System.StringComparison.Ordinal));
            if (index < 0 || index >= arguments.Length)
            {
                failure = $"the handler argument references parameter '{name}', which is not a preceding argument of this call";
                return null;
            }

            forwarded.Add(arguments[index]);
            sources.Add(index);
        }

        var forwardedArgs = forwarded.ToImmutable();
        var constructor = SelectConstructor(peeled, forwardedArgs, out var hasOutBool);
        if (constructor == null)
        {
            failure = $"'{peeled.Name}' has no interpolated-string-handler constructor matching the forwarded arguments";
            return null;
        }

        if (!ValidateAppendMethods(peeled, parts, out failure))
        {
            return null;
        }

        // Issue #377 sub-item 1: capture the parameter's RefKind so the call
        // binder/lowerer can feed the constructed handler local by-ref.
        var handlerRefKind = RefKind.None;
        if (paramType.IsByRef)
        {
            if (parameter.IsOut)
            {
                handlerRefKind = RefKind.Out;
            }
            else if (parameter.IsIn)
            {
                handlerRefKind = RefKind.In;
            }
            else
            {
                handlerRefKind = RefKind.Ref;
            }
        }

        return new InterpolatedStringHandlerInfo(
            peeled,
            TypeSymbol.FromClrType(peeled),
            constructor,
            forwardedArgs,
            hasOutBool,
            sources.ToImmutable(),
            handlerRefKind);
    }

    internal static bool TryResolveAppendFormatted(
        System.Type handlerType,
        BoundInterpolatedStringPart part,
        TypeSymbol holeType,
        out MethodInfo method,
        out ImmutableArray<TypeSymbol> typeArguments)
    {
        method = null;
        typeArguments = default;
        var wantAlign = part.Alignment.HasValue;
        var wantFormat = part.Format != null;
        var extra = (wantAlign ? 1 : 0) + (wantFormat ? 1 : 0);
        var candidates = ImmutableArray.CreateBuilder<MethodInfo>();

        foreach (var candidate in handlerType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
        {
            if (candidate.Name != "AppendFormatted")
            {
                continue;
            }

            var parameters = candidate.GetParameters();
            if (parameters.Length != 1 + extra)
            {
                continue;
            }

            var index = 1;
            if (wantAlign && !parameters[index++].ParameterType.IsSameAs(typeof(int)))
            {
                continue;
            }

            if (wantFormat && !parameters[index].ParameterType.IsSameAs(typeof(string)))
            {
                continue;
            }

            candidates.Add(candidate);
        }

        if (candidates.Count == 0)
        {
            return false;
        }

        var valueClrType = NullableTypeSymbol.GetEffectiveClrType(holeType);
        if (valueClrType != null)
        {
            var argumentTypes = new System.Type[1 + extra];
            argumentTypes[0] = valueClrType;
            var index = 1;
            if (wantAlign)
            {
                argumentTypes[index++] = typeof(int);
            }

            if (wantFormat)
            {
                argumentTypes[index] = typeof(string);
            }

            var resolution = OverloadResolution.Resolve<MethodInfo>(candidates, argumentTypes);
            if (resolution.Outcome == OverloadResolution.ResolutionOutcome.Resolved)
            {
                method = resolution.Best;
            }
            else if (resolution.Outcome == OverloadResolution.ResolutionOutcome.Ambiguous)
            {
                foreach (var candidate in resolution.Ambiguous)
                {
                    if (candidate.IsGenericMethod)
                    {
                        continue;
                    }

                    if (method != null)
                    {
                        method = null;
                        break;
                    }

                    method = candidate;
                }
            }

            if (method == null)
            {
                return false;
            }
        }
        else
        {
            method = candidates.FirstOrDefault(candidate => candidate.IsGenericMethodDefinition)
                ?? candidates[0];
        }

        if (!method.IsGenericMethodDefinition)
        {
            return true;
        }

        if (valueClrType != null)
        {
            method = method.MakeGenericMethod(valueClrType);
            return true;
        }

        method = method.MakeGenericMethod(typeof(object));
        typeArguments = ImmutableArray.Create(holeType);
        return true;
    }

    private static bool ValidateAppendMethods(
        System.Type handlerType,
        ImmutableArray<BoundInterpolatedStringPart> parts,
        out string failure)
    {
        failure = null;
        if (parts.Any(part => part.IsLiteral && part.Literal.Length > 0)
            && handlerType.GetMethod("AppendLiteral", new[] { typeof(string) }) == null)
        {
            failure = $"'{handlerType.Name}' has no AppendLiteral(string) method";
            return false;
        }

        foreach (var part in parts)
        {
            if (part.IsHole
                && !TryResolveAppendFormatted(handlerType, part, part.Value.Type, out _, out _))
            {
                var shape = part.Alignment.HasValue && part.Format != null
                    ? "(value, int, string)"
                    : part.Alignment.HasValue
                        ? "(value, int)"
                        : part.Format != null
                            ? "(value, string)"
                            : "(value)";
                failure = $"'{handlerType.Name}' has no applicable AppendFormatted{shape} method";
                return false;
            }
        }

        return true;
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
