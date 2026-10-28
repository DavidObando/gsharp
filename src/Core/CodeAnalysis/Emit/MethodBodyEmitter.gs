// <copyright file="MethodBodyEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Lowering.Iterators
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import GSharp.Core.CodeAnalysis
import System.Collections

/// PR-E-11: promoted from the formerly nested `BodyEmitter` class on
/// (cref:ReflectionMetadataEmitter). Owns per-method IL emission —
/// every statement, expression, pattern, operator, member access, call,
/// conversion, closure body, and async/iterator helper that runs while a
/// method body is being built. Constructor-injected with the per-method
/// slot dictionaries (allocated by (cref:SlotPlanner)) and a back-
/// reference to the root emitter for cross-method services (token cache,
/// well-known references, closure and state-machine orchestrators).
/// @remarks Internally subdivided into nested partials (`MethodBodyEmitter.Statements.cs`,
/// `.Expressions.cs`, `.Patterns.cs`, `.Operators.cs`,
/// `.MemberAccess.cs`, `.Calls.cs`, `.Conversions.cs`,
/// `.Closures.cs`, `.Async.cs`) so no single file is more than
/// ~1500 LoC. Behaviour-preserving — IL is byte-identical with the
/// pre-PR-E-11 baseline (see `RefactoringBaselineTests`).
internal partial class MethodBodyEmitter {
    internal prop SuppressNativeProtocolValidation bool {
        get;
        set;
    }
    private let coordinator ReflectionMetadataEmitter?
    private prop outer ReflectionMetadataEmitter -> Invariant.Required(
        this.coordinator,
        "an isolated method body cannot access metadata or generic remaps"
    )
    private let recordLocalSequencePoint((int32, SyntaxNode?) -> void)?
    private let il InstructionEncoder
    private let locals Dictionary[VariableSymbol, int32]
    private let parameters Dictionary[ParameterSymbol, int32]
    private let labels Dictionary[BoundLabel, LabelHandle]
    private let structLiteralSlots Dictionary[BoundStructLiteralExpression, int32]
    private let defaultExpressionSlots Dictionary[BoundDefaultExpression, int32]
    private let mapIndexSlots Dictionary[BoundIndexExpression, int32]
    private let patternSwitchSlots Dictionary[BoundPatternSwitchStatement, int32]
    private let typePatternScratchSlots Dictionary[BoundTypePattern, int32]
    private let switchExpressionSlots Dictionary[BoundSwitchExpression, (Result int32, Discriminant int32)]
    private let channelOpSlots Dictionary[BoundNode, (VT int32, TA int32, Result int32, Spare int32)]
    private let receiverSpillSlots Dictionary[BoundExpression, int32]
    private let stackAllocResultSlots Dictionary[BoundStackAllocExpression, int32]
    private let materializedStackAllocs HashSet[BoundStackAllocExpression] = HashSet[BoundStackAllocExpression]()

    // Issue #2283: a `<-ch` channel-receive expression emits its own inline
    // try/catch (see EmitChannelReceiveCore) to translate a closed-channel
    // exception into `default(T)`. ECMA-335 III.3.47 requires a protected
    // block to be entered with an empty evaluation stack. When the receive is
    // the WHOLE statement (or the direct initializer/RHS of one), the stack is
    // already empty at that point and this is safe. But when it is a
    // sub-expression — an operand of `+`, a call argument, embedded in a
    // larger expression — earlier operands are already sitting on the stack
    // when the receive's try/catch begins, producing invalid IL
    // (ilverify TryNonEmptyStack / StackUnderflow, and an
    // InvalidProgramException at run time). Track which receive nodes have
    // already had their try/catch materialised so every occurrence — root or
    // not — runs exactly once, at the start of its containing statement.
    // Issue #1688: tracks which planned receiverSpillSlots entries have
    // already been evaluated-and-cached during this method's emission. A
    // compound member assignment (`getObj().F += x` / `getObj().P += x`)
    // reuses the SAME receiver BoundExpression instance for both the read
    // (embedded in the compound RHS) and the write (the assignment's own
    // target) — see TryEmitCachedReceiver. The first encounter evaluates the
    // receiver and stores it; every later encounter of the identical node
    // instance loads the cached value/address instead of re-running the
    // (potentially side-effecting) receiver expression.
    private let spilledCompoundReceivers HashSet[BoundExpression] = HashSet[BoundExpression]()

    private let nullableCoalesceSpillSlots Dictionary[BoundBinaryExpression, int32]
    private let indexAssignmentValueSlots Dictionary[BoundExpression, int32]
    private let liftedBinarySlots Dictionary[BoundExpression, LiftedBinarySlots]
    private let structThisParameter ParameterSymbol?
    private let asyncFieldMap AsyncStateMachineFieldMap?
    private let asyncPlan AsyncStateMachinePlan?
    private let iteratorEmitCtx StateMachineEmitter.IteratorEmitContext?
    private let constValues Dictionary[VariableSymbol, object]?
    private let hasFixedReturns bool
    private let fixedReturnSlot int32
    private var fixedReturnLabel LabelHandle?

    // Issue #503 follow-up: when this MethodBodyEmitter is emitting the Invoke
    // method of a synthesized closure class, captures of the *enclosing*
    // closure are loaded/stored through `this`'s display-class fields
    // instead of looking for a local slot or parameter index. Null when
    // the current method isn't a closure Invoke.
    private let enclosingClosure ClosureEmitter.ClosureInfo?

    // 6.2 SilentEmitFailure invariant: track the most recently dispatched
    // BoundNode so that any exception thrown from deep in the emit pipeline
    // can be re-anchored at the offending source construct. Updated at the
    // top of EmitStatement and EmitExpression (the two dispatch chokepoints).
    private var currentNode BoundNode?

    /// Gets the (cref:SyntaxNode) of the most recently dispatched
    /// (cref:BoundNode), suitable for anchoring emit-failure diagnostics.
    internal prop CurrentAnchor SyntaxNode? -> this.currentNode?.Syntax

    // Stack of currently-active protected regions; each entry holds the set of
    // bound labels defined lexically within that region (including nested
    // protected sub-regions). Used to translate goto/conditional-goto whose
    // target lies outside the innermost region into the CLR-required `leave`.
    private let protectedRegionStack Stack[HashSet[BoundLabel]] = Stack[HashSet[BoundLabel]]()

    // Phase 4 (ADR-0027 §7.7a) Portable PDB sequence-point capture. Always
    // allocated (cheap) so EmitStatement can append without a null check;
    // the outer harvests this list via SequencePoints after EmitBlock and
    // hands it to PortablePdbEmitter only when PDB emit is enabled. Empty
    // for synthesized methods that go through other emit paths.
    private let sequencePoints List[SequencePoint] = List[SequencePoint]()

    private var lastSequencePointIlOffset int32 = -1

    // ADR-0174 P3-8: async stepping information for a MoveNext body — the
    // yield/resume IL offsets of the hidden await markers keyed by state, and
    // the outermost catch handler (the builder's SetException route).
    private let awaitYieldOffsets SortedDictionary[int32, int32] = SortedDictionary[int32, int32]()

    private let awaitResumeOffsets SortedDictionary[int32, int32] = SortedDictionary[int32, int32]()
    private var tryDepth int32
    private var outermostCatchHandlerOffset int32 = -1

    // Tracks whether the current linear IL position is closed by ret, throw,
    // or an unconditional branch. A label or ordinary instruction reopens it.
    private var currentPositionEndsInTerminator bool

