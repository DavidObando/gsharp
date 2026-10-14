// <copyright file="ClrMemberVisibility.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Reflection

/// Issue #3705: the single place that decides whether an imported CLR member
/// is visible to the compilation currently being bound.
///
/// Member-lookup probes across the binder each hand-rolled their own
/// (cref:BindingFlags) and `nonPublic:` arguments, and the result
/// was a family of "inconsistent sibling probe" defects (#3693, #3702, #3703):
/// a friend assembly's `internal` method was a candidate while its
/// `internal` property was not, an `internal` setter was readable
/// but not writable, and so on. Every probe that participates in member lookup
/// should ask these helpers instead, passing the one bit that decides the
/// answer — whether
/// (cref:ReferenceResolver.CanAccessInternalMembers(Assembly?)) holds
/// for the declaring assembly.
///
/// General member lookup admits only `public` and friend-visible
/// `assembly` members. The explicitly derived-type helpers additionally
/// admit the CLR family accessibilities available from a subclass; private
/// members remain invisible.
shared class ClrMemberVisibility {
    /// Widens [`flags`](paramref) to include
    /// (cref:BindingFlags.NonPublic) when friend-assembly internals are
    /// visible. The caller must still filter the returned members through the
    /// per-member predicates below: (cref:BindingFlags.NonPublic) also
    /// admits `private` and `protected`.
    /// @param flags The public-only binding flags.
    /// @param includeInternal Whether friend internals are visible.
    /// @returns The widened flags.
    func Widen(flags BindingFlags, includeInternal bool) BindingFlags -> if includeInternal {
        flags | BindingFlags.NonPublic
    } else {
        flags
    }

    /// Whether a method/accessor is visible to the consuming compilation.
    /// @param method The candidate method, or `null`.
    /// @param includeInternal Whether friend internals are visible.
    /// @returns `true` when the method may be bound here.
    func IsVisible(method MethodBase?, includeInternal bool) bool -> method != nil &&
        (method.IsPublic || (includeInternal && method.IsAssembly))

    /// Whether a method or accessor is visible from a derived type.
    /// @param method The candidate method, or `null`.
    /// @param includeInternal Whether friend internals are visible.
    /// @returns `true` when the method may be called from the derived type.
    func IsVisibleFromDerived(method MethodBase?, includeInternal bool) bool -> method != nil &&
        (method.IsPublic || method.IsFamily || method.IsFamilyOrAssembly || (includeInternal && method.IsAssembly))

    /// Whether a field is visible to the consuming compilation.
    /// @param field The candidate field, or `null`.
    /// @param includeInternal Whether friend internals are visible.
    /// @returns `true` when the field may be bound here.
    func IsVisible(field FieldInfo?, includeInternal bool) bool -> field != nil &&
        (field.IsPublic || (includeInternal && field.IsAssembly))

    /// Whether a field is visible from a derived type.
    /// @param field The candidate field, or `null`.
    /// @param includeInternal Whether friend internals are visible.
    /// @returns `true` when the field may be accessed from the derived type.
    func IsVisibleFromDerived(field FieldInfo?, includeInternal bool) bool -> field != nil &&
        (field.IsPublic || field.IsFamily || field.IsFamilyOrAssembly || (includeInternal && field.IsAssembly))

    /// Whether a property is visible — i.e. at least one of its accessors is.
    /// A `{ get; internal set; }` property is visible to a friend and to
    /// a non-friend alike; only the setter differs, which is
    /// (cref:GetVisibleSetter)'s business.
    /// @param property The candidate property, or `null`.
    /// @param includeInternal Whether friend internals are visible.
    /// @returns `true` when the property may be bound here.
    func IsVisible(property PropertyInfo?, includeInternal bool) bool -> property != nil &&
        (GetVisibleGetter(property, includeInternal) != nil || GetVisibleSetter(property, includeInternal) != nil)

    /// Whether an event is visible — i.e. its `add` accessor is.
    /// @param eventInfo The candidate event, or `null`.
    /// @param includeInternal Whether friend internals are visible.
    /// @returns `true` when the event may be bound here.
    func IsVisible(eventInfo EventInfo?, includeInternal bool) bool -> eventInfo != nil &&
        GetVisibleAddMethod(eventInfo, includeInternal) != nil

    /// Returns the property's getter when it is visible here.
    /// @param property The property to inspect.
    /// @param includeInternal Whether friend internals are visible.
    /// @returns The visible getter, or `null`.
    func GetVisibleGetter(property PropertyInfo, includeInternal bool) MethodInfo? -> Visible(
        property.GetGetMethod(nonPublic: true),
        includeInternal
    )

    /// Returns the property's setter when it is visible here.
    /// @param property The property to inspect.
    /// @param includeInternal Whether friend internals are visible.
    /// @returns The visible setter, or `null`.
    func GetVisibleSetter(property PropertyInfo, includeInternal bool) MethodInfo? -> Visible(
        property.GetSetMethod(nonPublic: true),
        includeInternal
    )

    /// Returns the property's getter when callable from a derived type.
    /// @param property The imported CLR property.
    /// @param includeInternal Whether friend internals are visible.
    /// @returns The callable getter, or `null`.
    func GetDerivedVisibleGetter(property PropertyInfo, includeInternal bool) MethodInfo? -> VisibleFromDerived(
        property.GetGetMethod(nonPublic: true),
        includeInternal
    )

    /// Issue #3813: the setter as seen from <b>inside a type that derives from
    /// the property's declaring type</b>, where CLR `family` accessibility
    /// is reachable and the blanket "protected stays invisible" rule of the
    /// other overloads does not apply.
    ///
    /// A G# class deriving from an imported CLR base is entitled to that base's
    /// `protected` members — the inherited-base assignment paths in
    /// `ExpressionBinder` say so in as many words (issues #319/#1582) and
    /// already deliver it for `protected` <em>fields</em>. Properties went
    /// through the accessor gate instead, so a `{ get; protected set; }`
    /// base property (e.g. `System.Threading.Channels.Channel<T>.Reader`)
    /// was reported read-only (`GS0127`) in a derived type's own
    /// constructor — a write C# accepts.
    /// @param property The property to inspect.
    /// @param includeInternal Whether friend internals are visible.
    /// @returns The setter callable from a derived type, or `null`.
    func GetDerivedVisibleSetter(property PropertyInfo, includeInternal bool) MethodInfo? -> VisibleFromDerived(
        property.GetSetMethod(nonPublic: true),
        includeInternal
    )

    /// Returns the event's `add` accessor when it is visible here.
    /// @param eventInfo The event to inspect.
    /// @param includeInternal Whether friend internals are visible.
    /// @returns The visible accessor, or `null`.
    func GetVisibleAddMethod(eventInfo EventInfo, includeInternal bool) MethodInfo? -> Visible(
        eventInfo.GetAddMethod(nonPublic: true),
        includeInternal
    )

    /// Returns the event's `remove` accessor when it is visible here.
    /// @param eventInfo The event to inspect.
    /// @param includeInternal Whether friend internals are visible.
    /// @returns The visible accessor, or `null`.
    func GetVisibleRemoveMethod(eventInfo EventInfo, includeInternal bool) MethodInfo? -> Visible(
        eventInfo.GetRemoveMethod(nonPublic: true),
        includeInternal
    )

    private func Visible(accessor MethodInfo?, includeInternal bool) MethodInfo? -> if IsVisible(
        accessor,
        includeInternal
    ) {
        accessor
    } else {
        default(MethodInfo?)
    }

    private func VisibleFromDerived(accessor MethodInfo?, includeInternal bool) MethodInfo? -> if IsVisibleFromDerived(
        accessor,
        includeInternal
    ) {
        accessor
    } else {
        default(MethodInfo?)
    }
}
