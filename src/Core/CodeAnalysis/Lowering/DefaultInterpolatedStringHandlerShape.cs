// <copyright file="DefaultInterpolatedStringHandlerShape.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>
/// Issue #3730 (issue #3705, family 3 — the load-context family): the
/// <c>System.Runtime.CompilerServices.DefaultInterpolatedStringHandler</c>
/// surface that <see cref="InterpolatedStringHandlerLowerer"/> lowers onto,
/// resolved from the <em>compilation's reference closure</em> rather than from
/// the SDK hosting <c>gsc</c>.
/// <para>
/// The lowerer used to hold <c>static readonly Type HandlerType =
/// typeof(DefaultInterpolatedStringHandler)</c> and reflect the constructor,
/// <c>AppendLiteral</c>, <c>ToStringAndClear</c> and the four
/// <c>AppendFormatted&lt;T&gt;</c> overloads off it. That is a live host
/// <c>typeof</c>, so it answers for the framework <c>gsc</c> is <em>running
/// on</em>, never for the framework it is <em>compiling against</em>. Two
/// silent divergences follow, both of the kind #3705 catalogues:
/// </para>
/// <list type="bullet">
/// <item>an overload present on the host but absent from the target is
/// accepted, and the emitted call cannot resolve at the target's runtime;</item>
/// <item>when the target closure does not declare the handler <em>at all</em>
/// (any <c>netstandard2.x</c> target, for instance), #3729's
/// <c>ImportedMemberRefFactory.GetTypeReference</c> projection has nothing to
/// project onto and falls back to the host type — so the compiled assembly
/// silently acquired a <c>TypeRef</c> scoped to
/// <c>System.Private.CoreLib, 10.0.0.0</c>, the very leak #3729 closed, and
/// the compile reported success.</item>
/// </list>
/// <para>
/// Resolution therefore goes through <see cref="ReferenceResolver.TryResolveType(string, out Type)"/> —
/// the established funnel for "give me a well-known type in <em>this</em>
/// compilation's reflection context" — and every member probe compares
/// parameter types with <see cref="ClrTypeUtilities.IsSameAs"/> rather than
/// reference identity against a host <c>typeof</c>, because the resolved
/// members are <see cref="System.Reflection.MetadataLoadContext"/> types on
/// every real <c>/reference:</c> compile.
/// </para>
/// </summary>
internal sealed class DefaultInterpolatedStringHandlerShape
{
    /// <summary>The handler's metadata name, as spelled in the target framework.</summary>
    public const string HandlerTypeFullName = "System.Runtime.CompilerServices.DefaultInterpolatedStringHandler";

    private DefaultInterpolatedStringHandlerShape(
        Type handlerType,
        ConstructorInfo constructor,
        MethodInfo appendLiteral,
        MethodInfo toStringAndClear,
        MethodInfo? appendFormattedValue,
        MethodInfo? appendFormattedAlign,
        MethodInfo? appendFormattedFormat,
        MethodInfo? appendFormattedAlignFormat)
    {
        this.HandlerType = handlerType;
        this.HandlerTypeSymbol = TypeSymbol.FromClrType(handlerType);
        this.Constructor = constructor;
        this.AppendLiteral = appendLiteral;
        this.ToStringAndClear = toStringAndClear;
        this.AppendFormattedValue = appendFormattedValue;
        this.AppendFormattedAlign = appendFormattedAlign;
        this.AppendFormattedFormat = appendFormattedFormat;
        this.AppendFormattedAlignFormat = appendFormattedAlignFormat;
    }

    /// <summary>Gets the target framework's handler type.</summary>
    public Type HandlerType { get; }

    /// <summary>Gets the symbol wrapping <see cref="HandlerType"/>.</summary>
    public TypeSymbol HandlerTypeSymbol { get; }

    /// <summary>Gets the target's <c>(literalLength, formattedCount)</c> constructor.</summary>
    public ConstructorInfo Constructor { get; }

    /// <summary>Gets the target's <c>void AppendLiteral(string)</c>.</summary>
    public MethodInfo AppendLiteral { get; }

    /// <summary>Gets the target's <c>string ToStringAndClear()</c>.</summary>
    public MethodInfo ToStringAndClear { get; }

    /// <summary>Gets the target's <c>void AppendFormatted&lt;T&gt;(T)</c>, when it declares one.</summary>
    public MethodInfo? AppendFormattedValue { get; }

