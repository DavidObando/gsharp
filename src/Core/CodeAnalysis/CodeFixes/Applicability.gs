// <copyright file="Applicability.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

/// How safely a host can apply a (cref:CodeFix) (ADR-0227 D5). The order is from the most to the
/// least safe, so a host compares values to filter fixes.
enum Applicability {
    /// The fix is correct for every input that its guard accepts. A host can apply it unattended.
    MachineApplicable,

    /// The fix is probably what the user wants, but it can be wrong or change behavior. A person
    /// must review it.
    MaybeIncorrect,

    /// The fix contains placeholder text that the user must replace. A host never applies it
    /// unattended.
    HasPlaceholders,

    /// The provider does not know. Hosts treat it as (cref:MaybeIncorrect).
    Unspecified
}
