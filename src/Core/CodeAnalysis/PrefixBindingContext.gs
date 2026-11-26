// <copyright file="PrefixBindingContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Threading
import SystemObject = System.Object

/// The kind of a failed lookup that a report states (ADR-0225).
internal enum PrefixLookupKind {
    /// A simple name: a variable, a function or a type.
    Name,
    /// A member of a receiver or of a type.
    Member
}

/// The callee of a call whose resolution the binder reports on in a prefix bind (ADR-0225 D6.5).
internal enum PrefixCallKind {
    /// A simple name: a later declaration can add a candidate or hide the callee.
    Name,
    /// A member of a receiver or of a type: a later member or receiver function can add a candidate.
    Member,
    /// A local or a parameter of a function type. No later text can change its signature.
    Fixed,
    /// A function literal or lambda body inside a call. The body states its own calls.
    Body
}

/// The facts of a prefix tree that the binder reads when it reports (ADR-0225).
/// The parser records them when it seals the cut. They are null for a tree of a complete program.
internal sealed class PrefixCut {
    internal init(
        text SourceText,
        cut int32,
        remainder PrefixRemainder,
        keptStart int32,
        laterDeclarationsPossible bool,
        openMemberStart int32,
        sealedTokens ImmutableArray[SyntaxToken]
    ) {
        Text = text
        Cut = cut
        Remainder = remainder
        KeptStart = keptStart
        LaterDeclarationsPossible = laterDeclarationsPossible
        OpenMemberStart = openMemberStart
        SealedTokens = sealedTokens
    }

    /// Gets the tokens that close the delimiters that are open at the cut, innermost first.
    internal prop SealedTokens ImmutableArray[SyntaxToken] {
        get;
    }

    /// Gets the text of the prefix tree.
    internal prop Text SourceText {
        get;
    }

    /// Gets the cut position.
    internal prop Cut int32 {
        get;
    }

    /// Gets what follows the cut.
    internal prop Remainder PrefixRemainder {
        get;
    }

    /// Gets the position of the first token after the cut that the prefix tree keeps.
    /// The text from (cref:Cut) to this position is not in the tree.
    internal prop KeptStart int32 {
        get;
    }

    /// Gets a value that tells whether a declaration after the cut can declare a name that any scope sees.
    /// This is true when nothing follows the cut, and when the cut is in the top-level statements.
    internal prop LaterDeclarationsPossible bool {
        get;
    }

    /// Gets the start of the member whose text after the cut the bind removed, or -1.
    internal prop OpenMemberStart int32 {
        get;
    }

    /// Returns a value that tells whether [`location`](paramref) is in the text that the bind removed.
    /// @param location A diagnostic location.
    /// @returns `true` for a location from the cut to the first kept token.
    internal func IsRemoved(location TextLocation) bool {
        if !object.ReferenceEquals(location.Text, Text) || location.Span.Start < Cut {
            return false
        }
        // When nothing follows the cut or nothing is kept, everything at or after the cut is removed,
        // also when the text ends there.
        return Remainder == PrefixRemainder.Nothing || !HasKeptText || location.Span.Start < KeptStart
    }

    /// Gets or sets the lexer diagnostics of tokens that the cut left unfinished (an unterminated string
    /// or comment). The lexer states them when it reaches the end of its input.
    internal prop UnfinishedTokenDiagnostics ImmutableArray[Diagnostic] {
        get {
            return if unfinishedTokenDiagnostics.IsDefault {
                ImmutableArray[Diagnostic].Empty
            } else {
                unfinishedTokenDiagnostics
            }
        }
        set {
            unfinishedTokenDiagnostics = value
        }
    }

    private var unfinishedTokenDiagnostics ImmutableArray[Diagnostic]

    /// Gets or sets a value that tells whether a declaration after the cut can add a candidate to a call that
    /// resolves before the cut: nothing follows the cut, or the bind could not keep the later declarations
    /// (#6179).
    internal prop LaterOverloadsPossible bool {
        get;
        set;
    }

    // #6179: the spans of the expressions whose type a later declaration can change. Bodies can bind in
    // parallel, so the lock guards both collections.
    private let provisionalGate object = SystemObject()
    private let provisionalKeys HashSet[(Text SourceText, Span TextSpan)] = HashSet[(Text SourceText, Span TextSpan)]()
    private let provisionalSpans List[(Text SourceText, Span TextSpan)] = List[(Text SourceText, Span TextSpan)]()
    private let provisionalTrees Dictionary[SourceText, SyntaxTree] = Dictionary[SourceText, SyntaxTree](
        ReferenceEqualityComparer.Instance
    )

    /// Records that a later declaration can change the type of [`node`](paramref) (#6179).
    /// @param node An expression that binds before the cut.
    internal func AddProvisional(node SyntaxNode) {
        let tree = node.SyntaxTree
        lock provisionalGate {
            provisionalTrees[tree.Text] = tree
        }
        AddProvisional(node.Location)
    }

    private let fixedKeys HashSet[(Text SourceText, Span TextSpan)] = HashSet[(Text SourceText, Span TextSpan)]()

    /// Records that no later declaration can change the type of [`node`](paramref): a call, a member access
    /// or an index expression that the binder showed to be fixed (#6179).
    /// @param node The expression.
    internal func AddFixed(node SyntaxNode) {
        let key = (node.SyntaxTree.Text, node.Span)
        lock provisionalGate {
            fixedKeys.Add(key)
            provisionalTrees[node.SyntaxTree.Text] = node.SyntaxTree
        }
    }

    /// Returns a value that tells whether the binder showed [`node`](paramref) to be fixed (#6179).
    /// @param node The expression.
    /// @returns `true` for a node that (cref:AddFixed) recorded.
    internal func IsFixed(node SyntaxNode) bool {
        let key = (node.SyntaxTree.Text, node.Span)
        lock provisionalGate {
            return fixedKeys.Contains(key)
        }
    }

    /// Returns the trees in which the bind recorded an expression or a name (#6179).
    /// @returns The trees.
    internal func ProvisionalTreeList() List[SyntaxTree] {
        lock provisionalGate {
            return List[SyntaxTree](provisionalTrees.Values)
        }
    }

    /// Records that the bind binds names in [`tree`](paramref), so that a report in it can follow a global
    /// of another tree (#6179).
    /// @param tree A tree of the compilation.
    internal func AddTree(tree SyntaxTree) {
        lock provisionalGate {
            provisionalTrees[tree.Text] = tree
        }
    }

    /// Returns the tree of [`text`](paramref) when the bind recorded an expression in it (#6179).
    /// @param text A source text.
    /// @returns The tree, or `null`.
    internal func ProvisionalTree(text SourceText?) SyntaxTree? {
        if text == nil {
            return nil
        }
        lock provisionalGate {
            return if provisionalTrees.TryGetValue(text, out var tree) {
                tree
            } else {
                default(SyntaxTree?)
            }
        }
    }

    /// Records that a later declaration can change the type of the expression at [`location`](paramref)
    /// (#6179).
    /// @param location The location of an expression that binds before the cut.
    internal func AddProvisional(location TextLocation) {
        if location.Text is not{} text {
            return
        }
        let key = (text, location.Span)
        lock provisionalGate {
            if provisionalKeys.Add(key) {
                provisionalSpans.Add(key)
            }
        }
    }

