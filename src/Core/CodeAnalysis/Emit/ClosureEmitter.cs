// <copyright file="ClosureEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Closure-environment orchestration and display-class synthesis. Owns
/// the metadata that describes every lambda / <c>go</c> capture environment
/// emitted into the assembly, and owns the rewriter that lowers a captured-
/// variable read inside a lambda body into a <c>this.field</c> access against
/// the synthesized display class.
/// </summary>
/// <remarks>
/// <para>
/// PR-E-9 introduces this component. Per the decomposition plan, the
/// closure-emit surface is split between two host types in the pre-refactor
/// source — exactly as PR-E-5 <see cref="ConversionEmitter"/> handled the
/// conversion-emit surface:
/// </para>
/// <list type="bullet">
/// <item>
/// Stateless, top-level orchestration on <see cref="ReflectionMetadataEmitter"/>
/// (<c>SynthesizeClosures</c>, <c>SynthesizeGoClosures</c>,
/// <c>SynthesizeDisplayClass</c>) plus the nested helper classes
/// (<see cref="ClosureInfo"/>, <see cref="CaptureRewriter"/>,
/// <see cref="ConstructedTypeCollector"/>) and the closure-state caches
/// (<see cref="ClosureInfos"/>, <see cref="GoClosureInfos"/>,
/// <see cref="ClosureInvokeToInfo"/>, <see cref="SynthesizedClosureClasses"/>,
/// <see cref="Counter"/>). <strong>These move here.</strong>
/// </item>
/// <item>
/// Body-emit-internal closure methods inside <c>BodyEmitter</c>
/// (<c>EmitFunctionLiteral</c> [two overloads], <c>EmitMethodGroup</c>,
/// <c>EmitFunctionToDelegateConversion</c>,
/// <c>EmitFunctionToNamedDelegateConversion</c>,
/// <c>EmitFunctionLiteralToNamedDelegate</c>,
/// <c>EmitMethodGroupToNamedDelegate</c>,
/// <c>EmitClrEventSubscription</c>, <c>EmitUserEventSubscription</c>,
/// <c>EmitCapturedVariableLoad</c>)
/// that reference <c>BodyEmitter</c>'s private <c>il</c>, <c>outer</c>,
/// <c>locals</c>, <c>parameters</c>, <c>enclosingClosure</c> fields and
/// call back into <c>EmitExpression</c> / <c>EmitLoadVariable</c> for every
/// captured value and method-group target. <strong>These are deferred to
/// PR-E-11 <c>MethodBodyEmitter</c></strong>, where <c>BodyEmitter</c> is
/// promoted to its own top-level type with its own partials (including
/// <c>MethodBodyEmitter.Closures.cs</c>). Moving them in PR-E-9 would
/// require widening <c>BodyEmitter</c>'s private surface to expose all of
/// those collaborators through an <c>IBodyEmitContext</c> interface, only
/// to take it apart again in PR-E-11. <strong>This is the same Option B
/// playbook PR-E-5 used</strong> for the same reason.
/// </item>
/// </list>
/// <para>
/// <b>Future home of the #567 / #503 unifying fix.</b> The plan calls this
/// PR out as "the structural home for the eventual #567 + #503 unifying
/// fix" — closure-environment emission unified with display-class
/// emission. The fix itself is deferred until PR-E-11 promotes
/// <c>BodyEmitter</c> to <c>MethodBodyEmitter</c>, because the fix needs to
/// span both the synthesis side (here) and the emit-time side
/// (<c>EmitCapturedVariableLoad</c> / <c>EmitFunctionLiteral</c>). Putting
/// the synthesis side in its own type today is the prerequisite that lets
/// PR-E-11 land that cross-cutting fix in one focused diff without
/// rummaging through the root emitter.
/// </para>
/// <para>
/// <b>What stays on <see cref="ReflectionMetadataEmitter"/></b>:
/// </para>
/// <list type="bullet">
/// <item>The <c>lambdaBodies</c> dictionary. It is cross-cutting (populated
/// by closure synthesis here AND by every state-machine synthesizer in
/// E-10), and the root emitter walks it from <c>EmitFunction</c>. Keeping
/// it on the root means E-9 and the future E-10 both write into it via
/// the constructor-injected dictionary reference, and the root keeps its
/// existing read paths unchanged. The plan explicitly nominates this
/// option ("Pick (a) for this PR — it keeps the diff minimal").</item>
/// <item><c>RegisterConstructedTypeAliases</c>. It is a single-use caller
/// of <see cref="ConstructedTypeCollector"/> that walks the root's
/// program-function bodies and lambda bodies and writes into the
/// <see cref="MetadataTokenCache"/>; it is not closure orchestration in
/// its own right. The collector type moves here (it is closure-emit-side
/// per PR-E-4's deferral note); the caller stays.</item>
/// <item>The state-machine synthesizers (<c>SynthesizeIteratorStateMachines</c>,
/// <c>SynthesizeAsyncIteratorStateMachines</c>,
/// <c>SynthesizeAsyncLambdaStateMachines</c>) and their nested classes
/// (<c>IteratorStateMachineInfo</c>, <c>AsyncIteratorEmitContext</c>).
/// These move with PR-E-10 <c>StateMachineEmitter</c>. They share the
/// <see cref="Counter"/> field and append to <see cref="SynthesizedClosureClasses"/>
/// from the root; both are exposed publicly here so the still-on-root SM
/// methods (and, once moved, the future <c>StateMachineEmitter</c>) can
/// mutate them directly.</item>
/// </list>
/// <para>
/// Like every other PR-E-* component, <see cref="ClosureEmitter"/> is
/// <c>internal sealed</c> and constructor-injected. It receives the same
/// <see cref="EmitContext"/>, <see cref="MetadataTokenCache"/>, and
/// <see cref="WellKnownReferences"/> trio as its peers, plus the
/// <see cref="SlotPlanner"/> for <c>go</c>-statement capture discovery
/// and a shared reference to the root's <c>lambdaBodies</c> dictionary so
/// it can register every synthesized closure-Invoke body without taking a
/// hard back-reference to <see cref="ReflectionMetadataEmitter"/>.
/// </para>
/// </remarks>
internal sealed class ClosureEmitter
{
#pragma warning disable SA1401 // field must be private — exposed as a public field (not property) so the still-on-root state-machine synthesizers (and, once moved, the future StateMachineEmitter) can pass it to Interlocked.Increment(ref ...). A property cannot be ref-passed in the same shape the pre-refactor source used.
    /// <summary>
    /// Monotonically increasing counter that disambiguates synthesized
    /// closure / state-machine class names. Public field (not property)
    /// so callers can pass it to <see cref="System.Threading.Interlocked.Increment(ref int)"/>
    /// directly. The root emitter's state-machine synthesizers
    /// (<c>SynthesizeIteratorStateMachines</c>,
    /// <c>SynthesizeAsyncIteratorStateMachines</c>) increment this
    /// counter alongside <see cref="SynthesizeClosures"/> /
    /// <see cref="SynthesizeGoClosures"/> so every synthesized class
    /// gets a globally unique name.
    /// </summary>
    public int Counter;
#pragma warning restore SA1401

#pragma warning disable IDE0052 // unused; reserved for the deferred BodyEmitter-internal moves landing in PR-E-11
    private readonly EmitContext emitCtx;
    private readonly MetadataTokenCache cache;
    private readonly WellKnownReferences wellKnown;
#pragma warning restore IDE0052
    private readonly SlotPlanner slotPlanner;
    private readonly Dictionary<FunctionSymbol, BoundBlockStatement> lambdaBodies;

