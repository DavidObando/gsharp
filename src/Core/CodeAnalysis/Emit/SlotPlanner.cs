// <copyright file="SlotPlanner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1201 // method should not follow a class (this file mixes private helper classes inline with methods)

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Owns the per-emit family of <see cref="BoundTreeWalker"/> collectors
/// that pre-allocate IL slots for every bound-node kind whose lowering
/// needs a scratch local. The collectors are independent walkers — none
/// of them emits IL — and their outputs (slot dictionaries keyed by
/// bound-node identity) feed the body emitter's <c>ldloc/stloc</c> sites.
/// </summary>
/// <remarks>
/// <para>
/// PR-E-4 extracts the 16 nested collector classes (and the
/// <see cref="SelectSlots"/> per-select value object they populate) out of
/// <see cref="ReflectionMetadataEmitter"/> into this dedicated component.
/// The slot dictionaries themselves continue to live on the
/// <c>ReflectionMetadataEmitter.BodyEmitter</c> nested type because they
/// are per-method-emit and are passed into the collectors at use sites
/// rather than owned long-term. The defensive
/// <c>Debug.Assert(!structLiteralSlots.ContainsKey(...))</c>-style
/// allocation-site assertions therefore remain in
/// <c>ReflectionMetadataEmitter</c>'s <c>CollectLocalsAndLabels</c> for
/// now; <c>SlotDictionaryAliasingAssertionTests</c> globs every
/// <c>*.cs</c> file under <c>src/Core/CodeAnalysis/Emit/</c> and so
/// remains green regardless of which sibling file ends up housing each
/// substring.
/// </para>
/// <para>
/// Two collectors required a small contract change to break their direct
/// dependency on the root emitter:
/// </para>
/// <list type="bullet">
///   <item><see cref="PatternSwitchSlotAllocator"/> now takes a
///   <see cref="MetadataTokenCache"/> directly instead of an
///   <see cref="ReflectionMetadataEmitter"/> back-reference. It only ever
///   read <c>cache.GlobalFieldDefs</c>.</item>
///   <item><see cref="ReceiverSpillCollector"/> now takes a
///   <c>Func&lt;BoundExpression, FunctionSymbol, IReadOnlyDictionary&lt;VariableSymbol, int&gt;, bool&gt;</c>
///   delegate that the emitter binds to its existing
///   <c>NeedsRvalueReceiverSpill</c> method.</item>
/// </list>
/// <para>
/// <c>ConstructedTypeCollector</c> is intentionally NOT moved here: it is
/// a <c>BoundTreeRewriter</c> tied to the closure/display-class synthesis
/// path and belongs with PR-E-9 <c>ClosureEmitter</c>.
/// </para>
/// </remarks>
internal sealed class SlotPlanner
{
    private readonly EmitContext emitCtx;
    private readonly MetadataTokenCache cache;
    private readonly Func<BoundExpression, FunctionSymbol, IReadOnlyDictionary<VariableSymbol, int>, bool> needsRvalueReceiverSpill;

    public SlotPlanner(
        EmitContext emitCtx,
        MetadataTokenCache cache,
        Func<BoundExpression, FunctionSymbol, IReadOnlyDictionary<VariableSymbol, int>, bool> needsRvalueReceiverSpill)
    {
        this.emitCtx = emitCtx ?? throw new ArgumentNullException(nameof(emitCtx));
        this.cache = cache ?? throw new ArgumentNullException(nameof(cache));
        this.needsRvalueReceiverSpill = needsRvalueReceiverSpill ?? throw new ArgumentNullException(nameof(needsRvalueReceiverSpill));
    }

    // ─────────────────────────── entry points ───────────────────────────
    public void CollectStructLiterals(BoundNode node, List<BoundStructLiteralExpression> sink)
        => new StructLiteralCollector(sink).Visit(node);

    public void CollectAppends(BoundNode node, List<BoundAppendExpression> sink)
        => new AppendCollector(sink).Visit(node);

    public void CollectNullConditional(BoundNode node, List<BoundNullConditionalAccessExpression> sink)
        => new NullConditionalCollector(sink).Visit(node);

    public void CollectBlockExpressionLocals(BoundBlockStatement body, List<VariableSymbol> sink)
    {
        var collector = new BlockExpressionLocalCollector();
        collector.Visit(body);
        sink.AddRange(collector.Variables);
    }

    public void CollectExpressionBlockLabels(BoundNode node, HashSet<BoundLabel> sink)
        => new ExpressionBlockLabelCollector(sink).Visit(node);

    public List<BoundFunctionLiteralExpression> CollectFunctionLiterals()
    {
        var sink = new List<BoundFunctionLiteralExpression>();
        var collector = new LambdaCollector(sink);
        foreach (var kvp in this.emitCtx.Program.Functions)
        {
            collector.Visit(kvp.Value);
        }

        return sink;
    }

    public List<BoundGoStatement> CollectGoStatements()
    {
        var sink = new List<BoundGoStatement>();
        var collector = new GoStatementCollector(sink);
        foreach (var kvp in this.emitCtx.Program.Functions)
        {
            collector.Visit(kvp.Value);
        }

        return sink;
    }

    public ImmutableArray<VariableSymbol> CollectCapturedVariables(BoundExpression expression)
    {
        var seen = new HashSet<VariableSymbol>();
        var captured = ImmutableArray.CreateBuilder<VariableSymbol>();
        var declared = new HashSet<VariableSymbol>();
        var collector = new GoCapturedVariableCollector(seen, declared, captured);
        collector.Collect(expression);
        return captured.ToImmutable();
    }

