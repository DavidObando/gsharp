// <copyright file="ClrMemberVisibility.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Issue #3705: the single place that decides whether an imported CLR member
/// is visible to the compilation currently being bound.
/// <para>
/// Member-lookup probes across the binder each hand-rolled their own
/// <see cref="BindingFlags"/> and <c>nonPublic:</c> arguments, and the result
/// was a family of "inconsistent sibling probe" defects (#3693, #3702, #3703):
/// a friend assembly's <c>internal</c> method was a candidate while its
/// <c>internal</c> property was not, an <c>internal</c> setter was readable
/// but not writable, and so on. Every probe that participates in member lookup
/// should ask these helpers instead, passing the one bit that decides the
/// answer — whether
/// <see cref="ReferenceResolver.CanAccessInternalMembers(Assembly?)"/> holds
/// for the declaring assembly.
/// </para>
/// <para>
/// Only metadata <c>assembly</c> accessibility is ever admitted:
/// <c>private</c>, <c>protected</c>, <c>protected internal</c> and
/// <c>private protected</c> members stay invisible however the friendship is
/// declared, and a consumer that was not named in an
/// <c>InternalsVisibleTo</c> sees none of them.
/// </para>
/// </summary>
public static class ClrMemberVisibility
{
    /// <summary>
    /// Widens <paramref name="flags"/> to include
    /// <see cref="BindingFlags.NonPublic"/> when friend-assembly internals are
    /// visible. The caller must still filter the returned members through the
    /// per-member predicates below: <see cref="BindingFlags.NonPublic"/> also
    /// admits <c>private</c> and <c>protected</c>.
    /// </summary>
    /// <param name="flags">The public-only binding flags.</param>
    /// <param name="includeInternal">Whether friend internals are visible.</param>
    /// <returns>The widened flags.</returns>
    public static BindingFlags Widen(BindingFlags flags, bool includeInternal)
        => includeInternal ? flags | BindingFlags.NonPublic : flags;

    /// <summary>Whether a method/accessor is visible to the consuming compilation.</summary>
    /// <param name="method">The candidate method, or <see langword="null"/>.</param>
    /// <param name="includeInternal">Whether friend internals are visible.</param>
    /// <returns><see langword="true"/> when the method may be bound here.</returns>
    public static bool IsVisible(MethodBase? method, bool includeInternal)
        => method != null && (method.IsPublic || (includeInternal && method.IsAssembly));

    /// <summary>Whether a field is visible to the consuming compilation.</summary>
    /// <param name="field">The candidate field, or <see langword="null"/>.</param>
    /// <param name="includeInternal">Whether friend internals are visible.</param>
    /// <returns><see langword="true"/> when the field may be bound here.</returns>
    public static bool IsVisible(FieldInfo? field, bool includeInternal)
        => field != null && (field.IsPublic || (includeInternal && field.IsAssembly));

    /// <summary>
    /// Whether a property is visible — i.e. at least one of its accessors is.
    /// A <c>{ get; internal set; }</c> property is visible to a friend and to
    /// a non-friend alike; only the setter differs, which is
    /// <see cref="GetVisibleSetter"/>'s business.
    /// </summary>
    /// <param name="property">The candidate property, or <see langword="null"/>.</param>
    /// <param name="includeInternal">Whether friend internals are visible.</param>
    /// <returns><see langword="true"/> when the property may be bound here.</returns>
    public static bool IsVisible(PropertyInfo? property, bool includeInternal)
        => property != null
            && (GetVisibleGetter(property, includeInternal) != null
                || GetVisibleSetter(property, includeInternal) != null);

    /// <summary>Whether an event is visible — i.e. its <c>add</c> accessor is.</summary>
    /// <param name="eventInfo">The candidate event, or <see langword="null"/>.</param>
    /// <param name="includeInternal">Whether friend internals are visible.</param>
    /// <returns><see langword="true"/> when the event may be bound here.</returns>
    public static bool IsVisible(EventInfo? eventInfo, bool includeInternal)
        => eventInfo != null && GetVisibleAddMethod(eventInfo, includeInternal) != null;