    public ClosureEmitter(
        EmitContext emitCtx,
        MetadataTokenCache cache,
        WellKnownReferences wellKnown,
        SlotPlanner slotPlanner,
        Dictionary<FunctionSymbol, BoundBlockStatement> lambdaBodies)
    {
        this.emitCtx = emitCtx ?? throw new ArgumentNullException(nameof(emitCtx));
        this.cache = cache ?? throw new ArgumentNullException(nameof(cache));
        this.wellKnown = wellKnown ?? throw new ArgumentNullException(nameof(wellKnown));
        this.slotPlanner = slotPlanner ?? throw new ArgumentNullException(nameof(slotPlanner));
        this.lambdaBodies = lambdaBodies ?? throw new ArgumentNullException(nameof(lambdaBodies));
    }

    /// <summary>
    /// Gets per-lambda closure metadata for every captured-variable function
    /// literal in the program. Populated by <see cref="SynthesizeClosures"/>
    /// and read by both the root emitter (when wiring <c>BodyEmitter</c>'s
    /// <c>enclosingClosure</c>) and by <c>BodyEmitter</c> itself (for the
    /// <c>EmitFunctionLiteral</c> path).
    /// </summary>
    public Dictionary<BoundFunctionLiteralExpression, ClosureInfo> ClosureInfos { get; } = [];