    public void CollectDefaultExpressions(BoundStatement root, List<BoundDefaultExpression> sink)
        => new DefaultExpressionCollector(sink).Visit(root);

    public void CollectReceiverSpills(
        BoundStatement root,
        FunctionSymbol function,
        IReadOnlyDictionary<VariableSymbol, int> locals,
        List<BoundExpression> sink)
        => new ReceiverSpillCollector(this.needsRvalueReceiverSpill, function, locals, sink).Visit(root);

    public void CollectMapIndexReads(BoundStatement root, List<BoundIndexExpression> sink)
        => new MapIndexReadCollector(sink).Visit(root);

    public void CollectIndexAssignmentValueSpills(BoundStatement root, List<BoundExpression> sink)
        => new IndexAssignmentValueSpillCollector(sink).Visit(root);

    public void CollectAssignmentValueSpills(BoundStatement root, List<BoundExpression> sink)
        => new AssignmentValueSpillCollector(sink).Visit(root);

    public void CollectNullableValueTypeUnwraps(BoundStatement root, List<BoundUnaryExpression> sink)
        => new NullableValueTypeUnwrapCollector(sink).Visit(root);

    public void CollectNullableValueTypeCoalesces(BoundStatement root, List<BoundBinaryExpression> sink)
        => new NullableValueTypeCoalesceCollector(sink).Visit(root);

    public void CollectLiftedBinaryOperators(BoundStatement root, List<BoundBinaryExpression> sink)
        => new LiftedBinaryOperatorCollector(sink).Visit(root);

    public void RunPatternSwitchAllocator(
        BoundNode node,
        Dictionary<VariableSymbol, int> locals,
        List<TypeSymbol> localTypes,
        Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots,
        Dictionary<BoundTypePattern, int> typePatternScratchSlots,
        Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots,
        Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots,
        Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots,
        Dictionary<BoundSelectStatement, SelectSlots> selectStatementSlots,
        Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes,
        BoundScopeStatement currentScope)
    {
        var allocator = new PatternSwitchSlotAllocator(
            this.cache,
            locals,
            localTypes,
            patternSwitchSlots,
            typePatternScratchSlots,
            switchExpressionSlots,
            channelOpSlots,
            scopeFrameSlots,
            selectStatementSlots,
            goEnclosingScopes,
            currentScope);
        allocator.Visit(node);
    }

    // ─────────────────────────── collectors ───────────────────────────
    private sealed class PatternSwitchSlotAllocator : BoundTreeWalker
    {
        private readonly MetadataTokenCache cache;
        private readonly Dictionary<VariableSymbol, int> locals;
        private readonly List<TypeSymbol> localTypes;
        private readonly Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots;
        private readonly Dictionary<BoundTypePattern, int> typePatternScratchSlots;
        private readonly Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots;
        private readonly Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots;
        private readonly Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots;
        private readonly Dictionary<BoundSelectStatement, SelectSlots> selectStatementSlots;
        private readonly Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes;
        private BoundScopeStatement currentScope;

        public PatternSwitchSlotAllocator(
            MetadataTokenCache cache,
            Dictionary<VariableSymbol, int> locals,
            List<TypeSymbol> localTypes,
            Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots,
            Dictionary<BoundTypePattern, int> typePatternScratchSlots,
            Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots,
            Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots,
            Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots,
            Dictionary<BoundSelectStatement, SelectSlots> selectStatementSlots,
            Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes,
            BoundScopeStatement currentScope)
        {
            this.cache = cache;
            this.locals = locals;
            this.localTypes = localTypes;
            this.patternSwitchSlots = patternSwitchSlots;
            this.typePatternScratchSlots = typePatternScratchSlots;
            this.switchExpressionSlots = switchExpressionSlots;
            this.channelOpSlots = channelOpSlots;
            this.scopeFrameSlots = scopeFrameSlots;
            this.selectStatementSlots = selectStatementSlots;
            this.goEnclosingScopes = goEnclosingScopes;
            this.currentScope = currentScope;
        }

        protected override void VisitPatternSwitchStatement(BoundPatternSwitchStatement node)
        {
            if (!this.patternSwitchSlots.ContainsKey(node))
            {
                var discriminantSlot = this.localTypes.Count;
                this.localTypes.Add(node.Discriminant.Type);
                this.patternSwitchSlots[node] = discriminantSlot;
            }

            VisitExpression(node.Discriminant);
            foreach (var arm in node.Arms)
            {
                if (arm.Pattern != null)
                {
                    AllocatePatternBindings(arm.Pattern, this.locals, this.localTypes, this.typePatternScratchSlots);
                    VisitPattern(arm.Pattern);
                }

                VisitStatement(arm.Body);
            }
        }

