// <copyright file="MethodBodyEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1028 // trailing whitespace
#pragma warning disable SA1116 // parameters begin on line after declaration
#pragma warning disable SA1117 // parameters on same line
#pragma warning disable SA1214 // readonly fields before non-readonly
#pragma warning disable SA1515 // single-line comment preceded by blank line
#pragma warning disable SA1201 // method should not follow a class
#pragma warning disable SA1202 // 'internal' members should come before 'private' members

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Lowering.Iterators;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-11: promoted from the formerly nested <c>BodyEmitter</c> class on
/// <see cref="ReflectionMetadataEmitter"/>. Owns per-method IL emission —
/// every statement, expression, pattern, operator, member access, call,
/// conversion, closure body, and async/iterator helper that runs while a
/// method body is being built. Constructor-injected with the per-method
/// slot dictionaries (allocated by <see cref="SlotPlanner"/>) and a back-
/// reference to the root emitter for cross-method services (token cache,
/// well-known references, closure and state-machine orchestrators).
/// </summary>
/// <remarks>
/// Internally subdivided into nested partials (<c>MethodBodyEmitter.Statements.cs</c>,
/// <c>.Expressions.cs</c>, <c>.Patterns.cs</c>, <c>.Operators.cs</c>,
/// <c>.MemberAccess.cs</c>, <c>.Calls.cs</c>, <c>.Conversions.cs</c>,
/// <c>.Closures.cs</c>, <c>.Async.cs</c>) so no single file is more than
/// ~1500 LoC. Behaviour-preserving — IL is byte-identical with the
/// pre-PR-E-11 baseline (see <c>RefactoringBaselineTests</c>).
/// </remarks>
internal sealed partial class MethodBodyEmitter
{
    private readonly ReflectionMetadataEmitter outer;
    private readonly InstructionEncoder il;
    private readonly Dictionary<VariableSymbol, int> locals;
    private readonly Dictionary<ParameterSymbol, int> parameters;
    private readonly Dictionary<BoundLabel, LabelHandle> labels;
    private readonly Dictionary<BoundAppendExpression, (int Src, int Dst)> appendSlots;
    private readonly Dictionary<BoundStructLiteralExpression, int> structLiteralSlots;
    private readonly Dictionary<BoundDefaultExpression, int> defaultExpressionSlots;
    private readonly Dictionary<BoundIndexExpression, int> mapIndexSlots;
    private readonly Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots;
    private readonly Dictionary<BoundTypePattern, int> typePatternScratchSlots;
    private readonly Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots;
    private readonly Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots;
    private readonly Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots;
    private readonly Dictionary<BoundSelectStatement, SelectSlots> selectStatementSlots;
    private readonly Dictionary<BoundExpression, int> receiverSpillSlots;
    private readonly Dictionary<BoundStackAllocExpression, int> stackAllocResultSlots;
    private readonly HashSet<BoundStackAllocExpression> materializedStackAllocs = new HashSet<BoundStackAllocExpression>();

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
    private readonly HashSet<BoundChannelReceiveExpression> materializedChannelReceives = new HashSet<BoundChannelReceiveExpression>();

    // Issue #1688: tracks which planned receiverSpillSlots entries have
    // already been evaluated-and-cached during this method's emission. A
    // compound member assignment (`getObj().F += x` / `getObj().P += x`)
    // reuses the SAME receiver BoundExpression instance for both the read
    // (embedded in the compound RHS) and the write (the assignment's own
    // target) — see TryEmitCachedReceiver. The first encounter evaluates the
    // receiver and stores it; every later encounter of the identical node
    // instance loads the cached value/address instead of re-running the
    // (potentially side-effecting) receiver expression.
    private readonly HashSet<BoundExpression> spilledCompoundReceivers = new HashSet<BoundExpression>();
    private readonly Dictionary<BoundBinaryExpression, int> nullableCoalesceSpillSlots;
    private readonly Dictionary<BoundExpression, int> indexAssignmentValueSlots;
    private readonly Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes;
    private readonly Dictionary<BoundExpression, LiftedBinarySlots> liftedBinarySlots;
    private readonly ParameterSymbol structThisParameter;
    private readonly Lowering.Async.AsyncStateMachineFieldMap asyncFieldMap;
    private readonly Lowering.Async.AsyncStateMachinePlan asyncPlan;
    private readonly StateMachineEmitter.AsyncIteratorEmitContext asyncIteratorEmitCtx;
    private readonly Dictionary<VariableSymbol, object> constValues;

    // Issue #503 follow-up: when this MethodBodyEmitter is emitting the Invoke
    // method of a synthesized closure class, captures of the *enclosing*
    // closure are loaded/stored through `this`'s display-class fields
    // instead of looking for a local slot or parameter index. Null when
    // the current method isn't a closure Invoke.
    private readonly ClosureEmitter.ClosureInfo enclosingClosure;

    // 6.2 SilentEmitFailure invariant: track the most recently dispatched
    // BoundNode so that any exception thrown from deep in the emit pipeline
    // can be re-anchored at the offending source construct. Updated at the
    // top of EmitStatement and EmitExpression (the two dispatch chokepoints).
    private BoundNode currentNode;

    /// <summary>
    /// Gets the <see cref="SyntaxNode"/> of the most recently dispatched
    /// <see cref="BoundNode"/>, suitable for anchoring emit-failure diagnostics.
    /// </summary>
    internal SyntaxNode CurrentAnchor => this.currentNode?.Syntax;

    // Stack of currently-active protected regions; each entry holds the set of
    // bound labels defined lexically within that region (including nested
    // protected sub-regions). Used to translate goto/conditional-goto whose
    // target lies outside the innermost region into the CLR-required `leave`.
    private readonly Stack<HashSet<BoundLabel>> protectedRegionStack = new Stack<HashSet<BoundLabel>>();