    /// <summary>
    /// Gets per-<c>go</c>-site closure metadata. The display class wraps the
    /// <c>go</c> expression in an <c>InvokeAction</c> method (or
    /// <c>InvokeAsync</c> for async <c>go</c>) that <c>Task.Run</c> can
    /// bind to.
    /// </summary>
    public Dictionary<BoundGoStatement, ClosureInfo> GoClosureInfos { get; } = [];

    /// <summary>
    /// Gets the reverse map from a closure-invoke <see cref="FunctionSymbol"/> to
    /// its <see cref="ClosureInfo"/>. The root emitter reads this when
    /// constructing a <c>BodyEmitter</c> so nested-closure transitive
    /// captures (issue #503 follow-up) route through the enclosing
    /// display class.
    /// </summary>
    public Dictionary<FunctionSymbol, ClosureInfo> ClosureInvokeToInfo { get; } = [];

    /// <summary>
    /// Gets every synthesized aggregate class emitted on behalf of a closure,
    /// <c>go</c> site, or state machine. The root emitter appends these
    /// to the program's user-struct list before TypeDef row planning;
    /// state-machine synthesizers (still on the root, moving with
    /// PR-E-10) also append to this list directly, which is why the
    /// collection is exposed as a mutable <see cref="List{T}"/>.
    /// </summary>
    public List<StructSymbol> SynthesizedClosureClasses { get; } = [];

