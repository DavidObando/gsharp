// <copyright file="DiagnosticDescriptors.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.InternalAnalyzers

import GSharp.Core.CodeAnalysis

/// Diagnostic descriptors for G# internal source analyzers.
shared class DiagnosticDescriptors {
    /// Reports Emit-layer symbol-keyed metadata-reference caches whose key
    /// omits the generic-remap scope.
    let EmitCacheKeyMissingRemapScope DiagnosticDescriptor = DiagnosticDescriptor(
        "GSA0004",
        "Include RemapScope in Emit-layer symbol-keyed metadata caches",
        "Emit cache '{0}' maps symbols to scope-sensitive metadata rows but its key does not include RemapScope",
        "GSharp.InternalAnalyzers",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "The same symbol encodes to different VAR/MVAR ordinals under different active generic remaps, so a TypeSpec/MemberRef/MethodSpec cache keyed on symbols without the RemapScope reuses rows across scopes and emits an invalid assembly (issues #2930, #3057, #3065; invariant #3163)."
    )

    /// Reports a `BoundTreeRewriter` override that reconstructs its node
    /// while reading fewer of the node's members than the base rewriter does.
    let RewriterCloneDropsMember DiagnosticDescriptor = DiagnosticDescriptor(
        "GSA0005",
        "Preserve every member the base rewriter preserves when cloning a bound node",
        "'{0}' rebuilds {1} but never reads node.{2}, which BoundTreeRewriter.{3} preserves",
        "GSharp.InternalAnalyzers",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Bound nodes are discriminated unions over their constructors, so a member one constructor omits is silently lost when a rewriter rebuilds the node through the wrong one. The base BoundTreeRewriter branches on the discriminator; an override that does not drops it and mis-codegens (issues #1644, #3333)."
    )

    /// Reports a loop that walks `StructSymbol.BaseClass` by hand
    /// instead of through the guarded `GetHierarchy()` helper.
    let UnguardedBaseClassWalk DiagnosticDescriptor = DiagnosticDescriptor(
        "GSA0006",
        "Walk StructSymbol.BaseClass through GetHierarchy() instead of by hand",
        "'{0}' is reassigned from '{0}.BaseClass' inside a loop; call GetHierarchy() instead so a base-class cycle cannot hang or exhaust memory",
        "GSharp.InternalAnalyzers",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "A genuine base-class cycle (`class B : C` / `class C : B`) is normally caught by the post-bind cycle detector (issue #973), but any loop that re-walks the symbol-level BaseClass chain by hand runs before that detector on every struct's declaration body, and will spin or OOM if it lacks its own cycle guard. This recurred at least six times (issues #4162 and #4164's five call sites) as independent, unguarded copies of the same loop shape. StructSymbol.GetHierarchy() is the single already-guarded walk; every caller should go through it instead of re-deriving its own guard."
    )

    /// ADR-0193 §3: reports a call to a CLR-type-to-symbol conversion door
    /// outside a `[NullabilityFunnel]` member, a nullability-free
    /// conversion of a signature position, or a direct wrapper-factory call
    /// inside a funnel walker.
    let NullabilityFunnelBypass DiagnosticDescriptor = DiagnosticDescriptor(
        "GSA0007",
        "Route CLR type conversions through the nullability funnel",
        "{0}",
        "GSharp.InternalAnalyzers",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Every Core path from a CLR Type (or its nullability metadata) to a TypeSymbol is a conversion door. Outside the members declared [NullabilityFunnel], a signature position must be read through the funnel readers (ClrNullability.Get*TypeSymbol, MemberLookup.GetClr*TypeSymbol), which merge declaration nullability; a type with no declaration nullability to lose goes through TypeSymbol.FromClrTypeWithoutNullability with a stated NullabilityFreeReason. Two independent paths computing one position's nullability is the most recurring defect class of the ADR-0186 work (ADR-0193, issue #4363)."
    )
}