        protected override void VisitVariableDeclaration(BoundVariableDeclaration node)
        {
            // Issue #216: const decls have no IL slot.
            // Issue #191: top-level globals are emitted as static fields on
            // <Program>; do not allocate a local slot for them when they
            // appear nested inside a switch arm / scope.
            if (node.ConstantValue == null
                && !this.locals.ContainsKey(node.Variable)
                && !(node.Variable is GlobalVariableSymbol gv && this.cache.GlobalFieldDefs.ContainsKey(gv)))
            {
                this.locals[node.Variable] = this.localTypes.Count;

                // Issue #491 (ADR-0060 follow-up): a ref-aliasing local's IL slot
                // is the managed pointer `T&`, not the pointee `T`. Recording the
                // slot type as ByRefTypeSymbol routes encoding through the byref
                // local-sig path (EncodeLocalVariableType).
                if (node.Variable is LocalVariableSymbol lvs && lvs.RefKind != RefKind.None)
                {
                    this.localTypes.Add(ByRefTypeSymbol.Get(lvs.Type));
                }
                else
                {
                    this.localTypes.Add(node.Variable.Type);
                }
            }

            base.VisitVariableDeclaration(node);
        }

        // ADR-0060: an inline `out var name`, `out let name`, or `out _` argument
        // synthesises a local in the binder without a corresponding
        // BoundVariableDeclaration statement. Pick the local up here when we see
        // its address taken so the emitter has a slot to ldloca from.
        protected override void VisitAddressOfExpression(BoundAddressOfExpression node)
        {
            if (node.Operand is BoundVariableExpression bve
                && bve.Variable is LocalVariableSymbol lvs
                && lvs is not ParameterSymbol
                && !this.locals.ContainsKey(lvs))
            {
                this.locals[lvs] = this.localTypes.Count;
                this.localTypes.Add(lvs.Type);
            }

            base.VisitAddressOfExpression(node);
        }

        protected override void VisitGoStatement(BoundGoStatement node)
        {
            if (this.currentScope != null)
            {
                this.goEnclosingScopes[node] = this.currentScope;
            }

            base.VisitGoStatement(node);
        }

        protected override void VisitScopeStatement(BoundScopeStatement node)
        {
            AllocateScopeFrameSlots(node, this.localTypes, this.scopeFrameSlots);
            var saved = this.currentScope;
            this.currentScope = node;
            try
            {
                base.VisitScopeStatement(node);
            }
            finally
            {
                this.currentScope = saved;
            }
        }

        protected override void VisitSelectStatement(BoundSelectStatement node)
        {
            AllocateSelectSlots(node, this.locals, this.localTypes, this.selectStatementSlots);
            base.VisitSelectStatement(node);
        }

        protected override void VisitChannelSendStatement(BoundChannelSendStatement node)
        {
            AllocateChannelSendSlots(node, this.localTypes, this.channelOpSlots);
            base.VisitChannelSendStatement(node);
        }

        protected override void VisitChannelReceiveExpression(BoundChannelReceiveExpression node)
        {
            AllocateChannelReceiveSlots(node, this.localTypes, this.channelOpSlots);
            base.VisitChannelReceiveExpression(node);
        }

        protected override void VisitSwitchExpression(BoundSwitchExpression node)
        {
            if (!this.switchExpressionSlots.ContainsKey(node))
            {
                var resultSlot = this.localTypes.Count;
                this.localTypes.Add(node.Type);
                var discrSlot = this.localTypes.Count;
                this.localTypes.Add(node.Discriminant.Type);
                this.switchExpressionSlots[node] = (resultSlot, discrSlot);
            }

            VisitExpression(node.Discriminant);
            foreach (var arm in node.Arms)
            {
                if (arm.Pattern != null)
                {
                    AllocatePatternBindings(arm.Pattern, this.locals, this.localTypes, this.typePatternScratchSlots);
                    VisitPattern(arm.Pattern);
                }

                VisitExpression(arm.Result);
            }
        }

        private static void AllocateScopeFrameSlots(
            BoundScopeStatement node,
            List<TypeSymbol> localTypes,
            Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots)
        {
            if (scopeFrameSlots.ContainsKey(node))
            {
                return;
            }

            var tasks = localTypes.Count;
            localTypes.Add(TypeSymbol.FromClrType(typeof(List<System.Threading.Tasks.Task>)));
            var cts = localTypes.Count;
            localTypes.Add(TypeSymbol.FromClrType(typeof(System.Threading.CancellationTokenSource)));
            var awaiter = localTypes.Count;
            localTypes.Add(TypeSymbol.FromClrType(typeof(System.Runtime.CompilerServices.TaskAwaiter)));
            scopeFrameSlots[node] = (tasks, cts, awaiter);
        }

        private static void AllocateChannelSendSlots(
            BoundChannelSendStatement node,
            List<TypeSymbol> localTypes,
            Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots)
        {
            if (channelOpSlots.ContainsKey(node))
            {
                return;
            }

            var vt = localTypes.Count;
            localTypes.Add(TypeSymbol.FromClrType(typeof(System.Threading.Tasks.ValueTask)));
            var ta = localTypes.Count;
            localTypes.Add(TypeSymbol.FromClrType(typeof(System.Runtime.CompilerServices.TaskAwaiter)));
            channelOpSlots[node] = (vt, ta, -1, -1);
        }

        private static void AllocateChannelReceiveSlots(
            BoundChannelReceiveExpression node,
            List<TypeSymbol> localTypes,
            Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots)
        {
            if (channelOpSlots.ContainsKey(node))
            {
                return;
            }

            var chType = (ChannelTypeSymbol)node.Channel.Type;
            var elementClr = chType.ElementType.ClrType ?? typeof(object);
            var vtClr = typeof(System.Threading.Tasks.ValueTask<>).MakeGenericType(elementClr);
            var taClr = typeof(System.Runtime.CompilerServices.TaskAwaiter<>).MakeGenericType(elementClr);

            var vt = localTypes.Count;
            localTypes.Add(TypeSymbol.FromClrType(vtClr));
            var ta = localTypes.Count;
            localTypes.Add(TypeSymbol.FromClrType(taClr));
            var result = localTypes.Count;
            localTypes.Add(chType.ElementType.ClrType != null ? chType.ElementType : TypeSymbol.FromClrType(typeof(object)));
            channelOpSlots[node] = (vt, ta, result, -1);
        }

