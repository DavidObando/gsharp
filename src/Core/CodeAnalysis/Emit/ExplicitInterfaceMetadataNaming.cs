// <copyright file="ExplicitInterfaceMetadataNaming.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// ADR-0148: an explicit-interface qualifier clause (<c>func (IFoo) M(...)</c>
/// / <c>prop (IFoo) P T</c>) keeps its declared, source-visible name plain —
/// diagnostics, reflection <c>Name</c> lookups by the ordinary member name,
/// and hand-authored G# source never see anything but <c>M</c> / <c>P</c>.
/// But the CLR metadata name of the emitted MethodDef/PropertyDef row (and,
/// for a property, its <c>get_</c>/<c>set_</c> accessor MethodDefs) DOES need
/// to be collision-free: two explicit implementations of DIFFERENT interfaces
/// that share a member name (the entire point of the feature) would otherwise
/// emit two MethodDefs with the identical name and signature in the same
/// type — legal at the raw metadata level, but indistinguishable to
/// reflection APIs that look a member up by name (and needlessly fragile).
/// This helper synthesizes a qualified, C#-explicit-impl-style metadata name
/// (<c>Interface.Member</c>, or <c>Package.Interface.Member</c> when the
/// interface has a package/namespace) that is unique per (interface, member)
/// slot — the same uniqueness key <see cref="DiagnosticBag.ReportDuplicateExplicitInterfaceImplementation"/>
/// (GS0491) already enforces at the source level, so within a single valid
/// compilation this synthesized name can never collide with another such
/// synthesized name, nor (since it always contains at least one <c>.</c>,
/// which no plain G# identifier can contain) with any ordinary member's name.
/// </summary>
internal static class ExplicitInterfaceMetadataNaming
{
    /// <summary>
    /// Returns the collision-free CLR metadata name for a member explicitly
    /// implementing <paramref name="target"/>'s <paramref name="memberName"/>
    /// member, or <paramref name="memberName"/> itself unchanged when
    /// <paramref name="target"/> is <see langword="null"/> (not an explicit
    /// implementation, or not yet resolved — the latter only for a program
    /// that already has a GS0488/GS0489 error and will not reach emit).
    /// </summary>
    /// <param name="memberName">The declared (plain, source-visible) member name.</param>
    /// <param name="target">The resolved explicit-interface clause target, or <see langword="null"/>.</param>
    /// <returns>A collision-free metadata name, or <paramref name="memberName"/> unchanged.</returns>
    internal static string GetMetadataName(string memberName, InterfaceSymbol target)
    {
        if (target == null)
        {
            return memberName;
        }

        return string.IsNullOrEmpty(target.PackageName)
            ? $"{target.Name}.{memberName}"
            : $"{target.PackageName}.{target.Name}.{memberName}";
    }
}
