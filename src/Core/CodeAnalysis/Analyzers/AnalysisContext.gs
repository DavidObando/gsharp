// <copyright file="AnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System

/// The registration surface passed to
/// (cref:GSharpDiagnosticAnalyzer.Initialize). Mirrors Roslyn's
/// `AnalysisContext` (ADR-0169); registrations are scoped to the current
/// driver run.
open class AnalysisContext {
    private let registry AnalyzerRegistry
    private let owner GSharpDiagnosticAnalyzer

    internal init(registry AnalyzerRegistry, owner GSharpDiagnosticAnalyzer) {
        this.registry = registry
        this.owner = owner
    }

    internal prop Registry AnalyzerRegistry -> registry
    internal prop Owner GSharpDiagnosticAnalyzer -> owner

    /// Registers a callback for syntax nodes of the given kinds.
    /// @param action The callback.
    /// @param syntaxKinds The node kinds to dispatch on.
    func RegisterSyntaxNodeAction(
        action(SyntaxNodeAnalysisContext) -> void,
        syntaxKinds ...SyntaxKind
    ) -> registry.AddKeyed(registry.SyntaxNodeActions, owner, action, syntaxKinds)

    /// Registers a callback for declared symbols of the given kinds.
    /// @param action The callback.
    /// @param symbolKinds The symbol kinds to dispatch on.
    func RegisterSymbolAction(action(SymbolAnalysisContext) -> void, symbolKinds ...SymbolKind) -> registry.AddKeyed(
        registry.SymbolActions,
        owner,
        action,
        symbolKinds
    )

    /// Registers a callback for bound nodes of the given kinds — the
    /// counterpart of Roslyn's `RegisterOperationAction` (ADR-0169;
    /// bound-node member shapes are stable at the kind level only).
    /// @param action The callback.
    /// @param boundNodeKinds The bound-node kinds to dispatch on.
    func RegisterBoundNodeAction(
        action(BoundNodeAnalysisContext) -> void,
        boundNodeKinds ...BoundNodeKind
    ) -> registry.AddKeyed(registry.BoundNodeActions, owner, action, boundNodeKinds)

    /// Registers a callback invoked once per declared function body with the
    /// whole bound body — the counterpart of Roslyn's
    /// `RegisterOperationBlockAction` (ADR-0169, issue #4436).
    /// @param action The callback.
    func RegisterBoundBodyAction(action(BoundBodyAnalysisContext) -> void) -> registry.BoundBodyActions.Add(
        AnalyzerActionEntry[BoundBodyAnalysisContext](owner, action)
    )

    /// Registers a callback invoked once per syntax tree, before binding-time
    /// actions.
    /// @param action The callback.
    func RegisterSyntaxTreeAction(action(SyntaxTreeAnalysisContext) -> void) -> registry.SyntaxTreeActions.Add(
        AnalyzerActionEntry[SyntaxTreeAnalysisContext](owner, action)
    )

    /// Registers a callback invoked once per syntax tree after binding, with
    /// the tree's (cref:SemanticModel).
    /// @param action The callback.
    func RegisterSemanticModelAction(action(SemanticModelAnalysisContext) -> void) -> registry.SemanticModelActions.Add(
        AnalyzerActionEntry[SemanticModelAnalysisContext](owner, action)
    )

    /// Registers a callback invoked at the start of the compilation pass,
    /// which may register further actions (including compilation-end
    /// actions) sharing state.
    /// @param action The callback.
    func RegisterCompilationStartAction(action(CompilationStartAnalysisContext) -> void) -> registry
        .CompilationStartActions
        .Add(AnalyzerActionEntry[CompilationStartAnalysisContext](owner, action))

    /// Registers a callback invoked once after all other actions have run.
    /// @param action The callback.
    func RegisterCompilationAction(action(CompilationAnalysisContext) -> void) -> registry.CompilationActions.Add(
        AnalyzerActionEntry[CompilationAnalysisContext](owner, action)
    )

    /// Recorded no-op: the driver is sequential in v1 (ADR-0169). Present so
    /// mechanically translated Roslyn analyzers compile unchanged.
    func EnableConcurrentExecution() { }

    /// Configures whether this analyzer runs on generated (`.g.gs`)
    /// trees. Defaults to (cref:GeneratedCodeAnalysisFlags.None).
    /// @param flags The generated-code analysis mode.
    func ConfigureGeneratedCodeAnalysis(flags GeneratedCodeAnalysisFlags) -> registry.GeneratedCodeFlags[owner] = flags
}
