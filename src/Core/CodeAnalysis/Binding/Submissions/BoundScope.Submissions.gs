// <copyright file="BoundScope.Submissions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

/// Interactive-submission scope state on (cref:BoundScope) (ADR-0156 Phase 2, ADR-0212 slice S8).
partial class BoundScope {
    // Registered on the root scope of an interactive submission's scope chain.
    private var submissionImports SubmissionImports?
    private var submissionOptions SubmissionBindingOptions?

    /// Gets the interactive submission import set (ADR-0156 Phase 2) visible
    /// from this scope, walking the parent chain to the root scope it was
    /// registered on; `null` for ordinary compilations.
    prop SubmissionImports SubmissionImports? -> submissionImports ?? Parent?.SubmissionImports

    /// Gets the interactive submission options registered on this scope chain; `null` for ordinary compilations.
    internal prop SubmissionOptions SubmissionBindingOptions? -> submissionOptions ?? Parent?.SubmissionOptions

    /// Registers the interactive submission import set (ADR-0156 Phase 2) on
    /// this (root) scope; exposed to child scopes via (cref:SubmissionImports).
    /// @param imports The submission import set; may be `null`.
    internal func SetSubmissionImports(imports SubmissionImports?) -> submissionImports = imports

    /// Registers the interactive submission options on this (root) scope.
    /// @param options The submission options; may be `null`.
    internal func SetSubmissionOptions(options SubmissionBindingOptions?) -> submissionOptions = options
}
