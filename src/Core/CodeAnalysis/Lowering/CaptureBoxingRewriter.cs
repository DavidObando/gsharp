// <copyright file="CaptureBoxingRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>
/// Issue #523: a function literal that captures a value-type local of its
/// enclosing scope must observe subsequent writes to that local — both Go
/// and C# capture closures over the variable cell, not its value at
/// construction time. The historical emit pipeline snapshotted captured
/// values into closure-class fields, so an outer reassignment was
/// invisible to the lambda.
/// </summary>
/// <remarks>
/// <para>
/// This pass hoists every captured local / captured parameter into a
/// synthesized single-field reference class (<c>&lt;&gt;__Box_&lt;name&gt;_&lt;n&gt;</c>),
/// inserts the allocation at the local's declaration site (or at function
/// entry for captured parameters), and rewrites every read and write of
/// the captured variable — including reads/writes inside the lambda body
/// — to go through the shared box.
/// </para>
/// <para>
/// Because the box is a reference type, the lambda's existing
/// snapshot-by-value emit (which copies the captured variable into the
/// closure class's field at <c>newobj</c> time) now copies a *reference*
/// to the box. The outer scope and every lambda that captures the
/// variable therefore share the same cell. Multiple lambdas in the same
/// scope share state automatically; nested lambdas continue to work via
/// the existing transitive-capture propagation
/// (<c>CapturedVariableCollector.RewriteFunctionLiteralExpression</c>).
/// </para>
/// <para>
/// Globals (<see cref="GlobalVariableSymbol"/>) are excluded as a side
/// fix: they are already addressable as static fields, so capturing them
/// into a closure field would just re-introduce the snapshot bug; the
/// pass instead rewrites the lambda's capture list to omit them, leaving
/// the lambda body to read the static field directly at every use.
/// </para>
/// <para>
/// For-range key/value variables are intentionally not boxed: the
/// existing snapshot emit happens to match C#'s
/// per-iteration-fresh-variable semantics for <c>foreach</c>, so leaving
/// them alone is both correct and cheaper.
/// </para>
/// </remarks>
internal static class CaptureBoxingRewriter
{
    /// <summary>
    /// Lowers captured-variable semantics in <paramref name="program"/> so
    /// that captures of locals/parameters share a heap cell with the
    /// outer scope. Returns the original instance unchanged when no
    /// function body required boxing.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Invariant (issue #567):</b> every lambda whose body is rewritten
    /// inside an outer function's tree must also have its
    /// <c>program.Functions[lambdaSymbol]</c> entry updated. The emitter
    /// looks lambdas up by <see cref="FunctionSymbol"/> key; if the entry
    /// still points to the original un-rewritten body, the emitter trips on
    /// unresolved variable references. The propagation pass after the main
    /// foreach loop closes this gap by overwriting stale entries with the
    /// rewritten lambda bodies collected during the outer function's rewrite.
    /// </para>
    /// </remarks>
    /// <param name="program">The bound program to lower.</param>
    /// <returns>The lowered program (or the original when nothing changed).</returns>
    public static BoundProgram Lower(BoundProgram program)
    {
        var counter = 0;
        var newStructs = new List<StructSymbol>();
        var newFunctions = ImmutableDictionary.CreateBuilder<FunctionSymbol, BoundBlockStatement>();
        var changed = false;
        var allLambdaUpdates = new Dictionary<FunctionSymbol, BoundBlockStatement>();

        foreach (var pair in program.Functions)
        {
            var (newBody, lambdaUpdates) = RewriteFunctionBody(pair.Key, pair.Value, program, newStructs, ref counter);
            newFunctions[pair.Key] = newBody;
            if (!ReferenceEquals(newBody, pair.Value))
            {
                changed = true;
            }

            foreach (var kv in lambdaUpdates)
            {
                allLambdaUpdates[kv.Key] = kv.Value;
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
        foreach (var (lambdaSymbol, rewrittenBody) in allLambdaUpdates)
        {
            if (newFunctions.ContainsKey(lambdaSymbol))
            {
                newFunctions[lambdaSymbol] = rewrittenBody;
                changed = true;
            }
        }

        if (!changed)
        {
            return program;
        }

        var combinedStructs = program.Structs.AddRange(newStructs);

        var result = new BoundProgram(
            program.EntryPointPackage,
            program.Packages,
            program.Diagnostics,
            newFunctions.ToImmutable(),
            program.EntryPoint,
            program.Statement,
            combinedStructs,
            program.Interfaces,
            program.Enums,
            program.Globals,
            program.Delegates)
        {
            Imports = program.Imports,
            FriendAssemblies = program.FriendAssemblies,
        };

        return result;
    }

    private static (BoundBlockStatement Body, Dictionary<FunctionSymbol, BoundBlockStatement> LambdaUpdates)
        RewriteFunctionBody(
        FunctionSymbol function,
        BoundBlockStatement body,
        BoundProgram program,
        List<StructSymbol> newStructs,
        ref int counter)
    {
        var emptyUpdates = new Dictionary<FunctionSymbol, BoundBlockStatement>();

        // Step 1: collect every captured variable touched by any function
        // literal in this body (transitively). This is the union over all
        // BoundFunctionLiteralExpression.CapturedVariables reachable from
        // this body, minus the literals' own parameters and locals — which
        // the binder's CapturedVariableCollector has already pruned.
        var capturedSet = new HashSet<VariableSymbol>();
        CaptureWalker.Collect(body, capturedSet);

        if (capturedSet.Count == 0)
        {
            return (body, emptyUpdates);
        }

        // Step 2: classify each captured variable.
        //   - boxable      → hoisted to a Box class; reads/writes rewritten.
        //   - drop-capture → captured set entry removed (globals).
        //   - leave alone  → kept as-is (refs, ref-likes, this).
        var boxInfo = new Dictionary<VariableSymbol, BoxedVariable>();
        var dropFromCapture = new HashSet<VariableSymbol>();
        var packageName = function.Package?.Name ?? program.PackageName ?? string.Empty;

        foreach (var variable in capturedSet)
        {
            if (variable is GlobalVariableSymbol)
            {
                // Globals already live in a static field — capturing them by
                // snapshot is just as wrong as for locals (#523), but the fix
                // is the opposite: the lambda should read the global directly,
                // not via a closure field. Strip the capture so emit treats
                // every reference inside the lambda as a static-field load.
                dropFromCapture.Add(variable);
                continue;
            }

            if (!IsBoxable(variable, function))
            {
                continue;
            }

            counter++;
            var boxClass = CreateBoxClass(variable, counter, packageName);

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
            var origTPs = SynthesizedClosureReifier.CollectOrdered(new[] { variable.Type });
            StructSymbol boxReference = boxClass;
            FieldSymbol fieldSymbol = boxClass.Fields[0];
            if (!origTPs.IsDefaultOrEmpty)
            {
                boxReference = SynthesizedClosureReifier.Reify(boxClass, origTPs);
                fieldSymbol = boxReference.Fields[0];
            }

            // For captured locals: a new LocalVariableSymbol of the box type
            // replaces the original; the binder-emitted slot is reclaimed
            // for the box reference.
            // For captured parameters: the parameter remains in the function
            // signature; a sibling local of the box type is added at entry
            // and its contents are seeded from the parameter once.
            var slotName = variable is ParameterSymbol p
                ? "<>__boxed_" + p.Name
                : variable.Name;
            var boxLocal = new LocalVariableSymbol(slotName, isReadOnly: false, type: boxReference);

            boxInfo[variable] = new BoxedVariable(variable, boxLocal, boxReference, fieldSymbol);
            newStructs.Add(boxClass);
        }

        if (boxInfo.Count == 0 && dropFromCapture.Count == 0)
        {
            return (body, emptyUpdates);
        }

        // Step 3: rewrite the body — locals, reads, writes, and lambdas.
        var rewriter = new BoxingRewriter(boxInfo, dropFromCapture);
        var rewritten = (BoundBlockStatement)rewriter.RewriteStatement(body);

        // Step 4: prepend per-parameter box allocation + seed.
        var paramBoxes = new List<BoxedVariable>();
        foreach (var bi in boxInfo.Values)
        {
            if (bi.Original is ParameterSymbol)
            {
                paramBoxes.Add(bi);
            }
        }

        if (paramBoxes.Count > 0)
        {
            // Keep parameter boxes in source-declaration order for a stable
            // local-signature row layout (Issue #456 determinism).
            paramBoxes.Sort((a, b) => string.CompareOrdinal(a.Original.Name, b.Original.Name));

            var prologue = ImmutableArray.CreateBuilder<BoundStatement>((paramBoxes.Count * 2) + rewritten.Statements.Length);
            foreach (var bi in paramBoxes)
            {
                prologue.Add(new BoundVariableDeclaration(
                    null,
                    bi.BoxLocal,
                    new BoundConstructorCallExpression(
                        null,
                        bi.BoxClass,
                        ImmutableArray<BoundExpression>.Empty)));
                prologue.Add(new BoundExpressionStatement(
                    null,
                    new BoundFieldAssignmentExpression(
                        null,
                        bi.BoxLocal,
                        bi.BoxClass,
                        bi.BoxField,
                        new BoundVariableExpression(null, bi.Original))));
            }

            prologue.AddRange(rewritten.Statements);
            rewritten = new BoundBlockStatement(null, prologue.ToImmutable());
        }

        return (rewritten, rewriter.RewrittenLambdaBodies);
    }

    private static bool IsBoxable(VariableSymbol variable, FunctionSymbol function)
    {
        // Only locals and parameters (parameters are LocalVariableSymbols).
        if (variable is not LocalVariableSymbol local)
        {
            return false;
        }

        // The synthesized `this` parameter for instance methods is a stable
        // reference and never reassigned; snapshotting it is fine.
        if (variable == function.ThisParameter)
        {
            return false;
        }

        // ADR-0060 / issue #491: ref-aliasing locals carry a managed pointer
        // in their slot; boxing would break the aliasing semantics.
        if (local.RefKind != RefKind.None)
        {
            return false;
        }

        // ADR-0058 / issue #376: managed pointer (T&) — binder rejects capture
        // already, but guard against future paths.
        if (local.Type is ByRefTypeSymbol)
        {
            return false;
        }

        // Issue #367: by-ref-like types cannot be boxed.
        if (TypeSymbol.IsByRefLike(local.Type))
        {
            return false;
        }

        // Parameters are boxable only when they belong to *this* function:
        // a captured parameter from an enclosing function is the responsibility
        // of that outer pass.
        if (local is ParameterSymbol parameter && !function.Parameters.Contains(parameter))
        {
            return false;
        }

        return true;
    }

    private static StructSymbol CreateBoxClass(VariableSymbol variable, int counter, string packageName)
    {
        var valueField = new FieldSymbol("Value", variable.Type, Accessibility.Public);
        var name = "<>__Box_" + variable.Name + "_" + counter.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return new StructSymbol(
            name,
            ImmutableArray.Create(valueField),
            Accessibility.Internal,
            declaration: null,
            packageName: packageName,
            isData: false,
            isInline: false,
            isClass: true);
    }

    private sealed class BoxedVariable
    {
        public BoxedVariable(VariableSymbol original, LocalVariableSymbol boxLocal, StructSymbol boxClass, FieldSymbol boxField)
        {
            Original = original;
            BoxLocal = boxLocal;
            BoxClass = boxClass;
            BoxField = boxField;
        }

        public VariableSymbol Original { get; }

        public LocalVariableSymbol BoxLocal { get; }

        public StructSymbol BoxClass { get; }

        public FieldSymbol BoxField { get; }
    }

    /// <summary>
    /// Issue #1453: finds captured locals that are introduced (rather than
    /// declared) by an <c>out</c>/<c>ref</c> address-of within a single
    /// statement — i.e. inline <c>out var x</c> captures that have no
    /// <see cref="BoundVariableDeclaration"/>. The scan is shallow: it stops at
    /// nested <see cref="BoundBlockStatement"/>s (those are handled when the
    /// rewriter recurses into them, so a loop body gets a fresh box) and at
    /// function literals (already opaque to <see cref="BoundTreeWalker"/>).
    /// </summary>
    private sealed class OutVarBoxIntroductionScanner : BoundTreeWalker
    {
        private readonly Dictionary<VariableSymbol, BoxedVariable> boxInfo;
        private readonly HashSet<VariableSymbol> allocated;
        private readonly List<BoxedVariable> found = new List<BoxedVariable>();
        private readonly HashSet<VariableSymbol> foundSet = new HashSet<VariableSymbol>();

        private OutVarBoxIntroductionScanner(
            Dictionary<VariableSymbol, BoxedVariable> boxInfo,
            HashSet<VariableSymbol> allocated)
        {
            this.boxInfo = boxInfo;
            this.allocated = allocated;
        }

        public static List<BoxedVariable> Scan(
            BoundStatement statement,
            Dictionary<VariableSymbol, BoxedVariable> boxInfo,
            HashSet<VariableSymbol> allocated)
        {
            var scanner = new OutVarBoxIntroductionScanner(boxInfo, allocated);
            scanner.VisitStatement(statement);
            return scanner.found;
        }

        /// <inheritdoc/>
        protected override void VisitBlockStatement(BoundBlockStatement node)
        {
            // Stop: a nested block introduces its own scope. Its out-var boxes
            // are allocated when the rewriter recurses into that block, keeping
            // loop-body captures fresh per iteration.
        }

        /// <inheritdoc/>
        protected override void VisitAddressOfExpression(BoundAddressOfExpression node)
        {
            if (node.Operand is BoundVariableExpression bve
                && this.boxInfo.TryGetValue(bve.Variable, out var bi)
                && bi.Original is not ParameterSymbol
                && !this.allocated.Contains(bve.Variable)
                && this.foundSet.Add(bve.Variable))
            {
                this.found.Add(bi);
            }

            base.VisitAddressOfExpression(node);
        }
    }

    private sealed class CaptureWalker : BoundTreeRewriter
    {
        private readonly HashSet<VariableSymbol> sink;

        private CaptureWalker(HashSet<VariableSymbol> sink)
        {
            this.sink = sink;
        }

        public static void Collect(BoundStatement root, HashSet<VariableSymbol> sink)
        {
            new CaptureWalker(sink).RewriteStatement(root);
        }

        /// <inheritdoc/>
        protected override BoundExpression RewriteFunctionLiteralExpression(BoundFunctionLiteralExpression node)
        {
            foreach (var captured in node.CapturedVariables)
            {
                this.sink.Add(captured);
            }

            // BoundTreeRewriter intentionally treats a function literal as a
            // leaf (the body is a separate lexical scope). Recurse explicitly
            // so nested lambdas-in-lambdas also contribute — defensive: the
            // binder already propagates captures transitively, but this keeps
            // the pass robust against future BoundTree changes.
            this.RewriteStatement(node.Body);
            return node;
        }
    }

    private sealed class BoxingRewriter : BoundTreeRewriter
    {
        private readonly Dictionary<VariableSymbol, BoxedVariable> boxInfo;
        private readonly HashSet<VariableSymbol> dropFromCapture;

        // Issue #1453: boxed local originals whose box has already been
        // allocated (a `new Box()` statement emitted). Ordinary captured
        // locals are allocated at their BoundVariableDeclaration; inline
        // `out var x` captures have no declaration, so RewriteBlockStatement
        // allocates their box at the introducing statement. This set
        // distinguishes the two so out-var boxes are allocated exactly once.
        private readonly HashSet<VariableSymbol> allocated = new HashSet<VariableSymbol>();

        public BoxingRewriter(
            Dictionary<VariableSymbol, BoxedVariable> boxInfo,
            HashSet<VariableSymbol> dropFromCapture)
        {
            this.boxInfo = boxInfo;
            this.dropFromCapture = dropFromCapture;
        }

        /// <summary>
        /// Gets the lambda bodies rewritten during this pass. When the outer function's
        /// body is rewritten, any nested <see cref="BoundFunctionLiteralExpression"/>
        /// whose body changes is recorded here so <see cref="Lower"/> can propagate
        /// the rewritten body back to <c>program.Functions[lambdaSymbol]</c>.
        /// </summary>
        public Dictionary<FunctionSymbol, BoundBlockStatement> RewrittenLambdaBodies { get; }
            = new Dictionary<FunctionSymbol, BoundBlockStatement>();

        /// <inheritdoc/>
        protected override BoundStatement RewriteBlockStatement(BoundBlockStatement node)
        {
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
            ImmutableArray<BoundStatement>.Builder builder = null;

            for (var i = 0; i < node.Statements.Length; i++)
            {
                var oldStatement = node.Statements[i];

                // Find declaration-less captured locals introduced (as an
                // address-of operand) directly within this statement, before it
                // is rewritten into box-field accesses. Mark them allocated up
                // front so recursion into nested scopes does not re-allocate.
                var introduced = OutVarBoxIntroductionScanner.Scan(oldStatement, this.boxInfo, this.allocated);
                foreach (var bi in introduced)
                {
                    this.allocated.Add(bi.Original);
                }

                var newStatement = this.RewriteStatement(oldStatement);

                var changed = introduced.Count > 0 || !ReferenceEquals(newStatement, oldStatement);
                if (changed && builder == null)
                {
                    builder = ImmutableArray.CreateBuilder<BoundStatement>(node.Statements.Length + introduced.Count);
                    for (var j = 0; j < i; j++)
                    {
                        builder.Add(node.Statements[j]);
                    }
                }

                if (builder != null)
                {
                    foreach (var bi in introduced)
                    {
                        builder.Add(new BoundVariableDeclaration(
                            null,
                            bi.BoxLocal,
                            new BoundConstructorCallExpression(
                                null,
                                bi.BoxClass,
                                ImmutableArray<BoundExpression>.Empty)));
                    }

                    builder.Add(newStatement);
                }
            }

            return builder == null ? node : new BoundBlockStatement(null, builder.ToImmutable());
        }

        /// <inheritdoc/>
        protected override BoundExpression RewriteVariableExpression(BoundVariableExpression node)
        {
            if (this.boxInfo.TryGetValue(node.Variable, out var bi))
            {
                return new BoundFieldAccessExpression(
                    null,
                    new BoundVariableExpression(null, bi.BoxLocal),
                    bi.BoxClass,
                    bi.BoxField);
            }

            return node;
        }

        /// <inheritdoc/>
        protected override BoundExpression RewriteAssignmentExpression(BoundAssignmentExpression node)
        {
            if (this.boxInfo.TryGetValue(node.Variable, out var bi))
            {
                var value = this.RewriteExpression(node.Expression);
                return new BoundFieldAssignmentExpression(
                    null,
                    bi.BoxLocal,
                    bi.BoxClass,
                    bi.BoxField,
                    value);
            }

            return base.RewriteAssignmentExpression(node);
        }

        /// <inheritdoc/>
        protected override BoundExpression RewriteFieldAssignmentExpression(BoundFieldAssignmentExpression node)
        {
            // Issue #567: when the receiver of a field assignment is a boxed
            // variable, the original receiver no longer has an IL slot. Rewrite
            // to use an expression-based receiver: `boxLocal.Value` produces
            // the reference to the original object, then the outer field
            // assignment targets the object's field through that expression.
            if (node.Receiver != null && this.boxInfo.TryGetValue(node.Receiver, out var bi))
            {
                var receiverExpr = new BoundFieldAccessExpression(
                    null,
                    new BoundVariableExpression(null, bi.BoxLocal),
                    bi.BoxClass,
                    bi.BoxField);
                var value = this.RewriteExpression(node.Value);
                return BoundFieldAssignmentExpression.WithExpressionReceiver(
                    null,
                    receiverExpr,
                    node.StructType,
                    node.Field,
                    value);
            }

            return base.RewriteFieldAssignmentExpression(node);
        }

        /// <inheritdoc/>
        protected override BoundExpression RewriteIndexAssignmentExpression(BoundIndexAssignmentExpression node)
        {
            // Issue #618: when the target of an index assignment is a boxed
            // variable, the original target no longer has an IL slot. Rewrite
            // to use an expression-based target: `boxLocal.Value` produces
            // the array/slice/map reference, then the outer index assignment
            // targets the element through that expression.
            if (node.Target != null && this.boxInfo.TryGetValue(node.Target, out var bi))
            {
                var targetExpr = new BoundFieldAccessExpression(
                    null,
                    new BoundVariableExpression(null, bi.BoxLocal),
                    bi.BoxClass,
                    bi.BoxField);
                var index = this.RewriteExpression(node.Index);
                var value = this.RewriteExpression(node.Value);
                return BoundIndexAssignmentExpression.WithExpressionTarget(
                    null,
                    targetExpr,
                    index,
                    value,
                    node.Type);
            }

            return base.RewriteIndexAssignmentExpression(node);
        }

        /// <inheritdoc/>
        protected override BoundExpression RewriteClrIndexAssignmentExpression(BoundClrIndexAssignmentExpression node)
        {
            // Issue #618: same pattern for CLR indexer writes (e.g.
            // `dict["key"] = v` on a Dictionary). When the target is boxed,
            // rewrite to use an expression-based target.
            if (node.Target != null && this.boxInfo.TryGetValue(node.Target, out var bi))
            {
                var targetExpr = new BoundFieldAccessExpression(
                    null,
                    new BoundVariableExpression(null, bi.BoxLocal),
                    bi.BoxClass,
                    bi.BoxField);
                ImmutableArray<BoundExpression>.Builder argBuilder = null;
                for (var i = 0; i < node.Arguments.Length; i++)
                {
                    var oldArg = node.Arguments[i];
                    var newArg = this.RewriteExpression(oldArg);
                    if (newArg != oldArg && argBuilder == null)
                    {
                        argBuilder = ImmutableArray.CreateBuilder<BoundExpression>(node.Arguments.Length);
                        for (var j = 0; j < i; j++)
                        {
                            argBuilder.Add(node.Arguments[j]);
                        }
                    }

                    if (argBuilder != null)
                    {
                        argBuilder.Add(newArg);
                    }
                }

                var args = argBuilder?.ToImmutable() ?? node.Arguments;
                var value = this.RewriteExpression(node.Value);
                return BoundClrIndexAssignmentExpression.WithExpressionTarget(
                    null,
                    targetExpr,
                    node.Indexer,
                    args,
                    value,
                    node.Type);
            }

            return base.RewriteClrIndexAssignmentExpression(node);
        }

        /// <inheritdoc/>
        protected override BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
        {
            if (this.boxInfo.TryGetValue(node.Variable, out var bi) && bi.Original == node.Variable)
            {
                // `var n = e` (where n is captured) lowers to:
                //   var <n_slot> = new Box_n()
                //   <n_slot>.Value = e
                // The original `n`'s slot is reclaimed by the new LocalVariableSymbol
                // of type Box_n. Note `Lowerer.Flatten` will inline this nested
                // block into the enclosing block during the post-binding lower pass.
                this.allocated.Add(bi.Original);
                var initializer = this.RewriteExpression(node.Initializer);
                var stmts = ImmutableArray.Create<BoundStatement>(
                    new BoundVariableDeclaration(
                        null,
                        bi.BoxLocal,
                        new BoundConstructorCallExpression(
                            null,
                            bi.BoxClass,
                            ImmutableArray<BoundExpression>.Empty)),
                    new BoundExpressionStatement(
                        null,
                        new BoundFieldAssignmentExpression(
                            null,
                            bi.BoxLocal,
                            bi.BoxClass,
                            bi.BoxField,
                            initializer)));
                return new BoundBlockStatement(null, stmts);
            }

            return base.RewriteVariableDeclaration(node);
        }

        /// <inheritdoc/>
        protected override BoundExpression RewriteFunctionLiteralExpression(BoundFunctionLiteralExpression node)
        {
            // Descend into the lambda's body so reads/writes of captured outer
            // variables become reads/writes through the box. The base
            // BoundTreeRewriter intentionally skips the body (separate
            // lexical scope), so we override and recurse explicitly.
            var newBody = (BoundBlockStatement)this.RewriteStatement(node.Body);

            // Update the lambda's capture list:
            //   - rewrite each boxed variable to its box-local;
            //   - drop globals so the lambda reads them directly via ldsfld.
            var newCaptured = ImmutableArray.CreateBuilder<VariableSymbol>(node.CapturedVariables.Length);
            var anyCaptureChange = false;
            foreach (var cv in node.CapturedVariables)
            {
                if (this.dropFromCapture.Contains(cv))
                {
                    anyCaptureChange = true;
                    continue;
                }

                if (this.boxInfo.TryGetValue(cv, out var bi))
                {
                    newCaptured.Add(bi.BoxLocal);
                    anyCaptureChange = true;
                }
                else
                {
                    newCaptured.Add(cv);
                }
            }

            if (ReferenceEquals(newBody, node.Body) && !anyCaptureChange)
            {
                return node;
            }

            // Track the rewritten body so Lower can propagate it to
            // program.Functions[lambdaSymbol], closing #567.
            if (!ReferenceEquals(newBody, node.Body))
            {
                this.RewrittenLambdaBodies[node.Function] = newBody;
            }

            return new BoundFunctionLiteralExpression(
                node.Syntax,
                node.Function,
                node.FunctionType,
                newBody,
                newCaptured.ToImmutable());
        }
    }
}