    // Phase 4 (ADR-0027 §7.7a) Portable PDB sequence-point capture. Always
    // allocated (cheap) so EmitStatement can append without a null check;
    // the outer harvests this list via SequencePoints after EmitBlock and
    // hands it to PortablePdbEmitter only when PDB emit is enabled. Empty
    // for synthesized methods that go through other emit paths.
    private readonly List<SequencePoint> sequencePoints = new List<SequencePoint>();
    private int lastSequencePointIlOffset = -1;

    public MethodBodyEmitter(
        ReflectionMetadataEmitter outer,
        InstructionEncoder il,
        Dictionary<VariableSymbol, int> locals,
        Dictionary<ParameterSymbol, int> parameters,
        Dictionary<BoundLabel, LabelHandle> labels,
        Dictionary<BoundAppendExpression, (int Src, int Dst)> appendSlots,
        Dictionary<BoundStructLiteralExpression, int> structLiteralSlots,
        Dictionary<BoundDefaultExpression, int> defaultExpressionSlots,
        Dictionary<BoundIndexExpression, int> mapIndexSlots,
        Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots,
        Dictionary<BoundTypePattern, int> typePatternScratchSlots,
        Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots,
        Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots,
        Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots,
        Dictionary<BoundSelectStatement, SelectSlots> selectStatementSlots,
        Dictionary<BoundExpression, int> receiverSpillSlots,
        Dictionary<BoundExpression, int> indexAssignmentValueSlots,
        Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes,
        Dictionary<BoundExpression, LiftedBinarySlots> liftedBinarySlots = null,
        Dictionary<BoundBinaryExpression, int> nullableCoalesceSpillSlots = null,
        ParameterSymbol structThisParameter = null,
        Lowering.Async.AsyncStateMachineFieldMap asyncFieldMap = null,
        Lowering.Async.AsyncStateMachinePlan asyncPlan = null,
        StateMachineEmitter.AsyncIteratorEmitContext asyncIteratorEmitCtx = null,
        Dictionary<VariableSymbol, object> constValues = null,
        ClosureEmitter.ClosureInfo enclosingClosure = null,
        Dictionary<BoundStackAllocExpression, int> stackAllocResultSlots = null)
    {
        this.outer = outer;
        this.il = il;
        this.locals = locals;
        this.parameters = parameters;
        this.labels = labels;
        this.appendSlots = appendSlots;
        this.structLiteralSlots = structLiteralSlots;
        this.defaultExpressionSlots = defaultExpressionSlots;
        this.mapIndexSlots = mapIndexSlots;
        this.patternSwitchSlots = patternSwitchSlots;
        this.typePatternScratchSlots = typePatternScratchSlots;
        this.switchExpressionSlots = switchExpressionSlots;
        this.channelOpSlots = channelOpSlots;
        this.scopeFrameSlots = scopeFrameSlots;
        this.selectStatementSlots = selectStatementSlots;
        this.receiverSpillSlots = receiverSpillSlots;
        this.indexAssignmentValueSlots = indexAssignmentValueSlots;
        this.goEnclosingScopes = goEnclosingScopes;
        this.liftedBinarySlots = liftedBinarySlots ?? new Dictionary<BoundExpression, LiftedBinarySlots>();
        this.nullableCoalesceSpillSlots = nullableCoalesceSpillSlots ?? new Dictionary<BoundBinaryExpression, int>();
        this.structThisParameter = structThisParameter;
        this.asyncFieldMap = asyncFieldMap;
        this.asyncPlan = asyncPlan;
        this.asyncIteratorEmitCtx = asyncIteratorEmitCtx;
        this.constValues = constValues;
        this.enclosingClosure = enclosingClosure;
        this.stackAllocResultSlots = stackAllocResultSlots ?? new Dictionary<BoundStackAllocExpression, int>();
    }

    public IReadOnlyList<SequencePoint> SequencePoints => this.sequencePoints;

    /// <summary>Issue #306: emits a single value expression onto the IL stack. Used by the constructor emitter to evaluate base-constructor argument expressions.</summary>
    /// <param name="expression">The bound value expression to emit.</param>
    public void EmitValue(BoundExpression expression) => this.EmitExpression(expression);

    /// <summary>Issue #306: emits base-constructor arguments, respecting <see cref="RefKind"/> for by-ref base parameters.</summary>
    /// <param name="arguments">The bound base-constructor argument expressions.</param>
    /// <param name="refKinds">The per-argument by-reference passing modes.</param>
    public void EmitBaseConstructorArguments(ImmutableArray<BoundExpression> arguments, ImmutableArray<RefKind> refKinds)
        => this.EmitImportedCallArguments(arguments, refKinds);

    public void EmitBlock(BoundBlockStatement block)
    {
        foreach (var statement in block.Statements)
        {
            this.EmitStatement(statement);
        }
    }

    private void EmitBlockExpression(BoundBlockExpression blockExpression)
    {
        // Labels introduced inside an expression-position block (e.g. the
        // short-circuit gate emitted by InterpolatedStringHandlerLowerer)
        // are not seen by the function-level CollectStatements pre-pass,
        // which only walks statement positions. Pre-declare them here so
        // forward conditional branches can resolve their target handles.
        foreach (var statement in blockExpression.Statements)
        {
            var nested = new HashSet<BoundLabel>();
            this.CollectLabels(statement, nested);
            foreach (var label in nested)
            {
                if (!this.labels.ContainsKey(label))
                {
                    this.labels[label] = this.il.DefineLabel();
                }
            }
        }

        foreach (var statement in blockExpression.Statements)
        {
            this.EmitStatement(statement);
        }

        this.EmitExpression(blockExpression.Expression);
    }