    init(
        outer ReflectionMetadataEmitter?,
        il InstructionEncoder,
        locals Dictionary[VariableSymbol, int32],
        parameters Dictionary[ParameterSymbol, int32],
        labels Dictionary[BoundLabel, LabelHandle],
        structLiteralSlots Dictionary[BoundStructLiteralExpression, int32],
        defaultExpressionSlots Dictionary[BoundDefaultExpression, int32],
        mapIndexSlots Dictionary[BoundIndexExpression, int32],
        patternSwitchSlots Dictionary[BoundPatternSwitchStatement, int32],
        typePatternScratchSlots Dictionary[BoundTypePattern, int32],
        switchExpressionSlots Dictionary[BoundSwitchExpression, (Result int32, Discriminant int32)],
        channelOpSlots Dictionary[BoundNode, (VT int32, TA int32, Result int32, Spare int32)],
        receiverSpillSlots Dictionary[BoundExpression, int32],
        indexAssignmentValueSlots Dictionary[BoundExpression, int32],
        liftedBinarySlots Dictionary[BoundExpression, LiftedBinarySlots]? = nil,
        nullableCoalesceSpillSlots Dictionary[BoundBinaryExpression, int32]? = nil,
        structThisParameter ParameterSymbol? = nil,
        asyncFieldMap AsyncStateMachineFieldMap? = nil,
        asyncPlan AsyncStateMachinePlan? = nil,
        iteratorEmitCtx StateMachineEmitter.IteratorEmitContext? = nil,
        constValues Dictionary[VariableSymbol, object]? = nil,
        enclosingClosure ClosureEmitter.ClosureInfo? = nil,
        stackAllocResultSlots Dictionary[BoundStackAllocExpression, int32]? = nil,
        hasFixedReturns bool = false,
        fixedReturnSlot int32 = -1,
        recordLocalSequencePoint((int32, SyntaxNode?) -> void)? = nil
    ) {
        this.coordinator = outer
        this.recordLocalSequencePoint = recordLocalSequencePoint
        this.il = il
        this.locals = locals
        this.parameters = parameters
        this.labels = labels
        this.structLiteralSlots = structLiteralSlots
        this.defaultExpressionSlots = defaultExpressionSlots
        this.mapIndexSlots = mapIndexSlots
        this.patternSwitchSlots = patternSwitchSlots
        this.typePatternScratchSlots = typePatternScratchSlots
        this.switchExpressionSlots = switchExpressionSlots
        this.channelOpSlots = channelOpSlots
        this.receiverSpillSlots = receiverSpillSlots
        this.indexAssignmentValueSlots = indexAssignmentValueSlots
        this.liftedBinarySlots = liftedBinarySlots ?? Dictionary[BoundExpression, LiftedBinarySlots]()
        this.nullableCoalesceSpillSlots = nullableCoalesceSpillSlots ?? Dictionary[BoundBinaryExpression, int32]()
        this.structThisParameter = structThisParameter
        this.asyncFieldMap = asyncFieldMap
        this.asyncPlan = asyncPlan
        this.iteratorEmitCtx = iteratorEmitCtx
        this.constValues = constValues
        this.enclosingClosure = enclosingClosure
        this.stackAllocResultSlots = stackAllocResultSlots ?? Dictionary[BoundStackAllocExpression, int32]()
        this.hasFixedReturns = hasFixedReturns
        this.fixedReturnSlot = fixedReturnSlot
    }

    private func ResolveCurrentStateMachineFieldToken(field FieldSymbol) EntityHandle {
        let stateMachine StructSymbol? = this.asyncFieldMap?.StructType ?? this.iteratorEmitCtx?.SmClass
        if stateMachine == nil {
            throw InvalidOperationException("Hoisted field '${field.Name}' was loaded outside a state machine.")
        }
        // Generic state machines require a MemberRef parented at their
        // self-instantiated TypeSpec; a raw FieldDef changes the byref identity.
        return this.outer.userTokens.ResolveFieldToken(stateMachine, field)
    }

    prop SequencePoints IReadOnlyList[SequencePoint] -> this.sequencePoints

    /// Gets the async stepping information gathered while emitting this body
    /// (ADR-0174 P3-8), or `null` when the body contains no await marker
    /// — i.e. it is not a state machine's `MoveNext`.
    prop AsyncStepping AsyncMethodSteppingInfo? {
        get {
            if this.awaitYieldOffsets.Count == 0 {
                return nil
            }
            let awaits = ImmutableArray.CreateBuilder[(Yield int32, Resume int32)](this.awaitYieldOffsets.Count)
            for (state, yieldOffset) in this.awaitYieldOffsets {
                if this.awaitResumeOffsets.TryGetValue(state, out var resumeOffset) {
                    awaits.Add((yieldOffset, resumeOffset))
                }
            }
            return AsyncMethodSteppingInfo(this.outermostCatchHandlerOffset, awaits.ToImmutable())
        }
    }

    /// Issue #306: emits a single value expression onto the IL stack. Used by the constructor emitter to
    /// evaluate base-constructor argument expressions.
    /// @param expression The bound value expression to emit.
    func EmitValue(expression BoundExpression) -> this.EmitExpression(expression)

    /// Issue #306: emits base-constructor arguments, respecting (cref:RefKind) for by-ref base parameters.
    /// @param arguments The bound base-constructor argument expressions.
    /// @param refKinds The per-argument by-reference passing modes.
    func EmitBaseConstructorArguments(
        arguments ImmutableArray[BoundExpression],
        refKinds ImmutableArray[RefKind]
    ) -> this.EmitImportedCallArguments(arguments, refKinds)

    func EmitBlock(block BoundBlockStatement) {
        for statement in block.Statements {
            this.EmitStatement(statement)
        }
    }

    func EmitMethodBody(body BoundBlockStatement, alwaysAppendRet bool) {
        this.EmitBlock(body)
        let emitFallthroughGuard = !alwaysAppendRet && !this.currentPositionEndsInTerminator
        var fallthroughGuardLabel LabelHandle? = nil
        if emitFallthroughGuard && (this.fixedReturnLabel != nil) {
            fallthroughGuardLabel = this.il.DefineLabel()
            this.il.Branch(ILOpCode.Br, fallthroughGuardLabel!!)
        }
        if this.EmitFixedReturnEpilogue() {
            this.il.OpCode(ILOpCode.Ret)
            if !(fallthroughGuardLabel != nil) {
                return
            }
            this.il.MarkLabel(fallthroughGuardLabel)
        }
        if alwaysAppendRet {
            this.il.OpCode(ILOpCode.Ret)
        } else if emitFallthroughGuard {
            let constructor = BclMember.Ctor(typeof(InvalidOperationException), typeof(string))
            this.il.LoadString(
                this.outer.emitCtx.Metadata.GetOrAddUserString(DiagnosticDescriptors.NonVoidFallthroughGuardMessage)
            )
            this.il.OpCode(ILOpCode.Newobj)
            this.il.Token(this.outer.memberRefs.GetCtorReference(constructor))
            this.il.OpCode(ILOpCode.Throw)
        }
    }

    func EmitFixedReturnEpilogue() bool {
        if !(this.fixedReturnLabel != nil) {
            return false
        }
        this.il.MarkLabel(this.fixedReturnLabel!!)
        if this.fixedReturnSlot >= 0 {
            this.il.LoadLocal(this.fixedReturnSlot)
        }
        return true
    }

    private func GetFixedReturnLabel() LabelHandle {
        this.fixedReturnLabel ??= this.il.DefineLabel()
        return this.fixedReturnLabel!!
    }

    private func EmitBlockExpression(blockExpression BoundBlockExpression) {
        this.EmitBlockExpressionPrefix(blockExpression)
        this.EmitExpression(blockExpression.Expression)
    }

    private func EmitBlockExpressionPrefix(blockExpression BoundBlockExpression) {
        // Labels introduced inside an expression-position block (e.g. the
        // short-circuit gate emitted by InterpolatedStringHandlerLowerer)
        // are not seen by the function-level CollectStatements pre-pass,
        // which only walks statement positions. Pre-declare them here so
        // forward conditional branches can resolve their target handles.
        for statement in blockExpression.Statements {
            let nested = HashSet[BoundLabel]()
            this.CollectLabels(statement, nested)
            for label in nested {
                if !this.labels.ContainsKey(label) {
                    this.labels[label] = this.il.DefineLabel()
                }
            }
        }
        for statement in blockExpression.Statements {
            this.EmitStatement(statement)
        }
    }

