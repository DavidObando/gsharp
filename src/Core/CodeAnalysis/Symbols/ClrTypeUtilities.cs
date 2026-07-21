// <copyright file="ClrTypeUtilities.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Helpers for comparing <see cref="Type"/> instances that may originate from
/// different reflection contexts (e.g. the gsc host's live runtime vs. a
/// <see cref="System.Reflection.MetadataLoadContext"/> over target-framework
/// reference assemblies). Reference-equality (<c>==</c>) and
/// <see cref="Type.IsAssignableFrom"/> only work within a single context, so
/// cross-context comparisons must fall back to name-based matching.
/// </summary>
public static class ClrTypeUtilities
{
    /// <summary>
    /// Issue #1678: process-wide memoization of <see cref="SafeGetInterfaces"/>,
    /// keyed by the CLR <see cref="Type"/>. Every binder call site that walks a
    /// receiver's transitive interfaces (member lookup, collection-initializer
    /// <c>Add</c> probing, base-call candidate collection, etc.) re-enumerated
    /// <see cref="Type.GetInterfaces"/> from scratch before this cache existed;
    /// for BCL types with wide interface sets (<c>List&lt;T&gt;</c>) that cost
    /// was paid once per call site instead of once per type.
    /// </summary>
    private static ConditionalWeakTable<Type, Type[]> interfacesCache = new();

    /// <summary>
    /// Resolves a named method without asking a constructed
    /// <see cref="TypeBuilder"/> generic instantiation to resolve members
    /// directly.
    /// </summary>
    /// <param name="type">The type that declares or inherits the method.</param>
    /// <param name="name">The method name to resolve.</param>
    /// <returns>The resolved method, or <see langword="null"/> when no matching method exists.</returns>
    public static MethodInfo GetMethodSafe(this Type type, string name)
    {
        if (type is null || name is null)
        {
            return null;
        }

        try
        {
            return type.GetMethod(name);
        }
        catch (NotSupportedException)
        {
            if (!IsConstructedGenericWithTypeBuilderArgument(type))
            {
                return null;
            }

            var openMethod = type.GetGenericTypeDefinition().GetMethod(name);
            return openMethod != null ? TypeBuilder.GetMethod(type, openMethod) : null;
        }
    }

    /// <summary>
    /// Issue #2327: single shared guard for every enum-reflection predicate
    /// in the binder/emitter (generalizes the #1100 / #2135 pattern already
    /// established for <c>IsAssignableFrom</c>/<c>IsInterface</c> probes).
    /// <see cref="Type.IsEnum"/> walks the base-type chain via
    /// <c>IsSubclassOf(typeof(Enum))</c> under the hood, which is one of the
    /// operations <c>System.Reflection.Emit.TypeBuilderInstantiation</c>
    /// (a constructed generic — e.g. a compiler-synthesized structural
    /// function-type delegate — closed over an in-flight <see cref="TypeBuilder"/>
    /// definition) throws <see cref="NotSupportedException"/> for. Such a type
    /// is never a genuine CLR enum, so a throw here is treated as a definite
    /// "not an enum" rather than propagating and crashing emit/binding.
    /// </summary>
    /// <param name="type">The CLR type to probe. May be <see langword="null"/>.</param>
    /// <returns><c>true</c> when <paramref name="type"/> is a real CLR enum.</returns>
    public static bool IsEnumSafe(this Type type)
    {
        if (type is null)
        {
            return false;
        }

        try
        {
            return type.IsEnum;
        }
        catch (NotSupportedException)
        {
            return false;
        }
    }

    /// <summary>
    /// Issue #2327: safe companion to <see cref="IsEnumSafe"/> — resolves the
    /// CLR underlying primitive of an enum type without risking the same
    /// <see cref="NotSupportedException"/> a <c>TypeBuilderInstantiation</c>
    /// (or other unsupported reflection type) can throw from
    /// <see cref="Enum.GetUnderlyingType"/>'s own <c>IsEnum</c> validation.
    /// </summary>
    /// <param name="type">The candidate enum CLR type. May be <see langword="null"/>.</param>
    /// <returns>The underlying primitive <see cref="Type"/>, or <see langword="null"/> when <paramref name="type"/> is not a genuine CLR enum.</returns>
    public static Type GetEnumUnderlyingTypeSafe(this Type type)
    {
        if (!type.IsEnumSafe())
        {
            return null;
        }

        try
        {
            return Enum.GetUnderlyingType(type);
        }
        catch (NotSupportedException)
        {
            return null;
        }
    }

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
    public static bool AreSame(Type a, Type b) => IsSameAs(a, b);