        private static void AllocateSelectSlots(
            BoundSelectStatement node,
            Dictionary<VariableSymbol, int> locals,
            List<TypeSymbol> localTypes,
            Dictionary<BoundSelectStatement, SelectSlots> selectStatementSlots)
        {
            if (selectStatementSlots.ContainsKey(node))
            {
                return;
            }

            var channelSlots = new int[node.Cases.Length];
            var valueSlots = new int[node.Cases.Length];
            var outSlots = new int[node.Cases.Length];
            Array.Fill(channelSlots, -1);
            Array.Fill(valueSlots, -1);
            Array.Fill(outSlots, -1);

            for (var i = 0; i < node.Cases.Length; i++)
            {
                var arm = node.Cases[i];
                if (arm.IsDefault)
                {
                    continue;
                }

                channelSlots[i] = localTypes.Count;
                localTypes.Add(arm.Channel.Type);

                if (arm.CaseKind == SelectCaseKind.Send)
                {
                    valueSlots[i] = localTypes.Count;
                    localTypes.Add(arm.Value.Type);
                    continue;
                }

                var chType = (ChannelTypeSymbol)arm.Channel.Type;
                if (arm.CaseKind == SelectCaseKind.ReceiveBind && arm.Variable != null)
                {
                    if (!locals.TryGetValue(arm.Variable, out var slot))
                    {
                        slot = localTypes.Count;
                        locals[arm.Variable] = slot;
                        localTypes.Add(arm.Variable.Type);
                    }

                    outSlots[i] = slot;
                }
                else
                {
                    outSlots[i] = localTypes.Count;
                    localTypes.Add(chType.ElementType.ClrType != null ? chType.ElementType : TypeSymbol.FromClrType(typeof(object)));
                }
            }

            var tasksSlot = localTypes.Count;
            localTypes.Add(TypeSymbol.FromClrType(typeof(System.Threading.Tasks.Task[])));
            var waitValueTaskSlot = localTypes.Count;
            localTypes.Add(TypeSymbol.FromClrType(typeof(System.Threading.Tasks.ValueTask<bool>)));
            var whenAnyTaskSlot = localTypes.Count;
            localTypes.Add(TypeSymbol.FromClrType(typeof(System.Threading.Tasks.Task<System.Threading.Tasks.Task>)));
            var whenAnyAwaiterSlot = localTypes.Count;
            localTypes.Add(TypeSymbol.FromClrType(typeof(System.Runtime.CompilerServices.TaskAwaiter<System.Threading.Tasks.Task>)));
            var completedTaskSlot = localTypes.Count;
            localTypes.Add(TypeSymbol.FromClrType(typeof(System.Threading.Tasks.Task)));

            selectStatementSlots[node] = new SelectSlots(
                channelSlots,
                valueSlots,
                outSlots,
                tasksSlot,
                waitValueTaskSlot,
                whenAnyTaskSlot,
                whenAnyAwaiterSlot,
                completedTaskSlot);
        }

        private static void AllocatePatternBindings(
            BoundPattern pattern,
            Dictionary<VariableSymbol, int> locals,
            List<TypeSymbol> localTypes,
            Dictionary<BoundTypePattern, int> typePatternScratchSlots)
        {
            switch (pattern)
            {
                case BoundTypePattern tp:
                    if (!typePatternScratchSlots.ContainsKey(tp))
                    {
                        var scratch = localTypes.Count;
                        localTypes.Add(TypeSymbol.FromClrType(typeof(object)));
                        typePatternScratchSlots[tp] = scratch;
                    }

                    if (!locals.ContainsKey(tp.Variable))
                    {
                        locals[tp.Variable] = localTypes.Count;
                        localTypes.Add(tp.Variable.Type);
                    }

                    break;
                case BoundPropertyPattern pp:
                    foreach (var field in pp.Fields)
                    {
                        AllocatePatternBindings(field.Pattern, locals, localTypes, typePatternScratchSlots);
                    }

                    break;
                case BoundListPattern lp:
                    foreach (var elem in lp.Elements)
                    {
                        AllocatePatternBindings(elem, locals, localTypes, typePatternScratchSlots);
                    }

                    break;
            }
        }
    }

    private sealed class StructLiteralCollector : BoundTreeWalker
    {
        private readonly List<BoundStructLiteralExpression> sink;

        public StructLiteralCollector(List<BoundStructLiteralExpression> sink)
        {
            this.sink = sink;
        }

        protected override void VisitStructLiteralExpression(BoundStructLiteralExpression node)
        {
            this.sink.Add(node);
            base.VisitStructLiteralExpression(node);
        }
    }

    private sealed class AppendCollector : BoundTreeWalker
    {
        private readonly List<BoundAppendExpression> sink;

        public AppendCollector(List<BoundAppendExpression> sink)
        {
            this.sink = sink;
        }

        protected override void VisitAppendExpression(BoundAppendExpression node)
        {
            this.sink.Add(node);
            base.VisitAppendExpression(node);
        }
    }

