// <copyright file="StateMachineEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1117 // parameters on same line
#pragma warning disable SA1116 // parameters begin on line after declaration
#pragma warning disable SA1124 // do not use regions
#pragma warning disable SA1201 // method should not follow a class (this file mixes a nested helper class inline with methods to mirror the pre-refactor source)
#pragma warning disable SA1202 // public/private ordering — methods are grouped by feature region to mirror the pre-refactor source for byte-identical emit
#pragma warning disable SA1611 // missing parameter documentation — preserved verbatim from the pre-refactor source to keep this PR a pure code-move
#pragma warning disable SA1615 // missing return value documentation — preserved verbatim from the pre-refactor source to keep this PR a pure code-move
#pragma warning disable SA1515 // single-line comments preceded by blank line — preserved verbatim from the pre-refactor source

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
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
/// Async/iterator state-machine synthesis and top-level MoveNext /
/// SetStateMachine / AwaitOnCompleted / async-kickoff IL emission.
/// Owns the state-machine plan inputs, the per-SM class metadata produced
/// by synthesis, and the helpers that build the MoveNextAsync / DisposeAsync /
/// GetAsyncEnumerator / IValueTaskSource&lt;bool&gt; bodies for async iterators.
/// </summary>
/// <remarks>
/// <para>
/// PR-E-10 introduces this component. Per the decomposition plan, the
/// state-machine emit surface is split between two host types in the
/// pre-refactor source — exactly as PR-E-5 <see cref="ConversionEmitter"/>
/// and PR-E-9 <see cref="ClosureEmitter"/> handled their own surfaces:
/// </para>
/// <list type="bullet">
/// <item>
/// Stateless, top-level orchestration / IL-emit on
/// <see cref="ReflectionMetadataEmitter"/>
/// (<c>SynthesizeIteratorStateMachines</c>,
/// <c>SynthesizeAsyncIteratorStateMachines</c>,
/// <c>SynthesizeAsyncLambdaStateMachines</c>, <c>EmitStateMachineMoveNext</c>,
/// <c>EmitStateMachineSetStateMachine</c>, <c>EmitAwaitOnCompletedCall</c>,
/// <c>EmitAsyncKickoffBody</c>) plus the nested helper classes
/// (<see cref="IteratorStateMachineInfo"/>,
/// <see cref="AsyncIteratorEmitContext"/>) and the state-machine caches
/// (<see cref="IteratorKickoffBodies"/>,
/// <see cref="IteratorStateMachineInfos"/>, <see cref="AsyncStateMachinePlans"/>,
/// <see cref="IteratorPlans"/>, <see cref="AsyncIteratorPlans"/>,
/// <see cref="AsyncIteratorInfos"/>, <see cref="AsyncIteratorEmitContexts"/>,
/// <see cref="AsyncSmEnclosingClosures"/>).
/// <strong>These move here.</strong>
/// </item>
/// <item>
/// Body-emit-internal state-machine methods inside <c>BodyEmitter</c>
/// (<c>EmitStateMachineAwaitOnCompleted</c>,
/// <c>EmitAsyncIteratorBuilderMoveNext</c>) that reference
/// <c>BodyEmitter</c>'s private <c>il</c>, <c>locals</c>, <c>parameters</c>,
/// <c>asyncPlan</c>, and <c>asyncIteratorEmitCtx</c> fields and immediately
/// call back into <c>this.outer.stateMachines.EmitAwaitOnCompletedCall</c>
/// for the actual emit. <strong>These are deferred to PR-E-11
/// <c>MethodBodyEmitter</c></strong>, where <c>BodyEmitter</c> is promoted to
/// its own top-level type with its own partials. Moving them in PR-E-10
/// would require widening <c>BodyEmitter</c>'s private surface only to take
/// it apart again one PR later. <strong>This is the same Option B playbook
/// PR-E-5 and PR-E-9 used</strong> for the same reason.
/// </item>
/// </list>
/// <para>
/// <b>What stays on <see cref="ReflectionMetadataEmitter"/></b>:
/// </para>
/// <list type="bullet">
/// <item>The <c>lambdaBodies</c> dictionary. It is cross-cutting — populated
/// by closure synthesis in PR-E-9 <see cref="ClosureEmitter"/> AND by every
/// state-machine synthesizer here — and the root emitter walks it from
/// <c>EmitFunction</c>. Keeping it on the root means
/// <see cref="ClosureEmitter"/> and <see cref="StateMachineEmitter"/> both
/// write into it via the constructor-injected dictionary reference, and the
/// root keeps its existing read paths unchanged. This is the same plan
/// nomination that PR-E-9 followed.</item>
/// <item><c>AddIteratorInterfaceImplementations</c> and
/// <c>AddAsyncIteratorInterfaceImplementations</c>. They are called from
/// the root's <c>EmitCore</c> loop that walks <c>smClasses</c> and adds
/// nested-type rows; they are AddInterfaceImplementation glue, not
/// state-machine synthesis or IL emission. They consume
/// <see cref="IteratorStateMachineInfos"/> /
/// <see cref="AsyncIteratorInfos"/> via this component's public maps.</item>
/// <item>The <c>BodyEmitter</c>-driven part of
/// <c>EmitStateMachineMoveNext</c> is reached via the
/// <see cref="MoveNextBodyResult"/> tuple returned from
/// <c>BuildMoveNextBodyBytes</c> on the root. Same callback pattern PR-E-8
/// <see cref="TypeDefEmitter"/> used for the three constructor body-emit
/// helpers — keeps <see cref="StateMachineEmitter"/> from needing visibility
/// into the still-private <c>BodyEmitter</c> nested class.</item>
/// </list>
/// <para>
/// Like every other PR-E-* component, <see cref="StateMachineEmitter"/> is
/// <c>internal sealed</c> and constructor-injected. It receives the same
/// <see cref="EmitContext"/>, <see cref="MetadataTokenCache"/>, and
/// <see cref="WellKnownReferences"/> trio as its peers, plus the
/// <see cref="ClosureEmitter"/> (for the shared synthesized-class counter
/// and class-list it appends every SM class onto) and a shared reference to
/// the root's <c>lambdaBodies</c> dictionary so synthesis can register the
/// rewritten <c>MoveNext</c> / <c>get_Current</c> / etc. bodies without a
/// hard back-reference to <see cref="ReflectionMetadataEmitter"/>.
/// </para>
/// </remarks>
internal sealed class StateMachineEmitter
{
    private readonly EmitContext emitCtx;
    private readonly MetadataTokenCache cache;
#pragma warning disable IDE0052 // unused; reserved for the deferred BodyEmitter-internal moves landing in PR-E-11
    private readonly WellKnownReferences wellKnown;
#pragma warning restore IDE0052
    private readonly ClosureEmitter closures;
    private readonly Dictionary<FunctionSymbol, BoundBlockStatement> lambdaBodies;

    // Injected delegate callbacks (same composition pattern as PR-E-5..E-9).
    private readonly Func<Type, TypeReferenceHandle> getTypeReference;
    private readonly Func<Type, EntityHandle> getTypeHandleForMember;
    private readonly Func<MethodInfo, EntityHandle> getMethodEntityHandle;
    private readonly Func<MethodInfo, TypeSymbol, EntityHandle> getMethodEntityHandleForContainingType;
    private readonly Func<MethodInfo, MemberReferenceHandle> getMethodReference;
    private readonly Func<ParameterHandle> nextParameterHandle;
    private readonly Action<SignatureTypeEncoder, TypeSymbol> encodeTypeSymbol;
    private readonly Action<SignatureTypeEncoder, Type> encodeClrType;

    // PR-E-8-style callback: drives the still-private BodyEmitter nested class
    // on RME to build the MoveNext body bytes (PDB metadata included). Returns
    // -1 bodyOffset under MetadataOnly.
    private readonly Func<AsyncStateMachinePlan, MoveNextBodyResult> buildMoveNextBodyBytes;

    public StateMachineEmitter(
        EmitContext emitCtx,
        MetadataTokenCache cache,
        WellKnownReferences wellKnown,
        ClosureEmitter closures,
        Dictionary<FunctionSymbol, BoundBlockStatement> lambdaBodies,
        Func<Type, TypeReferenceHandle> getTypeReference,
        Func<Type, EntityHandle> getTypeHandleForMember,
        Func<MethodInfo, EntityHandle> getMethodEntityHandle,
        Func<MethodInfo, TypeSymbol, EntityHandle> getMethodEntityHandleForContainingType,
        Func<MethodInfo, MemberReferenceHandle> getMethodReference,
        Func<ParameterHandle> nextParameterHandle,
        Action<SignatureTypeEncoder, TypeSymbol> encodeTypeSymbol,
        Action<SignatureTypeEncoder, Type> encodeClrType,
        Func<AsyncStateMachinePlan, MoveNextBodyResult> buildMoveNextBodyBytes)
    {
        this.emitCtx = emitCtx ?? throw new ArgumentNullException(nameof(emitCtx));
        this.cache = cache ?? throw new ArgumentNullException(nameof(cache));
        this.wellKnown = wellKnown ?? throw new ArgumentNullException(nameof(wellKnown));
        this.closures = closures ?? throw new ArgumentNullException(nameof(closures));
        this.lambdaBodies = lambdaBodies ?? throw new ArgumentNullException(nameof(lambdaBodies));
        this.getTypeReference = getTypeReference ?? throw new ArgumentNullException(nameof(getTypeReference));
        this.getTypeHandleForMember = getTypeHandleForMember ?? throw new ArgumentNullException(nameof(getTypeHandleForMember));
        this.getMethodEntityHandle = getMethodEntityHandle ?? throw new ArgumentNullException(nameof(getMethodEntityHandle));
        this.getMethodEntityHandleForContainingType = getMethodEntityHandleForContainingType ?? throw new ArgumentNullException(nameof(getMethodEntityHandleForContainingType));
        this.getMethodReference = getMethodReference ?? throw new ArgumentNullException(nameof(getMethodReference));
        this.nextParameterHandle = nextParameterHandle ?? throw new ArgumentNullException(nameof(nextParameterHandle));
        this.encodeTypeSymbol = encodeTypeSymbol ?? throw new ArgumentNullException(nameof(encodeTypeSymbol));
        this.encodeClrType = encodeClrType ?? throw new ArgumentNullException(nameof(encodeClrType));
        this.buildMoveNextBodyBytes = buildMoveNextBodyBytes ?? throw new ArgumentNullException(nameof(buildMoveNextBodyBytes));
    }

