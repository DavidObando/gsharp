// <copyright file="RegionEffectScanner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// The region walker of ADR-0213 section 7 (rules W1 to W7). It maps each
/// syntax kind to its effect class through (cref:RegionEffectKindTable) and
/// composes the effects of a region from syntax alone, before the region is
/// bound. It resolves no name: the consumer resolves the names of a record at
/// the entry scope of the region.
/// @remarks Slice L0 only measures with the walker. Nothing in the binder
/// consumes a record yet. A scanner serves one function body: it caches the
/// record of each loop statement, so a nested loop is walked once (section 7,
/// composition and cost). The walk is single threaded and keeps no hash order
/// in any result: names and call sites are in source order of the walk.
internal sealed class RegionEffectScanner {
    private let topLevelCache Dictionary[SyntaxNode, RegionEffects] = Dictionary[SyntaxNode, RegionEffects]()
    private let nestedCache Dictionary[SyntaxNode, RegionEffects] = Dictionary[SyntaxNode, RegionEffects]()
    private var scopes List[ScopeFrame] = List[ScopeFrame]()
    private var current RegionEffects = RegionEffects()
    private var closureDepth int32 = 0
    // The names that a pattern or a binding declared anywhere in the region so far. A pattern variable
    // of `if x is not T v { return }` is visible after the statement that declares it.
    private var patternNames HashSet[string] = HashSet[string]()
    private var pendingReceiver ExpressionSyntax? = nil
    private var pendingReceiverIsRoot bool = false
    private var pendingReceiverPath RegionReceiverPath? = nil
    // The path of the value that the pattern being visited tests, or `nil` when the walker cannot follow it.
    private var patternSubject RegionReceiverPath? = nil
    // The depth of name-shaped patterns being visited: their names are types or constants, which no getter reads.
    private var constantPatternDepth int32 = 0

    /// The names that one declaration scope holds, and the `ref` locals of the scope with the name
    /// of the variable each one aliases (`nil` when the storage is not a plain variable).
    private sealed class ScopeFrame {
        init() {
            Names = HashSet[string]()
            Kinds = Dictionary[string, string]()
            Aliases = Dictionary[string, string?]()
            LocalAliases = HashSet[string]()
            Origins = Dictionary[string, RegionReceiverPath?]()
        }

        /// Gets the receiver path of each local of the scope whose type the entry scope can resolve: its declared
        /// type, its initializer or the collection it iterates. A local without an entry has no path.
        prop Origins Dictionary[string, RegionReceiverPath?] {
            get;
        }

        /// Gets the `ref` locals of the scope whose storage is a variable that the region declares.
        prop LocalAliases HashSet[string] {
            get;
        }

        /// Gets how each name was declared: `pattern`, `pattern|Type`, `leaked|Type`, `binding` or `local`.
        prop Kinds Dictionary[string, string] {
            get;
        }

        prop Names HashSet[string] {
            get;
        }

        prop Aliases Dictionary[string, string?] {
            get;
        }
    }

    /// Gets the number of syntax nodes this scanner visited. A cached record is not visited again.
    prop NodesVisited int32 {
        get;
        private set;
    }

    /// Gets the number of regions this scanner computed.
    prop Regions int32 {
        get;
        private set;
    }

    /// Scans the region of a loop statement (ADR-0213 section 9, column `R`): the condition, the
    /// body and the post statement, and for the range forms the iteration. The initializer of a
    /// `for` clause and the collection of a range loop run once before the region and are not in
    /// it. The record is cached per loop.
    /// @param loop A loop statement, or a labeled statement that holds one.
    /// @param iterationRunsUserCode Whether the iteration of a range loop runs user code (`MoveNext`,
    /// `Current`, disposal). The binder knows it from the collection's type, which syntax does not show; it
    /// is `false` for an array, a slice or a string. It only applies to the loop itself, not to a nested one.
    func ScanLoop(loop SyntaxNode, iterationRunsUserCode bool = true) RegionEffects {
        var node = loop
        while node is LabeledStatementSyntax labeled {
            node = labeled.Statement
        }
        if topLevelCache.TryGetValue(node, out var cached) {
            return cached
        }
        // A loop with no part that runs once has the same region at the top level and nested.
        let sameWhenNested = !HasPartsThatRunOnce(node)
        if sameWhenNested && nestedCache.TryGetValue(node, out var nested) {
            topLevelCache.Add(node, nested)
            return nested
        }
        let result = ScanFresh(node, true, iterationRunsUserCode)
        topLevelCache.Add(node, result)
        if sameWhenNested {
            nestedCache.Add(node, result)
        }
        return result
    }

    // The initializer of a `for` clause, the bounds of a `for ... in a...b` loop and the collection of a
    // range loop run once before the region (table T3, T5).
    private func HasPartsThatRunOnce(node SyntaxNode) bool -> node.Kind == SyntaxKind.ForClauseStatement ||
        node.Kind == SyntaxKind.ForEllipsisStatement ||
        node.Kind == SyntaxKind.ForRangeStatement ||
        node.Kind == SyntaxKind.ForTupleRangeStatement ||
        node.Kind == SyntaxKind.AwaitForRangeStatement

    /// Scans a run of statements, such as the span of a backward `goto` (section 11). Not cached.
    func ScanStatements(statements IEnumerable[SyntaxNode]) RegionEffects {
        let savedScopes = scopes
        let savedCurrent = current
        scopes = List[ScopeFrame]()
        scopes.Add(ScopeFrame())
        current = RegionEffects()
        let before = NodesVisited
        let list = statements.ToArray()
        VisitList(list)
        current.NodesVisited = NodesVisited - before
        Regions++
        let result = current
        scopes = savedScopes
        current = savedCurrent
        return result
    }

    private func ScanFresh(node SyntaxNode, topLevel bool, iterationRunsUserCode bool = true) RegionEffects {
        let savedScopes = scopes
        let savedCurrent = current
        let savedClosure = closureDepth
        let savedPatterns = patternNames
        scopes = List[ScopeFrame]()
        scopes.Add(ScopeFrame())
        current = RegionEffects()
        closureDepth = 0
        patternNames = HashSet[string]()
        let before = NodesVisited
        VisitLoop(node, topLevel, iterationRunsUserCode)
        current.NodesVisited = NodesVisited - before
        Regions++
        let result = current
        scopes = savedScopes
        current = savedCurrent
        closureDepth = savedClosure
        patternNames = savedPatterns
        return result
    }

    // ---------------------------------------------------------------- scopes

    private func Push() {
        scopes.Add(ScopeFrame())
    }

    private func Pop() {
        scopes.RemoveAt(scopes.Count - 1)
    }

    private func Declare(token SyntaxToken?, declaration string = "local") {
        if token == nil {
            return
        }
        DeclareName(token.ValueText, declaration)
    }

    private func DeclareName(name string, declaration string) {
        if name.Length > 0 && scopes.Count > 0 {
            scopes[scopes.Count - 1].Names.Add(name)
            scopes[scopes.Count - 1].Kinds[name] = declaration
            if declaration != "local" {
                patternNames.Add(name)
            }
        }
    }

    // Gives the pattern variables of the innermost scope the typed kind (`pattern|Type`, rule P7) that the
    // classification of a condition proves for the statement that the condition guards.
    private func RetypePatternNames(names Dictionary[string, string]) {
        if scopes.Count == 0 {
            return
        }
        let frame = scopes[scopes.Count - 1]
        for pair in names {
            if frame.Kinds.TryGetValue(pair.Key, out var kind) && kind.StartsWith("pattern", StringComparison.Ordinal) {
                frame.Kinds[pair.Key] = pair.Value
            }
        }
    }

    // How the innermost declaration of the name was made, or `nil` when the region does not declare it.
    private func DeclarationKind(name string) string? {
        let frame = DeclaringFrame(name)
        if frame < 0 {
            return nil
        }
        return scopes[frame].Kinds[name]
    }

    private func IsDeclared(name string) bool {
        for var i = scopes.Count - 1; i >= 0; i-- {
            if scopes[i].Names.Contains(name) {
                return true
            }
        }
        return false
    }

    // The frame that declares the name, or -1.
    private func DeclaringFrame(name string) int32 {
        for var i = scopes.Count - 1; i >= 0; i-- {
            if scopes[i].Names.Contains(name) {
                return i
            }
        }
        return -1
    }

    // The frame whose declaration the name surely denotes, or -1. A pattern variable with the plain kind
    // `pattern` may be out of the binder's scope where the scanner still holds it (a when-false variable in a
    // then branch, ADR-0166), and a leaked one is out of it in a function with a user label, so a write or a
    // bare read of its name is taken to name other storage.
    private func DeclaringStorageFrame(name string) int32 {
        for var i = scopes.Count - 1; i >= 0; i-- {
            if scopes[i].Kinds.TryGetValue(name, out var kind) && kind != "pattern" && !kind.StartsWith(
                "leaked|",
                StringComparison.Ordinal
            ) {
                return i
            }
        }
        return -1
    }

    private func Active() bool -> closureDepth == 0

    // ---------------------------------------------------------------- dispatch

    private func VisitChildren(node SyntaxNode) {
        for child in node.GetChildren() {
            Visit(child)
        }
    }

    private func VisitList(nodes[]SyntaxNode) {
        for node in nodes {
            Visit(node)
        }
    }