    /// <summary>
    /// Extension-method companion to <see cref="AreSame(Type, Type)"/>. Reads more
    /// naturally at call sites that historically used
    /// <c>clrType == typeof(SomeType)</c> reference-identity comparisons —
    /// issue #835 — and prevents the silent feature drops that occur when the
    /// left-hand <see cref="Type"/> was materialised through a
    /// <see cref="System.Reflection.MetadataLoadContext"/> rather than the host
    /// process's <c>typeof()</c>.
    /// </summary>
    /// <param name="self">The candidate type, typically a CLR type extracted
    /// from imported metadata. May be <c>null</c>.</param>
    /// <param name="other">The expected canonical type, typically a host
    /// <c>typeof(...)</c> literal.</param>
    /// <returns><c>true</c> when both types denote the same logical CLR type.</returns>
    public static bool IsSameAs(this Type self, Type other)
    {
        if (self is null || other is null)
        {
            return false;
        }

        if (ReferenceEquals(self, other))
        {
            return true;
        }

        // Arrays: element + rank must match. The constructed-array FullName
        // embeds the element's assembly-qualified name when the element is
        // itself a constructed generic, so arrays of cross-context generics
        // require structural comparison.
        if (self.IsArray && other.IsArray)
        {
            return self.GetArrayRank() == other.GetArrayRank()
                && IsSameAs(self.GetElementType(), other.GetElementType());
        }

        if (self.IsByRef && other.IsByRef)
        {
            return IsSameAs(self.GetElementType(), other.GetElementType());
        }

        if (self.IsPointer && other.IsPointer)
        {
            return IsSameAs(self.GetElementType(), other.GetElementType());
        }

        // Constructed (closed) generics: compare the open definition's
        // FullName (which is assembly-qualifier-free, e.g.
        // `System.Nullable\u00601`) and recurse on each type argument. This
        // is the cross-reflection-context fix that closes issue #504-reopen
        // for `Nullable<T>` and applies equally to any other constructed
        // generic with a leaf-FullName-matchable type argument.
        if (self.IsGenericType && other.IsGenericType
            && !self.IsGenericTypeDefinition && !other.IsGenericTypeDefinition)
        {
            if (!string.Equals(
                    self.GetGenericTypeDefinition().FullName,
                    other.GetGenericTypeDefinition().FullName,
                    StringComparison.Ordinal))
            {
                return false;
            }

            var aArgs = self.GetGenericArguments();
            var bArgs = other.GetGenericArguments();
            if (aArgs.Length != bArgs.Length)
            {
                return false;
            }

            for (var i = 0; i < aArgs.Length; i++)
            {
                if (!IsSameAs(aArgs[i], bArgs[i]))
                {
                    return false;
                }
            }

            return true;
        }

        return string.Equals(self.FullName, other.FullName, StringComparison.Ordinal);
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

        if (target.IsGenericType
            && source.IsGenericType
            && AreSame(target.GetGenericTypeDefinition(), source.GetGenericTypeDefinition())
            && GenericArgumentsAreAssignable(target, source))
        {
            return true;
        }

        // Same-context fast path covers inheritance / interfaces.
        if (ReferenceEquals(target.Assembly, source.Assembly) || target.GetType() == source.GetType())
        {
            try
            {
                if (target.IsAssignableFrom(source))
                {
                    return true;
                }

                // Issue #908: do NOT treat a `false` here as authoritative. The
                // `target.GetType() == source.GetType()` guard also fires when the
                // two types are the same reflection-kind (e.g. both
                // MetadataLoadContext RoTypes) but originate from *different*
                // context instances — across two separate compilations sharing a
                // process. There, IsAssignableFrom compares base types by
                // reference and returns a spurious `false` even for a genuine
                // upcast (e.g. MemoryStream → Stream). Fall through to the
                // by-name walk, which is reference-context independent and only
                // ever returns true for real inheritance / implementation.
            }
            catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException)
            {
                // InvalidOperationException: MLC types throw for some cross-context paths.
                // NotSupportedException: a TypeBuilderInstantiation (generic instantiation of
                // a type still being defined by emit's TypeBuilders) throws from
                // IsAssignableFrom. In both cases fall through to the reference-context-
                // independent by-name walk below (issue #2135).
            }
        }