    /// <summary>Gets the target's <c>void AppendFormatted&lt;T&gt;(T, int)</c>, when it declares one.</summary>
    public MethodInfo? AppendFormattedAlign { get; }

    /// <summary>Gets the target's <c>void AppendFormatted&lt;T&gt;(T, string)</c>, when it declares one.</summary>
    public MethodInfo? AppendFormattedFormat { get; }

    /// <summary>Gets the target's <c>void AppendFormatted&lt;T&gt;(T, int, string)</c>, when it declares one.</summary>
    public MethodInfo? AppendFormattedAlignFormat { get; }

    /// <summary>
    /// Resolves the handler surface from <paramref name="references"/>. Returns
    /// <see langword="false"/> — naming the missing member in
    /// <paramref name="missingMember"/> — when the target framework does not
    /// declare the shape the lowering needs, so the caller can select a
    /// target-compatible non-handler lowering.
    /// </summary>
    /// <param name="references">The compilation's reference closure.</param>
    /// <param name="shape">The resolved handler surface.</param>
    /// <param name="missingMember">The first member the target failed to provide.</param>
    /// <returns><see langword="true"/> when the target provides the required surface.</returns>
    public static bool TryResolve(
        ReferenceResolver references,
        [NotNullWhen(true)] out DefaultInterpolatedStringHandlerShape? shape,
        [NotNullWhen(false)] out string? missingMember)
    {
        shape = null;
        missingMember = null;

        if (!references.TryResolveType(HandlerTypeFullName, out var handlerType)
            || references.IsHostFallback(handlerType))
        {
            missingMember = HandlerTypeFullName;
            return false;
        }

        var constructor = FindConstructor(handlerType);
        if (constructor == null)
        {
            missingMember = HandlerTypeFullName + ".ctor(int, int)";
            return false;
        }

        var appendLiteral = FindAppendLiteral(handlerType);
        if (appendLiteral == null)
        {
            missingMember = HandlerTypeFullName + ".AppendLiteral(string)";
            return false;
        }

        var toStringAndClear = FindToStringAndClear(handlerType);
        if (toStringAndClear == null)
        {
            missingMember = HandlerTypeFullName + ".ToStringAndClear()";
            return false;
        }

        shape = new DefaultInterpolatedStringHandlerShape(
            handlerType,
            constructor,
            appendLiteral,
            toStringAndClear,
            FindAppendFormatted(handlerType, secondParam: null, thirdParam: null),
            FindAppendFormatted(handlerType, secondParam: typeof(int), thirdParam: null),
            FindAppendFormatted(handlerType, secondParam: typeof(string), thirdParam: null),
            FindAppendFormatted(handlerType, secondParam: typeof(int), thirdParam: typeof(string)));
        return true;
    }

    /// <summary>
    /// The <c>AppendFormatted&lt;T&gt;</c> overload an interpolation hole with
    /// the given alignment/format decorations needs, together with the C#-style
    /// signature used to name it in a diagnostic when the target lacks it.
    /// </summary>
    /// <param name="hasAlignment">Whether the hole carries an alignment.</param>
    /// <param name="hasFormat">Whether the hole carries a format specifier.</param>
    /// <returns>The overload (possibly <see langword="null"/>) and its display signature.</returns>
    public (MethodInfo? Method, string Signature) GetAppendFormatted(bool hasAlignment, bool hasFormat)
        => (hasAlignment, hasFormat) switch
        {
            (true, true) => (this.AppendFormattedAlignFormat, HandlerTypeFullName + ".AppendFormatted<T>(T, int, string)"),
            (true, false) => (this.AppendFormattedAlign, HandlerTypeFullName + ".AppendFormatted<T>(T, int)"),
            (false, true) => (this.AppendFormattedFormat, HandlerTypeFullName + ".AppendFormatted<T>(T, string)"),
            (false, false) => (this.AppendFormattedValue, HandlerTypeFullName + ".AppendFormatted<T>(T)"),
        };