    private func Visit(node SyntaxNode?) {
        if node == nil {
            return
        }
        // The receiver of a member call is valid for the node that follows the dot only.
        let receiver = pendingReceiver
        let receiverIsRoot = pendingReceiverIsRoot
        let receiverPath = pendingReceiverPath
        pendingReceiver = nil
        pendingReceiverIsRoot = false
        pendingReceiverPath = nil
        NodesVisited++
        let kind = node.Kind
        let effectClass = RegionEffectKindTable.Classify(kind)
        switch effectClass {
            case RegionEffectClass.Token {
                return
            }
            case RegionEffectClass.Unknown {
                current.ContainsUnknownKind = true
                VisitChildren(node)
                return
            }
            case RegionEffectClass.DeclarationOnly {
                // A member of an anonymous class can hold a body that assigns a captured name. It is
                // walked like a closure body, so its writes count and its calls do not (rule W7).
                closureDepth++
                VisitChildren(node)
                closureDepth--
                return
            }
            case RegionEffectClass.Loop {
                VisitNestedLoop(node)
                return
            }
            case RegionEffectClass.Closure {
                VisitClosure(node)
                return
            }
            default { }
        }
        switch kind {
            case SyntaxKind.NameOfExpression { }
            case SyntaxKind.ReturnStatement {
                let returnStatement = cast[ReturnStatementSyntax](node)
                if Active() && !returnStatement.IsRefReturn {
                    RecordReturnedValue(returnStatement.Expression)
                }
                VisitChildren(node)
            }
            case SyntaxKind.ConditionalExpression {
                let conditional = cast[ConditionalExpressionSyntax](node)
                VisitCondition(conditional.Condition)
                Visit(conditional.WhenTrue)
                Visit(conditional.WhenFalse)
            }
            case SyntaxKind.NameExpression {
                let read = cast[NameExpressionSyntax](node).IdentifierToken.ValueText
                // A name after a dot is a member of the receiver, not a bare read (rule W5).
                if receiver == nil && Active() && DeclaringStorageFrame(read) < 0 && !current.BareReads.Contains(read) {
                    current.BareReads.Add(read)
                }
            }
            case SyntaxKind.BlockStatement {
                VisitBlock(cast[BlockStatementSyntax](node))
            }
            case SyntaxKind.BlockExpression {
                // The declarations of a block expression are not visible after it.
                let blockExpression = cast[BlockExpressionSyntax](node)
                Push()
                for statement in blockExpression.Statements {
                    Visit(statement)
                }
                Visit(blockExpression.Expression)
                Pop()
            }
            case SyntaxKind.ListPattern {
                // A list pattern reads the length and the elements of its subject (rule W5).
                RecordMemberRead()
                RecordRead(nil, nil)
                VisitChildren(node)
            }
            case SyntaxKind.IfStatement {
                let ifStatement = cast[IfStatementSyntax](node)
                // The initializer scope encloses both arms. The condition and the then branch have a scope
                // of their own, so a pattern variable of the condition is not visible in the else arm.
                Push()
                Visit(ifStatement.Initializer)
                Push()
                VisitCondition(ifStatement.Condition)
                RetypePatternNames(ClassifyCondition(ifStatement.Condition).WhenTrue)
                Visit(ifStatement.ThenStatement)
                Pop()
                Visit(ifStatement.ElseClause)
                Pop()
            }
            case SyntaxKind.IfLetStatement {
                let ifLet = cast[IfLetStatementSyntax](node)
                Push()
                VisitBindings(ifLet.Bindings)
                VisitCondition(ifLet.Guard)
                Visit(ifLet.ThenStatement)
                Pop()
                Visit(ifLet.ElseClause)
            }
            case SyntaxKind.IfLetExpression {
                let ifLet = cast[IfLetExpressionSyntax](node)
                Push()
                VisitBindings(ifLet.Bindings)
                VisitCondition(ifLet.Guard)
                Visit(ifLet.ThenBlock)
                Pop()
                Visit(ifLet.ElseExpression)
            }
            case SyntaxKind.GuardLetStatement {
                let guardLet = cast[GuardLetStatementSyntax](node)
                // The names are visible to the statements that follow the guard.
                VisitBindings(guardLet.Bindings)
                VisitCondition(guardLet.Guard)
                Visit(guardLet.ElseStatement)
            }
            case SyntaxKind.VariableDeclaration {
                VisitVariableDeclaration(cast[VariableDeclarationSyntax](node))
            }
            case SyntaxKind.UsingStatement {
                // The cleanup region runs Dispose on every exit (rule W4).
                if Active() {
                    current.ContainsCall = true
                }
                VisitChildren(node)
            }
            case SyntaxKind.AwaitUsingStatement {
                if Active() {
                    current.ContainsCall = true
                    current.ContainsSuspension = true
                }
                VisitChildren(node)
            }
            case SyntaxKind.FixedStatement {
                let fixedStatement = cast[FixedStatementSyntax](node)
                current.ContainsAliasTake = true
                Visit(fixedStatement.PinnedSource)
                Push()
                Declare(fixedStatement.Identifier)
                Visit(fixedStatement.Body)
                Pop()
            }
            case SyntaxKind.TupleDeconstructionStatement {
                let deconstruction = cast[TupleDeconstructionStatementSyntax](node)
                Visit(deconstruction.Initializer)
                RecordDeconstruction()
                for identifier in deconstruction.Identifiers {
                    Declare(identifier)
                }
            }
            case SyntaxKind.NamedDeconstructionStatement {
                let deconstruction = cast[NamedDeconstructionStatementSyntax](node)
                Visit(deconstruction.Initializer)
                RecordDeconstruction()
                for field in deconstruction.Fields {
                    Declare(field.LocalIdentifier)
                }
            }
            case SyntaxKind.VarPattern {
                Declare(cast[VarPatternSyntax](node).Designation, "pattern")
            }
            case SyntaxKind.TypePattern {
                let pattern = cast[TypePatternSyntax](node)
                // The typed kind (rule P7) is given where the binder scopes the variable (`RetypePatternNames`).
                Declare(pattern.Identifier, "pattern")
                Declare(pattern.Designation, "pattern")
                Visit(pattern.PropertyPattern)
            }
            case SyntaxKind.TypeOrConstantPattern {
                let pattern = cast[TypeOrConstantPatternSyntax](node)
                constantPatternDepth++
                Visit(pattern.Expression)
                constantPatternDepth--
                Visit(pattern.PropertyPattern)
            }
            case SyntaxKind.PropertyPattern {
                let pattern = cast[PropertyPatternSyntax](node)
                Declare(pattern.Designation, "pattern")
                // Each field of the pattern reads a member of the subject (rule W5), and its pattern tests that
                // member. `{ }` is a null test.
                let subject = patternSubject
                for field in pattern.Fields {
                    RecordMemberRead()
                    let name = field.Identifier.ValueText
                    RecordRead(subject, name)
                    patternSubject = subject?.Append(RegionReceiverStepKind.Member, name)
                    Visit(field.Pattern)
                }
                patternSubject = subject
            }
            case SyntaxKind.SlicePattern {
                let pattern = cast[SlicePatternSyntax](node)
                Declare(pattern.CaptureIdentifier, "pattern")
                Visit(pattern.Pattern)
            }
            case SyntaxKind.MultiAssignmentDeclarationExpression {
                Declare(cast[MultiAssignmentDeclarationExpressionSyntax](node).Identifier)
            }
            case SyntaxKind.IsExpression {
                let isExpression = cast[IsExpressionSyntax](node)
                RecordTypeTests(isExpression.Expression, isExpression.Pattern)
                Visit(isExpression.Expression)
                let outer = patternSubject
                patternSubject = BuildPath(isExpression.Expression)
                Visit(isExpression.Pattern)
                patternSubject = outer
            }
            case SyntaxKind.SwitchStatement {
                let switchStatement = cast[SwitchStatementSyntax](node)
                Visit(switchStatement.Expression)
                for switchCase in switchStatement.Cases {
                    RecordTypeTests(switchStatement.Expression, switchCase.Value)
                    Push()
                    let outer = patternSubject
                    patternSubject = BuildPath(switchStatement.Expression)
                    Visit(switchCase.Value)
                    patternSubject = outer
                    VisitCondition(switchCase.Guard)
                    Visit(switchCase.Body)
                    Pop()
                }
            }
            case SyntaxKind.SwitchExpression {
                let switchExpression = cast[SwitchExpressionSyntax](node)
                Visit(switchExpression.Expression)
                for arm in switchExpression.Arms {
                    RecordTypeTests(switchExpression.Expression, arm.Value)
                    Push()
                    let outer = patternSubject
                    patternSubject = BuildPath(switchExpression.Expression)
                    Visit(arm.Value)
                    patternSubject = outer
                    VisitCondition(arm.Guard)
                    Visit(arm.Result)
                    Pop()
                }
            }
            case SyntaxKind.SelectCase {
                let selectCase = cast[SelectCaseSyntax](node)
                if Active() {
                    current.ContainsCall = true
                }
                Visit(selectCase.Channel)
                Visit(selectCase.Value)
                Push()
                Declare(selectCase.Identifier)
                VisitCondition(selectCase.Guard)
                Visit(selectCase.Body)
                Pop()
            }
            case SyntaxKind.TryStatement {
                let tryStatement = cast[TryStatementSyntax](node)
                Visit(tryStatement.TryBlock)
                for clause in tryStatement.CatchClauses {
                    NodesVisited++
                    if Active() {
                        current.ContainsHandler = true
                    }
                    Push()
                    Declare(clause.Identifier)
                    VisitCondition(clause.Filter)
                    Visit(clause.Body)
                    Pop()
                }
                Visit(tryStatement.FinallyClause)
            }
            case SyntaxKind.AssignmentExpression {
                VisitAssignment(cast[AssignmentExpressionSyntax](node))
            }
            case SyntaxKind.EventSubscriptionExpression {
                VisitCompound(cast[EventSubscriptionExpressionSyntax](node))
            }
            case SyntaxKind.NullCoalescingAssignmentExpression {
                VisitNullCoalescingAssignment(cast[NullCoalescingAssignmentExpressionSyntax](node))
            }
            case SyntaxKind.MultiAssignmentStatement {
                VisitMultiAssignment(cast[MultiAssignmentStatementSyntax](node))
            }
            case SyntaxKind.IndexAssignmentExpression,
            SyntaxKind.MemberIndexAssignmentExpression,
            SyntaxKind.CompoundIndexAssignmentExpression,
            SyntaxKind.MemberFieldAssignmentExpression,
            SyntaxKind
                .FieldAssignmentExpression {
                if Active() {
                    current.ContainsMemberWrite = true
                    // A setter or an indexer runs user code.
                    current.ContainsCall = true
                }
                if kind == SyntaxKind.CompoundIndexAssignmentExpression ||
                    kind == SyntaxKind
                    .MemberFieldAssignmentExpression {
                    if Active() {
                        // An operator or a setter can run code.
                        current.ContainsOperatorCandidate = true
                        current.OperatorHasUnresolvedOperand = true
                    }
                }
                VisitChildren(node)
            }
            case SyntaxKind.IndirectAssignmentExpression, SyntaxKind.IndirectCompoundAssignmentExpression {
                if Active() {
                    current.ContainsPointerWrite = true
                    current.ContainsMemberWrite = true
                }
                VisitChildren(node)
            }
            case SyntaxKind.RefArgumentExpression {
                VisitRefArgument(cast[RefArgumentExpressionSyntax](node))
            }
            case SyntaxKind.ConditionalRefArgumentExpression {
                let conditional = cast[ConditionalRefArgumentExpressionSyntax](node)
                Visit(conditional.Condition)
                RecordReferenceOperand(conditional.WhenTrue, conditional.WhenTrueRefKindModifier)
                RecordReferenceOperand(conditional.WhenFalse, conditional.WhenFalseRefKindModifier)
            }
            case SyntaxKind.UnaryExpression {
                VisitUnary(cast[UnaryExpressionSyntax](node))
            }
            case SyntaxKind.BinaryExpression {
                let binary = cast[BinaryExpressionSyntax](node)
                if Active() && binary.OperatorToken.Kind == SyntaxKind.QuestionQuestionToken {
                    // The two operands meet in one type, which a structural projection or a user conversion
                    // may reach (rule W4).
                    current.ContainsConversionCandidate = true
                    current.Conversions.Add(RegionConversion(nil, nil, false))
                }
                if Active() && IsOperatorCandidate(binary) {
                    current.ContainsOperatorCandidate = true
                    RecordOperatorOperand(binary.Left)
                    RecordOperatorOperand(binary.Right)
                    RecordOperator(binary.OperatorToken.Kind, binary.Left, binary.Right)
                } else if Active() &&
                    (
                    binary
                        .OperatorToken
                        .Kind == SyntaxKind.EqualsEqualsToken ||
                        binary
                        .OperatorToken
                        .Kind == SyntaxKind.BangEqualsToken
                ) {
                    // A comparison with `nil` is a null test unless the other operand is a non-nullable value type.
                    let other = if IsNilLiteral(binary.Left) {
                        binary.Right
                    } else {
                        binary.Left
                    }
                    var inner ExpressionSyntax = other
                    while inner is ParenthesizedExpressionSyntax parenthesized {
                        inner = parenthesized.Expression
                    }
                    if inner is NameExpressionSyntax nilOperand {
                        let text = nilOperand.IdentifierToken.ValueText
                        if IsDeclared(text) {
                            // A name of the region may have any type.
                            current.ContainsOperatorCandidate = true
                            current.OperatorHasUnresolvedOperand = true
                        } else if !current.NilCompareOperandNames.Contains(text) {
                            current.NilCompareOperandNames.Add(text)
                        }
                    } else if inner.Kind != SyntaxKind.AccessorExpression && inner.Kind != SyntaxKind.IndexExpression {
                        // A construction or a call may produce a value type: `default(Token) == nil`.
                        current.ContainsOperatorCandidate = true
                        current.OperatorHasUnresolvedOperand = true
                    }
                }
                VisitChildren(node)
            }
            case SyntaxKind.CallExpression {
                VisitCall(cast[CallExpressionSyntax](node), receiver, receiverIsRoot, receiverPath)
            }
            case SyntaxKind.AccessorExpression {
                VisitAccessor(cast[AccessorExpressionSyntax](node), receiver, receiverIsRoot, receiverPath)
            }
            case SyntaxKind.IndexExpression {
                let index = cast[IndexExpressionSyntax](node)
                RecordMemberRead()
                RecordRead(
                    if receiver != nil {
                        AppendPath(receiverPath, index.Target)
                    } else {
                        BuildPath(index.Target)
                    },
                    nil
                )
                // In `a.b[i]` the target `b` is a member of `a`.
                pendingReceiver = receiver
                pendingReceiverIsRoot = receiverIsRoot
                pendingReceiverPath = receiverPath
                Visit(index.Target)
                for argument in index.Indices {
                    Visit(argument)
                }
            }
            case SyntaxKind.FieldAccessExpression {
                RecordMemberRead()
                RecordRead(nil, nil)
                VisitChildren(node)
            }
            case SyntaxKind.GotoStatement, SyntaxKind.LabeledStatement {
                current.ContainsGoto = true
                VisitChildren(node)
            }
            case SyntaxKind.AwaitExpression, SyntaxKind.YieldStatement, SyntaxKind.GoStatement {
                if Active() {
                    current.ContainsCall = true
                    current.ContainsSuspension = true
                }
                VisitChildren(node)
            }
            case SyntaxKind.StructLiteralExpression,
            SyntaxKind.AnonymousClassExpression,
            SyntaxKind
                .ObjectCreationExpression {
                if Active() {
                    current.ContainsCall = true
                    current.Calls.Add(
                        RegionCall(
                            RegionCallKind.Construction,
                            nil,
                            List[string](),
                            List[string](),
                            false,
                            node.Span.Start
                        )
                    )
                }
                VisitChildren(node)
            }
            default {
                // Every other listed kind has the class Structural, Call or Declaration. A Call kind
                // without a case above runs code the walker cannot see (rule W4).
                if effectClass == RegionEffectClass.Call && Active() {
                    current.ContainsCall = true
                }
                VisitChildren(node)
            }
        }
    }