    // Phase 4 emit parity (E2): for each lambda that captures outer variables,
    // synthesize a sealed closure class on the entry-point package with:
    //   - one public field per captured VariableSymbol (typed identically),
    //   - one instance method (the lambda body, with captured reads/writes
    //     rewritten to this.field reads/writes),
    //   - a default ctor (chains to object::.ctor() via the existing
    //     EmitClassDefaultConstructor path).
    // Capture semantics are snapshot-by-value at literal creation time — the
    // same semantics the interpreter implements (see
    // <c>EvaluateFunctionLiteralExpression</c>): writes inside the lambda
    // update the closure copy only, not the outer variable.
    //
    // Nested-lambda captures (a lambda that captures a variable already
    // captured by an enclosing closure) are not yet supported: detecting them
    // requires another rewrite layer. The synthesis throws a clear
    // NotSupportedException for that case.
    public void SynthesizeClosures(List<BoundFunctionLiteralExpression> literals, PackageSymbol hostPackage)
    {
        foreach (var literal in literals)
        {
            if (literal.CapturedVariables.Length == 0)
            {
                // Issue #1469: a non-capturing lambda is normally hoisted to a
                // static method on the top-level `<Program>` host type. When the
                // lambda is lexically declared inside a member of a user type and
                // reads a `protected`/`private` member (e.g. a positional member
                // of a `protected` nested data class, or a private backing field),
                // the `<Program>`-hosted method is outside that member's
                // accessibility domain — producing an unverifiable `FieldAccess`/
                // `MethodAccess` ("not visible") IL site and a runtime
                // `FieldAccessException`/`MethodAccessException`. C# avoids this by
                // hosting the lambda in a display class nested inside the declaring
                // type, sharing its accessibility domain. Mirror that here by
                // routing the non-capturing lambda through a (fieldless) display
                // class nested in the enclosing user type, exactly as the
                // capture-bearing #1335 path does. Only non-async lambdas whose
                // enclosing type is a non-generic user type are nested; async
                // lambdas are owned by the async state-machine synthesis (which
                // keys off the absence of a ClosureInfo), and generic enclosers
                // are skipped because a nested type would have to re-declare the
                // encloser's type parameters, which this synthesis does not model.
                // All other non-capturing lambdas keep the existing top-level
                // `<Program>` static placement.
                if (literal.Function == null
                    || literal.Function.IsAsync
                    || literal.Function.LexicalEnclosingType is not StructSymbol zeroCaptureEnclosing
                    || !zeroCaptureEnclosing.TypeParameters.IsDefaultOrEmpty)
                {
                    continue;
                }

                var hostName = "<lambda_host_" + literal.Function.Name + "_" + System.Threading.Interlocked.Increment(ref this.Counter).ToString(System.Globalization.CultureInfo.InvariantCulture) + ">";
                var hostInfo = this.SynthesizeDisplayClass(
                    hostName,
                    ImmutableArray<VariableSymbol>.Empty,
                    literal.Function.Parameters,
                    literal.Function.Type,
                    literal.Body,
                    hostPackage,
                    invokeName: "Invoke");

                this.ClosureInfos[literal] = hostInfo;

                if (hostInfo.ClassSym.ContainingType == null)
                {
                    hostInfo.ClassSym.SetContainingType(zeroCaptureEnclosing);
                }

                continue;
            }

            var closureName = "<closure_" + literal.Function.Name + "_" + System.Threading.Interlocked.Increment(ref this.Counter).ToString(System.Globalization.CultureInfo.InvariantCulture) + ">";
            var info = this.SynthesizeDisplayClass(
                closureName,
                literal.CapturedVariables,
                literal.Function.Parameters,
                literal.Function.Type,
                literal.Body,
                hostPackage,
                invokeName: "Invoke");

            this.ClosureInfos[literal] = info;

            // Issue #1335: a closure declared inside a member of a user type must
            // be able to reach that type's `protected`/`private` members (matching
            // C#, which nests display classes inside the containing type). Emitting
            // the closure as a CLR type nested in the enclosing user type grants it
            // the CLR nested-type access to the encloser's family/private members
            // (and the encloser's inherited protected members). Without nesting the
            // synthesized Invoke method triggers MethodAccessException/
            // FieldAccessException at runtime. Generic enclosing types are skipped:
            // a nested type would have to re-declare the encloser's type parameters,
            // which the closure synthesis does not model, and the public-member case
            // those closures already handle does not need nesting.
            if (literal.Function?.LexicalEnclosingType is StructSymbol enclosing
                && enclosing.TypeParameters.IsDefaultOrEmpty
                && info.ClassSym.ContainingType == null)
            {
                info.ClassSym.SetContainingType(enclosing);
            }
        }
    }

    public void SynthesizeGoClosures(List<BoundGoStatement> goStatements, PackageSymbol hostPackage)
    {
        foreach (var go in goStatements)
        {
            var captured = this.slotPlanner.CollectCapturedVariables(go.Expression);

            // When the go target is async (returns Task/Task<T>), the closure must
            // return Task so that Task.Run(Func<Task>) properly awaits completion.
            // Detection must be robust across assembly-load contexts: when the
            // compilation is cross-targeting (explicit /reference paths loaded
            // through a MetadataLoadContext), go.Expression.Type.ClrType is a
            // reference-pack Type whose identity differs from the gsc host's
            // System.Threading.Tasks.Task, so typeof(Task).IsAssignableFrom(...)
            // returns false. That mis-detection emits an Action thunk that
            // discards the spawned Task — breaking structured scope-join and
            // producing invalid IL when the async target captures arguments.
            // Compare by metadata name across the base-type chain instead.
            var isAsync = IsTaskClrType(go.Expression.Type?.ClrType);
            var returnType = isAsync ? TypeSymbol.FromClrType(typeof(System.Threading.Tasks.Task)) : TypeSymbol.Void;
            BoundStatement bodyStatement = isAsync
                ? new BoundReturnStatement(null, go.Expression)
                : new BoundExpressionStatement(null, go.Expression);
            var body = new BoundBlockStatement(null, ImmutableArray.Create(bodyStatement));

            var closureName = "<go_" + System.Threading.Interlocked.Increment(ref this.Counter).ToString(System.Globalization.CultureInfo.InvariantCulture) + ">";
            var info = this.SynthesizeDisplayClass(
                closureName,
                captured,
                ImmutableArray<ParameterSymbol>.Empty,
                returnType,
                body,
                hostPackage,
                invokeName: "InvokeAction");

            this.GoClosureInfos[go] = info;
        }
    }

