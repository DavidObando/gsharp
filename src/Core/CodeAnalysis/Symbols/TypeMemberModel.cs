// <copyright file="TypeMemberModel.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0112: the single canonical member-resolution layer for user-defined G#
/// types (<see cref="StructSymbol"/> for class + struct,
/// <see cref="InterfaceSymbol"/>, and <see cref="EnumSymbol"/>).
///
/// This type is deliberately pure — it has no <c>BinderContext</c> dependency and
/// returns only existing <see cref="Symbol"/> instances (FunctionSymbol /
/// FieldSymbol / PropertySymbol / EventSymbol / EnumMemberSymbol) — so both the
/// binder and the language server can consume it without behavioral drift, and
/// emit / overload resolution / conversion are unaffected by the layer itself.
///
/// CLR / imported member reflection is intentionally out of scope and remains
/// behind <c>MemberLookup</c>; this layer covers user-symbol member tables only.
/// </summary>
public static class TypeMemberModel
{
    /// <summary>
    /// Looks up the first member named <paramref name="name"/> on
    /// <paramref name="type"/> honoring <paramref name="query"/>. The search
    /// order — property → field → event → method, instance entries before static
    /// entries, walking the base chain this-first — matches the historic
    /// language-server enumeration so hover/definition/lookup stay byte-for-byte
    /// equivalent under <see cref="MemberQuery.All"/>.
    /// </summary>
    /// <param name="type">The type to resolve against (user-defined types only).</param>
    /// <param name="name">The member name.</param>
    /// <param name="query">The static/instance/inherited/kind filter.</param>
    /// <returns>The first matching member, or <c>null</c> when none matches.</returns>
    public static Symbol LookupMember(TypeSymbol type, string name, MemberQuery query)
    {
        if (type is StructSymbol structSymbol)
        {
            return LookupStructMember(structSymbol, name, query);
        }

        if (type is InterfaceSymbol interfaceSymbol)
        {
            return LookupInterfaceMember(interfaceSymbol, name, query);
        }

        if (type is EnumSymbol enumSymbol)
        {
            if (query.IncludeStatic && (query.Kinds & MemberKinds.Field) != 0
                && enumSymbol.TryGetMember(name, out var enumMember))
            {
                return enumMember;
            }

            return null;
        }

        return null;
    }

    /// <summary>
    /// Returns every method named <paramref name="name"/> visible on
    /// <paramref name="type"/> for the given query (the overload set), walking
    /// inheritance this-first with signature-based dedup so each visible
    /// signature appears once. Instance methods are surfaced when
    /// <see cref="MemberQuery.IncludeInstance"/> is set; static methods when
    /// <see cref="MemberQuery.IncludeStatic"/> is set.
    /// </summary>
    /// <param name="type">The type to resolve against.</param>
    /// <param name="name">The method name.</param>
    /// <param name="query">The static/instance/inherited filter.</param>
    /// <returns>The merged overload set; empty when none found.</returns>
    public static ImmutableArray<FunctionSymbol> GetMethods(TypeSymbol type, string name, MemberQuery query)
    {
        if ((query.Kinds & MemberKinds.Method) == 0)
        {
            return ImmutableArray<FunctionSymbol>.Empty;
        }

        if (type is StructSymbol structSymbol)
        {
            ImmutableArray<FunctionSymbol>.Builder builder = null;
            for (var c = structSymbol; c != null; c = c.BaseClass)
            {
                if (query.IncludeInstance)
                {
                    AddMethodsDeduped(ref builder, c.Methods, name);
                }

                if (query.IncludeStatic)
                {
                    AddMethodsDeduped(ref builder, c.StaticMethods, name);
                }

                if (!query.IncludeInherited)
                {
                    break;
                }
            }

            return builder?.ToImmutable() ?? ImmutableArray<FunctionSymbol>.Empty;
        }

        if (type is InterfaceSymbol interfaceSymbol)
        {
            ImmutableArray<FunctionSymbol>.Builder builder = null;
            if (query.IncludeInstance)
            {
                AddMethodsDeduped(ref builder, interfaceSymbol.Methods, name);
            }

            if (query.IncludeStatic)
            {
                AddMethodsDeduped(ref builder, interfaceSymbol.StaticMethods, name);
            }

            return builder?.ToImmutable() ?? ImmutableArray<FunctionSymbol>.Empty;
        }

        return ImmutableArray<FunctionSymbol>.Empty;
    }