    private void EmitStatement(BoundStatement statement)
    {
        if (statement.Syntax != null)
        {
            this.currentNode = statement;
        }

        this.RecordSequencePointFor(statement);
        this.MaterializeSpilledStackAllocs(statement);
        this.MaterializeSpilledChannelReceives(statement);
        switch (statement)
        {
            case BoundBlockStatement block:
                this.EmitBlock(block);
                break;
            case BoundExpressionStatement expr:
                this.EmitExpression(expr.Expression);
                if (expr.Expression.Type != TypeSymbol.Void)
                {
                    this.il.OpCode(ILOpCode.Pop);
                }

                break;
            case BoundReturnStatement ret:
                if (ret.Expression is not null)
                {
                    // Issue #490 (ADR-0060 follow-up): a `return ref <lvalue>` arrives
                    // as a BoundAddressOfExpression wrapping the lvalue. Emit the address
                    // (ldloca / ldarga / ldflda / ldelema / dereferenced pointer) so the
                    // returned `T&` slot holds the managed pointer the signature declares.
                    if (ret.IsRef && ret.Expression is BoundAddressOfExpression addrOf)
                    {
                        this.EmitAddressOf(addrOf);
                    }
                    else
                    {
                        this.EmitExpression(ret.Expression);
                    }
                }

                this.il.OpCode(ILOpCode.Ret);
                break;
            case BoundVariableDeclaration decl:
                if (decl.ConstantValue != null)
                {
                    break; // value inlined at read sites; initializer is a side-effect-free literal
                }

                this.EmitExpression(decl.Initializer);
                this.EmitStoreVariable(decl.Variable);
                break;
            case BoundLocalFunctionDeclaration:
                // Issue #1886: a generic local function is not a runtime value — no slot, no
                // codegen here. Its underlying method is discovered and emitted independently
                // via the non-capturing-lambda hosting pipeline (see SlotPlanner.CollectFunctionLiterals).
                break;
            case BoundLabelStatement lbl:
                this.il.MarkLabel(this.labels[lbl.Label]);
                break;
            case BoundGotoStatement g:
                this.EmitBranch(g.Label, conditional: null, jumpIfTrue: false);
                break;
            case BoundConditionalGotoStatement cg:
                this.EmitBranch(cg.Label, conditional: cg.Condition, jumpIfTrue: cg.JumpIfTrue);
                break;
            case BoundTryStatement tryStmt:
                this.EmitTryStatement(tryStmt);
                break;
            case BoundThrowStatement throwStmt:
                this.EmitExpression(throwStmt.Expression);
                this.il.OpCode(ILOpCode.Throw);
                break;
            case BoundPatternSwitchStatement ps:
                this.EmitPatternSwitchStatement(ps);
                break;
            case BoundGoStatement go:
                this.EmitGoStatement(go);
                break;
            case BoundScopeStatement scope:
                this.EmitScopeStatement(scope);
                break;
            case BoundFixedStatement fixedStmt:
                this.EmitFixedStatement(fixedStmt);
                break;
            case BoundChannelSendStatement cs:
                this.EmitChannelSendStatement(cs);
                break;
            case BoundSelectStatement select:
                this.EmitSelectStatement(select);
                break;
            case BoundYieldStatement:
                EmitDiagnosticException.Throw(statement.Syntax, "Internal error: yield reached the emitter before iterator lowering.");
                break;
            case BoundAwaitSequencePoint:
                this.il.OpCode(ILOpCode.Nop);
                break;
            default:
                EmitDiagnosticException.Throw(
                    statement.Syntax,
                    $"Bound statement kind '{statement.Kind}' is not yet supported by the emitter.");
                break;
        }
    }

    // Phase 4 (ADR-0027 §7.7a): record a sequence point for the current
    // statement before its first opcode lands in the IL stream. Skipped for
    // block / label statements (children record their own anchors and a
    // label statement emits no IL of its own). BoundAwaitSequencePoint and
    // synthesised statements with no Syntax map to hidden (0xfeefee).
    private void RecordSequencePointFor(BoundStatement statement)
    {
        if (this.outer.emitCtx.Pdb == null)
        {
            return;
        }

        switch (statement)
        {
            case BoundBlockStatement:
            case BoundLabelStatement:
                return;
        }

        var ilOffset = this.il.Offset;
        if (ilOffset == this.lastSequencePointIlOffset)
        {
            // Avoid two consecutive records at the same IL offset — the
            // Portable PDB sequence-point encoding forbids δIL = 0 except
            // for the first record.
            return;
        }

        var syntax = statement.Syntax;
        if (statement is BoundAwaitSequencePoint || syntax is null)
        {
            this.sequencePoints.Add(SequencePoint.Hidden(ilOffset, document: default));
            this.lastSequencePointIlOffset = ilOffset;
            return;
        }

        var location = syntax.Location;
        if (location.Text is null)
        {
            this.sequencePoints.Add(SequencePoint.Hidden(ilOffset, document: default));
            this.lastSequencePointIlOffset = ilOffset;
            return;
        }

        var documentHandle = this.outer.emitCtx.Pdb.GetOrAddDocument(syntax.SyntaxTree);
        this.sequencePoints.Add(new SequencePoint(
            ilOffset: ilOffset,
            document: documentHandle,
            startLine: location.StartLine + 1,
            startColumn: location.StartCharacter + 1,
            endLine: location.EndLine + 1,
            endColumn: location.EndCharacter + 1));
        this.lastSequencePointIlOffset = ilOffset;
    }

    // Issue #1522: before a statement's own IL is emitted (evaluation stack is
    // empty here), materialise every spilled `stackalloc` sub-expression that
    // this statement contains, in source order, into its pre-allocated result
    // local. The `localloc` therefore runs at an empty stack, satisfying
    // ECMA-335 III.3.47; the original operand position later loads the result
    // local. Nested statements are handled by their own EmitStatement pass, so
    // this walker does not descend past the first statement boundary.
    private void MaterializeSpilledStackAllocs(BoundStatement statement)
    {
        if (this.stackAllocResultSlots.Count == 0)
        {
            return;
        }

        var spilled = new List<BoundStackAllocExpression>();
        new SpilledStackAllocCollector(this.stackAllocResultSlots, spilled).Visit(statement);
        foreach (var sa in spilled)
        {
            if (!this.materializedStackAllocs.Add(sa))
            {
                continue;
            }

            this.EmitStackAllocCore(sa);
            this.il.StoreLocal(this.stackAllocResultSlots[sa]);
        }
    }