    /// <summary>
    /// Closes an <c>AppendFormatted&lt;T&gt;</c> definition over an
    /// interpolation hole's CLR type.
    /// <para>
    /// Issue #3730: <paramref name="open"/> now belongs to the reference
    /// closure's reflection context while <paramref name="typeArgument"/> may
    /// still be a host <c>RuntimeType</c> (every built-in <c>TypeSymbol</c>
    /// wraps one), so the argument is projected into the handler's context
    /// first. Left unprojected, <c>MakeGenericMethod</c> yields a
    /// <c>System.Reflection.Emit.MethodBuilderInstantiation</c> whose
    /// <c>GetParameters()</c> answers the <em>unsubstituted</em> <c>T</c> —
    /// the same cross-context artefact #3752 hit through
    /// <c>MakeGenericType</c>.
    /// </para>
    /// <para>
    /// The projection goes through <c>ClrTypeUtilities.RemapHostCoreTypeToContext</c>,
    /// which is the sibling probe that was already right: the <em>user</em>-handler
    /// path in <c>InterpolatedStringHandlerInfo</c> has closed its
    /// <c>AppendFormatted&lt;T&gt;</c> over a remapped <c>typeof(object)</c>
    /// since #368, while the default-handler path here closed over raw host
    /// types. Same helper, same question, one of the two arms omitted it. It is
    /// best-effort by construction: a type the reference set cannot name falls
    /// back to the raw argument rather than failing the compile.
    /// </para>
    /// </summary>
    /// <param name="open">The open <c>AppendFormatted&lt;T&gt;</c> definition.</param>
    /// <param name="typeArgument">The hole's CLR type.</param>
    /// <returns>The closed method.</returns>
    public MethodInfo CloseAppendFormatted(MethodInfo open, Type typeArgument)
        => open.MakeGenericMethod(this.ProjectTypeArgument(typeArgument));

    /// <summary>
    /// Projects <paramref name="typeArgument"/> into the handler's reflection
    /// context, tolerating types the reference closure cannot name.
    /// </summary>
    /// <param name="typeArgument">The type to project.</param>
    /// <returns>The projected type, or the original when projection is impossible.</returns>
    public Type ProjectTypeArgument(Type typeArgument)
        => ClrTypeUtilities.RemapHostCoreTypeToContext(typeArgument, this.HandlerType) ?? typeArgument;

    private static ConstructorInfo? FindConstructor(Type handlerType)
    {
        foreach (var candidate in handlerType.GetConstructors(BindingFlags.Public | BindingFlags.Instance))
        {
            var parameters = candidate.GetParameters();
            if (parameters.Length == 2
                && parameters[0].ParameterType.IsSameAs(typeof(int))
                && parameters[1].ParameterType.IsSameAs(typeof(int)))
            {
                return candidate;
            }
        }

        return null;
    }

    private static MethodInfo? FindAppendLiteral(Type handlerType)
    {
        foreach (var candidate in handlerType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
        {
            var parameters = candidate.GetParameters();
            if (candidate.Name == "AppendLiteral"
                && !candidate.IsGenericMethodDefinition
                && candidate.ReturnType.IsSameAs(typeof(void))
                && parameters.Length == 1
                && parameters[0].ParameterType.IsSameAs(typeof(string)))
            {
                return candidate;
            }
        }

        return null;
    }

    private static MethodInfo? FindToStringAndClear(Type handlerType)
    {
        foreach (var candidate in handlerType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
        {
            if (candidate.Name == "ToStringAndClear"
                && !candidate.IsGenericMethodDefinition
                && candidate.ReturnType.IsSameAs(typeof(string))
                && candidate.GetParameters().Length == 0)
            {
                return candidate;
            }
        }

        return null;
    }

    private static MethodInfo? FindAppendFormatted(Type handlerType, Type? secondParam, Type? thirdParam)
    {
        var expectedArity = 1 + (secondParam == null ? 0 : 1) + (thirdParam == null ? 0 : 1);
        foreach (var candidate in handlerType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
        {
            if (candidate.Name != "AppendFormatted"
                || !candidate.IsGenericMethodDefinition
                || !candidate.ReturnType.IsSameAs(typeof(void))
                || candidate.GetGenericArguments().Length != 1)
            {
                continue;
            }

            var parameters = candidate.GetParameters();
            if (parameters.Length != expectedArity || !parameters[0].ParameterType.IsGenericMethodParameter)
            {
                continue;
            }

            if (secondParam != null && !parameters[1].ParameterType.IsSameAs(secondParam))
            {
                continue;
            }

            if (thirdParam != null && !parameters[2].ParameterType.IsSameAs(thirdParam))
            {
                continue;
            }

            return candidate;
        }

        return null;
    }
}