    private func EmitStatement(statement BoundStatement) {
        let startOffset = this.il.Offset
        if statement.Syntax != nil {
            this.currentNode = statement
        }
        this.RecordSequencePointFor(statement)
        this.MaterializeSpilledStackAllocs(statement)
        switch statement {
            case block is BoundBlockStatement {
                this.EmitBlock(block)
            }
            case expr is BoundExpressionStatement {
                this.EmitExpression(expr.Expression)
                if expr.Expression.Type != TypeSymbol.Void {
                    this.il.OpCode(ILOpCode.Pop)
                }
            }
            case ret is BoundReturnStatement {
                if ret.Expression != nil {
                    // Issue #490 (ADR-0060 follow-up): a `return ref <lvalue>` arrives
                    // as a BoundAddressOfExpression wrapping the lvalue. Emit the address
                    // (ldloca / ldarga / ldflda / ldelema / dereferenced pointer) so the
                    // returned `T&` slot holds the managed pointer the signature declares.
                    if ret.IsRef && ret.Expression is BoundAddressOfExpression addrOf {
                        this.EmitAddressOf(addrOf)
                    } else {
                        this.EmitExpression(ret.Expression!!)
                    }
                }
                if this.protectedRegionStack.Count > 0 && this.hasFixedReturns {
                    if ret.Expression != nil {
                        this.il.StoreLocal(this.fixedReturnSlot)
                    }
                    this.il.Branch(ILOpCode.Leave, this.GetFixedReturnLabel())
                } else {
                    this.il.OpCode(ILOpCode.Ret)
                }
            }
            case decl is BoundVariableDeclaration {
                if decl.ConstantValue != nil || (decl.Variable is GlobalVariableSymbol and {IsConst: true}) {
                    break // value inlined at read sites; initializer is a side-effect-free literal

                }
                let initializer = Invariant.Required(
                    decl.Initializer,
                    "every declaration the binder emits carries an initializer -- an unbindable one is recovered as a BoundErrorExpression, not as an absent initializer",
                    expression: "decl.Initializer"
                )
                this.EmitExpression(initializer)
                this.EmitStoreVariable(decl.Variable)
            }
            case BoundLocalFunctionDeclaration { }
            case lbl is BoundLabelStatement {
                this.il.MarkLabel(this.labels[lbl.Label])
            }
            case g is BoundGotoStatement {
                this.EmitBranch(g.Label, conditional: nil, jumpIfTrue: false)
            }
            case cg is BoundConditionalGotoStatement {
                this.EmitBranch(cg.Label, conditional: cg.Condition, jumpIfTrue: cg.JumpIfTrue)
            }
            case tryStmt is BoundTryStatement {
                this.EmitTryStatement(tryStmt)
            }
            case throwStmt is BoundThrowStatement {
                this.EmitExpression(throwStmt.Expression)
                this.il.OpCode(ILOpCode.Throw)
            }
            case BoundRethrowStatement {
                // ADR-0176 (#3897): `rethrow` re-raises the exception the
                // enclosing CLR catch handler is processing. `rethrow` is not
                // `throw <expr>`: it preserves the original StackTrace, where
                // `throw` resets it to this site. The binder guarantees we are
                // lexically inside a catch handler.
                this.il.OpCode(ILOpCode.Rethrow)
            }
            case ps is BoundPatternSwitchStatement {
                this.EmitPatternSwitchStatement(ps)
            }
            case go_ is BoundGoStatement {
                this.EmitGoStatement(go_)
            }
            case fixedStmt is BoundFixedStatement {
                this.EmitFixedStatement(fixedStmt)
            }
            case BoundYieldStatement {
                EmitDiagnosticException.Throw(
                    statement.Syntax,
                    "Internal error: yield reached the emitter before iterator lowering."
                )
            }
            case awaitMarker is BoundAwaitSequencePoint {
                // ADR-0174 P3-8: the marker's offset is the yield/resume point
                // the Portable PDB async-stepping blob reports for this await.
                let markers = if awaitMarker.Kind == BoundNodeKind.AwaitYieldPoint {
                    this.awaitYieldOffsets
                } else {
                    this.awaitResumeOffsets
                }
                markers.TryAdd(awaitMarker.State, this.il.Offset)
                this.il.OpCode(ILOpCode.Nop)
            }
            default {
                EmitDiagnosticException.Throw(
                    statement.Syntax,
                    "Bound statement kind '${statement.Kind}' is not yet supported by the emitter."
                )
            }
        }
        if statement is BoundLabelStatement {
            this.currentPositionEndsInTerminator = false
        } else if !(statement is BoundBlockStatement) && this.il.Offset != startOffset {
            this.currentPositionEndsInTerminator = statement is BoundReturnStatement ||
                statement is BoundThrowStatement ||
                statement is BoundRethrowStatement ||
                statement is BoundGotoStatement
        }
    }

    // Phase 4 (ADR-0027 §7.7a): record a sequence point for the current
    // statement before its first opcode lands in the IL stream. Structural
    // wrappers leave that offset to their first child statement (issue #5014).
    // BoundAwaitSequencePoint and synthesized statements map to hidden points.
    private func RecordSequencePointFor(statement BoundStatement) {
        switch statement {
            case BoundBlockStatement, BoundLabelStatement, BoundTryStatement {
                return
            }
        }
        this.RecordSequencePoint(
            if statement is BoundAwaitSequencePoint {
                nil
            } else {
                statement.Syntax
            }
        )
    }

    private func RecordSequencePoint(syntax SyntaxNode?) {
        if this.recordLocalSequencePoint != nil {
            if this.il.Offset != this.lastSequencePointIlOffset {
                this.recordLocalSequencePoint(this.il.Offset, syntax)
                this.lastSequencePointIlOffset = this.il.Offset
            }
            return
        }
        if this.outer.emitCtx.Pdb == nil {
            return
        }
        let ilOffset = this.il.Offset
        if ilOffset == this.lastSequencePointIlOffset {
            // Avoid two consecutive records at the same IL offset — the
            // Portable PDB sequence-point encoding forbids δIL = 0 except
            // for the first record.
            return
        }
        if syntax == nil {
            this.sequencePoints.Add(SequencePoint.Hidden(ilOffset, document: default(DocumentHandle)))
            this.lastSequencePointIlOffset = ilOffset
            return
        }
        var location = syntax.Location
        if location.Text == nil {
            this.sequencePoints.Add(SequencePoint.Hidden(ilOffset, document: default(DocumentHandle)))
            this.lastSequencePointIlOffset = ilOffset
            return
        }
        let documentHandle = this.outer.emitCtx.Pdb!!.GetOrAddDocument(syntax.SyntaxTree)
        let positions = location.GetLineRange()
        this.sequencePoints.Add(
            SequencePoint(
                ilOffset: ilOffset,
                document: documentHandle,
                startLine: positions.StartLine + 1,
                startColumn: positions.StartCharacter + 1,
                endLine: positions.EndLine + 1,
                endColumn: positions.EndCharacter + 1
            )
        )
        this.lastSequencePointIlOffset = ilOffset
    }

    // Issue #1522: before a statement's own IL is emitted (evaluation stack is
    // empty here), materialise every spilled `stackalloc` sub-expression that
    // this statement contains, in source order, into its pre-allocated result
    // local. The `localloc` therefore runs at an empty stack, satisfying
    // ECMA-335 III.3.47; the original operand position later loads the result
    // local. Nested statements are handled by their own EmitStatement pass, so
    // this walker does not descend past the first statement boundary.
    private func MaterializeSpilledStackAllocs(statement BoundStatement) {
        if this.stackAllocResultSlots.Count == 0 {
            return
        }
        let spilled = List[BoundStackAllocExpression]()
        SpilledStackAllocCollector(this.stackAllocResultSlots, spilled).Visit(statement)
        for sa in spilled {
            if !this.materializedStackAllocs.Add(sa) {
                continue
            }
            this.EmitStackAllocCore(sa)
            this.il.StoreLocal(this.stackAllocResultSlots[sa])
        }
    }