    /// <summary>
    /// Gets the per-iterator-function kickoff bodies synthesized by
    /// <see cref="SynthesizeIteratorStateMachines"/> and
    /// <see cref="SynthesizeAsyncIteratorStateMachines"/>. The root emitter's
    /// <c>EmitFunction</c> swaps in this body for the user-authored iterator
    /// function so the kickoff returns a freshly-constructed SM struct.
    /// </summary>
    public Dictionary<FunctionSymbol, BoundBlockStatement> IteratorKickoffBodies { get; } = new Dictionary<FunctionSymbol, BoundBlockStatement>();

    /// <summary>
    /// Gets per-iterator-SM metadata. Populated by
    /// <see cref="SynthesizeIteratorStateMachines"/>; the root reads it when
    /// walking the SM class list to attach <c>IEnumerable&lt;T&gt;</c> /
    /// <c>IEnumerator&lt;T&gt;</c> / <c>IDisposable</c> interface
    /// implementations.
    /// </summary>
    public Dictionary<StructSymbol, IteratorStateMachineInfo> IteratorStateMachineInfos { get; } = new Dictionary<StructSymbol, IteratorStateMachineInfo>();

    /// <summary>
    /// Gets per-async-iterator-SM plan. Populated by
    /// <see cref="SynthesizeAsyncIteratorStateMachines"/>; the root reads it
    /// when walking the SM class list to attach <c>IAsyncEnumerable&lt;T&gt;</c>
    /// / <c>IAsyncEnumerator&lt;T&gt;</c> / <c>IAsyncDisposable</c> /
    /// <c>IValueTaskSource&lt;bool&gt;</c> / <c>IAsyncStateMachine</c> interface
    /// implementations.
    /// </summary>
    public Dictionary<StructSymbol, AsyncIteratorPlan> AsyncIteratorInfos { get; } = new Dictionary<StructSymbol, AsyncIteratorPlan>();

    /// <summary>
    /// Gets per-async-iterator-SM emit-time context (builder field + builder
    /// info). Read by <see cref="EmitAwaitOnCompletedCall"/> and by
    /// <c>BodyEmitter</c> via the root emitter when threading the async
    /// iterator MoveNext path through the await pipeline.
    /// </summary>
    public Dictionary<StructSymbol, AsyncIteratorEmitContext> AsyncIteratorEmitContexts { get; } = new Dictionary<StructSymbol, AsyncIteratorEmitContext>();

    /// <summary>
    /// Gets the map from a capture-bearing async lambda's SM struct to the
    /// closure display class it is nested inside (Subset A of the Roslyn
    /// nesting convention). SM structs NOT in this map nest inside the
    /// per-package <c>&lt;Program&gt;</c> class.
    /// </summary>
    public Dictionary<StructSymbol, StructSymbol> AsyncSmEnclosingClosures { get; } = new Dictionary<StructSymbol, StructSymbol>();

    /// <summary>
    /// Gets or sets the async state-machine plans produced by
    /// <c>AsyncStateMachineRewriter</c>. Assigned from the root emitter's
    /// <c>Emit</c> entry point when an async-rewrite result is supplied.
    /// </summary>
    public ImmutableArray<AsyncStateMachinePlan> AsyncStateMachinePlans { get; internal set; } = ImmutableArray<AsyncStateMachinePlan>.Empty;

    /// <summary>
    /// Gets or sets the iterator state-machine plans produced by
    /// <c>IteratorRewriter</c>. Assigned from the root emitter's <c>Emit</c>
    /// entry point when an iterator-rewrite result is supplied.
    /// </summary>
    public ImmutableArray<IteratorStateMachinePlan> IteratorPlans { get; internal set; } = ImmutableArray<IteratorStateMachinePlan>.Empty;

    /// <summary>
    /// Gets or sets the async iterator state-machine plans produced by
    /// <c>AsyncIteratorRewriter</c>. Assigned from the root emitter's
    /// <c>Emit</c> entry point when an async-iterator-rewrite result is
    /// supplied.
    /// </summary>
    public ImmutableArray<AsyncIteratorPlan> AsyncIteratorPlans { get; internal set; } = ImmutableArray<AsyncIteratorPlan>.Empty;

    public sealed class IteratorStateMachineInfo
    {
        public IteratorStateMachineInfo(IteratorStateMachinePlan plan, StructSymbol classSym)
            : this(plan, classSym, ImmutableArray<TypeParameterSymbol>.Empty, ImmutableArray<TypeParameterSymbol>.Empty)
        {
        }

        public IteratorStateMachineInfo(
            IteratorStateMachinePlan plan,
            StructSymbol classSym,
            ImmutableArray<TypeParameterSymbol> outerMethodTypeParameters,
            ImmutableArray<TypeParameterSymbol> classTypeParameters)
        {
            this.Plan = plan;
            this.ClassSym = classSym;
            this.OuterMethodTypeParameters = outerMethodTypeParameters;
            this.ClassTypeParameters = classTypeParameters;
        }

        public IteratorStateMachinePlan Plan { get; }

        public StructSymbol ClassSym { get; }

        /// <summary>
        /// Gets the OUTER method's type parameters (those declared on
        /// <see cref="IteratorStateMachinePlan.Function"/>) that the
        /// state-machine class is reified over (issue #810). Empty for
        /// non-generic iterators.
        /// </summary>
        public ImmutableArray<TypeParameterSymbol> OuterMethodTypeParameters { get; }

        /// <summary>
        /// Gets the state-machine class's own type parameters (issue #810),
        /// constructed as ordinal-aligned mirrors of
        /// <see cref="OuterMethodTypeParameters"/> with
        /// <see cref="TypeParameterSymbol.IsMethodTypeParameter"/> set to
        /// <see langword="false"/>. Empty for non-generic iterators.
        /// </summary>
        public ImmutableArray<TypeParameterSymbol> ClassTypeParameters { get; }

        /// <summary>
        /// Issue #810: returns the emit-time remap from each outer-method
        /// type parameter to its corresponding class-type-parameter ordinal,
        /// or <see langword="null"/> when this iterator has no type
        /// parameters. Used by
        /// <see cref="ReflectionMetadataEmitter.activeIteratorStateMachineRemap"/>.
        /// </summary>
        public Dictionary<TypeParameterSymbol, int> BuildRemap()
        {
            if (this.OuterMethodTypeParameters.IsDefaultOrEmpty)
            {
                return null;
            }

            var map = new Dictionary<TypeParameterSymbol, int>(this.OuterMethodTypeParameters.Length);
            for (var i = 0; i < this.OuterMethodTypeParameters.Length; i++)
            {
                map[this.OuterMethodTypeParameters[i]] = i;
            }

            return map;
        }
    }

    /// <summary>
    /// Lightweight emit-time context for async iterator MoveNext methods.
    /// Carries the builder field, SM class, and builder info needed by
    /// <see cref="EmitAwaitOnCompletedCall"/>.
    /// </summary>
    public sealed class AsyncIteratorEmitContext
    {
        public AsyncIteratorEmitContext(StructSymbol smClass, FieldSymbol builderField, AsyncMethodBuilderInfo builderInfo)
        {
            this.SmClass = smClass;
            this.BuilderField = builderField;
            this.BuilderInfo = builderInfo;
        }

        public StructSymbol SmClass { get; }

        public FieldSymbol BuilderField { get; }

        public AsyncMethodBuilderInfo BuilderInfo { get; }
    }

    /// <summary>
    /// Tuple result returned by the <c>buildMoveNextBodyBytes</c> callback.
    /// Captures everything <see cref="EmitStateMachineMoveNext"/> needs from
    /// the still-private <c>BodyEmitter</c> nested class on the root: the
    /// raw method-body offset and the PDB metadata (sequence points, locals,
    /// constants, IL size, and the locals signature).
    /// </summary>
    public readonly struct MoveNextBodyResult
    {
        public MoveNextBodyResult(
            int bodyOffset,
            IReadOnlyList<SequencePoint> sequencePoints,
            IReadOnlyList<LocalInfo> locals,
            IReadOnlyList<LocalConstantInfo> constants,
            int codeSize,
            StandaloneSignatureHandle localsSignature)
        {
            this.BodyOffset = bodyOffset;
            this.SequencePoints = sequencePoints;
            this.Locals = locals;
            this.Constants = constants;
            this.CodeSize = codeSize;
            this.LocalsSignature = localsSignature;
        }

        public int BodyOffset { get; }

        public IReadOnlyList<SequencePoint> SequencePoints { get; }

        public IReadOnlyList<LocalInfo> Locals { get; }

        public IReadOnlyList<LocalConstantInfo> Constants { get; }

        public int CodeSize { get; }

        public StandaloneSignatureHandle LocalsSignature { get; }
    }

    #region Iterator state-machine synthesis