    // ---------------------------------------------------------------- blocks

    private func VisitBlock(block BlockStatementSyntax) {
        Push()
        let statements = block.Statements
        let starts = List[int32]()
        for statement in statements {
            starts.Add(current.Writes.Count)
            Visit(statement)
            DeclareLeakedPatternNames(statement)
        }
        starts.Add(current.Writes.Count)
        // A write before an unconditional exit of its own statement list is on an exit path.
        var exitIndex = -1
        for var i = 0; i < statements.Length; i++ {
            if IsUnconditionalExit(statements[i]) {
                exitIndex = i
                break
            }
        }
        if exitIndex > 0 {
            for var i = starts[0]; i < starts[exitIndex]; i++ {
                current.Writes[i].FollowedByExit = true
            }
        }
        Pop()
    }

    private func IsUnconditionalExit(statement StatementSyntax) bool -> statement.Kind == SyntaxKind.BreakStatement ||
        statement.Kind == SyntaxKind.ReturnStatement ||
        statement.Kind == SyntaxKind.ThrowStatement ||
        statement.Kind == SyntaxKind.RethrowStatement ||
        statement.Kind == SyntaxKind.GotoStatement

    // ADR-0166: `if c { exit }`, a direct statement of a block with no initializer and no else, declares the
    // variables that `c` assigns when false in the block after it, unless the function has a user label. The
    // kind `leaked|Type` leaves that test to the consumer, which knows the function.
    private func DeclareLeakedPatternNames(statement StatementSyntax) {
        if statement is not IfStatementSyntax ifStatement ||
            ifStatement.Initializer != nil ||
            ifStatement.ElseClause != nil ||
            !EndsInExit(ifStatement.ThenStatement) {
            return
        }
        for pair in ClassifyCondition(ifStatement.Condition).WhenFalse {
            DeclareName(
                pair.Key,
                if pair.Value.StartsWith("pattern|", StringComparison.Ordinal) {
                    "leaked|" + pair.Value.Substring("pattern|".Length)
                } else {
                    "pattern"
                }
            )
        }
    }

    private func EndsInExit(statement StatementSyntax) bool {
        if statement is BlockStatementSyntax block {
            return block.Statements.Length > 0 && EndsInExit(block.Statements[block.Statements.Length - 1])
        }
        return statement.Kind == SyntaxKind.BreakStatement ||
            statement.Kind == SyntaxKind.ContinueStatement ||
            statement.Kind == SyntaxKind.ReturnStatement ||
            statement.Kind == SyntaxKind.ThrowStatement ||
            statement.Kind == SyntaxKind.RethrowStatement
    }

