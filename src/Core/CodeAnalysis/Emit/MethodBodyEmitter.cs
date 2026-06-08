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
    private readonly Dictionary<BoundExpression, int> indexAssignmentValueSlots;
    private readonly Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes;
    private readonly Dictionary<BoundBinaryExpression, LiftedBinarySlots> liftedBinarySlots;
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
        Dictionary<BoundBinaryExpression, LiftedBinarySlots> liftedBinarySlots = null,
        ParameterSymbol structThisParameter = null,
        Lowering.Async.AsyncStateMachineFieldMap asyncFieldMap = null,
        Lowering.Async.AsyncStateMachinePlan asyncPlan = null,
        StateMachineEmitter.AsyncIteratorEmitContext asyncIteratorEmitCtx = null,
        Dictionary<VariableSymbol, object> constValues = null,
        ClosureEmitter.ClosureInfo enclosingClosure = null)
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
        this.liftedBinarySlots = liftedBinarySlots ?? new Dictionary<BoundBinaryExpression, LiftedBinarySlots>();
        this.structThisParameter = structThisParameter;
        this.asyncFieldMap = asyncFieldMap;
        this.asyncPlan = asyncPlan;
        this.asyncIteratorEmitCtx = asyncIteratorEmitCtx;
        this.constValues = constValues;
        this.enclosingClosure = enclosingClosure;
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
        this.currentNode = statement;
        this.RecordSequencePointFor(statement);
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

    private static bool IsObjectStackType(TypeSymbol type)
    {
        if (type == TypeSymbol.Object || type?.ClrType == typeof(object))
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

        var clr = type?.ClrType;
        if (clr != null && clr.IsEnum)
        {
            // Loaded via a MetadataLoadContext or normal load: use the
            // CLR's own underlying-type API, then map back to a
            // TypeSymbol for the numeric lattice.
            var underlying = System.Enum.GetUnderlyingType(clr);
            return TypeSymbol.FromClrType(underlying);
        }

        return null;
    }

    private static bool IsInterfaceTargetType(TypeSymbol type)
    {
        if (type is InterfaceSymbol)
        {
            return true;
        }

        return type?.ClrType != null && type.ClrType.IsInterface;
    }

    private static bool IsInterfaceSourceType(TypeSymbol type)
    {
        if (type is InterfaceSymbol)
        {
            return true;
        }

        return type?.ClrType != null && type.ClrType.IsInterface;
    }

    private static bool IsUnsignedClrType(Type t)
        => t == typeof(byte) || t == typeof(ushort) || t == typeof(uint)
            || t == typeof(ulong) || t == typeof(nuint) || t == typeof(char);

    private static bool IsNumericClrType(Type t)
        => t == typeof(sbyte) || t == typeof(byte)
            || t == typeof(short) || t == typeof(ushort)
            || t == typeof(int) || t == typeof(uint)
            || t == typeof(long) || t == typeof(ulong)
            || t == typeof(nint) || t == typeof(nuint)
            || t == typeof(float) || t == typeof(double)
            || t == typeof(decimal) || t == typeof(char);

    private static bool Is32BitOrSmaller(Type t)
        => t == typeof(sbyte) || t == typeof(byte)
            || t == typeof(short) || t == typeof(ushort)
            || t == typeof(int) || t == typeof(uint)
            || t == typeof(char) || t == typeof(bool);

    private static bool IsReferenceCompatible(TypeSymbol a, TypeSymbol b)
    {
        if (a == b)
        {
            return true;
        }

        // ADR-0045: any reference type widens to `object` at the IL
        // level as a no-op; the slot already holds the reference.
        if (b?.ClrType == typeof(object) && a?.ClrType != null && !a.ClrType.IsValueType)
        {
            return true;
        }

        if (a is StructSymbol aClass && b is StructSymbol bClass && aClass.IsClass && bClass.IsClass)
        {
            for (var c = aClass; c != null; c = c.BaseClass)
            {
                if (c == bClass)
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

                    if (ifaceClr == b.ClrType || b.ClrType.IsAssignableFrom(ifaceClr))
                    {
                        return true;
                    }
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

        return false;
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

        // Issue #574: enum comparisons (< <= > >=) dispatch through the
        // enum's CLR underlying type. A byte/ushort/uint/ulong-backed
        // enum needs the unsigned IL comparison opcodes (clt_un / cgt_un);
        // a sbyte/short/int/long-backed enum needs the signed forms.
        if (t?.ClrType?.IsEnum == true)
        {
            var underlyingName = System.Enum.GetUnderlyingType(t.ClrType).FullName;
            return underlyingName == "System.Byte"
                || underlyingName == "System.UInt16"
                || underlyingName == "System.UInt32"
                || underlyingName == "System.UInt64";
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
            this.EmitExpression(conditional);
            this.il.Branch(jumpIfTrue ? ILOpCode.Brtrue : ILOpCode.Brfalse, targetHandle);
            return;
        }

        // Conditional goto that crosses a protected region boundary:
        // `leave` is not conditional, so emit the inverse branch over a
        // `leave` to the target.
        var skipLabel = this.il.DefineLabel();
        this.EmitExpression(conditional);
        this.il.Branch(jumpIfTrue ? ILOpCode.Brfalse : ILOpCode.Brtrue, skipLabel);
        this.il.Branch(ILOpCode.Leave, targetHandle);
        this.il.MarkLabel(skipLabel);
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