    public void SynthesizeIteratorStateMachines(PackageSymbol hostPackage)
    {
        if (this.IteratorPlans.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var plan in this.IteratorPlans)
        {
            // Issue #806: nest each iterator SM under its kickoff function's
            // package (<Program>), not the entry-point/host package. Falling
            // back to the host package only when the function has no package
            // keeps multi-namespace assemblies emitting correct NestedType
            // rows so CLR access checks succeed at runtime.
            var packageName = plan.Function.Package?.Name ?? hostPackage?.Name ?? string.Empty;

            // Issue #810: when the iterator is generic, the synthesized
            // state-machine class must itself be generic over a matching
            // set of class-level type parameters (mirroring Roslyn's
            // `<Empty>d__0<T>`). Build class TPs (`IsMethodTypeParameter=false`,
            // so EncodeTypeSymbol writes them as `Var(idx)`) before the
            // class is materialized — every field/parameter/local that
            // mentions the outer method's TP is then substituted to the
            // class TP via the activeIteratorStateMachineRemap encode-time
            // hook. The class TPs themselves are not used directly in any
            // bound expression — the substitution lives at the encoder.
            var outerMethodTPs = plan.Function.TypeParameters.IsDefaultOrEmpty
                ? ImmutableArray<TypeParameterSymbol>.Empty
                : plan.Function.TypeParameters;
            ImmutableArray<TypeParameterSymbol> classTPs;
            if (outerMethodTPs.IsDefaultOrEmpty)
            {
                classTPs = ImmutableArray<TypeParameterSymbol>.Empty;
            }
            else
            {
                var b = ImmutableArray.CreateBuilder<TypeParameterSymbol>(outerMethodTPs.Length);
                foreach (var outerTP in outerMethodTPs)
                {
                    var classTP = new TypeParameterSymbol(
                        outerTP.Name,
                        outerTP.Ordinal,
                        outerTP.Constraint,
                        outerTP.Variance,
                        outerTP.InterfaceConstraint)
                    {
                        HasReferenceTypeConstraint = outerTP.HasReferenceTypeConstraint,
                        HasValueTypeConstraint = outerTP.HasValueTypeConstraint,
                        HasDefaultConstructorConstraint = outerTP.HasDefaultConstructorConstraint,
                        IsMethodTypeParameter = false,
                    };
                    b.Add(classTP);
                }

                classTPs = b.MoveToImmutable();
            }

            var stateField = new FieldSymbol("<>1__state", TypeSymbol.Int32, Accessibility.Public);
            var currentField = new FieldSymbol("<>2__current", plan.ElementType, Accessibility.Public);
            var initialThreadField = new FieldSymbol("<>l__initialThreadId", TypeSymbol.Int32, Accessibility.Public);
            var fields = ImmutableArray.CreateBuilder<FieldSymbol>();
            fields.Add(stateField);
            fields.Add(currentField);
            fields.Add(initialThreadField);

            var fieldMap = new Dictionary<VariableSymbol, FieldSymbol>();
            var parameterFields = new Dictionary<ParameterSymbol, FieldSymbol>();
            foreach (var parameter in plan.Function.Parameters)
            {
                var field = new FieldSymbol("<>3__" + parameter.Name, parameter.Type, Accessibility.Public);
                fields.Add(field);
                fieldMap[parameter] = field;
                parameterFields[parameter] = field;
            }

            // Issue #641: hoist `this` (the user-class receiver) into a field
            // so the MoveNext body can access instance members of the enclosing
            // class across yield suspension points.
            FieldSymbol thisProxyField = null;
            if (plan.Function.ThisParameter != null && plan.Function.ReceiverType != null)
            {
                thisProxyField = new FieldSymbol("<>4__this", plan.Function.ReceiverType, Accessibility.Public);
                fields.Add(thisProxyField);
                fieldMap[plan.Function.ThisParameter] = thisProxyField;
            }

            var hoistedFields = new Dictionary<VariableSymbol, FieldSymbol>();
            foreach (var local in plan.HoistedLocals)
            {
                if (fieldMap.ContainsKey(local))
                {
                    continue;
                }

                var field = new FieldSymbol("<>5__" + local.Name, local.Type, Accessibility.Public);
                fields.Add(field);
                fieldMap[local] = field;
                hoistedFields[local] = field;
            }

            var smClass = new StructSymbol(
                name: "<" + plan.Function.Name + ">d__" + System.Threading.Interlocked.Increment(ref this.closures.Counter).ToString(System.Globalization.CultureInfo.InvariantCulture),
                fields: fields.ToImmutable(),
                accessibility: Accessibility.Internal,
                declaration: null,
                packageName: packageName,
                isData: false,
                isInline: false,
                isClass: true);

            // Issue #810: stamp the SM class with its class-level type
            // parameters so `EmitNestedStructTypeDef` mangles the name
            // (`<Empty>d__1` → `<Empty>d__1`1`) and emits `GenericParam`
            // rows. Done after construction so the StructSymbol's
            // internal generic flags are flipped without re-running the
            // (cached) `Construct` path.
            if (!classTPs.IsDefaultOrEmpty)
            {
                smClass.SetTypeParameters(classTPs);
            }

            var moveNext = new FunctionSymbol("MoveNext", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Bool, null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);
            var getCurrent = new FunctionSymbol("get_Current", ImmutableArray<ParameterSymbol>.Empty, plan.ElementType, null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);
            var getCurrentObject = new FunctionSymbol("get_Current", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.FromClrType(typeof(object)), null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);

            // Issue #810: when the element type contains an outer-method
            // type parameter, the `IEnumerator<T>` return for GetEnumerator
            // must encode as `IEnumerator<Var(idx)>` (not `IEnumerator<object>`).
            // Build a symbolic `ImportedTypeSymbol` so EncodeTypeSymbol's
            // existing R2 path emits the proper GENERICINST blob; the
            // emit-time remap then translates the outer-method TP to the
            // class's TP. Closed element types continue through the CLR
            // `MakeGenericType` path unchanged.
            var getEnumeratorType = ContainsOuterMethodTypeParameter(plan.ElementType, outerMethodTPs)
                ? (TypeSymbol)ImportedTypeSymbol.GetConstructed(
                    typeof(System.Collections.Generic.IEnumerator<>).MakeGenericType(typeof(object)),
                    typeof(System.Collections.Generic.IEnumerator<>),
                    ImmutableArray.Create<TypeSymbol>(plan.ElementType))
                : TypeSymbol.FromClrType(typeof(System.Collections.Generic.IEnumerator<>).MakeGenericType(plan.ElementType.ClrType ?? typeof(object)));
            var getEnumerator = new FunctionSymbol("GetEnumerator", ImmutableArray<ParameterSymbol>.Empty, getEnumeratorType, null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);
            var getEnumeratorObject = new FunctionSymbol("GetEnumerator", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.FromClrType(typeof(System.Collections.IEnumerator)), null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);
            var dispose = new FunctionSymbol("Dispose", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);
            var reset = new FunctionSymbol("Reset", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);
            smClass.SetMethods(ImmutableArray.Create(moveNext, getCurrent, getCurrentObject, getEnumerator, getEnumeratorObject, dispose, reset));

            var moveNextBody = IteratorMoveNextBodyBuilder.BuildWithFieldAccess(plan, stateField, currentField, moveNext.ThisParameter, smClass, fieldMap).Body;
            this.lambdaBodies[moveNext] = moveNextBody;
            this.lambdaBodies[getCurrent] = Lowerer.Lower(new BoundBlockStatement(null,
                ImmutableArray.Create<BoundStatement>(
                new BoundReturnStatement(null, new BoundFieldAccessExpression(null, new BoundVariableExpression(null, getCurrent.ThisParameter), smClass, currentField)))));
            this.lambdaBodies[getCurrentObject] = Lowerer.Lower(new BoundBlockStatement(null,
                ImmutableArray.Create<BoundStatement>(
                new BoundReturnStatement(null,
                    new BoundConversionExpression(
                    null,
                    TypeSymbol.FromClrType(typeof(object)),
                    new BoundFieldAccessExpression(null, new BoundVariableExpression(null, getCurrentObject.ThisParameter), smClass, currentField))))));
            this.lambdaBodies[dispose] = IteratorMoveNextBodyBuilder.BuildDisposeBody(plan, stateField, dispose.ThisParameter, smClass, fieldMap);
            this.lambdaBodies[reset] = Lowerer.Lower(new BoundBlockStatement(null,
                ImmutableArray.Create<BoundStatement>(
                new BoundExpressionStatement(null, new BoundFieldAssignmentExpression(null, reset.ThisParameter, smClass, stateField, new BoundLiteralExpression(null, -1))),
                new BoundReturnStatement(null, null))));

            // Issue #810: the GetEnumerator and the outer-method kickoff
            // both build a fresh state-machine literal. When the SM is
            // generic, the literal target must be the CONSTRUCTED instance
            // `<Empty>d__1<MVar(0)>` so the emitted `newobj`/`stfld` tokens
            // land on a TypeSpec carrying the right type arguments. The
            // GetEnumerator overloads run on `this` (an instance of the
            // open SM definition, which encodes as a self-instantiation
            // `<Empty>d__1<Var(0)>`); we pass the open `smClass` to the
            // CreateIteratorStateMachineLiteral helper and let the encoder
            // routing decide. The kickoff body lives inside the user's
            // generic method whose type parameters are still active
            // (`MVar(0)`), so we explicitly construct the SM type over the
            // outer method's TPs.
            var kickoffSmType = classTPs.IsDefaultOrEmpty
                ? smClass
                : StructSymbol.Construct(smClass, outerMethodTPs.CastArray<TypeSymbol>());

            this.lambdaBodies[getEnumerator] = Lowerer.Lower(new BoundBlockStatement(null,
                ImmutableArray.Create<BoundStatement>(
                new BoundReturnStatement(null, this.CreateIteratorStateMachineLiteral(smClass, stateField, parameterFields, plan.Function.Parameters, p => new BoundFieldAccessExpression(null, new BoundVariableExpression(null, getEnumerator.ThisParameter), smClass, parameterFields[p]),
                    thisProxyField, thisProxyField != null ? new BoundFieldAccessExpression(null, new BoundVariableExpression(null, getEnumerator.ThisParameter), smClass, thisProxyField) : null)))));
            this.lambdaBodies[getEnumeratorObject] = Lowerer.Lower(new BoundBlockStatement(null,
                ImmutableArray.Create<BoundStatement>(
                new BoundReturnStatement(null, this.CreateIteratorStateMachineLiteral(smClass, stateField, parameterFields, plan.Function.Parameters, p => new BoundFieldAccessExpression(null, new BoundVariableExpression(null, getEnumeratorObject.ThisParameter), smClass, parameterFields[p]),
                    thisProxyField, thisProxyField != null ? new BoundFieldAccessExpression(null, new BoundVariableExpression(null, getEnumeratorObject.ThisParameter), smClass, thisProxyField) : null)))));

            this.IteratorKickoffBodies[plan.Function] = Lowerer.Lower(new BoundBlockStatement(null,
                ImmutableArray.Create<BoundStatement>(
                new BoundReturnStatement(null, this.CreateIteratorStateMachineLiteral(kickoffSmType, stateField, parameterFields, plan.Function.Parameters, p => new BoundVariableExpression(null, p),
                    thisProxyField, plan.Function.ThisParameter != null ? new BoundVariableExpression(null, plan.Function.ThisParameter) : null)))));
            this.IteratorStateMachineInfos[smClass] = new IteratorStateMachineInfo(plan, smClass, outerMethodTPs, classTPs);
            this.closures.SynthesizedClosureClasses.Add(smClass);
        }
    }