    private sealed class NullConditionalCollector : BoundTreeWalker
    {
        private readonly List<BoundNullConditionalAccessExpression> sink;

        public NullConditionalCollector(List<BoundNullConditionalAccessExpression> sink)
        {
            this.sink = sink;
        }

        protected override void VisitNullConditionalAccessExpression(BoundNullConditionalAccessExpression node)
        {
            this.sink.Add(node);
            base.VisitNullConditionalAccessExpression(node);
        }
    }

    private sealed class BlockExpressionLocalCollector : BoundTreeWalker
    {
        public List<VariableSymbol> Variables { get; } = new List<VariableSymbol>();

        protected override void VisitBlockExpression(BoundBlockExpression node)
        {
            foreach (var statement in node.Statements)
            {
                if (statement is BoundVariableDeclaration declaration)
                {
                    this.Variables.Add(declaration.Variable);
                }
            }

            base.VisitBlockExpression(node);
        }
    }

    // Walks an arbitrary bound sub-tree and records every BoundLabelStatement
    // label it discovers. Implemented as a BoundTreeWalker subclass so it
    // automatically descends through every statement and expression kind
    // (including BoundBlockExpression, BoundSpillSequenceExpression, etc.)
    // without having to enumerate them by hand.
    private sealed class ExpressionBlockLabelCollector : BoundTreeWalker
    {
        private readonly HashSet<BoundLabel> sink;

        public ExpressionBlockLabelCollector(HashSet<BoundLabel> sink)
        {
            this.sink = sink;
        }

        public override void VisitStatement(BoundStatement node)
        {
            if (node is BoundLabelStatement label)
            {
                this.sink.Add(label.Label);
                return;
            }

            base.VisitStatement(node);
        }
    }

    private sealed class LambdaCollector : BoundTreeWalker
    {
        private readonly List<BoundFunctionLiteralExpression> sink;

        public LambdaCollector(List<BoundFunctionLiteralExpression> sink)
        {
            this.sink = sink;
        }

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundFunctionLiteralExpression lambda)
            {
                this.sink.Add(lambda);
                this.VisitStatement(lambda.Body);
                return;
            }