    // ADR-0166 as a syntax shape: the pattern variables that a condition assigns when it is true and when it is
    // false, each with its declaration kind. Each set is a subset of what `PatternVariables.Classify` gives the
    // binder, so a typed kind never names a variable that the binder does not scope there. The two operands of
    // `&&`, `||`, `and` and `or` declare different variables, so none is assigned on the paths of both.
    private func ClassifyCondition(condition ExpressionSyntax?)(
        WhenTrue Dictionary[string, string],
        WhenFalse Dictionary[string, string]
    ) {
        switch condition {
            case parenthesized is ParenthesizedExpressionSyntax {
                return ClassifyCondition(parenthesized.Expression)
            }
            case unary is UnaryExpressionSyntax when unary.OperatorToken.Kind == SyntaxKind.BangToken {
                {
                    let (whenTrue, whenFalse) = ClassifyCondition(unary.Operand)
                    return (whenFalse, whenTrue)
                }
            }
            case binary is BinaryExpressionSyntax when binary.OperatorToken.Kind == SyntaxKind.AmpersandAmpersandToken {
                {
                    let (leftTrue, leftFalse) = ClassifyCondition(binary.Left)
                    let (rightTrue, rightFalse) = ClassifyCondition(binary.Right)
                    return (UnionPatternNames(leftTrue, rightTrue), Dictionary[string, string]())
                }
            }
            case binary is BinaryExpressionSyntax when binary.OperatorToken.Kind == SyntaxKind.PipePipeToken {
                {
                    let (leftTrue, leftFalse) = ClassifyCondition(binary.Left)
                    let (rightTrue, rightFalse) = ClassifyCondition(binary.Right)
                    return (Dictionary[string, string](), UnionPatternNames(leftFalse, rightFalse))
                }
            }
            case isExpression is IsExpressionSyntax {
                return ClassifyPatternNames(isExpression.Pattern)
            }
            default {
                return (Dictionary[string, string](), Dictionary[string, string]())
            }
        }
    }

    private func ClassifyPatternNames(pattern PatternSyntax)(
        WhenTrue Dictionary[string, string],
        WhenFalse Dictionary[string, string]
    ) {
        switch pattern {
            case parenthesized is ParenthesizedPatternSyntax {
                return ClassifyPatternNames(parenthesized.Pattern)
            }
            case notPattern is NotPatternSyntax {
                {
                    let (whenTrue, whenFalse) = ClassifyPatternNames(notPattern.Pattern)
                    return (whenFalse, whenTrue)
                }
            }
            case binary is BinaryPatternSyntax when binary.OperatorToken.Text == "and" {
                {
                    let (leftTrue, leftFalse) = ClassifyPatternNames(binary.Left)
                    let (rightTrue, rightFalse) = ClassifyPatternNames(binary.Right)
                    return (UnionPatternNames(leftTrue, rightTrue), Dictionary[string, string]())
                }
            }
            case binary is BinaryPatternSyntax when binary.OperatorToken.Text == "or" {
                {
                    let (leftTrue, leftFalse) = ClassifyPatternNames(binary.Left)
                    let (rightTrue, rightFalse) = ClassifyPatternNames(binary.Right)
                    return (Dictionary[string, string](), UnionPatternNames(leftFalse, rightFalse))
                }
            }
            case typePattern is TypePatternSyntax {
                {
                    let whenTrue = Dictionary[string, string]()
                    if typePattern.BindingIdentifier is {} identifier &&
                        identifier.ValueText != "" &&
                        identifier.ValueText != "_" {
                        let type = typePattern.Type
                        whenTrue[identifier.ValueText] = if type.Identifier == nil ||
                            type.IsArray ||
                            type.IsNullable ||
                            type.HasTypeArguments ||
                            type.IsTuple ||
                            type.IsFunction ||
                            type.IsFunctionPointer {
                            "pattern"
                        } else {
                            "pattern|" + type.DottedName
                        }
                    }
                    return (whenTrue, Dictionary[string, string]())
                }
            }
            default {
                return (Dictionary[string, string](), Dictionary[string, string]())
            }
        }
    }

    private func UnionPatternNames(left Dictionary[string, string], right Dictionary[string, string]) Dictionary[
        string,
        string
    ] {
        let result = Dictionary[string, string](left)
        for pair in right {
            result[pair.Key] = if result.TryGetValue(pair.Key, out var kind) && kind != pair.Value {
                "pattern"
            } else {
                pair.Value
            }
        }
        return result
    }

    private func VisitBindings(bindings SeparatedSyntaxList[IfLetBindingClauseSyntax]) {
        for binding in bindings {
            NodesVisited++
            Visit(binding.Initializer)
            if Active() {
                current.ContainsConversionCandidate = true
            }
            Declare(binding.Identifier, "binding")
        }
    }

    private func VisitVariableDeclaration(declaration VariableDeclarationSyntax) {
        Visit(declaration.Initializer)
        let origin = if declaration.TypeClause != nil {
            TypeOrigin(declaration.TypeClause)
        } else if declaration.Initializer is RefArgumentExpressionSyntax {
            default(RegionReceiverPath?)
        } else {
            BuildPath(declaration.Initializer)
        }
        if Active() && declaration.Initializer is {} initialized {
            current.ContainsConversionCandidate = true
            if declaration.TypeClause != nil {
                RecordConversion(initialized, TypeOrigin(declaration.TypeClause))
            }
        }
        let name = declaration.Identifier.ValueText
        // The storage that a `ref` local names is fixed where it is declared, before a later declaration
        // of the same name can hide it (rule W3).
        var target string? = nil
        var targetIsLocal = false
        var initializer ExpressionSyntax? = declaration.Initializer
        if initializer is RefArgumentExpressionSyntax refArgument {
            initializer = refArgument.Expression
        }
        if initializer != nil {
            target = NameOf(initializer)
        }
        if target != nil {
            let frame = DeclaringFrame(target)
            if frame >= 0 {
                if scopes[frame].Aliases.TryGetValue(target, out var outer) {
                    targetIsLocal = scopes[frame].LocalAliases.Contains(target)
                    target = outer
                } else {
                    targetIsLocal = true
                }
            }
        }
        Declare(declaration.Identifier)
        SetOrigin(name, origin)
        if declaration.HasRefKindModifier && scopes.Count > 0 {
            if Active() {
                current.ContainsAliasTake = true
                if target == nil {
                    current.ContainsMemberWrite = true
                }
            }
            scopes[scopes.Count - 1].Aliases[name] = target
            if targetIsLocal {
                scopes[scopes.Count - 1].LocalAliases.Add(name)
            }
        }
    }

    // ---------------------------------------------------------------- loops

    private func VisitNestedLoop(node SyntaxNode) {
        if nestedCache.TryGetValue(node, out var cached) {
            Compose(cached)
            return
        }
        if !HasPartsThatRunOnce(node) && topLevelCache.TryGetValue(node, out var topLevel) {
            nestedCache.Add(node, topLevel)
            Compose(topLevel)
            return
        }
        let record = ScanFresh(node, false)
        nestedCache.Add(node, record)
        Compose(record)
    }

    // Adds the record of a nested loop to the record of the region. Each write is replayed through the
    // scopes of the enclosing region, so a name declared there is region-local (W1) and a `ref` local
    // reaches its storage (W3). The nested record stays as it was: it is cached and shared.
    private func Compose(record RegionEffects) {
        for write in record.Writes {
            // A callable that an enclosing declaration names like the type takes call binding (probe d2).
            let shadowed = (
                write.Proof == RegionWriteProof.Construction &&
                    write.ConstructedTypeName != nil &&
                    IsDeclared(write.ConstructedTypeName)
            ) ||
                (
                write.Proof == RegionWriteProof.NullAssertion &&
                    write.RightSideName != nil &&
                    IsDeclared(write.RightSideName)
            )
            PlaceWrite(
                write.Name,
                write.Position,
                if shadowed {
                    RegionWriteProof.None
                } else {
                    write.Proof
                },
                write.ConstructedTypeName,
                write.RightSideName,
                write.RightSideDeclaration,
                write.ViaCallArgument,
                write.FollowedByExit
            )
        }
        if Active() {
            for name in record.NilCompareOperandNames {
                if IsDeclared(name) {
                    current.ContainsOperatorCandidate = true
                    current.OperatorHasUnresolvedOperand = true
                }
            }
            for name in record.OperatorOperandNames {
                if IsDeclared(name) {
                    current.OperatorHasUnresolvedOperand = true
                }
            }
            for name in record.ReturnedNames {
                if IsDeclared(name) {
                    current.ContainsConversionCandidate = true
                }
            }
        }
        let bareBefore = current.BareReads.ToArray()
        let callsBefore = current.Calls.Count
        let readsBefore = current.MemberReads.Count
        let operatorsBefore = current.Operators.Count
        let conversionsBefore = current.Conversions.Count
        let testsBefore = current.TypeTests.Count
        current.AbsorbFlags(record, Active())
        // A nested type test of a name that the enclosing region declares tests no entry-scope receiver; the local
        // has a type that its origin does not show.
        for var i = current.TypeTests.Count - 1; i >= testsBefore; i-- {
            let name = current.TypeTests[i].Name
            if IsDeclared(name) {
                SetOrigin(name, nil)
                current.TypeTests.RemoveAt(i)
            }
        }
        // A nested named call whose callee the enclosing region declares calls a function value. A nested member
        // call whose receiver the enclosing region declares has the receiver's origin as its path. An operand that
        // names a `ref` local of the enclosing region names the local's storage. The nested record stays as it was.
        for var i = callsBefore; i < current.Calls.Count; i++ {
            let call = current.Calls[i]
            var kind = call.Kind
            var callee = call.CalleeName
            var receiverName = call.ReceiverName
            var receiver = call.Receiver
            if kind == RegionCallKind.MemberInvocation && receiverName != nil && IsDeclared(receiverName) {
                receiver = OriginOf(receiverName)
                receiverName = nil
            } else if kind == RegionCallKind.MemberInvocation && receiver != nil {
                receiver = Rebase(receiver)
            } else if kind == RegionCallKind.NamedInvocation && callee != nil && IsDeclared(callee) {
                kind = RegionCallKind.ExpressionInvocation
                callee = nil
            }
            let arguments = List[RegionReceiverPath?]()
            for argument in call.Arguments {
                arguments.Add(
                    if argument == nil {
                        default(RegionReceiverPath?)
                    } else {
                        Rebase(argument)
                    }
                )
            }
            current.Calls[i] = RegionCall(
                kind,
                callee,
                RebaseOperands(call.ByReferenceNames),
                RebaseOperands(call.ByValueNames),
                call.HasUnresolvedOperand,
                call.Position,
                receiverName,
                receiver,
                arguments
            )
        }
        for var i = operatorsBefore; i < current.Operators.Count; i++ {
            let rebased = List[RegionReceiverPath?]()
            for operand in current.Operators[i].Operands {
                rebased.Add(
                    if operand == nil {
                        default(RegionReceiverPath?)
                    } else {
                        Rebase(operand)
                    }
                )
            }
            current.Operators[i] = RegionOperator(
                current.Operators[i].Kind,
                rebased,
                current.Operators[i].OperatorForms
            )
        }
        for var i = conversionsBefore; i < current.Conversions.Count; i++ {
            let conversion = current.Conversions[i]
            current.Conversions[i] = RegionConversion(
                if conversion.Source == nil {
                    default(RegionReceiverPath?)
                } else {
                    Rebase(conversion.Source)
                },
                if conversion.Target == nil {
                    default(RegionReceiverPath?)
                } else {
                    Rebase(conversion.Target)
                },
                conversion.SourceIsBuiltInByForm
            )
        }
        for var i = readsBefore; i < current.MemberReads.Count; i++ {
            let read = current.MemberReads[i]
            if read.Receiver != nil {
                current.MemberReads[i] = RegionMemberRead(Rebase(read.Receiver), read.Member)
            }
        }
        // A name that an enclosing declaration of the region hides is no property read.
        for name in record.BareReads {
            if DeclaringStorageFrame(name) >= 0 && !bareBefore.Contains(name) {
                current.BareReads.Remove(name)
            }
        }
    }