    /// <summary>Enumerates every member matching <paramref name="query"/> on <paramref name="type"/> (for completion). Order is this-first, kind by kind, instance entries before static entries.</summary>
    /// <param name="type">The type to enumerate.</param>
    /// <param name="query">The static/instance/inherited/kind filter.</param>
    /// <returns>The matching members.</returns>
    public static IEnumerable<Symbol> EnumerateMembers(TypeSymbol type, MemberQuery query)
    {
        if (type is StructSymbol structSymbol)
        {
            return EnumerateStructMembers(structSymbol, query);
        }

        if (type is InterfaceSymbol interfaceSymbol)
        {
            return EnumerateInterfaceMembers(interfaceSymbol, query);
        }

        if (type is EnumSymbol enumSymbol)
        {
            return EnumerateEnumMembers(enumSymbol, query);
        }

        return System.Linq.Enumerable.Empty<Symbol>();
    }

    /// <summary>Tries to find an instance field named <paramref name="name"/> on <paramref name="type"/>, walking the base chain.</summary>
    /// <param name="type">The type to resolve against.</param>
    /// <param name="name">The field name.</param>
    /// <param name="field">The found field on success.</param>
    /// <returns>True if found.</returns>
    public static bool TryGetField(TypeSymbol type, string name, out FieldSymbol field)
    {
        if (type is StructSymbol structSymbol)
        {
            for (var c = structSymbol; c != null; c = c.BaseClass)
            {
                if (c.TryGetField(name, out field))
                {
                    return true;
                }
            }
        }

        field = null;
        return false;
    }

    /// <summary>
    /// ADR-0112 P0: tries to find a field named <paramref name="name"/> on
    /// <paramref name="type"/> while also surfacing the <see cref="StructSymbol"/>
    /// that actually declares it — the binder needs the declaring struct to build
    /// a <c>BoundFieldAccessExpression</c>. This mirrors
    /// <see cref="StructSymbol.TryGetFieldIncludingInherited"/> for the
    /// declaring-type semantics but honors <paramref name="query"/> (instance
    /// before static at each level, this-first base-chain walk, stopping when
    /// <see cref="MemberQuery.IncludeInherited"/> is unset).
    /// </summary>
    /// <param name="type">The type to resolve against (user-defined struct/class only).</param>
    /// <param name="name">The field name.</param>
    /// <param name="query">The static/instance/inherited filter.</param>
    /// <param name="field">The found field on success.</param>
    /// <param name="declaringType">The struct that actually declares the field on success.</param>
    /// <returns>True if found.</returns>
    public static bool TryGetFieldIncludingInherited(TypeSymbol type, string name, MemberQuery query, out FieldSymbol field, out StructSymbol declaringType)
    {
        if ((query.Kinds & MemberKinds.Field) != 0 && type is StructSymbol structSymbol)
        {
            for (var c = structSymbol; c != null; c = c.BaseClass)
            {
                if (query.IncludeInstance && c.TryGetField(name, out field))
                {
                    declaringType = c;
                    return true;
                }

                if (query.IncludeStatic && c.TryGetStaticField(name, out field))
                {
                    declaringType = c;
                    return true;
                }

                if (!query.IncludeInherited)
                {
                    break;
                }
            }
        }

        field = null;
        declaringType = null;
        return false;
    }

    /// <summary>Tries to find a static field named <paramref name="name"/> on <paramref name="type"/>.</summary>
    /// <param name="type">The type to resolve against.</param>
    /// <param name="name">The field name.</param>
    /// <param name="field">The found field on success.</param>
    /// <returns>True if found.</returns>
    public static bool TryGetStaticField(TypeSymbol type, string name, out FieldSymbol field)
    {
        if (type is StructSymbol structSymbol && structSymbol.TryGetStaticField(name, out field))
        {
            return true;
        }

        field = null;
        return false;
    }

    /// <summary>Tries to find an instance property named <paramref name="name"/> on <paramref name="type"/>, walking the base chain.</summary>
    /// <param name="type">The type to resolve against.</param>
    /// <param name="name">The property name.</param>
    /// <param name="property">The found property on success.</param>
    /// <returns>True if found.</returns>
    public static bool TryGetProperty(TypeSymbol type, string name, out PropertySymbol property)
    {
        if (type is StructSymbol structSymbol)
        {
            for (var c = structSymbol; c != null; c = c.BaseClass)
            {
                foreach (var p in c.Properties)
                {
                    if (p.Name == name)
                    {
                        property = p;
                        return true;
                    }
                }
            }
        }
        else if (type is InterfaceSymbol interfaceSymbol)
        {
            foreach (var p in interfaceSymbol.Properties)
            {
                if (p.Name == name)
                {
                    property = p;
                    return true;
                }
            }
        }

        property = null;
        return false;
    }

