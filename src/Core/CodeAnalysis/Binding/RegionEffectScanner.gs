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
    // Whether the tested value is a built-in operator expression, such as `(n + 1) is == 0`.
    private var patternSubjectIsOperatorForm bool = false
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
            Constants = Dictionary[string, RegionConstantValue]()
        }

        /// Gets the receiver path of each local of the scope whose type the entry scope can resolve: its declared
        /// type, its initializer or the collection it iterates. A local without an entry has no path.
        prop Origins Dictionary[string, RegionReceiverPath?] {
            get;
        }

        prop Constants Dictionary[string, RegionConstantValue] {
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
        let savedClosure = closureDepth
        let savedPatterns = patternNames
        scopes = List[ScopeFrame]()
        scopes.Add(ScopeFrame())
        current = RegionEffects()
        closureDepth = 0
        patternNames = HashSet[string]()
        let before = NodesVisited
        let list = statements.ToArray()
        VisitList(list)
        current.NodesVisited = NodesVisited - before
        Regions++
        let result = current
        scopes = savedScopes
        current = savedCurrent
        closureDepth = savedClosure
        patternNames = savedPatterns
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
            scopes[scopes.Count - 1].Constants.Remove(name)
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
        VisitNode(node)
        // The path of a merged arm is taken where its names are in scope (`if var x = dt; flag { x } else { dto }`).
        if armTargets.Count > 0 && node is ExpressionSyntax arm && armTargets.Remove(arm) {
            armPaths[arm] = BuildPath(arm)
        }
    }

    private func VisitNode(node SyntaxNode?) {
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
                let merge = BeginMerge(node)
                VisitCondition(conditional.Condition)
                Visit(conditional.WhenTrue)
                Visit(conditional.WhenFalse)
                EndMerge(merge)
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
            case SyntaxKind.WithExpression {
                // A `with` copies its receiver and sets each listed member: a member write through a setter that can
                // run user code (rule W4), as a member assignment is.
                if Active() {
                    current.ContainsMemberWrite = true
                    current.ContainsCall = true
                }
                VisitChildren(node)
            }
            case SyntaxKind.ListPattern {
                // A list pattern reads the length and the elements of its subject (rule W5). Its elements test
                // elements, which have no path.
                RecordMemberRead()
                RecordRead(nil, nil)
                let outer = patternSubject
                let outerIsOperatorForm = patternSubjectIsOperatorForm
                patternSubject = nil
                patternSubjectIsOperatorForm = false
                VisitChildren(node)
                patternSubject = outer
                patternSubjectIsOperatorForm = outerIsOperatorForm
            }
            case SyntaxKind.ConstantPattern {
                RecordPatternTest(cast[ConstantPatternSyntax](node).Expression, nil)
                VisitChildren(node)
            }
            case SyntaxKind.RelationalPattern {
                let relational = cast[RelationalPatternSyntax](node)
                // The binder converts the operand to the subject's type, which a conversion operator can do (W4).
                if Active() && relational.Expression !is LiteralExpressionSyntax {
                    current.Conversions.Add(RegionConversion(nil, nil, false))
                }
                // Issue #5688: `== value` and `!= value` bind as the binary operation `subject op value`.
                // Record them as operator candidates, including a literal value.
                let operatorKind = relational.OperatorToken.Kind
                if Active() &&
                    (operatorKind == SyntaxKind.EqualsEqualsToken || operatorKind == SyntaxKind.BangEqualsToken) {
                    if IsNilLiteral(relational.Expression) {
                        // A `nil` comparison is a null test unless the subject type defines `==`, which the consumer checks.
                        if patternSubject is {
                            RootName: {} rootName,
                            RootIsCall: false,
                            RootType: nil,
                            RootLiteralType: nil,
                            Steps: {IsEmpty: true}
                        } &&
                            !IsDeclared(rootName) {
                            if !current.NilCompareOperandNames.Contains(rootName) {
                                current.NilCompareOperandNames.Add(rootName)
                            }
                        } else {
                            if patternSubject is not{Steps: {IsEmpty: false}} {
                                current.ContainsOperatorCandidate = true
                                current.OperatorHasUnresolvedOperand = true
                            }
                            current.NilCompareOperandPaths.Add(patternSubject)
                        }
                    } else {
                        current.ContainsOperatorCandidate = true
                        let operands = List[RegionReceiverPath?]()
                        let operatorForms = List[bool]()
                        operands.Add(patternSubject)
                        operatorForms.Add(patternSubject == nil && patternSubjectIsOperatorForm)
                        operands.Add(BuildPath(relational.Expression))
                        operatorForms.Add(IsOperatorForm(relational.Expression))
                        current.Operators.Add(RegionOperator(operatorKind, operands, operatorForms))
                    }
                }
                VisitChildren(node)
            }
            case SyntaxKind.IfStatement {
                let ifStatement = cast[IfStatementSyntax](node)
                VisitIf(
                    ifStatement.Initializer,
                    ifStatement.Condition,
                    ifStatement.ThenStatement,
                    ifStatement.ElseClause
                )
            }
            case SyntaxKind.IfExpression {
                let ifExpression = cast[IfExpressionSyntax](node)
                let merge = BeginMerge(node)
                VisitIf(
                    ifExpression.Initializer,
                    ifExpression.Condition,
                    ifExpression.ThenBlock,
                    ifExpression.ElseExpression
                )
                EndMerge(merge)
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
                let merge = BeginMerge(node)
                Push()
                VisitBindings(ifLet.Bindings)
                VisitCondition(ifLet.Guard)
                Visit(ifLet.ThenBlock)
                Pop()
                Visit(ifLet.ElseExpression)
                EndMerge(merge)
            }
            case SyntaxKind.GuardLetStatement {
                let guardLet = cast[GuardLetStatementSyntax](node)
                let isStandalone = guardLet.Parent is not BlockStatementSyntax and
                    not GlobalStatementSyntax and
                    not StaticInitializerBlockSyntax
                if isStandalone {
                    Push()
                }
                // The binder binds the else branch after each binding, so a name in it can be an enclosing one (a
                // binding that fails before the name is declared) or a binding. Visiting it before and after the
                // bindings covers every prefix.
                Visit(guardLet.ElseStatement)
                // The names are visible to the statements that follow the guard.
                VisitBindings(guardLet.Bindings)
                VisitCondition(guardLet.Guard)
                Visit(guardLet.ElseStatement)
                if isStandalone {
                    Pop()
                }
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
                let outer = patternSubject
                let outerIsOperatorForm = patternSubjectIsOperatorForm
                patternSubject = TypeOrigin(pattern.Type)
                patternSubjectIsOperatorForm = false
                Visit(pattern.PropertyPattern)
                patternSubject = outer
                patternSubjectIsOperatorForm = outerIsOperatorForm
            }
            case SyntaxKind.TypeOrConstantPattern {
                let pattern = cast[TypeOrConstantPatternSyntax](node)
                if pattern.PropertyPattern == nil {
                    RecordPatternTest(pattern.Expression, TypeTest("", pattern.CandidateType, true))
                    constantPatternDepth++
                    Visit(pattern.Expression)
                    constantPatternDepth--
                }
                let outer = patternSubject
                let outerIsOperatorForm = patternSubjectIsOperatorForm
                patternSubject = TypeOrigin(pattern.CandidateType)
                patternSubjectIsOperatorForm = false
                Visit(pattern.PropertyPattern)
                patternSubject = outer
                patternSubjectIsOperatorForm = outerIsOperatorForm
            }
            case SyntaxKind.BinaryPattern {
                let binary = cast[BinaryPatternSyntax](node)
                Visit(binary.Left)
                let outer = patternSubject
                let outerIsOperatorForm = patternSubjectIsOperatorForm
                if binary.OperatorToken.Text == "and" && TryNarrowPatternSubject(binary.Left, out var narrowed) {
                    patternSubject = narrowed
                    patternSubjectIsOperatorForm = false
                }
                Visit(binary.Right)
                patternSubject = outer
                patternSubjectIsOperatorForm = outerIsOperatorForm
            }
            case SyntaxKind.PropertyPattern {
                let pattern = cast[PropertyPatternSyntax](node)
                Declare(pattern.Designation, "pattern")
                // Each field of the pattern reads a member of the subject (rule W5), and its pattern tests that
                // member. `{ }` is a null test.
                let subject = patternSubject
                let subjectIsOperatorForm = patternSubjectIsOperatorForm
                patternSubjectIsOperatorForm = false
                for field in pattern.Fields {
                    RecordMemberRead()
                    let name = field.Identifier.ValueText
                    RecordRead(subject, name)
                    patternSubject = subject?.Append(RegionReceiverStepKind.Member, name)
                    Visit(field.Pattern)
                }
                patternSubject = subject
                patternSubjectIsOperatorForm = subjectIsOperatorForm
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
                Visit(isExpression.Expression)
                let subject = BuildPath(isExpression.Expression)
                let subjectIsOperatorForm = IsOperatorForm(isExpression.Expression)
                RecordTypeTests(isExpression.Expression, isExpression.Pattern)
                let outer = patternSubject
                let outerIsOperatorForm = patternSubjectIsOperatorForm
                patternSubject = subject
                patternSubjectIsOperatorForm = subjectIsOperatorForm
                Visit(isExpression.Pattern)
                patternSubject = outer
                patternSubjectIsOperatorForm = outerIsOperatorForm
            }
            case SyntaxKind.SwitchStatement {
                let switchStatement = cast[SwitchStatementSyntax](node)
                Visit(switchStatement.Expression)
                let subject = BuildPath(switchStatement.Expression)
                let subjectIsOperatorForm = IsOperatorForm(switchStatement.Expression)
                for switchCase in switchStatement.Cases {
                    RecordTypeTests(switchStatement.Expression, switchCase.Value)
                    Push()
                    let outer = patternSubject
                    let outerIsOperatorForm = patternSubjectIsOperatorForm
                    patternSubject = subject
                    patternSubjectIsOperatorForm = subjectIsOperatorForm
                    Visit(switchCase.Value)
                    patternSubject = outer
                    patternSubjectIsOperatorForm = outerIsOperatorForm
                    VisitCondition(switchCase.Guard)
                    Visit(switchCase.Body)
                    Pop()
                }
            }
            case SyntaxKind.SwitchExpression {
                let switchExpression = cast[SwitchExpressionSyntax](node)
                let merge = BeginMerge(node)
                Visit(switchExpression.Expression)
                let subject = BuildPath(switchExpression.Expression)
                let subjectIsOperatorForm = IsOperatorForm(switchExpression.Expression)
                for arm in switchExpression.Arms {
                    RecordTypeTests(switchExpression.Expression, arm.Value)
                    Push()
                    let outer = patternSubject
                    let outerIsOperatorForm = patternSubjectIsOperatorForm
                    patternSubject = subject
                    patternSubjectIsOperatorForm = subjectIsOperatorForm
                    Visit(arm.Value)
                    patternSubject = outer
                    patternSubjectIsOperatorForm = outerIsOperatorForm
                    VisitCondition(arm.Guard)
                    Visit(arm.Result)
                    Pop()
                }
                EndMerge(merge)
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
                    current.Conversions.Add(RegionConversion(nil, nil, false))
                }
                if Active() && IsOperatorCandidate(binary) {
                    current.ContainsOperatorCandidate = true
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
                    } else if inner.Kind == SyntaxKind.AccessorExpression || inner.Kind == SyntaxKind.IndexExpression {
                        // A member or an element of an imported value type may select its `==` (the consumer checks).
                        current.NilCompareOperandPaths.Add(BuildPath(inner))
                    } else {
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
                RecordIndexAccess(
                    if receiver != nil {
                        AppendPath(receiverPath, index.Target)
                    } else {
                        BuildPath(index.Target)
                    },
                    index,
                    node.Span.Start
                )
                // In `a.b[i]` the target `b` is a member of `a`.
                pendingReceiver = receiver
                pendingReceiverIsRoot = receiverIsRoot
                pendingReceiverPath = receiverPath
                Visit(index.Target)
                for argument in index.Indices {
                    // A range index slices the target without a `System.Range` value (the read is classified).
                    if UnwrapParentheses(argument) is RangeExpressionSyntax sliced {
                        VisitRangeBounds(sliced)
                    } else {
                        Visit(argument)
                    }
                }
            }
            case SyntaxKind.BaseClassCallExpression, SyntaxKind.BaseInterfaceCallExpression {
                // A base call runs the base member, which the walker does not resolve; its inner call is not a call
                // of a function of that name (the bound-tree collector counts it as a call that writes storage).
                if Active() {
                    current.ContainsCall = true
                    current.Calls.Add(
                        RegionCall(RegionCallKind.Other, nil, List[string](), List[string](), true, node.Span.Start)
                    )
                }
                VisitChildren(node)
            }
            case SyntaxKind.FromEndIndexExpression {
                // `^n` constructs a `System.Index` (a constructor is no plain call, ADR-0208 amendment A3).
                RecordConstruction(node)
                VisitChildren(node)
            }
            case SyntaxKind.RangeExpression {
                // A range value constructs a `System.Range`.
                RecordConstruction(node)
                VisitRangeBounds(cast[RangeExpressionSyntax](node))
            }
            case SyntaxKind.ArrayCreationExpression {
                let creation = cast[ArrayCreationExpressionSyntax](node)
                if Active() {
                    let elementType = if creation.ElementTypeClause is {} clause {
                        TypeOrigin(clause)
                    } else if creation.ElementTypeIdentifier is {} identifier && creation.Rank == 1 {
                        RootPath(identifier.ValueText)
                    } else {
                        default(RegionReceiverPath?)
                    }
                    if creation.Elements is {} elements {
                        for element in elements {
                            // A nested array literal of the element type converts by its own elements.
                            if UnwrapParentheses(element) is ArrayCreationExpressionSyntax nested &&
                                NestedArrayHasElementType(creation, nested) {
                                continue
                            }
                            RecordElementConversion(element, elementType)
                        }
                    }
                    RecordLengthConversion(creation.LengthExpression)
                    if creation.Dimensions is {} dimensions {
                        for dimension in dimensions {
                            RecordLengthConversion(dimension)
                        }
                    }
                }
                VisitChildren(node)
            }
            case SyntaxKind.StackAllocExpression {
                let allocation = cast[StackAllocExpressionSyntax](node)
                if Active() {
                    let elementType = RootPath(allocation.ElementTypeIdentifier.ValueText)
                    if allocation.Elements is {} elements {
                        for element in elements {
                            RecordElementConversion(element, elementType)
                        }
                    }
                    RecordLengthConversion(allocation.CountExpression)
                }
                VisitChildren(node)
            }
            case SyntaxKind.MapCreationExpression {
                let creation = cast[MapCreationExpressionSyntax](node)
                if creation.Entries.Count > 0 {
                    // Populating a map calls the key's `GetHashCode` and `Equals` (R17, W4).
                    RecordConstruction(node)
                }
                if Active() {
                    let keyType = TypeOrigin(creation.TypeClause.MapKeyType)
                    let valueType = TypeOrigin(creation.TypeClause.MapValueType)
                    for entry in creation.Entries {
                        RecordElementConversion(entry.Key, keyType)
                        RecordElementConversion(entry.Value, valueType)
                    }
                }
                VisitChildren(node)
            }
            case SyntaxKind.ChannelCreationExpression {
                let creation = cast[ChannelCreationExpressionSyntax](node)
                if Active() {
                    for argument in creation.Arguments {
                        RecordLengthConversion(argument)
                    }
                }
                VisitChildren(node)
            }
            case SyntaxKind.MakeChannelExpression {
                let creation = cast[MakeChannelExpressionSyntax](node)
                if Active() {
                    RecordLengthConversion(creation.Capacity)
                }
                VisitChildren(node)
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
            SyntaxKind.ObjectCreationExpression {
                RecordConstruction(node)
                VisitChildren(node)
            }
            case SyntaxKind.InterpolatedStringExpression {
                let interp = cast[InterpolatedStringExpressionSyntax](node)
                if Active() {
                    current.ContainsCall = true
                    for segment in interp.Segments {
                        if segment.IsExpression && segment.Expression is {} holeExpr {
                            if IsPureStringForm(holeExpr) || IsPureBooleanForm(holeExpr) || IsNilLiteral(holeExpr) {
                                continue
                            }
                            var holePath = BuildPath(holeExpr)
                            if holePath == nil && (IsStringForm(holeExpr) || IsOperatorForm(holeExpr)) {
                                holePath = RegionReceiverPath(
                                    nil,
                                    false,
                                    nil,
                                    "<operator>",
                                    ImmutableArray[RegionReceiverStep].Empty
                                )
                            }
                            current.Calls.Add(
                                RegionCall(
                                    RegionCallKind.MemberInvocation,
                                    "ToString",
                                    List[string](),
                                    List[string](),
                                    false,
                                    node.Span.Start,
                                    nil,
                                    holePath,
                                    nil
                                )
                            )
                        }
                    }
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

    // An `if` statement or expression. The initializer scope encloses both arms. The condition and the then branch
    // have a scope of their own, so a pattern variable of the condition is not visible in the else arm, and no
    // declaration of the initializer is visible after the `if` (as `BindIfExpression` scopes them).
    private func VisitIf(
        initializer StatementSyntax?,
        condition ExpressionSyntax?,
        thenBranch SyntaxNode?,
        elseBranch SyntaxNode?
    ) {
        Push()
        Visit(initializer)
        let classified = ClassifyCondition(condition)
        Push()
        VisitCondition(condition)
        RetypePatternNames(classified.WhenTrue)
        Visit(thenBranch)
        Pop()
        if elseBranch != nil {
            Push()
            for pair in classified.WhenFalse {
                DeclareName(pair.Key, pair.Value)
            }
            Visit(elseBranch)
            Pop()
        }
        Pop()
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
    // variables that `c` assigns when false in the block after it, unless the function has a user label.
    // A `guard let ... && g else { exit }` likewise declares the variables that `g` assigns when true (#4968).
    // The kind `leaked|Type` leaves that test to the consumer, which knows the function.
    private func DeclareLeakedPatternNames(statement StatementSyntax) {
        if statement is GuardLetStatementSyntax guardLet {
            if guardLet.Guard == nil || !EndsInExit(guardLet.ElseStatement) {
                return
            }
            for pair in ClassifyCondition(guardLet.Guard).WhenTrue {
                DeclareName(
                    pair.Key,
                    if pair.Value.StartsWith("pattern|", StringComparison.Ordinal) {
                        "leaked|" + pair.Value.Substring("pattern|".Length)
                    } else {
                        "pattern"
                    }
                )
            }
            return
        }
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

    // The bindings of `if let`, `guard let` or `while let`. A typed binding converts its initializer to the binding's
    // type, and each later initializer sees the earlier bindings (#4968).
    private func VisitBindings(bindings SeparatedSyntaxList[IfLetBindingClauseSyntax]) {
        for binding in bindings {
            NodesVisited++
            Visit(binding.Initializer)
            if Active() && binding.TypeClause != nil {
                RecordConversion(binding.Initializer, TypeOrigin(binding.TypeClause))
            }
            Declare(binding.Identifier, "binding")
        }
    }

    private func VisitVariableDeclaration(declaration VariableDeclarationSyntax) {
        Visit(declaration.Initializer)
        let constant = if declaration.Keyword?.Kind == SyntaxKind.ConstKeyword && !declaration.HasRefKindModifier {
            BuildConstantValue(declaration.Initializer, TypeOrigin(declaration.TypeClause))
        } else {
            default(RegionConstantValue?)
        }
        let origin = if declaration.TypeClause != nil {
            TypeOrigin(declaration.TypeClause)
        } else if declaration.Initializer is RefArgumentExpressionSyntax {
            default(RegionReceiverPath?)
        } else {
            BuildPath(declaration.Initializer)
        }
        if Active() && declaration.Initializer is {} initialized && declaration.TypeClause != nil {
            RecordConversion(initialized, TypeOrigin(declaration.TypeClause))
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
        if constant is {} knownConstant && scopes.Count > 0 {
            scopes[scopes.Count - 1].Constants[name] = if TypeOrigin(declaration.TypeClause) is {} targetType {
                knownConstant.Through(targetType)
            } else {
                knownConstant
            }
        }
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
                // A nested scan does not see a pattern variable of the enclosing region (Q4).
                write.RightSideDeclaration ??
                    (
                    if write.RightSideName is {} rightName {
                        DeclarationKind(rightName)
                    } else {
                        default(string?)
                    }
                ),
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
        }
        let bareBefore = current.BareReads.ToArray()
        let callsBefore = current.Calls.Count
        let indexAccessesBefore = current.IndexAccesses.Count
        let patternIndexAccessesBefore = current.PatternIndexAccesses.Count
        let readsBefore = current.MemberReads.Count
        let patternReadsBefore = current.PatternReads.Count
        let patternTestsBefore = current.PatternTests.Count
        let nilComparesBefore = current.NilCompareOperandPaths.Count
        let operatorsBefore = current.Operators.Count
        let conversionsBefore = current.Conversions.Count
        let testsBefore = current.TypeTests.Count
        current.AbsorbFlags(record, Active())
        // A nested type test of a name that the enclosing region declares tests no entry-scope receiver; the local
        // has a type that its origin does not show.
        for var i = current.TypeTests.Count - 1; i >= testsBefore; i-- {
            let test = current.TypeTests[i]
            let name = test.Name
            if IsDeclared(name) {
                SetOrigin(name, nil)
                current.TypeTests.RemoveAt(i)
            } else if !test.DeclaredInRegion && CandidateUnlessDeclared(test) == nil {
                current.TypeTests[i] = RegionTypeTest(
                    test.Name,
                    test.TypeName,
                    test.Arity,
                    test.MayBeConstant,
                    true,
                    test.TypeClause
                )
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
                arguments,
                call.ArgumentForms,
                call.HasTypeArguments,
                call.Syntax
            )
        }
        RebaseIndexAccesses(current.IndexAccesses, indexAccessesBefore)
        RebaseIndexAccesses(current.PatternIndexAccesses, patternIndexAccessesBefore)
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
                conversion.SourceIsBuiltInByForm,
                conversion.SourceIsNil,
                conversion.OperatorArms,
                conversion.AllowExplicit
            )
        }
        for var i = readsBefore; i < current.MemberReads.Count; i++ {
            let read = current.MemberReads[i]
            if read.Receiver != nil {
                current.MemberReads[i] = RegionMemberRead(Rebase(read.Receiver), read.Member)
            }
        }
        for var i = patternReadsBefore; i < current.PatternReads.Count; i++ {
            let read = current.PatternReads[i]
            if read.Receiver != nil {
                current.PatternReads[i] = RegionMemberRead(Rebase(read.Receiver), read.Member)
            }
        }
        for var i = patternTestsBefore; i < current.PatternTests.Count; i++ {
            let test = current.PatternTests[i]
            current.PatternTests[i] = RegionPatternTest(
                if test.Subject == nil {
                    default(RegionReceiverPath?)
                } else {
                    Rebase(test.Subject)
                },
                if test.Value == nil {
                    default(RegionReceiverPath?)
                } else {
                    Rebase(test.Value)
                },
                test.ValueIsNull,
                CandidateUnlessDeclared(test.Candidate),
                RebaseConstantValue(test.ConstantValue)
            )
        }
        for var i = nilComparesBefore; i < current.NilCompareOperandPaths.Count; i++ {
            if current.NilCompareOperandPaths[i] is {} compared {
                current.NilCompareOperandPaths[i] = Rebase(compared)
            }
        }
        // A name that an enclosing declaration of the region hides is no property read.
        for name in record.BareReads {
            if DeclaringStorageFrame(name) >= 0 && !bareBefore.Contains(name) {
                current.BareReads.Remove(name)
            }
        }
    }

    // Rebases the index accesses that a nested record added from [`before`](paramref) on.
    private func RebaseIndexAccesses(accesses List[RegionCall], before int32) {
        for var i = before; i < accesses.Count; i++ {
            let access = accesses[i]
            let arguments = List[RegionReceiverPath?]()
            for argument in access.Arguments {
                arguments.Add(
                    if argument == nil {
                        default(RegionReceiverPath?)
                    } else {
                        Rebase(argument)
                    }
                )
            }
            accesses[i] = RegionCall(
                access.Kind,
                access.CalleeName,
                access.ByReferenceNames,
                access.ByValueNames,
                false,
                access.Position,
                nil,
                if access.Receiver == nil {
                    default(RegionReceiverPath?)
                } else {
                    Rebase(access.Receiver)
                },
                arguments,
                access.ArgumentForms
            )
        }
    }

    // Visits the parts of a loop statement. At the top level of a region the initializer of a
    // `for` clause and the collection of a range loop are outside it (table T3, T5).
    // A deconstruction calls `Deconstruct`, reads data members or converts the parts to declared types (rule W4).
    private func RecordDeconstruction() {
        if Active() {
            current.Conversions.Add(RegionConversion(nil, nil, false))
        }
    }

    // A returned value is converted to the return type, which may select a user conversion (rule W4).
    private func RecordReturnedValue(value ExpressionSyntax?) {
        if value != nil {
            RecordConversion(value, RootPath(ReturnTypeRoot))
        }
    }

    // A condition or a guard is converted to `bool`. Unless it is `bool` by its form, it may select a user
    // conversion (a name, a member read, an element, a block value, a conditional).
    private func VisitCondition(condition ExpressionSyntax?) {
        if condition != nil && Active() && !IsBooleanByForm(condition) {
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
                RetypePatternNames(ClassifyCondition(loop.Guard).WhenTrue)
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
                RecordConversion(assignment.Value, BuildPath(target))
            }
            Visit(target)
        }
    }

    private func VisitMultiAssignment(statement MultiAssignmentStatementSyntax) {
        if Active() {
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

    private func ArgumentForm(argument ExpressionSyntax) RegionArgumentForm {
        var inner = argument
        while inner is ParenthesizedExpressionSyntax parenthesized {
            inner = parenthesized.Expression
        }
        if inner is RefArgumentExpressionSyntax or
            ConditionalRefArgumentExpressionSyntax or
            UnaryExpressionSyntax{OperatorToken: {Kind: SyntaxKind.AmpersandToken}} {
            return RegionArgumentForm.ByReference
        }
        if inner is NamedArgumentExpressionSyntax {
            return RegionArgumentForm.Named
        }
        if IsNilLiteral(inner) {
            return RegionArgumentForm.Nil
        }
        if inner is LambdaExpressionSyntax or FunctionLiteralExpressionSyntax {
            return RegionArgumentForm.FunctionLiteral
        }
        if IsPureStringForm(inner) || IsPureBooleanForm(inner) {
            return RegionArgumentForm.Path
        }
        if IsStringForm(inner) {
            return RegionArgumentForm.StringByForm
        }
        if IsOperatorForm(inner) || inner is InterpolatedStringExpressionSyntax {
            return RegionArgumentForm.BuiltInByForm
        }
        return RegionArgumentForm.Path
    }

    // An interpolated string, or a `+` with a string literal or interpolated operand. It is a `string` when its
    // operators are predefined; a user-defined `+` (`token + "x"`) can return another type.
    // A string literal, an interpolated string, or a `+` of such operands only: a `string` without any operator
    // of the region.
    private func IsPureStringForm(expression ExpressionSyntax?) bool {
        let inner = UnwrapParentheses(expression)
        if inner is InterpolatedStringExpressionSyntax or NameOfExpressionSyntax {
            return true
        }
        if inner is LiteralExpressionSyntax literal {
            return literal.LiteralToken.Kind == SyntaxKind.StringToken
        }
        return inner is BinaryExpressionSyntax binary &&
            binary
            .OperatorToken
            .Kind == SyntaxKind.PlusToken &&
            IsPureStringForm(binary.Left) &&
            IsPureStringForm(binary.Right)
    }

    // A boolean literal, an `is` test, or `!`, `&&`, `||`, `==` or `!=` of such operands only.
    private func IsPureBooleanForm(expression ExpressionSyntax?) bool {
        let inner = UnwrapParentheses(expression)
        if inner is IsExpressionSyntax {
            return true
        }
        if inner is LiteralExpressionSyntax literal {
            return literal
                .LiteralToken
                .Kind == SyntaxKind.TrueKeyword ||
                literal
                .LiteralToken
                .Kind == SyntaxKind.FalseKeyword
        }
        if inner is UnaryExpressionSyntax unary && unary.OperatorToken.Kind == SyntaxKind.BangToken {
            return IsPureBooleanForm(unary.Operand)
        }
        if inner is BinaryExpressionSyntax binary {
            if binary
                .OperatorToken
                .Kind == SyntaxKind.AmpersandAmpersandToken ||
                binary
                .OperatorToken
                .Kind == SyntaxKind.PipePipeToken {
                return true
            }
            if binary
                .OperatorToken
                .Kind == SyntaxKind.EqualsEqualsToken ||
                binary
                .OperatorToken
                .Kind == SyntaxKind.BangEqualsToken {
                return IsPureBooleanForm(binary.Left) && IsPureBooleanForm(binary.Right)
            }
        }
        return false
    }

    private func IsStringForm(expression ExpressionSyntax?) bool {
        let inner = UnwrapParentheses(expression)
        if inner is InterpolatedStringExpressionSyntax {
            return true
        }
        if inner is LiteralExpressionSyntax literal {
            return literal.LiteralToken.Kind == SyntaxKind.StringToken
        }
        return inner is BinaryExpressionSyntax binary &&
            binary
            .OperatorToken
            .Kind == SyntaxKind.PlusToken &&
            (IsStringForm(binary.Left) || IsStringForm(binary.Right))
    }

    private func IsOperatorForm(expression ExpressionSyntax?) bool {
        var inner = expression
        while inner is ParenthesizedExpressionSyntax parenthesized {
            inner = parenthesized.Expression
        }
        if inner is BinaryExpressionSyntax binary {
            return binary.OperatorToken.Kind != SyntaxKind.QuestionQuestionToken
        }
        return inner is UnaryExpressionSyntax unary && IsUnaryOperatorCandidate(unary)
    }

    // A value converted to the type of [`target`](paramref). An operator or a literal has a built-in value when
    // its operands do (the operator itself is classified as an operator).
    private func RecordConversion(value ExpressionSyntax, target RegionReceiverPath?, allowExplicit bool = false) {
        var inner ExpressionSyntax = value
        while inner is ParenthesizedExpressionSyntax parenthesized {
            inner = parenthesized.Expression
        }
        if inner is DefaultExpressionSyntax{TypeClause: nil} {
            return
        }
        // `nil` stores the null value of a reference or nullable target without an operator. The consumer checks
        // the target, since a non-nullable value type takes `nil` only through a conversion operator.
        if IsNilLiteral(inner) {
            current.Conversions.Add(
                RegionConversion(nil, target, false, sourceIsNil: true, allowExplicit: allowExplicit)
            )
            return
        }
        var builtInByForm = inner is BinaryExpressionSyntax ||
            inner is LiteralExpressionSyntax ||
            inner is InterpolatedStringExpressionSyntax ||
            IsPureBooleanForm(inner)
        if inner is UnaryExpressionSyntax unary && IsUnaryOperatorCandidate(unary) {
            builtInByForm = true
        }
        current.Conversions.Add(RegionConversion(BuildPath(value), target, builtInByForm, allowExplicit: allowExplicit))
    }

    // An element of an array, a stack allocation or a map literal, converted to its element, key or value type
    // (`[]Token{1}`). The consumer checks it for a fact on by-reference storage. For other facts the expression
    // that holds the literal (a declaration, an assignment, an argument or a read) is already a call (rule W4).
    private func RecordElementConversion(element ExpressionSyntax, target RegionReceiverPath?) {
        RecordConversion(element, target)
    }

    // The arms of a conditional, `if`, `if let` or switch expression meet in one type, so each arm is converted to the
    // type of each other arm that is not an operator (`flag ? dt : dto` converts `DateTime` to `DateTimeOffset`,
    // `flag ? nf : 1.0` converts an `NFloat` to `double`); a literal arm is a target of its literal type, and two
    // operator arms meet without an operator only when the operators of the region are predefined. Nested arms are
    // merged into the outermost expression, which records the pairs once; each arm's path is taken when the arm has
    // been visited, in its scopes. An expression with more arms than the bound is one site that can run code.
    private const MaxMergeArms int32 = 8

    private let armTargets HashSet[ExpressionSyntax] = HashSet[ExpressionSyntax](ReferenceEqualityComparer.Instance)
    private let armPaths Dictionary[ExpressionSyntax, RegionReceiverPath?] = Dictionary[
        ExpressionSyntax,
        RegionReceiverPath?
    ](ReferenceEqualityComparer.Instance)
    private let flattenedMerges HashSet[SyntaxNode] = HashSet[SyntaxNode](ReferenceEqualityComparer.Instance)

    private func BeginMerge(node SyntaxNode) List[ExpressionSyntax]? {
        if flattenedMerges.Remove(node) {
            return nil
        }
        let arms = List[ExpressionSyntax]()
        CollectArms(node, arms)
        if arms.Count <= MaxMergeArms {
            for arm in arms {
                armTargets.Add(arm)
            }
        }
        return arms
    }

    private func EndMerge(arms List[ExpressionSyntax]?) {
        guard let merged = arms else {
            return
        }
        let paths = List[RegionReceiverPath?]()
        for arm in merged {
            armTargets.Remove(arm)
            var path RegionReceiverPath? = nil
            if armPaths.Remove(arm, out var captured) {
                path = captured
            }
            paths.Add(path)
        }
        if !Active() {
            return
        }
        if merged.Count > MaxMergeArms {
            current.Conversions.Add(RegionConversion(nil, nil, false))
            return
        }
        var operatorArms = 0
        for var targetIndex = 0; targetIndex < merged.Count; targetIndex++ {
            let target = merged[targetIndex]
            if IsNilLiteral(target) {
                continue
            }
            if IsOperatorForm(target) && paths[targetIndex] == nil {
                operatorArms++
                continue
            }
            for var sourceIndex = 0; sourceIndex < merged.Count; sourceIndex++ {
                if sourceIndex != targetIndex {
                    RecordArmConversion(merged[sourceIndex], paths[sourceIndex], paths[targetIndex])
                }
            }
        }
        if operatorArms >= 2 {
            current.Conversions.Add(RegionConversion(nil, nil, true, false, operatorArms: true))
        }
    }

    // An arm converted to the type of another arm, with the path taken in the arm's scopes.
    private func RecordArmConversion(arm ExpressionSyntax, path RegionReceiverPath?, target RegionReceiverPath?) {
        if IsNilLiteral(arm) {
            current.Conversions.Add(RegionConversion(nil, target, false, sourceIsNil: true))
            return
        }
        let builtInByForm = arm is BinaryExpressionSyntax ||
            arm is LiteralExpressionSyntax ||
            arm is InterpolatedStringExpressionSyntax ||
            IsPureBooleanForm(arm) ||
            (arm is UnaryExpressionSyntax unary && IsUnaryOperatorCandidate(unary))
        current.Conversions.Add(RegionConversion(path, target, builtInByForm))
    }

    private func CollectArms(node SyntaxNode?, arms List[ExpressionSyntax]) {
        switch node {
            case conditional is ConditionalExpressionSyntax {
                AddArm(conditional.WhenTrue, arms)
                AddArm(conditional.WhenFalse, arms)
            }
            case ifExpression is IfExpressionSyntax {
                AddArm(ifExpression.ThenBlock, arms)
                AddArm(ifExpression.ElseExpression, arms)
            }
            case ifLet is IfLetExpressionSyntax {
                AddArm(ifLet.ThenBlock, arms)
                AddArm(ifLet.ElseExpression, arms)
            }
            case switchExpression is SwitchExpressionSyntax {
                for arm in switchExpression.Arms {
                    AddArm(arm.Result, arms)
                }
            }
            default { }
        }
    }

    private func AddArm(arm ExpressionSyntax?, arms List[ExpressionSyntax]) {
        var value = UnwrapParentheses(arm)
        while value is BlockExpressionSyntax block {
            value = UnwrapParentheses(block.Expression)
        }
        switch value {
            case nil { }
            case ConditionalExpressionSyntax, IfExpressionSyntax, IfLetExpressionSyntax, SwitchExpressionSyntax {
                flattenedMerges.Add(value!!)
                CollectArms(value, arms)
            }
            case ThrowExpressionSyntax { }
            default {
                arms.Add(value!!)
            }
        }
    }

    // A length or a dimension of an allocation, converted to `int32`.
    private func RecordLengthConversion(length ExpressionSyntax?) {
        if length != nil {
            RecordElementConversion(length, RootPath("int32"))
        }
    }

    // A construction: a struct literal, an object creation, an anonymous class, or the `System.Index` or
    // `System.Range` that `^n` and `a..b` make.
    private func RecordConstruction(node SyntaxNode) {
        if Active() {
            current.ContainsCall = true
            current.Calls.Add(
                RegionCall(RegionCallKind.Construction, nil, List[string](), List[string](), false, node.Span.Start)
            )
        }
    }

    // The bounds of a range. A `^n` bound is an offset from the end of the sliced sequence; the range that
    // contains it is classified as a whole. The binder converts a bound that is not a `System.Index`, and the
    // operand of `^`, to `int32` (`BindRangeBound`), so each is a conversion site.
    private func VisitRangeBounds(bounds RangeExpressionSyntax) {
        RecordRangeBound(bounds.LowerBound)
        RecordRangeBound(bounds.UpperBound)
    }

    private func RecordRangeBound(bound ExpressionSyntax?) {
        let value = if UnwrapParentheses(bound) is FromEndIndexExpressionSyntax fromEnd {
            fromEnd.Operand
        } else {
            bound
        }
        if value == nil {
            return
        }
        if Active() {
            RecordConversion(value, RootPath("int32"))
        }
        Visit(value)
    }

    // Whether a nested array literal is stored into an array element (`[][]int32{[]int32{1}}`). No conversion
    // operator converts between array types: a source one must name a type of the package (GS0394), and an imported
    // one is declared on a class.
    private func NestedArrayHasElementType(
        creation ArrayCreationExpressionSyntax,
        nested ArrayCreationExpressionSyntax
    ) bool -> creation
        .ElementTypeClause
        ?.IsArray == true

    // An index access `t[i]`, recorded as a call of the member `[]` on the target for the consumer's check of the
    // conversions of its arguments. A range argument has the form `Range`.
    private func RecordIndexAccess(target RegionReceiverPath?, index IndexExpressionSyntax, position int32) {
        if !Active() {
            return
        }
        let arguments = List[RegionReceiverPath?]()
        let argumentForms = List[RegionArgumentForm]()
        for argument in index.Indices {
            let inner = UnwrapParentheses(argument)
            let form = if inner is RangeExpressionSyntax {
                RegionArgumentForm.Range
            } else if inner is FromEndIndexExpressionSyntax {
                RegionArgumentForm.BuiltInByForm
            } else {
                ArgumentForm(argument)
            }
            argumentForms.Add(form)
            arguments.Add(
                if form == RegionArgumentForm.Path {
                    BuildPath(argument)
                } else {
                    default(RegionReceiverPath?)
                }
            )
        }
        // In a constant pattern the access can name a generic type (`o is List[int32]`); the consumer decides.
        let accesses = if constantPatternDepth > 0 {
            current.PatternIndexAccesses
        } else {
            current.IndexAccesses
        }
        accesses.Add(
            RegionCall(
                RegionCallKind.MemberInvocation,
                IndexMemberName,
                List[string](),
                List[string](),
                false,
                position,
                nil,
                target,
                arguments,
                argumentForms
            )
        )
    }

    /// The member name of an index access in (cref:RegionEffects.IndexAccesses).
    internal const IndexMemberName string = "[]"

    private func UnwrapParentheses(expression ExpressionSyntax?) ExpressionSyntax? {
        var inner = expression
        while inner is ParenthesizedExpressionSyntax parenthesized {
            inner = parenthesized.Expression
        }
        return inner
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

    // A read inside a constant pattern can name a type or a constant (`o is System.String`); the consumer decides.
    private func RecordRead(receiver RegionReceiverPath?, member string?) {
        if !Active() {
            return
        }
        if constantPatternDepth == 0 {
            current.MemberReads.Add(RegionMemberRead(receiver, member))
        } else {
            current.PatternReads.Add(RegionMemberRead(receiver, member))
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
        if receiver == nil && IsIntrinsicCast(call) {
            let operand = call.Arguments[0]
            Visit(operand)
            if Active() {
                RecordConversion(operand, TypeOrigin(call.TypeArgumentList!!.Arguments[0]), allowExplicit: true)
            }
            return
        }
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
        let arguments = List[RegionReceiverPath?]()
        let argumentForms = List[RegionArgumentForm]()
        for argument in call.Arguments {
            ClassifyCallArgument(argument, out var form, out var path)
            argumentForms.Add(form)
            arguments.Add(path)
            var unwrappedArgument = argument
            while unwrappedArgument is ParenthesizedExpressionSyntax parenthesized {
                unwrappedArgument = parenthesized.Expression
            }
            switch unwrappedArgument {
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
                    arguments,
                    argumentForms,
                    call.TypeArgumentList != nil,
                    call
                )
            )
        }
    }

    // The name of a plain variable operand: a name, through parentheses and `!!`. Otherwise `nil`.
    // ---------------------------------------------------------------- receiver paths

    private func IsIntrinsicCast(call CallExpressionSyntax) bool -> call.Callee == nil &&
        call.ConversionTypeClause == nil &&
        call
        .Identifier
        .ValueText == "cast" &&
        call
        .TypeArgumentList
        ?.Arguments
        .Count == 1 &&
        call
        .Arguments
        .Count == 1

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
                if IsIntrinsicCast(call) {
                    return TypeOrigin(call.TypeArgumentList!!.Arguments[0])
                }
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
            case defaultValue is DefaultExpressionSyntax {
                return TypeOrigin(defaultValue.TypeClause)
            }
            case index is IndexExpressionSyntax {
                return BuildPath(index.Target)?.Append(RegionReceiverStepKind.Index, nil)
            }
            case accessor is AccessorExpressionSyntax {
                return AppendPath(BuildPath(accessor.LeftPart), accessor.RightPart)
            }
            default {
                // A concatenation of string literals or an interpolated string is a `string`.
                if IsPureStringForm(expression) {
                    return RegionReceiverPath(
                        nil,
                        false,
                        nil,
                        "System.String",
                        ImmutableArray[RegionReceiverStep].Empty
                    )
                }
                if IsPureBooleanForm(expression) {
                    return RegionReceiverPath(
                        nil,
                        false,
                        nil,
                        "System.Boolean",
                        ImmutableArray[RegionReceiverStep].Empty
                    )
                }
                return nil
            }
        }
    }

    private func BuildConstantValuePath(expression ExpressionSyntax?) RegionReceiverPath? -> switch expression {
        case parenthesized is ParenthesizedExpressionSyntax: BuildConstantValuePath(parenthesized.Expression)
        case name is NameExpressionSyntax when !IsDeclared(name.IdentifierToken.ValueText):
        RootPath(name.IdentifierToken.ValueText)
        case accessor is AccessorExpressionSyntax:
        AppendPath(BuildConstantValuePath(accessor.LeftPart), accessor.RightPart)
        default: default(RegionReceiverPath?)
    }

    private func BuildConstantValue(
        expression ExpressionSyntax?,
        contextualType RegionReceiverPath? = nil
    ) RegionConstantValue? {
        switch UnwrapParentheses(expression) {
            case literal is LiteralExpressionSyntax when literal.LiteralToken.Kind == SyntaxKind.NilKeyword {
                return RegionConstantValue(nil, ImmutableArray[RegionReceiverPath].Empty)
            }
            case defaultValue is DefaultExpressionSyntax {
                let target = TypeOrigin(defaultValue.TypeClause) ?? contextualType
                return if target == nil {
                    default(RegionConstantValue?)
                } else {
                    RegionConstantValue(nil, ImmutableArray.Create(target))
                }
            }
            case call is CallExpressionSyntax when IsIntrinsicCast(call) {
                return BuildConstantValue(call.Arguments[0], TypeOrigin(call.TypeArgumentList!!.Arguments[0]))?.Through(
                    TypeOrigin(call.TypeArgumentList!!.Arguments[0])!!
                )
            }
            case name is NameExpressionSyntax when DeclaringFrame(name.IdentifierToken.ValueText) >= 0 {
                let frame = scopes[DeclaringFrame(name.IdentifierToken.ValueText)]
                return if frame.Constants.TryGetValue(name.IdentifierToken.ValueText, out var constant) {
                    constant
                } else {
                    default(RegionConstantValue?)
                }
            }
            default {
                return if BuildConstantValuePath(expression) is {} path {
                    RegionConstantValue(path, ImmutableArray[RegionReceiverPath].Empty)
                } else {
                    default(RegionConstantValue?)
                }
            }
        }
    }

    private func RebaseConstantValue(value RegionConstantValue?) RegionConstantValue? {
        if value == nil {
            return nil
        }
        if value.Path?.RootName is not{} root || !IsDeclared(root) {
            return value
        }
        let frame = scopes[DeclaringFrame(root)]
        if value.Path!!.Steps.Length != 0 || !frame.Constants.TryGetValue(root, out var constant) {
            return nil
        }
        return RegionConstantValue(constant.Path, constant.Targets.AddRange(value.Targets))
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
                BuildStepCallArguments(call, out var arguments, out var argumentForms)
                return prefix.Append(
                    RegionReceiverStepKind.Call,
                    call.Identifier.ValueText,
                    arguments,
                    argumentForms,
                    call
                )
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

    private func ClassifyCallArgument(
        argument ExpressionSyntax,
        out form RegionArgumentForm,
        out path RegionReceiverPath?
    ) {
        form = ArgumentForm(argument)
        path = if form == RegionArgumentForm.Path {
            BuildPath(argument)
        } else {
            default(RegionReceiverPath?)
        }
        var unwrapped = argument
        while unwrapped is ParenthesizedExpressionSyntax parenthesized {
            unwrapped = parenthesized.Expression
        }
        // A `ref`, `out` or `&` argument binds a parameter of its exact storage type; an `out var` takes the parameter's.
        if unwrapped is RefArgumentExpressionSyntax byReference {
            if byReference.IsInlineDeclaration {
                form = RegionArgumentForm.InlineDeclaration
                if byReference.DeclaredType != nil {
                    path = TypeOrigin(byReference.DeclaredType)
                }
            } else if byReference.Expression != nil {
                path = BuildPath(byReference.Expression)
                if byReference.RefKindModifier.Text == "in" {
                    form = RegionArgumentForm.ReadOnlyReference
                }
            }
        } else if unwrapped is UnaryExpressionSyntax{OperatorToken: {Kind: SyntaxKind.AmpersandToken}} address {
            path = BuildPath(address.Operand)
        }
    }

    private func BuildStepCallArguments(
        call CallExpressionSyntax,
        out arguments List[RegionReceiverPath?],
        out argumentForms List[RegionArgumentForm]
    ) {
        arguments = List[RegionReceiverPath?]()
        argumentForms = List[RegionArgumentForm]()
        for argument in call.Arguments {
            ClassifyCallArgument(argument, out var form, out var path)
            argumentForms.Add(form)
            arguments.Add(path)
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
        var rebased = path
        if path.Steps.Any((step RegionReceiverStep) -> step.Arguments.Count > 0) {
            let steps = ImmutableArray.CreateBuilder[RegionReceiverStep](path.Steps.Length)
            for step in path.Steps {
                if step.Arguments.Count == 0 {
                    steps.Add(step)
                    continue
                }
                let arguments = List[RegionReceiverPath?](step.Arguments.Count)
                for argument in step.Arguments {
                    arguments.Add(
                        if argument == nil {
                            default(RegionReceiverPath?)
                        } else {
                            Rebase(argument)
                        }
                    )
                }
                steps.Add(RegionReceiverStep(step.Kind, step.Name, arguments, step.ArgumentForms, step.CallSyntax))
            }
            rebased = RegionReceiverPath(
                path.RootName,
                path.RootIsCall,
                path.RootType,
                path.RootLiteralType,
                steps.MoveToImmutable()
            )
        }
        let root = rebased.RootName
        if root == nil || !IsDeclared(root) {
            return rebased
        }
        if rebased.RootIsCall {
            return nil
        }
        return OriginOf(root)?.Concat(rebased)
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
                let mayBeConstant = candidate.PropertyPattern == nil
                let declared = mayBeConstant && IsDeclared(FirstSegment(candidate.CandidateType.DottedName))
                current.TypeTests.Add(TypeTest(name, candidate.CandidateType, mayBeConstant, declared))
            }
        }
    }

    private func TryNarrowPatternSubject(pattern PatternSyntax, out narrowed RegionReceiverPath?) bool {
        switch pattern {
            case parenthesized is ParenthesizedPatternSyntax {
                return TryNarrowPatternSubject(parenthesized.Pattern, out narrowed)
            }
            case typePattern is TypePatternSyntax {
                narrowed = TypeOrigin(typePattern.Type)
                return true
            }
            case candidate is TypeOrConstantPatternSyntax {
                narrowed = if candidate.PropertyPattern != nil {
                    TypeOrigin(candidate.CandidateType)
                } else {
                    default(RegionReceiverPath?)
                }
                return true
            }
            case binary is BinaryPatternSyntax when binary.OperatorToken.Text == "and" {
                if TryNarrowPatternSubject(binary.Right, out narrowed) {
                    return true
                }
                return TryNarrowPatternSubject(binary.Left, out narrowed)
            }
            default {
                narrowed = nil
                return false
            }
        }
    }

    // ADR-0208 R19 (#5593): a constant pattern can call the `Equals` of the tested value; the consumer decides it
    // from the types of the subject and the value.
    private func RecordPatternTest(value ExpressionSyntax, candidate RegionTypeTest?) {
        if !Active() {
            return
        }
        let unwrapped = UnwrapParentheses(value)
        let isNull = unwrapped is LiteralExpressionSyntax literal && literal.LiteralToken.Kind == SyntaxKind.NilKeyword
        let tested = CandidateUnlessDeclared(candidate)
        current.PatternTests.Add(
            RegionPatternTest(
                patternSubject,
                if isNull {
                    default(RegionReceiverPath?)
                } else {
                    BuildPath(unwrapped)
                },
                isNull,
                tested,
                BuildConstantValue(unwrapped)
            )
        )
    }

    // A name that the region declares is a value, whatever type of that name the entry scope has. A nested region's
    // test is checked again when the enclosing region composes it, since the enclosing region can declare the name.
    private func CandidateUnlessDeclared(candidate RegionTypeTest?) RegionTypeTest? -> if candidate is {
        MayBeConstant: true,
        TypeName: {} typeName
    } &&
        IsDeclared(FirstSegment(typeName)) {
        default(RegionTypeTest?)
    } else {
        candidate
    }

    private func FirstSegment(name string) string {
        let dot = name.IndexOf('.')
        return if dot < 0 {
            name
        } else {
            name.Substring(0, dot)
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
    private func TypeTest(
        name string,
        type TypeClauseSyntax,
        mayBeConstant bool,
        declaredInRegion bool = false
    ) RegionTypeTest {
        if type.Identifier == nil || type.IsArray || type.IsTuple || type.IsFunction || type.IsFunctionPointer {
            return RegionTypeTest(name, nil, 0, mayBeConstant, declaredInRegion, type)
        }
        let arity = if type.TypeArguments is {} arguments {
            arguments.Count
        } else {
            0
        }
        return RegionTypeTest(name, type.DottedName, arity, mayBeConstant, declaredInRegion, type)
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
