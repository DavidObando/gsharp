// <copyright file="RegionEffectScanner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
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

    /// The names that one declaration scope holds, and the `ref` locals of the scope with the name
    /// of the variable each one aliases (`nil` when the storage is not a plain variable).
    private sealed class ScopeFrame {
        init() {
            Names = HashSet[string]()
            Kinds = Dictionary[string, string]()
            Aliases = Dictionary[string, string?]()
            LocalAliases = HashSet[string]()
        }

        /// Gets the `ref` locals of the scope whose storage is a variable that the region declares.
        prop LocalAliases HashSet[string] {
            get;
        }

        /// Gets how each name was declared: `pattern`, `binding` or `local`.
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
        let name = token.ValueText
        if name.Length > 0 && scopes.Count > 0 {
            scopes[scopes.Count - 1].Names.Add(name)
            scopes[scopes.Count - 1].Kinds[name] = declaration
            if declaration != "local" {
                patternNames.Add(name)
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
        pendingReceiver = nil
        pendingReceiverIsRoot = false
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
            case SyntaxKind.NameExpression {
                let read = cast[NameExpressionSyntax](node).IdentifierToken.ValueText
                if Active() && !IsDeclared(read) && !current.BareReads.Contains(read) {
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
                VisitChildren(node)
            }
            case SyntaxKind.IfStatement {
                let ifStatement = cast[IfStatementSyntax](node)
                // The initializer scope encloses both arms. The condition and the then branch have a scope
                // of their own, so a pattern variable of the condition is not visible in the else arm.
                Push()
                Visit(ifStatement.Initializer)
                Push()
                Visit(ifStatement.Condition)
                Visit(ifStatement.ThenStatement)
                Pop()
                Visit(ifStatement.ElseClause)
                Pop()
            }
            case SyntaxKind.IfLetStatement {
                let ifLet = cast[IfLetStatementSyntax](node)
                Push()
                VisitBindings(ifLet.Bindings)
                Visit(ifLet.Guard)
                Visit(ifLet.ThenStatement)
                Pop()
                Visit(ifLet.ElseClause)
            }
            case SyntaxKind.IfLetExpression {
                let ifLet = cast[IfLetExpressionSyntax](node)
                Push()
                VisitBindings(ifLet.Bindings)
                Visit(ifLet.Guard)
                Visit(ifLet.ThenBlock)
                Pop()
                Visit(ifLet.ElseExpression)
            }
            case SyntaxKind.GuardLetStatement {
                let guardLet = cast[GuardLetStatementSyntax](node)
                // The names are visible to the statements that follow the guard.
                VisitBindings(guardLet.Bindings)
                Visit(guardLet.Guard)
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
                for identifier in deconstruction.Identifiers {
                    Declare(identifier)
                }
            }
            case SyntaxKind.NamedDeconstructionStatement {
                let deconstruction = cast[NamedDeconstructionStatementSyntax](node)
                Visit(deconstruction.Initializer)
                for field in deconstruction.Fields {
                    Declare(field.LocalIdentifier)
                }
            }
            case SyntaxKind.VarPattern {
                Declare(cast[VarPatternSyntax](node).Designation, "pattern")
            }
            case SyntaxKind.TypePattern {
                let pattern = cast[TypePatternSyntax](node)
                Declare(pattern.Identifier, "pattern")
                Declare(pattern.Designation, "pattern")
                Visit(pattern.PropertyPattern)
            }
            case SyntaxKind.PropertyPattern {
                let pattern = cast[PropertyPatternSyntax](node)
                Declare(pattern.Designation, "pattern")
                // Each field of the pattern reads a member of the subject (rule W5). `{ }` is a null test.
                for field in pattern.Fields {
                    RecordMemberRead()
                }
                VisitChildren(node)
            }
            case SyntaxKind.SlicePattern {
                let pattern = cast[SlicePatternSyntax](node)
                Declare(pattern.CaptureIdentifier, "pattern")
                Visit(pattern.Pattern)
            }
            case SyntaxKind.MultiAssignmentDeclarationExpression {
                Declare(cast[MultiAssignmentDeclarationExpressionSyntax](node).Identifier)
            }
            case SyntaxKind.SwitchStatement {
                let switchStatement = cast[SwitchStatementSyntax](node)
                Visit(switchStatement.Expression)
                for switchCase in switchStatement.Cases {
                    Push()
                    Visit(switchCase.Value)
                    Visit(switchCase.Guard)
                    Visit(switchCase.Body)
                    Pop()
                }
            }
            case SyntaxKind.SwitchExpression {
                let switchExpression = cast[SwitchExpressionSyntax](node)
                Visit(switchExpression.Expression)
                for arm in switchExpression.Arms {
                    Push()
                    Visit(arm.Value)
                    Visit(arm.Guard)
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
                Visit(selectCase.Guard)
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
                    Visit(clause.Filter)
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
                if Active() && IsOperatorCandidate(binary) {
                    current.ContainsOperatorCandidate = true
                    RecordOperatorOperand(binary.Left)
                    RecordOperatorOperand(binary.Right)
                }
                VisitChildren(node)
            }
            case SyntaxKind.CallExpression {
                VisitCall(cast[CallExpressionSyntax](node), receiver, receiverIsRoot)
            }
            case SyntaxKind.AccessorExpression {
                VisitAccessor(cast[AccessorExpressionSyntax](node), receiver != nil)
            }
            case SyntaxKind.IndexExpression, SyntaxKind.FieldAccessExpression {
                RecordMemberRead()
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

    private func VisitBindings(bindings SeparatedSyntaxList[IfLetBindingClauseSyntax]) {
        for binding in bindings {
            NodesVisited++
            Visit(binding.Initializer)
            Declare(binding.Identifier, "binding")
        }
    }

    private func VisitVariableDeclaration(declaration VariableDeclarationSyntax) {
        Visit(declaration.Initializer)
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
            let shadowed = write.Proof == RegionWriteProof.Construction &&
                write.ConstructedTypeName != nil &&
                IsDeclared(write.ConstructedTypeName)
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
        for name in record.OperatorOperandNames {
            if IsDeclared(name) {
                current.OperatorHasUnresolvedOperand = true
            }
        }
        current.AbsorbFlags(record, Active())
    }

    // Visits the parts of a loop statement. At the top level of a region the initializer of a
    // `for` clause and the collection of a range loop are outside it (table T3, T5).
    private func VisitLoop(node SyntaxNode, topLevel bool, iterationRunsUserCode bool = true) {
        switch node.Kind {
            case SyntaxKind.WhileStatement {
                let loop = cast[WhileStatementSyntax](node)
                Visit(loop.Condition)
                Visit(loop.Body)
            }
            case SyntaxKind.ForConditionStatement {
                let loop = cast[ForConditionStatementSyntax](node)
                Visit(loop.Condition)
                Visit(loop.Body)
            }
            case SyntaxKind.ForClauseStatement {
                let loop = cast[ForClauseStatementSyntax](node)
                Push()
                if !topLevel {
                    Visit(loop.Initializer)
                }
                Visit(loop.Condition)
                Visit(loop.Post)
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
                Push()
                Declare(loop.FirstIdentifier)
                Declare(loop.SecondIdentifier)
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
                Visit(loop.Guard)
                Visit(loop.Body)
                Pop()
            }
            case SyntaxKind.DoWhileStatement {
                let loop = cast[DoWhileStatementSyntax](node)
                Visit(loop.Body)
                Visit(loop.Condition)
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
        if value != nil {
            ClassifyProof(value, out proof, out typeName, out rightName)
        }
        var rightDeclaration string? = nil
        if rightName != nil {
            rightDeclaration = DeclarationKind(rightName)
            if rightDeclaration == nil && patternNames.Contains(rightName) {
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
        let frame = DeclaringFrame(name)
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
                    // The type of a type-test fact must accept the literal: only a string literal proves one.
                    typeName = if literal.LiteralToken.Kind == SyntaxKind.StringToken {
                        "string"
                    } else {
                        nil
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

    private func RecordMemberRead() {
        if Active() {
            current.ContainsMemberRead = true
            current.MemberReadCount++
        }
    }

    private func VisitAccessor(accessor AccessorExpressionSyntax, isRightPartOfAccessor bool) {
        // `a.M(args)` is a call. `a.b` and `a.b.M()` read the member `b`: an unknown getter (rule W5).
        Visit(accessor.LeftPart)
        let right = accessor.RightPart
        if right.Kind != SyntaxKind.CallExpression {
            RecordMemberRead()
        }
        // The receiver of the call is a plain root only when this accessor does not itself follow a dot.
        pendingReceiver = accessor.LeftPart
        pendingReceiverIsRoot = !isRightPartOfAccessor
        Visit(right)
    }

    private func VisitCall(call CallExpressionSyntax, receiver ExpressionSyntax?, receiverIsRoot bool) {
        if Active() {
            current.ContainsCall = true
        }
        var kind = RegionCallKind.NamedInvocation
        if receiver != nil {
            kind = RegionCallKind.MemberInvocation
        } else if call.Callee != nil {
            kind = RegionCallKind.ExpressionInvocation
        }
        let byReference = List[string]()
        let byValue = List[string]()
        var unresolved = false
        if receiver != nil && receiverIsRoot {
            let receiverName = NameOf(receiver)
            if receiverName != nil {
                byValue.Add(OperandName(receiverName))
            }
        }
        if call.Callee != nil {
            Visit(call.Callee)
        }
        for argument in call.Arguments {
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
                    if kind == RegionCallKind.NamedInvocation {
                        call.Identifier.ValueText
                    } else {
                        default(string?)
                    },
                    byReference,
                    byValue,
                    unresolved,
                    call.Span.Start
                )
            )
        }
    }

    // The name of a plain variable operand: a name, through parentheses and `!!`. Otherwise `nil`.
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