        // Cross-context fallback (#610): when the same-context fast path
        // cannot fire (live-runtime ↔ MetadataLoadContext boundary), walk
        // the source's interface set and base-type chain by name. This
        // generalizes the dedicated #570 slice-to-interface arm so ALL CLR
        // reference upcasts work across reflection contexts.
        if (target.IsInterface)
        {
            return ImplementsInterfaceByName(source, target);
        }

        // Base-class walk: check if source derives from target by comparing
        // base type full names up the chain.
        for (var baseType = source.BaseType; baseType != null; baseType = baseType.BaseType)
        {
            if (AreSame(baseType, target))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Returns whether <paramref name="concrete"/> implements an interface
    /// equivalent to <paramref name="targetInterface"/> by name and generic-
    /// argument-name. Generalizes the cross-context (live-runtime vs.
    /// MetadataLoadContext) interface walk that <see cref="IsAssignableByName"/>'s
    /// same-context fast path cannot resolve. Used by #570's slice-conversions-
    /// equal-array-conversions rule and reusable for any future cross-context
    /// "does X implement Y?" probe.
    /// </summary>
    /// <param name="concrete">The candidate concrete type whose interfaces to walk.</param>
    /// <param name="targetInterface">The interface type to match (live or MLC).</param>
    /// <returns><see langword="true"/> when the concrete type implements an
    /// interface whose full-name and generic argument full-names equal the target.</returns>
    public static bool ImplementsInterfaceByName(Type concrete, Type targetInterface)
    {
        if (concrete is null || targetInterface is null)
        {
            return false;
        }

        foreach (var iface in SafeGetInterfaces(concrete))
        {
            if (InterfaceMatchesByName(iface, targetInterface))
            {
                return true;
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
        => SafeEnumerate(type, flags, t => t.GetProperties(flags));

    /// <summary>
    /// Enumerates a type's fields tolerantly (issue #338): fields whose type
    /// cannot be loaded under the reference context are skipped.
    /// </summary>
    /// <param name="type">The type to enumerate.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The fields whose signatures load cleanly.</returns>
    public static FieldInfo[] SafeGetFields(Type type, BindingFlags flags)
        => SafeEnumerate(type, flags, t => t.GetFields(flags));

    /// <summary>
    /// Enumerates a type's events tolerantly (issue #338): events whose handler
    /// type cannot be loaded under the reference context are skipped.
    /// </summary>
    /// <param name="type">The type to enumerate.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The events whose signatures load cleanly.</returns>
    public static EventInfo[] SafeGetEvents(Type type, BindingFlags flags)
        => SafeEnumerate(type, flags, t => t.GetEvents(flags));

    /// <summary>
    /// Enumerates a type's constructors tolerantly (issue #338): constructors
    /// whose parameter signature cannot be loaded under the reference context
    /// are skipped instead of sinking the whole overload set.
    /// </summary>
    /// <param name="type">The type to enumerate.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The constructors whose signatures load cleanly.</returns>
    public static ConstructorInfo[] SafeGetConstructors(Type type, BindingFlags flags)
        => SafeEnumerate(type, flags, t => t.GetConstructors(flags));

    /// <summary>
    /// Enumerates a type's methods tolerantly (issue #338): methods whose
    /// parameter or return signature cannot be loaded under the reference
    /// context are skipped instead of sinking the whole candidate set.
    /// </summary>
    /// <param name="type">The type to enumerate.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The methods whose signatures load cleanly.</returns>
    public static MethodInfo[] SafeGetMethods(Type type, BindingFlags flags)
        => SafeEnumerate(type, flags, t => t.GetMethods(flags));

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
    /// Issue #1582: looks up an instance FIELD named <paramref name="name"/>
    /// inherited from <paramref name="type"/> (a CLR/metadata base class),
    /// walking the CLR base chain and including non-public members whose
    /// accessibility is visible to a derived type — <c>public</c>,
    /// <c>protected</c> (Family), or <c>protected internal</c>
    /// (FamilyOrAssembly). Private and (cross-assembly) internal fields are
    /// excluded, mirroring the accessibility rule used for inherited CLR
    /// methods in <c>CollectBaseClrMethodCandidates</c>. Reflection's
    /// <see cref="Type.GetField(string, BindingFlags)"/> already surfaces
    /// inherited (non-<c>DeclaredOnly</c>) members, so a single tolerant probe
    /// covers the whole chain.
    /// </summary>
    /// <param name="type">The CLR base type to search (its base chain is walked by reflection).</param>
    /// <param name="name">The field name.</param>
    /// <returns>The matching visible inherited field, or <c>null</c> when none is found.</returns>
    public static FieldInfo SafeGetInheritedInstanceField(Type type, string name)
    {
        if (type is null)
        {
            return null;
        }

        var field = SafeGetField(type, name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        if (field != null && (field.IsPublic || field.IsFamily || field.IsFamilyOrAssembly))
        {
            return field;
        }

        return null;
    }

    /// <summary>
    /// Issue #1582: looks up a non-indexer instance PROPERTY named
    /// <paramref name="name"/> inherited from <paramref name="type"/> (a
    /// CLR/metadata base class), walking the CLR base chain and including
    /// members with a non-public accessor whose accessibility is visible to a
    /// derived type (<c>public</c>, <c>protected</c>, or
    /// <c>protected internal</c>). See
    /// <see cref="SafeGetInheritedInstanceField"/> for the accessibility rule.
    /// </summary>
    /// <param name="type">The CLR base type to search (its base chain is walked by reflection).</param>
    /// <param name="name">The property name.</param>
    /// <returns>The matching visible inherited property, or <c>null</c> when none is found.</returns>
    public static PropertyInfo SafeGetInheritedInstanceProperty(Type type, string name)
    {
        if (type is null)
        {
            return null;
        }

        var property = SafeGetProperty(type, name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        if (property == null || property.GetIndexParameters().Length != 0)
        {
            return null;
        }

        var accessor = property.GetGetMethod(nonPublic: true) ?? property.GetSetMethod(nonPublic: true);
        if (accessor != null && (accessor.IsPublic || accessor.IsFamily || accessor.IsFamilyOrAssembly))
        {
            return property;
        }

        return null;
    }

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

    /// <summary>Looks up an event by name across an interface and its inherited interfaces.</summary>
    /// <param name="type">The interface type to search.</param>
    /// <param name="name">The event name.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The matching event, or <c>null</c> when none is found.</returns>
    public static EventInfo SafeGetEventIncludingInterfaces(Type type, string name, BindingFlags flags)
    {
        var direct = SafeGetEvent(type, name, flags);
        if (direct != null)
        {
            return direct;
        }

        if (type is null)
        {
            return null;
        }

        foreach (var iface in SafeGetInterfaces(type))
        {
            var inherited = SafeGetEvent(iface, name, flags);
            if (inherited != null)
            {
                return inherited;
            }
        }

        return null;
    }

    /// <summary>
    /// Issues #529 / #572: looks up a property by name, walking the transitive
    /// interface hierarchy. For interface types this surfaces inherited
    /// interface members; for concrete classes this surfaces default
    /// interface properties (DIMs) that the class does not override.
    /// CLR reflection does not include inherited interface members in
    /// <see cref="Type.GetProperties(BindingFlags)"/>, so this helper
    /// explicitly walks <see cref="Type.GetInterfaces()"/>.
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

        if (type is null)
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
    /// Issues #529 / #572: enumerates methods including those declared on
    /// transitive base interfaces. For interface types this surfaces
    /// inherited interface members; for concrete classes this surfaces
    /// default interface methods (DIMs) that the class does not override.
    /// Methods from interfaces that are hidden by a same-name-and-parameter-types
    /// method already present (on the class or a more-derived interface) are
    /// excluded (mirrors C# hiding rules).
    /// </summary>
    /// <param name="type">The type to enumerate.</param>
    /// <param name="flags">The binding flags controlling visibility.</param>
    /// <returns>The methods whose signatures load cleanly.</returns>
    public static MethodInfo[] SafeGetMethodsIncludingInterfaces(Type type, BindingFlags flags)
    {
        var direct = SafeGetMethods(type, flags);
        if (type is null)
        {
            return direct;
        }

        var interfaces = SafeGetInterfaces(type);
        if (interfaces.Length == 0)
        {
            return direct;
        }

        var all = new List<MethodInfo>(direct);
        foreach (var iface in interfaces)
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

    /// <summary>
    /// Issue #2291: safely determines whether a property accessor OVERRIDES a
    /// base declaration, tolerating a <see cref="System.Reflection.MetadataLoadContext"/>
    /// that does not support <see cref="MethodInfo.GetBaseDefinition"/> (it
    /// throws <see cref="NotSupportedException"/> unconditionally for every
    /// virtual method, not just an unresolvable one). A genuine C# record's
    /// <c>EqualityContract</c> property getter is <c>virtual</c> (so a derived
    /// record can widen it), which is exactly the shape that first surfaced
    /// this: building a semantic aggregate for an imported record under an
    /// MLC-backed resolver must not crash just because ONE property happens to
    /// be virtual. Falls back to "not an override" on failure — the same
    /// conservative default every other MLC-safe query in this file uses.
    /// </summary>
    /// <param name="accessor">The property accessor (getter or setter) to probe.</param>
    /// <returns><c>true</c> when the accessor is confirmed to override a base declaration.</returns>
    public static bool SafeIsOverride(MethodInfo accessor)
    {
        if (accessor is null)
        {
            return false;
        }

        try
        {
            return accessor.GetBaseDefinition() != accessor;
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return false;
        }
    }

    /// <summary>
    /// Issue #1181: collects the transitive closure of imported/BCL base
    /// interfaces declared on <paramref name="interfaceSymbol"/> or on any of
    /// its user base interfaces. A user interface
    /// <c>interface IBox : System.IDisposable</c> records <c>IDisposable</c> in
    /// <see cref="InterfaceSymbol.BaseClrInterfaces"/>; this walk surfaces that
    /// CLR interface plus every interface IT extends (e.g.
    /// <c>IEnumerable&lt;T&gt;</c> → <c>IEnumerable</c>) so the binder and the
    /// language server can project the inherited CLR members onto an
    /// <c>IBox</c>-typed receiver. The result is deduplicated structurally via
    /// <see cref="ClrTypeUtilities.AreSame"/> (FullName-based, robust across
    /// metadata-load contexts).
    /// </summary>
    /// <param name="interfaceSymbol">The user interface whose imported base interfaces to collect.</param>
    /// <returns>The transitive CLR base interface <see cref="Type"/>s, each appearing once.</returns>
    public static IReadOnlyList<Type> GetTransitiveClrBaseInterfaces(InterfaceSymbol interfaceSymbol)
    {
        if (interfaceSymbol == null)
        {
            return Array.Empty<Type>();
        }

        var result = new List<Type>();

        void AddClr(Type clr)
        {
            if (clr == null || !clr.IsInterface)
            {
                return;
            }

            foreach (var existing in result)
            {
                if (AreSame(existing, clr))
                {
                    return;
                }
            }

            result.Add(clr);

            foreach (var transitive in SafeGetInterfaces(clr))
            {
                AddClr(transitive);
            }
        }

        // A user base interface may itself extend a CLR interface, so walk the
        // whole user interface hierarchy (this-first) and harvest each level's
        // imported base interfaces.
        foreach (var iface in interfaceSymbol.SelfAndAllBaseInterfaces())
        {
            if (iface.BaseClrInterfaces.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var clrBase in iface.BaseClrInterfaces)
            {
                if (clrBase?.ClrType is Type clrType)
                {
                    AddClr(clrType);
                }
            }
        }

        return result;
    }

    internal static Type[] SafeGetInterfaces(Type type)
    {
        if (type is null)
        {
            return Array.Empty<Type>();
        }

        // Some MetadataLoadContext Type implementations return only direct
        // interfaces. Complete the graph explicitly and include interfaces
        // inherited through base classes, then cache that canonical result.
        return interfacesCache.GetValue(type, static t =>
        {
            var result = new List<Type>();
            var visited = new HashSet<Type>();

            void Visit(Type current)
            {
                if (current == null || !visited.Add(current))
                {
                    return;
                }

                Type[] direct;
                try
                {
                    direct = current.GetInterfaces();
                }
                catch (Exception ex) when (IsMetadataLoadFailure(ex))
                {
                    direct = Array.Empty<Type>();
                }

                foreach (var iface in direct)
                {
                    if (!result.Contains(iface))
                    {
                        result.Add(iface);
                    }

                    Visit(iface);
                }

                try
                {
                    Visit(current.BaseType);
                }
                catch (Exception ex) when (IsMetadataLoadFailure(ex))
                {
                    // A partial graph is still useful to callers.
                }
            }

            Visit(t);
            return result.ToArray();
        });
    }

    internal static Type RemapHostCoreTypeToContext(Type type, Type contextObject)
    {
        if (type == null
            || contextObject == null
            || ReferenceEquals(contextObject.Assembly, typeof(object).Assembly))
        {
            return type;
        }

        if (type.IsByRef)
        {
            return RemapHostCoreTypeToContext(type.GetElementType(), contextObject).MakeByRefType();
        }

        if (type.IsPointer)
        {
            return RemapHostCoreTypeToContext(type.GetElementType(), contextObject).MakePointerType();
        }

        if (type.IsArray)
        {
            var element = RemapHostCoreTypeToContext(type.GetElementType(), contextObject);
            return type.IsSZArray
                ? element.MakeArrayType()
                : element.MakeArrayType(type.GetArrayRank());
        }

        if (type.IsConstructedGenericType
            && ReferenceEquals(type.GetGenericTypeDefinition().Assembly, typeof(object).Assembly))
        {
            var open = contextObject.Assembly.GetType(
                type.GetGenericTypeDefinition().FullName,
                throwOnError: false);
            if (open != null)
            {
                return open.MakeGenericType(
                    type.GetGenericArguments()
                        .Select(argument => RemapHostCoreTypeToContext(argument, contextObject))
                        .ToArray());
            }
        }

        if (ReferenceEquals(type.Assembly, typeof(object).Assembly))
        {
            return contextObject.Assembly.GetType(type.FullName, throwOnError: false) ?? type;
        }

        return type;
    }

    /// <summary>
    /// Removes every entry from the process-wide CLR member-enumeration caches
    /// (<c>interfacesCache</c> and the per-member-kind caches backing
    /// <see cref="SafeEnumerate{TMember}"/>). Called by
    /// <see cref="ReferenceResolver.Dispose"/> alongside the other
    /// process-wide symbol caches (#1622) so entries keyed on a disposed
    /// <see cref="System.Reflection.MetadataLoadContext"/>'s <see cref="Type"/>
    /// instances do not pin that context's memory for the life of the process.
    /// </summary>
    internal static void ClearCache()
    {
        interfacesCache = new ConditionalWeakTable<Type, Type[]>();
        MemberCache<MethodInfo>.Cache.Clear();
        MemberCache<PropertyInfo>.Cache.Clear();
        MemberCache<FieldInfo>.Cache.Clear();
        MemberCache<EventInfo>.Cache.Clear();
        MemberCache<ConstructorInfo>.Cache.Clear();
    }

    private static bool GenericArgumentsAreAssignable(Type target, Type source)
    {
        var parameters = target.GetGenericTypeDefinition().GetGenericArguments();
        var targetArguments = target.GetGenericArguments();
        var sourceArguments = source.GetGenericArguments();
        for (var i = 0; i < parameters.Length; i++)
        {
            if (AreSame(targetArguments[i], sourceArguments[i]))
            {
                continue;
            }

            if (targetArguments[i].IsValueType || sourceArguments[i].IsValueType)
            {
                return false;
            }

            var variance = parameters[i].GenericParameterAttributes & GenericParameterAttributes.VarianceMask;
            if (variance == GenericParameterAttributes.Covariant
                && IsAssignableByName(targetArguments[i], sourceArguments[i]))
            {
                continue;
            }

            if (variance == GenericParameterAttributes.Contravariant
                && IsAssignableByName(sourceArguments[i], targetArguments[i]))
            {
                continue;
            }

            return false;
        }

        return true;
    }

    private static bool IsConstructedGenericWithTypeBuilderArgument(Type type)
    {
        return type != null
            && type.IsConstructedGenericType
            && ContainsTypeBuilderGenericArgument(type);
    }

    private static bool ContainsTypeBuilderGenericArgument(Type type)
    {
        if (type == null)
        {
            return false;
        }

        if (type is TypeBuilder)
        {
            return true;
        }

        if (type.HasElementType)
        {
            return ContainsTypeBuilderGenericArgument(type.GetElementType());
        }

        if (!type.IsGenericType)
        {
            return false;
        }

        try
        {
            foreach (var arg in type.GetGenericArguments())
            {
                if (ContainsTypeBuilderGenericArgument(arg))
                {
                    return true;
                }
            }
        }
        catch (NotSupportedException)
        {
            return false;
        }

        return false;
    }

    private static bool InterfaceMatchesByName(Type candidate, Type target)
    {
        // Non-generic interfaces: direct FullName comparison.
        if (!target.IsGenericType)
        {
            return string.Equals(candidate.FullName, target.FullName, StringComparison.Ordinal);
        }

        // Generic interfaces: compare the open definition's FullName (e.g.
        // `System.Collections.Generic.IEnumerable`1`) then match each
        // generic argument structurally via AreSame.
        if (!candidate.IsGenericType)
        {
            return false;
        }

        if (!string.Equals(
                candidate.GetGenericTypeDefinition().FullName,
                target.GetGenericTypeDefinition().FullName,
                StringComparison.Ordinal))
        {
            return false;
        }

        var candidateArgs = candidate.GetGenericArguments();
        var targetArgs = target.GetGenericArguments();
        if (candidateArgs.Length != targetArgs.Length)
        {
            return false;
        }

        for (var i = 0; i < candidateArgs.Length; i++)
        {
            if (!AreSame(candidateArgs[i], targetArgs[i]))
            {
                return false;
            }
        }

        return true;
    }

    private static TMember[] SafeEnumerate<TMember>(Type type, BindingFlags flags, Func<Type, TMember[]> getAll)
        where TMember : MemberInfo
    {
        if (type is null)
        {
            return Array.Empty<TMember>();
        }

        // Issue #1678: Type.GetMethods()/GetProperties()/etc. re-walk and
        // re-validate every member on every call (expensive under a
        // MetadataLoadContext); memoize per (Type, Flags, member kind) so a
        // type used at N call sites pays this once instead of N times.
        return MemberCache<TMember>.Cache.GetOrAdd((type, flags), key =>
        {
            TMember[] all;
            try
            {
                all = getAll(key.Type);
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
        });
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
        catch (AmbiguousMatchException)
        {
            for (var declaringType = type; declaringType != null; declaringType = declaringType.BaseType)
            {
                TMember match = null;
                foreach (var member in safeEnumerate(type, flags))
                {
                    if (!string.Equals(member.Name, name, StringComparison.Ordinal)
                        || !AreSame(member.DeclaringType, declaringType))
                    {
                        continue;
                    }

                    if (match != null)
                    {
                        return null;
                    }

                    match = member;
                }

                if (match != null)
                {
                    return match;
                }
            }

            return null;
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

    /// <summary>
    /// Per-member-kind cache backing <see cref="SafeEnumerate{TMember}"/>. A
    /// distinct closed generic (<c>MemberCache&lt;MethodInfo&gt;</c> vs.
    /// <c>MemberCache&lt;PropertyInfo&gt;</c>, etc.) gets its own static
    /// dictionary, so a single <c>(Type, BindingFlags)</c> key cannot collide
    /// across member kinds.
    /// </summary>
    /// <typeparam name="TMember">The <see cref="MemberInfo"/>-derived member kind cached.</typeparam>
    private static class MemberCache<TMember>
        where TMember : MemberInfo
    {
        internal static readonly ConcurrentDictionary<(Type Type, BindingFlags Flags), TMember[]> Cache = new();
    }
}