    // Visits the parts of a loop statement. At the top level of a region the initializer of a
    // `for` clause and the collection of a range loop are outside it (table T3, T5).
    // A deconstruction calls `Deconstruct`, reads data members or converts the parts to declared types (rule W4).
    private func RecordDeconstruction() {
        if Active() {
            current.ContainsConversionCandidate = true
            current.Conversions.Add(RegionConversion(nil, nil, false))
        }
    }

    // A returned value is converted to the return type, which may select a user conversion (rule W4). The consumer
    // decides a plain name and a constant with their types. A member or element read is an unknown getter already
    // (W5), which removes what a conversion can.
    private func RecordReturnedValue(value ExpressionSyntax?) {
        if value != nil {
            // The value converts to the return type of the enclosing function.
            RecordConversion(value, RootPath(ReturnTypeRoot))
        }
        var inner = value
        while inner is ParenthesizedExpressionSyntax parenthesized {
            inner = parenthesized.Expression
        }
        switch inner {
            case nil { }
            case name is NameExpressionSyntax {
                let text = name.IdentifierToken.ValueText
                if IsDeclared(text) {
                    // A name of the region may have any type.
                    current.ContainsConversionCandidate = true
                } else if !current.ReturnedNames.Contains(text) {
                    current.ReturnedNames.Add(text)
                }
            }
            case literal is LiteralExpressionSyntax {
                if literal.LiteralToken.Kind != SyntaxKind.NilKeyword {
                    current.ReturnsConstant = true
                }
            }
            case NameOfExpressionSyntax {
                current.ReturnsConstant = true
            }
            case AccessorExpressionSyntax, IndexExpressionSyntax { }
            default {
                current.ContainsConversionCandidate = true
            }
        }
    }

    // A condition or a guard is converted to `bool`. Unless it is `bool` by its form, it may select a user
    // conversion (a name, a member read, an element, a block value, a conditional).
    private func VisitCondition(condition ExpressionSyntax?) {
        if condition != nil && Active() && !IsBooleanByForm(condition) {
            current.ContainsConversionCandidate = true
            RecordConversion(condition, RootPath("bool"))
        }
        Visit(condition)
    }

    // A literal `true` or `false`, an `is` test, a comparison, `!`, `&&` or `||`: the binder converts none of
    // them, since `&&` and `||` take `bool` operands. A user operator in a comparison or in `!` is an operator
    // candidate of its own.
    private func IsBooleanByForm(expression ExpressionSyntax) bool {
        switch expression {
            case parenthesized is ParenthesizedExpressionSyntax {
                return IsBooleanByForm(parenthesized.Expression)
            }
            case literal is LiteralExpressionSyntax {
                let token = literal.LiteralToken.Kind
                return token == SyntaxKind.TrueKeyword || token == SyntaxKind.FalseKeyword
            }
            case IsExpressionSyntax {
                return true
            }
            case unary is UnaryExpressionSyntax {
                return unary.OperatorToken.Kind == SyntaxKind.BangToken
            }
            case binary is BinaryExpressionSyntax {
                switch binary.OperatorToken.Kind {
                    case SyntaxKind.AmpersandAmpersandToken,
                    SyntaxKind.PipePipeToken,
                    SyntaxKind.EqualsEqualsToken,
                    SyntaxKind.BangEqualsToken,
                    SyntaxKind.LessToken,
                    SyntaxKind.LessOrEqualsToken,
                    SyntaxKind.GreaterToken,
                    SyntaxKind.GreaterOrEqualsToken {
                        return true
                    }
                    default {
                        return false
                    }
                }
            }
            default {
                return false
            }
        }
    }

    private func VisitLoop(node SyntaxNode, topLevel bool, iterationRunsUserCode bool = true) {
        switch node.Kind {
            case SyntaxKind.WhileStatement {
                let loop = cast[WhileStatementSyntax](node)
                VisitCondition(loop.Condition)
                // A nested loop is scanned in scopes of its own, so the typed kinds end with this scan.
                RetypePatternNames(ClassifyCondition(loop.Condition).WhenTrue)
                Visit(loop.Body)
            }
            case SyntaxKind.ForConditionStatement {
                let loop = cast[ForConditionStatementSyntax](node)
                VisitCondition(loop.Condition)
                // A nested loop is scanned in scopes of its own, so the typed kinds end with this scan.
                RetypePatternNames(ClassifyCondition(loop.Condition).WhenTrue)
                Visit(loop.Body)
            }
            case SyntaxKind.ForClauseStatement {
                let loop = cast[ForClauseStatementSyntax](node)
                Push()
                if !topLevel {
                    Visit(loop.Initializer)
                }
                VisitCondition(loop.Condition)
                Visit(loop.Post)
                RetypePatternNames(ClassifyCondition(loop.Condition).WhenTrue)
                Visit(loop.Body)
                Pop()
            }
            case SyntaxKind.ForInfiniteStatement {
                Visit(cast[ForInfiniteStatementSyntax](node).Body)
            }
            case SyntaxKind.ForEllipsisStatement {
                let loop = cast[ForEllipsisStatementSyntax](node)
                if !topLevel {
                    Visit(loop.LowerBound)
                    Visit(loop.UpperBound)
                }
                Push()
                Declare(loop.Identifier)
                SetOrigin(loop.Identifier.ValueText, BuildPath(loop.LowerBound))
                Visit(loop.Body)
                Pop()
            }
            case SyntaxKind.ForRangeStatement {
                let loop = cast[ForRangeStatementSyntax](node)
                if iterationRunsUserCode {
                    RecordIteration(false)
                }
                if !topLevel {
                    Visit(loop.Collection)
                }
                let element = if loop.TypeClause != nil {
                    TypeOrigin(loop.TypeClause)
                } else {
                    BuildPath(loop.Collection)?.Append(RegionReceiverStepKind.Element, nil)
                }
                Push()
                Declare(loop.FirstIdentifier)
                Declare(loop.SecondIdentifier)
                if loop.SecondIdentifier == nil {
                    SetOrigin(loop.FirstIdentifier.ValueText, element)
                }
                Visit(loop.Body)
                Pop()
            }
            case SyntaxKind.ForTupleRangeStatement {
                let loop = cast[ForTupleRangeStatementSyntax](node)
                if iterationRunsUserCode {
                    RecordIteration(false)
                }
                if !topLevel {
                    Visit(loop.Collection)
                }
                Push()
                for identifier in loop.Identifiers {
                    Declare(identifier)
                }
                Visit(loop.Body)
                Pop()
            }
            case SyntaxKind.AwaitForRangeStatement {
                let loop = cast[AwaitForRangeStatementSyntax](node)
                RecordIteration(true)
                if !topLevel {
                    Visit(loop.Stream)
                }
                Push()
                Declare(loop.Identifier)
                Visit(loop.Body)
                Pop()
            }
            case SyntaxKind.WhileLetStatement {
                let loop = cast[WhileLetStatementSyntax](node)
                Push()
                VisitBindings(loop.Bindings)
                VisitCondition(loop.Guard)
                Visit(loop.Body)
                Pop()
            }
            case SyntaxKind.DoWhileStatement {
                let loop = cast[DoWhileStatementSyntax](node)
                Visit(loop.Body)
                VisitCondition(loop.Condition)
            }
            default {
                current.ContainsUnknownKind = true
                VisitChildren(node)
            }
        }
    }

    // The iteration of a range loop is `MoveNext`, `Current` and disposal (rule W4, table T5).
    private func RecordIteration(suspends bool) {
        if Active() {
            current.ContainsCall = true
            current.ContainsIteration = true
            if suspends {
                current.ContainsSuspension = true
            }
        }
    }

    // ---------------------------------------------------------------- closures

