// <copyright file="ExplicitInterfaceMetadataNaming.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Symbols

/// ADR-0149: an explicit-interface qualifier clause (`func (IFoo) M(...)`
/// / `prop (IFoo) P T`) keeps its declared, source-visible name plain —
/// diagnostics, reflection `Name` lookups by the ordinary member name,
/// and hand-authored G# source never see anything but `M` / `P`.
/// But the CLR metadata name of the emitted MethodDef/PropertyDef row (and,
/// for a property, its `get_`/`set_` accessor MethodDefs) DOES need
/// to be collision-free: two explicit implementations of DIFFERENT interfaces
/// that share a member name (the entire point of the feature) would otherwise
/// emit two MethodDefs with the identical name and signature in the same
/// type — legal at the raw metadata level, but indistinguishable to
/// reflection APIs that look a member up by name (and needlessly fragile).
/// This helper synthesizes a qualified, C#-explicit-impl-style metadata name
/// (`Interface.Member`, or `Package.Interface.Member` when the
/// interface has a package/namespace) that is unique per (interface, member)
/// slot — the same uniqueness key (cref:DiagnosticBag.ReportDuplicateExplicitInterfaceImplementation)
/// (GS0495) already enforces at the source level, so within a single valid
/// compilation this synthesized name can never collide with another such
/// synthesized name, nor (since it always contains at least one `.`,
/// which no plain G# identifier can contain) with any ordinary member's name.
internal shared class ExplicitInterfaceMetadataNaming {
    /// Returns the collision-free CLR metadata name for a member explicitly
    /// implementing [`target`](paramref)'s [`memberName`](paramref)
    /// member, or [`memberName`](paramref) itself unchanged when
    /// [`target`](paramref) is `null` (not an explicit
    /// implementation, or not yet resolved — the latter only for a program
    /// that already has a GS0492/GS0493 error and will not reach emit).
    /// @param memberName The declared (plain, source-visible) member name.
    /// @param target The resolved explicit-interface clause target, or `null`.
    /// @returns A collision-free metadata name, or [`memberName`](paramref) unchanged.
    internal func GetMetadataName(memberName string, target TypeSymbol?) string {
        if target == nil {
            return memberName
        }
        if target is InterfaceSymbol sourceInterface {
            return if string.IsNullOrEmpty(sourceInterface.PackageName) {
                "${sourceInterface.Name}.$memberName"
            } else {
                "${sourceInterface.PackageName}.${sourceInterface.Name}.$memberName"
            }
        }
        let interfaceName string? = if target is ImportedTypeSymbol imported && imported.OpenDefinition != nil {
            imported.OpenDefinition.FullName
        } else {
            target.ClrType?.FullName
        }
        return "${interfaceName ?? target.Name}.$memberName"
    }
}
