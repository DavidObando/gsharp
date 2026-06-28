#nullable disable

// <copyright file="AccessibilityChecker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Issue #950: bind-time accessibility checks for the <c>protected</c>
/// modifier. A <c>protected</c> member is accessible within its declaring type
/// and within the bodies of types that derive from the declaring type; it is
/// inaccessible from unrelated external code (e.g. the synthetic
/// <c>&lt;Program&gt;</c> host or a sibling type).
/// <para>
/// Unlike <c>private</c>/<c>internal</c> — which G# leaves to the CLR to
/// enforce at runtime via the emitted IL accessibility — <c>protected</c> adds
/// a compile-time check so that external access is reported as a clean
/// diagnostic (GS0379) rather than surfacing only as a runtime
/// <see cref="System.MethodAccessException"/>/<see cref="System.FieldAccessException"/>.
/// The emitted IL still carries CIL <c>family</c> accessibility, so the CLR
/// independently enforces the same rule.
/// </para>
/// </summary>
internal static class AccessibilityChecker
{
    /// <summary>
    /// Returns <see langword="true"/> when a member declared on
    /// <paramref name="declaringType"/> with the given
    /// <paramref name="accessibility"/> is accessible from the body of
    /// <paramref name="currentFunction"/>. Only the <c>protected</c> case is
    /// enforced here; every other accessibility is treated as accessible (G#
    /// defers private/internal enforcement to the CLR).
    /// </summary>
    /// <param name="accessibility">The accessed member's accessibility.</param>
    /// <param name="declaringType">The type that declares the member.</param>
    /// <param name="currentFunction">The function whose body contains the access (may be <see langword="null"/> for top-level code).</param>
    /// <returns><see langword="true"/> when the access is permitted.</returns>
    public static bool IsAccessible(Accessibility accessibility, StructSymbol declaringType, FunctionSymbol currentFunction)
    {
        if (accessibility != Accessibility.Protected || declaringType == null)
        {
            return true;
        }

        var enclosingType = (currentFunction?.ReceiverType as StructSymbol)
            ?? (currentFunction?.StaticOwnerType as StructSymbol);

        for (var t = enclosingType; t != null; t = t.BaseClass)
        {
            if (SameDeclaringType(t, declaringType))
            {
                return true;
            }
        }

        return false;
    }

    private static bool SameDeclaringType(StructSymbol a, StructSymbol b)
    {
        if (ReferenceEquals(a, b))
        {
            return true;
        }

        // Symbols are normally canonical (one instance per declared type), but
        // guard against constructed/projected duplicates by comparing the
        // declaration identity and qualified name as a fallback.
        if (a.Declaration != null && ReferenceEquals(a.Declaration, b.Declaration))
        {
            return true;
        }

        return string.Equals(a.Name, b.Name, System.StringComparison.Ordinal)
            && string.Equals(a.PackageName, b.PackageName, System.StringComparison.Ordinal);
    }
}
