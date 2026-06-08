// <copyright file="ClrTypeUtilities.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Helpers for comparing <see cref="Type"/> instances that may originate from
/// different reflection contexts (e.g. the gsc host's live runtime vs. a
/// <see cref="System.Reflection.MetadataLoadContext"/> over target-framework
/// reference assemblies). Reference-equality (<c>==</c>) and
/// <see cref="Type.IsAssignableFrom"/> only work within a single context, so
/// cross-context comparisons must fall back to name-based matching.
/// </summary>
internal static class ClrTypeUtilities
{
    /// <summary>
    /// Returns whether two <see cref="Type"/>s refer to the same logical CLR
    /// type, regardless of which reflection context produced them. Two types
    /// are considered the same when their <see cref="Type.FullName"/>s match.
    /// </summary>
    /// <remarks>
    /// Issue #504-reopen: constructed generics, arrays, by-ref, and pointer
    /// types are compared <em>structurally</em> (definition + element / type
    /// arguments) rather than by raw <see cref="Type.FullName"/>. The
    /// FullName of a constructed generic (e.g. <c>Nullable&lt;bool&gt;</c>)
    /// embeds the assembly-qualified name of every type argument
    /// (<c>System.Boolean, System.Private.CoreLib, …</c>), and those
    /// assembly identities differ across reflection contexts — the host
    /// runtime's <c>System.Boolean</c> lives in <c>System.Private.CoreLib</c>
    /// while the MetadataLoadContext-loaded reference-assembly
    /// <c>System.Boolean</c> lives in the <c>System.Runtime</c> facade — so
    /// the embedded strings diverge even when the two types denote the same
    /// logical CLR shape. Recursing on the type definition plus each leaf
    /// type argument keeps the cross-context identity check correct, since
    /// leaf non-generic types have an assembly-independent
    /// <see cref="Type.FullName"/>.
    /// </remarks>
    /// <param name="a">First type.</param>
    /// <param name="b">Second type.</param>
    /// <returns><c>true</c> when both types are non-null and denote the same logical CLR type.</returns>
    public static bool AreSame(Type a, Type b)
    {
        if (a is null || b is null)
        {
            return false;
        }

        if (ReferenceEquals(a, b))
        {
            return true;
        }

        // Arrays: element + rank must match. The constructed-array FullName
        // embeds the element's assembly-qualified name when the element is
        // itself a constructed generic, so arrays of cross-context generics
        // require structural comparison.
        if (a.IsArray && b.IsArray)
        {
            return a.GetArrayRank() == b.GetArrayRank()
                && AreSame(a.GetElementType(), b.GetElementType());
        }

        if (a.IsByRef && b.IsByRef)
        {
            return AreSame(a.GetElementType(), b.GetElementType());
        }

        if (a.IsPointer && b.IsPointer)
        {
            return AreSame(a.GetElementType(), b.GetElementType());
        }

        // Constructed (closed) generics: compare the open definition's
        // FullName (which is assembly-qualifier-free, e.g.
        // `System.Nullable\u00601`) and recurse on each type argument. This
        // is the cross-reflection-context fix that closes issue #504-reopen
        // for `Nullable<T>` and applies equally to any other constructed
        // generic with a leaf-FullName-matchable type argument.
        if (a.IsGenericType && b.IsGenericType
            && !a.IsGenericTypeDefinition && !b.IsGenericTypeDefinition)
        {
            if (!string.Equals(
                    a.GetGenericTypeDefinition().FullName,
                    b.GetGenericTypeDefinition().FullName,
                    StringComparison.Ordinal))
            {
                return false;
            }

            var aArgs = a.GetGenericArguments();
            var bArgs = b.GetGenericArguments();
            if (aArgs.Length != bArgs.Length)
            {
                return false;
            }

            for (var i = 0; i < aArgs.Length; i++)
            {
                if (!AreSame(aArgs[i], bArgs[i]))
                {
                    return false;
                }
            }

            return true;
        }

        return string.Equals(a.FullName, b.FullName, StringComparison.Ordinal);
    }

