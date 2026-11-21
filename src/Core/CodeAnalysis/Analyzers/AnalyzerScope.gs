// <copyright file="AnalyzerScope.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import System

/// What the diagnostics of an analyzer depend on (ADR-0227 D4, issue #6165). An analyzer declares it
/// with (cref:AnalysisContext.ConfigureScope(AnalyzerScope)); the default is
/// (cref:AnalyzerScope.Compilation).
enum AnalyzerScope {
    /// The analyzer can read anything in the compilation. A diagnostic-delta check that runs it binds
    /// the whole compilation after the edit.
    Compilation,

    /// The analyzer registers only bound-node and bound-body actions, and what it reports from the
    /// actions on one function body depends only on that body and the compilation's declarations, not
    /// on another body. Its messages and properties do not depend on where the body sits in the file:
    /// a diagnostic of another body keeps its message when an edit before it moves its span. A
    /// diagnostic-delta check of an edit inside one body runs it on the edited body alone and keeps its
    /// earlier results for the other bodies. An analyzer that declares this scope and registers another
    /// kind of action counts as (cref:AnalyzerScope.Compilation).
    MemberBody
}