    private func VisitClosure(node SyntaxNode) {
        current.ContainsClosure = true
        switch node.Kind {
            case SyntaxKind.FunctionDeclaration {
                let function = cast[FunctionDeclarationSyntax](node)
                // The name is visible to the statements after it and to its own body.
                Declare(function.Identifier)
                VisitClosureBody(function.Parameters, function.Body)
            }
            case SyntaxKind.FunctionLiteralExpression {
                let literal = cast[FunctionLiteralExpressionSyntax](node)
                VisitClosureBody(literal.Parameters, literal.Body)
            }
            default {
                let lambda = cast[LambdaExpressionSyntax](node)
                VisitClosureBody(lambda.Parameters, lambda.Body)
            }
        }
    }

    // Rule W7: only the writes to captured names count for the region, and its creation is none.
    private func VisitClosureBody(parameters SeparatedSyntaxList[ParameterSyntax], body SyntaxNode?) {
        closureDepth++
        Push()
        for parameter in parameters {
            DeclareParameter(parameter)
        }
        Visit(body)
        Pop()
        closureDepth--
    }

    private func DeclareParameter(parameter ParameterSyntax) {
        Declare(parameter.Identifier)
        if parameter.DeconstructionPattern != nil {
            for element in parameter.DeconstructionPattern.Elements {
                DeclareParameter(element)
            }
        }
    }

    // ---------------------------------------------------------------- writes

    private func VisitAssignment(assignment AssignmentExpressionSyntax) {
        Visit(assignment.Expression)
        RecordWrite(assignment.IdentifierToken.ValueText, assignment.IdentifierToken.Span.Start, assignment.Expression)
    }

    private func VisitCompound(subscription EventSubscriptionExpressionSyntax) {
        Visit(subscription.Value)
        let target = subscription.LeftHandSide
        if target is NameExpressionSyntax name {
            // `x += v` and `x++` read and write the variable. A user-defined operator can also run code.
            RecordWrite(name.IdentifierToken.ValueText, name.IdentifierToken.Span.Start, nil)
            if Active() {
                current.ContainsOperatorCandidate = true
                RecordOperatorOperand(name)
                RecordOperatorOperand(subscription.Value)
                if SyntaxFacts.TryGetCompoundAssignmentBaseOperator(subscription.OperatorToken.Kind, out var baseKind) {
                    RecordOperator(baseKind, name, subscription.Value)
                } else {
                    RecordOperator(subscription.OperatorToken.Kind, name, nil)
                }
            }
        } else {
            // An event subscription, a compound member write or an increment of a member.
            if Active() {
                current.ContainsMemberWrite = true
                current.ContainsCall = true
            }
            Visit(target)
        }
    }

    private func VisitNullCoalescingAssignment(assignment NullCoalescingAssignmentExpressionSyntax) {
        Visit(assignment.Value)
        let target = assignment.Target
        if target is NameExpressionSyntax name {
            RecordWrite(name.IdentifierToken.ValueText, name.IdentifierToken.Span.Start, assignment.Value)
        } else {
            if Active() {
                current.ContainsMemberWrite = true
            }
            Visit(target)
        }
    }

    private func VisitMultiAssignment(statement MultiAssignmentStatementSyntax) {
        if Active() {
            current.ContainsConversionCandidate = true
            current.Conversions.Add(RegionConversion(nil, nil, false))
        }
        for value in statement.Values {
            Visit(value)
        }
        for target in statement.Targets {
            if target is NameExpressionSyntax name {
                RecordWrite(name.IdentifierToken.ValueText, name.IdentifierToken.Span.Start, nil)
            } else if target is MultiAssignmentDeclarationExpressionSyntax declaration {
                NodesVisited++
                Declare(declaration.Identifier)
            } else {
                // Fresh storage is declared above. Anything else writes a member, an element or a pointer.
                if Active() {
                    current.ContainsMemberWrite = true
                }
                Visit(target)
            }
        }
    }

    // Records a write to the name. A write to a `ref` local declared in the region writes the
    // variable it aliases (rule W3). A write to a name declared in the region is region-local (W1).
    private func RecordWrite(name string, position int32, value ExpressionSyntax?) {
        RecordWriteCore(name, position, value, false)
    }

    private func RecordWriteCore(name string, position int32, value ExpressionSyntax?, viaCallArgument bool) {
        var proof = RegionWriteProof.None
        var typeName string? = nil
        var rightName string? = nil
        if Active() && value != nil {
            current.ContainsConversionCandidate = true
            RecordConversion(value, OriginOf(name))
        }
        if value != nil {
            ClassifyProof(value, out proof, out typeName, out rightName)
        }
        var rightDeclaration string? = nil
        if rightName != nil {
            rightDeclaration = DeclarationKind(rightName)
            if rightDeclaration == nil && patternNames.Contains(rightName) {
                // A pattern variable of a closed scope: the name may denote another variable here.
                rightDeclaration = "pattern"
            }
        }
        PlaceWrite(name, position, proof, typeName, rightName, rightDeclaration, viaCallArgument, false)
    }

    // Places a write in the record. A name the region declares is region-local; a `ref` local writes the
    // storage it named when it was declared.
    private func PlaceWrite(
        name string,
        position int32,
        proof RegionWriteProof,
        typeName string?,
        rightName string?,
        rightDeclaration string?,
        viaCallArgument bool,
        followedByExit bool
    ) {
        let frame = DeclaringStorageFrame(name)
        if frame >= 0 {
            if scopes[frame].Aliases.TryGetValue(name, out var target) && !scopes[frame].LocalAliases.Contains(name) {
                if target == nil {
                    if Active() {
                        current.ContainsMemberWrite = true
                    }
                } else {
                    current.AddWrite(
                        RegionWrite(
                            target,
                            position,
                            RegionWriteProof.None,
                            nil,
                            nil,
                            nil,
                            viaCallArgument,
                            followedByExit
                        )
                    )
                }
            }
            return
        }
        current.AddWrite(
            RegionWrite(name, position, proof, typeName, rightName, rightDeclaration, viaCallArgument, followedByExit)
        )
    }

    // The name of the variable a call operand denotes: a `ref` local stands for the storage it names.
    private func OperandName(name string) string {
        let frame = DeclaringFrame(name)
        if frame >= 0 && scopes[frame].Aliases.TryGetValue(name, out var target) && target != nil {
            return target
        }
        return name
    }

    // Proof rule P7 (ADR-0213 section 8) as a syntax shape. The consumer decides with types.
    private func ClassifyProof(
        value ExpressionSyntax,
        out proof RegionWriteProof,
        out typeName string?,
        out rightName string?
    ) {
        proof = RegionWriteProof.None
        typeName = nil
        rightName = nil
        var expression ExpressionSyntax = value
        while expression is ParenthesizedExpressionSyntax parenthesized {
            expression = parenthesized.Expression
        }
        switch expression {
            case literal is LiteralExpressionSyntax {
                if literal.LiteralToken.Kind != SyntaxKind.NilKeyword {
                    proof = RegionWriteProof.NonNilLiteral
                    // The consumer checks that the literal's type converts to the root without an operator.
                    typeName = if literal.LiteralToken.Kind == SyntaxKind.StringToken {
                        "System.String"
                    } else {
                        literal.Value?.GetType().FullName
                    }
                }
            }
            case call is CallExpressionSyntax {
                if call.Callee == nil &&
                    call.TypeArgumentList == nil &&
                    call.NullableQuestionToken == nil &&
                    !IsDeclared(call.Identifier.ValueText) {
                    proof = RegionWriteProof.Construction
                    typeName = call.Identifier.ValueText
                }
            }
            case literal is StructLiteralExpressionSyntax {
                if literal.TypeArgumentList == nil && !IsDeclared(literal.TypeIdentifier.ValueText) {
                    proof = RegionWriteProof.Construction
                    typeName = literal.TypeIdentifier.ValueText
                }
            }
            case unary is UnaryExpressionSyntax {
                if unary.OperatorToken.Kind == SyntaxKind.BangBangToken {
                    proof = RegionWriteProof.NullAssertion
                    var operand ExpressionSyntax = unary.Operand
                    while operand is ParenthesizedExpressionSyntax parenthesized {
                        operand = parenthesized.Expression
                    }
                    if operand is NameExpressionSyntax asserted {
                        rightName = asserted.IdentifierToken.ValueText
                    }
                }
            }
            case name is NameExpressionSyntax {
                rightName = name.IdentifierToken.ValueText
            }
            default { }
        }
    }

    // ---------------------------------------------------------------- operands

    private func VisitUnary(unary UnaryExpressionSyntax) {
        if unary.OperatorToken.Kind == SyntaxKind.AmpersandToken {
            // `&x` writes x through the pointer that the operator creates (rule W3).
            RecordAddressTake(unary.Operand)
            return
        }
        if Active() && IsUnaryOperatorCandidate(unary) {
            current.ContainsOperatorCandidate = true
            RecordOperatorOperand(unary.Operand)
            RecordOperator(unary.OperatorToken.Kind, unary.Operand, nil)
        }
        Visit(unary.Operand)
    }

    private func RecordAddressTake(operand ExpressionSyntax) {
        if Active() {
            current.ContainsAliasTake = true
        }
        let name = NameOf(operand)
        if name != nil {
            RecordWriteCore(name, operand.Span.Start, nil, true)
        } else {
            RecordUnnamedStorageWrite(operand)
            Visit(operand)
        }
    }

    // The storage is an element or a member. A write through the address of an element is a member
    // write. The walker cannot tell a stable member path from storage of unknown origin, so the
    // address of any other operand is a write through a pointer (rule W3).
    private func RecordUnnamedStorageWrite(operand ExpressionSyntax) {
        if Active() {
            current.ContainsMemberWrite = true
            if operand.Kind != SyntaxKind.IndexExpression {
                current.ContainsPointerWrite = true
            }
        }
    }