    /// Gets the encoder's control-flow builder, which every body this emitter
    /// writes has: both callers that construct a MethodBodyEmitter --
    /// FunctionEmitter and ConstructorBodyEmitter -- build their
    /// (cref:InstructionEncoder) with one. (The synthesized bodies in
    /// DataStructSynthesizer do not, but they contain no protected region and
    /// never reach this emitter.)
    private prop ControlFlow ControlFlowBuilder -> Invariant.Required(
        this.il.ControlFlowBuilder,
        "FunctionEmitter and ConstructorBodyEmitter build every encoder this emitter writes into with a control-flow builder",
        expression: "this.il.ControlFlowBuilder"
    )

    /// Issue #4358: whether [`target`](paramref) is the natural
    /// structural delegate shape [`sourceFn`](paramref) materialises as
    /// — the same `System.Func`N` / `System.Action[`N]` definition
    /// `SignatureEncoder.ResolveDelegateClrType` builds for it.
    /// @remarks The name alone is not enough: a user assembly may declare its own
    /// `System.Func` (issue #2948 supports exactly that collision), which
    /// is a named delegate with a fixed signature. Comparing against the
    /// natural definition for THIS source also pins the arity, so a
    /// same-named delegate of a different arity can never qualify. Compared
    /// by full name and assembly identity, since the two may come from
    /// different reflection contexts (reference identity and
    /// `ClrTypeUtilities.AreSame`, which is full-name based, are not
    /// usable here).
    /// @param target The (possibly constructed) target delegate type.
    /// @param sourceFn The source function type.
    /// @returns `true` when the target is the natural shape.
    private func IsNaturalDelegateShapeOf(target Type?, sourceFn FunctionTypeSymbol) bool {
        let OpenDefinition = func (type Type) Type {
            return if type.IsGenericType && !type.IsGenericTypeDefinition {
                type.GetGenericTypeDefinition()
            } else {
                type
            }
        }
        // Func/Action stop at 16 parameters; a wider function type has no
        // natural shape to compare against (ResolveDelegateClrType would throw).
        if target == nil || sourceFn.ParameterTypes.Length > 16 {
            return false
        }
        let natural = this.outer.signatures.ResolveDelegateClrType(sourceFn)
        let targetDefinition = OpenDefinition(target)
        let naturalDefinition = OpenDefinition(natural)
        return string.Equals(targetDefinition.FullName, naturalDefinition.FullName, StringComparison.Ordinal) &&
            string
            .Equals(
            targetDefinition.Assembly.GetName().Name,
            naturalDefinition.Assembly.GetName().Name,
            StringComparison.Ordinal
        )
    }

    private func CollectLabels(statement BoundStatement, sink HashSet[BoundLabel]) {
        switch statement {
            case nil {
                return
            }
            case lbl is BoundLabelStatement {
                sink.Add(lbl.Label)
                return
            }
            case block is BoundBlockStatement {
                for s in block.Statements {
                    this.CollectLabels(s, sink)
                }
                return
            }
            case t is BoundTryStatement {
                this.CollectLabels(t.TryBlock, sink)
                for c in t.CatchClauses {
                    this.CollectLabels(c.Body, sink)
                }
                if t.FinallyBlock != nil {
                    this.CollectLabels(t.FinallyBlock, sink)
                }
                return
            }
            case fx is BoundFixedStatement {
                this.CollectLabels(fx.Body, sink)
                return
            }
            case es is BoundExpressionStatement {
                this.CollectLabelsInExpression(es.Expression, sink)
                return
            }
            case cg is BoundConditionalGotoStatement {
                this.CollectLabelsInExpression(cg.Condition, sink)
                return
            }
            case rs is BoundReturnStatement {
                this.CollectLabelsInExpression(rs.Expression, sink)
                return
            }
            default {
                // All other structured statements (if/for/while/...) are
                // flattened to BoundGotoStatement/BoundConditionalGotoStatement
                // by Lowerer before reaching the emitter. However, any
                // statement that carries a BoundExpression may transitively
                // contain a BoundBlockExpression (interpolated-string handler
                // gate, null-conditional capture, switch-expression spill,
                // ...) whose statement list introduces BoundLabelStatements.
                // Those labels are registered in this.labels by
                // EmitBlockExpression, but if they are not added here the
                // EmitBranch crossesRegion heuristic emits an illegal Leave
                // for a same-region goto (issue #418 / P1-4). Use a generic
                // walker as a safety net for any statement kind that might
                // carry an expression-position block.
                this.outer.slotPlanner.CollectExpressionBlockLabels(statement, sink)
                return
            }
        }
    }

    // Recursively collects BoundLabelStatement labels that live inside a
    // BoundExpression sub-tree. This is the inverse-side of CollectLabels
    // for expression-position blocks (BoundBlockExpression et al.).
    private func CollectLabelsInExpression(expression BoundExpression?, sink HashSet[BoundLabel]) {
        if expression == nil {
            return
        }
        this.outer.slotPlanner.CollectExpressionBlockLabels(expression, sink)
    }

    private func EmitBranch(target BoundLabel, conditional BoundExpression?, jumpIfTrue bool) {
        let targetHandle = this.labels[target]
        let crossesRegion = this.protectedRegionStack.Count > 0 && !this.protectedRegionStack.Peek().Contains(target)
        if conditional is BoundLiteralExpression{Value: bool value} {
            if value == jumpIfTrue {
                this.il.Branch(
                    if crossesRegion {
                        ILOpCode.Leave
                    } else {
                        ILOpCode.Br
                    },
                    targetHandle
                )
            }
            return
        }
        if conditional == nil {
            this.il.Branch(
                if crossesRegion {
                    ILOpCode.Leave
                } else {
                    ILOpCode.Br
                },
                targetHandle
            )
            return
        }
        if !crossesRegion {
            this.EmitConditionalGotoProbe(conditional)
            this.il.Branch(
                if jumpIfTrue {
                    ILOpCode.Brtrue
                } else {
                    ILOpCode.Brfalse
                },
                targetHandle
            )
            return
        }
        // Conditional goto that crosses a protected region boundary:
        // `leave` is not conditional, so emit the inverse branch over a
        // `leave` to the target.
        let skipLabel = this.il.DefineLabel()
        this.EmitConditionalGotoProbe(conditional)
        this.il.Branch(
            if jumpIfTrue {
                ILOpCode.Brfalse
            } else {
                ILOpCode.Brtrue
            },
            skipLabel
        )
        this.il.Branch(ILOpCode.Leave, targetHandle)
        this.il.MarkLabel(skipLabel)
    }

