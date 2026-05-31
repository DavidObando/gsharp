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
    /// <param name="a">First type.</param>
    /// <param name="b">Second type.</param>
    /// <returns><c>true</c> when both types are non-null and share a FullName.</returns>
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
}
