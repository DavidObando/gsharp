// <copyright file="BodyLocalDelta.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Binding.Suspension
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Threading

/// The body-local check of the diagnostic-delta gate (ADR-0227 D4, issue #6128): when an edit is
/// confined to one function body, bind that body against the compilation's declarations instead of
/// binding a new compilation, and assemble the diagnostics that the full check would read.
/// @remarks The diagnostics after the edit are the compilation's diagnostics with the edited body's
/// diagnostics replaced: the parse diagnostics of the new trees, the declaration diagnostics, the body
/// diagnostics of every other member, the body diagnostics of the new body, and the documentation
/// diagnostics when no error is left. A diagnostic outside the body moves with the text before it.
///
/// The result equals the full check's. The check returns `null`, and the caller binds the whole
/// compilation, whenever that is not shown:
///
/// - the edit is not inside the braces of one function or method body, or the tree changes outside it;
/// - the member is not a top-level function or a struct or class method, is generic in a way that gives
///   it two symbols, is a P/Invoke stub, or is specialized for nullable sequences;
/// - the compilation is a prefix bind, a submission, or has no published declarations or bodies;
/// - the declared body, bound again in a speculative pass, does not report exactly the diagnostics that
///   the compilation's bind reported for it, so the pass is not the compilation's pass;
/// - the body can change another body's analysis or the declarations (see
///   (cref:Binder.BindSpeculativeFunctionBody(BoundGlobalScope, ReferenceResolver?, FunctionSymbol,
///   StructSymbol?, FunctionDeclarationSyntax, BlockStatementSyntax)));
/// - the member suspends or is async, either body names a function that suspends, has a suspension point
///   or calls a suspending function, so the suspension inference can change or the bind meets its marks;
/// - a whole-program analysis (managed references, ref-struct liveness, rendezvous batches) reports on
///   either body;
/// - a diagnostic outside the body touches a changed span.
internal shared class BodyLocalDelta {
    /// Assembles the diagnostics after the edit, before the host's filter, or gives the reason why it cannot.
    func TryCollect(
        compilation Compilation,
        snapshot Compilation,
        oldTree SyntaxTree,
        newTree SyntaxTree,
        changes ImmutableArray[TextChange],
        cancellationToken CancellationToken
    ) BodyLocalResult {
        if compilation.Submission != nil || compilation.FindPrefixCut() != nil {
            return BodyLocalResult("the compilation is a submission or a prefix bind")
        }
        if !BodyEditLocator.TryLocate(oldTree, newTree, changes, out var oldDeclaration, out var newDeclaration) {
            return BodyLocalResult("the edit is not confined to one function body")
        }
        let declarations = compilation.PublishedGlobalScope
        let program = compilation.PublishedBoundProgram
        if declarations == nil || program == nil || program.BodyDiagnostics == nil || declarations.Previous != nil ||
            declarations.HasNativeProtocols {
            return BodyLocalResult("the compilation has no published body pass")
        }
        if !compilation.TryEnterBuildGate(cancellationToken) {
            return BodyLocalResult("the compilation cannot build")
        }
        try {
            return Collect(
                compilation,
                snapshot,
                declarations,
                program,
                oldTree,
                newTree,
                oldDeclaration!!,
                newDeclaration!!,
                changes,
                cancellationToken
            )
        } finally {
            compilation.ExitBuildGate()
        }
    }

    private func Collect(
        compilation Compilation,
        snapshot Compilation,
        declarations BoundGlobalScope,
        program BoundProgram,
        oldTree SyntaxTree,
        newTree SyntaxTree,
        oldDeclaration FunctionDeclarationSyntax,
        newDeclaration FunctionDeclarationSyntax,
        changes ImmutableArray[TextChange],
        cancellationToken CancellationToken
    ) BodyLocalResult {
        var function FunctionSymbol? = nil
        var owner StructSymbol? = nil
        var count = 0
        for candidate in declarations.Functions {
            if object.ReferenceEquals(candidate.Declaration, oldDeclaration) {
                function = candidate
                count++
            }
        }
        for type in declarations.Structs {
            for candidate in NonDefault(type.Methods).AddRange(NonDefault(type.StaticMethods)) {
                if !candidate.IsExtension && object.ReferenceEquals(candidate.Declaration, oldDeclaration) {
                    function = candidate
                    owner = type
                    count++
                }
            }
        }
        for type in declarations.Interfaces {
            for candidate in NonDefault(type.Methods)
                .AddRange(NonDefault(type.StaticMethods))
                .AddRange(NonDefault(type.PrivateMethods))
                .AddRange(NonDefault(type.StaticPrivateMethods)) {
                if object.ReferenceEquals(candidate?.Declaration, oldDeclaration) {
                    count++
                }
            }
        }
        if count != 1 || function == nil {
            return BodyLocalResult("the body is not the body of one function or method")
        }
        if function.IsPInvoke || function.NullableSequenceSpecialization != NullableSequenceSpecializationKind.None ||
            function.IsReturnTypeInferred {
            return BodyLocalResult("the member is a P/Invoke stub, a nullable-sequence specialization or has an inferred return type")
        }
        if owner != nil && declarations.LatestRichAnonymousObjectPlans.ContainsKey(owner) {
            return BodyLocalResult("the member belongs to a rich anonymous type")
        }
        if !program.BodyDiagnostics!!.TryGetValue(function, out var recorded) || recorded.IsDefault ||
            !program.Functions.TryGetValue(function, out var oldBound) {
            return BodyLocalResult("the compilation recorded no single body bind of the member")
        }
        // The suspension inference marks functions after every body is bound, and the speculative bind
        // sees those marks. A body that names no suspending function never meets one; a body without
        // a suspension point leaves the inference as it was.
        if function.IsSuspending || function.IsAsync {
            return BodyLocalResult("the member suspends or is async")
        }
        let suspending = HashSet[string](StringComparer.Ordinal)
        for member in program.Functions.Keys {
            if member.IsSuspending {
                suspending.Add(member.Name)
            }
        }
        if suspending.Count > 0 && (NamesAny(oldDeclaration.Body!!, suspending) || NamesAny(newDeclaration.Body!!, suspending)) {
            return BodyLocalResult("a body names a suspending function")
        }
        cancellationToken.ThrowIfCancellationRequested()
        let speculative = BindSpeculatively(compilation, declarations, function, owner, oldDeclaration, newDeclaration)
        if speculative.FallbackReason != nil {
            return BodyLocalResult(speculative.FallbackReason)
        }
        // The speculative pass must be the compilation's pass: the declared body reports what it reported.
        if !SameOccurrences(speculative.OldDiagnostics, recorded) {
            return BodyLocalResult("the speculative bind of the declared body differs from the compilation's bind")
        }
        let newBound = speculative.NewBody!!
        if HasSuspensionFacts(oldBound) || HasSuspensionFacts(newBound) {
            return BodyLocalResult("a body has a suspension point or calls a suspending function")
        }
        if ReportsWholeProgramFindings(function, oldBound, compilation.References) || ReportsWholeProgramFindings(
            function,
            newBound,
            compilation.References
        ) {
            return BodyLocalResult("a whole-program analysis reports on a body")
        }
        cancellationToken.ThrowIfCancellationRequested()
        let spanMap = DocumentMap(newTree.Text, changes)
        let oldText = oldTree.Text
        // The declaration diagnostics: the parse of every tree, then the declarations.
        let declaration = List[Diagnostic]()
        for tree in snapshot.SyntaxTrees {
            declaration.AddRange(tree.Diagnostics)
        }
        for d in declarations.Diagnostics {
            if !TryRelocate(d, oldText, newTree.Text, spanMap, out var moved) {
                return BodyLocalResult("a declaration diagnostic touches the edit")
            }
            declaration.Add(moved!!)
        }
        // The body diagnostics: every occurrence that the member's bind reported is replaced.
        let remove = Dictionary[Diagnostic, int32](ReferenceEqualityComparer.Instance)
        for d in recorded {
            let _ = remove.TryGetValue(d, out var n)
            remove[d] = n + 1
        }
        let body = List[Diagnostic]()
        for d in program.Diagnostics {
            if remove.TryGetValue(d, out var left) && left > 0 {
                remove[d] = left - 1
                continue
            }
            if !TryRelocate(d, oldText, newTree.Text, spanMap, out var moved) {
                return BodyLocalResult("a body diagnostic outside the edited body touches the edit")
            }
            body.Add(moved!!)
        }
        for d in speculative.NewDiagnostics {
            // A diagnostic at the member's declaration names the old text.
            if !TryRelocate(d, oldText, newTree.Text, spanMap, out var moved) {
                return BodyLocalResult("a diagnostic of the new body touches the edit outside the new body")
            }
            body.Add(moved!!)
        }
        let declarationItems = snapshot.ApplySourceSuppressions(declaration.ToImmutableArray())
        let bodyItems = snapshot.ApplySourceSuppressions(body.ToImmutableArray())
        var items = declarationItems.AddRange(bodyItems)
        if !items.Any((d Diagnostic) -> d.IsError) {
            let documentation = List[Diagnostic]()
            for d in snapshot.GetDocumentationDiagnostics(program) {
                if !TryRelocate(d, oldText, newTree.Text, spanMap, out var moved) {
                    return BodyLocalResult("a documentation diagnostic touches the edit")
                }
                documentation.Add(moved!!)
            }
            items = items.AddRange(documentation)
        }
        return BodyLocalResult(items)
    }

    private func NonDefault(members ImmutableArray[FunctionSymbol]) ImmutableArray[FunctionSymbol] -> if members.IsDefault {
        ImmutableArray[FunctionSymbol].Empty
    } else {
        members
    }

    // Binds under the scopes of the compilation's body pass (Compilation.GetBoundProgram).
    private func BindSpeculatively(
        compilation Compilation,
        declarations BoundGlobalScope,
        function FunctionSymbol,
        owner StructSymbol?,
        oldDeclaration FunctionDeclarationSyntax,
        newDeclaration FunctionDeclarationSyntax
    ) SpeculativeBodyBind {
        using let nullabilityScope = NullabilityOptions.Enter(compilation.Nullability, compilation.PlatformNilChecks)
        using let recordingScope = CallCandidateRecorder.Enter(
            compilation.RecordMemberGroups,
            ConcurrentDictionary[SyntaxNode, BoundErrorExpression]()
        )
        using let prefixScope = PrefixBindingContext.Enter(nil)
        return Binder.BindSpeculativeFunctionBody(
            declarations,
            compilation.References,
            function,
            owner,
            oldDeclaration,
            newDeclaration.Body!!
        )
    }

    // Each diagnostic of one array matches one occurrence of the other: same object, or same location
    // text, span, ID, severity and message.
    private func SameOccurrences(left ImmutableArray[Diagnostic], right ImmutableArray[Diagnostic]) bool {
        if left.Length != right.Length {
            return false
        }
        let used = [right.Length]bool
        for d in left {
            var found = false
            for var i = 0; i < right.Length; i++ {
                let other = right[i]
                if !used[i] && object.ReferenceEquals(d.Location.Text, other.Location.Text) &&
                    d.Location.Span.Start == other.Location.Span.Start &&
                    d.Location.Span.Length == other.Location.Span.Length &&
                    d.Id == other.Id &&
                    d.Severity == other.Severity &&
                    d.Message == other.Message {
                    used[i] = true
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

    private func NamesAny(body SyntaxNode, names HashSet[string]) bool {
        for token in body.DescendantTokens() {
            if token.Kind == SyntaxKind.IdentifierToken && names.Contains(token.ValueText) {
                return true
            }
        }
        return false
    }

    private func HasSuspensionFacts(body BoundBlockStatement) bool {
        let facts = SuspensionPointCollector.Collect(body)
        if facts.HasDirectPoint {
            return true
        }
        for callee in facts.Callees {
            if callee.IsSuspending {
                return true
            }
        }
        return false
    }

    // The analyses that BindProgram runs over every body after the bind. Each looks at one body at a
    // time, so a body on which none reports leaves their findings on the other bodies as they were.
    private func ReportsWholeProgramFindings(
        function FunctionSymbol,
        body BoundBlockStatement,
        references ReferenceResolver?
    ) bool {
        let single = ImmutableDictionary.CreateBuilder[FunctionSymbol, BoundBlockStatement]()
        single.Add(function, body)
        let rendezvous = ImmutableArray.CreateBuilder[Diagnostic]()
        RendezvousBatchAnalyzer.Run(single, rendezvous)
        if rendezvous.Count > 0 {
            return true
        }
        let managed = DiagnosticBag()
        ManagedReferenceSafetyAnalyzer.Analyze(
            single,
            ImmutableArray[StructSymbol].Empty,
            ImmutableArray[InterfaceSymbol].Empty,
            managed
        )
        if managed.Count > 0 {
            return true
        }
        let liveness = DiagnosticBag()
        RefStructAsyncLivenessAnalyzer.Analyze(body.PreEmitAnalysisBody ?? body, function, liveness, references)
        return liveness.Count > 0
    }

    // Moves a diagnostic of the old text to the new text: its location, its additional locations and
    // the changes of its suggestions. It fails when one of them touches a change.
    private func TryRelocate(
        d Diagnostic,
        oldText SourceText,
        newText SourceText,
        spanMap DocumentMap,
        out moved Diagnostic?
    ) bool {
        moved = d
        var changed = false
        var location = d.Location
        if object.ReferenceEquals(location.Text, oldText) {
            if !spanMap.TryMapSpan(location.Span, out var span) {
                return false
            }
            location = TextLocation(newText, span)
            changed = true
        }
        let additional = ImmutableArray.CreateBuilder[TextLocation](d.AdditionalLocations.Length)
        for extra in d.AdditionalLocations {
            if object.ReferenceEquals(extra.Text, oldText) {
                if !spanMap.TryMapSpan(extra.Span, out var span) {
                    return false
                }
                additional.Add(TextLocation(newText, span))
                changed = true
            } else {
                additional.Add(extra)
            }
        }
        var suggestions = d.Suggestions
        if object.ReferenceEquals(d.Location.Text, oldText) && !d.Suggestions.IsDefaultOrEmpty {
            let builder = ImmutableArray.CreateBuilder[DiagnosticSuggestion](d.Suggestions.Length)
            for suggestion in d.Suggestions {
                let edits = ImmutableArray.CreateBuilder[TextChange](suggestion.Changes.Length)
                for edit in suggestion.Changes {
                    if !spanMap.TryMapSpan(edit.Span, out var span) {
                        return false
                    }
                    edits.Add(TextChange(span, edit.NewText))
                }
                builder.Add(
                    DiagnosticSuggestion(
                        suggestion.Message,
                        suggestion.EquivalenceKey,
                        suggestion.Applicability,
                        edits.ToImmutable()
                    )
                )
            }
            suggestions = builder.ToImmutable()
        }
        if changed {
            moved = d.WithLocations(location, additional.ToImmutable(), suggestions)
        }
        return true
    }
}

/// The diagnostics that the body-local check assembled, or the reason why it did not.
internal class BodyLocalResult {
    init(reason string) {
        Reason = reason
    }

    init(diagnostics ImmutableArray[Diagnostic]) {
        Diagnostics = diagnostics
        Succeeded = true
    }

    prop Succeeded bool {
        get;
    }

    prop Diagnostics ImmutableArray[Diagnostic] {
        get;
    }

    prop Reason string? {
        get;
    }
}