    /// <summary>Tries to find a static property named <paramref name="name"/> on <paramref name="type"/>.</summary>
    /// <param name="type">The type to resolve against.</param>
    /// <param name="name">The property name.</param>
    /// <param name="property">The found property on success.</param>
    /// <returns>True if found.</returns>
    public static bool TryGetStaticProperty(TypeSymbol type, string name, out PropertySymbol property)
    {
        if (type is StructSymbol structSymbol)
        {
            foreach (var p in structSymbol.StaticProperties)
            {
                if (p.Name == name)
                {
                    property = p;
                    return true;
                }
            }
        }

        property = null;
        return false;
    }

    /// <summary>Tries to find an instance event named <paramref name="name"/> on <paramref name="type"/>, walking the base chain.</summary>
    /// <param name="type">The type to resolve against.</param>
    /// <param name="name">The event name.</param>
    /// <param name="event">The found event on success.</param>
    /// <returns>True if found.</returns>
    public static bool TryGetEvent(TypeSymbol type, string name, out EventSymbol @event)
    {
        if (type is StructSymbol structSymbol)
        {
            for (var c = structSymbol; c != null; c = c.BaseClass)
            {
                foreach (var e in c.Events)
                {
                    if (e.Name == name)
                    {
                        @event = e;
                        return true;
                    }
                }
            }
        }
        else if (type is InterfaceSymbol interfaceSymbol)
        {
            foreach (var e in interfaceSymbol.Events)
            {
                if (e.Name == name)
                {
                    @event = e;
                    return true;
                }
            }
        }

        @event = null;
        return false;
    }

    /// <summary>Tries to find a static event named <paramref name="name"/> on <paramref name="type"/>.</summary>
    /// <param name="type">The type to resolve against.</param>
    /// <param name="name">The event name.</param>
    /// <param name="event">The found event on success.</param>
    /// <returns>True if found.</returns>
    public static bool TryGetStaticEvent(TypeSymbol type, string name, out EventSymbol @event)
    {
        if (type is StructSymbol structSymbol)
        {
            foreach (var e in structSymbol.StaticEvents)
            {
                if (e.Name == name)
                {
                    @event = e;
                    return true;
                }
            }
        }

        @event = null;
        return false;
    }

    private static IEnumerable<Symbol> EnumerateStructMembers(StructSymbol structSymbol, MemberQuery query)
    {
        for (var c = structSymbol; c != null; c = c.BaseClass)
        {
            if ((query.Kinds & MemberKinds.Field) != 0)
            {
                if (query.IncludeInstance)
                {
                    foreach (var f in c.Fields)
                    {
                        yield return f;
                    }
                }

                if (query.IncludeStatic)
                {
                    foreach (var f in c.StaticFields)
                    {
                        yield return f;
                    }
                }
            }

            if ((query.Kinds & MemberKinds.Property) != 0)
            {
                if (query.IncludeInstance)
                {
                    foreach (var p in c.Properties)
                    {
                        yield return p;
                    }
                }

                if (query.IncludeStatic)
                {
                    foreach (var p in c.StaticProperties)
                    {
                        yield return p;
                    }
                }
            }

            if ((query.Kinds & MemberKinds.Event) != 0)
            {
                if (query.IncludeInstance)
                {
                    foreach (var e in c.Events)
                    {
                        yield return e;
                    }
                }

                if (query.IncludeStatic)
                {
                    foreach (var e in c.StaticEvents)
                    {
                        yield return e;
                    }
                }
            }

            if ((query.Kinds & MemberKinds.Method) != 0)
            {
                if (query.IncludeInstance)
                {
                    foreach (var m in c.Methods)
                    {
                        yield return m;
                    }
                }

                if (query.IncludeStatic)
                {
                    foreach (var m in c.StaticMethods)
                    {
                        yield return m;
                    }
                }
            }

            if (!query.IncludeInherited)
            {
                yield break;
            }
        }
    }

    /// <summary>
    /// ADR-0112 P0: enumerates an interface's members for completion. Interfaces
    /// have no base-chain modeling here, so this surfaces the interface's own
    /// instance properties/events/methods plus static methods, honoring the
    /// query. (InterfaceSymbol does not currently model static
    /// properties/events; see the ADR-0112 P0 addendum.)
    /// </summary>
    private static IEnumerable<Symbol> EnumerateInterfaceMembers(InterfaceSymbol interfaceSymbol, MemberQuery query)
    {
        if ((query.Kinds & MemberKinds.Property) != 0 && query.IncludeInstance)
        {
            foreach (var p in interfaceSymbol.Properties)
            {
                yield return p;
            }
        }

        if ((query.Kinds & MemberKinds.Event) != 0 && query.IncludeInstance)
        {
            foreach (var e in interfaceSymbol.Events)
            {
                yield return e;
            }
        }

        if ((query.Kinds & MemberKinds.Method) != 0)
        {
            if (query.IncludeInstance)
            {
                foreach (var m in interfaceSymbol.Methods)
                {
                    yield return m;
                }
            }

            if (query.IncludeStatic)
            {
                foreach (var m in interfaceSymbol.StaticMethods)
                {
                    yield return m;
                }
            }
        }
    }