    public ClosureInfo SynthesizeDisplayClass(
        string closureName,
        ImmutableArray<VariableSymbol> capturedVariables,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol returnType,
        BoundBlockStatement body,
        PackageSymbol hostPackage,
        string invokeName)
    {
        var packageName = hostPackage?.Name ?? string.Empty;
        var fieldBuilder = ImmutableArray.CreateBuilder<FieldSymbol>(capturedVariables.Length);
        var captureFields = new Dictionary<VariableSymbol, FieldSymbol>();
        foreach (var captured in capturedVariables)
        {
            var field = new FieldSymbol(captured.Name, captured.Type, Accessibility.Public);
            fieldBuilder.Add(field);
            captureFields[captured] = field;
        }

        var closureClass = new StructSymbol(
            name: closureName,
            fields: fieldBuilder.MoveToImmutable(),
            accessibility: Accessibility.Internal,
            declaration: null,
            packageName: packageName,
            isData: false,
            isInline: false,
            isClass: true);

        var invokeMethod = new FunctionSymbol(
            name: invokeName,
            parameters: parameters,
            type: returnType,
            declaration: null,
            package: hostPackage,
            accessibility: Accessibility.Public,
            receiverType: (TypeSymbol)closureClass);

        closureClass.SetMethods(ImmutableArray.Create(invokeMethod));

        // Issue #1477: when the lambda is declared inside a generic type (or
        // generic method) and captures a value whose type references an
        // enclosing type parameter (a `T`-typed value, `this` of `G[T]`, or a
        // boxed `Box[T]`), the display class must itself be generic over those
        // parameters — otherwise each capture field's `VAR` slot has no generic
        // parameter in scope, producing an illegal field type (TypeLoadException
        // at load) and unverifiable IL (`StackUnexpected`/`DelegateCtor`) at the
        // capture site. Reify the display class generic over exactly the
        // referenced enclosing parameters (mirroring the state-machine
        // treatment); the emitter's outer-TP → own-TP remap then routes every
        // field / Invoke signature through a valid `VAR(idx)` slot, and the
        // returned constructed instance carries the original parameters as type
        // arguments for the capture-site `newobj`/field stores/delegate ctor.
        var enclosingRefSink = new List<TypeSymbol>();
        foreach (var captured in capturedVariables)
        {
            enclosingRefSink.Add(captured.Type);
        }

        foreach (var parameter in parameters)
        {
            enclosingRefSink.Add(parameter.Type);
        }

        enclosingRefSink.Add(returnType);
        var origTPs = SynthesizedClosureReifier.CollectOrdered(enclosingRefSink);
        StructSymbol constructedClass = closureClass;
        if (!origTPs.IsDefaultOrEmpty)
        {
            constructedClass = SynthesizedClosureReifier.Reify(closureClass, origTPs);
        }

        var rewriter = new CaptureRewriter(closureClass, captureFields, invokeMethod.ThisParameter);
        var rewrittenBody = (BoundBlockStatement)rewriter.RewriteStatement(body);
        if (rewriter.UnsupportedCapture != null)
        {
            throw new NotSupportedException(
                $"Synthesized closure '{closureName}' captures '{rewriter.UnsupportedCapture.Name}' from a kind ('{rewriter.UnsupportedCaptureKind}') the emitter cannot currently rewrite. Run under the interpreter for now.");
        }

        this.lambdaBodies[invokeMethod] = (BoundBlockStatement)Lowerer.Lower(rewrittenBody);
        this.SynthesizedClosureClasses.Add(closureClass);
        var info = new ClosureInfo(closureClass, invokeMethod, captureFields, constructedClass);
        this.ClosureInvokeToInfo[invokeMethod] = info;
        return info;
    }