    /// <summary>
    /// Issue #810: returns <see langword="true"/> when <paramref name="type"/>
    /// references any of the outer method's type parameters (directly or
    /// nested inside an array/slice/sequence/imported-generic). Used to
    /// decide whether the GetEnumerator return type needs a symbolic
    /// (TypeSpec-encoded) `IEnumerator&lt;T&gt;` instead of the
    /// CLR-erased `IEnumerator&lt;object&gt;` shape.
    /// </summary>
    private static bool ContainsOuterMethodTypeParameter(TypeSymbol type, ImmutableArray<TypeParameterSymbol> outerMethodTPs)
    {
        if (outerMethodTPs.IsDefaultOrEmpty || type == null)
        {
            return false;
        }

        switch (type)
        {
            case TypeParameterSymbol tp:
                foreach (var outer in outerMethodTPs)
                {
                    if (ReferenceEquals(tp, outer))
                    {
                        return true;
                    }
                }

                return false;
            case ArrayTypeSymbol a:
                return ContainsOuterMethodTypeParameter(a.ElementType, outerMethodTPs);
            case SliceTypeSymbol s:
                return ContainsOuterMethodTypeParameter(s.ElementType, outerMethodTPs);
            case SequenceTypeSymbol seq:
                return ContainsOuterMethodTypeParameter(seq.ElementType, outerMethodTPs);
            case AsyncSequenceTypeSymbol aseq:
                return ContainsOuterMethodTypeParameter(aseq.ElementType, outerMethodTPs);
            case NullableTypeSymbol nu:
                return ContainsOuterMethodTypeParameter(nu.UnderlyingType, outerMethodTPs);
            case ImportedTypeSymbol it when !it.TypeArguments.IsDefaultOrEmpty:
                foreach (var arg in it.TypeArguments)
                {
                    if (ContainsOuterMethodTypeParameter(arg, outerMethodTPs))
                    {
                        return true;
                    }
                }

                return false;
            case TupleTypeSymbol tup:
                // Issue #813: a tuple element type that mentions an
                // outer-method TP (e.g. `(int32, T)` from
                // `sequence[(int32, T)]`) must drive the same
                // symbolic-IEnumerator routing as the open-generic
                // sequence cases above, so the SM's GetEnumerator return
                // encodes as `IEnumerator<ValueTuple<int32,!0>>` rather
                // than the type-erased `IEnumerator<object>`.
                foreach (var elem in tup.ElementTypes)
                {
                    if (ContainsOuterMethodTypeParameter(elem, outerMethodTPs))
                    {
                        return true;
                    }
                }

                return false;
            default:
                return false;
        }
    }

    private BoundStructLiteralExpression CreateIteratorStateMachineLiteral(
        StructSymbol smClass,
        FieldSymbol stateField,
        Dictionary<ParameterSymbol, FieldSymbol> parameterFields,
        ImmutableArray<ParameterSymbol> parameters,
        Func<ParameterSymbol, BoundExpression> parameterValueFactory,
        FieldSymbol thisProxyField = null,
        BoundExpression thisProxyValue = null)
    {
        var initializers = ImmutableArray.CreateBuilder<BoundFieldInitializer>();
        initializers.Add(new BoundFieldInitializer(stateField, new BoundLiteralExpression(null, 0)));
        foreach (var parameter in parameters)
        {
            initializers.Add(new BoundFieldInitializer(parameterFields[parameter], parameterValueFactory(parameter)));
        }

        // Issue #641: capture or propagate `this` into <>4__this.
        if (thisProxyField != null && thisProxyValue != null)
        {
            initializers.Add(new BoundFieldInitializer(thisProxyField, thisProxyValue));
        }

        return new BoundStructLiteralExpression(null, smClass, initializers.ToImmutable());
    }

    #endregion

    #region Async iterator state-machine synthesis