    /// <summary>
    /// ADR-0112 P0: enumerates an enum's members for completion. Enum members
    /// are surfaced as static fields, mirroring the enum handling in
    /// <see cref="LookupMember"/>.
    /// </summary>
    private static IEnumerable<Symbol> EnumerateEnumMembers(EnumSymbol enumSymbol, MemberQuery query)
    {
        if (query.IncludeStatic && (query.Kinds & MemberKinds.Field) != 0)
        {
            foreach (var member in enumSymbol.Members)
            {
                yield return member;
            }
        }
    }

    private static Symbol LookupStructMember(StructSymbol structSymbol, string name, MemberQuery query)
    {
        for (var c = structSymbol; c != null; c = c.BaseClass)
        {
            if ((query.Kinds & MemberKinds.Property) != 0
                && TryFirst(query.IncludeInstance ? c.Properties : ImmutableArray<PropertySymbol>.Empty, query.IncludeStatic ? c.StaticProperties : ImmutableArray<PropertySymbol>.Empty, name, out PropertySymbol property))
            {
                return property;
            }

            if ((query.Kinds & MemberKinds.Field) != 0
                && TryFirst(query.IncludeInstance ? c.Fields : ImmutableArray<FieldSymbol>.Empty, query.IncludeStatic ? c.StaticFields : ImmutableArray<FieldSymbol>.Empty, name, out FieldSymbol field))
            {
                return field;
            }

            if ((query.Kinds & MemberKinds.Event) != 0
                && TryFirst(query.IncludeInstance ? c.Events : ImmutableArray<EventSymbol>.Empty, query.IncludeStatic ? c.StaticEvents : ImmutableArray<EventSymbol>.Empty, name, out EventSymbol @event))
            {
                return @event;
            }

            if ((query.Kinds & MemberKinds.Method) != 0
                && TryFirst(query.IncludeInstance ? c.Methods : ImmutableArray<FunctionSymbol>.Empty, query.IncludeStatic ? c.StaticMethods : ImmutableArray<FunctionSymbol>.Empty, name, out FunctionSymbol method))
            {
                return method;
            }

            if (!query.IncludeInherited)
            {
                break;
            }
        }

        return null;
    }

    private static Symbol LookupInterfaceMember(InterfaceSymbol interfaceSymbol, string name, MemberQuery query)
    {
        if ((query.Kinds & MemberKinds.Property) != 0 && query.IncludeInstance)
        {
            foreach (var p in interfaceSymbol.Properties)
            {
                if (p.Name == name)
                {
                    return p;
                }
            }
        }

        if ((query.Kinds & MemberKinds.Event) != 0 && query.IncludeInstance)
        {
            foreach (var e in interfaceSymbol.Events)
            {
                if (e.Name == name)
                {
                    return e;
                }
            }
        }

        if ((query.Kinds & MemberKinds.Method) != 0)
        {
            if (query.IncludeInstance && interfaceSymbol.TryGetMethod(name, out var method))
            {
                return method;
            }

            if (query.IncludeStatic && interfaceSymbol.TryGetStaticMethod(name, out var staticMethod))
            {
                return staticMethod;
            }
        }

        return null;
    }

    private static bool TryFirst<T>(ImmutableArray<T> instance, ImmutableArray<T> @static, string name, out T result)
        where T : Symbol
    {
        if (!instance.IsDefaultOrEmpty)
        {
            foreach (var s in instance)
            {
                if (s.Name == name)
                {
                    result = s;
                    return true;
                }
            }
        }

        if (!@static.IsDefaultOrEmpty)
        {
            foreach (var s in @static)
            {
                if (s.Name == name)
                {
                    result = s;
                    return true;
                }
            }
        }

        result = null;
        return false;
    }

    private static void AddMethodsDeduped(ref ImmutableArray<FunctionSymbol>.Builder builder, ImmutableArray<FunctionSymbol> source, string name)
    {
        if (source.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var m in source)
        {
            if (m.Name != name)
            {
                continue;
            }

            if (builder != null)
            {
                var hidden = false;
                foreach (var existing in builder)
                {
                    if (BoundScope.FunctionSignaturesEqual(existing, m))
                    {
                        hidden = true;
                        break;
                    }
                }

                if (hidden)
                {
                    continue;
                }
            }

            builder ??= ImmutableArray.CreateBuilder<FunctionSymbol>();
            builder.Add(m);
        }
    }
}