    /// <summary>Returns the property's getter when it is visible here.</summary>
    /// <param name="property">The property to inspect.</param>
    /// <param name="includeInternal">Whether friend internals are visible.</param>
    /// <returns>The visible getter, or <see langword="null"/>.</returns>
    public static MethodInfo? GetVisibleGetter(PropertyInfo property, bool includeInternal)
        => Visible(property.GetGetMethod(nonPublic: true), includeInternal);

    /// <summary>Returns the property's setter when it is visible here.</summary>
    /// <param name="property">The property to inspect.</param>
    /// <param name="includeInternal">Whether friend internals are visible.</param>
    /// <returns>The visible setter, or <see langword="null"/>.</returns>
    public static MethodInfo? GetVisibleSetter(PropertyInfo property, bool includeInternal)
        => Visible(property.GetSetMethod(nonPublic: true), includeInternal);

    /// <summary>
    /// Issue #3813: the setter as seen from <b>inside a type that derives from
    /// the property's declaring type</b>, where CLR <c>family</c> accessibility
    /// is reachable and the blanket "protected stays invisible" rule of the
    /// other overloads does not apply.
    /// <para>
    /// A G# class deriving from an imported CLR base is entitled to that base's
    /// <c>protected</c> members — the inherited-base assignment paths in
    /// <c>ExpressionBinder</c> say so in as many words (issues #319/#1582) and
    /// already deliver it for <c>protected</c> <em>fields</em>. Properties went
    /// through the accessor gate instead, so a <c>{ get; protected set; }</c>
    /// base property (e.g. <c>System.Threading.Channels.Channel&lt;T&gt;.Reader</c>)
    /// was reported read-only (<c>GS0127</c>) in a derived type's own
    /// constructor — a write C# accepts.
    /// </para>
    /// </summary>
    /// <param name="property">The property to inspect.</param>
    /// <param name="includeInternal">Whether friend internals are visible.</param>
    /// <returns>The setter callable from a derived type, or <see langword="null"/>.</returns>
    public static MethodInfo? GetDerivedVisibleSetter(PropertyInfo property, bool includeInternal)
    {
        var setter = property.GetSetMethod(nonPublic: true);
        if (setter == null)
        {
            return null;
        }

        // `family` (protected) and `famorassem` (protected internal) are always
        // reachable from a derived type; `famandassem` (private protected) only
        // adds the same-assembly/friend requirement on top.
        var reachable = setter.IsFamily
            || setter.IsFamilyOrAssembly
            || (includeInternal && setter.IsFamilyAndAssembly);
        return reachable ? setter : Visible(setter, includeInternal);
    }

    /// <summary>Returns the event's <c>add</c> accessor when it is visible here.</summary>
    /// <param name="eventInfo">The event to inspect.</param>
    /// <param name="includeInternal">Whether friend internals are visible.</param>
    /// <returns>The visible accessor, or <see langword="null"/>.</returns>
    public static MethodInfo? GetVisibleAddMethod(EventInfo eventInfo, bool includeInternal)
        => Visible(eventInfo.GetAddMethod(nonPublic: true), includeInternal);

    /// <summary>Returns the event's <c>remove</c> accessor when it is visible here.</summary>
    /// <param name="eventInfo">The event to inspect.</param>
    /// <param name="includeInternal">Whether friend internals are visible.</param>
    /// <returns>The visible accessor, or <see langword="null"/>.</returns>
    public static MethodInfo? GetVisibleRemoveMethod(EventInfo eventInfo, bool includeInternal)
        => Visible(eventInfo.GetRemoveMethod(nonPublic: true), includeInternal);

    private static MethodInfo? Visible(MethodInfo? accessor, bool includeInternal)
        => IsVisible(accessor, includeInternal) ? accessor : null;
}
