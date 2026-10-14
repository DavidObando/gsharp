// <copyright file="ClosureCaptureLegalityChecker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable

/// PR #4273 (Copilot review, on the fix for issue #4271): the single
/// legality check that decides whether a captured variable may be hoisted
/// into a heap-allocated closure environment at all. Originally inline (and
/// duplicated) at (cref:LambdaBinder)'s two function-literal capture
/// call sites; extracted here so (cref:LambdaBinder) and the
/// `go`-statement closure path (`StatementBinder.BindGoStatement`)
/// apply the exact same rules — the review's own request ("apply the same
/// capture-legality validation to `BoundGoStatement` closures, ideally
/// through a shared validator").
/// @remarks Every rejection here shares the same root cause: the CLR gives no way to
/// keep a managed pointer, a `ref struct`, or an unmanaged `fixed`
/// pointer alive inside a heap-allocated (or, for `go`, thread-pool-
/// scheduled) display class once the capturing closure may run after the
/// enclosing statement/call returns.
internal shared class ClosureCaptureLegalityChecker {
    /// Reports a diagnostic for every variable in [`captured`](paramref)
    /// whose capture would be unsound — a `ref struct` (GS0219-adjacent
    /// (cref:DiagnosticBag.ReportByRefLikeEscape)), a managed pointer
    /// ((cref:DiagnosticBag.ReportByRefCannotEscape)), a `fixed`
    /// pointer (GS9008), a `ref`/`out`/`in` PARAMETER (GS9010,
    /// issue #4259), or a `ref`/`var ref` LOCAL alias (GS9011,
    /// issue #4271). Ordinary (non-ref, non-pointer) captures are left alone.
    /// @param captured The closure's captured-variable set.
    /// @param diagnostics The bag to report into.
    /// @param location The text location of the capturing closure (or, for a `go` statement, its goroutine
    /// expression).
    func CheckCapturedVariables(
        captured ImmutableArray[VariableSymbol],
        diagnostics DiagnosticBag,
        location TextLocation
    ) {
        for capturedVariable in captured {
            if ManagedReferenceOrigins.IsScopedHandle(capturedVariable) {
                diagnostics.ReportManagedReference(location, "a scoped managed-reference value cannot be captured")
            } else if TypeSymbol.IsByRefLike(capturedVariable.Type) {
                diagnostics.ReportByRefLikeEscape(
                    location,
                    capturedVariable.Type,
                    "be captured by a closure (variable '${capturedVariable.Name}')"
                )
            } else if capturedVariable.Type is ByRefTypeSymbol {
                diagnostics.ReportByRefCannotEscape(
                    location,
                    "managed pointer '${capturedVariable.Name}' cannot be captured by a closure; the closure may outlive the pointed-to variable"
                )
            } else if capturedVariable.Type is PointerTypeSymbol {
                diagnostics.ReportFixedPointerCannotEscape(location, capturedVariable.Name)
            } else if capturedVariable is ParameterSymbol{
                RefKind: RefKind.Ref or RefKind.Out or RefKind.In
            } refParameter {
                diagnostics.ReportRefParameterCannotBeCaptured(
                    location,
                    refParameter.Name,
                    RefKindKeyword(refParameter.RefKind)
                )
            } else if capturedVariable is LocalVariableSymbol{RefKind: not RefKind.None} refLocal {
                diagnostics.ReportRefLocalAliasCannotBeCaptured(location, refLocal.Name)
            }
        }
    }

    /// Issue #4259: human-readable keyword for a captured-parameter diagnostic.
    private func RefKindKeyword(kind RefKind) string -> switch kind {
        case RefKind.Ref: "ref"
        case RefKind.Out: "out"
        case RefKind.In: "in"
        default: "ref"
    }
}