    /// <summary>
    /// Returns whether <paramref name="source"/> is assignable to
    /// <paramref name="target"/> when the two types may live in different
    /// reflection contexts. Falls back to identity-by-name and special-cases
    /// <c>System.Object</c> as universally assignable.
    /// </summary>
    /// <param name="target">Target parameter type.</param>
    /// <param name="source">Source argument type.</param>
    /// <returns><c>true</c> when an assignment is permissible.</returns>
    public static bool IsAssignableByName(Type target, Type source)
    {
        if (target is null || source is null)
        {
            return false;
        }

        if (AreSame(target, source))
        {
            return true;
        }

        if (string.Equals(target.FullName, "System.Object", StringComparison.Ordinal))
        {
            return true;
        }

        // Same-context fast path covers inheritance / interfaces.
        if (ReferenceEquals(target.Assembly, source.Assembly) || target.GetType() == source.GetType())
        {
            try
            {
                return target.IsAssignableFrom(source);
            }
            catch (InvalidOperationException)
            {
                // MLC types throw for some cross-context paths; fall through.
            }
        }

        return false;
    }

    /// <summary>
    /// Returns whether <paramref name="type"/> is a CLR delegate type, i.e. it
    /// (transitively) derives from <c>System.MulticastDelegate</c> /
    /// <c>System.Delegate</c>. Walks the base-type chain by name so it is safe
    /// for types loaded through a <see cref="System.Reflection.MetadataLoadContext"/>,
    /// where <c>typeof(Delegate).IsAssignableFrom</c> would throw.
    /// </summary>
    /// <param name="type">The candidate type.</param>
    /// <returns><c>true</c> when the type is a delegate type.</returns>
    public static bool IsDelegateType(Type type)
    {
        for (var t = type; t != null; t = t.BaseType)
        {
            var fullName = t.FullName;
            if (string.Equals(fullName, "System.MulticastDelegate", StringComparison.Ordinal)
                || string.Equals(fullName, "System.Delegate", StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #367: returns whether <paramref name="type"/> is a CLR by-ref-like
    /// (<c>ref struct</c>) type — one carrying
    /// <c>System.Runtime.CompilerServices.IsByRefLikeAttribute</c>, such as
    /// <c>System.Span&lt;T&gt;</c>, <c>System.ReadOnlySpan&lt;T&gt;</c>, or
    /// <c>System.Runtime.CompilerServices.DefaultInterpolatedStringHandler</c>.
    /// Such values are stack-only: they cannot be boxed, stored in fields of a
    /// non-ref-struct, captured by closures, hoisted into async/iterator state
    /// machines, or used as generic type arguments. <see cref="Type.IsByRefLike"/>
    /// is honoured by <see cref="System.Reflection.MetadataLoadContext"/>, so this
    /// works for types loaded from reference assemblies. Guards against the
    /// metadata-load failures described on <see cref="IsMetadataLoadFailure"/>.
    /// </summary>
    /// <param name="type">The candidate type.</param>
    /// <returns><c>true</c> when the type is a by-ref-like value type.</returns>
    public static bool IsByRefLike(Type type)
    {
        if (type is null)
        {
            return false;
        }

        try
        {
            return type.IsByRefLike;
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return false;
        }
    }

    /// <summary>
    /// Issue #338 (generalizing the #321 fix): determines whether an exception
    /// thrown while reflecting over a CLR member's signature is a
    /// metadata/assembly load failure. Such failures arise when a member's
    /// signature (parameter, return, property, field, or event-handler type)
    /// references a type that cannot be loaded or projected under the reference
    /// <see cref="System.Reflection.MetadataLoadContext"/> — for example a
    /// ref-struct type or a type living in a transitive assembly that was not
    /// supplied via <c>/r:</c>. Member enumeration sites treat the offending
    /// member as absent rather than letting the throw sink the whole member set;
    /// any other exception is left to propagate. This is the single shared
    /// predicate used by every CLR member enumeration site (overload
    /// resolution, property/field/event/constructor enumeration, and the
    /// member-access binding path).
    /// </summary>
    /// <param name="ex">The exception observed while evaluating a member.</param>
    /// <returns>Whether the exception represents a tolerable load failure.</returns>
    public static bool IsMetadataLoadFailure(Exception ex) =>
        ex is FileNotFoundException
            or FileLoadException
            or TypeLoadException
            or BadImageFormatException
            or MissingMethodException
            or MissingMemberException
            or NotSupportedException;

    /// <summary>
    /// Probes whether a member's full signature can be read without triggering a
    /// metadata-load failure (issue #338). Touching the relevant signature types
    /// (property/field/event-handler/parameter/return types) forces the
    /// <see cref="System.Reflection.MetadataLoadContext"/> to resolve them; if
    /// any cannot be loaded the member is treated as unusable and skipped.
    /// </summary>
    /// <param name="member">The reflected member to probe.</param>
    /// <returns><c>true</c> when the member's signature loads cleanly.</returns>
    public static bool CanLoadSignature(MemberInfo member)
    {
        if (member is null)
        {
            return false;
        }

        try
        {
            switch (member)
            {
                case PropertyInfo property:
                    _ = property.PropertyType;
                    foreach (var indexParameter in property.GetIndexParameters())
                    {
                        _ = indexParameter.ParameterType;
                    }

                    break;
                case FieldInfo field:
                    _ = field.FieldType;
                    break;
                case EventInfo @event:
                    _ = @event.EventHandlerType;
                    break;
                case MethodBase method:
                    foreach (var parameter in method.GetParameters())
                    {
                        _ = parameter.ParameterType;
                    }

                    if (method is MethodInfo methodInfo)
                    {
                        _ = methodInfo.ReturnType;
                    }

                    break;
            }

            return true;
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return false;
        }
    }

    /// <summary>
    /// Enumerates a type's public properties tolerantly (issue #338): properties
    /// whose signature cannot be loaded under the reference context are skipped
    /// instead of sinking the whole set.
    /// </summary>
    /// <param name="type">The type to enumerate.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The properties whose signatures load cleanly.</returns>
    public static PropertyInfo[] SafeGetProperties(Type type, BindingFlags flags)
        => SafeEnumerate(type, t => t.GetProperties(flags));

    /// <summary>
    /// Enumerates a type's fields tolerantly (issue #338): fields whose type
    /// cannot be loaded under the reference context are skipped.
    /// </summary>
    /// <param name="type">The type to enumerate.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The fields whose signatures load cleanly.</returns>
    public static FieldInfo[] SafeGetFields(Type type, BindingFlags flags)
        => SafeEnumerate(type, t => t.GetFields(flags));

    /// <summary>
    /// Enumerates a type's events tolerantly (issue #338): events whose handler
    /// type cannot be loaded under the reference context are skipped.
    /// </summary>
    /// <param name="type">The type to enumerate.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The events whose signatures load cleanly.</returns>
    public static EventInfo[] SafeGetEvents(Type type, BindingFlags flags)
        => SafeEnumerate(type, t => t.GetEvents(flags));

    /// <summary>
    /// Enumerates a type's constructors tolerantly (issue #338): constructors
    /// whose parameter signature cannot be loaded under the reference context
    /// are skipped instead of sinking the whole overload set.
    /// </summary>
    /// <param name="type">The type to enumerate.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The constructors whose signatures load cleanly.</returns>
    public static ConstructorInfo[] SafeGetConstructors(Type type, BindingFlags flags)
        => SafeEnumerate(type, t => t.GetConstructors(flags));

    /// <summary>
    /// Enumerates a type's methods tolerantly (issue #338): methods whose
    /// parameter or return signature cannot be loaded under the reference
    /// context are skipped instead of sinking the whole candidate set.
    /// </summary>
    /// <param name="type">The type to enumerate.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The methods whose signatures load cleanly.</returns>
    public static MethodInfo[] SafeGetMethods(Type type, BindingFlags flags)
        => SafeEnumerate(type, t => t.GetMethods(flags));

    /// <summary>
    /// Looks up a single property by name tolerantly (issue #338). When the
    /// requested member — or an unrelated sibling probed during the lookup —
    /// references an unloadable type, the direct lookup is retried via a guarded
    /// enumeration that skips only the offending members.
    /// </summary>
    /// <param name="type">The type to search.</param>
    /// <param name="name">The property name.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The matching property, or <c>null</c> when none is usable.</returns>
    public static PropertyInfo SafeGetProperty(Type type, string name, BindingFlags flags)
        => SafeGetMember(type, name, flags, (t, f) => t.GetProperty(name, f), SafeGetProperties);

    /// <summary>
    /// Looks up a single field by name tolerantly (issue #338). See
    /// <see cref="SafeGetProperty"/> for the tolerance contract.
    /// </summary>
    /// <param name="type">The type to search.</param>
    /// <param name="name">The field name.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The matching field, or <c>null</c> when none is usable.</returns>
    public static FieldInfo SafeGetField(Type type, string name, BindingFlags flags)
        => SafeGetMember(type, name, flags, (t, f) => t.GetField(name, f), SafeGetFields);

    /// <summary>
    /// Looks up a single event by name tolerantly (issue #338). See
    /// <see cref="SafeGetProperty"/> for the tolerance contract.
    /// </summary>
    /// <param name="type">The type to search.</param>
    /// <param name="name">The event name.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The matching event, or <c>null</c> when none is usable.</returns>
    public static EventInfo SafeGetEvent(Type type, string name, BindingFlags flags)
        => SafeGetMember(type, name, flags, (t, f) => t.GetEvent(name, f), SafeGetEvents);

    /// <summary>
    /// Issue #529: looks up a property by name, walking the transitive
    /// interface hierarchy when <paramref name="type"/> is an interface.
    /// CLR reflection does not include inherited interface members in
    /// <see cref="Type.GetProperties(BindingFlags)"/> for interface types,
    /// so this helper explicitly walks <see cref="Type.GetInterfaces()"/>.
    /// </summary>
    /// <param name="type">The type to search.</param>
    /// <param name="name">The property name.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The matching property, or <c>null</c> when none is found.</returns>
    public static PropertyInfo SafeGetPropertyIncludingInterfaces(Type type, string name, BindingFlags flags)
    {
        var direct = SafeGetProperty(type, name, flags);
        if (direct != null)
        {
            return direct;
        }

        if (type is null || !type.IsInterface)
        {
            return null;
        }

        foreach (var iface in SafeGetInterfaces(type))
        {
            var inherited = SafeGetProperty(iface, name, flags);
            if (inherited != null)
            {
                return inherited;
            }
        }

        return null;
    }

    /// <summary>
    /// Issue #529: looks up a field by name, walking the transitive
    /// interface hierarchy when <paramref name="type"/> is an interface.
    /// </summary>
    /// <param name="type">The type to search.</param>
    /// <param name="name">The field name.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The matching field, or <c>null</c> when none is found.</returns>
    public static FieldInfo SafeGetFieldIncludingInterfaces(Type type, string name, BindingFlags flags)
    {
        var direct = SafeGetField(type, name, flags);
        if (direct != null)
        {
            return direct;
        }

        if (type is null || !type.IsInterface)
        {
            return null;
        }

        foreach (var iface in SafeGetInterfaces(type))
        {
            var inherited = SafeGetField(iface, name, flags);
            if (inherited != null)
            {
                return inherited;
            }
        }

        return null;
    }

    /// <summary>
    /// Issue #529: enumerates methods including those declared on
    /// transitive base interfaces when <paramref name="type"/> is an
    /// interface. For non-interface types, this is equivalent to
    /// <see cref="SafeGetMethods"/>. Methods from base interfaces that
    /// are hidden by a same-name-and-parameter-types method on a
    /// more-derived interface are excluded (mirrors C# hiding rules).
    /// </summary>
    /// <param name="type">The type to enumerate.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The methods whose signatures load cleanly.</returns>
    public static MethodInfo[] SafeGetMethodsIncludingInterfaces(Type type, BindingFlags flags)
    {
        var direct = SafeGetMethods(type, flags);
        if (type is null || !type.IsInterface)
        {
            return direct;
        }

        var all = new List<MethodInfo>(direct);
        foreach (var iface in SafeGetInterfaces(type))
        {
            foreach (var m in SafeGetMethods(iface, flags))
            {
                if (!IsHiddenByExisting(all, m))
                {
                    all.Add(m);
                }
            }
        }

        return all.ToArray();
    }

    private static TMember[] SafeEnumerate<TMember>(Type type, Func<Type, TMember[]> getAll)
        where TMember : MemberInfo
    {
        if (type is null)
        {
            return Array.Empty<TMember>();
        }

        TMember[] all;
        try
        {
            all = getAll(type);
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return Array.Empty<TMember>();
        }

        var usable = new List<TMember>(all.Length);
        foreach (var member in all)
        {
            if (CanLoadSignature(member))
            {
                usable.Add(member);
            }
        }

        return usable.ToArray();
    }

    private static TMember SafeGetMember<TMember>(
        Type type,
        string name,
        BindingFlags flags,
        Func<Type, BindingFlags, TMember> directLookup,
        Func<Type, BindingFlags, TMember[]> safeEnumerate)
        where TMember : MemberInfo
    {
        if (type is null)
        {
            return null;
        }

        try
        {
            var member = directLookup(type, flags);
            return member != null && CanLoadSignature(member) ? member : null;
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            // The direct lookup was poisoned by an unloadable member (the target
            // or a sibling reflected over during the search). Recover via the
            // guarded enumeration, which skips only the offending members.
            foreach (var member in safeEnumerate(type, flags))
            {
                if (string.Equals(member.Name, name, StringComparison.Ordinal))
                {
                    return member;
                }
            }

            return null;
        }
    }

    /// <summary>
    /// Issue #529: tolerantly retrieves the transitive interface set
    /// for a type, guarding against metadata-load failures.
    /// </summary>
    /// <param name="type">The type whose interfaces to retrieve.</param>
    /// <returns>The transitive interface set, or empty on failure.</returns>
    private static Type[] SafeGetInterfaces(Type type)
    {
        if (type is null)
        {
            return Array.Empty<Type>();
        }

        try
        {
            return type.GetInterfaces();
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return Array.Empty<Type>();
        }
    }

    /// <summary>
    /// Issue #529: returns whether <paramref name="candidate"/> is hidden
    /// by any method already in <paramref name="existing"/>. A method is
    /// hidden when another method with the same name and same parameter
    /// types is already present (C# interface hiding semantics).
    /// </summary>
    /// <param name="existing">The methods found so far.</param>
    /// <param name="candidate">The candidate from a base interface.</param>
    /// <returns><c>true</c> when the candidate is hidden.</returns>
    private static bool IsHiddenByExisting(List<MethodInfo> existing, MethodInfo candidate)
    {
        foreach (var m in existing)
        {
            if (!string.Equals(m.Name, candidate.Name, StringComparison.Ordinal))
            {
                continue;
            }

            var existingParams = m.GetParameters();
            var candidateParams = candidate.GetParameters();
            if (existingParams.Length != candidateParams.Length)
            {
                continue;
            }

            var match = true;
            for (var i = 0; i < existingParams.Length; i++)
            {
                if (!AreSame(existingParams[i].ParameterType, candidateParams[i].ParameterType))
                {
                    match = false;
                    break;
                }
            }

            if (match)
            {
                return true;
            }
        }

        return false;
    }
}