            base.VisitExpression(node);
        }
    }

    private sealed class GoStatementCollector : BoundTreeWalker
    {
        private readonly List<BoundGoStatement> sink;

        public GoStatementCollector(List<BoundGoStatement> sink)
        {
            this.sink = sink;
        }

        public override void VisitExpression(BoundExpression node)
        {
            // Override the base dispatch so we descend into the body of any
            // BoundFunctionLiteralExpression we encounter — go statements
            // need to discover nested go statements inside lambda bodies too.
            if (node is BoundFunctionLiteralExpression lambda)
            {
                this.VisitStatement(lambda.Body);
                return;
            }

            base.VisitExpression(node);
        }

        protected override void VisitGoStatement(BoundGoStatement node)
        {
            this.sink.Add(node);
            base.VisitGoStatement(node);
        }
    }

    private sealed class GoCapturedVariableCollector : BoundTreeWalker
    {
        private readonly HashSet<VariableSymbol> seen;
        private readonly HashSet<VariableSymbol> declared;
        private readonly ImmutableArray<VariableSymbol>.Builder captured;

        public GoCapturedVariableCollector(
            HashSet<VariableSymbol> seen,
            HashSet<VariableSymbol> declared,
            ImmutableArray<VariableSymbol>.Builder captured)
        {
            this.seen = seen;
            this.declared = declared;
            this.captured = captured;
        }

        public void Collect(BoundExpression expression)
        {
            this.VisitExpression(expression);
        }

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundVariableExpression ve)
            {
                this.CaptureIfFree(ve.Variable);
                return;
            }

            base.VisitExpression(node);
        }

        protected override void VisitAssignmentExpression(BoundAssignmentExpression node)
        {
            this.CaptureIfFree(node.Variable);
            base.VisitAssignmentExpression(node);
        }

        protected override void VisitVariableDeclaration(BoundVariableDeclaration node)
        {
            this.VisitExpression(node.Initializer);
            this.declared.Add(node.Variable);
        }

        private void CaptureIfFree(VariableSymbol variable)
        {
            if (!this.declared.Contains(variable)
                && this.seen.Add(variable))
            {
                this.captured.Add(variable);
            }
        }
    }

    private sealed class DefaultExpressionCollector : BoundTreeWalker
    {
        private readonly List<BoundDefaultExpression> sink;

        public DefaultExpressionCollector(List<BoundDefaultExpression> sink)
        {
            this.sink = sink;
        }

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundDefaultExpression de)
            {
                this.sink.Add(de);
                return;
            }

            base.VisitExpression(node);
        }
    }

    private sealed class ReceiverSpillCollector : BoundTreeWalker
    {
        private readonly Func<BoundExpression, FunctionSymbol, IReadOnlyDictionary<VariableSymbol, int>, bool> needsRvalueReceiverSpill;
        private readonly FunctionSymbol function;
        private readonly IReadOnlyDictionary<VariableSymbol, int> locals;
        private readonly List<BoundExpression> sink;

        public ReceiverSpillCollector(
            Func<BoundExpression, FunctionSymbol, IReadOnlyDictionary<VariableSymbol, int>, bool> needsRvalueReceiverSpill,
            FunctionSymbol function,
            IReadOnlyDictionary<VariableSymbol, int> locals,
            List<BoundExpression> sink)
        {
            this.needsRvalueReceiverSpill = needsRvalueReceiverSpill;
            this.function = function;
            this.locals = locals;
            this.sink = sink;
        }

        protected override void VisitImportedInstanceCallExpression(BoundImportedInstanceCallExpression node)
        {
            this.AddIfNeeded(node.Receiver);
            base.VisitImportedInstanceCallExpression(node);
        }

        protected override void VisitUserInstanceCallExpression(BoundUserInstanceCallExpression node)
        {
            this.AddIfNeeded(node.Receiver);
            base.VisitUserInstanceCallExpression(node);
        }

        protected override void VisitClrPropertyAccessExpression(BoundClrPropertyAccessExpression node)
        {
            if (node.Receiver != null)
            {
                this.AddIfNeeded(node.Receiver);
            }

            base.VisitClrPropertyAccessExpression(node);
        }

        protected override void VisitClrPropertyAssignmentExpression(BoundClrPropertyAssignmentExpression node)
        {
            if (node.Receiver != null)
            {
                this.AddIfNeeded(node.Receiver);
            }

            base.VisitClrPropertyAssignmentExpression(node);
        }

        // Issue #418 (P1-5): G# computed/auto properties also need the spill
        // infrastructure when the receiver is a non-addressable struct rvalue
        // (e.g. `makePoint(5, 6).Sum`, `getOuter().Inner.Length`).
        protected override void VisitPropertyAccessExpression(BoundPropertyAccessExpression node)
        {
            if (node.Receiver != null)
            {
                this.AddIfNeeded(node.Receiver);
            }

            base.VisitPropertyAccessExpression(node);
        }

        protected override void VisitPropertyAssignmentExpression(BoundPropertyAssignmentExpression node)
        {
            if (node.Receiver != null)
            {
                this.AddIfNeeded(node.Receiver);
            }

            base.VisitPropertyAssignmentExpression(node);
        }

        protected override void VisitClrEventSubscriptionExpression(BoundClrEventSubscriptionExpression node)
        {
            if (node.Receiver != null)
            {
                this.AddIfNeeded(node.Receiver);
            }

            base.VisitClrEventSubscriptionExpression(node);
        }

        protected override void VisitEventSubscriptionExpression(BoundEventSubscriptionExpression node)
        {
            if (node.Receiver != null)
            {
                this.AddIfNeeded(node.Receiver);
            }

            base.VisitEventSubscriptionExpression(node);
        }

        protected override void VisitClrIndexExpression(BoundClrIndexExpression node)
        {
            this.AddIfNeeded(node.Target);
            base.VisitClrIndexExpression(node);
        }

        protected override void VisitTupleElementAccessExpression(BoundTupleElementAccessExpression node)
        {
            this.AddIfNeeded(node.Receiver);
            base.VisitTupleElementAccessExpression(node);
        }

        protected override void VisitClrMethodGroupExpression(BoundClrMethodGroupExpression node)
        {
            if (node.Receiver != null)
            {
                this.AddIfNeeded(node.Receiver);
            }

            base.VisitClrMethodGroupExpression(node);
        }

        private void AddIfNeeded(BoundExpression receiver)
        {
            if (this.needsRvalueReceiverSpill(receiver, this.function, this.locals))
            {
                this.sink.Add(receiver);
            }
        }
    }

    private sealed class MapIndexReadCollector : BoundTreeWalker
    {
        private readonly List<BoundIndexExpression> sink;

        public MapIndexReadCollector(List<BoundIndexExpression> sink)
        {
            this.sink = sink;
        }

        protected override void VisitIndexExpression(BoundIndexExpression node)
        {
            if (node.Target.Type is MapTypeSymbol)
            {
                this.sink.Add(node);
            }

            base.VisitIndexExpression(node);
        }
    }

    // Issue #418 (P1-1): collects every index-assignment expression so the body
    // emitter can pre-allocate a scratch slot of the value's type. The emit sites
    // use a dup + stloc tmp + store + ldloc tmp pattern to avoid re-evaluating
    // the index/argument expressions when producing the assignment's result.
    private sealed class IndexAssignmentValueSpillCollector : BoundTreeWalker
    {
        private readonly List<BoundExpression> sink;

        public IndexAssignmentValueSpillCollector(List<BoundExpression> sink)
        {
            this.sink = sink;
        }

        protected override void VisitIndexAssignmentExpression(BoundIndexAssignmentExpression node)
        {
            this.sink.Add(node);
            base.VisitIndexAssignmentExpression(node);
        }

        protected override void VisitClrIndexAssignmentExpression(BoundClrIndexAssignmentExpression node)
        {
            this.sink.Add(node);
            base.VisitClrIndexAssignmentExpression(node);
        }
    }

    // Issue #418 (P1-2): walker that collects every BoundPropertyAssignment /
    // BoundClrPropertyAssignment expression so the slot allocator can give
    // each one a value-temp local for the dup/stloc spill described in
    // CollectAssignmentValueSpills.
    private sealed class AssignmentValueSpillCollector : BoundTreeWalker
    {
        private readonly List<BoundExpression> sink;

        public AssignmentValueSpillCollector(List<BoundExpression> sink)
        {
            this.sink = sink;
        }

        protected override void VisitPropertyAssignmentExpression(BoundPropertyAssignmentExpression node)
        {
            this.sink.Add(node);
            base.VisitPropertyAssignmentExpression(node);
        }

        protected override void VisitClrPropertyAssignmentExpression(BoundClrPropertyAssignmentExpression node)
        {
            this.sink.Add(node);
            base.VisitClrPropertyAssignmentExpression(node);
        }

        // ADR-0060 / issue #491: assignments to ref-kind parameters or to
        // ref-aliasing locals lower to `<addr>; value; dup; stloc tmp; stind`.
        // To preserve the assignment-as-expression result semantics without
        // a re-read, the emitter spills the value to a temp local.
        protected override void VisitAssignmentExpression(BoundAssignmentExpression node)
        {
            if (node.Variable is ParameterSymbol ps && ps.RefKind != RefKind.None)
            {
                this.sink.Add(node);
            }
            else if (node.Variable is LocalVariableSymbol lvs && lvs.RefKind != RefKind.None)
            {
                this.sink.Add(node);
            }

            base.VisitAssignmentExpression(node);
        }

        // ADR-0060: an explicit `*p = v` indirect-assignment expression spills
        // its value to a temp for the same reason.
        protected override void VisitIndirectAssignmentExpression(BoundIndirectAssignmentExpression node)
        {
            this.sink.Add(node);
            base.VisitIndirectAssignmentExpression(node);
        }
    }

    // Issue #504: walks the bound tree collecting every `BoundUnaryExpression`
    // whose operator is `NullAssertion` (`!!`) and whose operand is a
    // value-type `Nullable<T>`. Each such site needs a `Nullable<T>`-typed
    // temp slot so the emitter can spill the operand and call
    // `Nullable<T>::get_Value` (which yields the underlying `T` or throws
    // `InvalidOperationException`). The reference-type `!!` path uses the
    // existing `dup; brtrue; throw NRE` pattern and needs no slot.
    private sealed class NullableValueTypeUnwrapCollector : BoundTreeWalker
    {
        private readonly List<BoundUnaryExpression> sink;

        public NullableValueTypeUnwrapCollector(List<BoundUnaryExpression> sink)
        {
            this.sink = sink;
        }

        protected override void VisitUnaryExpression(BoundUnaryExpression node)
        {
            if (node.Op.Kind == BoundUnaryOperatorKind.NullAssertion
                && node.Operand.Type is NullableTypeSymbol n
                && n.UnderlyingType?.ClrType is { IsValueType: true })
            {
                this.sink.Add(node);
            }

            base.VisitUnaryExpression(node);
        }
    }

    // Issue #519: walks the bound tree collecting every `BoundBinaryExpression`
    // whose operator is `NullCoalesce` (`?:`) and whose LHS is a value-type
    // `Nullable<T>`. Each such site needs a `Nullable<T>`-typed temp slot so
    // the emitter can spill the LHS once, call `Nullable<T>::get_HasValue`
    // off the slot's address, and either reload the slot (when the result
    // type is `Nullable<T>`) or call `Nullable<T>::get_Value` off the slot's
    // address (when the result type is the underlying `T`). The reference-
    // type `?:` path uses the existing `dup; brtrue; pop; rhs` pattern and
    // needs no slot.
    private sealed class NullableValueTypeCoalesceCollector : BoundTreeWalker
    {
        private readonly List<BoundBinaryExpression> sink;

        public NullableValueTypeCoalesceCollector(List<BoundBinaryExpression> sink)
        {
            this.sink = sink;
        }

        protected override void VisitBinaryExpression(BoundBinaryExpression node)
        {
            if (node.Op.Kind == BoundBinaryOperatorKind.NullCoalesce
                && node.Left.Type is NullableTypeSymbol n
                && n.UnderlyingType?.ClrType is { IsValueType: true })
            {
                this.sink.Add(node);
            }

            base.VisitBinaryExpression(node);
        }
    }

    // PR N-4 / §6.1 / C# §7.3.7: walks the bound tree collecting every
    // BoundBinaryExpression that is a lifted operator over a value-type
    // Nullable<T>. The emitter needs a fixed set of scratch slots per
    // lifted operator site:
    //   * one Nullable<T>-typed slot for the LHS spill (so the emitter can
    //     take its address for call get_HasValue / get_Value),
    //   * one Nullable<T>-typed slot for the RHS spill (same reason),
    //   * one Nullable<R>-typed slot for the result when the operator
    //     produces Nullable<R> (arithmetic / bitwise). The slot is used to
    //     initobj a default Nullable<R> on the "null" branch and then load
    //     it as a value. The slot is NOT allocated for lifted equality /
    //     ordering, whose result is bool.
    // Mirrors NullableValueTypeCoalesceCollector but yields a richer
    // per-node slot bundle.
    private sealed class LiftedBinaryOperatorCollector : BoundTreeWalker
    {
        private readonly List<BoundBinaryExpression> sink;

        public LiftedBinaryOperatorCollector(List<BoundBinaryExpression> sink)
        {
            this.sink = sink;
        }

        protected override void VisitBinaryExpression(BoundBinaryExpression node)
        {
            if (IsLiftedValueTypeBinary(node))
            {
                this.sink.Add(node);
            }

            base.VisitBinaryExpression(node);
        }

        private static bool IsLiftedValueTypeBinary(BoundBinaryExpression node)
        {
            // Form 1: classic lifted form — both LHS and RHS are
            // value-type Nullable<T> wrapping the same underlying. The
            // lifted binder arm enforces this; the mixed-mode binder
            // lift inserts an implicit `T -> T?` conversion for the
            // non-nullable side before binding the operator.
            //
            // Form 2: `value-type Nullable<T> == nil` / `!= nil` — bound
            // by the IsNullCompare arm with left=Nullable<T>, right=Null.
            // Without slot allocation the bottom of EmitBinary would
            // load the LHS as a struct value and the RHS as `ldnull`
            // and then emit `ceq` — an `InvalidProgramException` at
            // runtime. Treating this as a lifted form lets the emitter
            // spill the LHS once and consult `HasValue`.
            bool leftIsValueNullable = node.Left.Type is NullableTypeSymbol left
                && left.UnderlyingType?.ClrType is { IsValueType: true };
            if (!leftIsValueNullable)
            {
                return false;
            }

            if (node.Right.Type == TypeSymbol.Null)
            {
                return node.Op.Kind is BoundBinaryOperatorKind.Equals
                    or BoundBinaryOperatorKind.NotEquals;
            }

            if (node.Right.Type is not NullableTypeSymbol rightNullable)
            {
                return false;
            }

            // Same-type nullable (e.g. int32? + int32?, enum? | enum?) or
            // heterogeneous nullable for §11.10 enum arithmetic (e.g.
            // enum? + int32?, enum? - enum? → int32?). Both sides must be
            // value-type nullable; heterogeneous pairs are allowed because
            // the EnumOperatorTable permits different-typed operands.
            var leftNullable = (NullableTypeSymbol)node.Left.Type!;
            if (leftNullable != rightNullable
                && !(rightNullable.UnderlyingType?.ClrType is { IsValueType: true }))
            {
                return false;
            }

            // Exclude operators whose value-type Nullable<T> emit is already
            // owned by dedicated collectors (NullCoalesce, NullAssertion).
            switch (node.Op.Kind)
            {
                case BoundBinaryOperatorKind.Sum:
                case BoundBinaryOperatorKind.Difference:
                case BoundBinaryOperatorKind.Product:
                case BoundBinaryOperatorKind.Quotient:
                case BoundBinaryOperatorKind.Remainder:
                case BoundBinaryOperatorKind.BitwiseAnd:
                case BoundBinaryOperatorKind.BitwiseOr:
                case BoundBinaryOperatorKind.BitwiseXor:
                case BoundBinaryOperatorKind.BitClear:
                case BoundBinaryOperatorKind.Equals:
                case BoundBinaryOperatorKind.NotEquals:
                case BoundBinaryOperatorKind.Less:
                case BoundBinaryOperatorKind.LessOrEquals:
                case BoundBinaryOperatorKind.Greater:
                case BoundBinaryOperatorKind.GreaterOrEquals:
                    return true;
                default:
                    return false;
            }
        }
    }
}

