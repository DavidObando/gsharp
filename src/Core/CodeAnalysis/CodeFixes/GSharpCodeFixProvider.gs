// <copyright file="GSharpCodeFixProvider.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import System.Collections.Immutable

/// Base class for G# code-fix providers (ADR-0227 D2). The counterpart of Roslyn's
/// `CodeFixProvider`. A provider names the diagnostic IDs that it fixes and registers fixes for
/// one diagnostic at a time. A provider in an analyzer assembly also carries
/// (cref:GSharpCodeFixProviderAttribute) and has a parameterless constructor.
abstract class GSharpCodeFixProvider {
    /// Gets the IDs of the diagnostics that this provider can fix. It must not be empty.
    abstract prop FixableDiagnosticIds ImmutableArray[string] {
        get;
    }

    /// Gets the stable name of the provider. The default is the full name of the type.
    open prop Id string -> GetType().FullName ?? GetType().Name

    /// Registers the fixes for (cref:CodeFixContext.Diagnostic). The method must be deterministic
    /// and must not change the compilation.
    /// @param context The diagnostic, the tree, the compilation and the registration surface.
    open func RegisterCodeFixes(context CodeFixContext);
    /// Gets a value that tells whether FixAll can apply the fixes of this provider (ADR-0227 D3).
    /// The default is `true`: the batch fixer computes each fix against the original snapshot and
    /// keeps the fixes that do not overlap. A provider whose fixes depend on each other returns `false`.
    open prop SupportsFixAll bool -> true

    /// Gets a value that tells whether the fixes of this provider come from data, such as mined
    /// transformation programs, rather than hand-written code (ADR-0227 D6). A host runs the full
    /// delta gate on these fixes (decision Q4).
    open prop IsDataDefined bool -> false
}