    /// Returns a value that tells whether [`node`](paramref) is an expression whose type a later
    /// declaration can change (#6179).
    /// @param node A syntax node.
    /// @returns `true` for a node at a location that (cref:AddProvisional) recorded.
    internal func IsProvisional(node SyntaxNode) bool {
        let key = (node.SyntaxTree.Text, node.Span)
        lock provisionalGate {
            return provisionalSpans.Count > 0 && provisionalKeys.Contains(key)
        }
    }

    /// Gets a value that tells whether the bind recorded an expression whose type can change (#6179).
    internal prop HasProvisional bool {
        get {
            lock provisionalGate {
                return provisionalSpans.Count > 0
            }
        }
    }

    private let fixedSignatureCallKeys HashSet[(Text SourceText, Span TextSpan)] = HashSet[
        (Text SourceText, Span TextSpan)
    ]()

    /// Records that [`node`](paramref) is a non-generic single-candidate call whose parameter types do not
    /// depend on sibling lambda bodies (#6229).
    /// @param node The call syntax node.
    internal func AddFixedSignatureCall(node SyntaxNode) {
        let key = (node.SyntaxTree.Text, node.Span)
        lock provisionalGate {
            fixedSignatureCallKeys.Add(key)
            provisionalTrees[node.SyntaxTree.Text] = node.SyntaxTree
        }
    }

    /// Returns a value that tells whether [`location`](paramref) was recorded by (cref:AddFixedSignatureCall).
    /// @param location The call syntax location.
    /// @returns `true` when sibling lambda bodies cannot change the call's signature.
    internal func IsFixedSignatureCallAt(location TextLocation) bool {
        if location.Text is not{} text {
            return false
        }
        let key = (text, location.Span)
        lock provisionalGate {
            return fixedSignatureCallKeys.Count > 0 && fixedSignatureCallKeys.Contains(key)
        }
    }

    /// Returns a value that tells whether [`node`](paramref) was recorded by (cref:AddFixedSignatureCall).
    /// @param node The call syntax node.
    /// @returns `true` when sibling lambda bodies cannot change the call's signature.
    internal func IsFixedSignatureCall(node SyntaxNode?) bool -> node != nil && IsFixedSignatureCallAt(node.Location)

    /// Returns a value that tells whether [`location`](paramref) contains an expression whose type a
    /// later declaration can change (#6179).
    /// @param location A diagnostic location.
    /// @param skipSpan Optional span whose provisional entries should be ignored (e.g. a lambda body).
    /// @param excludeCallLambdas When `true`, also ignores sibling lambda bodies that cannot affect
    /// [`location`](paramref)'s call signature (#6229).
    /// @param fixedCallSpan Optional span of the fixed-signature call whose direct lambda arguments
    /// should be ignored (#6229).
    /// @returns `true` when a recorded expression is in the location.
    internal func ContainsProvisional(
        location TextLocation,
        skipSpan TextSpan? = nil,
        excludeCallLambdas bool = false,
        fixedCallSpan TextSpan? = nil
    ) bool {
        let span = location.Span
        lock provisionalGate {
            if provisionalSpans.Count == 0 {
                return false
            }
            var tree SyntaxTree? = nil
            if location.Text is {} text {
                provisionalTrees.TryGetValue(text, out tree)
            }
            for entry in provisionalSpans {
                if skipSpan is {} excluded && excluded.Start <= entry.Span.Start && entry.Span.End <= excluded.End {
                    continue
                }
                if object.ReferenceEquals(entry.Text, location.Text) &&
                    span.Start <= entry.Span.Start &&
                    entry.Span.End <= span.End &&
                    !IsShieldedFromOuterSpan(tree, span, entry.Span, excludeCallLambdas, fixedCallSpan) {
                    return true
                }
            }
        }
        return false
    }

    private func IsShieldedFromOuterSpan(
        tree SyntaxTree?,
        outer TextSpan,
        inner TextSpan,
        excludeCallLambdas bool = false,
        fixedCallSpan TextSpan? = nil
    ) bool {
        if tree == nil {
            return false
        }
        var node SyntaxNode = tree.Root
        var inSiblingLambdaBlock = false
        var inSiblingReturn = false
        while true {
            var next SyntaxNode? = nil
            for child in node.GetChildren() {
                if child is not SyntaxToken &&
                    child.Span.Start <= inner.Start &&
                    inner.End <= child.Span.End &&
                    child.Span.Length > 0 {
                    next = child
                    break
                }
            }
            if next == nil {
                return inSiblingLambdaBlock && !inSiblingReturn
            }
            if (next is InterpolatedStringExpressionSyntax || next is NameOfExpressionSyntax) &&
                outer.Start <= next.Span.Start &&
                next.Span.End <= outer.End {
                return true
            }
            if excludeCallLambdas && outer.Start < next.Span.Start && next.Span.End <= outer.End {
                if next is FunctionLiteralExpressionSyntax {
                    return true
                }
                if next is LambdaExpressionSyntax {
                    if fixedCallSpan is {} callSpan && PrefixBindingContext.EnclosingCallOfArgumentExact(
                        next.SyntaxTree,
                        next,
                        callSpan
                    ) {
                        return true
                    }
                } else if node is LambdaExpressionSyntax &&
                    (next is BlockExpressionSyntax || next is BlockStatementSyntax) {
                    if inSiblingLambdaBlock && !inSiblingReturn {
                        return true
                    }
                    inSiblingLambdaBlock = true
                    inSiblingReturn = next is BlockExpressionSyntax block &&
                        block.Expression is {} tail &&
                        tail.Span.Start <= inner.Start &&
                        inner.End <= tail.Span.End
                } else if inSiblingLambdaBlock && !inSiblingReturn && next is ReturnStatementSyntax {
                    inSiblingReturn = true
                }
            }
            node = next
        }
        return false
    }

    /// Gets or sets the span of the last source token before the cut, or an empty span at 0.
    internal prop LastToken TextSpan {
        get;
        set;
    }

    /// Gets or sets a value that tells whether the last source token before the cut is a word (a name,
    /// a keyword or a number) that more text after the cut can extend.
    internal prop LastTokenIsWord bool {
        get;
        set;
    }

    /// Gets or sets a value that tells whether the prefix tree keeps text after the cut.
    internal prop HasKeptText bool {
        get;
        set;
    }

    /// Gets the prefix tree. The parser sets it after the parse.
    internal prop Tree SyntaxTree? {
        get;
        set;
    }

    /// Returns a value that tells whether [`location`](paramref) is in a function literal or a lambda of
    /// the open member before the cut. Such a body can use a local that a later statement declares. When
    /// nothing follows the cut, a literal of any member before the cut counts.
    /// @param location A diagnostic location.
    /// @returns `true` when a later statement of the open member can declare a name that the location sees.
    internal func IsInDeferredBodyOfOpenMember(location TextLocation) bool {
        // When nothing follows the cut, any member before the cut can be the open one.
        let memberStart = if Remainder == PrefixRemainder.Nothing {
            0
        } else {
            OpenMemberStart
        }
        return IsInDeferredBodyAfter(memberStart, location)
    }