/// <summary>
/// PR N-4 / §6.1 / C# §7.3.7: per-<see cref="BoundBinaryExpression"/>
/// bundle of pre-allocated local slot indices that the body emitter
/// consumes when lowering a lifted binary operator over a value-type
/// <c>Nullable&lt;T&gt;</c>. Pre-allocated by <see cref="SlotPlanner"/>'s
/// lifted-binary walker and stored in the per-method
/// <c>liftedBinarySlots</c> dictionary.
/// </summary>
internal sealed class LiftedBinarySlots
{
    public LiftedBinarySlots(int lhsSlot, int rhsSlot, int resultSlot)
    {
        this.LhsSlot = lhsSlot;
        this.RhsSlot = rhsSlot;
        this.ResultSlot = resultSlot;
    }

    /// <summary>Gets the slot holding the spilled LHS <c>Nullable&lt;T&gt;</c>.</summary>
    public int LhsSlot { get; }

    /// <summary>Gets the slot holding the spilled RHS <c>Nullable&lt;T&gt;</c>.</summary>
    public int RhsSlot { get; }

    /// <summary>
    /// Gets the slot holding the result <c>Nullable&lt;R&gt;</c>, or <c>-1</c>
    /// when the lifted operator returns <c>bool</c> (equality / ordering).
    /// </summary>
    public int ResultSlot { get; }
}