    // Issue #2283: before a statement's own IL is emitted (evaluation stack is
    // empty here), materialise every `<-ch` channel-receive expression this
    // statement contains, in source order, running each one's try/catch (see
    // EmitChannelReceiveCore) at this empty-stack point and storing the
    // result into its pre-allocated slot. The original operand position
    // (EmitChannelReceiveExpression) then just loads that slot instead of
    // re-emitting the try/catch — which would otherwise open a protected
    // region while earlier operands of the same expression are still on the
    // stack (ECMA-335 III.3.47 violation: ilverify TryNonEmptyStack /
    // StackUnderflow, InvalidProgramException at run time). Nested statements
    // are handled by their own EmitStatement pass, so this walker does not
    // descend past the first statement boundary. This always runs — even for
    // a receive that is already the whole statement — so there is exactly one
    // code path, and it is unconditionally safe.
    private void MaterializeSpilledChannelReceives(BoundStatement statement)
    {
        if (this.channelOpSlots.Count == 0)
        {
            return;
        }

        var receives = new List<BoundChannelReceiveExpression>();
        new ChannelReceiveCollector(receives).Visit(statement);
        foreach (var recv in receives)
        {
            if (!this.materializedChannelReceives.Add(recv))
            {
                continue;
            }

            this.EmitChannelReceiveCore(recv);
        }
    }

    private static bool IsObjectStackType(TypeSymbol type)
    {
        if (type == TypeSymbol.Object || type?.ClrType.IsSameAs(typeof(object)) == true)
        {
            return true;
        }

        return type is TypeParameterSymbol
            || (type is ImportedTypeSymbol imported && imported.HasTypeParameterArgument)
            || (type is FunctionTypeSymbol fn && TypeSymbol.ContainsTypeParameter(fn));
    }

    private static TypeSymbol GetEnumUnderlyingTypeSymbol(TypeSymbol type)
    {
        if (type is EnumSymbol enumSym)
        {
            return enumSym.UnderlyingType;
        }

        // Issue #2327: `type.ClrType` may be a
        // System.Reflection.Emit.TypeBuilderInstantiation (e.g. a
        // compiler-synthesized structural function-type delegate closed
        // over an in-flight TypeBuilder definition), whose `IsEnum` throws
        // NotSupportedException. Route through the shared safe helper
        // (generalizing the #1100/#2135 pattern) rather than probing
        // `ClrType.IsEnum` directly — a throw means the type is definitely
        // not an enum, matching the guard used by EnumOperatorTable.
        var underlying = type?.ClrType.GetEnumUnderlyingTypeSafe();
        if (underlying != null)
        {
            // Loaded via a MetadataLoadContext or normal load: map the CLR
            // underlying type back to a TypeSymbol for the numeric lattice.
            return TypeSymbol.FromClrType(underlying);
        }

        return null;
    }

    private static bool IsInterfaceTargetType(TypeSymbol type)
    {
        if (type is NullableTypeSymbol nullable)
        {
            type = nullable.UnderlyingType;
        }

        if (type is InterfaceSymbol)
        {
            return true;
        }

        return type?.ClrType != null && type.ClrType.IsInterface;
    }

    private static bool IsInterfaceSourceType(TypeSymbol type)
    {
        if (type is NullableTypeSymbol nullable)
        {
            type = nullable.UnderlyingType;
        }

        if (type is InterfaceSymbol)
        {
            return true;
        }

        return type?.ClrType != null && type.ClrType.IsInterface;
    }

    private static bool IsExplicitUnboxingSourceType(TypeSymbol type)
    {
        if (type is NullableTypeSymbol nullable)
        {
            type = nullable.UnderlyingType;
        }

        return type?.ClrType.IsSameAs(typeof(object)) == true
            || type?.ClrType.IsSameAs(typeof(System.ValueType)) == true
            || type?.ClrType.IsSameAs(typeof(System.Enum)) == true
            || IsInterfaceSourceType(type);
    }

    private static bool IsUnsignedClrType(Type t)
        => t.IsSameAs(typeof(byte)) || t.IsSameAs(typeof(ushort)) || t.IsSameAs(typeof(uint))
            || t.IsSameAs(typeof(ulong)) || t.IsSameAs(typeof(nuint)) || t.IsSameAs(typeof(char));

    private static bool IsNumericClrType(Type t)
        => t.IsSameAs(typeof(sbyte)) || t.IsSameAs(typeof(byte))
            || t.IsSameAs(typeof(short)) || t.IsSameAs(typeof(ushort))
            || t.IsSameAs(typeof(int)) || t.IsSameAs(typeof(uint))
            || t.IsSameAs(typeof(long)) || t.IsSameAs(typeof(ulong))
            || t.IsSameAs(typeof(nint)) || t.IsSameAs(typeof(nuint))
            || t.IsSameAs(typeof(float)) || t.IsSameAs(typeof(double))
            || t.IsSameAs(typeof(decimal)) || t.IsSameAs(typeof(char));

    private static bool Is32BitOrSmaller(Type t)
        => t.IsSameAs(typeof(sbyte)) || t.IsSameAs(typeof(byte))
            || t.IsSameAs(typeof(short)) || t.IsSameAs(typeof(ushort))
            || t.IsSameAs(typeof(int)) || t.IsSameAs(typeof(uint))
            || t.IsSameAs(typeof(char)) || t.IsSameAs(typeof(bool));