    private func VisitRefArgument(argument RefArgumentExpressionSyntax) {
        if argument.IsInlineDeclaration {
            // `out var x` declares x in the scope of the statement.
            Declare(argument.DeclarationIdentifier)
            return
        }
        RecordReferenceOperand(argument.Expression, argument.RefKindModifier)
    }

    // A `ref` or `out` operand is a write to its root. An `in` operand is a read.
    private func RecordReferenceOperand(operand ExpressionSyntax?, modifier SyntaxToken?) {
        if operand == nil {
            return
        }
        let text = if modifier == nil {
            "ref"
        } else {
            modifier.Text
        }
        if text == "in" {
            Visit(operand)
            return
        }
        if Active() {
            current.ContainsRefOrOutArgument = true
            current.ContainsAliasTake = true
        }
        let name = NameOf(operand)
        if name != nil {
            RecordWriteCore(name, operand.Span.Start, nil, true)
        } else {
            // The storage is an element or a member. The callee can write it.
            RecordUnnamedStorageWrite(operand)
            Visit(operand)
        }
    }

    // An operand of an operator candidate: a name is resolved by the consumer, a literal is ruled out, anything
    // else may have a user-defined type.
    private func RecordOperatorOperand(operand ExpressionSyntax?) {
        if operand == nil {
            return
        }
        var expression ExpressionSyntax? = operand
        while expression is ParenthesizedExpressionSyntax parenthesized {
            expression = parenthesized.Expression
        }
        if expression is LiteralExpressionSyntax {
            return
        }
        if expression is NameExpressionSyntax name {
            let text = name.IdentifierToken.ValueText
            if IsDeclared(text) {
                // A name of the region may be a variable of any type, and shadow one of the entry scope.
                current.OperatorHasUnresolvedOperand = true
                return
            }
            if !current.OperatorOperandNames.Contains(text) {
                current.OperatorOperandNames.Add(text)
            }
            return
        }
        current.OperatorHasUnresolvedOperand = true
    }

    private func IsNilLiteral(expression ExpressionSyntax) bool {
        var inner ExpressionSyntax = expression
        while inner is ParenthesizedExpressionSyntax parenthesized {
            inner = parenthesized.Expression
        }
        return inner is LiteralExpressionSyntax literal && literal.LiteralToken.Kind == SyntaxKind.NilKeyword
    }

    private func IsOperatorCandidate(binary BinaryExpressionSyntax) bool {
        switch binary.OperatorToken.Kind {
            case SyntaxKind.AmpersandAmpersandToken, SyntaxKind.PipePipeToken, SyntaxKind.QuestionQuestionToken {
                return false
            }
            default {
                // Equality with `nil` is a null test, not a call of a user operator.
                if binary
                    .OperatorToken
                    .Kind == SyntaxKind.EqualsEqualsToken ||
                    binary
                    .OperatorToken
                    .Kind == SyntaxKind.BangEqualsToken {
                    return !IsNilLiteral(binary.Left) && !IsNilLiteral(binary.Right)
                }
                return true
            }
        }
    }

    private func IsUnaryOperatorCandidate(unary UnaryExpressionSyntax) bool {
        switch unary.OperatorToken.Kind {
            case SyntaxKind.PlusToken,
            SyntaxKind.MinusToken,
            SyntaxKind.BangToken,
            SyntaxKind.TildeToken,
            SyntaxKind.PlusPlusToken,
            SyntaxKind.MinusMinusToken {
                return true
            }
            default {
                return false
            }
        }
    }

    // ---------------------------------------------------------------- calls and members

    private func RecordOperator(kind SyntaxKind, left ExpressionSyntax?, right ExpressionSyntax?) {
        let operands = List[RegionReceiverPath?]()
        let operatorForms = List[bool]()
        operands.Add(BuildPath(left))
        operatorForms.Add(IsOperatorForm(left))
        if right != nil {
            operands.Add(BuildPath(right))
            operatorForms.Add(IsOperatorForm(right))
        }
        current.Operators.Add(RegionOperator(kind, operands, operatorForms))
    }

    private func IsOperatorForm(expression ExpressionSyntax?) bool {
        var inner = expression
        while inner is ParenthesizedExpressionSyntax parenthesized {
            inner = parenthesized.Expression
        }
        return inner is BinaryExpressionSyntax ||
            (inner is UnaryExpressionSyntax unary && unary.OperatorToken.Kind != SyntaxKind.BangBangToken)
    }

    // A value converted to the type of [`target`](paramref). An operator or a literal has a built-in value when
    // its operands do (the operator itself is classified as an operator).
    private func RecordConversion(value ExpressionSyntax, target RegionReceiverPath?) {
        var inner ExpressionSyntax = value
        while inner is ParenthesizedExpressionSyntax parenthesized {
            inner = parenthesized.Expression
        }
        // `nil` stores the null value of a reference or nullable target; it calls no conversion operator.
        if IsNilLiteral(inner) {
            return
        }
        var builtInByForm = inner is BinaryExpressionSyntax ||
            inner is LiteralExpressionSyntax ||
            inner is InterpolatedStringExpressionSyntax
        if inner is UnaryExpressionSyntax unary && unary.OperatorToken.Kind != SyntaxKind.BangBangToken {
            builtInByForm = true
        }
        current.Conversions.Add(RegionConversion(BuildPath(value), target, builtInByForm))
    }

    /// The root name of the path that stands for the return type of the enclosing function (no identifier).
    internal const ReturnTypeRoot string = "<return>"

    private func RootPath(name string) RegionReceiverPath -> RegionReceiverPath(
        name,
        false,
        nil,
        nil,
        ImmutableArray[RegionReceiverStep].Empty
    )

    private func RecordRead(receiver RegionReceiverPath?, member string?) {
        if Active() && constantPatternDepth == 0 {
            current.MemberReads.Add(RegionMemberRead(receiver, member))
        }
    }

    private func RecordMemberRead() {
        if Active() {
            current.ContainsMemberRead = true
            current.MemberReadCount++
        }
    }

    // [`receiver`](paramref) is the part before the dot that this accessor follows, or `nil` at the start of a chain.
    private func VisitAccessor(
        accessor AccessorExpressionSyntax,
        receiver ExpressionSyntax?,
        receiverIsRoot bool,
        prefix RegionReceiverPath?
    ) {
        let isRightPartOfAccessor = receiver != nil
        // `a.M(args)` is a call. `a.b` and `a.b.M()` read the member `b`: an unknown getter (rule W5). In
        // `a.b.c`, `a.M().b` and `a.b[i].c` the name `b`, the call `M()` and the index `b[i]` are the left part of
        // the accessor that follows `a.`, and `a` is their receiver.
        if isRightPartOfAccessor {
            pendingReceiver = receiver
            pendingReceiverIsRoot = receiverIsRoot
            pendingReceiverPath = prefix
        }
        Visit(accessor.LeftPart)
        let right = accessor.RightPart
        // The receiver of the call is a plain root only when this accessor does not itself follow a dot.
        let leftPath = if isRightPartOfAccessor {
            AppendPath(prefix, accessor.LeftPart)
        } else {
            BuildPath(accessor.LeftPart)
        }
        if right.Kind != SyntaxKind.CallExpression {
            RecordMemberRead()
            // The member that follows the dot: `a.b`, `a.b.c`, `a.b[i]`; in `a.M().b` the call is no read.
            var first ExpressionSyntax = right
            if first is AccessorExpressionSyntax nested {
                first = nested.LeftPart
            }
            if first is IndexExpressionSyntax indexed {
                first = indexed.Target
            }
            if first is NameExpressionSyntax read {
                RecordRead(leftPath, read.IdentifierToken.ValueText)
            } else if first.Kind != SyntaxKind.CallExpression {
                RecordRead(nil, nil)
            }
        }
        pendingReceiver = accessor.LeftPart
        pendingReceiverIsRoot = !isRightPartOfAccessor
        pendingReceiverPath = leftPath
        Visit(right)
    }

