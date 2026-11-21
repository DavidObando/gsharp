// <copyright file="Binder.Speculation.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable

/// The result of a speculative bind of one member body (ADR-0227 D4, issue #6128).
internal class SpeculativeBodyBind {
    internal init(reason string) {
        FallbackReason = reason
        OldDiagnostics = ImmutableArray[Diagnostic].Empty
        NewDiagnostics = ImmutableArray[Diagnostic].Empty
    }

    internal init(
        oldDiagnostics ImmutableArray[Diagnostic],
        newDiagnostics ImmutableArray[Diagnostic],
        newBody BoundBlockStatement
    ) {
        OldDiagnostics = oldDiagnostics
        NewDiagnostics = newDiagnostics
        NewBody = newBody
    }

    /// Gets the reason why the body cannot be checked on its own, or `null` when it can.
    prop FallbackReason string? {
        get;
    }

    /// Gets the diagnostics of the declared body, bound speculatively.
    prop OldDiagnostics ImmutableArray[Diagnostic] {
        get;
    }

    /// Gets the diagnostics of the replacement body.
    prop NewDiagnostics ImmutableArray[Diagnostic] {
        get;
    }

    /// Gets the lowered replacement body.
    prop NewBody BoundBlockStatement? {
        get;
    }
}

partial class Binder {
    shared {
        /// Binds the declared body of [`function`](paramref) and [`newBody`](paramref) in its place, each
        /// in a body pass of its own over [`globalScope`](paramref), for the body-local check of the
        /// diagnostic-delta gate (ADR-0227 D4, issue #6128). Neither pass changes the compilation that owns
        /// [`globalScope`](paramref): the synthesis registries are copies, and the edited body reaches the
        /// call-effect analysis through (cref:BindingServices.SpeculativeBodies), not through the symbol.
        /// @remarks The result has a (cref:SpeculativeBodyBind.FallbackReason) when the body can affect
        /// what another body or the declarations report: a call-effect summary that the edit changes or
        /// that sees a cycle, a reference to a struct member that the narrowing analysis scans for, a deferred
        /// LINQ call, an iterator, a comparer factory, a synthesized delegate or adapter, or a native protocol.
        /// @param globalScope The declarations of the compilation.
        /// @param references The references of the compilation.
        /// @param function The member whose body changes.
        /// @param owner The type whose body pass binds the member, or `null` for a top-level function.
        /// @param declaration The declaration of [`function`](paramref).
        /// @param newBody The replacement body, from the edited tree.
        /// @returns The diagnostics of both binds, or the reason to fall back.
        internal func BindSpeculativeFunctionBody(
            globalScope BoundGlobalScope,
            references ReferenceResolver?,
            function FunctionSymbol,
            owner StructSymbol?,
            declaration FunctionDeclarationSyntax,
            newBody BlockStatementSyntax
        ) SpeculativeBodyBind {
            let oldBody = declaration.Body
            if oldBody == nil {
                return SpeculativeBodyBind("the member has no body")
            }
            if ContainsCrossBodySyntax(oldBody) || ContainsCrossBodySyntax(newBody) {
                return SpeculativeBodyBind("the body has syntax that another body's analysis reads")
            }
            let oldPass = BindSpeculativePass(globalScope, references, function, owner, declaration, oldBody, nil)
            if oldPass.FallbackReason != nil {
                return SpeculativeBodyBind(oldPass.FallbackReason)
            }
            let replacement = Dictionary[FunctionDeclarationSyntax, BlockStatementSyntax](
                ReferenceEqualityComparer.Instance
            )
            replacement.Add(declaration, newBody)
            let newPass = BindSpeculativePass(
                globalScope,
                references,
                function,
                owner,
                declaration,
                newBody,
                replacement
            )
            if newPass.FallbackReason != nil {
                return SpeculativeBodyBind(newPass.FallbackReason)
            }
            if !SameSummary(oldPass.Direct!!, newPass.Direct!!) ||
                !SameSummary(oldPass.WithOverrides!!, newPass.WithOverrides!!) {
                return SpeculativeBodyBind("the edit changes the call-effect summary of the member")
            }
            // The narrowing of every caller reads the body for a proof that the member returns a non-nil
            // value. A value of a value type is never nil, so no caller asks.
            let statements = oldPass.Probe!!.statements
            if !function.Type.IsValueType {
                let oldProof = statements.ReturnsDefinitelyNonNullForSpeculation(function, oldBody)
                let newProof = statements.ReturnsDefinitelyNonNullForSpeculation(function, newBody)
                if oldProof != newProof {
                    return SpeculativeBodyBind("the edit changes whether the member provably returns a non-nil value")
                }
            }
            // The call-effect analysis of a callable field reads its initializer while no tree writes the
            // field's name.
            let written = HashSet[string](StringComparer.Ordinal)
            CollectIdentifierNames(oldBody, written)
            CollectIdentifierNames(newBody, written)
            for name in written {
                if !statements.IsCallableFieldNameForSpeculation(name) {
                    continue
                }
                let oldWrites = statements.WritesFieldNameForSpeculation(oldBody, name)
                let newWrites = statements.WritesFieldNameForSpeculation(newBody, name)
                if oldWrites != newWrites {
                    return SpeculativeBodyBind("the edit changes a write of the callable field name '${name}'")
                }
            }
            if function.ReceiverType is StructSymbol || function.StaticOwnerType is StructSymbol || owner != nil {
                // The narrowing analysis scans every member body of a struct for a reference to a member.
                let probe = oldPass.Probe!!
                let names = HashSet[string](StringComparer.Ordinal)
                CollectIdentifierNames(oldBody, names)
                CollectIdentifierNames(newBody, names)
                let byRef = function.ReturnRefKind != RefKind.None
                for name in names {
                    if probe.statements.TakesReferenceToNameForSpeculation(oldBody, name, byRef) !=
                    probe.statements.TakesReferenceToNameForSpeculation(newBody, name, byRef) {
                        return SpeculativeBodyBind("the edit changes a reference to the member '${name}'")
                    }
                }
            }
            return SpeculativeBodyBind(oldPass.Diagnostics, newPass.Diagnostics, newPass.Body!!)
        }

        private func BindSpeculativePass(
            globalScope BoundGlobalScope,
            references ReferenceResolver?,
            function FunctionSymbol,
            owner StructSymbol?,
            declaration FunctionDeclarationSyntax,
            body BlockStatementSyntax,
            replacement Dictionary[FunctionDeclarationSyntax, BlockStatementSyntax]?
        ) SpeculativePass {
            let parentScope = CreateBodyPassScope(
                globalScope,
                references,
                default(BodyBindingOptions),
                recordedBodyDiagnostics: nil,
                speculative: true
            )
            RegisterNativeProtocolOperations(globalScope, parentScope)
            let registry = parentScope.GetStructuralAdapterRegistry()
            if registry.ProtocolOperations.Count > 0 || registry.HasNativeProtocolDeclarations {
                return SpeculativePass("the compilation sees native protocols")
            }
            parentScope.GetBindingServices().SpeculativeBodies = replacement
            if !object.ReferenceEquals(body.SyntaxTree, declaration.SyntaxTree) {
                parentScope.SetSpeculativeTreeAlias(body.SyntaxTree, declaration.SyntaxTree)
            }
            let adapterTypes = registry.Types.Count
            let adapterBodies = registry.MethodBodies.Count
            let adapterCounter = registry.Counter
            let anonymousTypes = parentScope.GetAnonymousTypeCache().Symbols.Count
            let richPlans = parentScope.GetRichAnonymousObjectPlans().Count
            let latestRichPlans = parentScope.GetLatestRichAnonymousObjectPlans().Count
            let previousPackage = parentScope.SetCurrentDeclaringPackage(owner?.PackageName ?? function.Package?.Name)
            let previousTree = parentScope.SetCurrentReferencingSyntaxTree(declaration.SyntaxTree)
            try {
                // The summary is computed before the bind, so the bind's own queries do not seed it.
                let probe = Binder(parentScope, function)
                for call in body.DescendantNodesAndSelf() {
                    if call is CallExpressionSyntax deferred &&
                        probe
                        .statements
                        .IsDeferredLinqOperatorNameForSpeculation(deferred.Identifier.ValueText) {
                        return SpeculativePass("the body calls a deferred LINQ operator")
                    }
                }
                let direct = probe.statements.GetFunctionEffectSummaryForSpeculation(
                    function,
                    includeOverrides: false,
                    out var directCycle
                )
                let withOverrides = Binder(parentScope, function).statements.GetFunctionEffectSummaryForSpeculation(
                    function,
                    includeOverrides: true,
                    out var overridesCycle
                )
                if directCycle || overridesCycle {
                    return SpeculativePass("the call-effect summary of the member has a cycle")
                }
                // A summary that depends on the root of its traversal (whether the root takes a sequence)
                // is not the member's own: a caller that takes a sequence sees other effects, and the full
                // pass caches the callees' summaries as its earlier roots saw them.
                let services = parentScope.GetBindingServices()
                if services.EnumerationEffectsDependOnRoot {
                    return SpeculativePass("a call-effect summary of the member depends on the caller")
                }
                // The traversal from this member caches the summaries of its callees as seen from it (a
                // callee's enumeration of a sequence can run a deferred callback only when the root takes a
                // sequence). The bind asks for each callee's summary as its own root, so it starts without
                // them.
                services.CachedCallEffectSummaries = nil
                services.CachedCallEffectSummariesWithOverrides = nil
                let allPathsReturnLocation = if function.Type != TypeSymbol.Void {
                    declaration.Identifier.Location
                } else {
                    default(TextLocation?)
                }
                let result = BindAndLowerMemberBody(
                    parentScope,
                    function,
                    body,
                    body,
                    owner,
                    allPathsReturnLocation,
                    convenienceConstructor: nil
                )
                if services.EnumerationEffectsDependOnRoot {
                    return SpeculativePass("a call-effect summary that the bind reads depends on the caller")
                }
                if (globalScope.RefDelegateCache is {} && parentScope.GetSynthesizedRefDelegateCache().WasQueried) ||
                    parentScope
                    .GetAnonymousTypeCache()
                    .Symbols
                    .Count != anonymousTypes ||
                    parentScope
                    .GetRichAnonymousObjectPlans().Count != richPlans || parentScope.GetLatestRichAnonymousObjectPlans()
                    .Count != latestRichPlans ||
                    registry
                    .Types
                    .Count != adapterTypes ||
                    registry
                    .MethodBodies
                    .Count != adapterBodies ||
                    registry.Counter != adapterCounter ||
                    registry
                    .ProtocolOperations
                    .Count > 0 {
                    return SpeculativePass("the body synthesizes a type that the pass shares")
                }
                return SpeculativePass(result.Body, result.Diagnostics, direct, withOverrides, probe)
            } finally {
                parentScope.SetCurrentReferencingSyntaxTree(previousTree)
                parentScope.SetCurrentDeclaringPackage(previousPackage)
            }
        }

        // Syntax that a whole-program scan of the binder reads from every body: iterators and comparer
        // factories feed the call-effect analysis of every lazy sequence and comparer, and an anonymous
        // object is declared by the declaration pass.
        private func ContainsCrossBodySyntax(body BlockStatementSyntax) bool {
            if ContainsSyntheticBodySideEffects(body) {
                return true
            }
            for node in body.DescendantNodesAndSelf() {
                switch node {
                    case YieldStatementSyntax {
                        return true
                    }
                    case AnonymousClassExpressionSyntax {
                        return true
                    }
                    case CallExpressionSyntax call when call.Identifier.ValueText == "Create" {
                        return true
                    }
                    default { }
                }
            }
            return false
        }

        private func CollectIdentifierNames(node SyntaxNode, names HashSet[string]) {
            for token in node.DescendantTokens() {
                if token.Kind == SyntaxKind.IdentifierToken {
                    names.Add(token.ValueText)
                }
            }
        }

        private func SameSummary(left CallEffectSummary, right CallEffectSummary) bool {
            if left.WritesAnyStorage != right.WritesAnyStorage ||
                left.InvokesCallbackParameter != right.InvokesCallbackParameter {
                return false
            }
            return SameTypes(left.WrittenFieldTypes, right.WrittenFieldTypes) &&
                SameTypes(left.WrittenElementTypes, right.WrittenElementTypes)
        }

        private func SameTypes(left List[TypeSymbol], right List[TypeSymbol]) bool {
            if left.Count != right.Count {
                return false
            }
            for type in left {
                var found = false
                for other in right {
                    if object.Equals(type, other) {
                        found = true
                        break
                    }
                }
                if !found {
                    return false
                }
            }
            return true
        }
    }

    private class SpeculativePass {
        init(reason string) {
            FallbackReason = reason
            Diagnostics = ImmutableArray[Diagnostic].Empty
        }

        init(
            body BoundBlockStatement,
            diagnostics ImmutableArray[Diagnostic],
            direct CallEffectSummary,
            withOverrides CallEffectSummary,
            probe Binder
        ) {
            Body = body
            Diagnostics = diagnostics
            Direct = direct
            WithOverrides = withOverrides
            Probe = probe
        }

        prop FallbackReason string? {
            get;
        }

        prop Body BoundBlockStatement? {
            get;
        }

        prop Diagnostics ImmutableArray[Diagnostic] {
            get;
        }

        prop Direct CallEffectSummary? {
            get;
        }

        prop WithOverrides CallEffectSummary? {
            get;
        }

        prop Probe Binder? {
            get;
        }
    }
}
