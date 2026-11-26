// <copyright file="BodyLocalDelta.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
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
/// - a diagnostic outside the body touches a changed span;
/// - an analyzer runs that is not body-local in scope (cref:AnalyzerScope.MemberBody), an analyzer
///   failed, ran out of time or reported an unsupported ID, or the analyzers report on the declared
///   body, bound speculatively, other than they reported on it in the baseline (issue #6165);
/// - the analyzers have a time budget, and an analyzer's time in the baseline plus its time on the new
///   body is more than half the budget (issue #6183).
///
/// The analyzers' diagnostics after the edit are the baseline's, without those that the dispatch on
/// the edited member reported and with spans moved by the edit, and those that they report on the new
/// body.
///
/// No analyzer code runs while the check holds the compilation's build gate (issue #6183). An analyzer
/// can query a semantic model, and the index of a semantic model takes the same gate.
internal shared class BodyLocalDelta {
    /// Assembles the diagnostics after the edit, before the host's filter, or gives the reason why it cannot.
    func TryCollect(
        baseline DeltaBaseline,
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
        if declarations == nil ||
            program == nil ||
            program.BodyDiagnostics == nil ||
            declarations.Previous != nil ||
            declarations.HasNativeProtocols {
            return BodyLocalResult("the compilation has no published body pass")
        }
        // Issue #6183: no analyzer code runs while this thread holds the build gate. An analyzer can
        // query a semantic model, whose index takes the same gate, and the gate is not reentrant.
        // So the analyzers initialize here and run after the gate is released.
        let options = baseline.EffectiveOptions
        if !options.Analyzers.IsEmpty {
            let run = baseline.AnalyzerRun
            if run == nil {
                return BodyLocalResult("the baseline has no analyzer run")
            }
            if !GSharpAnalyzerDriver.AreBodyLocal(options.Analyzers, compilation) {
                return BodyLocalResult("an analyzer is not body-local in scope")
            }
            if run.Diagnostics.Any(IsAnalyzerHostDiagnostic) {
                return BodyLocalResult("an analyzer failed, ran out of time or reported an unsupported ID")
            }
            // Issue #6183: the check after the run on the new body adds that run's time.
            if options.AnalyzerOptions?.TimeBudgetMilliseconds is {} budget &&
                !FitTimeBudget(run, nil, options.Analyzers.Length, budget) {
                return BodyLocalResult(TimeBudgetReason)
            }
        }
        if !compilation.TryEnterBuildGate(cancellationToken) {
            return BodyLocalResult("the compilation cannot build")
        }
        var result BodyLocalResult
        try {
            result = Collect(
                baseline,
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
        let analyzerPhase = result.AnalyzerPhase
        if !result.Succeeded || analyzerPhase == nil {
            return result
        }
        let analyzerItems = List[Diagnostic]()
        let reason string? = analyzerPhase(analyzerItems)
        if reason != nil {
            return BodyLocalResult(reason)
        }
        // A successor can retire the compilation while the analyzers run without the gate, and the
        // retirement re-points the symbols that they read.
        if !compilation.TryEnterBuildGate(cancellationToken) {
            return BodyLocalResult("the compilation cannot build")
        }
        compilation.ExitBuildGate()
        return BodyLocalResult(result.Diagnostics.AddRange(analyzerItems))
    }

    private func Collect(
        baseline DeltaBaseline,
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
        let options = baseline.EffectiveOptions
        if function.IsPInvoke ||
            function.NullableSequenceSpecialization != NullableSequenceSpecializationKind.None ||
            function.IsReturnTypeInferred {
            return BodyLocalResult(
                "the member is a P/Invoke stub, a nullable-sequence specialization or has an inferred return type"
            )
        }
        if owner != nil && declarations.LatestRichAnonymousObjectPlans.ContainsKey(owner) {
            return BodyLocalResult("the member belongs to a rich anonymous type")
        }
        if !program.BodyDiagnostics!!.TryGetValue(function, out var recorded) ||
            recorded.IsDefault ||
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
        if suspending.Count > 0 &&
            (NamesAny(oldDeclaration.Body!!, suspending) || NamesAny(newDeclaration.Body!!, suspending)) {
            return BodyLocalResult("a body names a suspending function")
        }
        cancellationToken.ThrowIfCancellationRequested()
        let speculative = BindSpeculatively(compilation, declarations, function, owner, oldDeclaration, newDeclaration)
        if speculative.FallbackReason != nil {
            return BodyLocalResult(speculative.FallbackReason)
        }
        // The speculative pass must be the compilation's pass: the declared body reports what it reported.
        if !SameOccurrences(speculative.OldDiagnostics, recorded, cancellationToken) {
            return BodyLocalResult("the speculative bind of the declared body differs from the compilation's bind")
        }
        let newBound = speculative.NewBody!!
        if HasSuspensionFacts(oldBound) || HasSuspensionFacts(newBound) {
            return BodyLocalResult("a body has a suspension point or calls a suspending function")
        }
        if ReportsSuspensionRewriteFindings(function, newBound, declarations.References ?? compilation.References) {
            return BodyLocalResult("the suspension rewrite reports on the new body")
        }
        if ReportsWholeProgramFindings(function, oldBound, compilation.References) ||
            ReportsWholeProgramFindings(function, newBound, compilation.References) {
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
        let oldBodySpan = oldDeclaration.Body!!.Span
        for d in program.Diagnostics {
            if remove.TryGetValue(d, out var left) && left > 0 {
                remove[d] = left - 1
                continue
            }
            // A later pass of the program's bind (the suspension rewrite, for one) reported it in the
            // declared body, and the body-local check does not run that pass again.
            if IsInside(d.Location, oldText, oldBodySpan) {
                return BodyLocalResult("a later pass of the bind reports in the declared body")
            }
            if !TryRelocate(d, oldText, newTree.Text, spanMap, out var moved) {
                return BodyLocalResult("a body diagnostic outside the edited body touches the edit")
            }
            body.Add(moved!!)
        }
        // #6177: the speculative bind of the body reports these, as the body bind would.
        Diagnostic.StampPhase(speculative.NewDiagnostics, DiagnosticPhase.Body)
        for d in speculative.NewDiagnostics {
            // A diagnostic at the member's declaration names the old text.
            if !TryRelocate(d, oldText, newTree.Text, spanMap, out var moved) {
                return BodyLocalResult("a diagnostic of the new body touches the edit outside the new body")
            }
            body.Add(moved!!)
        }
        // The analyzers' diagnostics (issue #6165) come from a phase that runs after the build gate is
        // released (issue #6183).
        var analyzerPhase Func[List[Diagnostic], string?]? = nil
        if !options.Analyzers.IsEmpty {
            let target = function
            analyzerPhase = (analyzerItems List[Diagnostic]) -> CollectAnalyzerDiagnostics(
                baseline,
                compilation,
                snapshot,
                target,
                oldDeclaration,
                newDeclaration,
                speculative,
                oldText,
                newTree.Text,
                spanMap,
                analyzerItems,
                cancellationToken
            )
        }
        let declarationItems = snapshot.ApplySourceSuppressions(declaration.ToImmutableArray())
        let bodyItems = snapshot.ApplySourceSuppressions(body.ToImmutableArray())
        var items = declarationItems.AddRange(bodyItems)
        if !items.Any((d Diagnostic) -> d.IsError) {
            let documentation = List[Diagnostic]()
            // The documentation pass of the old program reports at the old text, so the snapshot's
            // suppressions apply once the diagnostics are relocated.
            for d in snapshot.ValidateDocumentationUnsuppressed(program) {
                if !TryRelocate(d, oldText, newTree.Text, spanMap, out var moved) {
                    return BodyLocalResult("a documentation diagnostic touches the edit")
                }
                documentation.Add(moved!!)
            }
            items = items.AddRange(snapshot.ApplySourceSuppressions(documentation.ToImmutableArray()))
        }
        return BodyLocalResult(items, analyzerPhase)
    }

    // Issue #6165: the analyzers' diagnostics after the edit, or the reason why the check cannot give
    // them. Every analyzer is body-local in scope, so the dispatch on one body reports what depends on
    // that body only.
    private func CollectAnalyzerDiagnostics(
        baseline DeltaBaseline,
        compilation Compilation,
        snapshot Compilation,
        function FunctionSymbol,
        oldDeclaration FunctionDeclarationSyntax,
        newDeclaration FunctionDeclarationSyntax,
        speculative SpeculativeBodyBind,
        oldText SourceText,
        newText SourceText,
        spanMap DocumentMap,
        result List[Diagnostic],
        cancellationToken CancellationToken
    ) string? {
        let options = baseline.EffectiveOptions
        let run = baseline.AnalyzerRun!!
        let oldBodySpan = oldDeclaration.Body!!.Span
        // The program's bind anchors every node without syntax at the nearest anchored ancestor, and the
        // body at its declaration, before the analyzers see it (ADR-0169).
        let oldBody = speculative.OldBody!!
        let newBody = speculative.NewBody!!
        SyntaxAnchoringWalker.Anchor(oldBody, oldDeclaration)
        SyntaxAnchoringWalker.Anchor(newBody, newDeclaration)
        // What the analyzers reported on the declared body in the baseline.
        let recorded = ImmutableArray.CreateBuilder[Diagnostic]()
        for var i = 0; i < run.Diagnostics.Length; i++ {
            let d = run.Diagnostics[i]
            if object.ReferenceEquals(run.Origins[i], function) {
                recorded.Add(d)
                continue
            }
            if IsInside(d.Location, oldText, oldBodySpan) {
                return "an analyzer reports in the declared body from another dispatch"
            }
            if !TryRelocate(d, oldText, newText, spanMap, out var moved) {
                return "an analyzer diagnostic outside the edited body touches the edit"
            }
            // The driver drops a diagnostic that a source suppression of the compilation covers.
            if !snapshot.DiagnosticSuppressions.IsSuppressed(moved!!) {
                result.Add(moved!!)
            }
        }
        cancellationToken.ThrowIfCancellationRequested()
        // The dispatch on the declared body, bound speculatively, must report what the baseline recorded.
        let before = GSharpAnalyzerDriver.TryRunOnBody(
            compilation,
            options.Analyzers,
            options.AnalyzerOptions,
            function,
            oldBody,
            compilation.DiagnosticSuppressions,
            cancellationToken
        )
        if before == nil || before.Diagnostics.Any(IsAnalyzerHostDiagnostic) {
            return "an analyzer failed on the declared body"
        }
        if !SameOccurrences(before.Diagnostics, recorded.ToImmutable(), cancellationToken) {
            return "the analyzers report on the speculative bind of the declared body other than on the compilation's"
        }
        // A diagnostic of the new body can sit at the member's declaration in the old text, so the
        // snapshot's source suppressions apply after the move to the new text.
        let after = GSharpAnalyzerDriver.TryRunOnBody(
            compilation,
            options.Analyzers,
            options.AnalyzerOptions,
            function,
            newBody,
            DiagnosticSuppressionMap.Build(ImmutableArray[SyntaxTree].Empty),
            cancellationToken
        )
        if after == nil || after.Diagnostics.Any(IsAnalyzerHostDiagnostic) {
            return "an analyzer failed on the new body"
        }
        if options.AnalyzerOptions?.TimeBudgetMilliseconds is {} budget &&
            !FitTimeBudget(run, after, options.Analyzers.Length, budget) {
            return TimeBudgetReason
        }
        for d in after.Diagnostics {
            if !TryRelocate(d, oldText, newText, spanMap, out var moved) {
                return "an analyzer diagnostic of the new body touches the edit outside the new body"
            }
            if !snapshot.DiagnosticSuppressions.IsSuppressed(moved!!) {
                result.Add(moved!!)
            }
        }
        return nil
    }

    // Issue #6183: the time budget (AnalyzerOptions.TimeBudgetMilliseconds) limits the time of each
    // analyzer over the whole run, and the full run reports GS9302 when an analyzer goes over it. The
    // time of the full run after the edit is the baseline's time, less the declared body, plus the new
    // body. The baseline's time plus the new body's time is more than that. The check keeps the
    // body-local path only when that sum, multiplied by this factor, is not more than the budget.
    // Times change from run to run, so the factor keeps the full run well under the budget.
    internal const TimeBudgetMarginFactor int64 = 2

    internal const TimeBudgetReason string = "an analyzer's time is not well under the time budget"

    // Whether each analyzer's time in the baseline, plus its time on the new body when one is given, is
    // well under the budget. It is false when a run gives no time for each analyzer.
    internal func FitTimeBudget(baseline AnalyzerRun, newBody AnalyzerRun?, analyzerCount int32, budget int32) bool {
        if baseline.Elapsed.Length != analyzerCount || (newBody != nil && newBody.Elapsed.Length != analyzerCount) {
            return false
        }
        for var i = 0; i < analyzerCount; i++ {
            var total = baseline.Elapsed[i]
            if newBody != nil {
                total += newBody.Elapsed[i]
            }
            if !FitsTimeBudget(total, budget) {
                return false
            }
        }
        return true
    }

    // Whether a time, multiplied by the margin factor, is not more than the budget.
    internal func FitsTimeBudget(time TimeSpan, budget int32) bool -> budget >= 0 &&
        time.Ticks <= TimeSpan.FromMilliseconds(budget).Ticks / TimeBudgetMarginFactor

    // GS9300 (an analyzer threw), GS9302 (it ran out of time) and GS9304 (it reported an ID it does not
    // support, once per run): a run on one body would not report them as a run on the compilation does.
    private func IsAnalyzerHostDiagnostic(d Diagnostic) bool -> d.Id is "GS9300" or "GS9302" or "GS9304"

    private func NonDefault(members ImmutableArray[FunctionSymbol]) ImmutableArray[
        FunctionSymbol
    ] -> if members.IsDefault {
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

    // Each diagnostic of one array matches one occurrence of the other: same location text (by
    // identity), span, ID, severity and message. The arrays are compared as multisets of those keys, so
    // a duplicate counts once for each occurrence.
    internal func SameOccurrences(
        left ImmutableArray[Diagnostic],
        right ImmutableArray[Diagnostic],
        cancellationToken CancellationToken
    ) bool {
        if left.Length != right.Length {
            return false
        }
        let texts = Dictionary[SourceText, int32](ReferenceEqualityComparer.Instance)
        let counts = Dictionary[(int32, int32, int32, string, DiagnosticSeverity, string), int32]()
        for var i = 0; i < left.Length; i++ {
            if (i & 1023) == 0 {
                cancellationToken.ThrowIfCancellationRequested()
            }
            let key = OccurrenceKey(left[i], texts)
            let _ = counts.TryGetValue(key, out var n)
            counts[key] = n + 1
        }
        for var i = 0; i < right.Length; i++ {
            if (i & 1023) == 0 {
                cancellationToken.ThrowIfCancellationRequested()
            }
            let key = OccurrenceKey(right[i], texts)
            if !counts.TryGetValue(key, out var n) || n == 0 {
                return false
            }
            counts[key] = n - 1
        }
        return true
    }

    // The location text by identity (-1 for none), the span, the ID, the severity and the message.
    private func OccurrenceKey(d Diagnostic, texts Dictionary[SourceText, int32])(
        int32,
        int32,
        int32,
        string,
        DiagnosticSeverity,
        string
    ) {
        var text = -1
        if d.Location.Text is {} source {
            if !texts.TryGetValue(source, out text) {
                text = texts.Count
                texts[source] = text
            }
        }
        return (text, d.Location.Span.Start, d.Location.Span.Length, d.Id, d.Severity, d.Message)
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

    private func IsInside(location TextLocation, text SourceText, span TextSpan) bool {
        let start = location.Span.Start
        let end = location.Span.End
        return object.ReferenceEquals(location.Text, text) && start >= span.Start && end <= span.End
    }

    // SuspensionInference rewrites every body after the bind (SuspendingCallRewriter) and reports there:
    // an await in a `lock` body or nested in a `go` operand, an await or a blocking bridge where the
    // container does not suspend, a `case cancelled` arm without a context. The member does not suspend
    // and its body names no suspending function, so no other function is newly suspending.
    private func ReportsSuspensionRewriteFindings(
        function FunctionSymbol,
        body BoundBlockStatement,
        references ReferenceResolver?
    ) bool {
        if references == nil {
            return true
        }
        let runtime = ChannelRuntimeBinder(references)
        if !runtime.IsAvailable {
            return false
        }
        let bag = DiagnosticBag()
        var adapted = false
        let _ = SuspendingCallRewriter.Rewrite(
            body,
            function,
            containerIsRoot: false,
            ImmutableHashSet[FunctionSymbol].Empty,
            runtime,
            bag,
            (container FunctionSymbol, group BoundMethodGroupExpression) -> {
                adapted = true
                return group
            }
        )
        return adapted || bag.Count > 0
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

    init(diagnostics ImmutableArray[Diagnostic], analyzerPhase Func[List[Diagnostic], string?]?) {
        Diagnostics = diagnostics
        Succeeded = true
        AnalyzerPhase = analyzerPhase
    }

    // Issue #6183: adds the analyzers' diagnostics after the edit to the list, or gives the reason why it
    // cannot. The caller runs it after it releases the compilation's build gate.
    prop AnalyzerPhase Func[List[Diagnostic], string?]? {
        get;
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