    public void SynthesizeAsyncIteratorStateMachines(PackageSymbol hostPackage)
    {
        if (this.AsyncIteratorPlans.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var plan in this.AsyncIteratorPlans)
        {
            // Issue #806: same fix as sync iterators — prefer the kickoff
            // function's package so the SM nests under the correct
            // <Program>.
            var packageName = plan.Function.Package?.Name ?? hostPackage?.Name ?? string.Empty;
            var elementType = plan.ElementType;

            // Fields
            var stateField = new FieldSymbol("<>1__state", TypeSymbol.Int32, Accessibility.Public);
            var currentField = new FieldSymbol("<>2__current", elementType, Accessibility.Public);
            var promiseFieldType = TypeSymbol.FromClrType(typeof(System.Threading.Tasks.Sources.ManualResetValueTaskSourceCore<bool>));
            var promiseField = new FieldSymbol("<>v__promiseOfValueOrEnd", promiseFieldType, Accessibility.Public);
            var disposeModeField = new FieldSymbol("<>w__disposeMode", TypeSymbol.Bool, Accessibility.Public);
            var builderFieldType = TypeSymbol.FromClrType(typeof(System.Runtime.CompilerServices.AsyncIteratorMethodBuilder));
            var builderField = new FieldSymbol("<>t__builder", builderFieldType, Accessibility.Public);

            var fields = ImmutableArray.CreateBuilder<FieldSymbol>();
            fields.Add(stateField);
            fields.Add(currentField);
            fields.Add(promiseField);
            fields.Add(disposeModeField);
            fields.Add(builderField);

            var fieldMap = new Dictionary<VariableSymbol, FieldSymbol>();
            var parameterFields = new Dictionary<ParameterSymbol, FieldSymbol>();
            foreach (var parameter in plan.Function.Parameters)
            {
                var field = new FieldSymbol("<>3__" + parameter.Name, parameter.Type, Accessibility.Public);
                fields.Add(field);
                fieldMap[parameter] = field;
                parameterFields[parameter] = field;
            }

            // Issue #641: hoist `this` (the user-class receiver) into a field
            // so the MoveNext body can access instance members of the enclosing
            // class across yield/await suspension points.
            FieldSymbol thisProxyField = null;
            if (plan.Function.ThisParameter != null && plan.Function.ReceiverType != null)
            {
                thisProxyField = new FieldSymbol("<>4__this", plan.Function.ReceiverType, Accessibility.Public);
                fields.Add(thisProxyField);
                fieldMap[plan.Function.ThisParameter] = thisProxyField;
            }

            foreach (var local in plan.HoistedLocals)
            {
                if (fieldMap.ContainsKey(local))
                {
                    continue;
                }

                var field = new FieldSymbol("<>5__" + local.Name, local.Type, Accessibility.Public);
                fields.Add(field);
                fieldMap[local] = field;
            }

            // Awaiter pool fields
            var awaiterPoolFields = new Dictionary<Type, FieldSymbol>();
            int awaiterOrdinal = 1;
            foreach (var (poolKey, fieldType) in plan.AwaiterTypes)
            {
                var fieldName = "<>u__" + awaiterOrdinal++;
                var field = new FieldSymbol(fieldName, fieldType, Accessibility.Public);
                fields.Add(field);
                awaiterPoolFields[poolKey] = field;
            }

            var smClass = new StructSymbol(
                name: "<" + plan.Function.Name + ">d__" + System.Threading.Interlocked.Increment(ref this.closures.Counter).ToString(System.Globalization.CultureInfo.InvariantCulture),
                fields: fields.ToImmutable(),
                accessibility: Accessibility.Internal,
                declaration: null,
                packageName: packageName,
                isData: false,
                isInline: false,
                isClass: true);

            // Methods: MoveNext, get_Current, MoveNextAsync, DisposeAsync, GetAsyncEnumerator
            var moveNext = new FunctionSymbol("MoveNext", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);
            var getCurrent = new FunctionSymbol("get_Current", ImmutableArray<ParameterSymbol>.Empty, elementType, null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);

            var valueTaskBoolType = TypeSymbol.FromClrType(typeof(System.Threading.Tasks.ValueTask<bool>));
            var moveNextAsync = new FunctionSymbol("MoveNextAsync", ImmutableArray<ParameterSymbol>.Empty, valueTaskBoolType, null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);

            var valueTaskType = TypeSymbol.FromClrType(typeof(System.Threading.Tasks.ValueTask));
            var disposeAsync = new FunctionSymbol("DisposeAsync", ImmutableArray<ParameterSymbol>.Empty, valueTaskType, null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);

            var methods = ImmutableArray.CreateBuilder<FunctionSymbol>();
            methods.Add(moveNext);
            methods.Add(getCurrent);
            methods.Add(moveNextAsync);
            methods.Add(disposeAsync);

            FunctionSymbol getAsyncEnumerator = null;
            if (plan.IsEnumerable)
            {
                var enumeratorType = TypeSymbol.FromClrType(typeof(System.Collections.Generic.IAsyncEnumerator<>).MakeGenericType(elementType.ClrType ?? typeof(object)));
                var ctParam = new ParameterSymbol("cancellationToken", TypeSymbol.FromClrType(typeof(System.Threading.CancellationToken)));
                getAsyncEnumerator = new FunctionSymbol("GetAsyncEnumerator", ImmutableArray.Create(ctParam), enumeratorType, null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);
                methods.Add(getAsyncEnumerator);
            }

            // IValueTaskSource<bool> methods
            var shortType = TypeSymbol.FromClrType(typeof(short));
            var vtsStatusType = TypeSymbol.FromClrType(typeof(System.Threading.Tasks.Sources.ValueTaskSourceStatus));
            var getStatusParam = new ParameterSymbol("token", shortType);
            var getStatus = new FunctionSymbol("GetStatus", ImmutableArray.Create(getStatusParam), vtsStatusType, null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);
            methods.Add(getStatus);

            var getResultParam = new ParameterSymbol("token", shortType);
            var getResult = new FunctionSymbol("GetResult", ImmutableArray.Create(getResultParam), TypeSymbol.Bool, null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);
            methods.Add(getResult);

            var onCompletedParams = ImmutableArray.Create(
                new ParameterSymbol("continuation", TypeSymbol.FromClrType(typeof(Action<object>))),
                new ParameterSymbol("state", TypeSymbol.FromClrType(typeof(object))),
                new ParameterSymbol("token", shortType),
                new ParameterSymbol("flags", TypeSymbol.FromClrType(typeof(System.Threading.Tasks.Sources.ValueTaskSourceOnCompletedFlags))));
            var onCompleted = new FunctionSymbol("OnCompleted", onCompletedParams, TypeSymbol.Void, null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);
            methods.Add(onCompleted);

            // IAsyncStateMachine.SetStateMachine (no-op for class-based SM)
            var setSmParam = new ParameterSymbol("stateMachine", TypeSymbol.FromClrType(typeof(System.Runtime.CompilerServices.IAsyncStateMachine)));
            var setStateMachine = new FunctionSymbol("SetStateMachine", ImmutableArray.Create(setSmParam), TypeSymbol.Void, null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);
            methods.Add(setStateMachine);

            smClass.SetMethods(methods.ToImmutable());

            // Build MoveNext body (handles both yield and await).
            var moveNextBody = AsyncIteratorMoveNextBodyBuilder.Build(
                plan, smClass, moveNext.ThisParameter, stateField, currentField,
                promiseField, disposeModeField, builderField, fieldMap, awaiterPoolFields);
            this.lambdaBodies[moveNext] = Lowerer.Lower(moveNextBody);

            // get_Current: return this.<>2__current;
            this.lambdaBodies[getCurrent] = Lowerer.Lower(new BoundBlockStatement(null,
                ImmutableArray.Create<BoundStatement>(
                new BoundReturnStatement(null, new BoundFieldAccessExpression(null, new BoundVariableExpression(null, getCurrent.ThisParameter), smClass, currentField)))));

            // MoveNextAsync: reset promise, call builder.MoveNext(ref this), return ValueTask<bool>
            // For simplicity: directly set result. The builder calls MoveNext synchronously first;
            // if it suspends, the continuation will complete the promise.
            // Implementation:
            //   if (state == -2) return new ValueTask<bool>(false);
            //   promise.Reset();
            //   builder.MoveNext(ref this);
            //   short version = promise.Version;
            //   return new ValueTask<bool>(this, version);
            // But this requires IValueTaskSource<bool> which we implement.
            // Simpler approach for this slice: call MoveNext directly and check if
            // the promise has a result. Actually the simplest correct approach:
            // Promise-based ValueTask construction requires implementing IValueTaskSource<bool>.
            // For this slice, we'll use a simpler approach: just run MoveNext and construct
            // the ValueTask from the result.
            // Actually the cleanest: use Task.FromResult pattern via the direct promise.
            this.lambdaBodies[moveNextAsync] = this.BuildMoveNextAsyncBody(
                moveNextAsync, smClass, stateField, promiseField, builderField, moveNext);

            // DisposeAsync: set disposeMode = true; call MoveNextAsync-style; return ValueTask
            this.lambdaBodies[disposeAsync] = this.BuildDisposeAsyncBody(
                disposeAsync, smClass, stateField, disposeModeField, promiseField, builderField, moveNext);

            // GetAsyncEnumerator: return this (with state set to -1)
            if (getAsyncEnumerator != null)
            {
                this.lambdaBodies[getAsyncEnumerator] = this.BuildGetAsyncEnumeratorBody(
                    getAsyncEnumerator, smClass, stateField, disposeModeField,
                    plan.Function.Parameters, parameterFields);
            }

            // IValueTaskSource<bool>.GetStatus(short token): return promise.GetStatus(token);
            this.lambdaBodies[getStatus] = this.BuildVtsGetStatusBody(getStatus, smClass, promiseField);

            // IValueTaskSource<bool>.GetResult(short token): return promise.GetResult(token);
            this.lambdaBodies[getResult] = this.BuildVtsGetResultBody(getResult, smClass, promiseField);

            // IValueTaskSource<bool>.OnCompleted(...): promise.OnCompleted(continuation, state, token, flags);
            this.lambdaBodies[onCompleted] = this.BuildVtsOnCompletedBody(onCompleted, smClass, promiseField);

            // IAsyncStateMachine.SetStateMachine: no-op (just return)
            this.lambdaBodies[setStateMachine] = Lowerer.Lower(new BoundBlockStatement(null,
                ImmutableArray.Create<BoundStatement>(
                new BoundReturnStatement(null, null))));

            // Kickoff body: new SM { state = -3, params..., <>4__this = this }
            this.IteratorKickoffBodies[plan.Function] = Lowerer.Lower(new BoundBlockStatement(null,
                ImmutableArray.Create<BoundStatement>(
                new BoundReturnStatement(null, this.CreateAsyncIteratorKickoffLiteral(smClass, stateField, builderField, parameterFields, plan.Function.Parameters, thisProxyField, plan.Function)))));

            this.AsyncIteratorInfos[smClass] = plan;
            this.closures.SynthesizedClosureClasses.Add(smClass);

            // Resolve builder info for async iterator emit context.
            var returnClrType = plan.Function.Type?.ClrType;
            var aiBuilderInfo = AsyncMethodBuilderInfo.Resolve(returnClrType, this.emitCtx.References);
            this.AsyncIteratorEmitContexts[smClass] = new AsyncIteratorEmitContext(smClass, builderField, aiBuilderInfo);
        }
    }

    private BoundBlockStatement BuildMoveNextAsyncBody(
        FunctionSymbol moveNextAsync,
        StructSymbol smClass,
        FieldSymbol stateField,
        FieldSymbol promiseField,
        FieldSymbol builderField,
        FunctionSymbol moveNextMethod)
    {
        var thisParam = moveNextAsync.ThisParameter;
        var stmts = ImmutableArray.CreateBuilder<BoundStatement>();

        // if (state == -2) return default(ValueTask<bool>); // completed
        var finishedLabel = new BoundLabel("<>mna_notFinished");
        stmts.Add(new BoundConditionalGotoStatement(
            null,
            finishedLabel,
            new BoundBinaryExpression(
                null,
                new BoundFieldAccessExpression(null, new BoundVariableExpression(null, thisParam), smClass, stateField),
                BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                new BoundLiteralExpression(null, StateMachineStates.FinishedState)),
            jumpIfTrue: false));

        // Return a completed ValueTask<bool>(false)
        stmts.Add(new BoundReturnStatement(null, new BoundDefaultExpression(null, TypeSymbol.FromClrType(typeof(System.Threading.Tasks.ValueTask<bool>)))));
        stmts.Add(new BoundLabelStatement(null, finishedLabel));

        // promise.Reset();
        var promiseType = typeof(System.Threading.Tasks.Sources.ManualResetValueTaskSourceCore<bool>);
        var resetMethod = promiseType.GetMethod("Reset");
        var promiseAddr = new BoundAddressOfExpression(
            null,
            new BoundFieldAccessExpression(null, new BoundVariableExpression(null, thisParam), smClass, promiseField));
        stmts.Add(new BoundExpressionStatement(null,
            new BoundImportedInstanceCallExpression(
            null,
            promiseAddr, resetMethod, TypeSymbol.Void, ImmutableArray<BoundExpression>.Empty)));

        // builder.MoveNext(ref this); — uses marker node for MethodSpec emission
        stmts.Add(new BoundExpressionStatement(null, new BoundStateMachineBuilderMoveNext(null, builderField, thisParam, smClass)));

        // short version = promise.Version;
        var versionProp = promiseType.GetProperty("Version");
        var versionGetter = versionProp.GetGetMethod();
        var promiseAddr2 = new BoundAddressOfExpression(
            null,
            new BoundFieldAccessExpression(null, new BoundVariableExpression(null, thisParam), smClass, promiseField));
        var versionCall = new BoundImportedInstanceCallExpression(
            null,
            promiseAddr2, versionGetter, TypeSymbol.FromClrType(typeof(short)), ImmutableArray<BoundExpression>.Empty);
        var versionLocal = new LocalVariableSymbol("<>version", isReadOnly: false, TypeSymbol.FromClrType(typeof(short)));
        stmts.Add(new BoundVariableDeclaration(null, versionLocal, versionCall));

        // return new ValueTask<bool>(this, version);
        // The ValueTask<bool>(IValueTaskSource<bool>, short) constructor
        var vtCtor = typeof(System.Threading.Tasks.ValueTask<bool>).GetConstructor(
            new[] { typeof(System.Threading.Tasks.Sources.IValueTaskSource<bool>), typeof(short) });
        var vtConstruct = new BoundClrConstructorCallExpression(
            null,
            typeof(System.Threading.Tasks.ValueTask<bool>),
            vtCtor,
            ImmutableArray.Create<BoundExpression>(
                new BoundVariableExpression(null, thisParam),
                new BoundVariableExpression(null, versionLocal)),
            TypeSymbol.FromClrType(typeof(System.Threading.Tasks.ValueTask<bool>)));
        stmts.Add(new BoundReturnStatement(null, vtConstruct));

        return Lowerer.Lower(new BoundBlockStatement(null, stmts.ToImmutable()));
    }