    private func VisitCall(
        call CallExpressionSyntax,
        receiver ExpressionSyntax?,
        receiverIsRoot bool,
        receiverPath RegionReceiverPath?
    ) {
        if Active() {
            current.ContainsCall = true
        }
        var kind = RegionCallKind.NamedInvocation
        if receiver != nil {
            kind = RegionCallKind.MemberInvocation
        } else if call.Callee != nil || IsDeclared(call.Identifier.ValueText) {
            // A callee that the region declares is a function value, which the entry scope cannot resolve.
            kind = RegionCallKind.ExpressionInvocation
        }
        let byReference = List[string]()
        let byValue = List[string]()
        var unresolved = false
        // The consumer resolves a plain receiver at the entry scope, to tell a function value from a method.
        var receiverName string? = nil
        if receiver != nil && receiverIsRoot && NameOf(receiver) is {} plainReceiver && !IsDeclared(plainReceiver) {
            receiverName = plainReceiver
        }
        if receiver != nil && receiverIsRoot {
            let receiverName = NameOf(receiver)
            if receiverName != nil {
                byValue.Add(OperandName(receiverName))
            }
        }
        if call.Callee != nil {
            Visit(call.Callee)
        }
        // The values passed by value, for the consumer's check of argument conversions. A call with an argument
        // passed by reference or by address keeps none (it binds by exact type there).
        var arguments List[RegionReceiverPath?]? = List[RegionReceiverPath?]()
        for argument in call.Arguments {
            if argument is RefArgumentExpressionSyntax or
                ConditionalRefArgumentExpressionSyntax or
                UnaryExpressionSyntax{OperatorToken: {Kind: SyntaxKind.AmpersandToken}} {
                arguments = nil
            } else {
                arguments?.Add(BuildPath(argument))
            }
            switch argument {
                case reference is RefArgumentExpressionSyntax {
                    NodesVisited++
                    let text = reference.RefKindModifier.Text
                    let name = if reference.Expression == nil {
                        default(string?)
                    } else {
                        NameOf(reference.Expression)
                    }
                    if text == "in" {
                        if name != nil {
                            byValue.Add(OperandName(name))
                        }
                    } else if name != nil {
                        byReference.Add(OperandName(name))
                    } else if !reference.IsInlineDeclaration {
                        unresolved = true
                    }
                    VisitRefArgument(reference)
                }
                case conditional is ConditionalRefArgumentExpressionSyntax {
                    unresolved = true
                    Visit(conditional)
                }
                case address is UnaryExpressionSyntax {
                    if address.OperatorToken.Kind == SyntaxKind.AmpersandToken {
                        let name = NameOf(address.Operand)
                        if name != nil {
                            byReference.Add(OperandName(name))
                        } else {
                            unresolved = true
                        }
                    } else if NameOf(address) != nil {
                        byValue.Add(OperandName(NameOf(address)!!))
                    } else {
                        unresolved = true
                    }
                    Visit(address)
                }
                default {
                    let name = NameOf(argument)
                    if name != nil {
                        byValue.Add(OperandName(name))
                    } else if argument.Kind != SyntaxKind.LiteralExpression {
                        unresolved = true
                    }
                    Visit(argument)
                }
            }
        }
        if Active() {
            current.Calls.Add(
                RegionCall(
                    kind,
                    if kind == RegionCallKind.NamedInvocation || kind == RegionCallKind.MemberInvocation {
                        call.Identifier.ValueText
                    } else {
                        default(string?)
                    },
                    byReference,
                    byValue,
                    unresolved,
                    call.Span.Start,
                    receiverName,
                    if kind == RegionCallKind.MemberInvocation && receiverName == nil {
                        receiverPath
                    } else {
                        default(RegionReceiverPath?)
                    },
                    arguments
                )
            )
        }
    }

    // The name of a plain variable operand: a name, through parentheses and `!!`. Otherwise `nil`.
    // ---------------------------------------------------------------- receiver paths

    // The path of an expression whose type the consumer resolves at the entry scope, or `nil`. A local of the
    // region stands for its origin; a name of the entry scope, a named call and a literal are roots.
    private func BuildPath(expression ExpressionSyntax?) RegionReceiverPath? {
        switch expression {
            case nil {
                return nil
            }
            case parenthesized is ParenthesizedExpressionSyntax {
                return BuildPath(parenthesized.Expression)
            }
            case assertion is UnaryExpressionSyntax when assertion.OperatorToken.Kind == SyntaxKind.BangBangToken {
                return BuildPath(assertion.Operand)
            }
            case name is NameExpressionSyntax {
                return OriginOf(name.IdentifierToken.ValueText)
            }
            case call is CallExpressionSyntax {
                if call.Callee != nil || call.TypeArgumentList != nil || IsDeclared(call.Identifier.ValueText) {
                    return nil
                }
                return RegionReceiverPath(
                    call.Identifier.ValueText,
                    true,
                    nil,
                    nil,
                    ImmutableArray[RegionReceiverStep].Empty
                )
            }
            case literal is LiteralExpressionSyntax {
                let type = if literal.LiteralToken.Kind == SyntaxKind.StringToken {
                    "System.String"
                } else {
                    literal.Value?.GetType().FullName
                }
                if type == nil {
                    return nil
                }
                return RegionReceiverPath(nil, false, nil, type, ImmutableArray[RegionReceiverStep].Empty)
            }
            case index is IndexExpressionSyntax {
                return BuildPath(index.Target)?.Append(RegionReceiverStepKind.Index, nil)
            }
            case accessor is AccessorExpressionSyntax {
                return AppendPath(BuildPath(accessor.LeftPart), accessor.RightPart)
            }
            default {
                return nil
            }
        }
    }

    // The path of the part that follows a dot after [`prefix`](paramref).
    private func AppendPath(prefix RegionReceiverPath?, part ExpressionSyntax) RegionReceiverPath? {
        if prefix == nil {
            return nil
        }
        switch part {
            case name is NameExpressionSyntax {
                return prefix.Append(RegionReceiverStepKind.Member, name.IdentifierToken.ValueText)
            }
            case call is CallExpressionSyntax {
                if call.Callee != nil || call.TypeArgumentList != nil {
                    return nil
                }
                return prefix.Append(RegionReceiverStepKind.Call, call.Identifier.ValueText)
            }
            case index is IndexExpressionSyntax {
                return AppendPath(prefix, index.Target)?.Append(RegionReceiverStepKind.Index, nil)
            }
            case accessor is AccessorExpressionSyntax {
                return AppendPath(AppendPath(prefix, accessor.LeftPart), accessor.RightPart)
            }
            default {
                return nil
            }
        }
    }

    // A local of the region stands for its origin (`nil` when it has none); any other name is a root.
    private func OriginOf(name string) RegionReceiverPath? {
        let frame = DeclaringFrame(name)
        if frame >= 0 {
            return if scopes[frame].Origins.TryGetValue(name, out var origin) {
                origin
            } else {
                default(RegionReceiverPath?)
            }
        }
        return RegionReceiverPath(name, false, nil, nil, ImmutableArray[RegionReceiverStep].Empty)
    }

    private func RebaseOperands(names List[string]) List[string] {
        let rebased = List[string](names.Count)
        for name in names {
            rebased.Add(OperandName(name))
        }
        return rebased
    }

    // A path of a nested record whose root the enclosing region declares starts at the root's origin.
    private func Rebase(path RegionReceiverPath) RegionReceiverPath? {
        let root = path.RootName
        if root == nil || !IsDeclared(root) {
            return path
        }
        if path.RootIsCall {
            return nil
        }
        return OriginOf(root)?.Concat(path)
    }

    private func SetOrigin(name string, origin RegionReceiverPath?) {
        let frame = DeclaringFrame(name)
        if frame >= 0 {
            scopes[frame].Origins[name] = origin
        }
    }

    private func TypeOrigin(type TypeClauseSyntax?) RegionReceiverPath? -> if type == nil {
        default(RegionReceiverPath?)
    } else {
        RegionReceiverPath(nil, false, type, nil, ImmutableArray[RegionReceiverStep].Empty)
    }

    // A type test of a plain name narrows the name where the test holds, so a member call on it can bind a
    // member of the tested type (ADR-0213, function values). Only the types that the pattern tests the subject
    // against count: a property or list subpattern tests a member or an element of it.
    private func RecordTypeTests(subject ExpressionSyntax?, pattern PatternSyntax?) {
        if pattern == nil || !Active() {
            return
        }
        let tested = List[PatternSyntax]()
        CollectSubjectTypePatterns(pattern, tested)
        var all = 0
        for node in pattern.DescendantNodesAndSelf() {
            if node is TypePatternSyntax || node is TypeOrConstantPatternSyntax {
                all++
            }
        }
        // A local of the region or a member that a test narrows has a type that its origin does not show.
        if all > tested.Count {
            current.ContainsMemberTypeTest = true
        }
        if tested.Count == 0 {
            return
        }
        if NameOf(subject) is not{} name {
            current.ContainsMemberTypeTest = true
            return
        }
        if IsDeclared(name) {
            SetOrigin(name, nil)
            return
        }
        for node in tested {
            if node is TypePatternSyntax typePattern {
                current.TypeTests.Add(TypeTest(name, typePattern.Type, false))
            } else if node is TypeOrConstantPatternSyntax candidate {
                current.TypeTests.Add(TypeTest(name, candidate.CandidateType, true))
            }
        }
    }

    // The type patterns that test the subject itself, through parentheses, `not`, `and` and `or`.
    private func CollectSubjectTypePatterns(pattern PatternSyntax, tested List[PatternSyntax]) {
        switch pattern {
            case parenthesized is ParenthesizedPatternSyntax {
                CollectSubjectTypePatterns(parenthesized.Pattern, tested)
            }
            case notPattern is NotPatternSyntax {
                CollectSubjectTypePatterns(notPattern.Pattern, tested)
            }
            case binary is BinaryPatternSyntax {
                CollectSubjectTypePatterns(binary.Left, tested)
                CollectSubjectTypePatterns(binary.Right, tested)
            }
            case TypePatternSyntax, TypeOrConstantPatternSyntax {
                tested.Add(pattern)
            }
            default { }
        }
    }

    // The members of a name do not depend on the type arguments or on `?`, so a test of a named type keeps its
    // name and arity. An array, tuple or function type has no name.
    private func TypeTest(name string, type TypeClauseSyntax, mayBeConstant bool) RegionTypeTest {
        if type.Identifier == nil || type.IsArray || type.IsTuple || type.IsFunction || type.IsFunctionPointer {
            return RegionTypeTest(name, nil, 0, mayBeConstant)
        }
        let arity = if type.TypeArguments is {} arguments {
            arguments.Count
        } else {
            0
        }
        return RegionTypeTest(name, type.DottedName, arity, mayBeConstant)
    }

    private func NameOf(expression ExpressionSyntax?) string? {
        var node = expression
        while node != nil {
            if node is ParenthesizedExpressionSyntax parenthesized {
                node = parenthesized.Expression
            } else if node is UnaryExpressionSyntax{OperatorToken: {Kind: SyntaxKind.BangBangToken}} assertion {
                node = assertion.Operand
            } else {
                break
            }
        }
        if node is NameExpressionSyntax name {
            return name.IdentifierToken.ValueText
        }
        return nil
    }
}