    // Issue #1700: a BoundConditionalGotoStatement whose condition is a
    // value-type `Nullable<T>` (e.g. the null-conditional-access spiller's
    // receiver capture for a struct/enum `T?`) cannot use `brtrue`/`brfalse`
    // directly on the loaded struct — that is invalid IL (ilverify
    // StackUnexpected: a Nullable<T> value has no valid truthy
    // interpretation). Mirror the `??`/`!!` null-probe shapes elsewhere in
    // this emitter: `box Nullable<T>` yields `null` when `HasValue == false`
    // and a boxed `T` otherwise (ECMA-335 §I.8.2.4), giving an object
    // reference that `brtrue`/`brfalse` can legally test. This covers BCL
    // value types, user-declared struct/enum underlyings (null ClrType during
    // emit — GetElementTypeToken already closes the TypeSpec over the emitted
    // TypeDef for those), and struct-constrained open type parameters
    // uniformly, since no reload of the boxed value is needed here (the
    // non-null branch re-reads the original capture/local, not this probe).
    private func EmitConditionalGotoProbe(conditional BoundExpression) {
        this.EmitExpression(conditional)
        if conditional.Type is NullableTypeSymbol nullable &&
            (NullableLifting.IsValueTypeNullable(nullable) || NullableLifting.IsUserValueTypeNullable(nullable)) {
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(nullable))
        }
    }

    private class ReceiverMutationDetector : BoundTreeWalker {
        private let receiver VariableSymbol

        init(receiver VariableSymbol) {
            this.receiver = receiver
        }

        prop Found bool {
            get;
            private set;
        }

        protected override func VisitAssignmentExpression(node BoundAssignmentExpression) {
            if object.ReferenceEquals(node.Variable, this.receiver) {
                this.Found = true
            }
            base.VisitAssignmentExpression(node)
        }
    }

    // Issue #1522: collects the spilled `stackalloc` sub-expressions directly
    // contained in a single statement, in source (evaluation) order, without
    // descending into nested statements (each of those runs its own
    // materialisation pass in EmitStatement).
    private class SpilledStackAllocCollector : BoundTreeWalker {
        private let spilled IReadOnlyDictionary[BoundStackAllocExpression, int32]
        private let sink List[BoundStackAllocExpression]
        private var entered bool

        init(spilled IReadOnlyDictionary[BoundStackAllocExpression, int32], sink List[BoundStackAllocExpression]) {
            this.spilled = spilled
            this.sink = sink
        }

        override func VisitStatement(node BoundStatement?) {
            if node == nil {
                return
            }
            if this.entered {
                return
            }
            this.entered = true
            base.VisitStatement(node)
        }

        override func VisitExpression(node BoundExpression?) {
            if node == nil {
                return
            }
            // Post-order: a stackalloc nested inside another spilled
            // stackalloc's count/initializer must be materialised first so the
            // outer materialisation reads it back with an empty stack.
            base.VisitExpression(node)
            if node is BoundStackAllocExpression sa && this.spilled.ContainsKey(sa) {
                this.sink.Add(sa)
            }
        }
    }

    private func GetChannelMethodEntityHandle(method MethodInfo, elementType TypeSymbol) EntityHandle {
        let closedCarrier = Invariant.Required(
            method.DeclaringType,
            "a channel member is looked up on a constructed Channel/ChannelReader/ChannelWriter type, which declares it",
            expression: "method.DeclaringType"
        )
        let openDefinition = closedCarrier.GetGenericTypeDefinition()
        return this
            .outer
            .memberRefs
            .GetMethodEntityHandle(method, ResolveChannelContainerSymbol(closedCarrier, openDefinition, elementType))
    }

    private func GetChannelGenericMethodEntityHandle(method MethodInfo, elementType TypeSymbol) EntityHandle -> this
        .outer
        .memberRefs
        .GetMethodEntityHandle(method, ToNullableTypeArguments(ResolveChannelMethodTypeArguments(elementType)))

    shared {
        private func IsObjectStackType(type TypeSymbol) bool {
            if type == TypeSymbol.Object || type?.ClrType.IsSameAs(typeof(object)) == true {
                return true
            }
            return type is TypeParameterSymbol ||
                (type is ImportedTypeSymbol imported && imported.HasTypeParameterArgument) ||
                (type is FunctionTypeSymbol fn && TypeSymbol.ContainsTypeParameter(fn))
        }

        private func GetEnumUnderlyingTypeSymbol(type TypeSymbol?) TypeSymbol? {
            if type is EnumSymbol enumSym {
                return enumSym.UnderlyingType
            }
            // Issue #2327: `type.ClrType` may be a
            // System.Reflection.Emit.TypeBuilderInstantiation (e.g. a
            // compiler-synthesized structural function-type delegate closed
            // over an in-flight TypeBuilder definition), whose `IsEnum` throws
            // NotSupportedException. Route through the shared safe helper
            // (generalizing the #1100/#2135 pattern) rather than probing
            // `ClrType.IsEnum` directly — a throw means the type is definitely
            // not an enum, matching the guard used by EnumOperatorTable.
            let underlying Type? = if type?.ClrType is {} clrType {
                clrType.GetEnumUnderlyingTypeSafe()
            } else {
                default(Type?)
            }
            if underlying != nil {
                // Loaded via a MetadataLoadContext or normal load: map the CLR
                // underlying type back to a TypeSymbol for the numeric lattice.
                return TypeSymbol.FromClrTypeWithoutNullability(underlying, NullabilityFreeReason.TypeStructure)
            }
            return nil
        }

        private func IsInterfaceTargetType(type TypeSymbol?) bool {
            var type = type
            if type is NullableTypeSymbol nullable {
                type = nullable.UnderlyingType
            }
            return Conversion.IsInterfaceLikeType(type)
        }

        private func IsInterfaceSourceType(type TypeSymbol?) bool -> IsInterfaceTargetType(type)

        private func IsExplicitUnboxingSourceType(type TypeSymbol) bool {
            var type = type
            if type is NullableTypeSymbol nullable {
                type = nullable.UnderlyingType
            }
            return type?.ClrType.IsSameAs(typeof(object)) == true || type?.ClrType.IsSameAs(
                typeof(ValueType)
            ) == true ||
                type
                ?.ClrType
                .IsSameAs(typeof(Enum)) == true || IsInterfaceSourceType(type)
        }

        private func IsUnsignedClrType(t Type) bool -> t.IsSameAs(typeof(uint8)) || t.IsSameAs(typeof(uint16)) ||
            t.IsSameAs(typeof(uint32)) || t.IsSameAs(typeof(uint64)) || t.IsSameAs(typeof(nuint)) || t.IsSameAs(
            typeof(char)
        )

        private func IsNumericClrType(t Type) bool -> t.IsSameAs(typeof(int8)) || t.IsSameAs(typeof(uint8)) ||
            t.IsSameAs(typeof(int16)) || t.IsSameAs(typeof(uint16)) || t.IsSameAs(typeof(int32)) || t.IsSameAs(
            typeof(uint32)
        ) ||
            t.IsSameAs(typeof(int64)) || t.IsSameAs(typeof(uint64)) || t.IsSameAs(typeof(nint)) || t.IsSameAs(
            typeof(nuint)
        ) ||
            t.IsSameAs(typeof(float32)) || t.IsSameAs(typeof(float64)) || t.IsSameAs(typeof(decimal)) || t.IsSameAs(
            typeof(char)
        )

        private func Is32BitOrSmaller(t Type) bool -> t.IsSameAs(typeof(int8)) || t.IsSameAs(typeof(uint8)) ||
            t.IsSameAs(typeof(int16)) || t.IsSameAs(typeof(uint16)) || t.IsSameAs(typeof(int32)) || t.IsSameAs(
            typeof(uint32)
        ) ||
            t.IsSameAs(typeof(char)) || t.IsSameAs(typeof(bool))

        private func IsReferenceCompatible(a TypeSymbol?, b TypeSymbol?) bool {
            var a = a
            var b = b
            // Issue #3501: inner generic nullability metadata does not change the
            // CLR reference shape — mirror ClassifyCore's unwrap so an annotated
            // imported target (e.g. the `IEqualityComparer<T>?` constructor
            // parameter surfaced through the MetadataLoadContext) matches the
            // same arms its bare shape would.
            while a is NullabilityAnnotatedTypeSymbol aAnnotated {
                a = aAnnotated.BaseType
            }
            while b is NullabilityAnnotatedTypeSymbol bAnnotated {
                b = bAnnotated.BaseType
            }
            if a == b {
                return true
            }
            // Issue #2354 follow-up: the SAME self-referential generic class type
            // can surface as two non-reference-equal StructSymbol instances — an
            // OPEN generic definition (e.g. the type of a generic class's own
            // `this` parameter) versus the identical type spelled out explicitly
            // with its own type parameters as arguments (e.g. a member signature
            // written `Box[T]` inside `class Box[T]`, bound via
            // `StructSymbol.Construct`). Both erase to the exact same TypeDef at
            // the IL level, so the conversion is a no-op reference load — mirrors
            // `Conversion.AreSameConstructedStructIdentity`, the binder-side rule
            // that admits this same case for `Conversion.Classify` (e.g. `return
            // this` from such a method). Reusing the shared predicate keeps the
            // binder's and emitter's notion of "same type" from drifting apart.
            if a is StructSymbol aSelfStruct &&
                b is StructSymbol bSelfStruct &&
                Conversion.AreSameConstructedStructIdentity(aSelfStruct, bSelfStruct) {
                return true
            }
            // Issue #1431: two reference types that resolve to the SAME closed CLR
            // type token are identical at the IL level even when their symbols use
            // different representations of the same type argument (e.g. a lambda
            // body bound against a native `(T) -> IEnumerable[R]` parameter yields
            // `IEnumerable<System.Int64>` projected through the
            // MetadataLoadContext, while the substituted target return is the
            // GS-side `IEnumerable[int64]` whose `ClrType` still carries the erased
            // `IEnumerable<object>` shape but whose `TypeArguments` correctly hold
            // `int64`). Both denote the identical metadata instantiation, so
            // assigning one into the other is a no-op reference conversion. Without
            // this, native-function-type lambda returns that mention a closed
            // generic threw NotSupportedException from EmitConversion (the
            // CLR-delegate `Func[...]` form already matched via reference
            // equality). The comparison reconstructs each side's effective closed
            // shape from its symbol `TypeArguments` (preferred) or `ClrType`
            // generic arguments so an erased `ClrType` does not defeat the match.
            if SameClosedReferenceShape(a, b) {
                return true
            }
            // ADR-0045: any reference type widens to `object` at the IL
            // level as a no-op; the slot already holds the reference.
            if b?.ClrType.IsSameAs(typeof(object)) == true && a?.ClrType != nil && !a!!.ClrType!!.IsValueType {
                return true
            }
            // Issue #990: a user-declared reference type (a `class`, modelled as
            // a StructSymbol with IsClass == true) has no ClrType during emit
            // because its TypeDef only exists in the assembly being emitted, so
            // the CLR-backed rule above cannot fire. Such a reference still
            // widens to `object` as a no-op (the slot already holds the
            // reference). This unblocks generators whose element type is a user
            // class: the synthesized non-generic `IEnumerator.Current` property
            // converts the strongly-typed `<>2__current` field to `object`.
            if b?.ClrType.IsSameAs(typeof(object)) == true && a is StructSymbol userClass && userClass.IsClass {
                return true
            }
            // Issue #1421: a user-declared interface value is a CLR reference type,
            // so widening it to `object` — or up to any of its (transitive) base
            // interfaces, user-declared (`BaseInterfaces`) or imported CLR
            // (`BaseClrInterfaces`) — is a no-op reference conversion at the IL
            // level (the slot already holds the reference). The InterfaceSymbol
            // carries no ClrType during emit (its TypeDef only exists in the
            // assembly being emitted), so the CLR-backed `object`-widening and #521
            // rules cannot fire. Without this, passing an interface-typed value to a
            // `ThrowIfNull(object?)`-style parameter — or assigning it to `object` —
            // threw NotSupportedException from EmitConversion.
            if a is InterfaceSymbol srcInterface {
                if b?.ClrType.IsSameAs(typeof(object)) == true || b == TypeSymbol.Object {
                    return true
                }
                if b is InterfaceSymbol targetBaseInterface {
                    for baseInterface in srcInterface.SelfAndAllBaseInterfaces() {
                        if baseInterface == targetBaseInterface {
                            return true
                        }
                        // Issue #1927: declaration-site variance. Mirrors the
                        // binder-side `Conversion.IsVarianceCompatibleInterfaceConversion`
                        // rule so the emitter recognizes the SAME conversions the
                        // binder already accepted. At the IL level this is still a
                        // plain reference load with no cast: the constructed
                        // interface types are erased to the SAME open generic CLR
                        // interface definition (differing only by type argument),
                        // and CLR generic-interface variance (`Ijw<out T>` /
                        // `Ijw<in T>`) makes the runtime reference directly
                        // assignment-compatible.
                        if Conversion.IsVarianceCompatibleInterfaceConversion(baseInterface, targetBaseInterface) {
                            return true
                        }
                    }
                }
                if b?.ClrType is {IsInterface: true} targetClrInterface {
                    for iface in srcInterface.SelfAndAllBaseInterfaces() {
                        for baseClrInterface in iface.BaseClrInterfaces {
                            let clr Type? = baseClrInterface?.ClrType
                            // Issue #2135: `targetClrInterface` may be a
                            // TypeBuilderInstantiation whose IsAssignableFrom throws
                            // NotSupportedException at emit; use the guarded by-name
                            // helper instead of calling IsAssignableFrom directly.
                            if clr != nil &&
                                (
                                clr.IsSameAs(targetClrInterface) || ClrTypeUtilities.IsAssignableByName(
                                    targetClrInterface,
                                    clr
                                )
                            ) {
                                return true
                            }
                        }
                    }
                }
            }
            // Issue #1481 / #3255: maps, channels, and function types are CLR
            // reference types. When their symbolic shape references an in-scope
            // type parameter, the symbol carries no ClrType during emit, so the
            // CLR-backed `object`-widening rule above cannot fire. Widening such a
            // reference to `object` is still a no-op (the slot already holds the
            // reference). This unblocks a generic iterator whose element type is a
            // map, channel, or function: the synthesized non-generic
            // `IEnumerator.Current` getter converts the strongly-typed reified
            // `<>2__current` field to `object`.
            if (a is MapTypeSymbol || a is FunctionTypeSymbol || a is ChannelTypeSymbol) &&
                (b?.ClrType.IsSameAs(typeof(object)) == true || b == TypeSymbol.Object) {
                return true
            }
            // Issue #3310 / ADR-0159: same-element `[]T → sequence[T]` is a no-op
            // reference conversion at the IL level (`T[]` implements
            // `IEnumerable<T>`), including the open shapes where the element type
            // references an in-scope type parameter or same-compilation struct
            // and both symbols carry a null ClrType. Mirrors the binder's
            // matching arm in Conversion.ClassifyCore; used by the synthesized
            // empty-sequence zero value and by user-written `[]K{}` assignments
            // into `sequence[K]` slots.
            if a is SliceTypeSymbol aSliceToSeq &&
                b is SequenceTypeSymbol bSeqFromSlice &&
                aSliceToSeq.ElementType == bSeqFromSlice.ElementType {
                return true
            }
            // Issue #3566: IEnumerable<T> (and its sequence[T] alias) implements
            // the non-generic System.Collections.IEnumerable by definition, so
            // the upcast is a no-op reference conversion at the IL level. Mirrors
            // the binder's matching arm in Conversion.ClassifyCore — needed
            // because the hybrid runtime/MetadataLoadContext constructed shape
            // defeats the CLR-backed assignability rules. IAsyncEnumerable
            // shapes never classify into this conversion binder-side.
            if a != nil && SequenceTypeSymbol.TryGetEnumerableInterfaceShape(a, out var aEnumerableDefinition, out _) &&
                aEnumerableDefinition?.FullName == "System.Collections.Generic.IEnumerable`1" &&
                b
                ?.ClrType
                ?.FullName == "System.Collections.IEnumerable" {
                return true
            }
            if a is StructSymbol aClass && b is StructSymbol bClass && aClass.IsClass && bClass.IsClass {
                // Issue #1248: a constructed generic class's base-type reference is
                // declared with the derived class's own type parameters (e.g.
                // `TransformBase[TIn, TOut] : FilterBase[TIn]`) and is kept
                // unsubstituted on the constructed symbol, so reference equality
                // against the constructed target (`FilterBase[int32]`) fails. The
                // upcast is a no-op reference conversion at the IL level regardless
                // of type arguments, and the binder already validated argument
                // compatibility, so matching by generic definition along the base
                // chain correctly recognises it.
                let aClassChain = aClass.GetHierarchy()
                for var level = 1; level < aClassChain.Count; level++ {
                    let c = aClassChain[level]
                    if c == bClass || object.ReferenceEquals(c.Definition, bClass.Definition) {
                        return true
                    }
                }
            }
            // Phase D: class → interface upcast. The CLR satisfies the
            // contract at the reference level (no IL op required); we only
            // need to recognise it so EmitConversion emits a no-op. Walk
            // the class hierarchy so an interface declared on a base class
            // is also recognised on the derived class.
            if a is StructSymbol srcClass && srcClass.IsClass && b is InterfaceSymbol targetIface {
                for c in srcClass.GetHierarchy() {
                    for iface in c.Interfaces {
                        // Issue #3236: mirror the binder's #2535 rule —
                        // declaration-site variance lifts through a class's
                        // implemented interface (`Service : IService[object]` →
                        // `IService[object?]`), exactly as the #1927 arm above
                        // already recognises for an interface-typed SOURCE. At the
                        // IL level this stays a plain reference load with no cast:
                        // both constructed interfaces erase to the same open
                        // generic definition (differing only by reference type
                        // argument) and CLR generic-interface variance makes the
                        // runtime reference directly assignment-compatible.
                        // Without this, the emitter threw NotSupportedException
                        // for the class-sourced lift the binder had accepted
                        // (`Conversion from 'Service' to 'IService[object?]?'`).
                        if iface == targetIface || Conversion.IsVarianceCompatibleInterfaceConversion(
                            iface,
                            targetIface
                        ) {
                            return true
                        }
                    }
                }
            }
            // Reuse the nominal classifier for source-class upcasts, including symbolic imported bases (#5388, #4731).
            if a is StructSymbol srcClass2 && srcClass2.IsClass && b != nil {
                if Conversion.ClassifyCore(a, b, allowStructuralProjection: false, allowExplicitReference: false)
                    .IsImplicit {
                    return true
                }
            }
            // Issue #323: any delegate-typed value (named/generic CLR delegate
            // such as Func[string]) widens to System.Delegate /
            // System.MulticastDelegate as a no-op reference upcast.
            if b?.ClrType != nil &&
                IsSystemDelegateHostType(b!!.ClrType) &&
                a?.ClrType != nil &&
                ClrTypeUtilities.IsDelegateType(a!!.ClrType) {
                return true
            }
            // Issue #2523: constructed imported reference types can preserve their
            // real generic arguments only symbolically while carrying an erased CLR
            // probe shape. The binder classifies their declared imported
            // interface/base conversion from that symbolic hierarchy; the emitted
            // representation is still an ordinary CLR reference upcast and
            // therefore requires no instruction. Reuse the binder classification
            // instead of repeating nullable substitution, variance, and
            // cross-context identity logic here.
            // Issue #3501: also admit a NON-generic imported reference source
            // (no symbolic TypeArguments, e.g. Roslyn's `SymbolEqualityComparer`)
            // converting to a variant constructed interface
            // (`IEqualityComparer[IMethodSymbol]`): the binder now classifies it
            // through the CLR interface-closure projection, and the emitted form
            // is the same no-op reference upcast.
            // #4731: sequence aliases also emit their actual symbolic element.
            // A valid widening must retain that precise stack type when a
            // reflected parameter is erased but its MethodSpec consumes the
            // real element; casting to the erased envelope would lose it.
            if (
                (
                    a is ImportedTypeSymbol importedReference &&
                        (
                        importedReference
                            .OpenDefinition
                            ?.IsValueType == false ||
                            (
                            importedReference.OpenDefinition == nil &&
                                importedReference.ClrType is {IsValueType: false, IsArray: false}
                        )
                    )
                ) ||
                    (a is SequenceTypeSymbol or AsyncSequenceTypeSymbol)
            ) &&
                (b is ImportedTypeSymbol or SequenceTypeSymbol or AsyncSequenceTypeSymbol) &&
                Conversion.ClassifyNonStructural(a!!, b!!) is {Exists: true, IsImplicit: true} {
                return true
            }
            // Issue #2516: slice/fixed-array-to-array/interface compatibility is
            // deliberately narrower than CLR array covariance. Reuse the binder's
            // classification before the general CLR assignability shortcuts below:
            // exact array and invariant-interface elements remain required, while
            // covariant read-only interfaces may widen their reference element.
            if (
                (a is SliceTypeSymbol or ArrayTypeSymbol or RectangularArrayTypeSymbol) ||
                    (a is ImportedTypeSymbol and {ClrType: {IsArray: true}})
            ) &&
                (
                (b is SliceTypeSymbol or ArrayTypeSymbol or RectangularArrayTypeSymbol) ||
                    b
                    ?.ClrType
                    ?.IsArray == true ||
                    b
                    ?.ClrType
                    ?.IsInterface == true
            ) {
                return Conversion.ClassifyNonStructural(a!!, b!!) is {Exists: true, IsImplicit: true}
            }
            // Issue #521: standard CLR reference upcast. A reference-typed
            // value of CLR type `a` widens to any base class or implemented
            // CLR interface `b` as a no-op at the IL level (the reference
            // already satisfies the wider static type).
            if a?.ClrType != nil &&
                b?.ClrType != nil &&
                !a!!.ClrType!!.IsValueType &&
                !b!!.ClrType!!.IsValueType &&
                ClrTypeUtilities.IsAssignableByName(b!!.ClrType, a!!.ClrType) {
                return true
            }
            // Issue #570: cross-context interface implementation check for
            // non-slice reference types. Slices were classified above so CLR array
            // covariance cannot bypass G#'s element restrictions.
            if a?.ClrType != nil &&
                b?.ClrType != nil &&
                b!!.ClrType!!.IsInterface &&
                ClrTypeUtilities.ImplementsInterfaceByName(a!!.ClrType, b!!.ClrType) {
                return true
            }
            // Issue #2140 / #3354: a G# slice, fixed array, or rectangular array
            // (any element type) is CLR array-backed. Upcasting it to the base
            // classes `object` / `System.Array` — or to any element-INDEPENDENT non-
            // generic array supertype interfaces (IEnumerable, ICollection,
            // IList, ICloneable, IStructuralComparable, IStructuralEquatable) —
            // is a no-op reference conversion: the slot already holds an array
            // reference that is assignment-compatible with the wider static
            // type. The concrete-element case reaches emit through the #521 /
            // #570 CLR arms above; these arms additionally recognise the
            // generic-type-parameter / same-compilation-user element case whose
            // backing `ClrType` is null during emit.
            if (a is SliceTypeSymbol or ArrayTypeSymbol or RectangularArrayTypeSymbol) {
                let bClr Type? = b?.ClrType
                if bClr != nil &&
                    (
                    bClr.IsSameAs(typeof(object)) || bClr.IsSameAs(typeof(Array)) || bClr.IsSameAs(
                        typeof(IEnumerable)
                    ) ||
                        bClr.IsSameAs(typeof(ICollection)) || bClr.IsSameAs(typeof(IList)) || bClr.IsSameAs(
                        typeof(ICloneable)
                    ) ||
                        bClr.IsSameAs(typeof(IStructuralComparable)) || bClr.IsSameAs(typeof(IStructuralEquatable))
                ) {
                    return true
                }
            }
            return false
        }

        /// Issue #1431: returns `true` when [`a`](paramref)
        /// and [`b`](paramref) denote the same closed constructed generic
        /// reference type, comparing by the open definition's full name and each
        /// effective type argument (taken from the symbol's `TypeArguments`
        /// when present, otherwise from the `ClrType`'s generic arguments).
        /// This recognises the no-op identity conversion between two symbols for
        /// the same instantiation that differ only in representation — notably a
        /// substituted target whose `ClrType` was left in the type-erased
        /// open form while its `TypeArguments` carry the real arguments.
        private func SameClosedReferenceShape(a TypeSymbol?, b TypeSymbol?) bool {
            if !TryGetClosedReferenceShape(a, out var aDef, out var aArgs) ||
                !TryGetClosedReferenceShape(b, out var bDef, out var bArgs) {
                return false
            }
            if !aDef.IsSameAs(bDef) || aArgs!!.Length != bArgs!!.Length {
                return false
            }
            for var i = 0; i < aArgs!!.Length; i++ {
                if aArgs!![i] == nil || bArgs!![i] == nil || !aArgs!![i].IsSameAs(bArgs!![i]) {
                    return false
                }
            }
            return true
        }

        private func TryGetClosedReferenceShape(
            type TypeSymbol?,
            @NotNullWhen(true) out definition Type?,
            @NotNullWhen(true) out args[]?Type
        ) bool {
            definition = nil
            args = nil
            let clr Type? = type?.ClrType
            if clr == nil || !clr.IsGenericType || clr.IsValueType {
                return false
            }
            definition = clr.GetGenericTypeDefinition()
            // Prefer the symbol's own type arguments — they survive the type
            // erasure that can leave `ClrType` in the open `IEnumerable<object>`
            // shape — and fall back to the CLR generic arguments when the symbol
            // elided them.
            if type is ImportedTypeSymbol imported &&
                !imported
                .TypeArguments
                .IsDefaultOrEmpty &&
                imported
                .TypeArguments
                .Length == clr
                .GetGenericArguments().Length {
                let symbolicArgs = [imported.TypeArguments.Length]Type
                for var i = 0; i < symbolicArgs.Length; i++ {
                    let argClr Type? = imported.TypeArguments[i]?.ClrType
                    if argClr == nil {
                        return false
                    }
                    symbolicArgs[i] = argClr
                }
                args = symbolicArgs
                return true
            }
            args = clr.GetGenericArguments()
            return true
        }

        private func IsSystemDelegateHostType(type Type?) bool {
            if type == nil {
                return false
            }
            let fullName = type.FullName
            return string.Equals(fullName, "System.Delegate", StringComparison.Ordinal) || string.Equals(
                fullName,
                "System.MulticastDelegate",
                StringComparison.Ordinal
            )
        }

        private func IsUnsignedOrChar(t TypeSymbol) bool {
            if t == TypeSymbol.UInt8 ||
                t == TypeSymbol.UInt16 ||
                t == TypeSymbol.UInt32 ||
                t == TypeSymbol.UInt64 ||
                t == TypeSymbol.NUInt ||
                t == TypeSymbol.Char {
                return true
            }
            // Issue #574 / 6.6: enum comparisons and arithmetic dispatch through
            // the enum's CLR underlying type. Unsigned-backed enums need the
            // unsigned IL opcodes (clt_un / cgt_un). Delegates to the single
            // source of truth in EnumOperatorTable.
            if EnumOperatorTable.IsUnsignedEnumUnderlying(t) {
                return true
            }
            return false
        }

        // Issue #520: the EmitLoad/StoreElement helpers need to distinguish
        // class/interface element types (require stelem.ref / ldelem.ref) from
        // value-type element types (require the typed `stelem/ldelem <token>`
        // forms when no short-form opcode matches). All G#-native non-string
        // primitives have a TypeSymbol fast-path above; anything left over is
        // user-defined or imported and we can ask the underlying CLR type.
        private func IsReferenceTypeElement(elementType TypeSymbol) bool {
            if elementType == TypeSymbol.Object {
                return true
            }
            let clr Type? = elementType?.ClrType
            return clr != nil && !clr.IsValueType && !clr.IsGenericParameter
        }

        // Issue #420 (P3-4): debug-only check used by EmitFieldAssignment to
        // assert the binder never feeds a value expression that reassigns the
        // field-assignment receiver variable. Looks for any
        // BoundAssignmentExpression whose target is the same VariableSymbol as
        // the receiver. Conservative — false positives are fine because this
        // is a debug-only assertion guarding a code-gen invariant.
        private func ValueExpressionMutatesReceiver(value BoundExpression?, receiver VariableSymbol?) bool {
            if value == nil || receiver == nil {
                return false
            }
            let detector = ReceiverMutationDetector(receiver)
            detector.Visit(value)
            return detector.Found
        }

        // ──────────────────────────────────────────────────────────────
        // Phase E: channel emit (ADR-0022 §I/O).
        //
        // Strategy mirrors the interpreter (EvaluateMakeChannelExpression /
        // Send / Receive / Close). The pre-pass allocated per-call-site
        // scratch slots for any value-typed receivers we need to address
        // (ValueTask, TaskAwaiter[, <T>]). Async ops block via
        // .AsTask().GetAwaiter().GetResult() to match the synchronous
        // evaluator surface.
        //
        // Reflection still needs a closed carrier type to find channel members.
        // Metadata emission separately retains symbolic element types that the
        // carrier cannot represent.
        //
        // Issue #3308: a MetadataLoadContext-projected element (e.g. a prior
        // REPL submission's user struct reverse-projected into `chan T`) cannot
        // participate in the direct carrier path either — closing a live
        // `typeof(Channel<>)` over a non-runtime Type yields a hybrid
        // instantiation whose reflection surface throws NotSupportedException.
        // Such elements take the same object-carrier + symbolic-member-ref path
        // that null-ClrType (same-compilation) elements always used.
        internal func ResolveChannelElementClrType(elementType TypeSymbol) Type {
            let clr Type? = NullableTypeSymbol.GetEffectiveClrType(elementType)
            return if clr != nil && IsRuntimeProvidedType(clr) {
                clr
            } else {
                typeof(object)
            }
        }

        internal func ChannelElementNeedsSymbolicType(elementType TypeSymbol) bool -> elementType?.ClrType == nil ||
            !IsRuntimeProvidedType(elementType.ClrType!!) ||
            TypeSymbol.RequiresSymbolicProjection(elementType)

        // Whether `type` is provided by the live runtime's own loader (a
        // System.RuntimeType), i.e. safe to close open runtime generics over and
        // reflect on. MetadataLoadContext RoTypes (and any other non-runtime
        // Type implementation) are not.
        private func IsRuntimeProvidedType(type Type) bool -> type.GetType() == typeof(object).GetType()

        private func ResolveChannelContainerSymbol(
            closedCarrier Type,
            openDefinition Type,
            elementType TypeSymbol
        ) TypeSymbol? -> if ChannelElementNeedsSymbolicType(elementType) {
            ImportedTypeSymbol.GetConstructed(
                closedCarrier,
                openDefinition,
                ImmutableArray.CreateRange(Enumerable.Repeat(elementType, openDefinition.GetGenericArguments().Length))
            )
        } else {
            default(ImportedTypeSymbol?)
        }

        private func ResolveChannelMethodTypeArguments(elementType TypeSymbol) ImmutableArray[
            TypeSymbol
        ] -> if ChannelElementNeedsSymbolicType(elementType) {
            ImmutableArray.Create(elementType)
        } else {
            default(ImmutableArray[TypeSymbol])
        }

        private func ToNullableTypeArguments(typeArguments ImmutableArray[TypeSymbol]) ImmutableArray[
            TypeSymbol?
        ] -> if typeArguments.IsDefault {
            default(ImmutableArray[TypeSymbol?])
        } else {
            typeArguments.Select((typeArgument TypeSymbol) -> cast[TypeSymbol?](typeArgument)).ToImmutableArray()
        }
    }
}