    /// <summary>
    /// Determines whether a CLR type is <see cref="System.Threading.Tasks.Task"/>
    /// or <c>Task&lt;T&gt;</c>, comparing by metadata name across the base-type
    /// chain so the result is independent of the assembly-load context the type
    /// originates from. <c>typeof(Task).IsAssignableFrom(t)</c> is unreliable
    /// here because cross-targeting compilations surface types through a
    /// <see cref="System.Reflection.MetadataLoadContext"/>, giving them a
    /// distinct <see cref="Type"/> identity from the gsc host's BCL.
    /// </summary>
    /// <remarks>
    /// Internal-static rather than private so the still-on-<see cref="ReflectionMetadataEmitter"/>
    /// <c>BodyEmitter</c> can use it from its <c>EmitGoStatement</c> path
    /// when shape-deciding whether the spawned closure is a
    /// <c>Func&lt;Task&gt;</c> vs. an <c>Action</c>. Both call sites move
    /// into PR-E-11 <c>MethodBodyEmitter.Closures</c> alongside the rest of
    /// the BodyEmitter-internal closure-emit methods.
    /// </remarks>
    /// <param name="clrType">The CLR type to test (may be <see langword="null"/>).</param>
    /// <returns><see langword="true"/> if <paramref name="clrType"/> is <see cref="System.Threading.Tasks.Task"/> or any subclass thereof (notably <c>Task&lt;T&gt;</c>); otherwise <see langword="false"/>.</returns>
    internal static bool IsTaskClrType(Type clrType)
    {
        for (var t = clrType; t != null; t = t.BaseType)
        {
            if (string.Equals(t.FullName, "System.Threading.Tasks.Task", StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Captured-variable metadata for a single synthesized display class.
    /// Produced by <see cref="SynthesizeDisplayClass"/>; consumed by the
    /// root emitter when wiring <c>BodyEmitter</c> and by
    /// <c>BodyEmitter</c> itself when emitting captured-variable loads.
    /// </summary>
    public sealed class ClosureInfo
    {
        public ClosureInfo(StructSymbol classSym, FunctionSymbol invokeMethod, Dictionary<VariableSymbol, FieldSymbol> captureFields)
            : this(classSym, invokeMethod, captureFields, classSym)
        {
        }

        public ClosureInfo(StructSymbol classSym, FunctionSymbol invokeMethod, Dictionary<VariableSymbol, FieldSymbol> captureFields, StructSymbol constructedClassSym)
        {
            this.ClassSym = classSym;
            this.InvokeMethod = invokeMethod;
            this.CaptureFields = captureFields;
            this.ConstructedClassSym = constructedClassSym;
        }

        public StructSymbol ClassSym { get; }

        /// <summary>
        /// Gets the constructed display-class instance to reference at the
        /// capture site (<c>newobj</c> / field stores / delegate ctor /
        /// <c>ldftn Invoke</c>). Equals <see cref="ClassSym"/> for a non-generic
        /// closure; for a generic-encloser closure it is the open definition
        /// constructed over the enclosing type parameters
        /// (<c>DisplayClass&lt;!0,…&gt;</c>) — issue #1477.
        /// </summary>
        public StructSymbol ConstructedClassSym { get; }

        public FunctionSymbol InvokeMethod { get; }

        public Dictionary<VariableSymbol, FieldSymbol> CaptureFields { get; }
    }

    /// <summary>
    /// Rewrites a lambda body so every captured-variable reference is
    /// retargeted to a <c>this.field</c> access against the synthesized
    /// display class. Run once per closure during
    /// <see cref="SynthesizeDisplayClass"/>; the result is stored as the
    /// Invoke method's lambda body and threaded through the normal
    /// <c>EmitFunction</c> path.
    /// </summary>
    public sealed class CaptureRewriter : BoundTreeRewriter
    {
        private readonly StructSymbol closureClass;
        private readonly Dictionary<VariableSymbol, FieldSymbol> captureFields;
        private readonly ParameterSymbol thisParam;

        public CaptureRewriter(StructSymbol closureClass, Dictionary<VariableSymbol, FieldSymbol> captureFields, ParameterSymbol thisParam)
        {
            this.closureClass = closureClass;
            this.captureFields = captureFields;
            this.thisParam = thisParam;
        }

        // Set when the rewriter encounters a captured variable in a context
        // it cannot lower (e.g., as the target of a BoundIndexAssignmentExpression
        // or other shape that the BoundFieldAssignment node does not model).
        // Reported by SynthesizeClosures as a NotSupportedException.
        public VariableSymbol UnsupportedCapture { get; private set; }

        public string UnsupportedCaptureKind { get; private set; }

        protected override BoundExpression RewriteVariableExpression(BoundVariableExpression node)
        {
            if (this.captureFields.TryGetValue(node.Variable, out var field))
            {
                return new BoundFieldAccessExpression(
                    null,
                    new BoundVariableExpression(null, this.thisParam),
                    this.closureClass,
                    field);
            }

            return node;
        }

        protected override BoundExpression RewriteAssignmentExpression(BoundAssignmentExpression node)
        {
            if (this.captureFields.TryGetValue(node.Variable, out var field))
            {
                var value = this.RewriteExpression(node.Expression);
                return new BoundFieldAssignmentExpression(null, this.thisParam, this.closureClass, field, value);
            }

            return base.RewriteAssignmentExpression(node);
        }

        protected override BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
        {
            // Lambda body declares its own locals — never the captured ones.
            // Still record an "unsupported capture" check in case a captured
            // VariableSymbol re-appears as a declaration shadow (binder bug).
            if (this.captureFields.ContainsKey(node.Variable))
            {
                this.UnsupportedCapture = node.Variable;
                this.UnsupportedCaptureKind = nameof(BoundVariableDeclaration);
            }

            return base.RewriteVariableDeclaration(node);
        }
    }

    /// <summary>
    /// Collects every constructed (non-definition) <see cref="StructSymbol"/>
    /// referenced anywhere in the bound program — function bodies, class
    /// methods, AND lambda bodies. PR-E-4 <see cref="SlotPlanner"/>
    /// explicitly deferred this rewriter to PR-E-9 because it is a
    /// closure-emit-side helper (the lambda-body walk is what makes it
    /// closure-aware) rather than a slot walker. The root emitter's
    /// <c>RegisterConstructedTypeAliases</c> drives this collector to
    /// alias every constructed type into the same TypeDef / ctor / field
    /// rows as its definition.
    /// </summary>
    public sealed class ConstructedTypeCollector : BoundTreeRewriter
    {
        public HashSet<StructSymbol> Constructed { get; } = [];

        protected override BoundExpression RewriteExpression(BoundExpression node)
        {
            this.TryAdd(node.Type);
            switch (node)
            {
                case BoundStructLiteralExpression sl:
                    this.TryAdd(sl.StructType);
                    foreach (var init in sl.Initializers)
                    {
                        this.TryAdd(init.MemberType);
                    }

                    break;
                case BoundFieldAccessExpression fa:
                    this.TryAdd(fa.StructType);
                    this.TryAdd(fa.Field.Type);
                    break;
                case BoundFieldAssignmentExpression fas:
                    this.TryAdd(fas.StructType);
                    this.TryAdd(fas.Field.Type);
                    break;
                case BoundPropertyAccessExpression pa:
                    this.TryAdd(pa.StructType);
                    this.TryAdd(pa.Property.Type);
                    break;
                case BoundPropertyAssignmentExpression pas:
                    this.TryAdd(pas.StructType);
                    this.TryAdd(pas.Property.Type);
                    break;
                case BoundConstructorCallExpression cc:
                    this.TryAdd(cc.StructType);
                    break;
                case BoundVariableExpression ve:
                    this.TryAdd(ve.Variable.Type);
                    break;
            }

            return base.RewriteExpression(node);
        }

        private void TryAdd(TypeSymbol type)
        {
            if (type is StructSymbol s && !s.TypeArguments.IsDefaultOrEmpty)
            {
                this.Constructed.Add(s);
            }
        }
    }
}
