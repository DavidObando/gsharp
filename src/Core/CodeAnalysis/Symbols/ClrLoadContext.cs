// <copyright file="ClrLoadContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Issue #3705 (family 3): the single place that answers "does this CLR type —
/// which may have been materialised through a
/// <see cref="System.Reflection.MetadataLoadContext"/> — satisfy a well-known
/// shape the compiler cares about?".
/// <para>
/// <c>gsc</c> creates one <c>MetadataLoadContext</c> per compilation
/// (<see cref="ImportedAssemblySemantics"/>) and never normalises the
/// <see cref="Type"/>s it hands back to host <c>RuntimeType</c>s. A
/// <c>typeof(X).IsAssignableFrom(importedType)</c> in the binder, lowerer or
/// emitter is therefore not merely imprecise: it is <em>unconditionally
/// false</em>, silently, for every program compiled with <c>/reference:</c> —
/// which is every production compile. That is what produced #3708 (a <c>for</c>
/// loop over an imported enumerable emitted no <c>Dispose</c>) and the
/// <c>Delegate</c> arm of #3697.
/// </para>
/// <para>
/// The rule this type exists to enforce: a load-context-crossing question is
/// asked here, never hand-rolled at the call site. The guard-rail test
/// <c>Issue3705LoadContextFunnelGuardTests</c> fails the build when a new
/// <c>typeof(X).IsAssignableFrom(…)</c> appears in <c>Binding/</c>,
/// <c>Lowering/</c>, <c>Emit/</c> or <c>Symbols/</c>.
/// </para>
/// </summary>
public static class ClrLoadContext
{
    /// <summary>
    /// Cross-reflection-context replacement for
    /// <c>typeof(WellKnown).IsAssignableFrom(candidate)</c>: returns whether
    /// <paramref name="candidate"/> <em>is</em>, derives from, or implements
    /// <paramref name="wellKnown"/>, comparing by logical CLR identity rather
    /// than by reference.
    /// </summary>
    /// <remarks>
    /// <paramref name="wellKnown"/> is expected to be a host <c>typeof(…)</c>
    /// literal for a BCL type whose <see cref="Type.FullName"/> is stable
    /// across contexts (<c>System.IDisposable</c>,
    /// <c>System.Collections.IEnumerable</c>, …). Constructed generics are
    /// compared structurally by <see cref="ClrTypeUtilities.IsSameAs"/>, so
    /// <c>Satisfies(x, typeof(IEnumerable&lt;string&gt;))</c> is meaningful;
    /// an <em>open</em> definition is not a shape any concrete type satisfies
    /// and always answers <see langword="false"/>.
    /// </remarks>
    /// <param name="candidate">The candidate type, typically drawn from imported metadata. May be <see langword="null"/>.</param>
    /// <param name="wellKnown">The well-known target shape, typically a host <c>typeof(…)</c> literal.</param>
    /// <returns><see langword="true"/> when <paramref name="candidate"/> satisfies <paramref name="wellKnown"/>.</returns>
    public static bool Satisfies(Type? candidate, Type? wellKnown)
    {
        if (candidate is null || wellKnown is null)
        {
            return false;
        }

        if (ClrTypeUtilities.IsSameAs(candidate, wellKnown))
        {
            return true;
        }

        // Every type is (or boxes to) System.Object, including interfaces —
        // whose Type.BaseType is null, so the base walk below cannot see it.
        if (string.Equals(wellKnown.FullName, "System.Object", StringComparison.Ordinal))
        {
            return true;
        }

        if (wellKnown.IsInterface)
        {
            return ClrTypeUtilities.ImplementsInterfaceByName(candidate, wellKnown);
        }

        for (var baseType = SafeBaseType(candidate); baseType != null; baseType = SafeBaseType(baseType))
        {
            if (ClrTypeUtilities.IsSameAs(baseType, wellKnown))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Cross-reflection-context replacement for
    /// <c>target.IsAssignableFrom(source)</c> where <em>either</em> operand may
    /// have come from a <c>MetadataLoadContext</c>. Uses the same-context
    /// <see cref="Type.IsAssignableFrom"/> fast path when it is trustworthy and
    /// falls back to the reference-context-independent by-name walk otherwise.
    /// </summary>
    /// <param name="target">The assignment target type.</param>
    /// <param name="source">The assignment source type.</param>
    /// <returns><see langword="true"/> when a reference assignment is permissible.</returns>
    public static bool IsAssignable(Type? target, Type? source)
        => ClrTypeUtilities.IsAssignableByName(target, source);

    /// <summary>
    /// Issue #932 / #3697: reads a delegate type's <c>Invoke</c> signature in a
    /// way that survives every reflection context the compiler can produce one
    /// in.
    /// <para>
    /// The direct <c>GetMethod("Invoke")</c> is tried first, then two
    /// fallbacks: the <c>System.Func`n</c> / <c>System.Action`n</c>
    /// generic-argument decomposition, and — for any other closed generic
    /// delegate (<c>Predicate&lt;T&gt;</c>, <c>Comparison&lt;T&gt;</c>,
    /// <c>Converter&lt;TIn,TOut&gt;</c>, an imported user delegate) — reading
    /// <c>Invoke</c> off the <em>open</em> definition, which is always in
    /// metadata, and substituting the closed type arguments. The direct probe
    /// fails whenever the closed type is a
    /// <c>System.Reflection.Emit.TypeBuilderInstantiation</c> (a structural
    /// function type closed over an in-flight <c>TypeBuilder</c>, or over a
    /// <c>MetadataLoadContext</c>-loaded argument), which throws
    /// <see cref="NotSupportedException"/>.
    /// </para>
    /// </summary>
    /// <param name="delegateType">The delegate type whose signature to read.</param>
    /// <param name="parameterTypes">On success, the <c>Invoke</c> parameter types with by-ref slots reduced to their pointee.</param>
    /// <param name="returnType">On success, the <c>Invoke</c> return type.</param>
    /// <returns><see langword="true"/> when the signature was recovered.</returns>
    public static bool TryGetDelegateSignature(
        Type? delegateType,
        out Type[] parameterTypes,
        [NotNullWhen(true)] out Type? returnType)
    {
        parameterTypes = Array.Empty<Type>();
        returnType = null;

        if (delegateType is null)
        {
            return false;
        }

        try
        {
            var invoke = delegateType.GetMethodSafe("Invoke");
            if (invoke != null)
            {
                var ps = invoke.GetParameters();
                var result = new Type[ps.Length];
                for (var i = 0; i < ps.Length; i++)
                {
                    var parameterType = GetDelegateCompatibilityParameterType(ps[i]);
                    if (parameterType is null)
                    {
                        return false;
                    }

                    result[i] = parameterType;
                }

                parameterTypes = result;
                returnType = invoke.ReturnType;
                return true;
            }
        }
        catch (Exception)
        {
            // Cross-context constructed Func<>/Action<> — fall back to the
            // generic-argument decomposition below.
        }

        var fullName = delegateType.FullName;
        if (fullName == null || !delegateType.IsGenericType)
        {
            return false;
        }

        Type[] genericArgs;
        try
        {
            genericArgs = delegateType.GetGenericArguments();
        }
        catch (Exception)
        {
            return false;
        }

        if (fullName.StartsWith("System.Func`", StringComparison.Ordinal) && genericArgs.Length >= 1)
        {
            // Func<T1,...,Tn,TResult>: trailing argument is the return type.
            var ps = new Type[genericArgs.Length - 1];
            Array.Copy(genericArgs, ps, ps.Length);
            parameterTypes = ps;
            returnType = genericArgs[genericArgs.Length - 1];
            return true;
        }

        if (fullName.StartsWith("System.Action`", StringComparison.Ordinal))
        {
            // Action<T1,...,Tn>: void return, all generic arguments are parameters.
            parameterTypes = genericArgs;
            returnType = typeof(void);
            return true;
        }

        // Issue #932: any other closed generic delegate whose constructed
        // Invoke is unreachable across reflection contexts. Read the Invoke
        // signature off the open generic definition — which is always in
        // metadata — then substitute the closed type arguments into each
        // generic-parameter slot.
        try
        {
            var definition = delegateType.GetGenericTypeDefinition();
            var defInvoke = definition.GetMethodSafe("Invoke");
            if (defInvoke == null)
            {
                return false;
            }

            var defParams = defInvoke.GetParameters();
            var resolvedParams = new Type[defParams.Length];
            for (var i = 0; i < defParams.Length; i++)
            {
                var resolved = SubstituteGenericParameter(
                    GetDelegateCompatibilityParameterType(defParams[i]),
                    genericArgs);
                if (resolved is null)
                {
                    return false;
                }

                resolvedParams[i] = resolved;
            }

            parameterTypes = resolvedParams;
            var resolvedReturn = SubstituteGenericParameter(defInvoke.ReturnType, genericArgs);
            if (resolvedReturn is null)
            {
                return false;
            }

            returnType = resolvedReturn;
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>
    /// Issue #2802: a by-ref slot's function shape is its pointee type;
    /// <c>ref</c>/<c>out</c>/<c>in</c> remain parameter metadata, not managed-
    /// pointer value types.
    /// </summary>
    /// <param name="parameter">The <c>Invoke</c> parameter.</param>
    /// <returns>The parameter's function-shape type.</returns>
    private static Type? GetDelegateCompatibilityParameterType(ParameterInfo parameter)
    {
        var parameterType = parameter.ParameterType;
        return parameterType.IsByRef ? parameterType.GetElementType() : parameterType;
    }

    /// <summary>
    /// Issue #932: maps a (possibly generic-parameter) type drawn from a
    /// delegate's open-definition <c>Invoke</c> signature to the corresponding
    /// closed type argument. A bare generic parameter <c>T</c> is replaced by
    /// <paramref name="genericArgs"/> at its
    /// <see cref="Type.GenericParameterPosition"/>; every other type is
    /// returned unchanged.
    /// </summary>
    /// <param name="type">The open-definition signature type.</param>
    /// <param name="genericArgs">The closed type arguments.</param>
    /// <returns>The substituted type.</returns>
    private static Type? SubstituteGenericParameter(Type? type, Type[] genericArgs)
    {
        if (type != null && type.IsGenericParameter
            && type.GenericParameterPosition >= 0
            && type.GenericParameterPosition < genericArgs.Length)
        {
            return genericArgs[type.GenericParameterPosition];
        }

        return type;
    }

    /// <summary>
    /// Reads <see cref="Type.BaseType"/>, tolerating the metadata-load
    /// failures a reference-only context can raise when the base type lives in
    /// an assembly that was not supplied via <c>/r:</c>.
    /// </summary>
    /// <param name="type">The type whose base to read.</param>
    /// <returns>The base type, or <see langword="null"/>.</returns>
    private static Type? SafeBaseType(Type type)
    {
        try
        {
            return type.BaseType;
        }
        catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
        {
            return null;
        }
    }
}