    private static bool IsReferenceCompatible(TypeSymbol a, TypeSymbol b)
    {
        if (a == b)
        {
            return true;
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
        if (a is StructSymbol aSelfStruct && b is StructSymbol bSelfStruct
            && Conversion.AreSameConstructedStructIdentity(aSelfStruct, bSelfStruct))
        {
            return true;
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
        if (SameClosedReferenceShape(a, b))
        {
            return true;
        }

        // ADR-0045: any reference type widens to `object` at the IL
        // level as a no-op; the slot already holds the reference.
        if (b?.ClrType.IsSameAs(typeof(object)) == true && a?.ClrType != null && !a.ClrType.IsValueType)
        {
            return true;
        }

        // Issue #990: a user-declared reference type (a `class`, modelled as
        // a StructSymbol with IsClass == true) has no ClrType during emit
        // because its TypeDef only exists in the assembly being emitted, so
        // the CLR-backed rule above cannot fire. Such a reference still
        // widens to `object` as a no-op (the slot already holds the
        // reference). This unblocks generators whose element type is a user
        // class: the synthesized non-generic `IEnumerator.Current` property
        // converts the strongly-typed `<>2__current` field to `object`.
        if (b?.ClrType.IsSameAs(typeof(object)) == true && a is StructSymbol userClass && userClass.IsClass)
        {
            return true;
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
        if (a is InterfaceSymbol srcInterface)
        {
            if (b?.ClrType.IsSameAs(typeof(object)) == true || b == TypeSymbol.Object)
            {
                return true;
            }

            if (b is InterfaceSymbol targetBaseInterface)
            {
                foreach (var baseInterface in srcInterface.SelfAndAllBaseInterfaces())
                {
                    if (baseInterface == targetBaseInterface)
                    {
                        return true;
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
                    if (Conversion.IsVarianceCompatibleInterfaceConversion(baseInterface, targetBaseInterface))
                    {
                        return true;
                    }
                }
            }

            if (b?.ClrType is { IsInterface: true } targetClrInterface)
            {
                foreach (var baseClrInterface in srcInterface.BaseClrInterfaces)
                {
                    var clr = baseClrInterface?.ClrType;

                    // Issue #2135: `targetClrInterface` may be a
                    // TypeBuilderInstantiation whose IsAssignableFrom throws
                    // NotSupportedException at emit; use the guarded by-name
                    // helper instead of calling IsAssignableFrom directly.
                    if (clr != null && (clr.IsSameAs(targetClrInterface) || ClrTypeUtilities.IsAssignableByName(targetClrInterface, clr)))
                    {
                        return true;
                    }
                }
            }
        }

        // Issue #1481: a `map[K, V]` is a CLR reference type
        // (`System.Collections.Generic.Dictionary<,>`) and a function type is a
        // reference-typed delegate. When the key/value/signature structurally
        // references an in-scope type parameter (e.g. `map[string, T]`,
        // `func(T) -> int32`), the symbol carries no ClrType during emit, so
        // the CLR-backed `object`-widening rule above cannot fire. Widening
        // such a reference to `object` is still a no-op (the slot already holds
        // the reference). This unblocks a generic iterator whose element type
        // is a `map[…]` / function: the synthesized non-generic
        // `IEnumerator.Current` getter converts the strongly-typed reified
        // `<>2__current` field to `object`.
        if ((a is MapTypeSymbol || a is FunctionTypeSymbol)
            && (b?.ClrType.IsSameAs(typeof(object)) == true || b == TypeSymbol.Object))
        {
            return true;
        }

        if (a is StructSymbol aClass && b is StructSymbol bClass && aClass.IsClass && bClass.IsClass)
        {
            // Issue #1248: a constructed generic class's base-type reference is
            // declared with the derived class's own type parameters (e.g.
            // `TransformBase[TIn, TOut] : FilterBase[TIn]`) and is kept
            // unsubstituted on the constructed symbol, so reference equality
            // against the constructed target (`FilterBase[int32]`) fails. The
            // upcast is a no-op reference conversion at the IL level regardless
            // of type arguments, and the binder already validated argument
            // compatibility, so matching by generic definition along the base
            // chain correctly recognises it.
            for (var c = aClass.BaseClass; c != null; c = c.BaseClass)
            {
                if (c == bClass || ReferenceEquals(c.Definition, bClass.Definition))
                {
                    return true;
                }
            }
        }

        // Phase D: class → interface upcast. The CLR satisfies the
        // contract at the reference level (no IL op required); we only
        // need to recognise it so EmitConversion emits a no-op. Walk
        // the class hierarchy so an interface declared on a base class
        // is also recognised on the derived class.
        if (a is StructSymbol srcClass && srcClass.IsClass && b is InterfaceSymbol targetIface)
        {
            for (var c = srcClass; c != null; c = c.BaseClass)
            {
                foreach (var iface in c.Interfaces)
                {
                    if (iface == targetIface)
                    {
                        return true;
                    }
                }
            }
        }

        // Issue #525: class → imported CLR interface upcast. The G#
        // class has no ClrType during emit, so the general #521 rule
        // below cannot match; recognise the implementation structurally
        // through `ImplementedClrInterfaces`.
        if (a is StructSymbol srcClass2 && srcClass2.IsClass
            && b?.ClrType != null && b.ClrType.IsInterface)
        {
            for (var c = srcClass2; c != null; c = c.BaseClass)
            {
                foreach (var iface in c.ImplementedClrInterfaces)
                {
                    var ifaceClr = iface?.ClrType;
                    if (ifaceClr == null)
                    {
                        continue;
                    }

                    // Issue #2135: `b.ClrType` may be a
                    // TypeBuilderInstantiation whose IsAssignableFrom throws
                    // NotSupportedException at emit; use the guarded by-name
                    // helper instead of calling IsAssignableFrom directly.
                    if (ifaceClr == b.ClrType || ClrTypeUtilities.IsAssignableByName(b.ClrType, ifaceClr))
                    {
                        return true;
                    }
                }
            }
        }

        // Issue #1274: class → imported CLR base class upcast. A user class
        // that (transitively) derives from an imported/BCL base class (e.g.
        // `MyStream : System.IO.Stream`) has no ClrType during emit, so the
        // general #521 rule below cannot match. Recognise the relation
        // structurally through the user base chain's `ImportedBaseType` so the
        // upcast emits as a no-op reference conversion.
        if (a is StructSymbol srcClass3 && srcClass3.IsClass
            && b?.ClrType is System.Type bClrClass
            && !bClrClass.IsInterface && !bClrClass.IsValueType)
        {
            for (var c = srcClass3; c != null; c = c.BaseClass)
            {
                if (c.ImportedBaseType?.ClrType is System.Type importedBaseClr
                    && ClrTypeUtilities.IsAssignableByName(bClrClass, importedBaseClr))
                {
                    return true;
                }
            }
        }

        // Issue #323: any delegate-typed value (named/generic CLR delegate
        // such as Func[string]) widens to System.Delegate /
        // System.MulticastDelegate as a no-op reference upcast.
        if (b?.ClrType != null && IsSystemDelegateHostType(b.ClrType)
            && a?.ClrType != null && ClrTypeUtilities.IsDelegateType(a.ClrType))
        {
            return true;
        }

        // Issue #521: standard CLR reference upcast. A reference-typed
        // value of CLR type `a` widens to any base class or implemented
        // CLR interface `b` as a no-op at the IL level (the reference
        // already satisfies the wider static type).
        if (a?.ClrType != null && b?.ClrType != null
            && !a.ClrType.IsValueType && !b.ClrType.IsValueType
            && ClrTypeUtilities.IsAssignableByName(b.ClrType, a.ClrType))
        {
            return true;
        }

        // Issue #570: cross-context interface implementation check for the
        // emitter's reference-compatibility decision. When `a` is a slice
        // type (backed by T[]) and `b` is an interface, the same-context
        // IsAssignableByName path above fails because the two types live in
        // different Type.Assembly instances. Use ImplementsInterfaceByName
        // to recognise the no-op widening.
        if (a?.ClrType != null && b?.ClrType != null
            && b.ClrType.IsInterface
            && ClrTypeUtilities.ImplementsInterfaceByName(a.ClrType, b.ClrType))
        {
            return true;
        }

        // Issue #821: cross-context slice-to-constructed-interface widening
        // where the target is an <see cref="ImportedTypeSymbol"/> whose
        // <c>ClrType</c> is the type-erased open-definition form (because
        // <c>MakeGenericType</c> at substitution time could not produce a
        // closed CLR type — the open def lives in a MetadataLoadContext while
        // the arguments live in the host runtime). Match the slice's backing
        // <c>T[]</c> interfaces against the open definition's full name and
        // the symbolic <c>TypeArguments</c> by leaf-FullName so the CLR
        // no-op upcast classifies correctly. Mirrors the binder fallback in
        // <see cref="Conversion.SliceImplementsInterface"/>.
        if (a is SliceTypeSymbol aSlice
            && aSlice.ClrType != null
            && b is ImportedTypeSymbol bImported
            && bImported.OpenDefinition is { } bOpenDef
            && !bImported.TypeArguments.IsDefaultOrEmpty)
        {
            foreach (var iface in aSlice.ClrType.GetInterfaces())
            {
                if (!iface.IsGenericType
                    || !string.Equals(
                        iface.GetGenericTypeDefinition().FullName,
                        bOpenDef.FullName,
                        StringComparison.Ordinal))
                {
                    continue;
                }

                var ifaceArgs = iface.GetGenericArguments();
                if (ifaceArgs.Length != bImported.TypeArguments.Length)
                {
                    continue;
                }

                var allMatch = true;
                for (var i = 0; i < ifaceArgs.Length; i++)
                {
                    var symbolic = bImported.TypeArguments[i];
                    if (symbolic?.ClrType is null
                        || !string.Equals(ifaceArgs[i].FullName, symbolic.ClrType.FullName, StringComparison.Ordinal))
                    {
                        allMatch = false;
                        break;
                    }
                }

                if (allMatch)
                {
                    return true;
                }
            }
        }

        // Issue #2140: a G# slice `[]T` (any element type) is backed at
        // runtime by a one-dimensional CLR array. Upcasting it to the base
        // class `System.Array` — or to any of the element-INDEPENDENT non-
        // generic array supertype interfaces (IEnumerable, ICollection,
        // IList, ICloneable, IStructuralComparable, IStructuralEquatable) —
        // is a no-op reference conversion: the slot already holds an array
        // reference that is assignment-compatible with the wider static
        // type. The concrete-element case reaches emit through the #521 /
        // #570 CLR arms above; these arms additionally recognise the
        // generic-type-parameter / same-compilation-user element case whose
        // backing `ClrType` is null during emit.
        if (a is SliceTypeSymbol)
        {
            var bClr = b?.ClrType;
            if (bClr != null
                && (bClr.IsSameAs(typeof(System.Array))
                    || bClr.IsSameAs(typeof(System.Collections.IEnumerable))
                    || bClr.IsSameAs(typeof(System.Collections.ICollection))
                    || bClr.IsSameAs(typeof(System.Collections.IList))
                    || bClr.IsSameAs(typeof(System.ICloneable))
                    || bClr.IsSameAs(typeof(System.Collections.IStructuralComparable))
                    || bClr.IsSameAs(typeof(System.Collections.IStructuralEquatable))))
            {
                return true;
            }
        }

        // Issue #2323: extends #2140 to the five generic single-type-
        // argument array interfaces — IEnumerable<T>, ICollection<T>,
        // IList<T>, IReadOnlyList<T>, IReadOnlyCollection<T> — for a slice
        // `[]T` whose element `T` is a generic type parameter or same-
        // compilation user type. Such elements leave the slice's backing
        // `ClrType` null during emit, so neither the #521 CLR reference-
        // upcast arm nor the #570 `ImplementsInterfaceByName` arm above can
        // fire (both require a non-null `ClrType` on `a`). The binder
        // already accepts this exact conversion via
        // `Conversion.SliceImplementsInterfaceSymbolically`; delegate to
        // that SAME symbolic rule here rather than re-deriving a second,
        // potentially divergent open-definition / type-argument match, so
        // binder acceptance and emitter reference-compatibility can never
        // disagree. That helper's `AreTypeArgumentsEquivalent` comparison
        // still rejects a mismatched element type, preserving slice
        // invariance and GS0155 for genuine element mismatches.
        if (a is SliceTypeSymbol aSliceSymbolic
            && aSliceSymbolic.ClrType == null
            && Conversion.SliceImplementsInterfaceSymbolically(aSliceSymbolic, b))
        {
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #1431: returns <see langword="true"/> when <paramref name="a"/>
    /// and <paramref name="b"/> denote the same closed constructed generic
    /// reference type, comparing by the open definition's full name and each
    /// effective type argument (taken from the symbol's <c>TypeArguments</c>
    /// when present, otherwise from the <c>ClrType</c>'s generic arguments).
    /// This recognises the no-op identity conversion between two symbols for
    /// the same instantiation that differ only in representation — notably a
    /// substituted target whose <c>ClrType</c> was left in the type-erased
    /// open form while its <c>TypeArguments</c> carry the real arguments.
    /// </summary>
    private static bool SameClosedReferenceShape(TypeSymbol a, TypeSymbol b)
    {
        if (!TryGetClosedReferenceShape(a, out var aDef, out var aArgs)
            || !TryGetClosedReferenceShape(b, out var bDef, out var bArgs))
        {
            return false;
        }

        if (!aDef.IsSameAs(bDef) || aArgs.Length != bArgs.Length)
        {
            return false;
        }

        for (var i = 0; i < aArgs.Length; i++)
        {
            if (aArgs[i] == null || bArgs[i] == null || !aArgs[i].IsSameAs(bArgs[i]))
            {
                return false;
            }
        }

        return true;
    }

    private static bool TryGetClosedReferenceShape(TypeSymbol type, out Type definition, out Type[] args)
    {
        definition = null;
        args = null;

        var clr = type?.ClrType;
        if (clr == null || !clr.IsGenericType || clr.IsValueType)
        {
            return false;
        }

        definition = clr.GetGenericTypeDefinition();

        // Prefer the symbol's own type arguments — they survive the type
        // erasure that can leave `ClrType` in the open `IEnumerable<object>`
        // shape — and fall back to the CLR generic arguments when the symbol
        // elided them.
        if (type is ImportedTypeSymbol imported
            && !imported.TypeArguments.IsDefaultOrEmpty
            && imported.TypeArguments.Length == clr.GetGenericArguments().Length)
        {
            var symbolicArgs = new Type[imported.TypeArguments.Length];
            for (var i = 0; i < symbolicArgs.Length; i++)
            {
                var argClr = imported.TypeArguments[i]?.ClrType;
                if (argClr == null)
                {
                    return false;
                }

                symbolicArgs[i] = argClr;
            }

            args = symbolicArgs;
            return true;
        }

        args = clr.GetGenericArguments();
        return true;
    }

    private static bool IsSystemDelegateHostType(Type type)
    {
        if (type == null)
        {
            return false;
        }

        var fullName = type.FullName;
        return string.Equals(fullName, "System.Delegate", StringComparison.Ordinal)
            || string.Equals(fullName, "System.MulticastDelegate", StringComparison.Ordinal);
    }

    private static bool IsUnsignedOrChar(TypeSymbol t)
    {
        if (t == TypeSymbol.UInt8
            || t == TypeSymbol.UInt16
            || t == TypeSymbol.UInt32
            || t == TypeSymbol.UInt64
            || t == TypeSymbol.NUInt
            || t == TypeSymbol.Char)
        {
            return true;
        }

        // Issue #574 / 6.6: enum comparisons and arithmetic dispatch through
        // the enum's CLR underlying type. Unsigned-backed enums need the
        // unsigned IL opcodes (clt_un / cgt_un). Delegates to the single
        // source of truth in EnumOperatorTable.
        if (Binding.EnumOperatorTable.IsUnsignedEnumUnderlying(t))
        {
            return true;
        }

        return false;
    }

    // Issue #520: the EmitLoad/StoreElement helpers need to distinguish
    // class/interface element types (require stelem.ref / ldelem.ref) from
    // value-type element types (require the typed `stelem/ldelem <token>`
    // forms when no short-form opcode matches). All G#-native non-string
    // primitives have a TypeSymbol fast-path above; anything left over is
    // user-defined or imported and we can ask the underlying CLR type.
    private static bool IsReferenceTypeElement(TypeSymbol elementType)
    {
        if (elementType == TypeSymbol.Object)
        {
            return true;
        }

        var clr = elementType?.ClrType;
        return clr != null && !clr.IsValueType && !clr.IsGenericParameter;
    }

    private void CollectLabels(BoundStatement statement, HashSet<BoundLabel> sink)
    {
        switch (statement)
        {
            case null:
                return;
            case BoundLabelStatement lbl:
                sink.Add(lbl.Label);
                return;
            case BoundBlockStatement block:
                foreach (var s in block.Statements)
                {
                    this.CollectLabels(s, sink);
                }

                return;
            case BoundTryStatement t:
                this.CollectLabels(t.TryBlock, sink);
                foreach (var c in t.CatchClauses)
                {
                    this.CollectLabels(c.Body, sink);
                }

                if (t.FinallyBlock != null)
                {
                    this.CollectLabels(t.FinallyBlock, sink);
                }

                return;
            case BoundScopeStatement sc:
                this.CollectLabels(sc.Body, sink);
                return;
            case BoundFixedStatement fx:
                this.CollectLabels(fx.Body, sink);
                return;
            case BoundExpressionStatement es:
                this.CollectLabelsInExpression(es.Expression, sink);
                return;
            case BoundConditionalGotoStatement cg:
                this.CollectLabelsInExpression(cg.Condition, sink);
                return;
            case BoundReturnStatement rs:
                this.CollectLabelsInExpression(rs.Expression, sink);
                return;
            default:
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
                this.outer.slotPlanner.CollectExpressionBlockLabels(statement, sink);
                return;
        }
    }

    // Recursively collects BoundLabelStatement labels that live inside a
    // BoundExpression sub-tree. This is the inverse-side of CollectLabels
    // for expression-position blocks (BoundBlockExpression et al.).
    private void CollectLabelsInExpression(BoundExpression expression, HashSet<BoundLabel> sink)
    {
        if (expression == null)
        {
            return;
        }

        this.outer.slotPlanner.CollectExpressionBlockLabels(expression, sink);
    }

    private void EmitBranch(BoundLabel target, BoundExpression conditional, bool jumpIfTrue)
    {
        var targetHandle = this.labels[target];
        var crossesRegion = this.protectedRegionStack.Count > 0
            && !this.protectedRegionStack.Peek().Contains(target);

        if (conditional == null)
        {
            this.il.Branch(crossesRegion ? ILOpCode.Leave : ILOpCode.Br, targetHandle);
            return;
        }

        if (!crossesRegion)
        {
            this.EmitConditionalGotoProbe(conditional);
            this.il.Branch(jumpIfTrue ? ILOpCode.Brtrue : ILOpCode.Brfalse, targetHandle);
            return;
        }

        // Conditional goto that crosses a protected region boundary:
        // `leave` is not conditional, so emit the inverse branch over a
        // `leave` to the target.
        var skipLabel = this.il.DefineLabel();
        this.EmitConditionalGotoProbe(conditional);
        this.il.Branch(jumpIfTrue ? ILOpCode.Brfalse : ILOpCode.Brtrue, skipLabel);
        this.il.Branch(ILOpCode.Leave, targetHandle);
        this.il.MarkLabel(skipLabel);
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
    private void EmitConditionalGotoProbe(BoundExpression conditional)
    {
        this.EmitExpression(conditional);

        if (conditional.Type is NullableTypeSymbol nullable
            && (NullableLifting.IsValueTypeNullable(nullable) || NullableLifting.IsUserValueTypeNullable(nullable)))
        {
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(nullable));
        }
    }

    // Issue #420 (P3-4): debug-only check used by EmitFieldAssignment to
    // assert the binder never feeds a value expression that reassigns the
    // field-assignment receiver variable. Looks for any
    // BoundAssignmentExpression whose target is the same VariableSymbol as
    // the receiver. Conservative — false positives are fine because this
    // is a debug-only assertion guarding a code-gen invariant.
    private static bool ValueExpressionMutatesReceiver(BoundExpression value, VariableSymbol receiver)
    {
        if (value == null || receiver == null)
        {
            return false;
        }

        var detector = new ReceiverMutationDetector(receiver);
        detector.Visit(value);
        return detector.Found;
    }

    private sealed class ReceiverMutationDetector : BoundTreeWalker
    {
        private readonly VariableSymbol receiver;

        public ReceiverMutationDetector(VariableSymbol receiver)
        {
            this.receiver = receiver;
        }

        public bool Found { get; private set; }

        protected override void VisitAssignmentExpression(BoundAssignmentExpression node)
        {
            if (ReferenceEquals(node.Variable, this.receiver))
            {
                this.Found = true;
            }

            base.VisitAssignmentExpression(node);
        }
    }

    // Issue #1522: collects the spilled `stackalloc` sub-expressions directly
    // contained in a single statement, in source (evaluation) order, without
    // descending into nested statements (each of those runs its own
    // materialisation pass in EmitStatement).
    private sealed class SpilledStackAllocCollector : BoundTreeWalker
    {
        private readonly IReadOnlyDictionary<BoundStackAllocExpression, int> spilled;
        private readonly List<BoundStackAllocExpression> sink;
        private bool entered;

        public SpilledStackAllocCollector(
            IReadOnlyDictionary<BoundStackAllocExpression, int> spilled,
            List<BoundStackAllocExpression> sink)
        {
            this.spilled = spilled;
            this.sink = sink;
        }

        public override void VisitStatement(BoundStatement node)
        {
            if (this.entered)
            {
                return;
            }

            this.entered = true;
            base.VisitStatement(node);
        }

        public override void VisitExpression(BoundExpression node)
        {
            // Post-order: a stackalloc nested inside another spilled
            // stackalloc's count/initializer must be materialised first so the
            // outer materialisation reads it back with an empty stack.
            base.VisitExpression(node);
            if (node is BoundStackAllocExpression sa && this.spilled.ContainsKey(sa))
            {
                this.sink.Add(sa);
            }
        }
    }

    // Issue #2283: collects every BoundChannelReceiveExpression directly
    // contained in a single statement (mirrors SpilledStackAllocCollector —
    // does not descend past the first statement boundary; nested statements
    // run their own MaterializeSpilledChannelReceives pass). Post-order, so a
    // receive nested inside another receive's channel sub-expression (however
    // unlikely) is materialised innermost-first.
    private sealed class ChannelReceiveCollector : BoundTreeWalker
    {
        private readonly List<BoundChannelReceiveExpression> sink;
        private bool entered;

        public ChannelReceiveCollector(List<BoundChannelReceiveExpression> sink)
        {
            this.sink = sink;
        }

        public override void VisitStatement(BoundStatement node)
        {
            if (this.entered)
            {
                return;
            }

            this.entered = true;
            base.VisitStatement(node);
        }

        public override void VisitExpression(BoundExpression node)
        {
            base.VisitExpression(node);
            if (node is BoundChannelReceiveExpression recv)
            {
                this.sink.Add(recv);
            }
        }
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
    // Element types lacking a ClrType (e.g. user-defined class
    // values) are erased to object, mirroring the interpreter's
    // `ElementType.ClrType ?? typeof(object)` fallback.
    private static Type ResolveChannelElementClrType(TypeSymbol elementType)
    {
        return elementType.ClrType ?? typeof(object);
    }
}
