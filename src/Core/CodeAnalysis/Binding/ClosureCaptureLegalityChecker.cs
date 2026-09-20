// <copyright file="ClosureCaptureLegalityChecker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// PR #4273 (Copilot review, on the fix for issue #4271): the single
/// legality check that decides whether a captured variable may be hoisted
/// into a heap-allocated closure environment at all. Originally inline (and
/// duplicated) at <see cref="LambdaBinder"/>'s two function-literal capture
/// call sites; extracted here so <see cref="LambdaBinder"/> and the
/// <c>go</c>-statement closure path (<c>StatementBinder.BindGoStatement</c>)
/// apply the exact same rules — the review's own request ("apply the same
/// capture-legality validation to <c>BoundGoStatement</c> closures, ideally
/// through a shared validator").
/// </summary>
/// <remarks>
/// Every rejection here shares the same root cause: the CLR gives no way to
/// keep a managed pointer, a <c>ref struct</c>, or an unmanaged <c>fixed</c>
/// pointer alive inside a heap-allocated (or, for <c>go</c>, thread-pool-
/// scheduled) display class once the capturing closure may run after the
/// enclosing statement/call returns.
/// </remarks>
internal static class ClosureCaptureLegalityChecker
{
    /// <summary>
    /// Reports a diagnostic for every variable in <paramref name="captured"/>
    /// whose capture would be unsound — a <c>ref struct</c> (GS0219-adjacent
    /// <see cref="DiagnosticBag.ReportByRefLikeEscape"/>), a managed pointer
    /// (<see cref="DiagnosticBag.ReportByRefCannotEscape"/>), a <c>fixed</c>
    /// pointer (GS9008), a <c>ref</c>/<c>out</c>/<c>in</c> PARAMETER (GS9010,
    /// issue #4259), or a <c>ref</c>/<c>var ref</c> LOCAL alias (GS9011,
    /// issue #4271). Ordinary (non-ref, non-pointer) captures are left alone.
    /// </summary>
    /// <param name="captured">The closure's captured-variable set.</param>
    /// <param name="diagnostics">The bag to report into.</param>
    /// <param name="location">The text location of the capturing closure (or, for a <c>go</c> statement, its goroutine expression).</param>
    public static void CheckCapturedVariables(
        ImmutableArray<VariableSymbol> captured,
        DiagnosticBag diagnostics,
        TextLocation location)
    {
        foreach (var capturedVariable in captured)
        {
            if (ManagedReferenceOrigins.IsScopedHandle(capturedVariable))
            {
                diagnostics.ReportManagedReference(location, "a scoped managed-reference value cannot be captured");
            }
            else if (TypeSymbol.IsByRefLike(capturedVariable.Type))
            {
                diagnostics.ReportByRefLikeEscape(location, capturedVariable.Type, $"be captured by a closure (variable '{capturedVariable.Name}')");
            }
            else if (capturedVariable.Type is ByRefTypeSymbol)
            {
                diagnostics.ReportByRefCannotEscape(
                    location,
                    $"managed pointer '{capturedVariable.Name}' cannot be captured by a closure; the closure may outlive the pointed-to variable");
            }
            else if (capturedVariable.Type is PointerTypeSymbol)
            {
                diagnostics.ReportFixedPointerCannotEscape(location, capturedVariable.Name);
            }
            else if (capturedVariable is ParameterSymbol { RefKind: RefKind.Ref or RefKind.Out or RefKind.In } refParameter)
            {
                diagnostics.ReportRefParameterCannotBeCaptured(location, refParameter.Name, RefKindKeyword(refParameter.RefKind));
            }
            else if (capturedVariable is LocalVariableSymbol { RefKind: not RefKind.None } refLocal)
            {
                diagnostics.ReportRefLocalAliasCannotBeCaptured(location, refLocal.Name);
            }
        }
    }

    /// <summary>Issue #4259: human-readable keyword for a captured-parameter diagnostic.</summary>
    private static string RefKindKeyword(RefKind kind) => kind switch
    {
        RefKind.Ref => "ref",
        RefKind.Out => "out",
        RefKind.In => "in",
        _ => "ref",
    };
}