    /// Returns a value that tells whether [`location`](paramref) is in a function literal or a lambda that
    /// starts at or after [`memberStart`](paramref) and before the cut.
    /// @param memberStart The first position to examine, or -1 for none.
    /// @param location A diagnostic location.
    /// @returns `true` when a later statement can declare a local that the location sees.
    internal func IsInDeferredBodyAfter(memberStart int32, location TextLocation) bool {
        if memberStart < 0 || !object.ReferenceEquals(location.Text, Text) || Tree is not{} tree {
            return false
        }
        let position = location.Span.Start
        if position < memberStart || position >= Cut {
            return false
        }
        var node SyntaxNode = tree.Root
        while true {
            var next SyntaxNode? = nil
            for child in node.GetChildren() {
                if child is not SyntaxToken && child.Span.Start <= position && position < child.Span.End {
                    next = child
                    break
                }
            }
            if next == nil {
                return false
            }
            if next.Span.Start >= memberStart && next is FunctionLiteralExpressionSyntax {
                return true
            }
            node = next
        }
        return false
    }
}

/// A premise that the binder states when it reports a diagnostic in a prefix bind (ADR-0225).
internal sealed class PrefixPremise {
    internal init(finality DiagnosticFinality, reason string) {
        Finality = finality
        Reason = reason
    }

    /// Gets the finality of the diagnostics that the premise covers.
    internal prop Finality DiagnosticFinality {
        get;
    }

    /// Gets the reason, or an empty string for a final diagnostic.
    internal prop Reason string {
        get;
    }

    shared {
        /// Gets the premise of a failed simple-name lookup: a later declaration can declare the name.
        internal let LaterDeclaration PrefixPremise = PrefixPremise(
            DiagnosticFinality.FutureDependent,
            "later-declaration"
        )

        /// Gets the premise of a failed member lookup: a later declaration can declare the member.
        internal let LaterMember PrefixPremise = PrefixPremise(DiagnosticFinality.FutureDependent, "later-member")

        /// Gets the premise of an expression whose type a later declaration can change: a call that a later
        /// overload, member or receiver function can retarget, or a local whose type such a call infers (#6179).
        internal let LaterOverload PrefixPremise = PrefixPremise(DiagnosticFinality.FutureDependent, "later-overload")

        /// Gets the premise of a check at the end of an open body.
        internal let RestOfBody PrefixPremise = PrefixPremise(DiagnosticFinality.FutureDependent, "rest-of-body")

        /// Gets the premise of a check of an open type.
        internal let RestOfType PrefixPremise = PrefixPremise(DiagnosticFinality.FutureDependent, "rest-of-type")

        /// Gets the premise of a check of a statement that is open at the cut.
        internal let RestOfStatement PrefixPremise = PrefixPremise(
            DiagnosticFinality.FutureDependent,
            "rest-of-statement"
        )
    }
}