    private BoundBlockStatement BuildDisposeAsyncBody(
        FunctionSymbol disposeAsync,
        StructSymbol smClass,
        FieldSymbol stateField,
        FieldSymbol disposeModeField,
        FieldSymbol promiseField,
        FieldSymbol builderField,
        FunctionSymbol moveNextMethod)
    {
        var thisParam = disposeAsync.ThisParameter;
        var stmts = ImmutableArray.CreateBuilder<BoundStatement>();

        // if (state == -2) return default(ValueTask);
        var finishedCheck = new BoundBinaryExpression(
            null,
            new BoundFieldAccessExpression(null, new BoundVariableExpression(null, thisParam), smClass, stateField),
            BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
            new BoundLiteralExpression(null, StateMachineStates.FinishedState));
        var earlyReturn = new BoundReturnStatement(null, new BoundDefaultExpression(null, TypeSymbol.FromClrType(typeof(System.Threading.Tasks.ValueTask))));
        stmts.Add(new BoundIfStatement(null, finishedCheck, earlyReturn, null));

        // this.<>w__disposeMode = true;
        stmts.Add(new BoundExpressionStatement(
            null,
            new BoundFieldAssignmentExpression(null, thisParam, smClass, disposeModeField, new BoundLiteralExpression(null, true))));

        // promise.Reset();
        var promiseType = typeof(System.Threading.Tasks.Sources.ManualResetValueTaskSourceCore<bool>);
        var resetMethod = promiseType.GetMethod("Reset");
        var promiseAddr = new BoundAddressOfExpression(
            null,
            new BoundFieldAccessExpression(null, new BoundVariableExpression(null, thisParam), smClass, promiseField));
        stmts.Add(new BoundExpressionStatement(null,
            new BoundImportedInstanceCallExpression(
            null,
            promiseAddr, resetMethod, TypeSymbol.Void, ImmutableArray<BoundExpression>.Empty)));

        // builder.MoveNext(ref this); — uses marker node for MethodSpec emission
        stmts.Add(new BoundExpressionStatement(null, new BoundStateMachineBuilderMoveNext(null, builderField, thisParam, smClass)));

        // Return default ValueTask (completed).
        stmts.Add(new BoundReturnStatement(null, new BoundDefaultExpression(null, TypeSymbol.FromClrType(typeof(System.Threading.Tasks.ValueTask)))));

        return Lowerer.Lower(new BoundBlockStatement(null, stmts.ToImmutable()));
    }

    private BoundBlockStatement BuildGetAsyncEnumeratorBody(
        FunctionSymbol getAsyncEnumerator,
        StructSymbol smClass,
        FieldSymbol stateField,
        FieldSymbol disposeModeField,
        ImmutableArray<ParameterSymbol> userParameters,
        Dictionary<ParameterSymbol, FieldSymbol> parameterFields)
    {
        var thisParam = getAsyncEnumerator.ThisParameter;
        var ctParam = getAsyncEnumerator.Parameters[0];
        var stmts = ImmutableArray.CreateBuilder<BoundStatement>();

        // this.<>1__state = -1; (running state)
        stmts.Add(new BoundExpressionStatement(
            null,
            new BoundFieldAssignmentExpression(null,
                thisParam, smClass, stateField,
                new BoundLiteralExpression(null, StateMachineStates.NotStartedOrRunningState))));

        // this.<>w__disposeMode = false; (reset dispose flag for re-enumeration)
        stmts.Add(new BoundExpressionStatement(
            null,
            new BoundFieldAssignmentExpression(null,
                thisParam, smClass, disposeModeField,
                new BoundLiteralExpression(null, false))));

        // Issue #180 / ADR-0040: thread the runtime-supplied cancellation
        // token into the user's @EnumeratorCancellation parameter. The C#
        // semantics combine the original kickoff token with the per-enumerator
        // token via CancellationTokenSource.CreateLinkedTokenSource; for this
        // slice we adopt the conservative "override when meaningful" rule:
        // if the caller passed a real (cancellable) token via WithCancellation,
        // assign it to the parameter field; otherwise keep the kickoff value.
        //     if (cancellationToken.CanBeCanceled) {
        //         this.<param> = cancellationToken;
        //     }
        if (!userParameters.IsDefaultOrEmpty)
        {
            foreach (var userParam in userParameters)
            {
                var ecAttr = KnownAttributes.FindEnumeratorCancellation(userParam.Attributes);
                if (ecAttr == null)
                {
                    continue;
                }

                if (userParam.Type?.ClrType != typeof(System.Threading.CancellationToken))
                {
                    // Binder already reported GS0207; skip emit-time threading.
                    continue;
                }

                if (!parameterFields.TryGetValue(userParam, out var paramField))
                {
                    continue;
                }

                var canBeCanceledGetter = typeof(System.Threading.CancellationToken)
                    .GetProperty(nameof(System.Threading.CancellationToken.CanBeCanceled))
                    .GetGetMethod();
                var canBeCanceledCall = new BoundImportedInstanceCallExpression(
                    null,
                    new BoundAddressOfExpression(null, new BoundVariableExpression(null, ctParam)),
                    canBeCanceledGetter,
                    TypeSymbol.Bool,
                    ImmutableArray<BoundExpression>.Empty);

                var assign = new BoundExpressionStatement(
                    null,
                    new BoundFieldAssignmentExpression(
                        null,
                        thisParam, smClass, paramField,
                        new BoundVariableExpression(null, ctParam)));

                stmts.Add(new BoundIfStatement(
                    null,
                    canBeCanceledCall,
                    new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(assign)),
                    elseStatement: null));

                // Only one parameter may carry the marker; if a user wrote
                // multiple, the binder accepts the first and downstream emit
                // honours that same parameter.
                break;
            }
        }

        // return this;
        stmts.Add(new BoundReturnStatement(null, new BoundVariableExpression(null, thisParam)));