/// <summary>
/// Per-<see cref="BoundSelectStatement"/> bundle of pre-allocated local
/// slot indices that the body emitter consumes when lowering a
/// <c>select</c> statement. Pre-allocated by
/// <see cref="SlotPlanner"/>'s pattern-switch walker and stored in the
/// per-method <c>selectStatementSlots</c> dictionary.
/// </summary>
internal sealed class SelectSlots
{
    public SelectSlots(
        int[] channelSlots,
        int[] valueSlots,
        int[] outSlots,
        int tasksSlot,
        int waitValueTaskSlot,
        int whenAnyTaskSlot,
        int whenAnyAwaiterSlot,
        int completedTaskSlot)
    {
        this.ChannelSlots = channelSlots;
        this.ValueSlots = valueSlots;
        this.OutSlots = outSlots;
        this.TasksSlot = tasksSlot;
        this.WaitValueTaskSlot = waitValueTaskSlot;
        this.WhenAnyTaskSlot = whenAnyTaskSlot;
        this.WhenAnyAwaiterSlot = whenAnyAwaiterSlot;
        this.CompletedTaskSlot = completedTaskSlot;
    }

    public int[] ChannelSlots { get; }

    public int[] ValueSlots { get; }

    public int[] OutSlots { get; }

    public int TasksSlot { get; }

    public int WaitValueTaskSlot { get; }

    public int WhenAnyTaskSlot { get; }

    public int WhenAnyAwaiterSlot { get; }

    public int CompletedTaskSlot { get; }
}