/// The prefix cut that a compilation binds under (ADR-0225). Binding reads it from an ambient value, as
/// it reads (cref:Symbols.NullabilityOptions), because a failed lookup in any tree can depend on a
/// declaration after the cut.
internal shared class PrefixBindingContext {
    private let current AsyncLocal[PrefixCut?] = AsyncLocal[PrefixCut?]()

    /// Restores the previous prefix cut.
    internal struct Scope : IDisposable {
        private let previous PrefixCut?

        internal init(previous PrefixCut?) {
            this.previous = previous
        }

        /// Restores the previous prefix cut.
        func Dispose() {
            PrefixBindingContext.current.Value = this.previous
        }
    }

    /// Gets the prefix cut of the bind in progress, or `null`.
    internal prop Current PrefixCut? -> current.Value

    /// Sets the prefix cut of the bind in progress until the scope ends.
    /// @param cut The prefix cut, or `null` for a complete program.
    /// @returns The scope that restores the previous value.
    internal func Enter(cut PrefixCut?) PrefixBindingContext.Scope {
        let previous = current.Value
        current.Value = cut
        return PrefixBindingContext.Scope(previous)
    }

    /// Returns the premise of a failed lookup at [`location`](paramref), or `null` when the failure is final.
    /// @param location The location of the failed lookup.
    /// @param kind The kind of the failed lookup.
    /// @returns The finality and its reason, or `null`.
    internal func ClassifyFailedLookup(location TextLocation, kind PrefixLookupKind) PrefixPremise? {
        if current.Value is not{} cut {
            return nil
        }
        // A simple-name lookup ends in the file scope. A member lookup can find a member of an open or
        // partial type, or a receiver function (`func (v T) Name()`), that a later declaration adds.
        if kind == PrefixLookupKind.Member {
            // The kept declarations hold every member and receiver function after the cut.
            return if cut.Remainder == PrefixRemainder.Nothing {
                PrefixPremise.LaterMember
            } else {
                nil
            }
        }
        if cut.LaterDeclarationsPossible {
            return PrefixPremise.LaterDeclaration
        }
        // A function literal can use a local that a later statement declares.
        if kind == PrefixLookupKind.Name && cut.IsInDeferredBodyOfOpenMember(location) {
            return PrefixPremise.LaterDeclaration
        }
        return nil
    }

    /// Gets a value that tells whether a top-level statement can follow the cut of the bind in progress:
    /// nothing follows the cut, or the cut is in the top-level statements.
    internal prop TopLevelStatementsCanFollow bool -> current.Value is {} cut && cut.LaterDeclarationsPossible

    /// Returns a value that tells whether a later declaration can add a conversion between
    /// [`fromType`](paramref) and [`toType`](paramref) (ADR-0120): nothing follows the cut, and one of
    /// the types is a type of this compilation, or an imported type that a later source type of the same
    /// name can hide (D6.3). A built-in type is neither.
    /// @param fromType The source type of the conversion.
    /// @param toType The target type of the conversion.
    /// @returns `true` when a later `func operator implicit` can remove a missing-conversion report.
    internal func LaterConversionCanFollow(fromType TypeSymbol, toType TypeSymbol) bool {
        if current.Value is not{} cut || cut.Remainder != PrefixRemainder.Nothing {
            return false
        }
        return IsSourceType(fromType) || IsSourceType(toType)
    }

    private func IsSourceType(type TypeSymbol) bool {
        // The nullability carriers wrap the type that a conversion is declared for.
        var underlying = type
        for var depth = 0; depth < 8; depth++ {
            if underlying is NullableTypeSymbol nullable {
                underlying = nullable.UnderlyingType
            } else if underlying is PlatformTypeSymbol platform {
                underlying = platform.UnderlyingType
            } else if underlying is NullabilityAnnotatedTypeSymbol annotated {
                underlying = annotated.BaseType
            } else {
                break
            }
        }
        return (underlying is StructSymbol structSymbol && structSymbol.Declaration != nil) ||
            underlying is ImportedTypeSymbol
    }

    /// Returns the premise of a failed overload resolution or argument check at [`location`](paramref)
    /// (ADR-0225 D6.5), or `null` when the failure is final. A later declaration can add a candidate.
    /// @param location The location of the report.
    /// @param kind The callee of the call.
    /// @returns The finality and its reason, or `null`.
    internal func ClassifyCallResolution(location TextLocation, kind PrefixCallKind) PrefixPremise? {
        // A function literal of the open member can call a local that a later statement declares.
        return if kind == PrefixCallKind.Fixed {
            if LaterLocalCanHide(location) {
                PrefixPremise.LaterDeclaration
            } else {
                default(PrefixPremise?)
            }
        } else if kind == PrefixCallKind.Member {
            ClassifyFailedLookup(location, PrefixLookupKind.Member)
        } else {
            ClassifyFailedLookup(location, PrefixLookupKind.Name)
        }
    }

    /// Returns a value that tells whether a later local can hide a simple name at [`location`](paramref):
    /// the location is in a function literal before the cut, and a later statement of the open member, or
    /// of the top-level statements, can declare a local that the literal sees (#6179).
    /// @param location The location of the name.
    /// @returns `true` when a later local can hide what the name resolved to.
    internal func LaterLocalCanHide(location TextLocation) bool {
        if current.Value is not{} cut {
            return false
        }
        return cut.IsInDeferredBodyOfOpenMember(location) ||
            (cut.LaterDeclarationsPossible && cut.OpenMemberStart < 0 && cut.IsInDeferredBodyAfter(0, location))
    }

    /// Returns a value that tells whether a later top-level statement can declare a global that hides a
    /// simple-name lookup inside [`syntax`](paramref) (#6229). Only bodies bound after top-level
    /// statements (functions, methods, constructors, accessors, and static initializers) see later globals;
    /// earlier top-level statements and field initializers do not.
    /// @param syntax The lookup syntax node.
    /// @returns `true` when [`syntax`](paramref) sits inside a member or function body.
    internal func IsInMemberOrFunctionBody(syntax SyntaxNode) bool {
        let tree = syntax.SyntaxTree
        var node SyntaxNode? = syntax
        while node != nil {
            if node is GlobalStatementSyntax || node is FieldDeclarationSyntax {
                return false
            }
            if node is FunctionDeclarationSyntax ||
                node is ConstructorDeclarationSyntax ||
                node is PropertyAccessorSyntax ||
                node is PropertyDeclarationSyntax ||
                node is EventAccessorSyntax ||
                node is EventDeclarationSyntax ||
                node is StaticInitializerBlockSyntax {
                return true
            }
            node = tree.GetParent(node)
        }
        return false
    }

    /// Returns a value that tells whether a later top-level statement can declare a global that hides a
    /// simple-name lookup inside [`syntax`](paramref) (#6229). Only bodies bound after top-level
    /// statements (functions, methods, constructors, accessors, and static initializers) see later globals;
    /// earlier top-level statements and field initializers do not.
    /// @param syntax The lookup syntax node.
    /// @returns `true` when a later top-level global can shadow the lookup.
    internal func LaterGlobalCanHide(syntax SyntaxNode) bool {
        if current.Value is not{} cut || !cut.LaterDeclarationsPossible {
            return false
        }
        return IsInMemberOrFunctionBody(syntax)
    }

    /// Returns a value that tells whether any type of [`type`](paramref)'s hierarchy before
    /// [`stop`](paramref) can still receive members after the cut (#6179, #6229).
    /// @param type The receiver or target type.
    /// @param stop Optional ancestor type at which to stop walking.
    /// @returns `true` when a later partial declaration or open type can add a member.
    internal func CanHierarchyGrow(type TypeSymbol?, stop TypeSymbol? = nil) bool {
        var currentType = type
        while currentType is NullableTypeSymbol nullable {
            currentType = nullable.UnderlyingType
        }
        if currentType is PlatformTypeSymbol platform {
            currentType = platform.UnderlyingType
        }
        // Member lookup on a type parameter follows its constraints.
        if currentType is TypeParameterSymbol parameter {
            return CanHierarchyGrow(parameter.EffectiveClassConstraint, stop) ||
                CanHierarchyGrow(parameter.InterfaceConstraint, stop) ||
                CanHierarchyGrow(parameter.ClrInterfaceConstraint, stop)
        }
        if currentType is StructSymbol aggregate {
            for level in aggregate.GetHierarchy() {
                if stop != nil && object.ReferenceEquals(level, stop) {
                    return false
                }
                if level is StructSymbol levelStruct &&
                    levelStruct.Declaration is {} declaration &&
                    IsIncompleteType(declaration) {
                    return true
                }
                if level is InterfaceSymbol {
                    return true
                }
            }
            return false
        }
        return stop == nil && currentType is InterfaceSymbol
    }

    /// Returns a value that tells whether a top-level function declaration of [`name`](paramref) exists in
    /// any tree of [`cut`](paramref)'s compilation, preventing a later top-level global of the same name
    /// (#6229).
    /// @param cut The prefix cut.
    /// @param name The function name.
    /// @returns `true` when a package-level function owns the name.
    internal func HasTopLevelFunction(cut PrefixCut, name string) bool {
        for tree in cut.ProvisionalTreeList() {
            for member in tree.Root.Members {
                if member is FunctionDeclarationSyntax fn && string.Equals(
                    fn.Identifier.ValueText,
                    name,
                    StringComparison.Ordinal
                ) {
                    return true
                }
            }
        }
        return false
    }

    /// Records that a later declaration can change the type of [`node`](paramref) (#6179).
    /// @param node An expression that binds before the cut.
    internal func AddProvisional(node SyntaxNode?) {
        if node != nil && current.Value is {} cut {
            cut.AddProvisional(node)
        }
    }

    /// Records that the binder showed [`node`](paramref) to be fixed (#6179).
    /// @param node A call, a member access or an index expression.
    internal func AddFixed(node SyntaxNode?) {
        if node != nil && current.Value is {} cut {
            cut.AddFixed(node)
        }
    }

    /// Records that the bind binds names in [`tree`](paramref) (#6179).
    /// @param tree A tree of the compilation.
    internal func AddTree(tree SyntaxTree) {
        if current.Value is {} cut {
            cut.AddTree(tree)
        }
    }

    /// Records that a later declaration can change the type of the expression at [`location`](paramref)
    /// (#6179).
    /// @param location The location of an expression that binds before the cut.
    internal func AddProvisional(location TextLocation) {
        if current.Value is {} cut {
            cut.AddProvisional(location)
        }
    }

    /// Returns a value that tells whether a fallback simple-name lookup on [`syntax`](paramref) can be
    /// shadowed by a later local or top-level global (#6229).
    /// @param syntax The name expression.
    /// @returns `true` when a later local or top-level global can hide the fallback lookup.
    internal func CanSimpleNameBeShadowed(syntax NameExpressionSyntax) bool {
        if current.Value is not{} cut {
            return false
        }
        if LaterLocalCanHide(syntax.Location) {
            return true
        }
        let name = syntax.IdentifierToken.ValueText
        if cut.LaterOverloadsPossible {
            return cut.LaterDeclarationsPossible && !HasTopLevelFunction(cut, name)
        }
        return LaterGlobalCanHide(syntax) && !HasTopLevelFunction(cut, name)
    }

    /// Returns a value that tells whether any hole inside [`syntax`](paramref) uses a provisional
    /// expression or name, for handler-targeted interpolations whose hole types determine validity (#6229).
    /// @param syntax The interpolated string syntax node, or `null`.
    /// @returns `true` when any interpolation hole depends on a provisional expression.
    internal func InterpolationHolesAreProvisional(syntax SyntaxNode?) bool {
        if current.Value is not{} cut ||
            (!cut.HasProvisional && !cut.LaterOverloadsPossible) ||
            syntax is not InterpolatedStringExpressionSyntax {
            return false
        }
        for child in syntax.GetChildren() {
            if child is not SyntaxToken &&
                (
                cut.ContainsProvisional(child.Location) ||
                    StatementUsesProvisionalCore(cut, syntax.SyntaxTree, child.Span, skipSubtree: nil)
            ) {
                return true
            }
        }
        return false
    }

    /// Records that [`node`](paramref) is a non-generic single-candidate call whose parameter types do not
    /// depend on sibling lambda bodies (#6229).
    /// @param node The call syntax node.
    internal func AddFixedSignatureCall(node SyntaxNode?) {
        if node != nil && current.Value is {} cut && !cut.LaterOverloadsPossible {
            cut.AddFixedSignatureCall(node)
        }
    }

    /// Returns the premise of a report at [`location`](paramref) that contains an expression whose type
    /// a later declaration can change, or `null` (#6179).
    /// @param location The location of the report.
    /// @param skipSubtree Optional argument subtree whose provisional expressions should be ignored.
    /// @param excludeCallLambdas When `true`, also ignores sibling lambda bodies of the call at [`location`](paramref).
    /// @returns (cref:PrefixPremise.LaterOverload) or `null`.
    internal func ProvisionalPremise(
        location TextLocation,
        skipSubtree SyntaxNode? = nil,
        excludeCallLambdas bool = false
    ) PrefixPremise? {
        if current.Value is not{} cut || (!cut.HasProvisional && !cut.LaterOverloadsPossible) {
            return nil
        }
        let fixedCallSpan TextSpan? = if excludeCallLambdas && cut.IsFixedSignatureCallAt(location) {
            location.Span
        } else {
            default(TextSpan?)
        }
        return if cut.ContainsProvisional(location, skipSubtree?.Span, excludeCallLambdas, fixedCallSpan) ||
            StatementUsesProvisional(cut, location, skipSubtree, excludeCallLambdas, fixedCallSpan) {
            PrefixPremise.LaterOverload
        } else {
            default(PrefixPremise?)
        }
    }

    // A report can be located on a part of a statement that does not contain the expression it checks: the
    // pattern of an `is`, the `!!` of an assertion, an index argument converted to the indexer's parameter,
    // or a statement inside a lambda/function literal whose signature comes from an enclosing call (#6179,
    // #6229).
    private func StatementUsesProvisional(
        cut PrefixCut,
        location TextLocation,
        skipSubtree SyntaxNode? = nil,
        excludeCallLambdas bool = false,
        fixedCallSpan TextSpan? = nil
    ) bool {
        if cut.ProvisionalTree(location.Text) is not{} tree {
            return false
        }
        return StatementUsesProvisionalCore(
            cut,
            tree,
            location.Span,
            skipSubtree: skipSubtree,
            excludeCallLambdas: excludeCallLambdas,
            fixedCallSpan: fixedCallSpan
        )
    }

    private func StatementUsesProvisionalCore(
        cut PrefixCut,
        tree SyntaxTree,
        span TextSpan,
        skipSubtree SyntaxNode?,
        excludeCallLambdas bool = false,
        fixedCallSpan TextSpan? = nil
    ) bool {
        var statement SyntaxNode? = nil
        let enclosingLambdas = List[SyntaxNode]()
        var node SyntaxNode = tree.Root
        while true {
            var next SyntaxNode? = nil
            for child in node.GetChildren() {
                if child is not SyntaxToken &&
                    child.Span.Start <= span.Start &&
                    span.End <= child.Span.End &&
                    child.Span.Length > 0 {
                    next = child
                    break
                }
            }
            if next == nil {
                break
            }
            if next is LambdaExpressionSyntax || next is FunctionLiteralExpressionSyntax {
                enclosingLambdas.Add(next)
            }
            // A field or a property initializer has no statement; its declaration is the context.
            if next is StatementSyntax || next is FieldDeclarationSyntax || next is PropertyDeclarationSyntax {
                statement = next
            } else if next is BlockExpressionSyntax block &&
                block.Expression is {} tail &&
                tail.Span.Start <= span.Start &&
                span.End <= tail.Span.End {
                statement = tail
            } else if next is LambdaExpressionSyntax lambdaExpr &&
                !(lambdaExpr.Body is BlockStatementSyntax || lambdaExpr.Body is BlockExpressionSyntax) &&
                lambdaExpr.Body.Span.Start <= span.Start &&
                span.End <= lambdaExpr.Body.Span.End {
                statement = lambdaExpr.Body
            }
            node = next
        }
        if statement is {} foundStatement {
            var currentStatement = foundStatement
            while currentStatement is LabeledStatementSyntax labeled {
                currentStatement = labeled.Statement
            }
            let inExpression = currentStatement is ExpressionSyntax
            if HeaderContainsProvisional(
                cut,
                currentStatement,
                currentStatement,
                inExpression,
                false,
                span,
                skipSubtree,
                excludeCallLambdas,
                fixedCallSpan
            ) ||
                (
                cut.LaterOverloadsPossible &&
                    HeaderContainsUnproven(cut, currentStatement, currentStatement, inExpression, span, skipSubtree)
            ) ||
                HeaderUsesProvisionalName(
                cut,
                tree,
                currentStatement,
                4,
                HashSet[object](ReferenceEqualityComparer.Instance),
                skipSubtree,
                span,
                excludeCallLambdas,
                fixedCallSpan
            ) {
                return true
            }
        }
        // A report inside a lambda or function literal without an explicit return type can depend on an
        // enclosing call whose signature or receiver uses a provisional expression (#6229).
        for var i = enclosingLambdas.Count - 1; i >= 0; i-- {
            let lambda = enclosingLambdas[i]
            if skipSubtree != nil && object.ReferenceEquals(lambda, skipSubtree) {
                continue
            }
            if !(
                lambda is LambdaExpressionSyntax ||
                    (lambda is FunctionLiteralExpressionSyntax lit && lit.ReturnTypeClause == nil)
            ) {
                continue
            }
            if EnclosingCallOfArgument(tree, lambda) is {} enclosingCall {
                let enclosingFixedSpan TextSpan? = if cut.IsFixedSignatureCall(enclosingCall) {
                    enclosingCall.Span
                } else {
                    default(TextSpan?)
                }
                return cut.ContainsProvisional(
                    enclosingCall.Location,
                    lambda.Span,
                    excludeCallLambdas: true,
                    fixedCallSpan: enclosingFixedSpan
                ) ||
                    StatementUsesProvisionalCore(
                    cut,
                    tree,
                    enclosingCall.Span,
                    skipSubtree: lambda,
                    excludeCallLambdas: true,
                    fixedCallSpan: enclosingFixedSpan
                )
            }
        }
        return false
    }

    internal func EnclosingCallOfArgumentExact(tree SyntaxTree, expression SyntaxNode, callSpan TextSpan) bool {
        return EnclosingCallOfArgument(tree, expression) is {} call &&
            call.Span.Start == callSpan.Start &&
            call.Span.End == callSpan.End
    }

    private func EnclosingCallOfArgument(tree SyntaxTree, expression SyntaxNode) SyntaxNode? {
        var current SyntaxNode = expression
        while tree.GetParent(current) is {} parent {
            if parent is ParenthesizedExpressionSyntax || parent is NamedArgumentExpressionSyntax {
                current = parent
                continue
            }
            if parent is CallExpressionSyntax || parent is BaseInterfaceCallExpressionSyntax {
                return parent
            }
            return nil
        }
        return nil
    }

    // A statement can read a variable whose type an earlier statement inferred from a provisional
    // expression, through any form of read (an assignment target, the `await` of an `async let`, a narrowed
    // read, the call of a function value). The check is by name, so it errs toward a provisional report: a
    // name of the header that an earlier statement in scope, or an enclosing statement's header, also
    // contains, where that statement uses a provisional expression, directly or by another such name.
    private func HeaderUsesProvisionalName(
        cut PrefixCut,
        tree SyntaxTree,
        statement SyntaxNode,
        depth int32,
        visited HashSet[object],
        skipSubtree SyntaxNode? = nil,
        report TextSpan? = nil,
        excludeCallLambdas bool = false,
        fixedCallSpan TextSpan? = nil
    ) bool {
        // The search errs toward a provisional report when it runs out of depth.
        if depth < 0 {
            return true
        }
        if !visited.Add(statement) {
            return false
        }
        let names = HashSet[string](StringComparer.Ordinal)
        CollectHeaderNames(
            statement,
            statement,
            statement is ExpressionSyntax,
            names,
            declared: false,
            skipSubtree: skipSubtree,
            report: report,
            declaredSpans: nil,
            excludeCallLambdas: excludeCallLambdas,
            fixedCallSpan: fixedCallSpan
        )
        if names.Count == 0 {
            return false
        }
        let earlier = List[SyntaxNode]()
        var current SyntaxNode = statement
        while tree.GetParent(current) is {} parent {
            if parent is StatementSyntax && parent is not BlockStatementSyntax {
                earlier.Add(parent)
            }
            for sibling in parent.GetChildren() {
                if sibling.Span.End <= statement.Span.Start &&
                    (sibling is StatementSyntax || sibling is GlobalStatementSyntax) {
                    earlier.Add(sibling)
                }
            }
            current = parent
        }
        // A global is visible in every member, wherever its statement is, also in another tree.
        for member in tree.Root.Members {
            if member is GlobalStatementSyntax global && !(global.Span.End <= statement.Span.Start) {
                earlier.Add(global)
            }
        }
        for other in cut.ProvisionalTreeList() {
            if !object.ReferenceEquals(other, tree) {
                for member in other.Root.Members {
                    if member is GlobalStatementSyntax global {
                        earlier.Add(global)
                    }
                }
            }
        }
        for entry in earlier {
            var candidate SyntaxNode = if entry is GlobalStatementSyntax global {
                global.Statement
            } else {
                entry
            }
            while candidate is LabeledStatementSyntax labeled {
                candidate = labeled.Statement
            }
            let declared = HashSet[string](StringComparer.Ordinal)
            let declaredSpans = Dictionary[string, TextSpan](StringComparer.Ordinal)
            CollectHeaderNames(
                candidate,
                candidate,
                false,
                declared,
                declared: true,
                skipSubtree: nil,
                report: nil,
                declaredSpans: declaredSpans
            )
            if !declared.Overlaps(names) {
                continue
            }
            var candidateUsesProvisional = false
            for matchedName in names {
                if declaredSpans.TryGetValue(matchedName, out var declSpan) &&
                    HeaderContainsProvisional(cut, candidate, candidate, false, false, declSpan, nil) {
                    candidateUsesProvisional = true
                    break
                }
            }
            if candidateUsesProvisional || HeaderUsesProvisionalName(cut, tree, candidate, depth - 1, visited) {
                return true
            }
        }
        return false
    }

    // With nothing after the cut, a call, a member access or an index expression of a statement's header
    // counts as provisional unless the binder showed it to be fixed, so a binding path without a record
    // errs toward a provisional report (#6179).
    // A node that contains the report is still binding when the binder reports inside it; the premises of
    // its call frame cover such a report.
    private func HeaderContainsUnproven(
        cut PrefixCut,
        statement SyntaxNode,
        node SyntaxNode,
        inExpression bool,
        report TextSpan,
        skipSubtree SyntaxNode? = nil
    ) bool {
        if skipSubtree != nil && object.ReferenceEquals(node, skipSubtree) {
            return false
        }
        if node is NameOfExpressionSyntax {
            return false
        }
        if node is InterpolatedStringExpressionSyntax {
            for child in node.GetChildren() {
                if child is not SyntaxToken && child.Span.Start <= report.Start && report.End <= child.Span.End {
                    if HeaderContainsUnproven(cut, statement, child, true, report, skipSubtree) {
                        return true
                    }
                }
            }
            return false
        }
        let containsReport = node.Span.Start <= report.Start && report.End <= node.Span.End
        if (node is CallExpressionSyntax || node is IndexExpressionSyntax || IsOutermostAccessor(node)) &&
            !containsReport &&
            !cut.IsFixed(node) {
            return true
        }
        for child in node.GetChildren() {
            if child is SyntaxToken {
                continue
            }
            if !inExpression && child is StatementSyntax && !object.ReferenceEquals(child, statement) {
                continue
            }
            if child is FunctionLiteralExpressionSyntax || child is LambdaExpressionSyntax {
                continue
            }
            if HeaderContainsUnproven(
                cut,
                statement,
                child,
                inExpression || child is ExpressionSyntax,
                report,
                skipSubtree
            ) {
                return true
            }
        }
        return false
    }

    private func IsOutermostAccessor(node SyntaxNode) bool -> node is AccessorExpressionSyntax &&
        !(node.Parent is AccessorExpressionSyntax parent && object.ReferenceEquals(parent.RightPart, node))

    // The identifiers of a statement's header, not those of its nested statements or of a function
    // literal's body. With [`declared`](paramref), the names that it declares or writes (an identifier that
    // is not a read in an expression, or the target of an assignment); otherwise the simple names that it
    // reads (not the member name of an access).
    private func CollectHeaderNames(
        statement SyntaxNode,
        node SyntaxNode,
        inExpression bool,
        names HashSet[string],
        declared bool,
        skipSubtree SyntaxNode? = nil,
        report TextSpan? = nil,
        declaredSpans Dictionary[string, TextSpan]? = nil,
        excludeCallLambdas bool = false,
        fixedCallSpan TextSpan? = nil
    ) {
        if skipSubtree != nil && object.ReferenceEquals(node, skipSubtree) {
            return
        }
        if !declared && node is NameOfExpressionSyntax {
            return
        }
        if !declared && node is InterpolatedStringExpressionSyntax {
            if report is {} reportSpan {
                for child in node.GetChildren() {
                    if child is not SyntaxToken &&
                        child.Span.Start <= reportSpan.Start &&
                        reportSpan.End <= child.Span.End {
                        CollectHeaderNames(
                            statement,
                            child,
                            true,
                            names,
                            declared,
                            skipSubtree,
                            report,
                            declaredSpans,
                            excludeCallLambdas,
                            fixedCallSpan
                        )
                    }
                }
            }
            return
        }
        for child in node.GetChildren() {
            if child is SyntaxToken token {
                if token.Kind == SyntaxKind.IdentifierToken && !token.IsMissing && IsNameOfKind(node, token, declared) {
                    names.Add(token.ValueText)
                    if declared && declaredSpans != nil {
                        declaredSpans[token.ValueText] = token.Span
                    }
                }
                continue
            }
            if skipSubtree != nil && object.ReferenceEquals(child, skipSubtree) {
                continue
            }
            if !inExpression && child is StatementSyntax && !object.ReferenceEquals(child, statement) {
                continue
            }
            if child is FunctionLiteralExpressionSyntax {
                continue
            }
            if child is LambdaExpressionSyntax l {
                if declared {
                    continue
                }
                if excludeCallLambdas {
                    if fixedCallSpan is {} callSpan {
                        if EnclosingCallOfArgumentExact(l.SyntaxTree, l, callSpan) {
                            continue
                        }
                    }
                    if l.Body is BlockExpressionSyntax || l.Body is BlockStatementSyntax {
                        if l.Body is BlockExpressionSyntax block {
                            if block.Expression is {} tail {
                                CollectHeaderNames(
                                    statement,
                                    tail,
                                    true,
                                    names,
                                    declared,
                                    skipSubtree,
                                    report,
                                    declaredSpans,
                                    excludeCallLambdas,
                                    fixedCallSpan
                                )
                            }
                            let blockReturns = List[ReturnStatementSyntax]()
                            for stmt in block.Statements {
                                if stmt is ReturnStatementSyntax ret {
                                    blockReturns.Add(ret)
                                } else {
                                    CollectBlockReturnStatements(stmt, blockReturns)
                                }
                            }
                            for ret in blockReturns {
                                CollectHeaderNames(
                                    statement,
                                    ret,
                                    false,
                                    names,
                                    declared,
                                    skipSubtree,
                                    report,
                                    declaredSpans,
                                    excludeCallLambdas,
                                    fixedCallSpan
                                )
                            }
                        }
                        continue
                    }
                }
            }
            CollectHeaderNames(
                statement,
                child,
                inExpression || child is ExpressionSyntax,
                names,
                declared,
                skipSubtree,
                report,
                declaredSpans,
                excludeCallLambdas,
                fixedCallSpan
            )
        }
    }

    // Whether an identifier whose parent is [`parent`](paramref) declares a name (with
    // [`declared`](paramref)) or reads a simple name.
    private func IsNameOfKind(parent SyntaxNode, token SyntaxToken, declared bool) bool {
        if parent is AssignmentExpressionSyntax {
            return true
        }
        if parent is MultiAssignmentDeclarationExpressionSyntax multiDecl {
            return declared && object.ReferenceEquals(token, multiDecl.Identifier)
        }
        if parent is IndexAssignmentExpressionSyntax indexAssign {
            return !declared && object.ReferenceEquals(token, indexAssign.TargetIdentifier)
        }
        if parent is FieldAssignmentExpressionSyntax fieldAssign {
            return !declared && object.ReferenceEquals(token, fieldAssign.Receiver)
        }
        if declared && parent is NameExpressionSyntax && parent.Parent is MultiAssignmentStatementSyntax multi {
            for target in multi.Targets {
                if object.ReferenceEquals(target, parent) {
                    return true
                }
            }
            return false
        }
        let read = (
            parent is NameExpressionSyntax || parent is CallExpressionSyntax || parent is GenericNameExpressionSyntax
        ) &&
            !IsMemberName(parent)
        return if declared {
            parent is not ExpressionSyntax
        } else {
            read
        }
    }

    private func IsMemberName(node SyntaxNode) bool -> node.Parent is AccessorExpressionSyntax accessor &&
        object.ReferenceEquals(accessor.RightPart, node)

    /// Returns a value that tells whether a later declaration can change the type of
    /// [`variable`](paramref): the type is inferred from an expression whose type can change (#6179).
    /// @param variable A local or a global that a name refers to.
    /// @returns `true` when a reference to the variable has a type that can change.
    internal func IsProvisionalVariable(variable VariableSymbol) bool {
        if current.Value is not{} cut || variable is ParameterSymbol || variable.DeclaringSyntax is not{} declaration {
            return false
        }
        if declaration is VariableDeclarationSyntax typed && typed.TypeClause != nil {
            return false
        }
        let anyCall = variable is GlobalVariableSymbol && cut.LaterOverloadsPossible
        if !anyCall && !cut.HasProvisional {
            return false
        }
        let tree = declaration.SyntaxTree
        var statement SyntaxNode = declaration
        while statement is not StatementSyntax && tree.GetParent(statement) is {} parent {
            statement = parent
        }
        // A global can be read in another body, which can bind first or come from the body cache. Any call
        // in its declaration then counts (anyCall).
        return HeaderContainsProvisional(cut, statement, statement, false, anyCall, declaration.Span, nil)
    }

    // The declaration part of [`statement`](paramref): the nested statements of a compound statement (the
    // body of a `for` or an `if`) do not type its variables, but every part of an expression can, except
    // the body of a function literal.
    private func HeaderContainsProvisional(
        cut PrefixCut,
        statement SyntaxNode,
        node SyntaxNode,
        inExpression bool,
        anyCall bool,
        report TextSpan?,
        skipSubtree SyntaxNode?,
        excludeCallLambdas bool = false,
        fixedCallSpan TextSpan? = nil
    ) bool {
        if skipSubtree != nil && object.ReferenceEquals(node, skipSubtree) {
            return false
        }
        if node is NameOfExpressionSyntax {
            return false
        }
        if node is InterpolatedStringExpressionSyntax {
            if report is {} reportSpan {
                for child in node.GetChildren() {
                    if child is not SyntaxToken &&
                        child.Span.Start <= reportSpan.Start &&
                        reportSpan.End <= child.Span.End {
                        if HeaderContainsProvisional(
                            cut,
                            statement,
                            child,
                            true,
                            anyCall,
                            report,
                            skipSubtree,
                            excludeCallLambdas,
                            fixedCallSpan
                        ) {
                            return true
                        }
                    }
                }
            }
            return false
        }
        if cut.IsProvisional(node) || (anyCall && node is CallExpressionSyntax) {
            return true
        }
        for child in node.GetChildren() {
            if child is SyntaxToken {
                continue
            }
            if skipSubtree != nil && object.ReferenceEquals(child, skipSubtree) {
                continue
            }
            if !inExpression && child is StatementSyntax && !object.ReferenceEquals(child, statement) {
                continue
            }
            // A function literal declares its return type, so its body does not change its type.
            if child is FunctionLiteralExpressionSyntax {
                continue
            }
            if excludeCallLambdas && child is LambdaExpressionSyntax lambdaChild {
                if fixedCallSpan is {} callSpan {
                    if EnclosingCallOfArgumentExact(lambdaChild.SyntaxTree, lambdaChild, callSpan) {
                        continue
                    }
                }
                if lambdaChild.Body is BlockExpressionSyntax block {
                    if block.Expression is {} tail &&
                        HeaderContainsProvisional(
                        cut,
                        statement,
                        tail,
                        true,
                        anyCall,
                        report,
                        skipSubtree,
                        excludeCallLambdas,
                        fixedCallSpan
                    ) {
                        return true
                    }
                    let blockReturns = List[ReturnStatementSyntax]()
                    for stmt in block.Statements {
                        if stmt is ReturnStatementSyntax ret {
                            blockReturns.Add(ret)
                        } else {
                            CollectBlockReturnStatements(stmt, blockReturns)
                        }
                    }
                    for ret in blockReturns {
                        if HeaderContainsProvisional(
                            cut,
                            statement,
                            ret,
                            false,
                            anyCall,
                            report,
                            skipSubtree,
                            excludeCallLambdas,
                            fixedCallSpan
                        ) {
                            return true
                        }
                    }
                    continue
                }
                if lambdaChild.Body is BlockStatementSyntax {
                    continue
                }
            }
            if HeaderContainsProvisional(
                cut,
                statement,
                child,
                inExpression || child is ExpressionSyntax,
                anyCall,
                report,
                skipSubtree,
                excludeCallLambdas,
                fixedCallSpan
            ) {
                return true
            }
        }
        return false
    }

    private func CollectBlockReturnStatements(node SyntaxNode, returns List[ReturnStatementSyntax]) {
        for child in node.GetChildren() {
            if child is SyntaxToken ||
                child is LambdaExpressionSyntax ||
                child is FunctionLiteralExpressionSyntax ||
                child is NameOfExpressionSyntax {
                continue
            }
            if child is ReturnStatementSyntax ret {
                returns.Add(ret)
                continue
            }
            CollectBlockReturnStatements(child, returns)
        }
    }

    /// Returns a value that tells whether the type of [`value`](paramref) comes from the parameter that
    /// it fills, so that a diagnostic inside it can depend on the candidate (ADR-0225 D6.5).
    /// @param value An argument expression.
    /// @returns `false` for an expression that has a type of its own.
    internal func IsTypedByCandidate(value ExpressionSyntax) bool {
        var current = value
        while current is ParenthesizedExpressionSyntax parenthesized {
            current = parenthesized.Expression
        }
        if current is BinaryExpressionSyntax binary {
            return binary.OperatorToken.Kind == SyntaxKind.QuestionQuestionToken
        }
        if current is LiteralExpressionSyntax literal {
            return literal.LiteralToken.Kind == SyntaxKind.NilKeyword
        }
        return !(
            current is NameExpressionSyntax ||
                current is GenericNameExpressionSyntax ||
                current is AccessorExpressionSyntax ||
                current is CallExpressionSyntax ||
                current is UnaryExpressionSyntax ||
                current is InterpolatedStringExpressionSyntax ||
                current is TypeOfExpressionSyntax ||
                current is SizeOfExpressionSyntax ||
                current is NameOfExpressionSyntax ||
                current is IsExpressionSyntax ||
                current is AsExpressionSyntax ||
                current is ObjectCreationExpressionSyntax ||
                current is ArrayCreationExpressionSyntax ||
                current is AwaitExpressionSyntax ||
                current is IndexExpressionSyntax ||
                current is RefArgumentExpressionSyntax
        )
    }

    /// Returns a value that tells whether [`node`](paramref) is open at the cut: its last token is a
    /// closing token that the parser added at the cut.
    /// @param node A syntax node, or `null`.
    /// @returns `true` for an open node of a prefix tree. It is `false` for every node of a complete program.
    internal func IsOpen(node SyntaxNode?) bool {
        if node == nil || node.SyntaxTree.Prefix is not{} cut || node.Span.End != cut.Cut {
            return false
        }
        var current SyntaxNode = node
        while current is not SyntaxToken {
            let count = current.ChildCount
            if count == 0 {
                return false
            }
            current = current.GetChild(count - 1)
        }
        return cast[SyntaxToken](current).IsSealedAtCut
    }

    /// Returns a value that tells whether a type can still get members after the cut: it is open at the
    /// cut, one of its partial parts is open, or it is partial and nothing follows the cut.
    /// @param syntax A type declaration. For a partial type it is the node that merges the parts.
    /// @returns `true` when a later declaration can add a member to the type.
    internal func IsIncompleteType(syntax StructDeclarationSyntax) bool {
        if IsOpen(syntax) {
            return true
        }
        if !syntax.IsPartial || current.Value is not{} cut {
            return false
        }
        if cut.Remainder == PrefixRemainder.Nothing {
            return true
        }
        if cut.Tree is not{} tree {
            return false
        }
        for part in syntax.PartialPartLocations {
            if object.ReferenceEquals(part.Text, cut.Text) && IsOpen(TypeDeclarationAt(tree, part.Span.Start)) {
                return true
            }
        }
        return false
    }

    // The innermost type declaration of [`tree`](paramref) that contains [`position`](paramref).
    private func TypeDeclarationAt(tree SyntaxTree, position int32) StructDeclarationSyntax? {
        var found StructDeclarationSyntax? = nil
        var node SyntaxNode = tree.Root
        while true {
            if node is StructDeclarationSyntax declaration {
                found = declaration
            }
            var next SyntaxNode? = nil
            for child in node.GetChildren() {
                if child.Span.Start <= position && position < child.Span.End {
                    next = child
                    break
                }
            }
            if next == nil {
                return found
            }
            node = next
        }
        return found
    }

    /// Returns a value that tells whether [`node`](paramref) is the last construct before the cut: it
    /// ends at or before the cut and no later token of its parent starts before the cut. A clause of the
    /// construct (a `catch` after a `try` block) can still follow.
    /// @param node A syntax node, or `null`.
    /// @returns `true` for the last construct before the cut of a prefix tree.
    internal func IsLastBeforeCut(node SyntaxNode?) bool {
        if node == nil || node.SyntaxTree.Prefix is not{} cut || node.Span.End > cut.Cut {
            return false
        }
        var current SyntaxNode = node
        while node.SyntaxTree.GetParent(current) is {} parent {
            var after = false
            for sibling in parent.GetChildren() {
                if object.ReferenceEquals(sibling, current) {
                    after = true
                } else if after &&
                    sibling.Span.Start < cut.Cut &&
                    !(sibling is SyntaxToken token && token.IsSealedAtCut) {
                    return false
                }
            }
            if parent.Span.End > cut.Cut || IsOpen(parent) {
                return true
            }
            current = parent
        }
        return true
    }

    /// Returns a value that tells whether [`node`](paramref) or one of its ancestors of kind
    /// [`kind`](paramref) is open at the cut.
    /// @param node A syntax node, or `null`.
    /// @param kind The kind of the ancestor.
    /// @returns `true` when the nearest node of that kind is open.
    internal func IsInOpen(node SyntaxNode?, kind SyntaxKind) bool {
        if node == nil || node.SyntaxTree.Prefix == nil {
            return false
        }
        var current SyntaxNode? = node
        while current != nil {
            if current.Kind == kind {
                return IsOpen(current)
            }
            current = node.SyntaxTree.GetParent(current)
        }
        return false
    }

    /// Returns a value that tells whether [`token`](paramref) closes a construct that is open at the cut.
    /// @param token A closing token, or `null`.
    /// @returns `true` for a token that the parser added at the cut.
    internal func IsSealed(token SyntaxToken?) bool -> token != nil && token.IsSealedAtCut
}