        return Lowerer.Lower(new BoundBlockStatement(null, stmts.ToImmutable()));
    }

    private BoundBlockStatement BuildVtsGetStatusBody(FunctionSymbol func, StructSymbol smClass, FieldSymbol promiseField)
    {
        // return promise.GetStatus(token);
        var thisParam = func.ThisParameter;
        var tokenParam = func.Parameters[0];
        var promiseType = typeof(System.Threading.Tasks.Sources.ManualResetValueTaskSourceCore<bool>);
        var method = promiseType.GetMethod("GetStatus", new[] { typeof(short) });
        var promiseAddr = new BoundAddressOfExpression(
            null,
            new BoundFieldAccessExpression(null, new BoundVariableExpression(null, thisParam), smClass, promiseField));
        var call = new BoundImportedInstanceCallExpression(
            null,
            promiseAddr, method, TypeSymbol.FromClrType(typeof(System.Threading.Tasks.Sources.ValueTaskSourceStatus)),
            ImmutableArray.Create<BoundExpression>(new BoundVariableExpression(null, tokenParam)));
        return Lowerer.Lower(new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(new BoundReturnStatement(null, call))));
    }

    private BoundBlockStatement BuildVtsGetResultBody(FunctionSymbol func, StructSymbol smClass, FieldSymbol promiseField)
    {
        // return promise.GetResult(token);
        var thisParam = func.ThisParameter;
        var tokenParam = func.Parameters[0];
        var promiseType = typeof(System.Threading.Tasks.Sources.ManualResetValueTaskSourceCore<bool>);
        var method = promiseType.GetMethod("GetResult", new[] { typeof(short) });
        var promiseAddr = new BoundAddressOfExpression(
            null,
            new BoundFieldAccessExpression(null, new BoundVariableExpression(null, thisParam), smClass, promiseField));
        var call = new BoundImportedInstanceCallExpression(
            null,
            promiseAddr, method, TypeSymbol.Bool,
            ImmutableArray.Create<BoundExpression>(new BoundVariableExpression(null, tokenParam)));
        return Lowerer.Lower(new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(new BoundReturnStatement(null, call))));
    }

    private BoundBlockStatement BuildVtsOnCompletedBody(FunctionSymbol func, StructSymbol smClass, FieldSymbol promiseField)
    {
        // promise.OnCompleted(continuation, state, token, flags);
        var thisParam = func.ThisParameter;
        var promiseType = typeof(System.Threading.Tasks.Sources.ManualResetValueTaskSourceCore<bool>);
        var method = promiseType.GetMethod("OnCompleted");
        var promiseAddr = new BoundAddressOfExpression(
            null,
            new BoundFieldAccessExpression(null, new BoundVariableExpression(null, thisParam), smClass, promiseField));
        var args = ImmutableArray.Create<BoundExpression>(
            new BoundVariableExpression(null, func.Parameters[0]),
            new BoundVariableExpression(null, func.Parameters[1]),
            new BoundVariableExpression(null, func.Parameters[2]),
            new BoundVariableExpression(null, func.Parameters[3]));
        var call = new BoundImportedInstanceCallExpression(null, promiseAddr, method, TypeSymbol.Void, args);
        return Lowerer.Lower(new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, call),
            new BoundReturnStatement(null, null))));
    }

    private BoundBlockStatement BuildVtsGetResultVoidBody(FunctionSymbol func, StructSymbol smClass, FieldSymbol promiseField)
    {
        // promise.GetResult(token); // discard bool
        var thisParam = func.ThisParameter;
        var tokenParam = func.Parameters[0];
        var promiseType = typeof(System.Threading.Tasks.Sources.ManualResetValueTaskSourceCore<bool>);
        var method = promiseType.GetMethod("GetResult", new[] { typeof(short) });
        var promiseAddr = new BoundAddressOfExpression(
            null,
            new BoundFieldAccessExpression(null, new BoundVariableExpression(null, thisParam), smClass, promiseField));
        var call = new BoundImportedInstanceCallExpression(
            null,
            promiseAddr, method, TypeSymbol.Bool,
            ImmutableArray.Create<BoundExpression>(new BoundVariableExpression(null, tokenParam)));
        return Lowerer.Lower(new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, call),
            new BoundReturnStatement(null, null))));
    }

    private BoundStructLiteralExpression CreateAsyncIteratorKickoffLiteral(
        StructSymbol smClass,
        FieldSymbol stateField,
        FieldSymbol builderField,
        Dictionary<ParameterSymbol, FieldSymbol> parameterFields,
        ImmutableArray<ParameterSymbol> parameters,
        FieldSymbol thisProxyField,
        FunctionSymbol kickoffFunction)
    {
        var initializers = ImmutableArray.CreateBuilder<BoundFieldInitializer>();
        initializers.Add(new BoundFieldInitializer(stateField, new BoundLiteralExpression(null, StateMachineStates.InitialAsyncIteratorState)));

        // Builder: AsyncIteratorMethodBuilder.Create()
        var createMethod = typeof(System.Runtime.CompilerServices.AsyncIteratorMethodBuilder)
            .GetMethod("Create", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static, null, Type.EmptyTypes, null);
        initializers.Add(new BoundFieldInitializer(builderField,
            new BoundClrStaticCallExpression(null, createMethod, TypeSymbol.FromClrType(typeof(System.Runtime.CompilerServices.AsyncIteratorMethodBuilder)), ImmutableArray<BoundExpression>.Empty)));

        foreach (var parameter in parameters)
        {
            initializers.Add(new BoundFieldInitializer(parameterFields[parameter], new BoundVariableExpression(null, parameter)));
        }

        // Issue #641: capture `this` into <>4__this so MoveNext can access
        // instance members of the enclosing class.
        if (thisProxyField != null && kickoffFunction.ThisParameter != null)
        {
            initializers.Add(new BoundFieldInitializer(thisProxyField, new BoundVariableExpression(null, kickoffFunction.ThisParameter)));
        }

        return new BoundStructLiteralExpression(null, smClass, initializers.ToImmutable());
    }

    #endregion

    #region Async lambda state-machine synthesis

    /// <summary>
    /// For each async lambda, runs the async state-machine pipeline on its body
    /// and produces an <see cref="AsyncStateMachinePlan"/>. For no-capture lambdas
    /// the kickoff method is the lambda's own FunctionSymbol; for capture-bearing
    /// lambdas the kickoff is the closure class's Invoke method.
    /// </summary>
    public void SynthesizeAsyncLambdaStateMachines(List<BoundFunctionLiteralExpression> literals, PackageSymbol hostPackage)
    {
        var packageName = hostPackage?.Name ?? this.emitCtx.Program.PackageName ?? string.Empty;
        var plans = this.AsyncStateMachinePlans.ToBuilder();

        foreach (var literal in literals)
        {
            if (!literal.Function.IsAsync)
            {
                continue;
            }

            FunctionSymbol kickoffFunction;
            BoundBlockStatement body;

            if (this.closures.ClosureInfos.TryGetValue(literal, out var closure))
            {
                // Capture-bearing async lambda: the closure's Invoke method is the kickoff.
                kickoffFunction = closure.InvokeMethod;
                kickoffFunction.IsAsync = true;
                if (!this.lambdaBodies.TryGetValue(kickoffFunction, out body))
                {
                    continue;
                }
            }
            else
            {
                // No-capture async lambda: the lambda's own function symbol is the kickoff.
                kickoffFunction = literal.Function;
                if (!this.lambdaBodies.TryGetValue(kickoffFunction, out body))
                {
                    body = literal.Body;
                }
            }

            // Lambda bodies are not pre-lowered (the Lowerer doesn't descend into
            // BoundFunctionLiteralExpression). Lower before the async pipeline.
            body = (BoundBlockStatement)Lowerer.Lower(body);

            var plan = AsyncStateMachineRewriter.RewriteSingle(
                kickoffFunction, body, this.emitCtx.References, packageName);
            if (plan == null)
            {
                continue;
            }

            // Record nesting: capture-bearing async lambda SMs nest inside
            // their closure class (Subset A of the Roslyn nesting convention).
            if (this.closures.ClosureInfos.TryGetValue(literal, out var closureForNesting))
            {
                var smStruct = plan.StateMachine.MaterializeAsStructSymbol();
                this.AsyncSmEnclosingClosures[smStruct] = closureForNesting.ClassSym;
            }

            plans.Add(plan);
        }

        this.AsyncStateMachinePlans = plans.ToImmutable();
    }

    #endregion

    #region State-machine IL emit

    /// <summary>
    /// Emits the <c>MoveNext()</c> method body for an async state machine, using
    /// the rewritten bound-tree body produced by <c>MoveNextBodyRewriter</c>.
    /// </summary>
    public void EmitStateMachineMoveNext(AsyncStateMachinePlan plan)
    {
        var bodyResult = this.buildMoveNextBodyBytes(plan);

        // MoveNext signature: void MoveNext() (instance)
        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });

        var moveNextHandle = this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig
                | MethodAttributes.NewSlot | MethodAttributes.Final,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("MoveNext"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: bodyResult.BodyOffset,
            parameterList: this.nextParameterHandle());

        // Phase 4/5 (ADR-0027 §7.7a): MoveNext is the visible body for an async
        // method post-lowering; sequence points and locals captured here surface
        // in debugger stack traces, locals window, and `step` commands across
        // `await` points.
        this.emitCtx.Pdb?.RecordMethod(moveNextHandle, bodyResult.SequencePoints, bodyResult.Locals, bodyResult.Constants, bodyResult.CodeSize, bodyResult.LocalsSignature, plan.KickoffMethod?.Declaration?.SyntaxTree);
    }

    /// <summary>
    /// Emits the <c>SetStateMachine(IAsyncStateMachine)</c> method for an
    /// async state machine. For struct state machines, this is a no-op body.
    /// </summary>
    public void EmitStateMachineSetStateMachine(AsyncStateMachinePlan plan)
    {
        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            var il = new InstructionEncoder(new BlobBuilder());
            il.OpCode(ILOpCode.Ret);
            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
        }

        var iAsyncSmType = typeof(System.Runtime.CompilerServices.IAsyncStateMachine);
        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true)
            .Parameters(1, r => r.Void(), ps =>
            {
                this.encodeClrType(ps.AddParameter().Type(), iAsyncSmType);
            });

        this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig
                | MethodAttributes.NewSlot | MethodAttributes.Final,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("SetStateMachine"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// Emits the kickoff body for an async function: creates the state-machine
    /// local, initializes fields, calls <c>builder.Start(ref sm)</c>, and
    /// returns <c>builder.Task</c> (or returns void for async void).
    /// </summary>
    public int EmitAsyncKickoffBody(FunctionSymbol function, AsyncStateMachinePlan plan)
    {
        var smStruct = plan.StateMachine.MaterializeAsStructSymbol();
        var smTypeDef = this.cache.StructTypeDefs[smStruct];
        var builderInfo = plan.StateMachine.BuilderInfo;
        var stateFieldHandle = this.cache.StructFieldDefs[plan.FieldMap.StateField];
        var builderFieldHandle = this.cache.StructFieldDefs[plan.FieldMap.BuilderField];

        var il = new InstructionEncoder(new BlobBuilder());

        // Local 0: the state-machine struct instance.
        // ldloca.s 0 / initobj SM  — zero-initialize the struct.
        il.LoadLocalAddress(0);
        il.OpCode(ILOpCode.Initobj);
        il.Token(smTypeDef);

        // sm.<>t__builder = AsyncTaskMethodBuilder[<T>].Create()
        il.LoadLocalAddress(0);
        var createRef = this.getMethodEntityHandleForContainingType(builderInfo.CreateMethod, plan.FieldMap.BuilderField.Type);
        il.OpCode(ILOpCode.Call);
        il.Token(createRef);
        il.OpCode(ILOpCode.Stfld);
        il.Token(builderFieldHandle);

        // Copy this (for instance methods)
        if (plan.FieldMap.ThisField != null && function.IsInstanceMethod)
        {
            var thisFieldHandle = this.cache.StructFieldDefs[plan.FieldMap.ThisField];
            il.LoadLocalAddress(0);
            il.LoadArgument(0);
            il.OpCode(ILOpCode.Stfld);
            il.Token(thisFieldHandle);
        }

        // Copy parameters
        int paramSlotShift = function.IsInstanceMethod ? 1 : 0;
        var paramIndex = 0;
        foreach (var copy in plan.KickoffPlan.ParameterCopies)
        {
            var fieldHandle = this.cache.StructFieldDefs[copy.Field];
            il.LoadLocalAddress(0);
            il.LoadArgument(paramIndex + paramSlotShift);
            il.OpCode(ILOpCode.Stfld);
            il.Token(fieldHandle);
            paramIndex++;
        }

        // sm.<>1__state = -1
        il.LoadLocalAddress(0);
        il.LoadConstantI4(StateMachineStates.NotStartedOrRunningState);
        il.OpCode(ILOpCode.Stfld);
        il.Token(stateFieldHandle);

        // sm.<>t__builder.Start<SM>(ref sm)
        // ldloca 0  (address of sm for ldflda builder)
        // ldflda <>t__builder
        // ldloca 0  (ref sm as argument)
        // call Start<SM>(ref SM)
        il.LoadLocalAddress(0);
        il.OpCode(ILOpCode.Ldflda);
        il.Token(builderFieldHandle);
        il.LoadLocalAddress(0);

        // Start is generic: Start<TStateMachine>(ref TStateMachine).
        // We need a MethodSpec for Start<SM>.
        var startMethodSpec = this.GetStateMachineStartMethodSpec(builderInfo.StartMethod, smStruct, plan.FieldMap.BuilderField.Type);
        il.OpCode(ILOpCode.Call);
        il.Token(startMethodSpec);

        // Return builder.Task or void
        if (builderInfo.TaskProperty != null)
        {
            // ldloca 0, ldflda builder, call get_Task
            il.LoadLocalAddress(0);
            il.OpCode(ILOpCode.Ldflda);
            il.Token(builderFieldHandle);
            var getTaskMethod = builderInfo.TaskProperty.GetGetMethod();
            var getTaskRef = this.getMethodEntityHandleForContainingType(getTaskMethod, plan.FieldMap.BuilderField.Type);
            il.OpCode(ILOpCode.Call);
            il.Token(getTaskRef);
        }

        il.OpCode(ILOpCode.Ret);

        // Locals: one local of the state-machine struct type.
        var localsSigBlob = new BlobBuilder();
        var localsEncoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(1);
        localsEncoder.AddVariable().Type().Type(smTypeDef, isValueType: true);
        var localsSignature = this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(localsSigBlob));

        return this.emitCtx.MethodBodyStream.AddMethodBody(
            il,
            maxStack: 3,
            localVariablesSignature: localsSignature);
    }

    /// <summary>
    /// Gets a MethodSpec for <c>builder.Start&lt;SM&gt;(ref SM)</c> where SM
    /// is the state-machine struct TypeDef.
    /// </summary>
    private EntityHandle GetStateMachineStartMethodSpec(MethodInfo startOpenMethod, StructSymbol smStruct, TypeSymbol builderFieldType)
    {
        // Start is an open generic instance method on the builder struct.
        // We need: MemberRef for Start<T>(ref T) on the builder type,
        // then a MethodSpec instantiating it with the SM TypeDef.
        var openRef = this.getMethodEntityHandleForContainingType(
            startOpenMethod.IsGenericMethod
                ? startOpenMethod.GetGenericMethodDefinition()
                : startOpenMethod,
            builderFieldType);

        // Build MethodSpec signature: instantiation with SM struct type.
        var smTypeDef = this.cache.StructTypeDefs[smStruct];
        var sigBlob = new BlobBuilder();
        var argsEncoder = new BlobEncoder(sigBlob).MethodSpecificationSignature(1);
        argsEncoder.AddArgument().Type(smTypeDef, isValueType: true);

        return this.emitCtx.Metadata.AddMethodSpecification(openRef, this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Emits the <c>builder.AwaitUnsafeOnCompleted&lt;TAwaiter, TSM&gt;(ref awaiter, ref this)</c>
    /// or <c>AwaitOnCompleted</c> call from within MoveNext. Requires manual MethodSpec
    /// construction because TStateMachine is the synthesized SM TypeDef.
    /// </summary>
    public void EmitAwaitOnCompletedCall(
        InstructionEncoder il,
        Dictionary<VariableSymbol, int> locals,
        Dictionary<ParameterSymbol, int> parameters,
        BoundStateMachineAwaitOnCompleted node,
        AsyncStateMachinePlan currentPlan = null,
        AsyncIteratorEmitContext aiCtx = null)
    {
        // Use the explicitly-passed plan when available; fall back to the
        // legacy search for backward compatibility with top-level async.
        if (currentPlan == null && aiCtx == null)
        {
            foreach (var plan in this.AsyncStateMachinePlans)
            {
                if (plan.FieldMap.StateField != null)
                {
                    if (this.cache.StructFieldDefs.ContainsKey(plan.FieldMap.BuilderField))
                    {
                        currentPlan = plan;
                        break;
                    }
                }
            }
        }

        FieldSymbol builderField;
        StructSymbol smStruct;
        AsyncMethodBuilderInfo builderInfo;
        bool smIsValueType;

        if (aiCtx != null)
        {
            builderField = aiCtx.BuilderField;
            smStruct = aiCtx.SmClass;
            builderInfo = aiCtx.BuilderInfo;
            smIsValueType = false; // async iterator SM is a class
        }
        else if (currentPlan != null)
        {
            builderField = currentPlan.FieldMap.BuilderField;
            smStruct = currentPlan.StateMachine.MaterializeAsStructSymbol();
            builderInfo = currentPlan.StateMachine.BuilderInfo;
            smIsValueType = !smStruct.IsClass;
        }
        else
        {
            throw new InvalidOperationException("Cannot emit AwaitOnCompleted: no active async plan.");
        }

        var builderFieldHandle = this.cache.StructFieldDefs[builderField];

        // ldarg.0 (this)
        // ldflda builder
        il.LoadArgument(0);
        il.OpCode(ILOpCode.Ldflda);
        il.Token(builderFieldHandle);

        // ldloca awaiter
        var awaiterSlot = locals[node.AwaiterLocal];
        il.LoadLocalAddress(awaiterSlot);

        // ref this: for struct SM ldarg.0 is already a managed pointer;
        // for class SM we need ldarga.s 0 (address of the 'this' arg slot).
        if (smIsValueType)
        {
            il.LoadArgument(0);
        }
        else
        {
            il.OpCode(ILOpCode.Ldarga_s);
            il.CodeBuilder.WriteByte(0);
        }

        // Build MethodSpec for AwaitUnsafeOnCompleted<TAwaiter, TSM> or AwaitOnCompleted<TAwaiter, TSM>
        var openMethod = node.UseCritical
            ? builderInfo.AwaitUnsafeOnCompletedMethod
            : builderInfo.AwaitOnCompletedMethod;

        var openRef = this.getMethodEntityHandleForContainingType(
            openMethod.IsGenericMethod
                ? openMethod.GetGenericMethodDefinition()
                : openMethod,
            builderField.Type);

        var smTypeDef = this.cache.StructTypeDefs[smStruct];
        var sigBlob = new BlobBuilder();
        var argsEncoder = new BlobEncoder(sigBlob).MethodSpecificationSignature(2);

        // First type arg: TAwaiter
        if (node.AwaiterTypeSymbol != null)
        {
            this.encodeTypeSymbol(argsEncoder.AddArgument(), node.AwaiterTypeSymbol);
        }
        else
        {
            this.encodeClrType(argsEncoder.AddArgument(), node.AwaiterClrType);
        }

        // Second type arg: TStateMachine (the SM TypeDef)
        argsEncoder.AddArgument().Type(smTypeDef, isValueType: smIsValueType);

        var methodSpec = this.emitCtx.Metadata.AddMethodSpecification(openRef, this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        il.OpCode(ILOpCode.Call);
        il.Token(methodSpec);
    }

    public bool TryGetAsyncBuilderMethodHandle(AsyncStateMachinePlan plan, MethodInfo method, out EntityHandle handle)
    {
        handle = default;
        if (plan?.StateMachine == null)
        {
            return false;
        }

        if (!TryCreateAsyncBuilderMemberReference(plan.StateMachine, method, out var memberRef))
        {
            return false;
        }

        handle = memberRef;
        return true;
    }

    public EntityHandle GetAsyncBuilderMethodHandle(AsyncStateMachinePlan plan, MethodInfo method)
    {
        return TryGetAsyncBuilderMethodHandle(plan, method, out var handle)
            ? handle
            : this.getMethodEntityHandle(method);
    }

    private static bool IsAsyncUserDefinedResultType(TypeSymbol type)
        => type is StructSymbol or InterfaceSymbol or EnumSymbol;

    private bool TryCreateAsyncBuilderMemberReference(
        SynthesizedStateMachineType stateMachine,
        MethodInfo method,
        out MemberReferenceHandle handle)
    {
        handle = default;
        if (stateMachine?.ResultTypeSymbol == null
            || !IsAsyncUserDefinedResultType(stateMachine.ResultTypeSymbol)
            || method == null
            || method.IsGenericMethod
            || method.DeclaringType is not Type declaringType
            || !declaringType.IsConstructedGenericType)
        {
            return false;
        }

        var openDeclaring = declaringType.GetGenericTypeDefinition();
        var parent = this.CreateConstructedTypeSpecification(
            openDeclaring,
            ImmutableArray.Create(stateMachine.ResultTypeSymbol));
        var openMethod = GetOpenMethodOnOpenDeclaringType(method);

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: !method.IsStatic)
            .Parameters(
                openMethod.GetParameters().Length,
                returnType: r => EncodeMethodReturnType(r, openMethod.ReturnType),
                parameters: ps =>
                {
                    foreach (var parameter in openMethod.GetParameters())
                    {
                        var parameterType = parameter.ParameterType;
                        if (parameterType.IsByRef)
                        {
                            this.encodeClrType(ps.AddParameter().Type(isByRef: true), parameterType.GetElementType()!);
                        }
                        else
                        {
                            this.encodeClrType(ps.AddParameter().Type(), parameterType);
                        }
                    }
                });

        handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(method.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return true;
    }

    private EntityHandle CreateConstructedTypeSpecification(Type openDefinition, ImmutableArray<TypeSymbol> typeArguments)
    {
        var sigBlob = new BlobBuilder();
        var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
        var genericInst = encoder.GenericInstantiation(
            this.getTypeReference(openDefinition),
            typeArguments.Length,
            isValueType: openDefinition.IsValueType);
        foreach (var typeArgument in typeArguments)
        {
            this.encodeTypeSymbol(genericInst.AddArgument(), typeArgument);
        }

        return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    private void EncodeMethodReturnType(ReturnTypeEncoder encoder, Type returnType)
    {
        if (returnType?.FullName == "System.Void")
        {
            encoder.Void();
            return;
        }

        if (returnType?.IsByRef == true)
        {
            this.encodeClrType(encoder.Type(isByRef: true), returnType.GetElementType()!);
            return;
        }

        this.encodeClrType(encoder.Type(), returnType);
    }

    private static MethodInfo GetOpenMethodOnOpenDeclaringType(MethodInfo method)
    {
        var declaring = method.DeclaringType;
        if (declaring is null || !declaring.IsConstructedGenericType)
        {
            return method;
        }

        var open = declaring.GetGenericTypeDefinition();
        foreach (var candidate in open.GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (candidate.MetadataToken == method.MetadataToken && candidate.Module == method.Module)
            {
                return candidate;
            }
        }

        return method;
    }

    #endregion
}
