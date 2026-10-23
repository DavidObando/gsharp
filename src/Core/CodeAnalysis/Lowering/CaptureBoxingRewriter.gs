// <copyright file="CaptureBoxingRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq

/// Issue #523: a function literal that captures a value-type local of its
/// enclosing scope must observe subsequent writes to that local — both Go
/// and C# capture closures over the variable cell, not its value at
/// construction time. The historical emit pipeline snapshotted captured
/// values into closure-class fields, so an outer reassignment was
/// invisible to the lambda.
/// @remarks This pass hoists every captured local / captured parameter into a
/// synthesized single-field reference class (`<>__Box_<name>_<n>`),
/// inserts the allocation at the local's declaration site (or at function
/// entry for captured parameters), and rewrites every read and write of
/// the captured variable — including reads/writes inside the lambda body
/// — to go through the shared box.
///
/// Because the box is a reference type, the lambda's existing
/// snapshot-by-value emit (which copies the captured variable into the
/// closure class's field at `newobj` time) now copies a *reference*
/// to the box. The outer scope and every lambda that captures the
/// variable therefore share the same cell. Multiple lambdas in the same
/// scope share state automatically; nested lambdas continue to work via
/// the existing transitive-capture propagation
/// (`CapturedVariableCollector.RewriteFunctionLiteralExpression`).
///
/// Globals ((cref:GlobalVariableSymbol)) are excluded as a side
/// fix: they are already addressable as static fields, so capturing them
/// into a closure field would just re-introduce the snapshot bug; the
/// pass instead rewrites the lambda's capture list to omit them, leaving
/// the lambda body to read the static field directly at every use.
///
/// For-range key/value variables are boxed at the start of each iteration.
/// This preserves foreach-style fresh-variable semantics when closures
/// escape while still sharing one cell among closures from the same iteration.
internal shared class CaptureBoxingRewriter {
    private class BoxedVariable {
        init(
            original VariableSymbol,
            boxLocal LocalVariableSymbol,
            boxClass StructSymbol,
            boxField FieldSymbol,
            retainedCapture LocalVariableSymbol?
        ) {
            Original = original
            BoxLocal = boxLocal
            BoxClass = boxClass
            BoxField = boxField
            RetainedCapture = retainedCapture
        }

        prop Original VariableSymbol {
            get;
        }

        prop BoxLocal LocalVariableSymbol {
            get;
        }

        prop BoxClass StructSymbol {
            get;
        }

        prop BoxField FieldSymbol {
            get;
        }

        prop RetainedCapture LocalVariableSymbol? {
            get;
        }
    }

    /// Issue #1453: finds captured locals that are introduced (rather than
    /// declared) by an `out`/`ref` address-of within a single
    /// statement — i.e. inline `out var x` captures that have no
    /// (cref:BoundVariableDeclaration). The scan is shallow: it stops at
    /// nested (cref:BoundBlockStatement)s (those are handled when the
    /// rewriter recurses into them, so a loop body gets a fresh box) and at
    /// function literals (already opaque to (cref:BoundTreeWalker)).
    private class OutVarBoxIntroductionScanner : BoundTreeWalker {
        private let boxInfo Dictionary[VariableSymbol, BoxedVariable]
        private let allocated HashSet[VariableSymbol]
        private let found List[BoxedVariable] = List[BoxedVariable]()
        private let foundSet HashSet[VariableSymbol] = HashSet[VariableSymbol]()

        private init(boxInfo Dictionary[VariableSymbol, BoxedVariable], allocated HashSet[VariableSymbol]) {
            this.boxInfo = boxInfo
            this.allocated = allocated
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func VisitBlockStatement(node BoundBlockStatement) {
            // Stop: a nested block introduces its own scope. Its out-var boxes
            // are allocated when the rewriter recurses into that block, keeping
            // loop-body captures fresh per iteration.

        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func VisitAddressOfExpression(node BoundAddressOfExpression) {
            if node.Operand is BoundVariableExpression bve && this.boxInfo.TryGetValue(bve.Variable, out var bi) &&
                !(bi.Original is ParameterSymbol) &&
                !this
                .allocated
                .Contains(bve.Variable) && this.foundSet.Add(bve.Variable) {
                this.found.Add(bi)
            }
            base.VisitAddressOfExpression(node)
        }

        shared {
            func Scan(
                statement BoundStatement,
                boxInfo Dictionary[VariableSymbol, BoxedVariable],
                allocated HashSet[VariableSymbol]
            ) List[BoxedVariable] {
                let scanner = OutVarBoxIntroductionScanner(boxInfo, allocated)
                scanner.VisitStatement(statement)
                return scanner.found
            }
        }
    }

    private class CaptureWalker : BoundTreeRewriter {
        private let sink HashSet[VariableSymbol]
        private let nestedParameters HashSet[ParameterSymbol]?
        private let persistentRoots HashSet[VariableSymbol]?
        private let retainedCaptureTypes Dictionary[VariableSymbol, TypeSymbol]?

        private init(
            sink HashSet[VariableSymbol],
            nestedParameters HashSet[ParameterSymbol]?,
            persistentRoots HashSet[VariableSymbol]?,
            retainedCaptureTypes Dictionary[VariableSymbol, TypeSymbol]?
        ) {
            this.sink = sink
            this.nestedParameters = nestedParameters
            this.persistentRoots = persistentRoots
            this.retainedCaptureTypes = retainedCaptureTypes
        }

        protected override func RewriteManagedReferenceExpression(
            node BoundManagedReferenceExpression
        ) BoundExpression {
            ManagedReferenceOrigins.CollectRoots(node.Location, this.sink)
            if this.persistentRoots != nil {
                ManagedReferenceOrigins.CollectRoots(node.Location, this.persistentRoots)
            }
            if node.RetainForCapture && this.retainedCaptureTypes != nil {
                let roots = HashSet[VariableSymbol]()
                ManagedReferenceOrigins.CollectRoots(node.Location, roots)
                for root in roots {
                    this.retainedCaptureTypes!!.TryAdd(root, node.Type)
                }
            }
            return base.RewriteManagedReferenceExpression(node)
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
            this.nestedParameters?.UnionWith(node.Function.Parameters)
            for captured in node.CapturedVariables {
                this.sink.Add(captured)
            }
            // BoundTreeRewriter intentionally treats a function literal as a
            // leaf (the body is a separate lexical scope). Recurse explicitly
            // so nested lambdas-in-lambdas also contribute — defensive: the
            // binder already propagates captures transitively, but this keeps
            // the pass robust against future BoundTree changes.
            this.RewriteStatement(node.Body)
            return node
        }

        protected override func RewriteLocalFunctionDeclaration(node BoundLocalFunctionDeclaration) BoundStatement {
            this.nestedParameters?.UnionWith(node.Literal.Function.Parameters)
            this.sink.UnionWith(node.Literal.CapturedVariables)
            this.RewriteStatement(node.Literal.Body)
            return node
        }

        shared {
            func Collect(
                root BoundStatement,
                sink HashSet[VariableSymbol],
                nestedParameters HashSet[ParameterSymbol]? = nil,
                persistentRoots HashSet[VariableSymbol]? = nil,
                retainedCaptureTypes Dictionary[VariableSymbol, TypeSymbol]? = nil
            ) {
                CaptureWalker(sink, nestedParameters, persistentRoots, retainedCaptureTypes).RewriteStatement(root)
            }
        }
    }

    private class BoxingRewriter : BoundTreeRewriter {
        private let boxInfo Dictionary[VariableSymbol, BoxedVariable]
        private let dropFromCapture HashSet[VariableSymbol]

        // Issue #1453: boxed local originals whose box has already been
        // allocated (a `new Box()` statement emitted). Ordinary captured
        // locals are allocated at their BoundVariableDeclaration; inline
        // `out var x` captures have no declaration, so RewriteBlockStatement
        // allocates their box at the introducing statement. This set
        // distinguishes the two so out-var boxes are allocated exactly once.
        private let allocated HashSet[VariableSymbol] = HashSet[VariableSymbol]()

        init(boxInfo Dictionary[VariableSymbol, BoxedVariable], dropFromCapture HashSet[VariableSymbol]) {
            RewrittenLambdaBodies = Dictionary[FunctionSymbol, BoundBlockStatement]()
            this.boxInfo = boxInfo
            this.dropFromCapture = dropFromCapture
        }

        /// Gets the lambda bodies rewritten during this pass. When the outer function's
        /// body is rewritten, any nested (cref:BoundFunctionLiteralExpression)
        /// whose body changes is recorded here so (cref:Lower) can propagate
        /// the rewritten body back to `program.Functions[lambdaSymbol]`.
        prop RewrittenLambdaBodies Dictionary[FunctionSymbol, BoundBlockStatement] {
            get;
        }

        internal func RewriteInitializer(expression BoundExpression) BoundExpression -> RewriteExpression(expression)

        protected override func RewriteIsExpression(node BoundIsExpression) BoundExpression {
            let condition = cast[BoundIsExpression](base.RewriteIsExpression(node))
            let seeds = this.BuildPatternBoxSeedStatements(condition.Pattern)
            return if seeds.IsEmpty {
                cast[BoundExpression](condition)
            } else {
                cast[BoundExpression](
                    BoundConditionalExpression(
                        node.Syntax,
                        condition,
                        BoundBlockExpression(node.Syntax, seeds, BoundLiteralExpression(node.Syntax, true)),
                        BoundLiteralExpression(node.Syntax, false),
                        TypeSymbol.Bool
                    )
                )
            }
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteBlockStatement(node BoundBlockStatement) BoundStatement {
            // Issue #1453: an inline `out var x` that is captured by a nested
            // lambda is hoisted into a Box like any other captured local, but
            // unlike `var x = e` it has no BoundVariableDeclaration, so
            // RewriteVariableDeclaration never allocates its box and emit later
            // fails with "Variable 'x' has no local slot".
            //
            // Allocate the box for such declaration-less captured locals at the
            // statement that first introduces them (their `out`/`ref` address-of
            // site), scoped to the block that contains that statement. Doing it
            // at block level means a loop body gets a fresh box per iteration,
            // mirroring how `var x = e` inside a loop body is handled.
            var builder ImmutableArray[BoundStatement].Builder? = nil
            for var i = 0; i < node.Statements.Length; i++ {
                let oldStatement = node.Statements[i]
                // Find declaration-less captured locals introduced (as an
                // address-of operand) directly within this statement, before it
                // is rewritten into box-field accesses. Mark them allocated up
                // front so recursion into nested scopes does not re-allocate.
                let introduced = OutVarBoxIntroductionScanner.Scan(oldStatement, this.boxInfo, this.allocated)
                for bi in introduced {
                    this.allocated.Add(bi.Original)
                }
                let newStatement = this.RewriteStatement(oldStatement)
                let changed = introduced.Count > 0 || !object.ReferenceEquals(newStatement, oldStatement)
                if changed && builder == nil {
                    builder = ImmutableArray.CreateBuilder[BoundStatement](node.Statements.Length + introduced.Count)
                    for var j = 0; j < i; j++ {
                        builder.Add(node.Statements[j])
                    }
                }
                if builder != nil {
                    for bi in introduced {
                        builder.AddRange(CaptureBoxingRewriter.BuildBoxStatements(bi, initialValue: nil))
                    }
                    builder.Add(newStatement)
                }
            }
            return if builder == nil {
                node
            } else {
                BoundBlockStatement(nil, builder.ToImmutable())
            }
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteVariableExpression(node BoundVariableExpression) BoundExpression {
            if this.boxInfo.TryGetValue(node.Variable, out var bi) {
                // Issue #2442: forward a bind-time narrowed type (see
                // LambdaBinder's FilterNarrowingsSurvivingClosureCapture) onto
                // the rewritten box-field access. Boxing runs before
                // ClosureEmitter's own capture rewrite and unconditionally
                // wraps every captured local/parameter — including read-only
                // bindings the binder has already proven safe to narrow
                // across closure capture — in a heap cell purely for
                // write-visibility semantics (see class remarks above); it
                // does not itself introduce any new mutation. Dropping
                // NarrowedType here would make EmitIndirectCall's
                // `call.Target.Type is DelegateTypeSymbol` dispatch see the
                // box field's declared (possibly nullable) type instead,
                // selecting the wrong Invoke overload and producing invalid
                // IL (ILVerify StackUnexpected) for a narrowed named-delegate
                // call inside a closure.
                return BoundFieldAccessExpression(
                    nil,
                    BoundVariableExpression(nil, bi.BoxLocal),
                    bi.BoxClass,
                    bi.BoxField,
                    node.NarrowedType
                )
            }
            return node
        }

        protected override func RewriteManagedReferenceExpression(
            node BoundManagedReferenceExpression
        ) BoundExpression {
            if !node.RetainForCapture {
                return base.RewriteManagedReferenceExpression(node)
            }
            let roots = HashSet[VariableSymbol]()
            ManagedReferenceOrigins.CollectRoots(node.Location, roots)
            if roots.Count == 0 {
                return node
            }
            let root = if roots.Count == 1 {
                roots.Single()
            } else {
                throw InvalidOperationException("A retained rich capture must have exactly one lexical root.")
                default(VariableSymbol)
            }
            let retained = Invariant.Required(
                this.boxInfo[root].RetainedCapture,
                "capture collection planned retained location storage",
                expression: "this.boxInfo[root].RetainedCapture"
            )
            return BoundVariableExpression(node.Syntax, retained)
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteAssignmentExpression(node BoundAssignmentExpression) BoundExpression {
            if this.boxInfo.TryGetValue(node.Variable, out var bi) {
                let value = this.RewriteExpression(node.Expression)
                return BoundFieldAssignmentExpression(nil, bi.BoxLocal, bi.BoxClass, bi.BoxField, value)
            }
            return base.RewriteAssignmentExpression(node)
        }

        // GSA0005: The rebuild sits inside `node.Receiver != null`, so this is the
        // variable-receiver form; every other form falls through to base.
        // InterfaceType and ReceiverExpression are null on this path.
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        @SuppressDiagnostic("GSA0005")
        protected override func RewriteFieldAssignmentExpression(node BoundFieldAssignmentExpression) BoundExpression {
            // Issue #567: when the receiver of a field assignment is a boxed
            // variable, the original receiver no longer has an IL slot. Rewrite
            // to use an expression-based receiver: `boxLocal.Value` produces
            // the reference to the original object, then the outer field
            // assignment targets the object's field through that expression.
            if node.Receiver != nil && this.boxInfo.TryGetValue(node.Receiver, out var bi) {
                let receiverExpr = BoundFieldAccessExpression(
                    nil,
                    BoundVariableExpression(nil, bi.BoxLocal),
                    bi.BoxClass,
                    bi.BoxField
                )
                let value = this.RewriteExpression(node.Value)
                return BoundFieldAssignmentExpression.WithExpressionReceiver(
                    nil,
                    receiverExpr,
                    BoundNodeForm.DeclaringType(node),
                    node.Field,
                    value,
                    node.ResultType
                )
            }
            return base.RewriteFieldAssignmentExpression(node)
        }

        // GSA0005: The rebuild sits inside `node.Target != null`, so this is the
        // variable-target form; TargetExpression is null on this path and the
        // expression-target form falls through to base.
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        @SuppressDiagnostic("GSA0005")
        protected override func RewriteIndexAssignmentExpression(node BoundIndexAssignmentExpression) BoundExpression {
            // Issue #618: when the target of an index assignment is a boxed
            // variable, the original target no longer has an IL slot. Rewrite
            // to use an expression-based target: `boxLocal.Value` produces
            // the array/slice/map reference, then the outer index assignment
            // targets the element through that expression.
            if node.Target != nil && this.boxInfo.TryGetValue(node.Target, out var bi) {
                let targetExpr = BoundFieldAccessExpression(
                    nil,
                    BoundVariableExpression(nil, bi.BoxLocal),
                    bi.BoxClass,
                    bi.BoxField
                )
                let indices = node.Indices.Select(this.RewriteExpression).ToImmutableArray()
                let value = this.RewriteExpression(node.Value)
                return BoundIndexAssignmentExpression.WithExpressionTarget(nil, targetExpr, indices, value, node.Type)
            }
            return base.RewriteIndexAssignmentExpression(node)
        }

        // GSA0005: Same as RewriteIndexAssignmentExpression: guarded by `node.Target !=
        // null`, so TargetExpression is null on the path that rebuilds.
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        @SuppressDiagnostic("GSA0005")
        protected override func RewriteClrIndexAssignmentExpression(
            node BoundClrIndexAssignmentExpression
        ) BoundExpression {
            // Issue #618: same pattern for CLR indexer writes (e.g.
            // `dict["key"] = v` on a Dictionary). When the target is boxed,
            // rewrite to use an expression-based target.
            if node.Target != nil && this.boxInfo.TryGetValue(node.Target, out var bi) {
                let targetExpr = BoundFieldAccessExpression(
                    nil,
                    BoundVariableExpression(nil, bi.BoxLocal),
                    bi.BoxClass,
                    bi.BoxField
                )
                var argBuilder ImmutableArray[BoundExpression].Builder? = nil
                for var i = 0; i < node.Arguments.Length; i++ {
                    let oldArg = node.Arguments[i]
                    let newArg = this.RewriteExpression(oldArg)
                    if newArg != oldArg && argBuilder == nil {
                        argBuilder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                        for var j = 0; j < i; j++ {
                            argBuilder.Add(node.Arguments[j])
                        }
                    }
                    if argBuilder != nil {
                        argBuilder.Add(newArg)
                    }
                }
                let args = argBuilder?.ToImmutable() ?? node.Arguments
                let value = this.RewriteExpression(node.Value)
                return BoundClrIndexAssignmentExpression.WithExpressionTarget(
                    nil,
                    targetExpr,
                    node.Indexer,
                    args,
                    value,
                    node.Type,
                    node.ConstrainedReceiverTypeParameter,
                    node.ConstrainedInterfaceType
                )
            }
            return base.RewriteClrIndexAssignmentExpression(node)
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteTryStatement(node BoundTryStatement) BoundStatement {
            let tryBlock = this.RewriteStatement(node.TryBlock)
            let rewrittenClauses = ImmutableArray.CreateBuilder[BoundCatchClause](node.CatchClauses.Length)
            var clausesChanged = false
            for clause in node.CatchClauses {
                var body = this.RewriteStatement(clause.Body)
                // BoundCatchClause.Variable is declared non-null; the guard is
                // kept for an oblivious producer, but it tests a copy so the
                // property's declared state survives for the rebuild below.
                let caught VariableSymbol? = clause.Variable
                if caught != nil && this.boxInfo.TryGetValue(caught, out var bi) {
                    body = PrependSeedStatements(body, this.BuildBoxSeedStatements(bi))
                    clausesChanged = true
                } else if !object.ReferenceEquals(body, clause.Body) {
                    clausesChanged = true
                }
                rewrittenClauses.Add(clause.WithBody(body))
            }
            let finallyBlock = if node.FinallyBlock == nil {
                default(BoundStatement?)
            } else {
                this.RewriteStatement(node.FinallyBlock)
            }
            if object.ReferenceEquals(tryBlock, node.TryBlock) && !clausesChanged && object.ReferenceEquals(
                finallyBlock,
                node.FinallyBlock
            ) {
                return node
            }
            return BoundTryStatement(nil, tryBlock, rewrittenClauses.ToImmutable(), finallyBlock)
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewritePatternSwitchStatement(node BoundPatternSwitchStatement) BoundStatement {
            let discriminant = this.RewriteExpression(node.Discriminant)
            var builder ImmutableArray[BoundPatternSwitchArm].Builder? = nil
            for var i = 0; i < node.Arms.Length; i++ {
                let arm = node.Arms[i]
                let pattern BoundPattern? = if arm.Pattern == nil {
                    default(BoundPattern?)
                } else {
                    this.RewritePattern(arm.Pattern)
                }
                let guard_ = if arm.Guard == nil {
                    default(BoundExpression?)
                } else {
                    this.RewriteExpression(arm.Guard)
                }
                var body = this.RewriteStatement(arm.Body)
                let seed = if pattern == nil {
                    ImmutableArray[BoundStatement].Empty
                } else {
                    this.BuildPatternBoxSeedStatements(pattern)
                }
                if !seed.IsEmpty {
                    body = PrependSeedStatements(body, seed)
                }
                if builder == nil && (pattern != arm.Pattern || guard_ != arm.Guard || body != arm.Body) {
                    builder = ImmutableArray.CreateBuilder[BoundPatternSwitchArm](node.Arms.Length)
                    for var j = 0; j < i; j++ {
                        builder.Add(node.Arms[j])
                    }
                }
                builder?.Add(BoundPatternSwitchArm(nil, pattern, guard_, body))
            }
            if discriminant == node.Discriminant && builder == nil {
                return node
            }
            return BoundPatternSwitchStatement(
                nil,
                discriminant,
                builder?.MoveToImmutable() ?? node.Arms,
                node.IsExhaustive
            )
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteSwitchExpression(node BoundSwitchExpression) BoundExpression {
            let discriminant = this.RewriteExpression(node.Discriminant)
            var builder ImmutableArray[BoundSwitchExpressionArm].Builder? = nil
            for var i = 0; i < node.Arms.Length; i++ {
                let arm = node.Arms[i]
                let pattern BoundPattern? = if arm.Pattern == nil {
                    default(BoundPattern?)
                } else {
                    this.RewritePattern(arm.Pattern)
                }
                let guard_ = if arm.Guard == nil {
                    default(BoundExpression?)
                } else {
                    this.RewriteExpression(arm.Guard)
                }
                var result = this.RewriteExpression(arm.Result)
                let seed = if pattern == nil {
                    ImmutableArray[BoundStatement].Empty
                } else {
                    this.BuildPatternBoxSeedStatements(pattern)
                }
                if !seed.IsEmpty {
                    // A switch-expression arm has no statement body to prepend
                    // into — only a `Result` expression — so the seed becomes a
                    // BoundBlockExpression's prefix statements (folding into an
                    // existing one from a prior rewrite, e.g. #2130's expression-
                    // tree lowering, rather than nesting).
                    result = if result is BoundBlockExpression existingBlock {
                        BoundBlockExpression(nil, seed.AddRange(existingBlock.Statements), existingBlock.Expression)
                    } else {
                        BoundBlockExpression(nil, seed, result)
                    }
                }
                if builder == nil && (pattern != arm.Pattern || guard_ != arm.Guard || result != arm.Result) {
                    builder = ImmutableArray.CreateBuilder[BoundSwitchExpressionArm](node.Arms.Length)
                    for var j = 0; j < i; j++ {
                        builder.Add(node.Arms[j])
                    }
                }
                builder?.Add(BoundSwitchExpressionArm(nil, pattern, guard_, result))
            }
            if discriminant == node.Discriminant && builder == nil {
                return node
            }
            return BoundSwitchExpression(nil, discriminant, builder?.MoveToImmutable() ?? node.Arms, node.Type)
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteForRangeStatement(node BoundForRangeStatement) BoundStatement {
            let collection = this.RewriteExpression(node.Collection)
            var body = this.RewriteStatement(node.Body)
            var seed = ImmutableArray[BoundStatement].Empty
            if node.KeyVariable != nil && this.boxInfo.TryGetValue(node.KeyVariable, out var keyBox) {
                seed = seed.AddRange(this.BuildBoxSeedStatements(keyBox))
            }
            if this.boxInfo.TryGetValue(node.ValueVariable, out var valueBox) {
                seed = seed.AddRange(this.BuildBoxSeedStatements(valueBox))
            }
            if !seed.IsEmpty {
                body = PrependSeedStatements(body, seed)
            }
            if object.ReferenceEquals(collection, node.Collection) && object.ReferenceEquals(body, node.Body) {
                return node
            }
            return BoundForRangeStatement(
                node.Syntax,
                node.KeyVariable,
                node.ValueVariable,
                collection,
                node.IterationKind,
                body,
                node.BreakLabel,
                node.ContinueLabel
            )
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteAwaitForRangeStatement(node BoundAwaitForRangeStatement) BoundStatement {
            let stream = this.RewriteExpression(node.Stream)
            var body = this.RewriteStatement(node.Body)
            if this.boxInfo.TryGetValue(node.ValueVariable, out var bi) {
                // Lambda bodies can reach boxing before await-for lowering.
                body = PrependSeedStatements(body, this.BuildBoxSeedStatements(bi))
            }
            if object.ReferenceEquals(stream, node.Stream) && object.ReferenceEquals(body, node.Body) {
                return node
            }
            return BoundAwaitForRangeStatement(
                node.Syntax,
                node.ValueVariable,
                stream,
                body,
                node.BreakLabel,
                node.ContinueLabel
            )
        }

        // GSA0005: Not a clone: this declares the synthesized box local, a different
        // variable from node.Variable, so node's ConstantValue does not belong to
        // it. The unboxed case falls through to base.
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        @SuppressDiagnostic("GSA0005")
        protected override func RewriteVariableDeclaration(node BoundVariableDeclaration) BoundStatement {
            if this.boxInfo.TryGetValue(node.Variable, out var bi) && bi.Original == node.Variable {
                // `var n = e` (where n is captured) lowers to:
                //   var <n_slot> = new Box_n()
                //   <n_slot>.Value = e
                // The original `n`'s slot is reclaimed by the new LocalVariableSymbol
                // of type Box_n. Note `Lowerer.Flatten` will inline this nested
                // block into the enclosing block during the post-binding lower pass.
                this.allocated.Add(bi.Original)
                let initializer = this.RewriteExpression(
                    Invariant.Required(
                        node.Initializer,
                        "a captured variable declaration has an initializer",
                        expression: "node.Initializer"
                    )
                )
                let stmts = CaptureBoxingRewriter.BuildBoxStatements(bi, initializer)
                return BoundBlockStatement(nil, stmts)
            }
            return base.RewriteVariableDeclaration(node)
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
            // Descend into the lambda's body so reads/writes of captured outer
            // variables become reads/writes through the box. The base
            // BoundTreeRewriter intentionally skips the body (separate
            // lexical scope), so we override and recurse explicitly.
            let retainedInBody = Dictionary[VariableSymbol, TypeSymbol]()
            CaptureWalker.Collect(node.Body, HashSet[VariableSymbol](), retainedCaptureTypes: retainedInBody)
            var newBody = cast[BoundBlockStatement](this.RewriteStatement(node.Body))
            let parameterSeeds = ImmutableArray.CreateBuilder[BoundStatement]()
            for parameter in node.Function.Parameters {
                if this.boxInfo.TryGetValue(parameter, out var box) {
                    parameterSeeds.AddRange(this.BuildBoxSeedStatements(box))
                }
            }
            if parameterSeeds.Count != 0 {
                newBody = cast[BoundBlockStatement](PrependSeedStatements(newBody, parameterSeeds.ToImmutable()))
            }
            // Update the lambda's capture list:
            //   - rewrite each boxed variable to its box-local;
            //   - drop globals so the lambda reads them directly via ldsfld.
            let newCaptured = ImmutableArray.CreateBuilder[VariableSymbol](node.CapturedVariables.Length)
            var anyCaptureChange = false
            for cv in node.CapturedVariables {
                if this.dropFromCapture.Contains(cv) {
                    anyCaptureChange = true
                    continue
                }
                if this.boxInfo.TryGetValue(cv, out var bi) {
                    newCaptured.Add(bi.BoxLocal)
                    if bi.RetainedCapture != nil && retainedInBody.ContainsKey(cv) {
                        newCaptured.Add(bi.RetainedCapture)
                    }
                    anyCaptureChange = true
                } else {
                    newCaptured.Add(cv)
                }
            }
            if object.ReferenceEquals(newBody, node.Body) && !anyCaptureChange {
                return node
            }
            // Track the rewritten body so Lower can propagate it to
            // program.Functions[lambdaSymbol], closing #567.
            if !object.ReferenceEquals(newBody, node.Body) {
                this.RewrittenLambdaBodies[node.Function] = newBody
            }
            return BoundFunctionLiteralExpression(
                node.Syntax,
                node.Function,
                node.FunctionType,
                newBody,
                newCaptured.ToImmutable()
            )
        }

        protected override func RewriteLocalFunctionDeclaration(node BoundLocalFunctionDeclaration) BoundStatement {
            let literal = cast[BoundFunctionLiteralExpression](this.RewriteFunctionLiteralExpression(node.Literal))
            return if object.ReferenceEquals(literal, node.Literal) {
                node
            } else {
                BoundLocalFunctionDeclaration(node.Syntax, literal)
            }
        }

        // Issue #2329: a catch-clause variable, a select-arm receive-bind
        // variable, and a pattern-switch/switch-expression type-pattern
        // variable are all "declaration-less" from CaptureBoxingRewriter's
        // point of view — the emitter stores their runtime value straight
        // into their ordinary local slot from specialized dispatch logic
        // (EmitCatchClauses' stloc of the caught exception, the select
        // TryRead out-argument, EmitTypePattern's stloc after isinst), with
        // no BoundVariableDeclaration node ever appearing in the tree (unlike
        // `var n = e`, which RewriteVariableDeclaration boxes above, or an
        // inline `out var x`, which OutVarBoxIntroductionScanner boxes at its
        // address-of site). When one of these variables is captured by a
        // nested lambda, boxInfo still hoists it into a Box (CaptureWalker
        // does not distinguish how a captured VariableSymbol was introduced),
        // but the box is never allocated or seeded anywhere — crashing emit
        // with GS9998 "has no local slot" (the box local itself has no slot)
        // exactly like the #1453 out-var gap.
        //
        // The fix mirrors the captured-parameter prologue (box constructed,
        // then seeded from the plain-slot value) but scoped to the construct's
        // own body/result instead of function entry: the plain slot still
        // receives the runtime value via the unmodified emit dispatch path,
        // and the first thing the (rewritten) body/result does is copy that
        // value into the box before any box.Value read executes.
        private func BuildBoxSeedStatements(bi BoxedVariable) ImmutableArray[BoundStatement] {
            this.allocated.Add(bi.Original)
            return CaptureBoxingRewriter.BuildBoxStatements(bi, BoundVariableExpression(nil, bi.Original))
        }

        private func BuildPatternBoxSeedStatements(pattern BoundPattern) ImmutableArray[BoundStatement] {
            let seed = ImmutableArray.CreateBuilder[BoundStatement]()
            for variable in PatternVariables.CollectBindings(pattern) {
                if this.boxInfo.TryGetValue(variable, out var bi) {
                    seed.AddRange(this.BuildBoxSeedStatements(bi))
                }
            }
            return seed.ToImmutable()
        }

        shared {
            // Prepends box-seed statements ahead of a construct's already-rewritten
            // body, tolerating a non-block body (defensive: every current caller's
            // grammar requires a brace-delimited body, but binding this generically
            // avoids a latent cast failure if that ever changes).
            private func PrependSeedStatements(
                body BoundStatement,
                seed ImmutableArray[BoundStatement]
            ) BoundStatement {
                if body is BoundBlockStatement block {
                    return BoundBlockStatement(nil, seed.AddRange(block.Statements))
                }
                return BoundBlockStatement(nil, seed.Add(body))
            }
        }
    }

    /// Lowers captured-variable semantics in [`program`](paramref) so
    /// that captures of locals/parameters share a heap cell with the
    /// outer scope. Returns the original instance unchanged when no
    /// function body required boxing.
    /// @remarks <b>Invariant (issue #567):</b> every lambda whose body is rewritten
    /// inside an outer function's tree must also have its
    /// `program.Functions[lambdaSymbol]` entry updated. The emitter
    /// looks lambdas up by (cref:FunctionSymbol) key; if the entry
    /// still points to the original un-rewritten body, the emitter trips on
    /// unresolved variable references. The propagation pass after the main
    /// foreach loop closes this gap by overwriting stale entries with the
    /// rewritten lambda bodies collected during the outer function's rewrite.
    /// @param program The bound program to lower.
    /// @param mapClrType Issue #2037: optional projector applied to a box class's constructed
    /// CLR type arguments before `MakeGenericType` (mirrors the #1958
    /// fix threaded through (cref:StructSymbol.Construct)). Pass
    /// (cref:ReferenceResolver.MapClrTypeToReferences) when the box
    /// might hoist a capture typed as an imported constructed generic over an
    /// enclosing type parameter under a cross-reflection-context (MLC)
    /// compile; `null` preserves the erase-on-mismatch
    /// fallback for same-compilation-only callers.
    /// @returns The lowered program (or the original when nothing changed).
    func Lower(program BoundProgram, mapClrType((Type) -> Type)? = nil) BoundProgram {
        var program = program
        program = InitializationPlanner.Prepare(program)
        var counter = 0
        let newStructs = List[StructSymbol]()
        let newFunctions = ImmutableDictionary.CreateBuilder[FunctionSymbol, BoundBlockStatement]()
        var changed = false
        let allLambdaUpdates = Dictionary[FunctionSymbol, BoundBlockStatement]()
        // Issue #4663: box classes are numbered in this loop, so it must not
        // follow the identity-hash order of program.Functions.
        for pair in BoundProgramOrder.Functions(program) {
            let prepared = ManagedAliasPlanner.Prepare(pair.Value)
            var (newBody, lambdaUpdates) = RewriteFunctionBody(
                pair.Key,
                prepared,
                program,
                newStructs,
                &counter,
                mapClrType,
                ImmutableArray[BoundExpression].Empty,
                out _,
                out var prologue
            )
            if !prologue.IsEmpty {
                newBody = BoundBlockStatement(newBody.Syntax, prologue.AddRange(newBody.Statements))
            }
            newFunctions[pair.Key] = newBody
            if !object.ReferenceEquals(newBody, pair.Value) {
                changed = true
            }
            for kv in lambdaUpdates {
                allLambdaUpdates[kv.Key] = kv.Value
            }
        }
        let initializers = program.Initializers.ToBuilder()
        for pair in BoundProgramOrder.Initializers(program) {
            let plan = pair.Value
            let prepared = ManagedAliasPlanner.Prepare(plan.Body)
            let argumentBuilder = ImmutableArray.CreateBuilder[BoundExpression](plan.Arguments.Length)
            for argument in plan.Arguments {
                argumentBuilder.Add(ManagedAliasPlanner.Prepare(argument))
            }
            let arguments = argumentBuilder.MoveToImmutable()
            let (body, updates) = RewriteFunctionBody(
                plan.Function,
                prepared,
                program,
                newStructs,
                &counter,
                mapClrType,
                arguments,
                out var rewrittenArguments,
                out var prologue
            )
            initializers[pair.Key] = BoundInitializationPlan(
                plan.Function,
                rewrittenArguments,
                BoundBlockStatement(nil, prologue),
                body
            )
            changed = true
            for update in updates {
                allLambdaUpdates[update.Key] = update.Value
            }
        }
        // Propagate rewritten lambda bodies to the per-symbol Functions map.
        // When the outer function's body is rewritten, nested lambdas inside
        // its tree are rewritten inline (through BoxingRewriter), but
        // program.Functions[lambdaSymbol] still points to the original
        // un-rewritten body. The emitter looks lambdas up by FunctionSymbol
        // key, so we must overwrite those entries here. This closes #567.
        //
        // Architecture note (issue #617): today lambda symbols are NOT in
        // program.Functions (they live only as BoundFunctionLiteralExpression
        // tree nodes, and the emitter discovers them via tree-walking). This
        // makes the loop below a defensive no-op — the ContainsKey guard is
        // always false. The loop is retained as a safety net: if a future
        // refactor ever registers lambda symbols in program.Functions, this
        // propagation ensures correctness regardless of iteration order,
        // making topological sorting of the foreach unnecessary.
        for (lambdaSymbol, rewrittenBody) in allLambdaUpdates {
            if newFunctions.ContainsKey(lambdaSymbol) {
                newFunctions[lambdaSymbol] = rewrittenBody
                changed = true
            }
        }
        if !changed {
            return program
        }
        var statement = program.Statement
        // Binder registers synthesized top-level statements as the same block
        // instance in Statement and Functions[EntryPoint].
        if program.EntryPoint != nil && program.Functions.TryGetValue(program.EntryPoint, out var entryPointBody) &&
            object.ReferenceEquals(statement, entryPointBody) {
            statement = newFunctions[program.EntryPoint]
        }
        let combinedStructs = program.Structs.AddRange(newStructs)
        let result = BoundProgram(
            program.EntryPointPackage,
            program.Packages,
            program.Diagnostics,
            newFunctions.ToImmutable(),
            program.EntryPoint,
            statement,
            combinedStructs,
            program.Interfaces,
            program.Enums,
            program.Globals,
            program.Delegates
        ){
            Initializers = initializers.ToImmutable(),
            Imports = program.Imports,
            FriendAssemblies = program.FriendAssemblies,
            AssemblyAttributes = program.AssemblyAttributes,
            ModuleAttributes = program.ModuleAttributes,
            NativeProtocols = program.NativeProtocols
        }
        return result
    }

    internal func IsCaptured(body BoundStatement, variable VariableSymbol) bool {
        let captured = HashSet[VariableSymbol]()
        CaptureWalker.Collect(body, captured)
        return captured.Contains(variable)
    }

    private func RewriteFunctionBody(
        function FunctionSymbol,
        body BoundBlockStatement,
        program BoundProgram,
        newStructs List[StructSymbol],
        ref counter int32,
        mapClrType((Type) -> Type)?,
        arguments ImmutableArray[BoundExpression],
        out rewrittenArguments ImmutableArray[BoundExpression],
        out parameterPrologue ImmutableArray[BoundStatement]
    )(Body BoundBlockStatement, LambdaUpdates Dictionary[FunctionSymbol, BoundBlockStatement]) {
        rewrittenArguments = arguments
        parameterPrologue = ImmutableArray[BoundStatement].Empty
        let emptyUpdates = Dictionary[FunctionSymbol, BoundBlockStatement]()
        // Step 1: collect every captured variable touched by any function
        // literal in this body (transitively). This is the union over all
        // BoundFunctionLiteralExpression.CapturedVariables reachable from
        // this body, minus the literals' own parameters and locals — which
        // the binder's CapturedVariableCollector has already pruned.
        let capturedSet = HashSet[VariableSymbol]()
        let nestedParameters = HashSet[ParameterSymbol]()
        let persistentRoots = HashSet[VariableSymbol]()
        let retainedCaptureTypes = Dictionary[VariableSymbol, TypeSymbol]()
        CaptureWalker.Collect(body, capturedSet, nestedParameters, persistentRoots, retainedCaptureTypes)
        for argument in arguments {
            CaptureWalker.Collect(
                BoundExpressionStatement(argument.Syntax, argument),
                capturedSet,
                nestedParameters,
                persistentRoots,
                retainedCaptureTypes
            )
        }
        if capturedSet.Count == 0 {
            return (body, emptyUpdates)
        }
        // Step 2: classify each captured variable.
        //   - boxable      → hoisted to a Box class; reads/writes rewritten.
        //   - drop-capture → captured set entry removed (globals).
        //   - leave alone  → kept as-is (refs, ref-likes, this).
        let boxInfo = Dictionary[VariableSymbol, BoxedVariable]()
        let dropFromCapture = HashSet[VariableSymbol]()
        let packageName = function.Package?.Name ?? program.PackageName ?? string.Empty
        let enclosingType = function.ReceiverType ?? function.StaticOwnerType ?? function.LexicalEnclosingType
        let enclosingDefinition TypeSymbol? = switch enclosingType {
            case enclosingStruct is StructSymbol: cast[TypeSymbol](enclosingStruct.Definition)
            case enclosingInterface is InterfaceSymbol: cast[TypeSymbol](enclosingInterface.Definition)
            default: nil
        }
        for variable in capturedSet {
            if variable is GlobalVariableSymbol {
                // Globals already live in a static field — capturing them by
                // snapshot is just as wrong as for locals (#523), but the fix
                // is the opposite: the lambda should read the global directly,
                // not via a closure field. Strip the capture so emit treats
                // every reference inside the lambda as a static-field load.
                dropFromCapture.Add(variable)
                continue
            }
            if !IsBoxable(variable, function, nestedParameters, persistentRoots) {
                continue
            }
            counter++
            let boxClass = CreateBoxClass(variable, counter, packageName)
            // Issue #1477: when the captured variable's type references an
            // enclosing generic type / method type parameter (a `T`-typed
            // local, or a value whose type is `G[T]`/`Box[T]`/`(…) -> T`), the
            // box class must be generic over those parameters; otherwise its
            // `Value` field's `VAR` slot has no generic parameter in scope,
            // producing an illegal field type (TypeLoadException at load) and
            // unverifiable IL at the capture site. Reify the box generic over
            // the referenced parameters (mirroring the state-machine treatment)
            // and reference the CONSTRUCTED instance everywhere downstream so
            // the local slot, `newobj`, and field stores carry the right
            // `Box<…enclosing args…>` TypeSpec; the open definition (added to
            // newStructs) gets the TypeDef + generic-param rows.
            var origTPs = SynthesizedClosureReifier.CollectOrdered([]TypeSymbol{variable.Type})
            if (enclosingDefinition is StructSymbol or InterfaceSymbol) {
                // A nested helper must redeclare every enclosing type parameter,
                // even when its Value field does not reference all of them.
                let ownerTypeParameters = StructSymbol.CollectEnclosingTypeParameters(enclosingDefinition!!).AddRange(
                    switch enclosingDefinition {
                        case enclosingStruct is StructSymbol: enclosingStruct.TypeParameters
                        case enclosingInterface is InterfaceSymbol: enclosingInterface.Definition!!.TypeParameters
                        default: ImmutableArray[TypeParameterSymbol].Empty
                    }
                )
                if !ownerTypeParameters.IsDefaultOrEmpty {
                    let seeded = ImmutableArray.CreateBuilder[TypeParameterSymbol](
                        ownerTypeParameters.Length + origTPs.Length
                    )
                    seeded.AddRange(ownerTypeParameters)
                    for typeParameter in origTPs {
                        if !ownerTypeParameters.Contains(typeParameter) {
                            seeded.Add(typeParameter)
                        }
                    }
                    origTPs = seeded.ToImmutable()
                    boxClass.MarkCompleteReifiedTypeParameterVector()
                }
            }
            var boxReference = boxClass
            var fieldSymbol = boxClass.Fields[0]
            if !origTPs.IsDefaultOrEmpty {
                boxReference = SynthesizedClosureReifier.Reify(boxClass, origTPs, mapClrType)
                fieldSymbol = boxReference.Fields[0]
            }
            // Issue #4526: a box field can expose a private nested type from the
            // enclosing member. Keep the helper in that member's CLR access domain.
            // Set this after reification, matching closure synthesis: constructing
            // an already-nested generic symbol would prepend owner arguments twice.
            if (enclosingDefinition is StructSymbol or InterfaceSymbol) {
                boxClass.SetContainingType(enclosingDefinition!!)
            }
            // For captured locals: a new LocalVariableSymbol of the box type
            // replaces the original; the binder-emitted slot is reclaimed
            // for the box reference.
            // For captured parameters: the parameter remains in the function
            // signature; a sibling local of the box type is added at entry
            // and its contents are seeded from the parameter once.
            let slotName = if variable is ParameterSymbol p {
                "<>__boxed_" + p.Name
            } else {
                variable.Name
            }
            let boxLocal = LocalVariableSymbol(slotName, isReadOnly: false, type: boxReference)
            retainedCaptureTypes.TryGetValue(variable, out var retainedCaptureType)
            let retainedCapture = if retainedCaptureType == nil {
                default(LocalVariableSymbol?)
            } else {
                LocalVariableSymbol("<>__capture_" + variable.Name, isReadOnly: true, type: retainedCaptureType)
            }
            boxInfo[variable] = BoxedVariable(variable, boxLocal, boxReference, fieldSymbol, retainedCapture)
            newStructs.Add(boxClass)
        }
        if boxInfo.Count == 0 && dropFromCapture.Count == 0 {
            return (body, emptyUpdates)
        }
        // Step 3: rewrite the body — locals, reads, writes, and lambdas.
        let rewriter = BoxingRewriter(boxInfo, dropFromCapture)
        rewrittenArguments = arguments.Select(rewriter.RewriteInitializer).ToImmutableArray()
        let rewritten = cast[BoundBlockStatement](rewriter.RewriteStatement(body))
        // Step 4: prepend per-parameter box allocation + seed.
        let paramBoxes = List[BoxedVariable]()
        for bi in boxInfo.Values {
            if bi.Original is ParameterSymbol parameter && function.Parameters.Contains(parameter) {
                paramBoxes.Add(bi)
            }
        }
        if paramBoxes.Count > 0 {
            // Keep parameter boxes in source-declaration order for a stable
            // local-signature row layout (Issue #456 determinism).
            paramBoxes.Sort(
                (a BoxedVariable, b BoxedVariable) -> string.CompareOrdinal(a.Original.Name, b.Original.Name)
            )
            let prologue = ImmutableArray.CreateBuilder[BoundStatement](
                (paramBoxes.Count * 2) + rewritten.Statements.Length
            )
            for bi in paramBoxes {
                prologue.AddRange(BuildBoxStatements(bi, BoundVariableExpression(nil, bi.Original)))
            }
            parameterPrologue = prologue.ToImmutable()
        }
        return (rewritten, rewriter.RewrittenLambdaBodies)
    }

    private func IsBoxable(
        variable VariableSymbol,
        function FunctionSymbol,
        nestedParameters HashSet[ParameterSymbol],
        persistentRoots HashSet[VariableSymbol]
    ) bool {
        // Only locals and parameters (parameters are LocalVariableSymbols).
        if variable is not LocalVariableSymbol local {
            return false
        }
        // The synthesized `this` parameter for instance methods is a stable
        // reference and never reassigned; snapshotting it is fine.
        if variable == function.ThisParameter {
            return false
        }
        // ADR-0060 / issue #491: ref-aliasing locals carry a managed pointer
        // in their slot; boxing would break the aliasing semantics. Issue
        // #4271: the binder now rejects this capture outright (GS9011)
        // before it ever reaches this pass; this guard is dead for the
        // closure-capture path but stays as a defense against future paths.
        if local.RefKind != RefKind.None {
            return false
        }
        // ADR-0058 / issue #376: managed pointer (T&) — binder rejects capture
        // already, but guard against future paths.
        if local.Type is ByRefTypeSymbol {
            return false
        }
        // Issue #367: by-ref-like types cannot be boxed.
        if TypeSymbol.IsByRefLike(local.Type) {
            return false
        }
        // ADR-0166: a boolean `is` pattern variable is assigned exactly once by
        // its match and is visible only in regions that match dominates, so
        // every closure that captures it is created after the assignment and
        // no later write can exist. Snapshotting it into the closure field is
        // therefore already correct — and unlike switch-arm bindings there is
        // no single statement body in which a box seed could be planted.
        if local is PatternVariableSymbol && !persistentRoots.Contains(local) {
            return false
        }
        // Parameters are boxable only when they belong to *this* function:
        // a captured parameter from an enclosing function is the responsibility
        // of that outer pass.
        if local is ParameterSymbol parameter && !function.Parameters.Contains(parameter) && !nestedParameters.Contains(
            parameter
        ) {
            return false
        }
        return true
    }

    private func CreateBoxClass(variable VariableSymbol, counter int32, packageName string) StructSymbol {
        let valueField = FieldSymbol("Value", variable.Type, Accessibility.Public)
        let name = "<>__Box_" + variable.Name + "_" + counter.ToString(CultureInfo.InvariantCulture)
        return StructSymbol(
            name,
            ImmutableArray.Create(valueField),
            Accessibility.Internal,
            declaration: nil,
            packageName: packageName,
            isData: false,
            isInline: false,
            isClass: true
        )
    }

    private func BuildBoxStatements(box BoxedVariable, initialValue BoundExpression?) ImmutableArray[BoundStatement] {
        let statements = ImmutableArray.CreateBuilder[BoundStatement](
            1 +
                (
                if initialValue == nil {
                    0
                } else {
                    1
                }
            ) +
                (
                if box.RetainedCapture == nil {
                    0
                } else {
                    1
                }
            )
        )
        statements.Add(
            BoundVariableDeclaration(
                nil,
                box.BoxLocal,
                BoundConstructorCallExpression(nil, box.BoxClass, ImmutableArray[BoundExpression].Empty)
            )
        )
        if initialValue != nil {
            statements.Add(
                BoundExpressionStatement(
                    nil,
                    BoundFieldAssignmentExpression(nil, box.BoxLocal, box.BoxClass, box.BoxField, initialValue)
                )
            )
        }
        if box.RetainedCapture != nil {
            statements.Add(
                BoundVariableDeclaration(
                    nil,
                    box.RetainedCapture,
                    BoundManagedReferenceExpression(
                        nil,
                        BoundFieldAccessExpression(
                            nil,
                            BoundVariableExpression(nil, box.BoxLocal),
                            box.BoxClass,
                            box.BoxField
                        ),
                        box.RetainedCapture.Type,
                        readOnly: false
                    )
                )
            )
        }
        return statements.MoveToImmutable()
    }
}
