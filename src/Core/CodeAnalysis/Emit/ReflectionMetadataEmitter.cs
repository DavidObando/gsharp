// <copyright file="ReflectionMetadataEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1028 // trailing whitespace
#pragma warning disable SA1116 // parameters begin on line after declaration
#pragma warning disable SA1117 // parameters on same line
#pragma warning disable SA1214 // readonly fields before non-readonly
#pragma warning disable SA1515 // single-line comment preceded by blank line
#pragma warning disable SA1201 // method should not follow a class (this file mixes private helper classes inline with methods)

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Lowering.Iterators;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Emits a managed PE for a <see cref="BoundProgram"/> using
/// <see cref="System.Reflection.Metadata"/> directly.
/// </summary>
/// <remarks>
/// Phase 2 (p2-langcov) coverage: locals, parameters, unary/binary operators,
/// assignments, label/goto/conditional-goto, user-defined function calls
/// (emitted as static methods on <c>&lt;Program&gt;</c>), and the imported-call
/// surface inherited from Phase 1. Per ADR-0027 the bespoke emitter is the
/// production path for v1.0; the Roslyn-fork escape valve referenced in
/// earlier comments here has been removed from the tree.
/// </remarks>
internal sealed class ReflectionMetadataEmitter
{
    // Portable PDB metadata format version expected by all current readers
    // (System.Reflection.Metadata, dotnet-symbol, debuggers). 0x0100 = v1.0.
    private const ushort PortablePdbVersion = 0x0100;

    private readonly BoundProgram program;
    private readonly ReferenceResolver references;
    private readonly string assemblyNameOverride;
    private readonly MetadataBuilder metadata = new MetadataBuilder();
    private readonly Dictionary<Assembly, AssemblyReferenceHandle> assemblyRefs = new Dictionary<Assembly, AssemblyReferenceHandle>();
    private AssemblyReferenceHandle systemRuntimeAssemblyRef;
    // Issue #420 (P3-9): key by TypeIdentityComparer so that the same logical
    // type reached through different MetadataLoadContext paths collapses to
    // one TypeRef row instead of producing duplicates.
    private readonly Dictionary<Type, TypeReferenceHandle> typeRefs = new Dictionary<Type, TypeReferenceHandle>(TypeIdentityComparer.Instance);
    private readonly Dictionary<Type, TypeSpecificationHandle> typeSpecs = new Dictionary<Type, TypeSpecificationHandle>(TypeIdentityComparer.Instance);
    private readonly Dictionary<MethodInfo, MemberReferenceHandle> methodRefs = new Dictionary<MethodInfo, MemberReferenceHandle>();
    private readonly Dictionary<MethodInfo, MethodSpecificationHandle> methodSpecs = new Dictionary<MethodInfo, MethodSpecificationHandle>();

    // Issue #420 (P3-7): cache for MethodSpec rows whose generic arguments include
    // user-defined type symbols. The placeholder-closed MethodInfo is identical for
    // all symbol arguments, so we must key by (MethodInfo, symbol arg list) with
    // structural equality on the symbol array.
    private readonly Dictionary<MethodSpecSymbolKey, MethodSpecificationHandle> methodSpecsWithSymbolArgs
        = new Dictionary<MethodSpecSymbolKey, MethodSpecificationHandle>();

    private readonly Dictionary<ConstructorInfo, MemberReferenceHandle> ctorRefs = new Dictionary<ConstructorInfo, MemberReferenceHandle>();
    private readonly Dictionary<FieldInfo, MemberReferenceHandle> fieldRefs = new Dictionary<FieldInfo, MemberReferenceHandle>();
    private readonly Dictionary<FunctionSymbol, MethodDefinitionHandle> functionHandles = new Dictionary<FunctionSymbol, MethodDefinitionHandle>();
    private readonly MethodBodyStreamEncoder methodBodyStream;
    private readonly BlobBuilder ilStream = new BlobBuilder();

    private readonly bool metadataOnly;

    // Phase 7.7b: informational version string stamped on the assembly.
    private string assemblyVersionOverride;

    private readonly Dictionary<StructSymbol, TypeDefinitionHandle> structTypeDefs = new Dictionary<StructSymbol, TypeDefinitionHandle>();
    private readonly Dictionary<FieldSymbol, FieldDefinitionHandle> structFieldDefs = new Dictionary<FieldSymbol, FieldDefinitionHandle>();
    private readonly Dictionary<StructSymbol, MethodDefinitionHandle> classCtorHandles = new Dictionary<StructSymbol, MethodDefinitionHandle>();
    private readonly Dictionary<StructSymbol, MethodDefinitionHandle> classPrimaryCtorHandles = new Dictionary<StructSymbol, MethodDefinitionHandle>();

    // Issue #262: .cctor (type initializer) handles for types with static field initializers.
    private readonly Dictionary<StructSymbol, MethodDefinitionHandle> cctorHandles = new Dictionary<StructSymbol, MethodDefinitionHandle>();

    // Phase 3.B.4: user-defined interface TypeDefs.
    private readonly Dictionary<InterfaceSymbol, TypeDefinitionHandle> interfaceTypeDefs = new Dictionary<InterfaceSymbol, TypeDefinitionHandle>();

    // Issue #193: user-defined enum TypeDefs and the per-member literal field rows.
    // EnumSymbol is emitted as a sealed value type deriving from System.Enum with
    // a public instance field 'value__' of int32 plus one public static literal
    // field per EnumMemberSymbol carrying its integer constant.
    private readonly Dictionary<EnumSymbol, TypeDefinitionHandle> enumTypeDefs = new Dictionary<EnumSymbol, TypeDefinitionHandle>();
    private readonly Dictionary<EnumMemberSymbol, FieldDefinitionHandle> enumMemberFieldDefs = new Dictionary<EnumMemberSymbol, FieldDefinitionHandle>();

    // Issue #191: each user-declared top-level var/let/const becomes a static
    // FieldDef on the entry-point package's <Program> TypeDef. Mapping symbol
    // → field handle so EmitLoadVariable/EmitStoreVariable can route through
    // ldsfld/stsfld instead of allocating a local slot.
    private readonly Dictionary<GlobalVariableSymbol, FieldDefinitionHandle> globalFieldDefs = new Dictionary<GlobalVariableSymbol, FieldDefinitionHandle>();

    // Phase 3.B.3 sub-step 2b: instance methods on user-defined classes.
    private readonly Dictionary<FunctionSymbol, MethodDefinitionHandle> methodHandles = new Dictionary<FunctionSymbol, MethodDefinitionHandle>();

    // ADR-0051 Phase 6: property accessor method handles for PropertyDef + MethodSemantics emission.
    private readonly Dictionary<PropertySymbol, (MethodDefinitionHandle? Getter, MethodDefinitionHandle? Setter)> propertyAccessorHandles = new Dictionary<PropertySymbol, (MethodDefinitionHandle? Getter, MethodDefinitionHandle? Setter)>();

    // Issue #418 (P1-7): tracks TypeDefs that already had a PropertyMap row emitted, so the
    // static-property emission path can decide whether to add its own PropertyMap without
    // relying on symbol-level heuristics (which fail when instance properties are declared
    // but all skipped during emission, leaving the static PropertyDef rows orphaned).
    private readonly HashSet<TypeDefinitionHandle> typesWithPropertyMap = new HashSet<TypeDefinitionHandle>();

    // ADR-0052: event accessor method handles for EventDef + MethodSemantics emission.
    // Issue #257: extended with optional Raise handle.
    private readonly Dictionary<EventSymbol, (MethodDefinitionHandle Add, MethodDefinitionHandle Remove, MethodDefinitionHandle? Raise)> eventAccessorHandles = new Dictionary<EventSymbol, (MethodDefinitionHandle Add, MethodDefinitionHandle Remove, MethodDefinitionHandle? Raise)>();

    // ADR-0051 Phase 6: cached MemberReferenceHandle for NotImplementedException..ctor().
    private MemberReferenceHandle? notImplementedExceptionCtorRef;

    // ADR-0052: cached MemberReferenceHandles for Delegate.Combine and Delegate.Remove.
    private MemberReferenceHandle? delegateCombineRef;
    private MemberReferenceHandle? delegateRemoveRef;

    // Issue #256: cached open MemberRef for Interlocked.CompareExchange<T>(ref T, T, T).
    private MemberReferenceHandle? interlockedCompareExchangeOpenRef;

    // Issue #420 (P3-11): cached MemberRefs for IsReadOnlyAttribute/IsByRefLikeAttribute/ObsoleteAttribute ctors,
    // so repeated emission of these markers doesn't create duplicate MemberRef rows.
    private MemberReferenceHandle? isReadOnlyAttributeCtorRef;
    private MemberReferenceHandle? isByRefLikeAttributeCtorRef;
    private MemberReferenceHandle? obsoleteAttributeStringBoolCtorRef;

    // Phase 4 emit parity (E1): synthesized lambda bodies (no captures).
    // Populated by a pre-pass walker over every user function/entry body.
    // Each lambda's synthetic FunctionSymbol is registered alongside user
    // functions in functionsByPackage so it gets a MethodDef row, and its
    // body is emitted via the same EmitFunction path.
    private readonly Dictionary<FunctionSymbol, BoundBlockStatement> lambdaBodies = new Dictionary<FunctionSymbol, BoundBlockStatement>();

    // Phase 4 emit parity (E2): synthesized closure classes for lambdas
    // that capture outer variables. Each captured-variable lambda gets:
    //   * A sealed class with one public field per capture (the closure).
    //   * An instance method holding the rewritten body where captured-
    //     variable reads/writes become this.field reads/writes.
    //   * A default ctor (chains to object::.ctor()) — emitted by the
    //     existing EmitClassDefaultConstructor path.
    // Capture semantics match the interpreter: snapshot-by-value at the
    // literal site. The synthesized class is appended to the user struct
    // list so it threads through the existing class TypeDef/method/field
    // row planning naturally.
    private readonly Dictionary<BoundFunctionLiteralExpression, ClosureInfo> closureInfos = new Dictionary<BoundFunctionLiteralExpression, ClosureInfo>();

    // Phase F: each `go` site is lowered through a synthesized display class
    // with an InvokeAction instance method that Task.Run can bind to an Action.
    private readonly Dictionary<BoundGoStatement, ClosureInfo> goClosureInfos = new Dictionary<BoundGoStatement, ClosureInfo>();
    private readonly List<StructSymbol> synthesizedClosureClasses = new List<StructSymbol>();
    private readonly Dictionary<FunctionSymbol, BoundBlockStatement> iteratorKickoffBodies = new Dictionary<FunctionSymbol, BoundBlockStatement>();
    private readonly Dictionary<StructSymbol, IteratorStateMachineInfo> iteratorStateMachineInfos = new Dictionary<StructSymbol, IteratorStateMachineInfo>();
    private int closureCounter;

    // Async state-machine plans produced by AsyncStateMachineRewriter.
    private ImmutableArray<AsyncStateMachinePlan> asyncStateMachinePlans = ImmutableArray<AsyncStateMachinePlan>.Empty;

    // Iterator state-machine plans produced by IteratorRewriter.
    private ImmutableArray<IteratorStateMachinePlan> iteratorPlans = ImmutableArray<IteratorStateMachinePlan>.Empty;

    // Async iterator state-machine plans produced by AsyncIteratorRewriter.
    private ImmutableArray<Lowering.Iterators.AsyncIteratorPlan> asyncIteratorPlans = ImmutableArray<Lowering.Iterators.AsyncIteratorPlan>.Empty;

    // Phase 3 (ADR-0027 §7.7a) Portable PDB options. Defaults to a None-format
    // instance so the existing PE-only emit path stays bit-for-bit identical
    // until Phases 4-7 light up the actual PDB pipeline.
    private DebugInformationOptions debugInformation = new();

    // Phase 3 (ADR-0027 §7.7a) Portable PDB destination stream. Only consumed
    // when debugInformation.Format is Portable; null in every other config.
    private Stream pdbStream;

    // Phase 4 (ADR-0027 §7.7a) Portable PDB collaborator. Instantiated by
    // EmitCore only when debugInformation.Format == Portable; null otherwise
    // so the existing PE-only emit path stays bit-for-bit identical.
    private PortablePdbEmitter pdb;

    // Maps async iterator SM class to its plan (populated during SynthesizeAsyncIteratorStateMachines).
    private readonly Dictionary<StructSymbol, Lowering.Iterators.AsyncIteratorPlan> asyncIteratorInfos = new Dictionary<StructSymbol, Lowering.Iterators.AsyncIteratorPlan>();

    // Maps async iterator SM class to the emit-time context needed by EmitAwaitOnCompletedCall.
    private readonly Dictionary<StructSymbol, AsyncIteratorEmitContext> asyncIteratorEmitContexts = new Dictionary<StructSymbol, AsyncIteratorEmitContext>();

    // Tracks which closure class a capture-bearing async lambda's SM struct nests inside.
    // SM structs NOT in this dictionary nest inside the per-package <Program> class.
    private readonly Dictionary<StructSymbol, StructSymbol> asyncSmEnclosingClosures = new Dictionary<StructSymbol, StructSymbol>();

    private Type coreObjectType;
    private Type coreStringType;
    private Type coreInt32Type;
    private Type coreBooleanType;
    private Type coreArrayType;
    private Type coreValueType;
    private Type coreSystemType;
    private Type coreRuntimeTypeHandleType;
    private Type coreEnumType;
    private TypeReferenceHandle objectTypeRef;
    private TypeReferenceHandle valueTypeRef;
    private MemberReferenceHandle objectCtorRef;
    private MemberReferenceHandle stringConcatRef;
    private MemberReferenceHandle stringEqualsRef;
    private MemberReferenceHandle objectStaticEqualsRef;
    private MemberReferenceHandle objectInstanceToStringRef;
    private MemberReferenceHandle objectInstanceGetHashCodeRef;
    private MemberReferenceHandle nullRefExceptionCtorRef;
    private EntityHandle? systemAttributeTypeRef;
    private MemberReferenceHandle? systemAttributeCtorRef;

    private ReflectionMetadataEmitter(BoundProgram program, ReferenceResolver references, string assemblyName, bool metadataOnly)
    {
        this.program = program;
        this.references = references ?? ReferenceResolver.Default();
        this.assemblyNameOverride = assemblyName;
        this.metadataOnly = metadataOnly;
        this.methodBodyStream = new MethodBodyStreamEncoder(this.ilStream);
    }

    /// <summary>
    /// Emits <paramref name="program"/> to <paramref name="peStream"/> as a
    /// managed PE.
    /// </summary>
    /// <param name="program">The bound program to emit.</param>
    /// <param name="peStream">Destination stream for the PE bytes.</param>
    /// <param name="references">
    /// Reference resolver providing the target framework's core types
    /// (<c>System.Object</c>, <c>System.String</c>) and any user-supplied
    /// imports. Pass <c>null</c> to resolve from the gsc host's loaded
    /// runtime (in-process scenarios only — produces an assembly bound to
    /// the gsc host's TFM).
    /// </param>
    /// <param name="assemblyName">
    /// Optional override for the assembly identity (module + assembly rows).
    /// When <c>null</c>, the entry-point package's name is used. Supplied by
    /// the SDK BuildTask from MSBuild's <c>AssemblyName</c>.
    /// </param>
    /// <param name="metadataOnly">
    /// When true, emits a metadata-only reference assembly: method bodies
    /// are omitted (RVA 0) and the assembly is marked with
    /// <c>System.Runtime.CompilerServices.ReferenceAssemblyAttribute</c>.
    /// </param>
    /// <param name="asyncRewriteResult">
    /// Optional result from the async state-machine rewriter. When non-null,
    /// contains plans for emitting state-machine types and kickoff bodies.
    /// </param>
    /// <param name="iteratorRewriteResult">
    /// Optional result from the iterator rewriter. When non-null, contains plans
    /// for emitting iterator state-machine types and kickoff bodies.
    /// </param>
    /// <param name="asyncIteratorRewriteResult">
    /// Optional result from the async iterator rewriter. When non-null, contains plans
    /// for emitting async iterator state-machine types and kickoff bodies.
    /// </param>
    /// <param name="debugInformation">
    /// Phase 3 (ADR-0027 §7.7a) PDB-related emit options. When <see langword="null"/>
    /// or when <see cref="DebugInformationOptions.Format"/> is
    /// <see cref="DebugInformationFormat.None"/> the emitter behaves exactly as
    /// it did before Phase 3 (no PDB sidecar, no <c>DebugDirectory</c> entries).
    /// The actual production of PDB content lands across Phases 4–7; Phase 3
    /// only plumbs the option onto the emitter so subsequent phases can consume
    /// it without further signature churn.
    /// </param>
    /// <param name="pdbStream">
    /// Optional destination for the Portable PDB sidecar stream. Only consumed
    /// when <paramref name="debugInformation"/> requests
    /// <see cref="DebugInformationFormat.Portable"/>; ignored in every other
    /// configuration. Plumbed here so callers can open the file once and have
    /// the emitter write to it directly without intermediate buffering.
    /// </param>
    /// <param name="assemblyVersion">
    /// Optional informational version string. When non-null, emitted as
    /// <c>AssemblyInformationalVersionAttribute</c> on the assembly so NuGet
    /// and consumer tooling can display the package version.
    /// </param>
    public static void Emit(
        BoundProgram program,
        Stream peStream,
        ReferenceResolver references = null,
        string assemblyName = null,
        bool metadataOnly = false,
        AsyncStateMachineRewriteResult asyncRewriteResult = null,
        IteratorRewriteResult iteratorRewriteResult = null,
        Lowering.Iterators.AsyncIteratorRewriteResult asyncIteratorRewriteResult = null,
        DebugInformationOptions debugInformation = null,
        Stream pdbStream = null,
        string assemblyVersion = null)
    {
        var emitter = new ReflectionMetadataEmitter(program, references, assemblyName, metadataOnly);
        emitter.assemblyVersionOverride = assemblyVersion;
        if (asyncRewriteResult != null)
        {
            emitter.asyncStateMachinePlans = asyncRewriteResult.StateMachines;
        }

        if (iteratorRewriteResult != null)
        {
            emitter.iteratorPlans = iteratorRewriteResult.Plans;
        }

        if (asyncIteratorRewriteResult != null)
        {
            emitter.asyncIteratorPlans = asyncIteratorRewriteResult.Plans;
        }

        emitter.debugInformation = debugInformation ?? new DebugInformationOptions();
        emitter.pdbStream = pdbStream;

        emitter.EmitCore(peStream);
    }

    private void EmitCore(Stream peStream)
    {
        // Phase 4 (ADR-0027 §7.7a): instantiate the Portable PDB collaborator
        // before any method body is emitted, but only when the caller asked
        // for portable PDBs or for embedded PDBs (Phase 7). Sidecar emission
        // additionally requires a destination stream; embedded emission does
        // not because the blob is written into the PE itself. Leaving
        // `this.pdb` null in every other configuration is what keeps the
        // legacy emit path bit-for-bit identical.
        var format = this.debugInformation.Format;
        var needsPdb = (format == DebugInformationFormat.Portable && this.pdbStream != null)
            || format == DebugInformationFormat.Embedded;
        if (needsPdb)
        {
            this.pdb = new PortablePdbEmitter(this.debugInformation);

            // #217: Wire per-file import information so the PDB emitter can
            // produce per-tree ImportScope rows. Group only the explicit
            // (user-written) imports — implicit ones have a null Declaration
            // and therefore no syntax-tree anchor.
            var importsGrouped = new Dictionary<SyntaxTree, ImmutableArray<ImportSymbol>>();
            foreach (var import in this.program.Imports)
            {
                var tree = import.Declaration?.SyntaxTree;
                if (tree is null)
                {
                    continue;
                }

                if (!importsGrouped.TryGetValue(tree, out var list))
                {
                    list = ImmutableArray<ImportSymbol>.Empty;
                }

                importsGrouped[tree] = list.Add(import);
            }

            this.pdb.SetImportsPerTree(importsGrouped);

            // Wire per-reference metadata so the PDB emitter can produce the
            // CompilationMetadataReferences CDI blob (issue #219).
            this.pdb.SetReferenceInfos(this.references.GetReferenceInfos());
        }

        // 1. Seed Object reference. Resolve from the supplied references so the type-ref
        //    assembly identity (mscorlib / System.Runtime / netstandard) matches the
        //    target framework rather than the gsc host's System.Private.CoreLib.
        this.coreObjectType = this.ResolveCoreType("System.Object", typeof(object));
        this.coreStringType = this.ResolveCoreType("System.String", typeof(string));
        this.coreInt32Type = this.ResolveCoreType("System.Int32", typeof(int));
        this.coreBooleanType = this.ResolveCoreType("System.Boolean", typeof(bool));
        this.coreArrayType = this.ResolveCoreType("System.Array", typeof(System.Array));
        this.coreValueType = this.ResolveCoreType("System.ValueType", typeof(System.ValueType));
        this.coreSystemType = this.ResolveCoreType("System.Type", typeof(System.Type));
        this.coreRuntimeTypeHandleType = this.ResolveCoreType("System.RuntimeTypeHandle", typeof(System.RuntimeTypeHandle));
        this.coreEnumType = this.ResolveCoreType("System.Enum", typeof(System.Enum));
        this.objectTypeRef = this.GetTypeReference(this.coreObjectType);
        this.valueTypeRef = this.GetTypeReference(this.coreValueType);
        this.objectCtorRef = this.GetObjectDefaultCtorReference();

        // Pre-assign FieldDefinitionHandles for user struct fields. Struct
        // TypeDefs are emitted between <Module> and the per-package <Program>
        // types so the field/method-row ranges fall out correctly:
        //
        //   TypeDef 1: <Module>   fieldList=1    methodList=1
        //   TypeDef 2: Struct A   fieldList=1    methodList=1   (owns rows 1..K1)
        //   TypeDef 3: Struct B   fieldList=K1+1 methodList=1   (owns rows K1+1..K2)
        //   TypeDef 4: <Program>  fieldList=N+1  methodList=1
        //
        // Where N = total struct fields. <Module> "owns" rows [1, 1) = none.
        // Phase 4 emit parity (E1+E2): discover all function literals before
        // any row planning. No-capture literals add MethodDef rows alongside
        // user functions; capture-bearing literals are lowered into synthesized
        // closure classes that fold into the existing class TypeDef/method/
        // field row planning. The host package for both is the entry-point
        // package (which always exists for compilable programs that run).
        var lambdaLiterals = this.CollectFunctionLiterals();
        var goStatements = this.CollectGoStatements();
        var hostPackageGuess = this.program.EntryPoint?.Package
            ?? this.program.EntryPointPackage
            ?? (this.program.Packages.IsDefaultOrEmpty ? null : this.program.Packages[0]);
        this.SynthesizeClosures(lambdaLiterals, hostPackageGuess);
        this.SynthesizeGoClosures(goStatements, hostPackageGuess);
        this.SynthesizeIteratorStateMachines(hostPackageGuess);
        this.SynthesizeAsyncIteratorStateMachines(hostPackageGuess);
        this.SynthesizeAsyncLambdaStateMachines(lambdaLiterals, hostPackageGuess);

        // Phase 3.B.4: user-defined interface TypeDefs (planned below).
        // Synthesized closure classes are appended after user aggregates so
        // their TypeDefs come last among the class block; field-row planning
        // walks the combined list so closure fields get well-defined rows.
        var allAggregates = this.program.Structs;
        if (this.synthesizedClosureClasses.Count > 0)
        {
            allAggregates = allAggregates.AddRange(this.synthesizedClosureClasses);
        }

        // Async state-machine types: materialized structs with their hoisted
        // fields are appended so they get TypeDef + FieldDef rows alongside
        // user structs. Method rows (MoveNext, SetStateMachine) are planned
        // separately below.
        var asyncSmStructs = new List<StructSymbol>();
        var asyncSmPlansByStruct = new Dictionary<StructSymbol, AsyncStateMachinePlan>();
        foreach (var plan in this.asyncStateMachinePlans)
        {
            var smStruct = plan.StateMachine.MaterializeAsStructSymbol();
            asyncSmStructs.Add(smStruct);
            asyncSmPlansByStruct[smStruct] = plan;
        }

        if (asyncSmStructs.Count > 0)
        {
            allAggregates = allAggregates.AddRange(asyncSmStructs);
        }

        // Separate state-machine types from non-SM types. SM types will be
        // nested inside their declaring type (<Program> or closure class) per
        // Roslyn convention. To satisfy ECMA-335 §II.22.32 (enclosing row <
        // nested row), <Program> TypeDefs must precede SM TypeDefs.
        var smClassSet = new HashSet<StructSymbol>(
            this.iteratorStateMachineInfos.Keys.Concat(this.asyncIteratorInfos.Keys));
        var smStructSet = new HashSet<StructSymbol>(asyncSmStructs);

        var nonSmClasses = new List<StructSymbol>();
        var smClasses = new List<StructSymbol>();
        var nonSmStructs = new List<StructSymbol>();
        var smStructsOrdered = new List<StructSymbol>();

        foreach (var s in allAggregates)
        {
            if (s.IsClass)
            {
                if (smClassSet.Contains(s))
                {
                    smClasses.Add(s);
                }
                else
                {
                    nonSmClasses.Add(s);
                }
            }
            else
            {
                if (smStructSet.Contains(s))
                {
                    smStructsOrdered.Add(s);
                }
                else
                {
                    nonSmStructs.Add(s);
                }
            }
        }

        var interfaces = this.program.Interfaces;

        // Field-row planning: non-SM types first, then SM types. This ensures
        // fieldList pointers are non-decreasing when <Program> (which owns no
        // fields) sits between non-SM and SM TypeDefs.
        //
        //   TypeDef row order (new):
        //     <Module>   fieldList=1     methodList=1
        //     Interfaces ...
        //     Non-SM classes ...
        //     Non-SM structs ...
        //     <Program>  fieldList=M+1   methodList=...
        //     SM classes fieldList=M+1.. methodList=...
        //     SM structs fieldList=...   methodList=...
        //
        // Where M = total non-SM fields. <Program> owns 0 fields so its
        // fieldList equals the first SM type's fieldList.
        int nextFieldRow = 1;
        var structFirstFieldRow = new Dictionary<StructSymbol, int>();

        // Walk non-SM types for field assignment.
        foreach (var s in nonSmClasses)
        {
            structFirstFieldRow[s] = nextFieldRow;
            nextFieldRow += s.Fields.Length;
            // ADR-0051 Phase 6: backing fields for auto-properties.
            foreach (var p in s.Properties)
            {
                if (p.IsAutoProperty && p.BackingField != null)
                {
                    nextFieldRow++;
                }
            }

            // ADR-0052: backing fields for field-like events.
            foreach (var ev in s.Events)
            {
                if (ev.IsFieldLike && ev.BackingField != null)
                {
                    nextFieldRow++;
                }
            }

            // ADR-0053: static fields from shared block.
            if (!s.StaticFields.IsDefaultOrEmpty)
            {
                nextFieldRow += s.StaticFields.Length;
            }

            // Issue #263: backing fields for static auto-properties.
            foreach (var p in s.StaticProperties)
            {
                if (p.IsAutoProperty && p.BackingField != null)
                {
                    nextFieldRow++;
                }
            }

            // Issue #263: backing fields for static field-like events.
            foreach (var ev in s.StaticEvents)
            {
                if (ev.IsFieldLike && ev.BackingField != null)
                {
                    nextFieldRow++;
                }
            }
        }

        foreach (var s in nonSmStructs)
        {
            structFirstFieldRow[s] = nextFieldRow;
            nextFieldRow += s.Fields.Length;
            // ADR-0051 Phase 6: backing fields for auto-properties.
            foreach (var p in s.Properties)
            {
                if (p.IsAutoProperty && p.BackingField != null)
                {
                    nextFieldRow++;
                }
            }

            // ADR-0052: backing fields for field-like events.
            foreach (var ev in s.Events)
            {
                if (ev.IsFieldLike && ev.BackingField != null)
                {
                    nextFieldRow++;
                }
            }

            // ADR-0053: static fields from shared block.
            if (!s.StaticFields.IsDefaultOrEmpty)
            {
                nextFieldRow += s.StaticFields.Length;
            }

            // Issue #263: backing fields for static auto-properties.
            foreach (var p in s.StaticProperties)
            {
                if (p.IsAutoProperty && p.BackingField != null)
                {
                    nextFieldRow++;
                }
            }

            // Issue #263: backing fields for static field-like events.
            foreach (var ev in s.StaticEvents)
            {
                if (ev.IsFieldLike && ev.BackingField != null)
                {
                    nextFieldRow++;
                }
            }
        }

        // Issue #193: each user-defined enum contributes 1 instance field
        // (value__) plus one literal field per member. Enum field rows are
        // planned right after non-SM struct fields so the enum TypeDef can
        // be emitted between non-SM struct TypeDefs and <Program> without
        // violating the monotone fieldList constraint.
        var enums = this.program.Enums;
        var enumFirstFieldRow = new Dictionary<EnumSymbol, int>();
        foreach (var e in enums)
        {
            enumFirstFieldRow[e] = nextFieldRow;
            nextFieldRow += 1 + e.Members.Length;
        }

        // Issue #191: user-declared top-level var/let/const live as static
        // fields on the entry-point package's <Program> TypeDef. Reserve their
        // field rows immediately before <Program>'s fieldList pointer so the
        // existing monotone constraint holds and programFirstFieldRow points
        // at the first global field (when any). SM struct fields are planned
        // after these globals so SM field rows remain strictly greater than
        // <Program>'s fieldList pointer.
        var globals = this.program.Globals;
        int programFirstFieldRow = nextFieldRow;
        var globalFieldRows = new Dictionary<GlobalVariableSymbol, int>();
        foreach (var g in globals)
        {
            globalFieldRows[g] = nextFieldRow++;
        }

        // SM types get field rows after <Program>'s fieldList pointer.
        foreach (var s in smClasses)
        {
            structFirstFieldRow[s] = nextFieldRow;
            nextFieldRow += s.Fields.Length;
        }

        foreach (var s in smStructsOrdered)
        {
            structFirstFieldRow[s] = nextFieldRow;
            nextFieldRow += s.Fields.Length;
        }

        var moduleFirstFieldRow = 1;

        // Phase 3.B.4: plan method rows for interface abstract methods FIRST.
        // Interface TypeDefs sit between <Module> and the class TypeDefs in
        // row order so their methodList pointer (= first abstract method) is
        // strictly less than the first class ctor row.
        int methodRow = 1;
        var interfaceFirstMethodRow = new Dictionary<InterfaceSymbol, int>();
        foreach (var i in interfaces)
        {
            interfaceFirstMethodRow[i] = methodRow;
            foreach (var m in i.Methods)
            {
                this.methodHandles[m] = MetadataTokens.MethodDefinitionHandle(methodRow++);
            }

            // Plan accessor method rows for interface properties (issue #248).
            foreach (var prop in i.Properties)
            {
                MethodDefinitionHandle? getterHandle = null;
                MethodDefinitionHandle? setterHandle = null;
                if (prop.HasGetter)
                {
                    getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                if (prop.HasSetter)
                {
                    setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                this.propertyAccessorHandles[prop] = (getterHandle, setterHandle);
            }

            // ADR-0052: plan accessor method rows for interface events.
            foreach (var ev in i.Events)
            {
                var addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                var removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                MethodDefinitionHandle? raiseHandle = ev.RaiseMethodSymbol != null ? MetadataTokens.MethodDefinitionHandle(methodRow++) : null;
                this.eventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle);
            }
        }

        // Plan method rows for non-SM class ctors + instance methods.
        var classCtorRows = new Dictionary<StructSymbol, int>();
        var classPrimaryCtorRows = new Dictionary<StructSymbol, int>();
        var aggregateMethodHandles = new Dictionary<FunctionSymbol, MethodDefinitionHandle>();
        foreach (var c in nonSmClasses)
        {
            classCtorRows[c] = methodRow++;

            // Issue #306: a class with an explicit base-constructor initializer
            // emits a single forwarding constructor (no separate parameterless
            // ctor), so reserve only one ctor row in that case.
            if (c.HasPrimaryConstructor && c.BaseConstructorInitializer == null)
            {
                classPrimaryCtorRows[c] = methodRow++;
            }

            if (!c.Methods.IsDefaultOrEmpty)
            {
                foreach (var m in c.Methods)
                {
                    var handle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                    aggregateMethodHandles[m] = handle;
                    this.methodHandles[m] = handle;
                }
            }

            // ADR-0051 Phase 6: plan accessor method rows for class properties.
            foreach (var prop in c.Properties)
            {
                MethodDefinitionHandle? getterHandle = null;
                MethodDefinitionHandle? setterHandle = null;
                if (prop.HasGetter)
                {
                    getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                if (prop.HasSetter)
                {
                    setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                this.propertyAccessorHandles[prop] = (getterHandle, setterHandle);
            }

            // ADR-0052: plan accessor method rows for class events.
            foreach (var ev in c.Events)
            {
                var addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                var removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                MethodDefinitionHandle? raiseHandle = ev.RaiseMethodSymbol != null ? MetadataTokens.MethodDefinitionHandle(methodRow++) : null;
                this.eventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle);
            }

            // ADR-0053: plan method rows for static methods on classes.
            if (!c.StaticMethods.IsDefaultOrEmpty)
            {
                foreach (var m in c.StaticMethods)
                {
                    var handle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                    aggregateMethodHandles[m] = handle;
                    this.methodHandles[m] = handle;
                }
            }

            // Issue #263: plan accessor method rows for static properties on classes.
            foreach (var prop in c.StaticProperties)
            {
                MethodDefinitionHandle? getterHandle = null;
                MethodDefinitionHandle? setterHandle = null;
                if (prop.HasGetter)
                {
                    getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                if (prop.HasSetter)
                {
                    setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                this.propertyAccessorHandles[prop] = (getterHandle, setterHandle);
            }

            // Issue #263: plan accessor method rows for static events on classes.
            foreach (var ev in c.StaticEvents)
            {
                var addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                var removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                MethodDefinitionHandle? raiseHandle = ev.RaiseMethodSymbol != null ? MetadataTokens.MethodDefinitionHandle(methodRow++) : null;
                this.eventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle);
            }

            // Issue #262: plan .cctor row for classes with static field initializers.
            if (!c.StaticFieldInitializers.IsEmpty)
            {
                this.cctorHandles[c] = MetadataTokens.MethodDefinitionHandle(methodRow++);
            }
        }

        // Plan method rows for non-SM structs.
        var structFirstMethodRows = new Dictionary<StructSymbol, int>();
        foreach (var s in nonSmStructs)
        {
            if (s.Methods.IsDefaultOrEmpty && !s.IsInline && s.Properties.IsDefaultOrEmpty && s.Events.IsDefaultOrEmpty && s.StaticMethods.IsDefaultOrEmpty && s.StaticProperties.IsDefaultOrEmpty && s.StaticEvents.IsDefaultOrEmpty && s.StaticFieldInitializers.IsEmpty)
            {
                continue;
            }

            structFirstMethodRows[s] = methodRow;
            if (s.IsInline)
            {
                methodRow += 7;
            }

            foreach (var m in s.Methods)
            {
                var handle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                aggregateMethodHandles[m] = handle;
                this.methodHandles[m] = handle;
            }

            // ADR-0051 Phase 6: plan accessor method rows for struct properties.
            foreach (var prop in s.Properties)
            {
                MethodDefinitionHandle? getterHandle = null;
                MethodDefinitionHandle? setterHandle = null;
                if (prop.HasGetter)
                {
                    getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                if (prop.HasSetter)
                {
                    setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                this.propertyAccessorHandles[prop] = (getterHandle, setterHandle);
            }

            // ADR-0052: plan accessor method rows for struct events.
            foreach (var ev in s.Events)
            {
                var addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                var removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                MethodDefinitionHandle? raiseHandle = ev.RaiseMethodSymbol != null ? MetadataTokens.MethodDefinitionHandle(methodRow++) : null;
                this.eventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle);
            }

            // ADR-0053: plan method rows for static methods on structs.
            if (!s.StaticMethods.IsDefaultOrEmpty)
            {
                foreach (var m in s.StaticMethods)
                {
                    var handle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                    aggregateMethodHandles[m] = handle;
                    this.methodHandles[m] = handle;
                }
            }

            // Issue #263: plan accessor method rows for static properties on structs.
            foreach (var prop in s.StaticProperties)
            {
                MethodDefinitionHandle? getterHandle = null;
                MethodDefinitionHandle? setterHandle = null;
                if (prop.HasGetter)
                {
                    getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                if (prop.HasSetter)
                {
                    setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                this.propertyAccessorHandles[prop] = (getterHandle, setterHandle);
            }

            // Issue #263: plan accessor method rows for static events on structs.
            foreach (var ev in s.StaticEvents)
            {
                var addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                var removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                MethodDefinitionHandle? raiseHandle = ev.RaiseMethodSymbol != null ? MetadataTokens.MethodDefinitionHandle(methodRow++) : null;
                this.eventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle);
            }

            // Issue #262: plan .cctor row for structs with static field initializers.
            if (!s.StaticFieldInitializers.IsEmpty)
            {
                this.cctorHandles[s] = MetadataTokens.MethodDefinitionHandle(methodRow++);
            }
        }

        int firstPackageCtorRow = methodRow;

        // 2. <Module> type (TypeDef row #1 must always be <Module> per ECMA-335).
        this.metadata.AddTypeDefinition(
            attributes: default(TypeAttributes),
            @namespace: default(StringHandle),
            name: this.metadata.GetOrAddString("<Module>"),
            baseType: default(EntityHandle),
            fieldList: MetadataTokens.FieldDefinitionHandle(moduleFirstFieldRow),
            methodList: MetadataTokens.MethodDefinitionHandle(1));

        // 2a. Phase 3.B.4: Emit interface TypeDefs + their abstract method
        // rows. Interfaces have no fields and only abstract method bodies, so
        // they are the simplest TypeDefs to emit. Their methodList points at
        // the first of their reserved abstract method rows.
        foreach (var i in interfaces)
        {
            this.EmitInterfaceTypeDef(i, interfaceFirstMethodRow[i], 1);
        }

        // 2b. Emit non-SM class TypeDefs (so methodLists stay non-decreasing),
        // then non-SM struct TypeDefs. SM types are emitted AFTER <Program>.
        foreach (var c in nonSmClasses)
        {
            this.EmitStructTypeDef(c, structFirstFieldRow[c], classCtorRows[c]);

            if (!c.Interfaces.IsDefaultOrEmpty)
            {
                foreach (var iface in c.Interfaces)
                {
                    if (this.interfaceTypeDefs.TryGetValue(iface, out var ifaceHandle))
                    {
                        this.metadata.AddInterfaceImplementation(this.structTypeDefs[c], ifaceHandle);
                    }
                }
            }
        }

        foreach (var s in nonSmStructs)
        {
            // Issue #242: the ECMA-335 methodList column must be monotonically
            // non-decreasing across TypeDef rows. Structs without methods must
            // use the NEXT available method row (i.e., the first method row of
            // the next struct that HAS methods, or firstPackageCtorRow). We
            // compute this by scanning forward.
            int methodListRow;
            if (structFirstMethodRows.TryGetValue(s, out var firstStructMethodRow))
            {
                methodListRow = firstStructMethodRow;
            }
            else
            {
                // Find the next struct (in emission order) that has methods.
                methodListRow = firstPackageCtorRow;
                bool foundSelf = false;
                foreach (var s2 in nonSmStructs)
                {
                    if (ReferenceEquals(s2, s))
                    {
                        foundSelf = true;
                        continue;
                    }

                    if (foundSelf && structFirstMethodRows.TryGetValue(s2, out var nextMethodRow))
                    {
                        methodListRow = nextMethodRow;
                        break;
                    }
                }
            }

            this.EmitStructTypeDef(s, structFirstFieldRow[s], methodListRow);
        }

        // Issue #193: emit enum TypeDefs between non-SM structs and <Program>.
        // Each enum has no methods, so its methodList points at the same row
        // <Program>'s package ctor will live (firstPackageCtorRow).
        foreach (var e in enums)
        {
            this.EmitEnumTypeDef(e, enumFirstFieldRow[e], firstPackageCtorRow);
        }

        // 3. Group functions by their declaring package. One <Program> type
        //    is emitted per package, in BoundProgram.Packages declaration
        //    order; method-row layout for each package is:
        //        package.ctor  → [package's non-entry user fns]  → [package's entry point if any]
        //    The entry-point function (if any) is placed last in its package
        //    so the EntryPoint token resolves cleanly.
        var packages = this.program.Packages.IsDefaultOrEmpty
            ? ImmutableArray.Create(this.program.EntryPointPackage ?? new PackageSymbol("Default", declaration: null))
            : this.program.Packages;

        var functionsByPackage = new Dictionary<PackageSymbol, List<FunctionSymbol>>();
        foreach (var pkg in packages)
        {
            functionsByPackage[pkg] = new List<FunctionSymbol>();
        }

        foreach (var kvp in this.program.Functions)
        {
            if (kvp.Key == this.program.EntryPoint)
            {
                continue;
            }

            // Class instance methods are owned by their class TypeDef, not by
            // a package's <Program> container.
            if (kvp.Key.IsInstanceMethod)
            {
                continue;
            }

            // ADR-0053: static methods on structs/classes are emitted as part of
            // their owning TypeDef, not as package-level functions.
            if (kvp.Key.IsStatic && aggregateMethodHandles.ContainsKey(kvp.Key))
            {
                continue;
            }

            var owningPackage = kvp.Key.Package ?? this.program.EntryPointPackage ?? packages[0];
            if (!functionsByPackage.TryGetValue(owningPackage, out var bucket))
            {
                bucket = new List<FunctionSymbol>();
                functionsByPackage[owningPackage] = bucket;
                packages = packages.Add(owningPackage);
            }

            bucket.Add(kvp.Key);
        }

        var entryPointPackage = this.program.EntryPoint?.Package ?? this.program.EntryPointPackage;

        // Phase 4 emit parity (E1): non-capture function literals are attached
        // to the entry-point package's <Program> container as ordinary static
        // methods. Capture-bearing literals were already redirected into
        // closure-class invoke methods by SynthesizeClosures, so we skip them
        // here.
        var lambdaHostPackage = entryPointPackage ?? packages[0];
        if (lambdaLiterals.Count > 0)
        {
            if (!functionsByPackage.TryGetValue(lambdaHostPackage, out var hostBucket))
            {
                hostBucket = new List<FunctionSymbol>();
                functionsByPackage[lambdaHostPackage] = hostBucket;
                packages = packages.Add(lambdaHostPackage);
            }

            foreach (var literal in lambdaLiterals)
            {
                if (literal.CapturedVariables.Length > 0)
                {
                    continue;
                }

                this.lambdaBodies[literal.Function] = literal.Body;
                hostBucket.Add(literal.Function);
            }
        }

        // Plan method rows for packages (per-package ctor + functions + entry).
        var packageCtorRows = new Dictionary<PackageSymbol, int>();
        var nextRow = firstPackageCtorRow;
        foreach (var pkg in packages)
        {
            packageCtorRows[pkg] = nextRow++;
            foreach (var fn in functionsByPackage[pkg])
            {
                this.functionHandles[fn] = MetadataTokens.MethodDefinitionHandle(nextRow++);
            }

            if (this.program.EntryPoint is not null && pkg == entryPointPackage)
            {
                this.functionHandles[this.program.EntryPoint] = MetadataTokens.MethodDefinitionHandle(nextRow++);
            }
        }

        // Plan method rows for SM classes (after package methods).
        int firstSmClassMethodRow = nextRow;
        foreach (var c in smClasses)
        {
            classCtorRows[c] = nextRow++;
            if (c.HasPrimaryConstructor)
            {
                classPrimaryCtorRows[c] = nextRow++;
            }

            if (!c.Methods.IsDefaultOrEmpty)
            {
                foreach (var m in c.Methods)
                {
                    var handle = MetadataTokens.MethodDefinitionHandle(nextRow++);
                    aggregateMethodHandles[m] = handle;
                    this.methodHandles[m] = handle;
                }
            }
        }

        // Plan method rows for SM structs (MoveNext + SetStateMachine each).
        foreach (var s in smStructsOrdered)
        {
            structFirstMethodRows[s] = nextRow;
            nextRow += 2; // MoveNext, SetStateMachine
        }

        MethodDefinitionHandle entryHandle = default;
        if (this.program.EntryPoint is not null)
        {
            entryHandle = this.functionHandles[this.program.EntryPoint];
        }

        // Pre-register SM class ctor handles so iterator kickoff bodies
        // (emitted during B4) can reference them for newobj calls.
        foreach (var c in smClasses)
        {
            this.classCtorHandles[c] = MetadataTokens.MethodDefinitionHandle(classCtorRows[c]);
        }

        // === PHASE A: Emit remaining TypeDefs (Program + SM) ===
        // <Program> TypeDefs BEFORE SM TypeDefs (ECMA-335 §II.22.32: enclosing row < nested row).
        var programTypeDefHandles = new Dictionary<PackageSymbol, TypeDefinitionHandle>();

        // Issue #191: emit global FieldDefs into the entry-point package's
        // <Program> field range. The entry-point package's <Program> TypeDef
        // is emitted first so its fieldList (= start of globals) is strictly
        // less than every subsequent <Program>'s fieldList (= past globals).
        var globalsHostPkg = entryPointPackage
            ?? (packages.IsDefaultOrEmpty ? null : packages[0]);
        if (globals.Length > 0 && globalsHostPkg != null && packages.Contains(globalsHostPkg))
        {
            // Globals whose type is a constructed generic (e.g. Box[int]) need
            // the alias map populated so EncodeTypeSymbol can resolve the
            // constructed StructSymbol to its definition's TypeDef. We call
            // RegisterConstructedTypeAliases again later (line 798) to pick
            // up ctor handles populated during the rest of Phase A.
            this.RegisterConstructedTypeAliases();
            this.EmitGlobalFieldDefs(globals);

            var programHandle = this.metadata.AddTypeDefinition(
                attributes: TypeAttributes.Class | TypeAttributes.Public | TypeAttributes.AutoLayout
                    | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit,
                @namespace: this.metadata.GetOrAddString(globalsHostPkg.Name),
                name: this.metadata.GetOrAddString("<Program>"),
                baseType: this.objectTypeRef,
                fieldList: MetadataTokens.FieldDefinitionHandle(programFirstFieldRow),
                methodList: MetadataTokens.MethodDefinitionHandle(packageCtorRows[globalsHostPkg]));
            programTypeDefHandles[globalsHostPkg] = programHandle;
        }

        foreach (var pkg in packages)
        {
            if (programTypeDefHandles.ContainsKey(pkg))
            {
                continue;
            }

            // Packages without globals (or non-entry-point packages when globals
            // were emitted above) point their fieldList past the global field
            // range so the monotone <Program> fieldList constraint holds.
            var fieldListRow = programFirstFieldRow + globals.Length;
            var programHandle = this.metadata.AddTypeDefinition(
                attributes: TypeAttributes.Class | TypeAttributes.Public | TypeAttributes.AutoLayout
                    | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit,
                @namespace: this.metadata.GetOrAddString(pkg.Name),
                name: this.metadata.GetOrAddString("<Program>"),
                baseType: this.objectTypeRef,
                fieldList: MetadataTokens.FieldDefinitionHandle(fieldListRow),
                methodList: MetadataTokens.MethodDefinitionHandle(packageCtorRows[pkg]));
            programTypeDefHandles[pkg] = programHandle;
        }

        // SM class TypeDefs (sync iterators + async iterators).
        foreach (var c in smClasses)
        {
            this.EmitNestedStructTypeDef(c, structFirstFieldRow[c], classCtorRows[c]);

            if (this.iteratorStateMachineInfos.TryGetValue(c, out var iteratorInfo))
            {
                this.AddIteratorInterfaceImplementations(c, iteratorInfo);
            }

            if (this.asyncIteratorInfos.TryGetValue(c, out var asyncIterPlan))
            {
                this.AddAsyncIteratorInterfaceImplementations(c, asyncIterPlan);
            }
        }

        // SM struct TypeDefs (async method/lambda state machines).
        foreach (var s in smStructsOrdered)
        {
            var smMethodListRow = structFirstMethodRows[s];
            this.EmitNestedStructTypeDef(s, structFirstFieldRow[s], smMethodListRow);

            var iAsyncSmType = typeof(System.Runtime.CompilerServices.IAsyncStateMachine);
            var iAsyncSmRef = this.GetTypeReference(iAsyncSmType);
            this.metadata.AddInterfaceImplementation(this.structTypeDefs[s], iAsyncSmRef);
        }

        // === PHASE B: Emit MethodDefs in row order ===
        // B1. Interface abstract methods.
        foreach (var i in interfaces)
        {
            foreach (var m in i.Methods)
            {
                this.EmitAbstractMethod(m);
            }

            // Issue #248: emit abstract accessor MethodDefs + PropertyDef rows for interface properties.
            this.EmitInterfacePropertyAccessors(i);

            // ADR-0052: emit abstract accessor MethodDefs + EventDef rows for interface events.
            this.EmitInterfaceEventAccessors(i);
        }

        // B2. Non-SM class ctors + instance methods.
        foreach (var c in nonSmClasses)
        {
            if (c.ExplicitConstructor != null)
            {
                // Issue #306: a class with an explicit `init(...)` constructor
                // emits exactly one `.ctor` (the user constructor). It serves as
                // both the base-chain target and the `newobj` target.
                var explicitHandle = this.EmitClassConstructorWithBody(c);
                this.classCtorHandles[c] = explicitHandle;
                this.classPrimaryCtorHandles[c] = explicitHandle;
            }
            else if (c.BaseConstructorInitializer != null)
            {
                // Issue #306: emit a single constructor that forwards arguments
                // to the resolved base ctor. When a primary constructor is
                // present its parameters drive both the forwarded arguments and
                // the field initialization; otherwise the forwarding ctor is
                // parameterless (constant base arguments). No separate
                // parameterless ctor is emitted because the base may lack one.
                var ctorParams = c.HasPrimaryConstructor
                    ? c.PrimaryConstructorParameters
                    : ImmutableArray<ParameterSymbol>.Empty;
                var forwardingHandle = this.EmitClassConstructorWithBaseInitializer(c, ctorParams);
                this.classCtorHandles[c] = forwardingHandle;
                this.classPrimaryCtorHandles[c] = forwardingHandle;
            }
            else
            {
                var ctorHandle = this.EmitClassDefaultConstructor(c);
                this.classCtorHandles[c] = ctorHandle;

                if (c.HasPrimaryConstructor)
                {
                    var primaryHandle = this.EmitClassPrimaryConstructor(c);
                    this.classPrimaryCtorHandles[c] = primaryHandle;
                }
            }

            if (!c.Methods.IsDefaultOrEmpty)
            {
                foreach (var m in c.Methods)
                {
                    if (!this.program.Functions.TryGetValue(m, out var body))
                    {
                        body = this.lambdaBodies[m];
                    }

                    var emittedHandle = this.EmitFunction(m, body, isEntryPoint: false);
                    this.methodHandles[m] = emittedHandle;
                }
            }

            // ADR-0051 Phase 6: emit property accessor methods for classes.
            this.EmitPropertyAccessors(c);

            // ADR-0052: emit event accessor methods for classes.
            this.EmitEventAccessors(c);

            // ADR-0053: emit static methods for classes.
            if (!c.StaticMethods.IsDefaultOrEmpty)
            {
                foreach (var m in c.StaticMethods)
                {
                    if (this.program.Functions.TryGetValue(m, out var staticBody))
                    {
                        var emittedHandle = this.EmitFunction(m, staticBody, isEntryPoint: false);
                        this.methodHandles[m] = emittedHandle;
                    }
                }
            }

            // Issue #263: emit static property accessor methods for classes.
            this.EmitStaticPropertyAccessors(c);

            // Issue #263: emit static event accessor methods for classes.
            this.EmitStaticEventAccessors(c);

            // Issue #262: emit .cctor for classes with static field initializers.
            if (this.cctorHandles.ContainsKey(c))
            {
                this.EmitStaticConstructor(c);
            }
        }

        // 4b. Non-SM struct methods.
        foreach (var s in nonSmStructs)
        {
            if (s.IsInline)
            {
                this.EmitInlineStructSynthesizedMembers(s);
            }

            if (s.Methods.IsDefaultOrEmpty && s.Properties.IsDefaultOrEmpty && s.Events.IsDefaultOrEmpty && s.StaticMethods.IsDefaultOrEmpty && s.StaticProperties.IsDefaultOrEmpty && s.StaticEvents.IsDefaultOrEmpty && s.StaticFieldInitializers.IsEmpty)
            {
                continue;
            }

            foreach (var m in s.Methods)
            {
                if (!this.program.Functions.TryGetValue(m, out var body))
                {
                    body = this.lambdaBodies[m];
                }

                var emittedHandle = this.EmitFunction(m, body, isEntryPoint: false);
                this.methodHandles[m] = emittedHandle;
            }

            // ADR-0051 Phase 6: emit property accessor methods for structs.
            this.EmitPropertyAccessors(s);

            // ADR-0052: emit event accessor methods for structs.
            this.EmitEventAccessors(s);

            // ADR-0053: emit static methods for structs.
            if (!s.StaticMethods.IsDefaultOrEmpty)
            {
                foreach (var m in s.StaticMethods)
                {
                    if (this.program.Functions.TryGetValue(m, out var staticBody))
                    {
                        var emittedHandle = this.EmitFunction(m, staticBody, isEntryPoint: false);
                        this.methodHandles[m] = emittedHandle;
                    }
                }
            }

            // Issue #263: emit static property accessor methods for structs.
            this.EmitStaticPropertyAccessors(s);

            // Issue #263: emit static event accessor methods for structs.
            this.EmitStaticEventAccessors(s);

            // Issue #262: emit .cctor for structs with static field initializers.
            if (this.cctorHandles.ContainsKey(s))
            {
                this.EmitStaticConstructor(s);
            }
        }

        // Phase 4 emit parity (F2, type-erased): now that every generic
        // definition has its TypeDef + FieldDefs + ctor handles in the
        // lookup dictionaries, walk the bound program for constructed
        // StructSymbols (Box[int], Pair[string, int], ...) and alias them
        // to their definitions' rows.
        this.RegisterConstructedTypeAliases();

        // B4. Per-package methods (ctor + user functions + entry).
        foreach (var pkg in packages)
        {
            this.EmitDefaultConstructor();

            foreach (var fn in functionsByPackage[pkg])
            {
                if (!this.program.Functions.TryGetValue(fn, out var body))
                {
                    body = this.lambdaBodies[fn];
                }

                this.EmitFunction(fn, body, isEntryPoint: false);
            }

            if (this.program.EntryPoint is not null && pkg == entryPointPackage)
            {
                var entryBody = this.program.Functions[this.program.EntryPoint];
                this.EmitFunction(this.program.EntryPoint, entryBody, isEntryPoint: true);
            }
        }

        // B5. SM class method bodies (ctors + instance methods).
        foreach (var c in smClasses)
        {
            var ctorHandle = this.EmitClassDefaultConstructor(c);
            this.classCtorHandles[c] = ctorHandle;

            if (c.HasPrimaryConstructor)
            {
                var primaryHandle = this.EmitClassPrimaryConstructor(c);
                this.classPrimaryCtorHandles[c] = primaryHandle;
            }

            if (!c.Methods.IsDefaultOrEmpty)
            {
                foreach (var m in c.Methods)
                {
                    if (!this.program.Functions.TryGetValue(m, out var body))
                    {
                        body = this.lambdaBodies[m];
                    }

                    var emittedHandle = this.EmitFunction(m, body, isEntryPoint: false);
                    this.methodHandles[m] = emittedHandle;
                }
            }
        }

        // B6. SM struct method bodies (MoveNext + SetStateMachine).
        foreach (var s in smStructsOrdered)
        {
            if (asyncSmPlansByStruct.TryGetValue(s, out var smPlan))
            {
                this.EmitStateMachineMoveNext(smPlan);
                this.EmitStateMachineSetStateMachine(smPlan);
            }
        }

        // NestedType entries. Each SM is nested inside its declaring type:
        // capture-bearing async lambda SMs inside their closure class,
        // all others inside the per-package <Program>.
        var hostPkg = entryPointPackage ?? (packages.IsDefaultOrEmpty ? null : packages[0]);
        var defaultProgramHandle = hostPkg != null && programTypeDefHandles.TryGetValue(hostPkg, out var h) ? h : default;

        foreach (var c in smClasses)
        {
            var nestedHandle = this.structTypeDefs[c];
            var smPkg = this.GetSmPackage(c, packages, entryPointPackage);
            var enclosingHandle = programTypeDefHandles.TryGetValue(smPkg, out var ph) ? ph : defaultProgramHandle;
            this.metadata.AddNestedType(nestedHandle, enclosingHandle);
        }

        foreach (var s in smStructsOrdered)
        {
            var nestedHandle = this.structTypeDefs[s];
            if (this.asyncSmEnclosingClosures.TryGetValue(s, out var closureSym)
                && this.structTypeDefs.TryGetValue(closureSym, out var closureHandle))
            {
                this.metadata.AddNestedType(nestedHandle, closureHandle);
            }
            else
            {
                var smPkg = this.GetSmPackage(s, packages, entryPointPackage);
                var enclosingHandle = programTypeDefHandles.TryGetValue(smPkg, out var ph) ? ph : defaultProgramHandle;
                this.metadata.AddNestedType(nestedHandle, enclosingHandle);
            }
        }

        // 6. Module + assembly rows. Reserve the MVID guid heap slot so we can
        // patch it with a content-derived value after PE serialization.
        var assemblyName = this.assemblyNameOverride ?? this.program.PackageName ?? "Default";
        var mvidFixup = this.metadata.ReserveGuid();
        this.metadata.AddModule(
            generation: 0,
            moduleName: this.metadata.GetOrAddString(assemblyName + ".dll"),
            mvid: mvidFixup.Handle,
            encId: default(GuidHandle),
            encBaseId: default(GuidHandle));

        var assemblyHandle = this.metadata.AddAssembly(
            name: this.metadata.GetOrAddString(assemblyName),
            version: this.ParseAssemblyVersion(),
            culture: default(StringHandle),
            publicKey: default(BlobHandle),
            flags: 0,
            hashAlgorithm: AssemblyHashAlgorithm.Sha1);

        if (this.metadataOnly)
        {
            this.EmitReferenceAssemblyAttribute(assemblyHandle);
        }

        // Phase 7.7b: emit cross-language interop attributes for NuGet consumability.
        this.EmitAssemblyInteropAttributes(assemblyHandle);
        if (!this.metadataOnly && this.pdb != null)
        {
            this.EmitDebuggableAttribute(assemblyHandle);
        }

        // 7. Build the Portable PDB blob FIRST so we can wire its content id
        // (CodeView), SHA-256 checksum (PdbChecksum), and — when embedded —
        // the blob itself into the PE's DebugDirectory. PortablePdbEmitter
        // does not touch any stream here; we own sidecar / embedded routing.
        BlobBuilder pdbBlob = null;
        BlobContentId pdbContentId = default;
        byte[] pdbChecksum = null;
        var pdbEnabled = this.pdb != null;
        if (pdbEnabled)
        {
            var peRowCounts = this.metadata.GetRowCounts();
            (pdbBlob, pdbContentId) = this.pdb.Serialize(
                peRowCounts,
                this.metadataOnly ? default : entryHandle,
                ComputeDeterministicContentId);
            pdbChecksum = ComputePdbChecksum(pdbBlob);
        }

        // 8. Construct a DebugDirectoryBuilder when PDB emit is on, so the PE
        // image gains a real CodeView entry (sidecar discovery), PdbChecksum
        // entry (PE ↔ PDB pairing), Reproducible entry (deterministic emit),
        // and — when embedded — an EmbeddedPortablePdb entry containing the
        // full PDB blob inline. Pass null to ManagedPEBuilder when PDB is off
        // so the legacy emit path stays bit-for-bit identical.
        DebugDirectoryBuilder debugDirectory = null;
        var isEmbedded = this.debugInformation.Format == DebugInformationFormat.Embedded;
        if (pdbEnabled)
        {
            debugDirectory = new DebugDirectoryBuilder();

            // CodeView: identifies the PDB the runtime/debugger should fetch.
            // For embedded format the path is conventionally just the bare
            // pdb file name (no directory) because the consumer reads it out
            // of the PE itself; for sidecar it must be an absolute path so
            // vsdbg/coreclr can locate the sidecar regardless of the
            // debugger's working directory. A relative path here would leave
            // breakpoints unbound. Mirrors the source-path fix in 34002ff.
            string codeViewPath;
            if (!string.IsNullOrEmpty(this.debugInformation.PdbFilePath))
            {
                codeViewPath = isEmbedded
                    ? Path.GetFileName(this.debugInformation.PdbFilePath)
                    : Path.GetFullPath(this.debugInformation.PdbFilePath);
            }
            else
            {
                codeViewPath = (this.assemblyNameOverride ?? this.program.PackageName ?? "module") + ".pdb";
            }

            debugDirectory.AddCodeViewEntry(
                pdbPath: codeViewPath,
                pdbContentId: pdbContentId,
                portablePdbVersion: PortablePdbVersion);

            // PdbChecksum: always emitted; lets symbol servers verify PE↔PDB
            // by content hash without trusting the file path.
            debugDirectory.AddPdbChecksumEntry(
                algorithmName: "SHA256",
                checksum: ImmutableArray.Create(pdbChecksum));

            // Reproducible: opt-in marker that this build is byte-deterministic.
            if (this.debugInformation.Deterministic)
            {
                debugDirectory.AddReproducibleEntry();
            }

            // EmbeddedPortablePdb: only when /debug:embedded was requested.
            // The blob is compressed inside the PE; readers transparently
            // inflate via System.Reflection.PortableExecutable.PEReader.
            if (isEmbedded)
            {
                debugDirectory.AddEmbeddedPortablePdbEntry(pdbBlob, PortablePdbVersion);
            }
        }

        // 9. Serialize PE deterministically: a SHA-256 of the serialized PE
        // content produces the BlobContentId, which patches both the PE
        // TimeDateStamp and the reserved MVID guid in the metadata heap.
        // For reference assemblies we use MvidPEBuilder which adds a .mvid
        // PE section so MSBuild's CopyRefAssembly can efficiently extract
        // the module version identifier without loading full metadata.
        var peHeaderBuilder = new PEHeaderBuilder(
            imageCharacteristics: entryHandle.IsNil
                ? Characteristics.Dll | Characteristics.ExecutableImage
                : Characteristics.ExecutableImage);
        var peBlob = new BlobBuilder();
        BlobContentId contentId;
        if (this.metadataOnly)
        {
            var mvidBuilder = new MvidPEBuilder(
                header: peHeaderBuilder,
                metadataRootBuilder: new MetadataRootBuilder(this.metadata),
                ilStream: this.ilStream,
                entryPoint: default,
                debugDirectoryBuilder: debugDirectory,
                deterministicIdProvider: ComputeDeterministicContentId);
            contentId = mvidBuilder.Serialize(peBlob, out var mvidSectionFixup);
            new BlobWriter(mvidSectionFixup).WriteGuid(contentId.Guid);
        }
        else
        {
            var peBuilder = new ManagedPEBuilder(
                header: peHeaderBuilder,
                metadataRootBuilder: new MetadataRootBuilder(this.metadata),
                ilStream: this.ilStream,
                entryPoint: entryHandle,
                debugDirectoryBuilder: debugDirectory,
                deterministicIdProvider: ComputeDeterministicContentId);
            contentId = peBuilder.Serialize(peBlob);
        }

        mvidFixup.CreateWriter().WriteGuid(contentId.Guid);
        peBlob.WriteContentTo(peStream);

        // 10. Phase 4–7 PDB sidecar routing. Embedded format suppresses the
        // sidecar — the blob already lives in the PE. Portable format writes
        // to the supplied stream when one was provided (callers that want
        // only an embedded PDB pass `pdbStream: null`).
        if (pdbEnabled && !isEmbedded && this.pdbStream != null)
        {
            pdbBlob.WriteContentTo(this.pdbStream);
        }
    }

    /// <summary>
    /// Computes the SHA-256 checksum of the serialized Portable PDB content,
    /// matching the algorithm name written into the <c>PdbChecksum</c> debug
    /// directory entry. Returning a fresh byte array keeps callers from
    /// having to thread <see cref="IncrementalHash"/> through the call site.
    /// </summary>
    private static byte[] ComputePdbChecksum(BlobBuilder pdbBlob)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var blob in pdbBlob.GetBlobs())
        {
            var bytes = blob.GetBytes();
            sha.AppendData(bytes.Array, bytes.Offset, bytes.Count);
        }

        return sha.GetHashAndReset();
    }

    /// <summary>
    /// Marks the assembly with
    /// <c>System.Runtime.CompilerServices.ReferenceAssemblyAttribute()</c> so
    /// loaders treat it as metadata-only and refuse to execute its (absent)
    /// method bodies.
    /// </summary>
    private void EmitReferenceAssemblyAttribute(AssemblyDefinitionHandle assemblyHandle)
    {
        var attrType = this.references.TryResolveType("System.Runtime.CompilerServices.ReferenceAssemblyAttribute", out var resolved)
            ? resolved
            : throw new InvalidOperationException(
                "Reference assembly emit requires System.Runtime.CompilerServices.ReferenceAssemblyAttribute to be resolvable from the supplied references.");
        var attrTypeRef = this.GetTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });

        var ctorRef = this.metadata.AddMemberReference(
            attrTypeRef,
            this.metadata.GetOrAddString(".ctor"),
            this.metadata.GetOrAddBlob(ctorSig));

        // Empty fixed/named argument blob: prolog 0x0001 + 0 named args.
        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        valueBlob.WriteUInt16(0);

        this.metadata.AddCustomAttribute(
            parent: assemblyHandle,
            constructor: ctorRef,
            value: this.metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Parses <see cref="assemblyVersionOverride"/> into a <see cref="Version"/> suitable
    /// for the assembly row. Falls back to <c>1.0.0.0</c> when the string is absent or
    /// does not parse as a version.
    /// </summary>
    private Version ParseAssemblyVersion()
    {
        if (string.IsNullOrEmpty(this.assemblyVersionOverride))
        {
            return new Version(1, 0, 0, 0);
        }

        // NuGet versions can contain pre-release suffixes (e.g. "1.2.3-beta.1").
        // Extract just the numeric prefix for System.Version.
        var versionStr = this.assemblyVersionOverride;
        var dashIdx = versionStr.IndexOf('-');
        if (dashIdx >= 0)
        {
            versionStr = versionStr.Substring(0, dashIdx);
        }

        var plusIdx = versionStr.IndexOf('+');
        if (plusIdx >= 0)
        {
            versionStr = versionStr.Substring(0, plusIdx);
        }

        if (Version.TryParse(versionStr, out var v))
        {
            // Pad to four components for ECMA-335 assembly identity.
            return new Version(
                Math.Max(v.Major, 0),
                Math.Max(v.Minor, 0),
                Math.Max(v.Build, 0),
                Math.Max(v.Revision, 0));
        }

        return new Version(1, 0, 0, 0);
    }

    /// <summary>
    /// Emits assembly-level attributes required for cross-language interop (C#/F#
    /// consumability): <c>AssemblyInformationalVersionAttribute</c>,
    /// <c>AssemblyMetadataAttribute("RepositoryUrl", ...)</c>, and
    /// <c>NullableContextAttribute(1)</c>.
    /// </summary>
    private void EmitAssemblyInteropAttributes(AssemblyDefinitionHandle assemblyHandle)
    {
        // 1. AssemblyInformationalVersionAttribute — carries the full NuGet
        // version string including pre-release suffix.
        if (!string.IsNullOrEmpty(this.assemblyVersionOverride))
        {
            this.EmitStringAttribute(
                assemblyHandle,
                "System.Reflection.AssemblyInformationalVersionAttribute",
                typeof(System.Reflection.AssemblyInformationalVersionAttribute),
                this.assemblyVersionOverride);
        }

        // 2. NullableContextAttribute(1) — declares the assembly's default
        // nullable context as "annotated" so C# consumers see non-null by
        // default for GSharp types (GSharp has no null references).
        this.EmitNullableContextAttribute(assemblyHandle);
    }

    /// <summary>
    /// Emits <c>System.Diagnostics.DebuggableAttribute(true, true)</c> when
    /// debug information is present so managed debuggers treat the assembly as
    /// JIT-tracked and non-optimized.
    /// </summary>
    private void EmitDebuggableAttribute(AssemblyDefinitionHandle assemblyHandle)
    {
        var attrType = this.references.TryResolveType("System.Diagnostics.DebuggableAttribute", out var resolved)
            ? resolved
            : typeof(System.Diagnostics.DebuggableAttribute);
        var attrTypeRef = this.GetTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(2, r => r.Void(), p =>
            {
                p.AddParameter().Type().Boolean();
                p.AddParameter().Type().Boolean();
            });

        var ctorRef = this.metadata.AddMemberReference(
            attrTypeRef,
            this.metadata.GetOrAddString(".ctor"),
            this.metadata.GetOrAddBlob(ctorSig));

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001); // Prolog
        valueBlob.WriteBoolean(true);  // isJITTrackingEnabled
        valueBlob.WriteBoolean(true);  // isJITOptimizerDisabled
        valueBlob.WriteUInt16(0);      // NumNamed

        this.metadata.AddCustomAttribute(
            parent: assemblyHandle,
            constructor: ctorRef,
            value: this.metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Emits a custom attribute whose sole constructor parameter is a single
    /// <see cref="string"/> argument.
    /// </summary>
    private void EmitStringAttribute(EntityHandle parent, string typeName, Type fallbackType, string value)
    {
        var attrType = this.references.TryResolveType(typeName, out var resolved)
            ? resolved
            : fallbackType;
        var attrTypeRef = this.GetTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(1, r => r.Void(), p => p.AddParameter().Type().String());

        var ctorRef = this.metadata.AddMemberReference(
            attrTypeRef,
            this.metadata.GetOrAddString(".ctor"),
            this.metadata.GetOrAddBlob(ctorSig));

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001); // Prolog
        valueBlob.WriteSerializedString(value);
        valueBlob.WriteUInt16(0); // NumNamed

        this.metadata.AddCustomAttribute(
            parent: parent,
            constructor: ctorRef,
            value: this.metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Emits <c>System.Runtime.CompilerServices.NullableContextAttribute(1)</c>
    /// on the assembly so C# consumers see GSharp public surface as non-nullable
    /// (oblivious context = 0, annotated = 1, warnings-only = 2).
    /// </summary>
    private void EmitNullableContextAttribute(AssemblyDefinitionHandle assemblyHandle)
    {
        if (!this.references.TryResolveType("System.Runtime.CompilerServices.NullableContextAttribute", out var attrType))
        {
            // The attribute may not exist in older TFMs — skip silently.
            return;
        }

        var attrTypeRef = this.GetTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(1, r => r.Void(), p => p.AddParameter().Type().Byte());

        var ctorRef = this.metadata.AddMemberReference(
            attrTypeRef,
            this.metadata.GetOrAddString(".ctor"),
            this.metadata.GetOrAddBlob(ctorSig));

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001); // Prolog
        valueBlob.WriteByte(1);        // Flag = Annotated (non-null by default)
        valueBlob.WriteUInt16(0);      // NumNamed

        this.metadata.AddCustomAttribute(
            parent: assemblyHandle,
            constructor: ctorRef,
            value: this.metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Derives the module MVID and PE timestamp from a SHA-256 hash of the
    /// serialized PE content blobs, mirroring Roslyn's deterministic emit so
    /// the same bound program always produces a byte-for-byte identical PE.
    /// </summary>
    private static BlobContentId ComputeDeterministicContentId(IEnumerable<Blob> content)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var blob in content)
        {
            var bytes = blob.GetBytes();
            sha.AppendData(bytes.Array, bytes.Offset, bytes.Count);
        }

        return BlobContentId.FromHash(sha.GetHashAndReset());
    }

    /// <summary>
    /// Converts the per-method <c>locals</c> dictionary used during IL emit
    /// into a stable, slot-ordered list suitable for the Portable PDB
    /// <c>LocalVariable</c> table. Compiler-generated names (synthesized by
    /// lowering) are reported with <see cref="LocalInfo.IsCompilerGenerated"/>
    /// set so debuggers can hide them from the locals window.
    /// </summary>
    private static IReadOnlyList<LocalInfo> CollectLocalInfo(Dictionary<VariableSymbol, int> locals)
    {
        if (locals == null || locals.Count == 0)
        {
            return System.Array.Empty<LocalInfo>();
        }

        var result = new List<LocalInfo>(locals.Count);
        foreach (var kvp in locals)
        {
            var name = kvp.Key.Name ?? string.Empty;
            var isGenerated = name.Length == 0
                || name[0] == '<'
                || name[0] == '$'
                || name.Contains('$');
            if (isGenerated && name.Length == 0)
            {
                // Anonymous slot — give it a deterministic placeholder so the
                // PDB row is still valid (debuggers ignore hidden names).
                name = "<slot" + kvp.Value + ">";
            }

            result.Add(new LocalInfo(kvp.Value, name, isGenerated));
        }

        result.Sort((a, b) => a.SlotIndex.CompareTo(b.SlotIndex));
        return result;
    }

    private void EmitStructTypeDef(StructSymbol structSym, int firstFieldRow, int methodListRow)
    {
        // Phase 4 emit parity (F2, type-erased): generic type definitions
        // are emitted as ordinary non-generic CLR classes/structs. Each
        // T-typed field is encoded as System.Object via EncodeTypeSymbol;
        // constructed instances (Box[int], Box[string]) share the same CLR
        // TypeDef as the definition and round-trip values through box /
        // unbox.any at field-access and primary-ctor boundaries. Constructed
        // StructSymbols are aliased into the lookup dictionaries by
        // RegisterConstructedTypeAliases after the definition's TypeDef and
        // members are emitted.
        if (!structSym.TypeArguments.IsDefaultOrEmpty)
        {
            throw new System.NotSupportedException(
                $"Internal error: a constructed StructSymbol ('{structSym.Name}') reached EmitStructTypeDef. Only definitions should be in program.Structs.");
        }

        // Emit field definitions in source order. Each field's signature is a
        // FieldSig encoding the GSharp type symbol.
        FieldDefinitionHandle firstField = default;
        foreach (var field in structSym.Fields)
        {
            var sigBlob = new BlobBuilder();
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), field.Type);
            var attrs = MapFieldAccessibility(field.Accessibility);
            if (field.IsReadOnly)
            {
                attrs |= FieldAttributes.InitOnly;
            }

            var handle = this.metadata.AddFieldDefinition(
                attributes: attrs,
                name: this.metadata.GetOrAddString(field.Name),
                signature: this.metadata.GetOrAddBlob(sigBlob));
            if (firstField.IsNil)
            {
                firstField = handle;
            }

            this.structFieldDefs[field] = handle;

            // Issue #186 / ADR-0047 §3: route any @-annotations bound onto
            // the field symbol onto the FieldDef row so attributes like
            // @Obsolete round-trip into CustomAttribute rows.
            this.EmitUserAttributes(handle, field, AttributeTargetKind.Field);
        }

        // ADR-0051 Phase 6: emit backing FieldDefs for auto-properties.
        foreach (var prop in structSym.Properties)
        {
            if (!prop.IsAutoProperty || prop.BackingField == null)
            {
                continue;
            }

            var sigBlob = new BlobBuilder();
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), prop.Type);
            var backingHandle = this.metadata.AddFieldDefinition(
                attributes: FieldAttributes.Private,
                name: this.metadata.GetOrAddString($"<{prop.Name}>k__BackingField"),
                signature: this.metadata.GetOrAddBlob(sigBlob));
            if (firstField.IsNil)
            {
                firstField = backingHandle;
            }

            this.structFieldDefs[prop.BackingField] = backingHandle;
        }

        // ADR-0052: emit backing FieldDefs for field-like events.
        foreach (var ev in structSym.Events)
        {
            if (!ev.IsFieldLike || ev.BackingField == null)
            {
                continue;
            }

            var sigBlob = new BlobBuilder();
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), ev.Type);
            var backingHandle = this.metadata.AddFieldDefinition(
                attributes: FieldAttributes.Private,
                name: this.metadata.GetOrAddString(ev.BackingField.Name),
                signature: this.metadata.GetOrAddBlob(sigBlob));
            if (firstField.IsNil)
            {
                firstField = backingHandle;
            }

            this.structFieldDefs[ev.BackingField] = backingHandle;
        }

        // ADR-0053: emit static field definitions from shared block.
        if (!structSym.StaticFields.IsDefaultOrEmpty)
        {
            foreach (var staticField in structSym.StaticFields)
            {
                var sigBlob = new BlobBuilder();
                this.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), staticField.Type);
                var attrs = MapFieldAccessibility(staticField.Accessibility) | FieldAttributes.Static;
                if (staticField.IsReadOnly)
                {
                    attrs |= FieldAttributes.InitOnly;
                }

                var handle = this.metadata.AddFieldDefinition(
                    attributes: attrs,
                    name: this.metadata.GetOrAddString(staticField.Name),
                    signature: this.metadata.GetOrAddBlob(sigBlob));
                if (firstField.IsNil)
                {
                    firstField = handle;
                }

                this.structFieldDefs[staticField] = handle;
            }
        }

        // Issue #263: emit backing FieldDefs for static auto-properties.
        foreach (var prop in structSym.StaticProperties)
        {
            if (!prop.IsAutoProperty || prop.BackingField == null)
            {
                continue;
            }

            var sigBlob = new BlobBuilder();
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), prop.Type);
            var backingHandle = this.metadata.AddFieldDefinition(
                attributes: FieldAttributes.Assembly | FieldAttributes.Static,
                name: this.metadata.GetOrAddString($"<{prop.Name}>k__BackingField"),
                signature: this.metadata.GetOrAddBlob(sigBlob));
            if (firstField.IsNil)
            {
                firstField = backingHandle;
            }

            this.structFieldDefs[prop.BackingField] = backingHandle;
        }

        // Issue #263: emit backing FieldDefs for static field-like events.
        foreach (var ev in structSym.StaticEvents)
        {
            if (!ev.IsFieldLike || ev.BackingField == null)
            {
                continue;
            }

            var sigBlob = new BlobBuilder();
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), ev.Type);
            var backingHandle = this.metadata.AddFieldDefinition(
                attributes: FieldAttributes.Private | FieldAttributes.Static,
                name: this.metadata.GetOrAddString(ev.BackingField.Name),
                signature: this.metadata.GetOrAddBlob(sigBlob));
            if (firstField.IsNil)
            {
                firstField = backingHandle;
            }

            this.structFieldDefs[ev.BackingField] = backingHandle;
        }

        if (firstField.IsNil)
        {
            // Empty struct: no field rows added; point at next row, which is
            // (firstFieldRow) — same as the next TypeDef's first field row.
            firstField = MetadataTokens.FieldDefinitionHandle(firstFieldRow);
        }

        TypeAttributes typeAttrs;
        EntityHandle baseType;
        if (structSym.IsClass)
        {
            // Phase 3.B.3 sub-step 3: classes are CLR reference types.
            // Sealed by default per ADR-0017 (Kotlin-style `open` opt-in).
            // Base is either the user-declared base class (if any) or
            // System.Object.
            var classAttrs = TypeAttributes.Class
                | TypeAttributes.AutoLayout | TypeAttributes.AnsiClass
                | TypeAttributes.BeforeFieldInit
                | MapTypeAccessibility(structSym.Accessibility);
            if (!structSym.IsOpen)
            {
                classAttrs |= TypeAttributes.Sealed;
            }

            typeAttrs = classAttrs;
            if (structSym.IsAttributeClass)
            {
                // Phase 4 of #141 / ADR-0047 §5: @Attribute sugar — base is
                // System.Attribute, regardless of any other resolution.
                baseType = this.GetSystemAttributeTypeRef();
            }
            else if (structSym.BaseClass != null && this.structTypeDefs.TryGetValue(structSym.BaseClass, out var baseHandle))
            {
                baseType = baseHandle;
            }
            else if (structSym.ImportedBaseType?.ClrType is Type importedBaseClr)
            {
                // Issue #296: the class inherits from an imported CLR base
                // class; reference it as the TypeDef's base type so the emitted
                // metadata extends the imported base.
                baseType = this.GetTypeReference(importedBaseClr);
            }
            else
            {
                baseType = this.objectTypeRef;
            }
        }
        else
        {
            typeAttrs = TypeAttributes.SequentialLayout | TypeAttributes.Sealed
                | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit
                | MapTypeAccessibility(structSym.Accessibility);
            baseType = this.valueTypeRef;
        }

        var handle2 = this.metadata.AddTypeDefinition(
            attributes: typeAttrs,
            @namespace: this.metadata.GetOrAddString(structSym.PackageName ?? string.Empty),
            name: this.metadata.GetOrAddString(structSym.Name),
            baseType: baseType,
            fieldList: firstField,
            methodList: MetadataTokens.MethodDefinitionHandle(methodListRow));
        this.structTypeDefs[structSym] = handle2;
        if (structSym.IsInline)
        {
            this.EmitIsReadOnlyAttribute(handle2);
        }

        if (structSym.IsRefStruct)
        {
            // Issue #367: mark user-declared `ref struct` types as by-ref-like.
            this.EmitIsByRefLikeAttribute(handle2);
        }

        // Phase 3 of #141: user annotations targeting the type land on this TypeDef.
        this.EmitUserAttributes(handle2, structSym, AttributeTargetKind.Type);
    }

    /// <summary>
    /// ADR-0051 Phase 6: emits accessor MethodDefs, PropertyDef rows, PropertyMap,
    /// and MethodSemantics rows for all properties declared on a type.
    /// Called during Phase B (MethodDef emission) after the type's regular methods.
    /// </summary>
    private void EmitPropertyAccessors(StructSymbol structSym)
    {
        if (structSym.Properties.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.structTypeDefs.TryGetValue(structSym, out var typeDefHandle))
        {
            return;
        }

        PropertyDefinitionHandle firstPropDef = default;
        foreach (var prop in structSym.Properties)
        {
            if (!this.propertyAccessorHandles.TryGetValue(prop, out var accessorHandles))
            {
                continue;
            }

            // Emit getter MethodDef.
            MethodDefinitionHandle? emittedGetter = null;
            if (prop.HasGetter && accessorHandles.Getter.HasValue)
            {
                emittedGetter = this.EmitPropertyGetter(structSym, prop);
            }

            // Emit setter MethodDef.
            MethodDefinitionHandle? emittedSetter = null;
            if (prop.HasSetter && accessorHandles.Setter.HasValue)
            {
                emittedSetter = this.EmitPropertySetter(structSym, prop);
            }

            // Emit PropertyDef row.
            var propertySignature = new BlobBuilder();
            new BlobEncoder(propertySignature)
                .PropertySignature(isInstanceProperty: true)
                .Parameters(0, returnType => this.EncodeTypeSymbol(returnType.Type(), prop.Type), parameters => { });

            var propDef = this.metadata.AddProperty(
                attributes: PropertyAttributes.None,
                name: this.metadata.GetOrAddString(prop.Name),
                signature: this.metadata.GetOrAddBlob(propertySignature));

            if (firstPropDef.IsNil)
            {
                firstPropDef = propDef;
            }

            // MethodSemantics rows linking accessor MethodDefs to the PropertyDef.
            if (emittedGetter.HasValue)
            {
                this.metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Getter, emittedGetter.Value);
            }

            if (emittedSetter.HasValue)
            {
                this.metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Setter, emittedSetter.Value);
            }
        }

        // PropertyMap row: links the TypeDef to its first PropertyDef.
        if (!firstPropDef.IsNil)
        {
            this.metadata.AddPropertyMap(typeDefHandle, firstPropDef);
            this.typesWithPropertyMap.Add(typeDefHandle);
        }
    }

    /// <summary>
    /// ADR-0051 Phase 6: emits a getter accessor MethodDef (get_PropertyName).
    /// For auto-properties: ldarg.0, ldfld backing, ret.
    /// For computed properties: emits the bound getter body IL.
    /// </summary>
    private MethodDefinitionHandle EmitPropertyGetter(StructSymbol structSym, PropertySymbol prop)
    {
        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            if (prop.IsAutoProperty && prop.BackingField != null
                && this.structFieldDefs.TryGetValue(prop.BackingField, out var backingHandle))
            {
                var il = new InstructionEncoder(new BlobBuilder());
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Ldfld);
                il.Token(backingHandle);
                il.OpCode(ILOpCode.Ret);
                bodyOffset = this.methodBodyStream.AddMethodBody(il);
            }
            else if (prop.GetterSymbol != null && this.program.Functions.TryGetValue(prop.GetterSymbol, out var getterBody))
            {
                // Computed property with bound body: emit using EmitFunction infrastructure.
                var handle = this.EmitFunction(prop.GetterSymbol, getterBody, isEntryPoint: false);
                return handle;
            }
            else
            {
                // Fallback: throw new NotImplementedException().
                var il = new InstructionEncoder(new BlobBuilder());
                var nieCtor = this.GetNotImplementedExceptionCtor();
                il.OpCode(ILOpCode.Newobj);
                il.Token(nieCtor);
                il.OpCode(ILOpCode.Throw);
                bodyOffset = this.methodBodyStream.AddMethodBody(il);
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => this.EncodeTypeSymbol(r.Type(), prop.Type), _ => { });

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig;
        if (prop.IsVirtual)
        {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }
        else if (prop.IsOverride)
        {
            methodAttrs |= MethodAttributes.Virtual;
        }
        else if (this.PropertyImplicitlyImplementsInterface(structSym, prop))
        {
            // Issue #248: implicit interface implementation requires Virtual | NewSlot.
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }

        return this.metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString($"get_{prop.Name}"),
            signature: this.metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: this.NextParameterHandle());
    }

    /// <summary>
    /// ADR-0051 Phase 6: emits a setter accessor MethodDef (set_PropertyName).
    /// For auto-properties: ldarg.0, ldarg.1, stfld backing, ret.
    /// For computed properties: emits the bound setter body IL.
    /// </summary>
    private MethodDefinitionHandle EmitPropertySetter(StructSymbol structSym, PropertySymbol prop)
    {
        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            if (prop.IsAutoProperty && prop.BackingField != null
                && this.structFieldDefs.TryGetValue(prop.BackingField, out var backingHandle))
            {
                var il = new InstructionEncoder(new BlobBuilder());
                il.LoadArgument(0);
                il.LoadArgument(1);
                il.OpCode(ILOpCode.Stfld);
                il.Token(backingHandle);
                il.OpCode(ILOpCode.Ret);
                bodyOffset = this.methodBodyStream.AddMethodBody(il);
            }
            else if (prop.SetterSymbol != null && this.program.Functions.TryGetValue(prop.SetterSymbol, out var setterBody))
            {
                // Computed property with bound body: emit using EmitFunction infrastructure.
                var handle = this.EmitFunction(prop.SetterSymbol, setterBody, isEntryPoint: false);
                return handle;
            }
            else
            {
                // Fallback: throw new NotImplementedException().
                var il = new InstructionEncoder(new BlobBuilder());
                var nieCtor = this.GetNotImplementedExceptionCtor();
                il.OpCode(ILOpCode.Newobj);
                il.Token(nieCtor);
                il.OpCode(ILOpCode.Throw);
                bodyOffset = this.methodBodyStream.AddMethodBody(il);
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(1, r => r.Void(), ps => this.EncodeTypeSymbol(ps.AddParameter().Type(), prop.Type));

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig;
        if (prop.IsVirtual)
        {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }
        else if (prop.IsOverride)
        {
            methodAttrs |= MethodAttributes.Virtual;
        }
        else if (this.PropertyImplicitlyImplementsInterface(structSym, prop))
        {
            // Issue #248: implicit interface implementation requires Virtual | NewSlot.
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }

        // Emit a Parameter row for "value" so the setter has a named parameter.
        var firstParamHandle = this.NextParameterHandle();
        this.metadata.AddParameter(
            attributes: ParameterAttributes.None,
            name: this.metadata.GetOrAddString(prop.SetterParameterName ?? "value"),
            sequenceNumber: 1);

        return this.metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString($"set_{prop.Name}"),
            signature: this.metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle);
    }

    /// <summary>
    /// Issue #263: emits accessor MethodDefs, PropertyDef rows, PropertyMap,
    /// and MethodSemantics rows for static properties declared in a shared block.
    /// </summary>
    private void EmitStaticPropertyAccessors(StructSymbol structSym)
    {
        if (structSym.StaticProperties.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.structTypeDefs.TryGetValue(structSym, out var typeDefHandle))
        {
            return;
        }

        PropertyDefinitionHandle firstPropDef = default;
        foreach (var prop in structSym.StaticProperties)
        {
            if (!this.propertyAccessorHandles.TryGetValue(prop, out var accessorHandles))
            {
                continue;
            }

            // Emit getter MethodDef.
            MethodDefinitionHandle? emittedGetter = null;
            if (prop.HasGetter && accessorHandles.Getter.HasValue)
            {
                emittedGetter = this.EmitStaticPropertyGetter(structSym, prop);
            }

            // Emit setter MethodDef.
            MethodDefinitionHandle? emittedSetter = null;
            if (prop.HasSetter && accessorHandles.Setter.HasValue)
            {
                emittedSetter = this.EmitStaticPropertySetter(structSym, prop);
            }

            // Emit PropertyDef row.
            var propertySignature = new BlobBuilder();
            new BlobEncoder(propertySignature)
                .PropertySignature(isInstanceProperty: false)
                .Parameters(0, returnType => this.EncodeTypeSymbol(returnType.Type(), prop.Type), parameters => { });

            var propDef = this.metadata.AddProperty(
                attributes: PropertyAttributes.None,
                name: this.metadata.GetOrAddString(prop.Name),
                signature: this.metadata.GetOrAddBlob(propertySignature));

            if (firstPropDef.IsNil)
            {
                firstPropDef = propDef;
            }

            // MethodSemantics rows linking accessor MethodDefs to the PropertyDef.
            if (emittedGetter.HasValue)
            {
                this.metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Getter, emittedGetter.Value);
            }

            if (emittedSetter.HasValue)
            {
                this.metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Setter, emittedSetter.Value);
            }
        }

        // PropertyMap row: links the TypeDef to its first PropertyDef.
        // Issue #418 (P1-7): only add a PropertyMap here if the instance-property
        // emission path (EmitPropertyAccessors) didn't already add one. Using
        // structSym.Properties.IsDefaultOrEmpty was incorrect — instance properties
        // may be declared but all skipped during emission (e.g., computed property
        // whose getter symbol has no entry in program.Functions), leaving no
        // PropertyMap. Without this row the static PropertyDef rows would be
        // orphaned and violate ECMA-335 §II.22.35.
        if (!firstPropDef.IsNil && !this.typesWithPropertyMap.Contains(typeDefHandle))
        {
            this.metadata.AddPropertyMap(typeDefHandle, firstPropDef);
            this.typesWithPropertyMap.Add(typeDefHandle);
        }
    }

    /// <summary>
    /// Issue #263: emits a static getter accessor MethodDef (get_PropertyName).
    /// </summary>
    private MethodDefinitionHandle EmitStaticPropertyGetter(StructSymbol structSym, PropertySymbol prop)
    {
        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            if (prop.IsAutoProperty && prop.BackingField != null
                && this.structFieldDefs.TryGetValue(prop.BackingField, out var backingHandle))
            {
                var il = new InstructionEncoder(new BlobBuilder());
                il.OpCode(ILOpCode.Ldsfld);
                il.Token(backingHandle);
                il.OpCode(ILOpCode.Ret);
                bodyOffset = this.methodBodyStream.AddMethodBody(il);
            }
            else if (prop.GetterSymbol != null && this.program.Functions.TryGetValue(prop.GetterSymbol, out var getterBody))
            {
                var handle = this.EmitFunction(prop.GetterSymbol, getterBody, isEntryPoint: false);
                return handle;
            }
            else
            {
                var il = new InstructionEncoder(new BlobBuilder());
                var nieCtor = this.GetNotImplementedExceptionCtor();
                il.OpCode(ILOpCode.Newobj);
                il.Token(nieCtor);
                il.OpCode(ILOpCode.Throw);
                bodyOffset = this.methodBodyStream.AddMethodBody(il);
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(0, r => this.EncodeTypeSymbol(r.Type(), prop.Type), _ => { });

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig | MethodAttributes.Static;

        return this.metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString($"get_{prop.Name}"),
            signature: this.metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: this.NextParameterHandle());
    }

    /// <summary>
    /// Issue #263: emits a static setter accessor MethodDef (set_PropertyName).
    /// </summary>
    private MethodDefinitionHandle EmitStaticPropertySetter(StructSymbol structSym, PropertySymbol prop)
    {
        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            if (prop.IsAutoProperty && prop.BackingField != null
                && this.structFieldDefs.TryGetValue(prop.BackingField, out var backingHandle))
            {
                var il = new InstructionEncoder(new BlobBuilder());
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Stsfld);
                il.Token(backingHandle);
                il.OpCode(ILOpCode.Ret);
                bodyOffset = this.methodBodyStream.AddMethodBody(il);
            }
            else if (prop.SetterSymbol != null && this.program.Functions.TryGetValue(prop.SetterSymbol, out var setterBody))
            {
                var handle = this.EmitFunction(prop.SetterSymbol, setterBody, isEntryPoint: false);
                return handle;
            }
            else
            {
                var il = new InstructionEncoder(new BlobBuilder());
                var nieCtor = this.GetNotImplementedExceptionCtor();
                il.OpCode(ILOpCode.Newobj);
                il.Token(nieCtor);
                il.OpCode(ILOpCode.Throw);
                bodyOffset = this.methodBodyStream.AddMethodBody(il);
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(1, r => r.Void(), ps => this.EncodeTypeSymbol(ps.AddParameter().Type(), prop.Type));

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig | MethodAttributes.Static;

        var firstParamHandle = this.NextParameterHandle();
        this.metadata.AddParameter(
            attributes: ParameterAttributes.None,
            name: this.metadata.GetOrAddString(prop.SetterParameterName ?? "value"),
            sequenceNumber: 1);

        return this.metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString($"set_{prop.Name}"),
            signature: this.metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle);
    }

    /// <summary>
    /// Issue #263: emits add/remove accessor MethodDefs, EventDef rows, EventMap,
    /// and MethodSemantics rows for static events declared in a shared block.
    /// </summary>
    private void EmitStaticEventAccessors(StructSymbol structSym)
    {
        if (structSym.StaticEvents.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.structTypeDefs.TryGetValue(structSym, out var typeDefHandle))
        {
            return;
        }

        EventDefinitionHandle firstEventDef = default;
        foreach (var ev in structSym.StaticEvents)
        {
            if (!this.eventAccessorHandles.TryGetValue(ev, out var accessorHandles))
            {
                continue;
            }

            // Emit add_X MethodDef.
            var addMethod = this.EmitStaticEventAddAccessor(structSym, ev);

            // Emit remove_X MethodDef.
            var removeMethod = this.EmitStaticEventRemoveAccessor(structSym, ev);

            // Issue #257: emit raise_X MethodDef if present.
            MethodDefinitionHandle? raiseMethod = null;
            if (ev.RaiseMethodSymbol != null)
            {
                raiseMethod = this.EmitEventRaiseAccessor(structSym, ev, isStatic: true);
            }

            // Emit EventDef row.
            var eventTypeHandle = this.GetEventTypeHandle(ev.Type);

            var eventDef = this.metadata.AddEvent(
                attributes: EventAttributes.None,
                name: this.metadata.GetOrAddString(ev.Name),
                type: eventTypeHandle);

            if (firstEventDef.IsNil)
            {
                firstEventDef = eventDef;
            }

            // MethodSemantics rows linking accessor MethodDefs to the EventDef.
            this.metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Adder, addMethod);
            this.metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Remover, removeMethod);
            if (raiseMethod.HasValue)
            {
                this.metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Raiser, raiseMethod.Value);
            }
        }

        // EventMap row: links the TypeDef to its first EventDef.
        // Only add if no instance events already created an EventMap for this type.
        if (!firstEventDef.IsNil && structSym.Events.IsDefaultOrEmpty)
        {
            this.metadata.AddEventMap(typeDefHandle, firstEventDef);
        }
    }

    /// <summary>
    /// Issue #263: emits a static add_X accessor MethodDef for a static event.
    /// </summary>
    private MethodDefinitionHandle EmitStaticEventAddAccessor(StructSymbol structSym, EventSymbol ev)
    {
        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            if (ev.IsFieldLike && ev.BackingField != null
                && this.structFieldDefs.TryGetValue(ev.BackingField, out var backingHandle))
            {
                // Issue #256: thread-safe CAS loop using Interlocked.CompareExchange<T>.
                var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
                var eventTypeHandle = this.GetEventTypeHandle(ev.Type);

                // ldsfld backingField; stloc.0
                il.OpCode(ILOpCode.Ldsfld);
                il.Token(backingHandle);
                il.OpCode(ILOpCode.Stloc_0);

                // loop_start:
                var loopStart = il.DefineLabel();
                il.MarkLabel(loopStart);

                // ldloc.0; stloc.1
                il.OpCode(ILOpCode.Ldloc_0);
                il.OpCode(ILOpCode.Stloc_1);

                // ldloc.1; ldarg.0; call Delegate.Combine; castclass T; stloc.2
                il.OpCode(ILOpCode.Ldloc_1);
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Call);
                il.Token(this.GetDelegateCombineRef());
                il.OpCode(ILOpCode.Castclass);
                il.Token(eventTypeHandle);
                il.OpCode(ILOpCode.Stloc_2);

                // ldsflda backingField; ldloc.2; ldloc.1
                il.OpCode(ILOpCode.Ldsflda);
                il.Token(backingHandle);
                il.OpCode(ILOpCode.Ldloc_2);
                il.OpCode(ILOpCode.Ldloc_1);

                // call Interlocked.CompareExchange<T>; stloc.0
                il.OpCode(ILOpCode.Call);
                il.Token(this.GetInterlockedCompareExchangeSpec(ev.Type));
                il.OpCode(ILOpCode.Stloc_0);

                // ldloc.0; ldloc.1; bne.un.s loop_start
                il.OpCode(ILOpCode.Ldloc_0);
                il.OpCode(ILOpCode.Ldloc_1);
                il.Branch(ILOpCode.Bne_un_s, loopStart);

                il.OpCode(ILOpCode.Ret);

                var localsSigBlob = new BlobBuilder();
                var localsEncoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(3);
                this.EncodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type);
                this.EncodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type);
                this.EncodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type);
                var localsSignature = this.metadata.AddStandaloneSignature(this.metadata.GetOrAddBlob(localsSigBlob));

                bodyOffset = this.methodBodyStream.AddMethodBody(il, maxStack: 3, localVariablesSignature: localsSignature);
            }
            else if (ev.AddMethodSymbol != null && this.program.Functions.TryGetValue(ev.AddMethodSymbol, out var addBody))
            {
                var handle = this.EmitFunction(ev.AddMethodSymbol, addBody, isEntryPoint: false);
                return handle;
            }
            else
            {
                var il = new InstructionEncoder(new BlobBuilder());
                var nieCtor = this.GetNotImplementedExceptionCtor();
                il.OpCode(ILOpCode.Newobj);
                il.Token(nieCtor);
                il.OpCode(ILOpCode.Throw);
                bodyOffset = this.methodBodyStream.AddMethodBody(il);
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(1, r => r.Void(), ps => this.EncodeTypeSymbol(ps.AddParameter().Type(), ev.Type));

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig | MethodAttributes.Static;

        var firstParamHandle = this.NextParameterHandle();
        this.metadata.AddParameter(
            attributes: ParameterAttributes.None,
            name: this.metadata.GetOrAddString("value"),
            sequenceNumber: 1);

        return this.metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString($"add_{ev.Name}"),
            signature: this.metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle);
    }

    /// <summary>
    /// Issue #263: emits a static remove_X accessor MethodDef for a static event.
    /// </summary>
    private MethodDefinitionHandle EmitStaticEventRemoveAccessor(StructSymbol structSym, EventSymbol ev)
    {
        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            if (ev.IsFieldLike && ev.BackingField != null
                && this.structFieldDefs.TryGetValue(ev.BackingField, out var backingHandle))
            {
                // Issue #256: thread-safe CAS loop using Interlocked.CompareExchange<T>.
                var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
                var eventTypeHandle = this.GetEventTypeHandle(ev.Type);

                // ldsfld backingField; stloc.0
                il.OpCode(ILOpCode.Ldsfld);
                il.Token(backingHandle);
                il.OpCode(ILOpCode.Stloc_0);

                // loop_start:
                var loopStart = il.DefineLabel();
                il.MarkLabel(loopStart);

                // ldloc.0; stloc.1
                il.OpCode(ILOpCode.Ldloc_0);
                il.OpCode(ILOpCode.Stloc_1);

                // ldloc.1; ldarg.0; call Delegate.Remove; castclass T; stloc.2
                il.OpCode(ILOpCode.Ldloc_1);
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Call);
                il.Token(this.GetDelegateRemoveRef());
                il.OpCode(ILOpCode.Castclass);
                il.Token(eventTypeHandle);
                il.OpCode(ILOpCode.Stloc_2);

                // ldsflda backingField; ldloc.2; ldloc.1
                il.OpCode(ILOpCode.Ldsflda);
                il.Token(backingHandle);
                il.OpCode(ILOpCode.Ldloc_2);
                il.OpCode(ILOpCode.Ldloc_1);

                // call Interlocked.CompareExchange<T>; stloc.0
                il.OpCode(ILOpCode.Call);
                il.Token(this.GetInterlockedCompareExchangeSpec(ev.Type));
                il.OpCode(ILOpCode.Stloc_0);

                // ldloc.0; ldloc.1; bne.un.s loop_start
                il.OpCode(ILOpCode.Ldloc_0);
                il.OpCode(ILOpCode.Ldloc_1);
                il.Branch(ILOpCode.Bne_un_s, loopStart);

                il.OpCode(ILOpCode.Ret);

                var localsSigBlob = new BlobBuilder();
                var localsEncoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(3);
                this.EncodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type);
                this.EncodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type);
                this.EncodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type);
                var localsSignature = this.metadata.AddStandaloneSignature(this.metadata.GetOrAddBlob(localsSigBlob));

                bodyOffset = this.methodBodyStream.AddMethodBody(il, maxStack: 3, localVariablesSignature: localsSignature);
            }
            else if (ev.RemoveMethodSymbol != null && this.program.Functions.TryGetValue(ev.RemoveMethodSymbol, out var removeBody))
            {
                var handle = this.EmitFunction(ev.RemoveMethodSymbol, removeBody, isEntryPoint: false);
                return handle;
            }
            else
            {
                var il = new InstructionEncoder(new BlobBuilder());
                var nieCtor = this.GetNotImplementedExceptionCtor();
                il.OpCode(ILOpCode.Newobj);
                il.Token(nieCtor);
                il.OpCode(ILOpCode.Throw);
                bodyOffset = this.methodBodyStream.AddMethodBody(il);
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(1, r => r.Void(), ps => this.EncodeTypeSymbol(ps.AddParameter().Type(), ev.Type));

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig | MethodAttributes.Static;

        var firstParamHandle = this.NextParameterHandle();
        this.metadata.AddParameter(
            attributes: ParameterAttributes.None,
            name: this.metadata.GetOrAddString("value"),
            sequenceNumber: 1);

        return this.metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString($"remove_{ev.Name}"),
            signature: this.metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle);
    }

    /// <summary>Resolves a MemberReferenceHandle for System.NotImplementedException..ctor().</summary>
    private MemberReferenceHandle GetNotImplementedExceptionCtor()
    {
        if (this.notImplementedExceptionCtorRef.HasValue)
        {
            return this.notImplementedExceptionCtorRef.Value;
        }

        var nieType = typeof(System.NotImplementedException);
        var nieTypeRef = this.GetTypeReference(nieType);
        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });
        this.notImplementedExceptionCtorRef = this.metadata.AddMemberReference(
            nieTypeRef,
            this.metadata.GetOrAddString(".ctor"),
            this.metadata.GetOrAddBlob(ctorSig));
        return this.notImplementedExceptionCtorRef.Value;
    }

    /// <summary>
    /// Issue #248: determines whether a property on a class/struct implicitly implements
    /// an interface property (same name and type on any implemented interface).
    /// </summary>
    private bool PropertyImplicitlyImplementsInterface(StructSymbol structSym, PropertySymbol prop)
    {
        if (structSym.Interfaces.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var iface in structSym.Interfaces)
        {
            if (iface.Properties.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var ifaceProp in iface.Properties)
            {
                if (ifaceProp.Name == prop.Name)
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #409: determines whether a value-type instance method must keep
    /// virtual method attributes because it participates in CLR vtable dispatch.
    /// </summary>
    private static bool RequiresVirtualOnValueType(FunctionSymbol function, StructSymbol receiverStruct)
    {
        if (function.IsOverride || function.OverriddenMethod != null)
        {
            return true;
        }

        return MethodImplicitlyImplementsInterface(receiverStruct, function);
    }

    /// <summary>
    /// Determines whether a method on a class/struct implicitly implements an
    /// interface method (same name, parameters, and return type).
    /// </summary>
    private static bool MethodImplicitlyImplementsInterface(StructSymbol structSym, FunctionSymbol method)
    {
        if (structSym.Interfaces.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var iface in structSym.Interfaces)
        {
            if (iface.Methods.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var ifaceMethod in iface.Methods)
            {
                if (MethodSignaturesMatch(ifaceMethod, method))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static bool MethodSignaturesMatch(FunctionSymbol interfaceMethod, FunctionSymbol implementationMethod)
    {
        if (interfaceMethod.Name != implementationMethod.Name || interfaceMethod.Type != implementationMethod.Type)
        {
            return false;
        }

        var interfaceParameters = CallableParameters(interfaceMethod);
        var implementationParameters = CallableParameters(implementationMethod);
        if (interfaceParameters.Length != implementationParameters.Length)
        {
            return false;
        }

        for (var i = 0; i < interfaceParameters.Length; i++)
        {
            if (interfaceParameters[i].Type != implementationParameters[i].Type)
            {
                return false;
            }
        }

        return true;
    }

    private static ImmutableArray<ParameterSymbol> CallableParameters(FunctionSymbol method)
        => method.ExplicitReceiverParameter == null ? method.Parameters : method.Parameters.RemoveAt(0);

    /// <summary>
    /// ADR-0052: determines whether an event on a class/struct implicitly implements
    /// an interface event (same name on any implemented interface).
    /// </summary>
    private bool EventImplicitlyImplementsInterface(StructSymbol structSym, EventSymbol ev)
    {
        if (structSym.Interfaces.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var iface in structSym.Interfaces)
        {
            if (iface.Events.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var ifaceEvent in iface.Events)
            {
                if (ifaceEvent.Name == ev.Name)
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// ADR-0052: emits add/remove accessor MethodDefs, EventDef rows, EventMap,
    /// and MethodSemantics rows for all events declared on a type.
    /// </summary>
    private void EmitEventAccessors(StructSymbol structSym)
    {
        if (structSym.Events.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.structTypeDefs.TryGetValue(structSym, out var typeDefHandle))
        {
            return;
        }

        EventDefinitionHandle firstEventDef = default;
        foreach (var ev in structSym.Events)
        {
            if (!this.eventAccessorHandles.TryGetValue(ev, out var accessorHandles))
            {
                continue;
            }

            // Emit add_X MethodDef.
            var addMethod = this.EmitEventAddAccessor(structSym, ev);

            // Emit remove_X MethodDef.
            var removeMethod = this.EmitEventRemoveAccessor(structSym, ev);

            // Issue #257: emit raise_X MethodDef if present.
            MethodDefinitionHandle? raiseMethod = null;
            if (ev.RaiseMethodSymbol != null)
            {
                raiseMethod = this.EmitEventRaiseAccessor(structSym, ev, isStatic: false);
            }

            // Emit EventDef row.
            var eventTypeHandle = this.GetEventTypeHandle(ev.Type);

            var eventDef = this.metadata.AddEvent(
                attributes: EventAttributes.None,
                name: this.metadata.GetOrAddString(ev.Name),
                type: eventTypeHandle);

            if (firstEventDef.IsNil)
            {
                firstEventDef = eventDef;
            }

            // MethodSemantics rows linking accessor MethodDefs to the EventDef.
            this.metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Adder, addMethod);
            this.metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Remover, removeMethod);
            if (raiseMethod.HasValue)
            {
                this.metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Raiser, raiseMethod.Value);
            }
        }

        // EventMap row: links the TypeDef to its first EventDef.
        if (!firstEventDef.IsNil)
        {
            this.metadata.AddEventMap(typeDefHandle, firstEventDef);
        }
    }

    /// <summary>
    /// ADR-0052: resolves the EntityHandle for the event handler type used in the EventDef row.
    /// </summary>
    private EntityHandle GetEventTypeHandle(TypeSymbol type)
    {
        if (type is FunctionTypeSymbol fnType)
        {
            var clrType = fnType.ClrType;
            if (clrType != null)
            {
                return this.GetTypeHandleForMember(clrType);
            }
        }

        if (type.ClrType != null)
        {
            return this.GetTypeHandleForMember(type.ClrType);
        }

        if (type is StructSymbol structSym && this.structTypeDefs.TryGetValue(structSym, out var td))
        {
            return td;
        }

        if (type is InterfaceSymbol ifaceSym && this.interfaceTypeDefs.TryGetValue(ifaceSym, out var ifaceDef))
        {
            return ifaceDef;
        }

        // Fallback: encode as System.Delegate.
        return this.GetTypeReference(typeof(System.Delegate));
    }

    /// <summary>
    /// ADR-0052: emits the add_X accessor MethodDef for an event.
    /// </summary>
    private MethodDefinitionHandle EmitEventAddAccessor(StructSymbol structSym, EventSymbol ev)
    {
        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            if (ev.IsFieldLike && ev.BackingField != null
                && this.structFieldDefs.TryGetValue(ev.BackingField, out var backingHandle))
            {
                // Issue #256: thread-safe CAS loop using Interlocked.CompareExchange<T>.
                var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
                var eventTypeHandle = this.GetEventTypeHandle(ev.Type);

                // ldarg.0; ldfld backingField; stloc.0
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Ldfld);
                il.Token(backingHandle);
                il.OpCode(ILOpCode.Stloc_0);

                // loop_start:
                var loopStart = il.DefineLabel();
                il.MarkLabel(loopStart);

                // ldloc.0; stloc.1
                il.OpCode(ILOpCode.Ldloc_0);
                il.OpCode(ILOpCode.Stloc_1);

                // ldloc.1; ldarg.1; call Delegate.Combine; castclass T; stloc.2
                il.OpCode(ILOpCode.Ldloc_1);
                il.LoadArgument(1);
                il.OpCode(ILOpCode.Call);
                il.Token(this.GetDelegateCombineRef());
                il.OpCode(ILOpCode.Castclass);
                il.Token(eventTypeHandle);
                il.OpCode(ILOpCode.Stloc_2);

                // ldarg.0; ldflda backingField; ldloc.2; ldloc.1
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Ldflda);
                il.Token(backingHandle);
                il.OpCode(ILOpCode.Ldloc_2);
                il.OpCode(ILOpCode.Ldloc_1);

                // call Interlocked.CompareExchange<T>; stloc.0
                il.OpCode(ILOpCode.Call);
                il.Token(this.GetInterlockedCompareExchangeSpec(ev.Type));
                il.OpCode(ILOpCode.Stloc_0);

                // ldloc.0; ldloc.1; bne.un.s loop_start
                il.OpCode(ILOpCode.Ldloc_0);
                il.OpCode(ILOpCode.Ldloc_1);
                il.Branch(ILOpCode.Bne_un_s, loopStart);

                il.OpCode(ILOpCode.Ret);

                var localsSigBlob = new BlobBuilder();
                var localsEncoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(3);
                this.EncodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type);
                this.EncodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type);
                this.EncodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type);
                var localsSignature = this.metadata.AddStandaloneSignature(this.metadata.GetOrAddBlob(localsSigBlob));

                bodyOffset = this.methodBodyStream.AddMethodBody(il, maxStack: 3, localVariablesSignature: localsSignature);
            }
            else if (ev.AddMethodSymbol != null && this.program.Functions.TryGetValue(ev.AddMethodSymbol, out var addBody))
            {
                // Explicit accessor with bound body: emit using EmitFunction infrastructure.
                var handle = this.EmitFunction(ev.AddMethodSymbol, addBody, isEntryPoint: false);
                return handle;
            }
            else
            {
                // Fallback: throw new NotImplementedException().
                var il = new InstructionEncoder(new BlobBuilder());
                var nieCtor = this.GetNotImplementedExceptionCtor();
                il.OpCode(ILOpCode.Newobj);
                il.Token(nieCtor);
                il.OpCode(ILOpCode.Throw);
                bodyOffset = this.methodBodyStream.AddMethodBody(il);
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(1, r => r.Void(), ps => this.EncodeTypeSymbol(ps.AddParameter().Type(), ev.Type));

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig;
        if (ev.IsVirtual)
        {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }
        else if (ev.IsOverride)
        {
            methodAttrs |= MethodAttributes.Virtual;
        }
        else if (this.EventImplicitlyImplementsInterface(structSym, ev))
        {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }

        var firstParamHandle = this.NextParameterHandle();
        this.metadata.AddParameter(
            attributes: ParameterAttributes.None,
            name: this.metadata.GetOrAddString("value"),
            sequenceNumber: 1);

        return this.metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString($"add_{ev.Name}"),
            signature: this.metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle);
    }

    /// <summary>
    /// ADR-0052: emits the remove_X accessor MethodDef for an event.
    /// </summary>
    private MethodDefinitionHandle EmitEventRemoveAccessor(StructSymbol structSym, EventSymbol ev)
    {
        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            if (ev.IsFieldLike && ev.BackingField != null
                && this.structFieldDefs.TryGetValue(ev.BackingField, out var backingHandle))
            {
                // Issue #256: thread-safe CAS loop using Interlocked.CompareExchange<T>.
                var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
                var eventTypeHandle = this.GetEventTypeHandle(ev.Type);

                // ldarg.0; ldfld backingField; stloc.0
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Ldfld);
                il.Token(backingHandle);
                il.OpCode(ILOpCode.Stloc_0);

                // loop_start:
                var loopStart = il.DefineLabel();
                il.MarkLabel(loopStart);

                // ldloc.0; stloc.1
                il.OpCode(ILOpCode.Ldloc_0);
                il.OpCode(ILOpCode.Stloc_1);

                // ldloc.1; ldarg.1; call Delegate.Remove; castclass T; stloc.2
                il.OpCode(ILOpCode.Ldloc_1);
                il.LoadArgument(1);
                il.OpCode(ILOpCode.Call);
                il.Token(this.GetDelegateRemoveRef());
                il.OpCode(ILOpCode.Castclass);
                il.Token(eventTypeHandle);
                il.OpCode(ILOpCode.Stloc_2);

                // ldarg.0; ldflda backingField; ldloc.2; ldloc.1
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Ldflda);
                il.Token(backingHandle);
                il.OpCode(ILOpCode.Ldloc_2);
                il.OpCode(ILOpCode.Ldloc_1);

                // call Interlocked.CompareExchange<T>; stloc.0
                il.OpCode(ILOpCode.Call);
                il.Token(this.GetInterlockedCompareExchangeSpec(ev.Type));
                il.OpCode(ILOpCode.Stloc_0);

                // ldloc.0; ldloc.1; bne.un.s loop_start
                il.OpCode(ILOpCode.Ldloc_0);
                il.OpCode(ILOpCode.Ldloc_1);
                il.Branch(ILOpCode.Bne_un_s, loopStart);

                il.OpCode(ILOpCode.Ret);

                var localsSigBlob = new BlobBuilder();
                var localsEncoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(3);
                this.EncodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type);
                this.EncodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type);
                this.EncodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type);
                var localsSignature = this.metadata.AddStandaloneSignature(this.metadata.GetOrAddBlob(localsSigBlob));

                bodyOffset = this.methodBodyStream.AddMethodBody(il, maxStack: 3, localVariablesSignature: localsSignature);
            }
            else if (ev.RemoveMethodSymbol != null && this.program.Functions.TryGetValue(ev.RemoveMethodSymbol, out var removeBody))
            {
                // Explicit accessor with bound body: emit using EmitFunction infrastructure.
                var handle = this.EmitFunction(ev.RemoveMethodSymbol, removeBody, isEntryPoint: false);
                return handle;
            }
            else
            {
                // Fallback: throw new NotImplementedException().
                var il = new InstructionEncoder(new BlobBuilder());
                var nieCtor = this.GetNotImplementedExceptionCtor();
                il.OpCode(ILOpCode.Newobj);
                il.Token(nieCtor);
                il.OpCode(ILOpCode.Throw);
                bodyOffset = this.methodBodyStream.AddMethodBody(il);
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(1, r => r.Void(), ps => this.EncodeTypeSymbol(ps.AddParameter().Type(), ev.Type));

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig;
        if (ev.IsVirtual)
        {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }
        else if (ev.IsOverride)
        {
            methodAttrs |= MethodAttributes.Virtual;
        }
        else if (this.EventImplicitlyImplementsInterface(structSym, ev))
        {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }

        var firstParamHandle = this.NextParameterHandle();
        this.metadata.AddParameter(
            attributes: ParameterAttributes.None,
            name: this.metadata.GetOrAddString("value"),
            sequenceNumber: 1);

        return this.metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString($"remove_{ev.Name}"),
            signature: this.metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle);
    }

    /// <summary>
    /// Issue #257: emits the raise_X accessor MethodDef for an event.
    /// The raise accessor body is always user-provided (explicit).
    /// </summary>
    private MethodDefinitionHandle EmitEventRaiseAccessor(StructSymbol structSym, EventSymbol ev, bool isStatic)
    {
        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            if (ev.RaiseMethodSymbol != null && this.program.Functions.TryGetValue(ev.RaiseMethodSymbol, out var raiseBody))
            {
                var handle = this.EmitFunction(ev.RaiseMethodSymbol, raiseBody, isEntryPoint: false);
                return handle;
            }
            else
            {
                // Fallback: throw new NotImplementedException().
                var il = new InstructionEncoder(new BlobBuilder());
                var nieCtor = this.GetNotImplementedExceptionCtor();
                il.OpCode(ILOpCode.Newobj);
                il.Token(nieCtor);
                il.OpCode(ILOpCode.Throw);
                bodyOffset = this.methodBodyStream.AddMethodBody(il);
            }
        }

        // Build signature: parameters match the handler type's parameters, return void.
        int paramCount = 0;
        if (ev.Type is FunctionTypeSymbol fnType)
        {
            paramCount = fnType.ParameterTypes.Length;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: !isStatic)
            .Parameters(paramCount, r => r.Void(), ps =>
            {
                if (ev.Type is FunctionTypeSymbol fn)
                {
                    foreach (var pt in fn.ParameterTypes)
                    {
                        this.EncodeTypeSymbol(ps.AddParameter().Type(), pt);
                    }
                }
            });

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig;
        if (isStatic)
        {
            methodAttrs |= MethodAttributes.Static;
        }
        else if (ev.IsVirtual)
        {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }
        else if (ev.IsOverride)
        {
            methodAttrs |= MethodAttributes.Virtual;
        }

        var firstParamHandle = this.NextParameterHandle();
        for (int i = 0; i < paramCount; i++)
        {
            this.metadata.AddParameter(
                attributes: ParameterAttributes.None,
                name: this.metadata.GetOrAddString($"arg{i}"),
                sequenceNumber: i + 1);
        }

        return this.metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString($"raise_{ev.Name}"),
            signature: this.metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle);
    }

    /// <summary>ADR-0052: resolves a MemberReferenceHandle for Delegate.Combine(Delegate, Delegate).</summary>
    private MemberReferenceHandle GetDelegateCombineRef()
    {
        if (this.delegateCombineRef.HasValue)
        {
            return this.delegateCombineRef.Value;
        }

        var delegateTypeRef = this.GetTypeReference(typeof(System.Delegate));
        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: false)
            .Parameters(2,
                r => r.Type().Type(delegateTypeRef, isValueType: false),
                ps =>
                {
                    ps.AddParameter().Type().Type(delegateTypeRef, isValueType: false);
                    ps.AddParameter().Type().Type(delegateTypeRef, isValueType: false);
                });

        this.delegateCombineRef = this.metadata.AddMemberReference(
            delegateTypeRef,
            this.metadata.GetOrAddString("Combine"),
            this.metadata.GetOrAddBlob(sig));
        return this.delegateCombineRef.Value;
    }

    /// <summary>ADR-0052: resolves a MemberReferenceHandle for Delegate.Remove(Delegate, Delegate).</summary>
    private MemberReferenceHandle GetDelegateRemoveRef()
    {
        if (this.delegateRemoveRef.HasValue)
        {
            return this.delegateRemoveRef.Value;
        }

        var delegateTypeRef = this.GetTypeReference(typeof(System.Delegate));
        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: false)
            .Parameters(2,
                r => r.Type().Type(delegateTypeRef, isValueType: false),
                ps =>
                {
                    ps.AddParameter().Type().Type(delegateTypeRef, isValueType: false);
                    ps.AddParameter().Type().Type(delegateTypeRef, isValueType: false);
                });

        this.delegateRemoveRef = this.metadata.AddMemberReference(
            delegateTypeRef,
            this.metadata.GetOrAddString("Remove"),
            this.metadata.GetOrAddBlob(sig));
        return this.delegateRemoveRef.Value;
    }

    /// <summary>
    /// Issue #256: resolves the open MemberRef for Interlocked.CompareExchange&lt;T&gt;(ref T, T, T).
    /// </summary>
    private MemberReferenceHandle GetInterlockedCompareExchangeOpenRef()
    {
        if (this.interlockedCompareExchangeOpenRef.HasValue)
        {
            return this.interlockedCompareExchangeOpenRef.Value;
        }

        var interlockedTypeRef = this.GetTypeReference(typeof(System.Threading.Interlocked));

        // Signature: static T CompareExchange<T>(ref T, T, T) with 1 generic param.
        // In open form, T is !!0 (method type parameter at index 0).
        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: false, genericParameterCount: 1)
            .Parameters(3,
                r => r.Type().GenericMethodTypeParameter(0),
                ps =>
                {
                    ps.AddParameter().Type(isByRef: true).GenericMethodTypeParameter(0);
                    ps.AddParameter().Type().GenericMethodTypeParameter(0);
                    ps.AddParameter().Type().GenericMethodTypeParameter(0);
                });

        this.interlockedCompareExchangeOpenRef = this.metadata.AddMemberReference(
            interlockedTypeRef,
            this.metadata.GetOrAddString("CompareExchange"),
            this.metadata.GetOrAddBlob(sig));
        return this.interlockedCompareExchangeOpenRef.Value;
    }

    /// <summary>
    /// Issue #256: produces a MethodSpec for Interlocked.CompareExchange&lt;EventType&gt;.
    /// </summary>
    private EntityHandle GetInterlockedCompareExchangeSpec(TypeSymbol eventType)
    {
        var openRef = this.GetInterlockedCompareExchangeOpenRef();
        var sigBlob = new BlobBuilder();
        var argsEncoder = new BlobEncoder(sigBlob).MethodSpecificationSignature(1);
        var typeEncoder = argsEncoder.AddArgument();
        this.EncodeTypeSymbol(typeEncoder, eventType);
        return this.metadata.AddMethodSpecification(openRef, this.metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Emits a nested-private TypeDef for a state-machine type.  Same as
    /// <see cref="EmitStructTypeDef"/> but uses <c>NestedPrivate</c> visibility
    /// and an empty namespace (nested types have no namespace in metadata).
    /// </summary>
    /// <summary>
    /// Converts the per-method <c>constValues</c> dictionary into a list of
    /// <see cref="LocalConstantInfo"/> descriptors for the Portable PDB
    /// <c>LocalConstant</c> table. Each entry corresponds to one compile-time
    /// <c>const</c> binding that occupied no IL slot.
    /// </summary>
    private static IReadOnlyList<LocalConstantInfo> CollectLocalConstantInfo(Dictionary<VariableSymbol, object> constValues)
    {
        if (constValues == null || constValues.Count == 0)
        {
            return System.Array.Empty<LocalConstantInfo>();
        }

        var result = new List<LocalConstantInfo>(constValues.Count);
        foreach (var kvp in constValues)
        {
            result.Add(new LocalConstantInfo(kvp.Key.Name ?? string.Empty, kvp.Value));
        }

        return result;
    }

    /// <summary>
    /// Pre-scans <paramref name="body"/> and populates
    /// <paramref name="constValues"/> with every <c>const</c>-declared local
    /// that has a compile-time <see cref="BoundVariableDeclaration.ConstantValue"/>.
    /// Called once before <see cref="CollectLocalsAndLabels"/> so that
    /// <see cref="BodyEmitter"/> can inline those values instead of loading
    /// from a slot.
    /// </summary>
    private static void CollectConstValues(BoundStatement body, Dictionary<VariableSymbol, object> constValues)
    {
        WalkStmtsForConsts(body, constValues);
    }

    private static void WalkStmtsForConsts(BoundStatement stmt, Dictionary<VariableSymbol, object> result)
    {
        switch (stmt)
        {
            case BoundVariableDeclaration vd when vd.ConstantValue != null:
                result[vd.Variable] = vd.ConstantValue;
                break;
            case BoundBlockStatement block:
                foreach (var s in block.Statements)
                {
                    WalkStmtsForConsts(s, result);
                }

                break;
            case BoundIfStatement ifs:
                WalkStmtsForConsts(ifs.ThenStatement, result);
                if (ifs.ElseStatement != null)
                {
                    WalkStmtsForConsts(ifs.ElseStatement, result);
                }

                break;
            case BoundTryStatement t:
                WalkStmtsForConsts(t.TryBlock, result);
                foreach (var clause in t.CatchClauses)
                {
                    WalkStmtsForConsts(clause.Body, result);
                }

                if (t.FinallyBlock != null)
                {
                    WalkStmtsForConsts(t.FinallyBlock, result);
                }

                break;
            case BoundPatternSwitchStatement ps:
                foreach (var arm in ps.Arms)
                {
                    if (arm.Body != null)
                    {
                        WalkStmtsForConsts(arm.Body, result);
                    }
                }

                break;
            case BoundScopeStatement sc:
                WalkStmtsForConsts(sc.Body, result);
                break;
            case BoundSelectStatement sel:
                foreach (var arm in sel.Cases)
                {
                    if (arm.Body != null)
                    {
                        WalkStmtsForConsts(arm.Body, result);
                    }
                }

                break;
        }
    }

    private void EmitNestedStructTypeDef(StructSymbol structSym, int firstFieldRow, int methodListRow)
    {
        if (!structSym.TypeArguments.IsDefaultOrEmpty)
        {
            throw new System.NotSupportedException(
                $"Internal error: a constructed StructSymbol ('{structSym.Name}') reached EmitNestedStructTypeDef.");
        }

        FieldDefinitionHandle firstField = default;
        foreach (var field in structSym.Fields)
        {
            var sigBlob = new BlobBuilder();
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), field.Type);
            var attrs = MapFieldAccessibility(field.Accessibility);
            if (field.IsReadOnly)
            {
                attrs |= FieldAttributes.InitOnly;
            }

            var handle = this.metadata.AddFieldDefinition(
                attributes: attrs,
                name: this.metadata.GetOrAddString(field.Name),
                signature: this.metadata.GetOrAddBlob(sigBlob));
            if (firstField.IsNil)
            {
                firstField = handle;
            }

            this.structFieldDefs[field] = handle;

            // Issue #186: mirror the EmitStructTypeDef path for nested types
            // so user @-annotations on fields round-trip into CustomAttribute
            // rows on the nested FieldDef as well.
            this.EmitUserAttributes(handle, field, AttributeTargetKind.Field);
        }

        if (firstField.IsNil)
        {
            firstField = MetadataTokens.FieldDefinitionHandle(firstFieldRow);
        }

        TypeAttributes typeAttrs;
        EntityHandle baseType;
        if (structSym.IsClass)
        {
            var classAttrs = TypeAttributes.Class
                | TypeAttributes.AutoLayout | TypeAttributes.AnsiClass
                | TypeAttributes.BeforeFieldInit
                | TypeAttributes.NestedPrivate;
            if (!structSym.IsOpen)
            {
                classAttrs |= TypeAttributes.Sealed;
            }

            typeAttrs = classAttrs;
            if (structSym.BaseClass != null && this.structTypeDefs.TryGetValue(structSym.BaseClass, out var baseHandle))
            {
                baseType = baseHandle;
            }
            else if (structSym.ImportedBaseType?.ClrType is Type importedBaseClr)
            {
                // Issue #296: nested class inheriting an imported CLR base.
                baseType = this.GetTypeReference(importedBaseClr);
            }
            else
            {
                baseType = this.objectTypeRef;
            }
        }
        else
        {
            typeAttrs = TypeAttributes.SequentialLayout | TypeAttributes.Sealed
                | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit
                | TypeAttributes.NestedPrivate;
            baseType = this.valueTypeRef;
        }

        // Nested types have no namespace in ECMA-335 metadata.
        var handle2 = this.metadata.AddTypeDefinition(
            attributes: typeAttrs,
            @namespace: default(StringHandle),
            name: this.metadata.GetOrAddString(structSym.Name),
            baseType: baseType,
            fieldList: firstField,
            methodList: MetadataTokens.MethodDefinitionHandle(methodListRow));
        this.structTypeDefs[structSym] = handle2;
        if (structSym.IsRefStruct)
        {
            // Issue #367: nested user-declared `ref struct` types are by-ref-like too.
            this.EmitIsByRefLikeAttribute(handle2);
        }
    }

    /// <summary>
    /// Issue #193: emits a CLR <c>enum</c> TypeDef for a user-defined GSharp
    /// <c>type Name enum { ... }</c>. The TypeDef is a sealed value type
    /// deriving from <c>System.Enum</c> with:
    ///   * an instance field <c>value__</c> of <c>int32</c> (the underlying
    ///     type per ADR-0047 §3; widen later if we add explicit underlying
    ///     -type syntax),
    ///   * one <c>public static literal</c> field per <see cref="EnumMemberSymbol"/>
    ///     carrying its integer constant via a <c>HasDefault</c> / Constant row.
    /// Custom attributes bound onto <c>EnumSymbol.Attributes</c> route
    /// to the type-def row; per-member attributes route to each literal field.
    /// </summary>
    private void EmitEnumTypeDef(EnumSymbol enumSym, int firstFieldRow, int methodListRow)
    {
        var enumTypeRef = this.GetTypeReference(this.coreEnumType);

        // P3-8 (#420): emit the TypeDef row *before* its FieldDef rows so the
        // literal-field signatures can refer to the enum's actual TypeDef
        // handle returned by AddTypeDefinition, rather than a speculative
        // row-count+1 value that breaks silently if the emit order ever
        // changes. The TypeDef's fieldList must still point at the first
        // FieldDef row that will belong to this enum, which is the next row
        // about to be added — we capture it via GetRowCount + 1 here and
        // assert below that the first AddFieldDefinition call matches.
        var firstFieldHandle = MetadataTokens.FieldDefinitionHandle(this.metadata.GetRowCount(TableIndex.Field) + 1);

        var typeAttrs = TypeAttributes.Class | TypeAttributes.Sealed
            | TypeAttributes.AnsiClass | TypeAttributes.AutoLayout
            | MapTypeAccessibility(enumSym.Accessibility);

        var enumTypeDef = this.metadata.AddTypeDefinition(
            attributes: typeAttrs,
            @namespace: this.metadata.GetOrAddString(enumSym.PackageName ?? string.Empty),
            name: this.metadata.GetOrAddString(enumSym.Name),
            baseType: enumTypeRef,
            fieldList: firstFieldHandle,
            methodList: MetadataTokens.MethodDefinitionHandle(methodListRow));
        this.enumTypeDefs[enumSym] = enumTypeDef;

        // Field 1: instance int32 'value__' with SpecialName | RTSpecialName.
        var valueFieldSigBlob = new BlobBuilder();
        new BlobEncoder(valueFieldSigBlob).FieldSignature().Int32();
        var valueFieldHandle = this.metadata.AddFieldDefinition(
            attributes: FieldAttributes.Public | FieldAttributes.SpecialName | FieldAttributes.RTSpecialName,
            name: this.metadata.GetOrAddString("value__"),
            signature: this.metadata.GetOrAddBlob(valueFieldSigBlob));
        if (valueFieldHandle != firstFieldHandle)
        {
            throw new InvalidOperationException(
                $"Enum '{enumSym.Name}' value__ FieldDef row {MetadataTokens.GetRowNumber(valueFieldHandle)} did not match the fieldList row {MetadataTokens.GetRowNumber(firstFieldHandle)} stamped on its TypeDef. This indicates another emitter inserted FieldDef rows between TypeDef creation and field emission.");
        }

        // Fields 2..N: one public static literal field per member, signature
        // is the enum's own typedef (the standard CLR convention for enum
        // literals). The Constant row is added below after all field rows
        // have been emitted so they remain in increasing parent-token order.
        var memberFieldHandles = new List<FieldDefinitionHandle>(enumSym.Members.Length);
        foreach (var member in enumSym.Members)
        {
            var memberSigBlob = new BlobBuilder();
            new BlobEncoder(memberSigBlob).FieldSignature().Type(enumTypeDef, isValueType: true);
            var memberFieldHandle = this.metadata.AddFieldDefinition(
                attributes: FieldAttributes.Public | FieldAttributes.Static | FieldAttributes.Literal | FieldAttributes.HasDefault,
                name: this.metadata.GetOrAddString(member.Name),
                signature: this.metadata.GetOrAddBlob(memberSigBlob));
            memberFieldHandles.Add(memberFieldHandle);
            this.enumMemberFieldDefs[member] = memberFieldHandle;
        }

        // Constant rows must be added in increasing parent FieldDefinition
        // order; iterating the literal fields in declaration order naturally
        // satisfies this since AddFieldDefinition is monotone.
        for (int i = 0; i < enumSym.Members.Length; i++)
        {
            this.metadata.AddConstant(parent: memberFieldHandles[i], value: enumSym.Members[i].Value);
        }

        // Issue #188 (step 3): route any user annotations attached to the
        // enum type onto the TypeDef row, and per-member annotations onto
        // each literal-field row.
        this.EmitUserAttributes(enumTypeDef, enumSym, AttributeTargetKind.Type);
        for (int i = 0; i < enumSym.Members.Length; i++)
        {
            this.EmitUserAttributes(memberFieldHandles[i], enumSym.Members[i], AttributeTargetKind.Field);
        }
    }

    /// <summary>
    /// Issue #191: emits one static <c>FieldDef</c> per user-declared top-level
    /// <c>var</c>/<c>let</c>/<c>const</c> on the entry-point package's
    /// <c>&lt;Program&gt;</c> TypeDef. Initialization stays in the entry-point
    /// method body and runs via <c>stsfld</c> as each declaration is reached,
    /// preserving existing side-effect ordering (e.g. a top-level
    /// <c>let ch = make(chan int)</c> followed by sends/receives).
    /// </summary>
    /// <remarks>
    /// The <c>InitOnly</c> flag is intentionally omitted for <c>let</c>/<c>const</c>
    /// globals: enforcing it would require moving initialization into a
    /// <c>.cctor</c>, which would reorder execution relative to interleaved
    /// top-level statements. Tracking InitOnly is left as a #191 follow-up.
    /// </remarks>
    private void EmitGlobalFieldDefs(ImmutableArray<GlobalVariableSymbol> globals)
    {
        foreach (var g in globals)
        {
            var sigBlob = new BlobBuilder();
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), g.Type);

            var attrs = MapFieldAccessibility(g.Accessibility) | FieldAttributes.Static;

            var handle = this.metadata.AddFieldDefinition(
                attributes: attrs,
                name: this.metadata.GetOrAddString(g.Name),
                signature: this.metadata.GetOrAddBlob(sigBlob));

            this.globalFieldDefs[g] = handle;

            // Route any @-annotations bound by #187 onto the FieldDef row so
            // attributes like @Obsolete round-trip into CustomAttribute rows.
            this.EmitUserAttributes(handle, g, AttributeTargetKind.Field);
        }
    }

    /// <summary>
    /// Resolves the package that a state-machine type's kickoff belongs to,
    /// for determining which <c>&lt;Program&gt;</c> TypeDef it nests inside.
    /// </summary>
    private PackageSymbol GetSmPackage(StructSymbol smSym, ImmutableArray<PackageSymbol> packages, PackageSymbol entryPointPackage)
    {
        // Try the SM's packageName to find the matching package.
        if (smSym.PackageName != null)
        {
            foreach (var pkg in packages)
            {
                if (pkg.Name == smSym.PackageName)
                {
                    return pkg;
                }
            }
        }

        return entryPointPackage ?? (packages.IsDefaultOrEmpty ? null : packages[0]);
    }

    /// <summary>Emits <c>System.Runtime.CompilerServices.IsReadOnlyAttribute</c> on an inline struct TypeDef.</summary>
    /// <param name="typeHandle">The inline struct TypeDef handle.</param>
    private void EmitIsReadOnlyAttribute(TypeDefinitionHandle typeHandle)
    {
        var ctorRef = this.GetIsReadOnlyAttributeCtorRef();

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        valueBlob.WriteUInt16(0);

        this.metadata.AddCustomAttribute(
            parent: typeHandle,
            constructor: ctorRef,
            value: this.metadata.GetOrAddBlob(valueBlob));
    }

    private MemberReferenceHandle GetIsReadOnlyAttributeCtorRef()
    {
        if (this.isReadOnlyAttributeCtorRef.HasValue)
        {
            return this.isReadOnlyAttributeCtorRef.Value;
        }

        var attrType = this.references.TryResolveType("System.Runtime.CompilerServices.IsReadOnlyAttribute", out var resolved)
            ? resolved
            : typeof(System.Runtime.CompilerServices.IsReadOnlyAttribute);
        var attrTypeRef = this.GetTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });

        this.isReadOnlyAttributeCtorRef = this.metadata.AddMemberReference(
            attrTypeRef,
            this.metadata.GetOrAddString(".ctor"),
            this.metadata.GetOrAddBlob(ctorSig));
        return this.isReadOnlyAttributeCtorRef.Value;
    }

    /// <summary>
    /// Issue #367: emits the metadata that marks a user-declared <c>ref struct</c>
    /// TypeDef as by-ref-like, matching what the C# compiler produces:
    /// <list type="bullet">
    ///   <item><description><c>System.Runtime.CompilerServices.IsByRefLikeAttribute</c>
    ///   so the CLR and any modern compiler treat the type as stack-only.</description></item>
    ///   <item><description><c>System.ObsoleteAttribute</c> carrying the well-known
    ///   guard message <c>"Types with embedded references are not supported in this
    ///   version of your compiler."</c> with <c>error: true</c>. Compilers that do
    ///   not understand by-ref-like types surface this as an error; compilers that
    ///   do recognise <c>IsByRefLikeAttribute</c> suppress the obsoletion.</description></item>
    /// </list>
    /// </summary>
    /// <param name="typeHandle">The ref-struct TypeDef handle.</param>
    private void EmitIsByRefLikeAttribute(TypeDefinitionHandle typeHandle)
    {
        var ctorRef = this.GetIsByRefLikeAttributeCtorRef();

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        valueBlob.WriteUInt16(0);

        this.metadata.AddCustomAttribute(
            parent: typeHandle,
            constructor: ctorRef,
            value: this.metadata.GetOrAddBlob(valueBlob));

        var obsoleteCtorRef = this.GetObsoleteAttributeStringBoolCtorRef();

        var obsoleteBlob = new BlobBuilder();
        obsoleteBlob.WriteUInt16(0x0001);
        obsoleteBlob.WriteSerializedString("Types with embedded references are not supported in this version of your compiler.");
        obsoleteBlob.WriteByte(1);
        obsoleteBlob.WriteUInt16(0);

        this.metadata.AddCustomAttribute(
            parent: typeHandle,
            constructor: obsoleteCtorRef,
            value: this.metadata.GetOrAddBlob(obsoleteBlob));
    }

    private MemberReferenceHandle GetIsByRefLikeAttributeCtorRef()
    {
        if (this.isByRefLikeAttributeCtorRef.HasValue)
        {
            return this.isByRefLikeAttributeCtorRef.Value;
        }

        var attrType = this.references.TryResolveType("System.Runtime.CompilerServices.IsByRefLikeAttribute", out var resolved)
            ? resolved
            : typeof(System.Runtime.CompilerServices.IsByRefLikeAttribute);
        var attrTypeRef = this.GetTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });

        this.isByRefLikeAttributeCtorRef = this.metadata.AddMemberReference(
            attrTypeRef,
            this.metadata.GetOrAddString(".ctor"),
            this.metadata.GetOrAddBlob(ctorSig));
        return this.isByRefLikeAttributeCtorRef.Value;
    }

    private MemberReferenceHandle GetObsoleteAttributeStringBoolCtorRef()
    {
        if (this.obsoleteAttributeStringBoolCtorRef.HasValue)
        {
            return this.obsoleteAttributeStringBoolCtorRef.Value;
        }

        var obsoleteType = this.references.TryResolveType("System.ObsoleteAttribute", out var obsoleteResolved)
            ? obsoleteResolved
            : typeof(System.ObsoleteAttribute);
        var obsoleteTypeRef = this.GetTypeReference(obsoleteType);

        var obsoleteCtorSig = new BlobBuilder();
        new BlobEncoder(obsoleteCtorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(2, r => r.Void(), p =>
            {
                p.AddParameter().Type().String();
                p.AddParameter().Type().Boolean();
            });

        this.obsoleteAttributeStringBoolCtorRef = this.metadata.AddMemberReference(
            obsoleteTypeRef,
            this.metadata.GetOrAddString(".ctor"),
            this.metadata.GetOrAddBlob(obsoleteCtorSig));
        return this.obsoleteAttributeStringBoolCtorRef.Value;
    }

    /// <summary>
    /// Phase 3 of #141 / ADR-0047 §3: emits a <c>CustomAttribute</c> row for
    /// every bound user annotation on <paramref name="symbol"/> whose target
    /// matches <paramref name="filter"/>. Resolves the attribute type to a
    /// CLR <see cref="Type"/>, picks a constructor matching the supplied
    /// positional argument arity / element types, writes the ECMA-335 II.23.3
    /// value blob (prolog <c>0x0001</c>, fixed args, named-arg count, named
    /// args), and attaches it to <paramref name="parent"/>.
    /// Attributes whose CLR type can't be resolved or whose ctor cannot be
    /// matched are silently skipped — the binder owns user-facing diagnostics.
    /// </summary>
    /// <param name="parent">The metadata entity (TypeDef / MethodDef / ...) to attach the attribute to.</param>
    /// <param name="symbol">The symbol carrying the bound annotation list.</param>
    /// <param name="filter">Only attributes whose <see cref="BoundAttribute.Target"/> equals this kind are emitted.</param>
    private void EmitUserAttributes(EntityHandle parent, Symbol symbol, AttributeTargetKind filter)
    {
        if (symbol?.Attributes.IsDefaultOrEmpty != false)
        {
            return;
        }

        foreach (var attr in symbol.Attributes)
        {
            if (attr.Target != filter)
            {
                continue;
            }

            this.EmitBoundAttribute(parent, attr);
        }
    }

    /// <summary>
    /// Returns the next <see cref="ParameterHandle"/> that will be assigned by
    /// the next call to <see cref="MetadataBuilder.AddParameter"/>. Issue #170:
    /// every <c>AddMethodDefinition</c> call must thread this value into its
    /// <c>parameterList</c> argument so the Param table's per-method runs stay
    /// monotone — methods that emit no parameter rows must share the same
    /// "next" handle, and methods that emit N rows anchor the run that follows.
    /// </summary>
    private ParameterHandle NextParameterHandle()
        => MetadataTokens.ParameterHandle(this.metadata.GetRowCount(TableIndex.Param) + 1);

    private void EmitBoundAttribute(EntityHandle parent, BoundAttribute attr)
    {
        var clrType = attr.AttributeType.ClrType;
        if (clrType == null)
        {
            return;
        }

        if (!this.references.TryResolveType(clrType.FullName, out var resolved))
        {
            resolved = clrType;
        }

        var positional = attr.PositionalArguments;
        var ctor = ResolveAttributeConstructor(resolved, positional);
        if (ctor == null)
        {
            return;
        }

        var ctorParams = ctor.GetParameters();
        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(
                ctorParams.Length,
                r => r.Void(),
                ps =>
                {
                    foreach (var p in ctorParams)
                    {
                        this.EncodeClrTypeForCtorSig(ps.AddParameter().Type(), p.ParameterType);
                    }
                });

        var attrTypeRef = this.GetTypeReference(resolved);
        var ctorRef = this.metadata.AddMemberReference(
            attrTypeRef,
            this.metadata.GetOrAddString(".ctor"),
            this.metadata.GetOrAddBlob(ctorSig));

        // Map the supplied positional arguments onto the constructor parameters,
        // collapsing a trailing params-array (e.g. InlineData(params object[]))
        // into a single synthesized array argument.
        var effective = BuildCtorArgumentValues(ctorParams, positional);

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        for (int i = 0; i < ctorParams.Length; i++)
        {
            // Normalize to the executing runtime's Type so the reference-equality
            // checks in the value-blob writer succeed even when the attribute was
            // resolved through a MetadataLoadContext (e.g. third-party packages).
            var writeType = NormalizeWellKnownType(ctorParams[i].ParameterType);
            WriteCustomAttributeFixedArg(valueBlob, writeType, effective[i]);
        }

        var named = attr.NamedArguments;
        valueBlob.WriteUInt16((ushort)named.Length);
        foreach (var arg in named)
        {
            WriteCustomAttributeNamedArg(valueBlob, resolved, arg);
        }

        this.metadata.AddCustomAttribute(
            parent: parent,
            constructor: ctorRef,
            value: this.metadata.GetOrAddBlob(valueBlob));
    }

    private static ConstructorInfo ResolveAttributeConstructor(Type attributeType, ImmutableArray<BoundAttributeArgument> positional)
    {
        var ctors = attributeType.GetConstructors(BindingFlags.Public | BindingFlags.Instance);

        // First pass: exact-arity match (the common case).
        foreach (var ctor in ctors)
        {
            var pars = ctor.GetParameters();
            if (pars.Length != positional.Length)
            {
                continue;
            }

            if (ParametersMatch(pars, positional, expandLast: false))
            {
                return ctor;
            }
        }

        // Second pass: params-array expansion. A constructor whose last
        // parameter is a single-dimensional array can absorb zero or more
        // trailing positional arguments, each assignable to the element type —
        // e.g. xUnit's InlineData(params object[] data). The exact-arity pass
        // above already handles passing the array directly.
        foreach (var ctor in ctors)
        {
            var pars = ctor.GetParameters();
            if (pars.Length == 0)
            {
                continue;
            }

            var lastType = pars[pars.Length - 1].ParameterType;
            if (!lastType.IsArray || lastType.GetArrayRank() != 1)
            {
                continue;
            }

            if (positional.Length < pars.Length - 1)
            {
                continue;
            }

            if (ParametersMatch(pars, positional, expandLast: true))
            {
                return ctor;
            }
        }

        return null;
    }

    private static bool ParametersMatch(ParameterInfo[] pars, ImmutableArray<BoundAttributeArgument> positional, bool expandLast)
    {
        var fixedCount = expandLast ? pars.Length - 1 : pars.Length;
        for (int i = 0; i < fixedCount; i++)
        {
            if (!ArgAssignable(positional[i].Value, pars[i].ParameterType))
            {
                return false;
            }
        }

        if (expandLast)
        {
            var elementType = pars[pars.Length - 1].ParameterType.GetElementType()!;
            for (int i = fixedCount; i < positional.Length; i++)
            {
                if (!ArgAssignable(positional[i].Value, elementType))
                {
                    return false;
                }
            }
        }

        return true;
    }

    private static bool ArgAssignable(object supplied, Type paramType)
    {
        // Everything is assignable to System.Object. Compared by name so the
        // check holds for attribute types resolved through a MetadataLoadContext.
        if (paramType.FullName == "System.Object")
        {
            return true;
        }

        if (supplied == null)
        {
            return !(paramType.IsValueType && Nullable.GetUnderlyingType(paramType) == null);
        }

        if (paramType.IsInstanceOfType(supplied))
        {
            return true;
        }

        return IsTriviallyConvertible(supplied.GetType(), paramType);
    }

    /// <summary>
    /// Maps the supplied positional arguments onto the constructor parameters,
    /// collapsing a trailing params-array into a single synthesized
    /// <see cref="object"/>[] when the call site supplied the elements inline
    /// (params expansion). Returns one value per constructor parameter.
    /// </summary>
    private static object[] BuildCtorArgumentValues(ParameterInfo[] ctorParams, ImmutableArray<BoundAttributeArgument> positional)
    {
        var lastIsArray = ctorParams.Length > 0
            && ctorParams[ctorParams.Length - 1].ParameterType.IsArray
            && ctorParams[ctorParams.Length - 1].ParameterType.GetArrayRank() == 1;

        // Direct (non-expanded) form: arity matches and the final argument is
        // itself assignable to the array parameter (or there is no array tail).
        var lastSupplied = positional.Length == ctorParams.Length && positional.Length > 0
            ? positional[positional.Length - 1].Value
            : null;
        var direct = !lastIsArray
            || (positional.Length == ctorParams.Length
                && (lastSupplied == null
                    || ctorParams[ctorParams.Length - 1].ParameterType.IsInstanceOfType(lastSupplied)
                    || lastSupplied.GetType().IsArray));

        if (direct)
        {
            var values = new object[ctorParams.Length];
            for (int i = 0; i < ctorParams.Length; i++)
            {
                values[i] = positional[i].Value;
            }

            return values;
        }

        var result = new object[ctorParams.Length];
        for (int i = 0; i < ctorParams.Length - 1; i++)
        {
            result[i] = positional[i].Value;
        }

        var tail = positional.Length - (ctorParams.Length - 1);
        var array = new object[tail];
        for (int i = 0; i < tail; i++)
        {
            array[i] = positional[ctorParams.Length - 1 + i].Value;
        }

        result[ctorParams.Length - 1] = array;
        return result;
    }

    /// <summary>
    /// Returns the executing runtime's <see cref="Type"/> for well-known
    /// core-library types (primitives, string, object, Type, and single-rank
    /// arrays thereof) so that the reference-equality dispatch in
    /// <see cref="WriteCustomAttributeFixedArg"/> works even when the attribute
    /// was resolved through a <see cref="MetadataLoadContext"/>. Unknown types
    /// are returned unchanged.
    /// </summary>
    private static Type NormalizeWellKnownType(Type t)
    {
        if (t == null)
        {
            return null;
        }

        if (t.IsArray && t.GetArrayRank() == 1)
        {
            var element = NormalizeWellKnownType(t.GetElementType()!);
            return element.MakeArrayType();
        }

        var byName = Type.GetType(t.FullName ?? string.Empty);
        return byName ?? t;
    }

    private static bool IsTriviallyConvertible(Type from, Type to)
    {
        if (from == to)
        {
            return true;
        }

        if (to.IsEnum)
        {
            return from == GetEnumUnderlyingTypeSafe(to);
        }

        if (from.IsArray && to.IsArray && from.GetArrayRank() == 1 && to.GetArrayRank() == 1)
        {
            return IsTriviallyConvertible(from.GetElementType()!, to.GetElementType()!);
        }

        return false;
    }

    private void EncodeClrTypeForCtorSig(SignatureTypeEncoder enc, Type t)
    {
        if (t == typeof(bool))
        {
            enc.Boolean();
        }
        else if (t == typeof(char))
        {
            enc.Char();
        }
        else if (t == typeof(sbyte))
        {
            enc.SByte();
        }
        else if (t == typeof(byte))
        {
            enc.Byte();
        }
        else if (t == typeof(short))
        {
            enc.Int16();
        }
        else if (t == typeof(ushort))
        {
            enc.UInt16();
        }
        else if (t == typeof(int))
        {
            enc.Int32();
        }
        else if (t == typeof(uint))
        {
            enc.UInt32();
        }
        else if (t == typeof(long))
        {
            enc.Int64();
        }
        else if (t == typeof(ulong))
        {
            enc.UInt64();
        }
        else if (t == typeof(float))
        {
            enc.Single();
        }
        else if (t == typeof(double))
        {
            enc.Double();
        }
        else if (t == typeof(string))
        {
            enc.String();
        }
        else if (t == typeof(object))
        {
            enc.Object();
        }
        else if (t.IsEnum)
        {
            EncodeClrTypeForCtorSig(enc, GetEnumUnderlyingTypeSafe(t));
        }
        else if (t.IsArray && t.GetArrayRank() == 1)
        {
            // ECMA-335 II.23.2.12: SZARRAY element-type for a single-dimensional array parameter.
            this.EncodeClrTypeForCtorSig(enc.SZArray(), t.GetElementType()!);
        }
        else if (typeof(Type).IsAssignableFrom(t))
        {
            // System.Type parameter: encoded as a CLASS type reference in the ctor signature.
            enc.Type(this.GetTypeReference(t), isValueType: false);
        }
        else
        {
            // Fallback: encode as object so the signature is still well-formed.
            enc.Object();
        }
    }

    private static void WriteCustomAttributeFixedArg(BlobBuilder bb, Type paramType, object value)
    {
        if (paramType.IsEnum)
        {
            WriteCustomAttributeFixedArg(bb, GetEnumUnderlyingTypeSafe(paramType), value);
            return;
        }

        if (paramType == typeof(bool))
        {
            bb.WriteBoolean((bool)value);
        }
        else if (paramType == typeof(char))
        {
            bb.WriteUInt16((char)value);
        }
        else if (paramType == typeof(sbyte))
        {
            bb.WriteSByte(Convert.ToSByte(value));
        }
        else if (paramType == typeof(byte))
        {
            bb.WriteByte(Convert.ToByte(value));
        }
        else if (paramType == typeof(short))
        {
            bb.WriteInt16(Convert.ToInt16(value));
        }
        else if (paramType == typeof(ushort))
        {
            bb.WriteUInt16(Convert.ToUInt16(value));
        }
        else if (paramType == typeof(int))
        {
            bb.WriteInt32(Convert.ToInt32(value));
        }
        else if (paramType == typeof(uint))
        {
            bb.WriteUInt32(Convert.ToUInt32(value));
        }
        else if (paramType == typeof(long))
        {
            bb.WriteInt64(Convert.ToInt64(value));
        }
        else if (paramType == typeof(ulong))
        {
            bb.WriteUInt64(Convert.ToUInt64(value));
        }
        else if (paramType == typeof(float))
        {
            bb.WriteSingle(Convert.ToSingle(value));
        }
        else if (paramType == typeof(double))
        {
            bb.WriteDouble(Convert.ToDouble(value));
        }
        else if (paramType == typeof(string))
        {
            bb.WriteSerializedString((string)value);
        }
        else if (typeof(Type).IsAssignableFrom(paramType))
        {
            // ECMA-335 II.23.3: a System.Type argument is encoded as a
            // SerString carrying the canonical type-name. A null Type
            // serialises as the SerString null marker (0xFF).
            bb.WriteSerializedString(value is Type t ? GetSerializedTypeName(t) : null);
        }
        else if (paramType.IsArray && paramType.GetArrayRank() == 1)
        {
            WriteCustomAttributeArrayArg(bb, paramType.GetElementType()!, value);
        }
        else if (paramType == typeof(object))
        {
            // ECMA-335 II.23.3: boxed object argument carries the
            // FieldOrPropType tag of the runtime type then the value.
            if (value == null)
            {
                // Null object: encode as STRING null marker per common practice.
                WriteCustomAttributeFieldOrPropertyType(bb, typeof(string));
                bb.WriteSerializedString(null);
            }
            else
            {
                var runtimeType = value.GetType();
                WriteCustomAttributeFieldOrPropertyType(bb, runtimeType);
                WriteCustomAttributeFixedArg(bb, runtimeType, value);
            }
        }
        else
        {
            // Fallback: serialise as string round-trip (best-effort).
            bb.WriteSerializedString(value?.ToString());
        }
    }

    private static void WriteCustomAttributeArrayArg(BlobBuilder bb, Type elementType, object value)
    {
        // ECMA-335 II.23.3: an SZARRAY argument is encoded as an Int32 length
        // (or 0xFFFFFFFF for a null array) followed by length elements of
        // FixedArg(elementType).
        if (value == null)
        {
            bb.WriteUInt32(0xFFFFFFFFu);
            return;
        }

        var array = (Array)value;
        bb.WriteInt32(array.Length);
        for (int i = 0; i < array.Length; i++)
        {
            WriteCustomAttributeFixedArg(bb, elementType, array.GetValue(i));
        }
    }

    private static string GetSerializedTypeName(Type t)
    {
        // ECMA-335 II.23.3 + I.8.5.2: the canonical serialised form is the
        // assembly-qualified name; types from mscorlib / System.Private.CoreLib
        // may omit the assembly portion. We always emit the assembly-qualified
        // form so the consumer can unambiguously rebind the type.
        return t.AssemblyQualifiedName ?? t.FullName ?? t.Name;
    }

    /// <summary>
    /// Returns the underlying primitive type of an enum in a way that works for
    /// types loaded through a <see cref="MetadataLoadContext"/>. The BCL helper
    /// <see cref="Enum.GetUnderlyingType(Type)"/> requires a runtime
    /// <see cref="Type"/> and throws <see cref="NotSupportedException"/> for
    /// metadata-loaded types (issue #418 / P1-8), which surfaces as an emit-time
    /// crash in the custom-attribute blob writer whenever an attribute argument
    /// is an enum defined in a referenced (non-BCL) package.
    /// </summary>
    /// <remarks>
    /// Per ECMA-335 II.14.3 every enum is laid out as a class containing a
    /// single instance field named <c>value__</c> whose type is the underlying
    /// primitive (e.g. <see cref="int"/>). Reading that field's type works
    /// uniformly for runtime and metadata-loaded types. The result is then
    /// normalized to the executing runtime's <see cref="Type"/> so that the
    /// reference-equality dispatch in the blob writers matches.
    /// </remarks>
    private static Type GetEnumUnderlyingTypeSafe(Type enumType)
    {
        var valueField = enumType.GetField("value__", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        var fieldType = valueField?.FieldType;
        if (fieldType == null)
        {
            // Defensive fallback: a malformed enum without value__ would be
            // invalid metadata, but treating it as int32 keeps the writer
            // robust rather than crashing during emit.
            return typeof(int);
        }

        return NormalizeWellKnownType(fieldType);
    }

    private static void WriteCustomAttributeNamedArg(BlobBuilder bb, Type attributeType, BoundAttributeArgument arg)
    {
        var prop = attributeType.GetProperty(arg.Name, BindingFlags.Public | BindingFlags.Instance);
        var field = prop == null
            ? attributeType.GetField(arg.Name, BindingFlags.Public | BindingFlags.Instance)
            : null;
        Type memberType;
        byte kindTag;
        if (prop != null)
        {
            kindTag = 0x54;
            memberType = prop.PropertyType;
        }
        else if (field != null)
        {
            kindTag = 0x53;
            memberType = field.FieldType;
        }
        else
        {
            // Unknown member — skip silently; binder owns user diagnostics.
            return;
        }

        bb.WriteByte(kindTag);
        WriteCustomAttributeFieldOrPropertyType(bb, memberType);
        bb.WriteSerializedString(arg.Name);
        WriteCustomAttributeFixedArg(bb, memberType, arg.Value);
    }

    private static void WriteCustomAttributeFieldOrPropertyType(BlobBuilder bb, Type t)
    {
        // ECMA-335 II.23.3 — element-type byte for a FIELD/PROPERTY tag.
        if (t == typeof(bool))
        {
            bb.WriteByte(0x02);
        }
        else if (t == typeof(char))
        {
            bb.WriteByte(0x03);
        }
        else if (t == typeof(sbyte))
        {
            bb.WriteByte(0x04);
        }
        else if (t == typeof(byte))
        {
            bb.WriteByte(0x05);
        }
        else if (t == typeof(short))
        {
            bb.WriteByte(0x06);
        }
        else if (t == typeof(ushort))
        {
            bb.WriteByte(0x07);
        }
        else if (t == typeof(int))
        {
            bb.WriteByte(0x08);
        }
        else if (t == typeof(uint))
        {
            bb.WriteByte(0x09);
        }
        else if (t == typeof(long))
        {
            bb.WriteByte(0x0A);
        }
        else if (t == typeof(ulong))
        {
            bb.WriteByte(0x0B);
        }
        else if (t == typeof(float))
        {
            bb.WriteByte(0x0C);
        }
        else if (t == typeof(double))
        {
            bb.WriteByte(0x0D);
        }
        else if (t == typeof(string))
        {
            bb.WriteByte(0x0E);
        }
        else if (typeof(Type).IsAssignableFrom(t))
        {
            // 0x50 — System.Type (no payload byte; the FixedArg holds the SerString).
            bb.WriteByte(0x50);
        }
        else if (t == typeof(object))
        {
            // 0x51 — boxed object. The FixedArg writer prefixes the runtime
            // type tag and value when emitting the argument body.
            bb.WriteByte(0x51);
        }
        else if (t.IsArray && t.GetArrayRank() == 1)
        {
            // 0x1D SZARRAY followed by the element type's FieldOrPropType byte.
            bb.WriteByte(0x1D);
            WriteCustomAttributeFieldOrPropertyType(bb, t.GetElementType()!);
        }
        else if (t.IsEnum)
        {
            // 0x55 then serialised type name (assembly-qualified).
            bb.WriteByte(0x55);
            bb.WriteSerializedString(GetSerializedTypeName(t));
        }
        else
        {
            // Fallback to STRING.
            bb.WriteByte(0x0E);
        }
    }

    /// <summary>
    /// Phase 3.B.4: emits a TypeDef row for a user-defined interface. Carries
    /// <c>TypeAttributes.Interface | Abstract | Public</c>, no fields, and a
    /// methodList pointing at its preassigned first abstract-method row.
    /// </summary>
    /// <param name="ifaceSym">The interface symbol.</param>
    /// <param name="firstMethodRow">The preassigned first method row.</param>
    /// <param name="firstFieldRow">The first field row for the next aggregate (interfaces own no fields, so this is forwarded as their fieldList).</param>
    private void EmitInterfaceTypeDef(InterfaceSymbol ifaceSym, int firstMethodRow, int firstFieldRow)
    {
        var typeAttrs = TypeAttributes.Interface | TypeAttributes.Abstract
            | TypeAttributes.AutoLayout | TypeAttributes.AnsiClass
            | MapTypeAccessibility(ifaceSym.Accessibility);
        var handle = this.metadata.AddTypeDefinition(
            attributes: typeAttrs,
            @namespace: this.metadata.GetOrAddString(ifaceSym.PackageName ?? string.Empty),
            name: this.metadata.GetOrAddString(ifaceSym.Name),
            baseType: default(EntityHandle),
            fieldList: MetadataTokens.FieldDefinitionHandle(firstFieldRow),
            methodList: MetadataTokens.MethodDefinitionHandle(firstMethodRow));
        this.interfaceTypeDefs[ifaceSym] = handle;

        // Phase 3 of #141: user annotations targeting the type land on this TypeDef.
        this.EmitUserAttributes(handle, ifaceSym, AttributeTargetKind.Type);
    }

    /// <summary>
    /// Issue #248: emits abstract accessor MethodDefs, PropertyDef rows, PropertyMap,
    /// and MethodSemantics rows for all properties declared on an interface.
    /// </summary>
    private void EmitInterfacePropertyAccessors(InterfaceSymbol ifaceSym)
    {
        if (ifaceSym.Properties.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.interfaceTypeDefs.TryGetValue(ifaceSym, out var typeDefHandle))
        {
            return;
        }

        PropertyDefinitionHandle firstPropDef = default;
        foreach (var prop in ifaceSym.Properties)
        {
            if (!this.propertyAccessorHandles.TryGetValue(prop, out var accessorHandles))
            {
                continue;
            }

            // Emit abstract getter MethodDef.
            MethodDefinitionHandle? emittedGetter = null;
            if (prop.HasGetter && accessorHandles.Getter.HasValue)
            {
                var sigBlob = new BlobBuilder();
                new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
                    .Parameters(0, r => this.EncodeTypeSymbol(r.Type(), prop.Type), _ => { });

                var attrs = MethodAttributes.Public | MethodAttributes.HideBySig
                    | MethodAttributes.Virtual | MethodAttributes.Abstract
                    | MethodAttributes.NewSlot | MethodAttributes.SpecialName;
                emittedGetter = this.metadata.AddMethodDefinition(
                    attributes: attrs,
                    implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
                    name: this.metadata.GetOrAddString($"get_{prop.Name}"),
                    signature: this.metadata.GetOrAddBlob(sigBlob),
                    bodyOffset: -1,
                    parameterList: this.NextParameterHandle());
            }

            // Emit abstract setter MethodDef.
            MethodDefinitionHandle? emittedSetter = null;
            if (prop.HasSetter && accessorHandles.Setter.HasValue)
            {
                var sigBlob = new BlobBuilder();
                new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
                    .Parameters(1, r => r.Void(), ps =>
                    {
                        this.EncodeTypeSymbol(ps.AddParameter().Type(), prop.Type);
                    });

                var attrs = MethodAttributes.Public | MethodAttributes.HideBySig
                    | MethodAttributes.Virtual | MethodAttributes.Abstract
                    | MethodAttributes.NewSlot | MethodAttributes.SpecialName;
                emittedSetter = this.metadata.AddMethodDefinition(
                    attributes: attrs,
                    implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
                    name: this.metadata.GetOrAddString($"set_{prop.Name}"),
                    signature: this.metadata.GetOrAddBlob(sigBlob),
                    bodyOffset: -1,
                    parameterList: this.NextParameterHandle());
            }

            // Emit PropertyDef row.
            var propertySignature = new BlobBuilder();
            new BlobEncoder(propertySignature)
                .PropertySignature(isInstanceProperty: true)
                .Parameters(0, returnType => this.EncodeTypeSymbol(returnType.Type(), prop.Type), parameters => { });

            var propDef = this.metadata.AddProperty(
                attributes: PropertyAttributes.None,
                name: this.metadata.GetOrAddString(prop.Name),
                signature: this.metadata.GetOrAddBlob(propertySignature));

            if (firstPropDef.IsNil)
            {
                firstPropDef = propDef;
            }

            // MethodSemantics rows linking accessor MethodDefs to the PropertyDef.
            if (emittedGetter.HasValue)
            {
                this.metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Getter, emittedGetter.Value);
            }

            if (emittedSetter.HasValue)
            {
                this.metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Setter, emittedSetter.Value);
            }
        }

        // PropertyMap row: links the TypeDef to its first PropertyDef.
        if (!firstPropDef.IsNil)
        {
            this.metadata.AddPropertyMap(typeDefHandle, firstPropDef);
            this.typesWithPropertyMap.Add(typeDefHandle);
        }
    }

    /// <summary>
    /// ADR-0052: emits abstract add/remove accessor MethodDefs, EventDef rows, EventMap,
    /// and MethodSemantics rows for all events declared on an interface.
    /// </summary>
    private void EmitInterfaceEventAccessors(InterfaceSymbol ifaceSym)
    {
        if (ifaceSym.Events.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.interfaceTypeDefs.TryGetValue(ifaceSym, out var typeDefHandle))
        {
            return;
        }

        EventDefinitionHandle firstEventDef = default;
        foreach (var ev in ifaceSym.Events)
        {
            if (!this.eventAccessorHandles.TryGetValue(ev, out var accessorHandles))
            {
                continue;
            }

            // Emit abstract add_X MethodDef.
            var addSigBlob = new BlobBuilder();
            new BlobEncoder(addSigBlob).MethodSignature(isInstanceMethod: true)
                .Parameters(1, r => r.Void(), ps => this.EncodeTypeSymbol(ps.AddParameter().Type(), ev.Type));

            var addAttrs = MethodAttributes.Public | MethodAttributes.HideBySig
                | MethodAttributes.Virtual | MethodAttributes.Abstract
                | MethodAttributes.NewSlot | MethodAttributes.SpecialName;
            var emittedAdd = this.metadata.AddMethodDefinition(
                attributes: addAttrs,
                implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
                name: this.metadata.GetOrAddString($"add_{ev.Name}"),
                signature: this.metadata.GetOrAddBlob(addSigBlob),
                bodyOffset: -1,
                parameterList: this.NextParameterHandle());

            // Emit abstract remove_X MethodDef.
            var removeSigBlob = new BlobBuilder();
            new BlobEncoder(removeSigBlob).MethodSignature(isInstanceMethod: true)
                .Parameters(1, r => r.Void(), ps => this.EncodeTypeSymbol(ps.AddParameter().Type(), ev.Type));

            var removeAttrs = MethodAttributes.Public | MethodAttributes.HideBySig
                | MethodAttributes.Virtual | MethodAttributes.Abstract
                | MethodAttributes.NewSlot | MethodAttributes.SpecialName;
            var emittedRemove = this.metadata.AddMethodDefinition(
                attributes: removeAttrs,
                implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
                name: this.metadata.GetOrAddString($"remove_{ev.Name}"),
                signature: this.metadata.GetOrAddBlob(removeSigBlob),
                bodyOffset: -1,
                parameterList: this.NextParameterHandle());

            // Emit EventDef row.
            var eventTypeHandle = this.GetEventTypeHandle(ev.Type);

            var eventDef = this.metadata.AddEvent(
                attributes: EventAttributes.None,
                name: this.metadata.GetOrAddString(ev.Name),
                type: eventTypeHandle);

            if (firstEventDef.IsNil)
            {
                firstEventDef = eventDef;
            }

            // MethodSemantics rows linking accessor MethodDefs to the EventDef.
            this.metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Adder, emittedAdd);
            this.metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Remover, emittedRemove);

            // Issue #257: emit abstract raise_X MethodDef if present.
            if (ev.RaiseMethodSymbol != null)
            {
                int raiseParamCount = 0;
                if (ev.Type is FunctionTypeSymbol fnType)
                {
                    raiseParamCount = fnType.ParameterTypes.Length;
                }

                var raiseSigBlob = new BlobBuilder();
                new BlobEncoder(raiseSigBlob).MethodSignature(isInstanceMethod: true)
                    .Parameters(raiseParamCount, r => r.Void(), ps =>
                    {
                        if (ev.Type is FunctionTypeSymbol fn)
                        {
                            foreach (var pt in fn.ParameterTypes)
                            {
                                this.EncodeTypeSymbol(ps.AddParameter().Type(), pt);
                            }
                        }
                    });

                var raiseAttrs = MethodAttributes.Public | MethodAttributes.HideBySig
                    | MethodAttributes.Virtual | MethodAttributes.Abstract
                    | MethodAttributes.NewSlot | MethodAttributes.SpecialName;
                var emittedRaise = this.metadata.AddMethodDefinition(
                    attributes: raiseAttrs,
                    implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
                    name: this.metadata.GetOrAddString($"raise_{ev.Name}"),
                    signature: this.metadata.GetOrAddBlob(raiseSigBlob),
                    bodyOffset: -1,
                    parameterList: this.NextParameterHandle());

                this.metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Raiser, emittedRaise);
            }
        }

        // EventMap row: links the TypeDef to its first EventDef.
        if (!firstEventDef.IsNil)
        {
            this.metadata.AddEventMap(typeDefHandle, firstEventDef);
        }
    }

    /// <summary>
    /// Phase 3.B.4: emits an abstract method definition for an interface
    /// member. Carries <c>Public | Virtual | Abstract | NewSlot | HideBySig</c>
    /// and no body (bodyOffset = -1).
    /// </summary>
    /// <param name="method">The interface method symbol.</param>
    private void EmitAbstractMethod(FunctionSymbol method)
    {
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                method.Parameters.Length,
                r => EncodeReturnSymbol(r, method.Type),
                ps =>
                {
                    foreach (var p in method.Parameters)
                    {
                        EncodeTypeSymbol(ps.AddParameter().Type(), p.Type);
                    }
                });

        var attrs = MethodAttributes.Public | MethodAttributes.HideBySig
            | MethodAttributes.Virtual | MethodAttributes.Abstract
            | MethodAttributes.NewSlot;
        this.metadata.AddMethodDefinition(
            attributes: attrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString(method.Name),
            signature: this.metadata.GetOrAddBlob(sigBlob),
            bodyOffset: -1,
            parameterList: this.NextParameterHandle());
    }

    /// <summary>
    /// Emits a parameter-less <c>.ctor</c> for a user-defined <c>class</c>
    /// (Phase 3.B.3). The body chains to the base class's <c>.ctor()</c>
    /// (either an inherited user class or <c>System.Object</c>) and returns.
    /// </summary>
    /// <param name="classSym">The class whose default constructor is being emitted.</param>
    private MethodDefinitionHandle EmitClassDefaultConstructor(StructSymbol classSym)
    {
        var baseCtorToken = this.GetBaseCtorToken(classSym);
        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            var il = new InstructionEncoder(new BlobBuilder());
            il.LoadArgument(0);
            il.OpCode(ILOpCode.Call);
            il.Token(baseCtorToken);
            il.OpCode(ILOpCode.Ret);
            bodyOffset = this.methodBodyStream.AddMethodBody(il);
        }

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });

        return this.metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName
                | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString(".ctor"),
            signature: this.metadata.GetOrAddBlob(ctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.NextParameterHandle());
    }

    /// <summary>
    /// Emits a <c>.cctor</c> (type initializer) for a type with static field
    /// initializers (Issue #262). The body evaluates each initializer expression
    /// and stores the result into the corresponding static field via <c>stsfld</c>.
    /// </summary>
    private void EmitStaticConstructor(StructSymbol typeSym)
    {
        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            // Build a synthetic body: for each field with an initializer,
            // emit the expression + stsfld.
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            foreach (var field in typeSym.StaticFields)
            {
                if (typeSym.StaticFieldInitializers.TryGetValue(field, out var initExpr))
                {
                    // Synthesize: field = initExpr (as an expression statement).
                    var assignment = new BoundFieldAssignmentExpression(null, null, typeSym, field, initExpr);
                    statements.Add(new BoundExpressionStatement(null, assignment));
                }
            }

            var body = new BoundBlockStatement(null, statements.ToImmutable());

            var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
            var locals = new Dictionary<VariableSymbol, int>();
            var labels = new Dictionary<BoundLabel, LabelHandle>();
            var localTypes = new List<TypeSymbol>();
            var appendSlots = new Dictionary<BoundAppendExpression, (int Src, int Dst)>();
            var structLiteralSlots = new Dictionary<BoundStructLiteralExpression, int>();
            var defaultExpressionSlots = new Dictionary<BoundDefaultExpression, int>();
            var mapIndexSlots = new Dictionary<BoundIndexExpression, int>();
            var patternSwitchSlots = new Dictionary<BoundPatternSwitchStatement, int>();
            var typePatternScratchSlots = new Dictionary<BoundTypePattern, int>();
            var switchExpressionSlots = new Dictionary<BoundSwitchExpression, (int Result, int Discriminant)>();
            var channelOpSlots = new Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)>();
            var scopeFrameSlots = new Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)>();
            var selectStatementSlots = new Dictionary<BoundSelectStatement, SelectSlots>();
            var receiverSpillSlots = new Dictionary<BoundExpression, int>();
            var indexAssignmentValueSlots = new Dictionary<BoundExpression, int>();
            var goEnclosingScopes = new Dictionary<BoundGoStatement, BoundScopeStatement>();
            var constValues = new Dictionary<VariableSymbol, object>();

            CollectLocalsAndLabels(
                body,
                null,
                locals,
                localTypes,
                labels,
                appendSlots,
                structLiteralSlots,
                defaultExpressionSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                receiverSpillSlots,
                indexAssignmentValueSlots,
                goEnclosingScopes,
                il);

            var parameters = new Dictionary<ParameterSymbol, int>();

            StandaloneSignatureHandle localsSignature = default;
            if (localTypes.Count > 0)
            {
                var localsSigBlob = new BlobBuilder();
                var encoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(localTypes.Count);
                foreach (var t in localTypes)
                {
                    EncodeTypeSymbol(encoder.AddVariable().Type(), t);
                }

                localsSignature = this.metadata.AddStandaloneSignature(this.metadata.GetOrAddBlob(localsSigBlob));
            }

            var emitter = new BodyEmitter(
                this,
                il,
                locals,
                parameters,
                labels,
                appendSlots,
                structLiteralSlots,
                defaultExpressionSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                receiverSpillSlots,
                indexAssignmentValueSlots,
                goEnclosingScopes,
                constValues: constValues);
            emitter.EmitBlock(body);
            il.OpCode(ILOpCode.Ret);

            bodyOffset = this.methodBodyStream.AddMethodBody(il, localVariablesSignature: localsSignature);
        }

        var cctorSig = new BlobBuilder();
        new BlobEncoder(cctorSig).MethodSignature(isInstanceMethod: false)
            .Parameters(0, r => r.Void(), _ => { });

        this.metadata.AddMethodDefinition(
            attributes: MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.SpecialName
                | MethodAttributes.RTSpecialName | MethodAttributes.Static,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString(".cctor"),
            signature: this.metadata.GetOrAddBlob(cctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.NextParameterHandle());
    }

    /// <summary>Resolves the <c>.ctor()</c> token a derived class's ctor should chain to: either the base class's default ctor (already emitted) or <see cref="objectCtorRef"/>.</summary>
    private EntityHandle GetBaseCtorToken(StructSymbol classSym)
    {
        if (classSym.BaseClass != null && this.classCtorHandles.TryGetValue(classSym.BaseClass, out var baseCtor))
        {
            return baseCtor;
        }

        if (classSym.IsAttributeClass)
        {
            // Phase 4 of #141 / ADR-0047 §5: chain to System.Attribute..ctor()
            // since the base type was overridden away from System.Object.
            return this.GetSystemAttributeCtorRef();
        }

        if (classSym.ImportedBaseType?.ClrType is Type importedBaseClr)
        {
            // Issue #296: chain the generated ctor to the imported CLR base's
            // accessible parameterless constructor.
            return this.GetImportedBaseDefaultCtorReference(importedBaseClr);
        }

        return this.objectCtorRef;
    }

    /// <summary>
    /// Issue #296: resolves a MemberRef to the imported CLR base class's
    /// accessible parameterless <c>.ctor()</c> for base-constructor chaining.
    /// Uses metadata-safe reflection (the declaring type is loaded under a
    /// MetadataLoadContext). Falls back to a synthesized parameterless ctor
    /// reference when no explicit parameterless ctor is discoverable.
    /// </summary>
    private EntityHandle GetImportedBaseDefaultCtorReference(Type importedBaseClr)
    {
        ConstructorInfo parameterless = null;
        foreach (var ctor in importedBaseClr.GetConstructors(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (ctor.GetParameters().Length != 0)
            {
                continue;
            }

            if (ctor.IsPublic || ctor.IsFamily || ctor.IsFamilyOrAssembly)
            {
                parameterless = ctor;
                break;
            }
        }

        if (parameterless != null)
        {
            return this.GetCtorReference(parameterless);
        }

        // No explicit accessible parameterless ctor was found; reference a
        // synthesized parameterless ctor signature on the base type ref. This
        // matches the implicit default ctor a base class would otherwise expose.
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });
        return this.metadata.AddMemberReference(
            parent: this.GetTypeReference(importedBaseClr),
            name: this.metadata.GetOrAddString(".ctor"),
            signature: this.metadata.GetOrAddBlob(sigBlob));
    }

    private EntityHandle GetSystemAttributeTypeRef()
    {
        if (!this.systemAttributeTypeRef.HasValue)
        {
            var t = this.references.TryResolveType("System.Attribute", out var resolved)
                ? resolved
                : typeof(System.Attribute);
            this.systemAttributeTypeRef = this.GetTypeReference(t);
        }

        return this.systemAttributeTypeRef.Value;
    }

    private MemberReferenceHandle GetSystemAttributeCtorRef()
    {
        if (!this.systemAttributeCtorRef.HasValue)
        {
            var attrTypeRef = this.GetSystemAttributeTypeRef();
            var ctorSig = new BlobBuilder();
            new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
                .Parameters(0, r => r.Void(), _ => { });

            this.systemAttributeCtorRef = this.metadata.AddMemberReference(
                attrTypeRef,
                this.metadata.GetOrAddString(".ctor"),
                this.metadata.GetOrAddBlob(ctorSig));
        }

        return this.systemAttributeCtorRef.Value;
    }

    /// <summary>
    /// Emits the Kotlin-style primary constructor for a class
    /// (Phase 3.B.3 sub-step 2): an instance ctor taking one parameter per
    /// declared primary-ctor param, chaining to <c>object::.ctor()</c> and
    /// assigning each argument to the same-named field.
    /// </summary>
    /// <param name="classSym">The class with a declared primary constructor.</param>
    private MethodDefinitionHandle EmitClassPrimaryConstructor(StructSymbol classSym)
    {
        var parameters = classSym.PrimaryConstructorParameters;
        var baseCtorToken = this.GetBaseCtorToken(classSym);

        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            var il = new InstructionEncoder(new BlobBuilder());
            il.LoadArgument(0);
            il.OpCode(ILOpCode.Call);
            il.Token(baseCtorToken);

            // For each ctor param: this.<field> = arg; positional 1:1 with
            // fields of the same name.
            for (var i = 0; i < parameters.Length; i++)
            {
                var param = parameters[i];
                if (!classSym.TryGetField(param.Name, out var field))
                {
                    throw new InvalidOperationException($"Class '{classSym.Name}' has no field for primary ctor parameter '{param.Name}'.");
                }

                if (!this.structFieldDefs.TryGetValue(field, out var fieldHandle))
                {
                    throw new InvalidOperationException($"Class field '{field.Name}' has no emitted FieldDef.");
                }

                il.LoadArgument(0);
                il.LoadArgument(i + 1);
                il.OpCode(ILOpCode.Stfld);
                il.Token(fieldHandle);
            }

            il.OpCode(ILOpCode.Ret);
            bodyOffset = this.methodBodyStream.AddMethodBody(il);
        }

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(
                parameters.Length,
                r => r.Void(),
                ps =>
                {
                    foreach (var p in parameters)
                    {
                        this.EncodeTypeSymbol(ps.AddParameter().Type(), p.Type);
                    }
                });

        return this.metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName
                | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString(".ctor"),
            signature: this.metadata.GetOrAddBlob(ctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.NextParameterHandle());
    }

    /// <summary>
    /// Issue #306: emits a constructor that forwards arguments to an explicit
    /// base constructor (<c>: Base(args)</c>) before initializing the class's
    /// own fields from the primary-constructor parameters. The base arguments
    /// are evaluated via a <see cref="BodyEmitter"/> so they may reference the
    /// primary-constructor parameters; the resolved base ctor token comes from
    /// the bound <see cref="BaseConstructorInitializer"/>.
    /// </summary>
    /// <param name="classSym">The class whose forwarding constructor is being emitted.</param>
    /// <param name="parameters">The constructor parameters (the primary-constructor parameters, or empty when the base arguments are constant).</param>
    private MethodDefinitionHandle EmitClassConstructorWithBaseInitializer(StructSymbol classSym, ImmutableArray<ParameterSymbol> parameters)
    {
        var init = classSym.BaseConstructorInitializer;
        var baseCtorToken = this.GetBaseInitializerCtorToken(classSym, init);

        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());

            var locals = new Dictionary<VariableSymbol, int>();
            var labels = new Dictionary<BoundLabel, LabelHandle>();
            var localTypes = new List<TypeSymbol>();
            var appendSlots = new Dictionary<BoundAppendExpression, (int Src, int Dst)>();
            var structLiteralSlots = new Dictionary<BoundStructLiteralExpression, int>();
            var defaultExpressionSlots = new Dictionary<BoundDefaultExpression, int>();
            var mapIndexSlots = new Dictionary<BoundIndexExpression, int>();
            var patternSwitchSlots = new Dictionary<BoundPatternSwitchStatement, int>();
            var typePatternScratchSlots = new Dictionary<BoundTypePattern, int>();
            var switchExpressionSlots = new Dictionary<BoundSwitchExpression, (int Result, int Discriminant)>();
            var channelOpSlots = new Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)>();
            var scopeFrameSlots = new Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)>();
            var selectStatementSlots = new Dictionary<BoundSelectStatement, SelectSlots>();
            var receiverSpillSlots = new Dictionary<BoundExpression, int>();
            var indexAssignmentValueSlots = new Dictionary<BoundExpression, int>();
            var goEnclosingScopes = new Dictionary<BoundGoStatement, BoundScopeStatement>();
            var constValues = new Dictionary<VariableSymbol, object>();

            // Pre-scan the base arguments so any scratch slots they require are
            // allocated and registered in the locals signature.
            if (!init.Arguments.IsDefaultOrEmpty)
            {
                var synth = ImmutableArray.CreateBuilder<BoundStatement>(init.Arguments.Length);
                foreach (var arg in init.Arguments)
                {
                    synth.Add(new BoundExpressionStatement(null, arg));
                }

                CollectLocalsAndLabels(
                    new BoundBlockStatement(null, synth.ToImmutable()),
                    null,
                    locals,
                    localTypes,
                    labels,
                    appendSlots,
                    structLiteralSlots,
                    defaultExpressionSlots,
                    mapIndexSlots,
                    patternSwitchSlots,
                    typePatternScratchSlots,
                    switchExpressionSlots,
                    channelOpSlots,
                    scopeFrameSlots,
                    selectStatementSlots,
                    receiverSpillSlots,
                    indexAssignmentValueSlots,
                    goEnclosingScopes,
                    il);
            }

            var paramSlots = new Dictionary<ParameterSymbol, int>();
            for (var i = 0; i < parameters.Length; i++)
            {
                paramSlots[parameters[i]] = i + 1;
            }

            StandaloneSignatureHandle localsSignature = default;
            if (localTypes.Count > 0)
            {
                var localsSigBlob = new BlobBuilder();
                var encoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(localTypes.Count);
                foreach (var t in localTypes)
                {
                    EncodeTypeSymbol(encoder.AddVariable().Type(), t);
                }

                localsSignature = this.metadata.AddStandaloneSignature(this.metadata.GetOrAddBlob(localsSigBlob));
            }

            var emitter = new BodyEmitter(
                this,
                il,
                locals,
                paramSlots,
                labels,
                appendSlots,
                structLiteralSlots,
                defaultExpressionSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                receiverSpillSlots,
                indexAssignmentValueSlots,
                goEnclosingScopes,
                constValues: constValues);

            // base(args)
            il.LoadArgument(0);
            if (!init.Arguments.IsDefaultOrEmpty)
            {
                foreach (var arg in init.Arguments)
                {
                    emitter.EmitValue(arg);
                }
            }

            il.OpCode(ILOpCode.Call);
            il.Token(baseCtorToken);

            // this.<field> = arg; positional 1:1 with same-named fields.
            for (var i = 0; i < parameters.Length; i++)
            {
                var param = parameters[i];
                if (!classSym.TryGetField(param.Name, out var field))
                {
                    throw new InvalidOperationException($"Class '{classSym.Name}' has no field for primary ctor parameter '{param.Name}'.");
                }

                if (!this.structFieldDefs.TryGetValue(field, out var fieldHandle))
                {
                    throw new InvalidOperationException($"Class field '{field.Name}' has no emitted FieldDef.");
                }

                il.LoadArgument(0);
                il.LoadArgument(i + 1);
                il.OpCode(ILOpCode.Stfld);
                il.Token(fieldHandle);
            }

            il.OpCode(ILOpCode.Ret);
            bodyOffset = this.methodBodyStream.AddMethodBody(il, localVariablesSignature: localsSignature);
        }

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(
                parameters.Length,
                r => r.Void(),
                ps =>
                {
                    foreach (var p in parameters)
                    {
                        this.EncodeTypeSymbol(ps.AddParameter().Type(), p.Type);
                    }
                });

        return this.metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName
                | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString(".ctor"),
            signature: this.metadata.GetOrAddBlob(ctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.NextParameterHandle());
    }

    /// <summary>
    /// Issue #306: emits a class constructor materialized from an explicit
    /// <c>init(...)</c> declaration. The body first chains to the resolved base
    /// constructor (either the explicit <c>: base(args)</c> initializer or the
    /// conventional parameterless chain) and then runs the bound constructor
    /// body, which sees <c>this</c>, the constructor parameters, and the class's
    /// fields (as bare names).
    /// </summary>
    /// <param name="classSym">The class whose explicit constructor is being emitted.</param>
    private MethodDefinitionHandle EmitClassConstructorWithBody(StructSymbol classSym)
    {
        var ctor = classSym.ExplicitConstructor;
        var function = ctor.Function;
        var body = this.program.Functions[function];
        var init = ctor.BaseInitializer;
        var baseCtorToken = init != null
            ? this.GetBaseInitializerCtorToken(classSym, init)
            : this.GetBaseCtorToken(classSym);

        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());

            var locals = new Dictionary<VariableSymbol, int>();
            var labels = new Dictionary<BoundLabel, LabelHandle>();
            var localTypes = new List<TypeSymbol>();
            var appendSlots = new Dictionary<BoundAppendExpression, (int Src, int Dst)>();
            var structLiteralSlots = new Dictionary<BoundStructLiteralExpression, int>();
            var defaultExpressionSlots = new Dictionary<BoundDefaultExpression, int>();
            var mapIndexSlots = new Dictionary<BoundIndexExpression, int>();
            var patternSwitchSlots = new Dictionary<BoundPatternSwitchStatement, int>();
            var typePatternScratchSlots = new Dictionary<BoundTypePattern, int>();
            var switchExpressionSlots = new Dictionary<BoundSwitchExpression, (int Result, int Discriminant)>();
            var channelOpSlots = new Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)>();
            var scopeFrameSlots = new Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)>();
            var selectStatementSlots = new Dictionary<BoundSelectStatement, SelectSlots>();
            var receiverSpillSlots = new Dictionary<BoundExpression, int>();
            var indexAssignmentValueSlots = new Dictionary<BoundExpression, int>();
            var goEnclosingScopes = new Dictionary<BoundGoStatement, BoundScopeStatement>();
            var constValues = new Dictionary<VariableSymbol, object>();

            // Pre-scan the base arguments so any scratch slots they require are
            // allocated and registered in the locals signature.
            if (init != null && !init.Arguments.IsDefaultOrEmpty)
            {
                var synth = ImmutableArray.CreateBuilder<BoundStatement>(init.Arguments.Length);
                foreach (var arg in init.Arguments)
                {
                    synth.Add(new BoundExpressionStatement(null, arg));
                }

                CollectLocalsAndLabels(
                    new BoundBlockStatement(null, synth.ToImmutable()),
                    null,
                    locals,
                    localTypes,
                    labels,
                    appendSlots,
                    structLiteralSlots,
                    defaultExpressionSlots,
                    mapIndexSlots,
                    patternSwitchSlots,
                    typePatternScratchSlots,
                    switchExpressionSlots,
                    channelOpSlots,
                    scopeFrameSlots,
                    selectStatementSlots,
                    receiverSpillSlots,
                    indexAssignmentValueSlots,
                    goEnclosingScopes,
                    il);
            }

            CollectConstValues(body, constValues);
            CollectLocalsAndLabels(
                body,
                function,
                locals,
                localTypes,
                labels,
                appendSlots,
                structLiteralSlots,
                defaultExpressionSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                receiverSpillSlots,
                indexAssignmentValueSlots,
                goEnclosingScopes,
                il);

            // Slot 0 is the implicit `this`; user parameters shift up by one.
            var paramSlots = new Dictionary<ParameterSymbol, int>
            {
                [function.ThisParameter] = 0,
            };
            for (var i = 0; i < function.Parameters.Length; i++)
            {
                paramSlots[function.Parameters[i]] = i + 1;
            }

            StandaloneSignatureHandle localsSignature = default;
            if (localTypes.Count > 0)
            {
                var localsSigBlob = new BlobBuilder();
                var encoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(localTypes.Count);
                foreach (var t in localTypes)
                {
                    EncodeTypeSymbol(encoder.AddVariable().Type(), t);
                }

                localsSignature = this.metadata.AddStandaloneSignature(this.metadata.GetOrAddBlob(localsSigBlob));
            }

            var emitter = new BodyEmitter(
                this,
                il,
                locals,
                paramSlots,
                labels,
                appendSlots,
                structLiteralSlots,
                defaultExpressionSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                receiverSpillSlots,
                indexAssignmentValueSlots,
                goEnclosingScopes,
                constValues: constValues);

            // base(args) — `this` followed by the (ref-kind aware) base arguments.
            il.LoadArgument(0);
            if (init != null && !init.Arguments.IsDefaultOrEmpty)
            {
                emitter.EmitBaseConstructorArguments(init.Arguments, init.ArgumentRefKinds);
            }

            il.OpCode(ILOpCode.Call);
            il.Token(baseCtorToken);

            // Run the user-authored constructor body.
            emitter.EmitBlock(body);

            il.OpCode(ILOpCode.Ret);
            bodyOffset = this.methodBodyStream.AddMethodBody(il, localVariablesSignature: localsSignature);
        }

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(
                function.Parameters.Length,
                r => r.Void(),
                ps =>
                {
                    foreach (var p in function.Parameters)
                    {
                        this.EncodeTypeSymbol(ps.AddParameter().Type(), p.Type);
                    }
                });

        return this.metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName
                | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString(".ctor"),
            signature: this.metadata.GetOrAddBlob(ctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.NextParameterHandle());
    }

    /// <summary>Issue #306: resolves the metadata token of the base constructor targeted by a <see cref="BaseConstructorInitializer"/>.</summary>
    private EntityHandle GetBaseInitializerCtorToken(StructSymbol classSym, BaseConstructorInitializer init)
    {
        if (init.IsClrBase)
        {
            return this.GetCtorReference(init.ClrConstructor);
        }

        var gsharpBase = init.GSharpBaseType;
        if (init.Arguments.Length > 0
            && gsharpBase.HasPrimaryConstructor
            && this.classPrimaryCtorHandles.TryGetValue(gsharpBase, out var primaryHandle))
        {
            return primaryHandle;
        }

        if (this.classCtorHandles.TryGetValue(gsharpBase, out var defaultHandle))
        {
            return defaultHandle;
        }

        // Fall back to the conventional resolution (parameterless chain).
        return this.GetBaseCtorToken(classSym);
    }

    private static TypeAttributes MapTypeAccessibility(Accessibility accessibility)
    {
        return accessibility switch
        {
            Accessibility.Internal => TypeAttributes.NotPublic,
            Accessibility.Private => TypeAttributes.NotPublic,
            _ => TypeAttributes.Public,
        };
    }

    private static TypeAttributes MapNestedTypeAccessibility(Accessibility accessibility)
    {
        return accessibility switch
        {
            Accessibility.Internal => TypeAttributes.NestedAssembly,
            Accessibility.Private => TypeAttributes.NestedPrivate,
            _ => TypeAttributes.NestedPublic,
        };
    }

    private static FieldAttributes MapFieldAccessibility(Accessibility accessibility)
    {
        return accessibility switch
        {
            Accessibility.Internal => FieldAttributes.Assembly,
            Accessibility.Private => FieldAttributes.Private,
            _ => FieldAttributes.Public,
        };
    }

    /// <summary>Emits the ADR-0033 synthesized members for an inline struct.</summary>
    /// <param name="structSym">The inline struct symbol.</param>
    private void EmitInlineStructSynthesizedMembers(StructSymbol structSym)
    {
        var field = structSym.Fields[0];
        var fieldHandle = this.structFieldDefs[field];
        var typeDef = this.structTypeDefs[structSym];
        this.EmitInlineEqualsObject(structSym, field, fieldHandle, typeDef);
        this.EmitInlineEqualsTyped(structSym, field, fieldHandle);
        this.EmitInlineGetHashCode(structSym, field, fieldHandle);
        this.EmitInlineToString(structSym, field, fieldHandle);
        this.EmitInlineEqualityOperator(structSym, field, fieldHandle, isInequality: false);
        this.EmitInlineEqualityOperator(structSym, field, fieldHandle, isInequality: true);
        this.EmitInlineDeconstruct(structSym, field, fieldHandle);
    }

    private void EmitBoxIfNeeded(InstructionEncoder il, TypeSymbol type)
    {
        if (IsValueTypeSymbol(type))
        {
            il.OpCode(ILOpCode.Box);
            il.Token(this.GetElementTypeToken(type));
        }
    }

    private int FinishInlineBody(InstructionEncoder il)
    {
        return this.metadataOnly ? -1 : this.methodBodyStream.AddMethodBody(il);
    }

    private void EmitInlineEqualsObject(StructSymbol structSym, FieldSymbol field, FieldDefinitionHandle fieldHandle, TypeDefinitionHandle typeDef)
    {
        // Issue #420 (P3-10): the IL below uses `unbox` to obtain a managed pointer
        // to the inline struct's field after `isinst`. `unbox` is only legal on
        // value types; if reference-type structs/records are ever introduced,
        // this helper must switch to `castclass` (and skip the boxed indirection
        // entirely). Assert the value-type assumption explicitly so a future
        // reference-type StructSymbol fails loudly in Debug builds instead of
        // silently producing invalid IL.
        Debug.Assert(
            !structSym.IsClass,
            "Equals(object) emit assumes value-type struct; reference-type records require castclass instead of unbox");

        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
        if (!this.metadataOnly)
        {
            var hasValue = il.DefineLabel();
            il.LoadArgument(1);
            il.OpCode(ILOpCode.Isinst);
            il.Token(typeDef);
            il.OpCode(ILOpCode.Dup);
            il.Branch(ILOpCode.Brtrue, hasValue);
            il.OpCode(ILOpCode.Pop);
            il.LoadConstantI4(0);
            il.OpCode(ILOpCode.Ret);
            il.MarkLabel(hasValue);
            il.OpCode(ILOpCode.Pop);
            il.LoadArgument(0);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            this.EmitBoxIfNeeded(il, field.Type);
            il.LoadArgument(1);
            il.OpCode(ILOpCode.Unbox);
            il.Token(typeDef);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            this.EmitBoxIfNeeded(il, field.Type);
            il.Call(this.GetObjectStaticEqualsReference());
            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(1, r => r.Type().Boolean(), ps => ps.AddParameter().Type().Object());
        this.metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.metadata.GetOrAddString("Equals"), this.metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), this.NextParameterHandle());
    }

    private void EmitInlineEqualsTyped(StructSymbol structSym, FieldSymbol field, FieldDefinitionHandle fieldHandle)
    {
        var il = new InstructionEncoder(new BlobBuilder());
        if (!this.metadataOnly)
        {
            il.LoadArgument(0);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            this.EmitBoxIfNeeded(il, field.Type);
            il.LoadArgumentAddress(1);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            this.EmitBoxIfNeeded(il, field.Type);
            il.Call(this.GetObjectStaticEqualsReference());
            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(1, r => r.Type().Boolean(), ps => this.EncodeTypeSymbol(ps.AddParameter().Type(), structSym));
        this.metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.metadata.GetOrAddString("Equals"), this.metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), this.NextParameterHandle());
    }

    private void EmitInlineGetHashCode(StructSymbol structSym, FieldSymbol field, FieldDefinitionHandle fieldHandle)
    {
        var il = new InstructionEncoder(new BlobBuilder());
        if (!this.metadataOnly)
        {
            il.LoadArgument(0);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            this.EmitBoxIfNeeded(il, field.Type);
            il.OpCode(ILOpCode.Callvirt);
            il.Token(this.GetObjectInstanceGetHashCodeReference());
            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(0, r => r.Type().Int32(), _ => { });
        this.metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.metadata.GetOrAddString("GetHashCode"), this.metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), this.NextParameterHandle());
    }

    private void EmitInlineToString(StructSymbol structSym, FieldSymbol field, FieldDefinitionHandle fieldHandle)
    {
        var il = new InstructionEncoder(new BlobBuilder());
        if (!this.metadataOnly)
        {
            il.LoadString(this.metadata.GetOrAddUserString(structSym.Name + "(" + field.Name + "="));
            il.LoadArgument(0);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            this.EmitBoxIfNeeded(il, field.Type);
            il.OpCode(ILOpCode.Callvirt);
            il.Token(this.GetObjectInstanceToStringReference());
            il.Call(this.GetStringConcatReference());
            il.LoadString(this.metadata.GetOrAddUserString(")"));
            il.Call(this.GetStringConcatReference());
            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(0, r => r.Type().String(), _ => { });
        this.metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.metadata.GetOrAddString("ToString"), this.metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), this.NextParameterHandle());
    }

    private void EmitInlineEqualityOperator(StructSymbol structSym, FieldSymbol field, FieldDefinitionHandle fieldHandle, bool isInequality)
    {
        var il = new InstructionEncoder(new BlobBuilder());
        if (!this.metadataOnly)
        {
            il.LoadArgumentAddress(0);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            this.EmitBoxIfNeeded(il, field.Type);
            il.LoadArgumentAddress(1);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            this.EmitBoxIfNeeded(il, field.Type);
            il.Call(this.GetObjectStaticEqualsReference());
            if (isInequality)
            {
                il.LoadConstantI4(0);
                il.OpCode(ILOpCode.Ceq);
            }

            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: false)
            .Parameters(
                2,
                r => r.Type().Boolean(),
                ps =>
                {
                    this.EncodeTypeSymbol(ps.AddParameter().Type(), structSym);
                    this.EncodeTypeSymbol(ps.AddParameter().Type(), structSym);
                });
        this.metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.SpecialName | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.metadata.GetOrAddString(isInequality ? "op_Inequality" : "op_Equality"), this.metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), this.NextParameterHandle());
    }

    private void EmitInlineDeconstruct(StructSymbol structSym, FieldSymbol field, FieldDefinitionHandle fieldHandle)
    {
        var il = new InstructionEncoder(new BlobBuilder());
        if (!this.metadataOnly)
        {
            il.LoadArgument(1);
            il.LoadArgument(0);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            il.OpCode(ILOpCode.Stobj);
            il.Token(this.GetElementTypeToken(field.Type));
            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(1, r => r.Void(), ps => this.EncodeTypeSymbol(ps.AddParameter().Type(isByRef: true), field.Type));
        this.metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.metadata.GetOrAddString("Deconstruct"), this.metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), this.NextParameterHandle());
    }

    /// <summary>
    /// Emits the <c>MoveNext</c> method for an async state machine using the
    /// rewritten bound-tree body produced by <see cref="MoveNextBodyRewriter"/>.
    /// </summary>
    private void EmitStateMachineMoveNext(AsyncStateMachinePlan plan)
    {
        var smStruct = plan.StateMachine.MaterializeAsStructSymbol();

        int bodyOffset = -1;
        IReadOnlyList<SequencePoint> capturedSequencePoints = null;
        IReadOnlyList<LocalInfo> capturedLocals = null;
        IReadOnlyList<LocalConstantInfo> capturedConstants = null;
        int capturedCodeSize = 0;
        StandaloneSignatureHandle capturedLocalsSignature = default;
        if (!this.metadataOnly)
        {
            var moveNextBody = MoveNextBodyRewriter.Build(plan);
            var body = moveNextBody.Body;

            var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());

            // Pre-scan locals, labels, and the rest for the body emitter.
            var locals = new Dictionary<VariableSymbol, int>();
            var labels = new Dictionary<BoundLabel, LabelHandle>();
            var localTypes = new List<TypeSymbol>();
            var appendSlots = new Dictionary<BoundAppendExpression, (int Src, int Dst)>();
            var structLiteralSlots = new Dictionary<BoundStructLiteralExpression, int>();
            var defaultExpressionSlots = new Dictionary<BoundDefaultExpression, int>();
            var mapIndexSlots = new Dictionary<BoundIndexExpression, int>();
            var patternSwitchSlots = new Dictionary<BoundPatternSwitchStatement, int>();
            var typePatternScratchSlots = new Dictionary<BoundTypePattern, int>();
            var switchExpressionSlots = new Dictionary<BoundSwitchExpression, (int Result, int Discriminant)>();
            var channelOpSlots = new Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)>();
            var scopeFrameSlots = new Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)>();
            var selectStatementSlots = new Dictionary<BoundSelectStatement, SelectSlots>();
            var receiverSpillSlots = new Dictionary<BoundExpression, int>();
            var indexAssignmentValueSlots = new Dictionary<BoundExpression, int>();
            var goEnclosingScopes = new Dictionary<BoundGoStatement, BoundScopeStatement>();

            // Issue #216: collect compile-time const bindings before slot allocation.
            var constValues = new Dictionary<VariableSymbol, object>();
            CollectConstValues(body, constValues);

            CollectLocalsAndLabels(
                body,
                null,
                locals,
                localTypes,
                labels,
                appendSlots,
                structLiteralSlots,
                defaultExpressionSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                receiverSpillSlots,
                indexAssignmentValueSlots,
                goEnclosingScopes,
                il);

            // MoveNext is instance on the SM struct: arg0 = this.
            var parameters = new Dictionary<ParameterSymbol, int>
            {
                [moveNextBody.ThisParameter] = 0,
            };

            StandaloneSignatureHandle localsSignature = default;
            if (localTypes.Count > 0)
            {
                var localsSigBlob = new BlobBuilder();
                var encoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(localTypes.Count);
                foreach (var t in localTypes)
                {
                    EncodeTypeSymbol(encoder.AddVariable().Type(), t);
                }

                localsSignature = this.metadata.AddStandaloneSignature(this.metadata.GetOrAddBlob(localsSigBlob));
            }

            var emitter = new BodyEmitter(
                this,
                il,
                locals,
                parameters,
                labels,
                appendSlots,
                structLiteralSlots,
                defaultExpressionSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                receiverSpillSlots,
                indexAssignmentValueSlots,
                goEnclosingScopes,
                constValues: constValues,
                structThisParameter: moveNextBody.ThisParameter,
                asyncFieldMap: plan.FieldMap,
                asyncPlan: plan);
            emitter.EmitBlock(body);

            bodyOffset = this.methodBodyStream.AddMethodBody(il, localVariablesSignature: localsSignature);
            capturedSequencePoints = emitter.SequencePoints;
            capturedLocals = CollectLocalInfo(locals);
            capturedConstants = CollectLocalConstantInfo(constValues);
            capturedCodeSize = il.Offset;
            capturedLocalsSignature = localsSignature;
        }

        // MoveNext signature: void MoveNext() (instance)
        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });

        var moveNextHandle = this.metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig
                | MethodAttributes.NewSlot | MethodAttributes.Final,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString("MoveNext"),
            signature: this.metadata.GetOrAddBlob(sig),
            bodyOffset: bodyOffset,
            parameterList: this.NextParameterHandle());

        // Phase 4/5 (ADR-0027 §7.7a): MoveNext is the visible body for an async
        // method post-lowering; sequence points and locals captured here surface
        // in debugger stack traces, locals window, and `step` commands across
        // `await` points.
        this.pdb?.RecordMethod(moveNextHandle, capturedSequencePoints, capturedLocals, capturedConstants, capturedCodeSize, capturedLocalsSignature, plan.KickoffMethod?.Declaration?.SyntaxTree);
    }

    /// <summary>
    /// Emits the <c>SetStateMachine(IAsyncStateMachine)</c> method for an
    /// async state machine. For struct state machines, this is a no-op body.
    /// </summary>
    private void EmitStateMachineSetStateMachine(AsyncStateMachinePlan plan)
    {
        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            var il = new InstructionEncoder(new BlobBuilder());
            il.OpCode(ILOpCode.Ret);
            bodyOffset = this.methodBodyStream.AddMethodBody(il);
        }

        var iAsyncSmType = typeof(System.Runtime.CompilerServices.IAsyncStateMachine);
        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true)
            .Parameters(1, r => r.Void(), ps =>
            {
                this.EncodeClrType(ps.AddParameter().Type(), iAsyncSmType);
            });

        this.metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig
                | MethodAttributes.NewSlot | MethodAttributes.Final,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString("SetStateMachine"),
            signature: this.metadata.GetOrAddBlob(sig),
            bodyOffset: bodyOffset,
            parameterList: this.NextParameterHandle());
    }

    /// <summary>
    /// Emits IL for pushing the default value of a CLR type onto the stack.
    /// </summary>
    private void EmitDefaultValue(InstructionEncoder il, Type type)
    {
        if (type == typeof(int) || type == typeof(bool) || type == typeof(byte)
            || type == typeof(short) || type == typeof(char))
        {
            il.LoadConstantI4(0);
        }
        else if (type == typeof(long))
        {
            il.LoadConstantI8(0);
        }
        else if (type == typeof(float))
        {
            il.OpCode(ILOpCode.Ldc_r4);
            il.CodeBuilder.WriteSingle(0.0f);
        }
        else if (type == typeof(double))
        {
            il.OpCode(ILOpCode.Ldc_r8);
            il.CodeBuilder.WriteDouble(0.0);
        }
        else if (type.IsValueType)
        {
            // For value types we need initobj pattern but SetResult takes the value
            // by value, not by ref. Use a local initialized to default.
            // Simplified: just push 0 for small structs or use ldloca + initobj.
            // For now, use a simple approach: push ldloca on a temp, initobj, ldloc.
            // Actually, the simplest correct approach: if it's a primitive, handled above.
            // For struct value types, we can't easily push default without a local.
            // Let's use ldloca on the arg slot (but we don't have one).
            // Simplest: we won't support generic Task<CustomStruct> yet.
            // For the common cases (Task<int>, Task<string>, Task<bool>), the above handles it.
            // Fallback: push 0 and hope for the best (works for small value types).
            il.LoadConstantI4(0);
        }
        else
        {
            // Reference types: default is null.
            il.OpCode(ILOpCode.Ldnull);
        }
    }

    /// <summary>
    /// Emits the kickoff body for an async function: creates the state-machine
    /// local, initializes fields, calls <c>builder.Start(ref sm)</c>, and
    /// returns <c>builder.Task</c> (or returns void for async void).
    /// </summary>
    private int EmitAsyncKickoffBody(FunctionSymbol function, AsyncStateMachinePlan plan)
    {
        var smStruct = plan.StateMachine.MaterializeAsStructSymbol();
        var smTypeDef = this.structTypeDefs[smStruct];
        var builderInfo = plan.StateMachine.BuilderInfo;
        var stateFieldHandle = this.structFieldDefs[plan.FieldMap.StateField];
        var builderFieldHandle = this.structFieldDefs[plan.FieldMap.BuilderField];

        var il = new InstructionEncoder(new BlobBuilder());

        // Local 0: the state-machine struct instance.
        // ldloca.s 0 / initobj SM  — zero-initialize the struct.
        il.LoadLocalAddress(0);
        il.OpCode(ILOpCode.Initobj);
        il.Token(smTypeDef);

        // sm.<>t__builder = AsyncTaskMethodBuilder[<T>].Create()
        il.LoadLocalAddress(0);
        var createRef = this.GetMethodEntityHandle(builderInfo.CreateMethod);
        il.OpCode(ILOpCode.Call);
        il.Token(createRef);
        il.OpCode(ILOpCode.Stfld);
        il.Token(builderFieldHandle);

        // Copy this (for instance methods)
        if (plan.FieldMap.ThisField != null && function.IsInstanceMethod)
        {
            var thisFieldHandle = this.structFieldDefs[plan.FieldMap.ThisField];
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
            var fieldHandle = this.structFieldDefs[copy.Field];
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
        var startMethodSpec = this.GetStateMachineStartMethodSpec(builderInfo.StartMethod, smStruct);
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
            var getTaskRef = this.GetMethodEntityHandle(getTaskMethod);
            il.OpCode(ILOpCode.Call);
            il.Token(getTaskRef);
        }

        il.OpCode(ILOpCode.Ret);

        // Locals: one local of the state-machine struct type.
        var localsSigBlob = new BlobBuilder();
        var localsEncoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(1);
        localsEncoder.AddVariable().Type().Type(smTypeDef, isValueType: true);
        var localsSignature = this.metadata.AddStandaloneSignature(this.metadata.GetOrAddBlob(localsSigBlob));

        return this.methodBodyStream.AddMethodBody(
            il,
            maxStack: 3,
            localVariablesSignature: localsSignature);
    }

    /// <summary>
    /// Gets a MethodSpec for <c>builder.Start&lt;SM&gt;(ref SM)</c> where SM
    /// is the state-machine struct TypeDef.
    /// </summary>
    private EntityHandle GetStateMachineStartMethodSpec(MethodInfo startOpenMethod, StructSymbol smStruct)
    {
        // Start is an open generic instance method on the builder struct.
        // We need: MemberRef for Start<T>(ref T) on the builder type,
        // then a MethodSpec instantiating it with the SM TypeDef.
        var openRef = this.GetMethodReference(startOpenMethod.IsGenericMethod
            ? startOpenMethod.GetGenericMethodDefinition()
            : startOpenMethod);

        // Build MethodSpec signature: instantiation with SM struct type.
        var smTypeDef = this.structTypeDefs[smStruct];
        var sigBlob = new BlobBuilder();
        var argsEncoder = new BlobEncoder(sigBlob).MethodSpecificationSignature(1);
        argsEncoder.AddArgument().Type(smTypeDef, isValueType: true);

        return this.metadata.AddMethodSpecification(openRef, this.metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Emits the <c>builder.AwaitUnsafeOnCompleted&lt;TAwaiter, TSM&gt;(ref awaiter, ref this)</c>
    /// or <c>AwaitOnCompleted</c> call from within MoveNext. Requires manual MethodSpec
    /// construction because TStateMachine is the synthesized SM TypeDef.
    /// </summary>
    private void EmitAwaitOnCompletedCall(
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
            foreach (var plan in this.asyncStateMachinePlans)
            {
                if (plan.FieldMap.StateField != null)
                {
                    if (this.structFieldDefs.ContainsKey(plan.FieldMap.BuilderField))
                    {
                        currentPlan = plan;
                        break;
                    }
                }
            }
        }

        FieldSymbol builderField;
        StructSymbol smStruct;
        Lowering.Async.AsyncMethodBuilderInfo builderInfo;
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

        var builderFieldHandle = this.structFieldDefs[builderField];

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

        var openRef = this.GetMethodReference(openMethod.IsGenericMethod
            ? openMethod.GetGenericMethodDefinition()
            : openMethod);

        var smTypeDef = this.structTypeDefs[smStruct];
        var sigBlob = new BlobBuilder();
        var argsEncoder = new BlobEncoder(sigBlob).MethodSpecificationSignature(2);

        // First type arg: TAwaiter
        this.EncodeClrType(argsEncoder.AddArgument(), node.AwaiterClrType);

        // Second type arg: TStateMachine (the SM TypeDef)
        argsEncoder.AddArgument().Type(smTypeDef, isValueType: smIsValueType);

        var methodSpec = this.metadata.AddMethodSpecification(openRef, this.metadata.GetOrAddBlob(sigBlob));
        il.OpCode(ILOpCode.Call);
        il.Token(methodSpec);
    }

    /// <summary>
    /// Encodes the CLR return type for an async kickoff method:
    /// <c>Task</c>, <c>Task&lt;T&gt;</c>, or <c>void</c> for async-void.
    /// </summary>
    private void EncodeAsyncReturnType(ReturnTypeEncoder encoder, AsyncStateMachinePlan plan)
    {
        var builderInfo = plan.StateMachine.BuilderInfo;
        if (builderInfo.Kind == AsyncMethodBuilderKind.Void)
        {
            encoder.Void();
        }
        else if (builderInfo.TaskProperty != null)
        {
            // The Task property's return type IS the kickoff return type.
            var taskClrType = builderInfo.TaskProperty.PropertyType;
            this.EncodeClrType(encoder.Type(), taskClrType);
        }
        else
        {
            encoder.Void();
        }
    }

    private MethodDefinitionHandle EmitDefaultConstructor()
    {
        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            var il = new InstructionEncoder(new BlobBuilder());
            il.LoadArgument(0);
            il.Call(this.objectCtorRef);
            il.OpCode(ILOpCode.Ret);
            bodyOffset = this.methodBodyStream.AddMethodBody(il);
        }

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });

        return this.metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName
                | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString(".ctor"),
            signature: this.metadata.GetOrAddBlob(ctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.NextParameterHandle());
    }

    private MethodDefinitionHandle EmitFunction(FunctionSymbol function, BoundBlockStatement body, bool isEntryPoint)
    {
        if (this.iteratorKickoffBodies.TryGetValue(function, out var iteratorKickoffBody))
        {
            body = iteratorKickoffBody;
        }

        // Async kickoff body: replace the user body with the kickoff stub
        // that creates the state machine, initializes it, and calls Start.
        AsyncStateMachinePlan asyncPlan = null;
        if (function.IsAsync && function.StateMachineType != null)
        {
            foreach (var plan in this.asyncStateMachinePlans)
            {
                if (plan.KickoffMethod == function)
                {
                    asyncPlan = plan;
                    break;
                }
            }
        }

        // Phase 4 emit parity (F1): generic functions are emitted with a
        // type-erased signature — each open type parameter is encoded as
        // System.Object via EncodeTypeSymbol. Call sites insert the box /
        // unbox.any around the boundary. This matches the interpreter's
        // type-erased semantics. ADR-0004 still calls for CLR reified
        // generics as the long-term goal; F2 will widen to GenericParam +
        // MVAR/VAR encoding and add a MethodSpec at call sites.
        int bodyOffset = -1;
        IReadOnlyList<SequencePoint> capturedSequencePoints = null;
        IReadOnlyList<LocalInfo> capturedLocals = null;
        IReadOnlyList<LocalConstantInfo> capturedConstants = null;
        int capturedCodeSize = 0;
        StandaloneSignatureHandle capturedLocalsSignature = default;
        if (!this.metadataOnly)
        {
            if (asyncPlan != null)
            {
                bodyOffset = this.EmitAsyncKickoffBody(function, asyncPlan);
            }
            else
            {
            var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());

            // Pre-scan body for locals (top-level only — Lowerer flattens blocks) and labels.
            var locals = new Dictionary<VariableSymbol, int>();
            var labels = new Dictionary<BoundLabel, LabelHandle>();
            var localTypes = new List<TypeSymbol>();
            var appendSlots = new Dictionary<BoundAppendExpression, (int Src, int Dst)>();
            var structLiteralSlots = new Dictionary<BoundStructLiteralExpression, int>();
            var defaultExpressionSlots = new Dictionary<BoundDefaultExpression, int>();
            var mapIndexSlots = new Dictionary<BoundIndexExpression, int>();
            var patternSwitchSlots = new Dictionary<BoundPatternSwitchStatement, int>();
            var typePatternScratchSlots = new Dictionary<BoundTypePattern, int>();
            var switchExpressionSlots = new Dictionary<BoundSwitchExpression, (int Result, int Discriminant)>();
            var channelOpSlots = new Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)>();
            var scopeFrameSlots = new Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)>();
            var selectStatementSlots = new Dictionary<BoundSelectStatement, SelectSlots>();
            var receiverSpillSlots = new Dictionary<BoundExpression, int>();
            var indexAssignmentValueSlots = new Dictionary<BoundExpression, int>();
            var goEnclosingScopes = new Dictionary<BoundGoStatement, BoundScopeStatement>();

            // Issue #216: collect compile-time const bindings before slot allocation.
            var constValues = new Dictionary<VariableSymbol, object>();
            CollectConstValues(body, constValues);

            CollectLocalsAndLabels(
                body,
                function,
                locals,
                localTypes,
                labels,
                appendSlots,
                structLiteralSlots,
                defaultExpressionSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                receiverSpillSlots,
                indexAssignmentValueSlots,
                goEnclosingScopes,
                il);

            // For instance methods, IL slot 0 is the implicit `this`, so user
            // parameters shift up by one. Both the synthesized `ThisParameter`
            // (slot 0) and the user parameters are registered so emit sites
            // can resolve either.
            var parameters = new Dictionary<ParameterSymbol, int>();
            int paramSlotShift = function.IsInstanceMethod ? 1 : 0;
            if (function.IsInstanceMethod)
            {
                parameters[function.ThisParameter] = 0;
            }

            var emittedParameterIndex = 0;
            for (var i = 0; i < function.Parameters.Length; i++)
            {
                if (ReferenceEquals(function.Parameters[i], function.ThisParameter))
                {
                    continue;
                }

                parameters[function.Parameters[i]] = emittedParameterIndex + paramSlotShift;
                emittedParameterIndex++;
            }

            StandaloneSignatureHandle localsSignature = default;
            if (localTypes.Count > 0)
            {
                var localsSigBlob = new BlobBuilder();
                var encoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(localTypes.Count);
                foreach (var t in localTypes)
                {
                    EncodeTypeSymbol(encoder.AddVariable().Type(), t);
                }

                localsSignature = this.metadata.AddStandaloneSignature(this.metadata.GetOrAddBlob(localsSigBlob));
            }

            // Detect async iterator MoveNext and thread emit context.
            AsyncIteratorEmitContext aiEmitCtx = null;
            if (function.Name == "MoveNext" && function.ReceiverType is StructSymbol owningSmClass)
            {
                this.asyncIteratorEmitContexts.TryGetValue(owningSmClass, out aiEmitCtx);
            }

            // For struct instance methods, pass structThisParameter so the
            // BodyEmitter knows arg0 is already a managed pointer (ref T) and
            // emits ldarg.0 instead of ldarga.0 when accessing fields via this.
            ParameterSymbol structThis = null;
            if (function.IsInstanceMethod
                && function.ReceiverType is StructSymbol recvStruct
                && !recvStruct.IsClass)
            {
                structThis = function.ThisParameter;
            }

            var emitter = new BodyEmitter(
                this,
                il,
                locals,
                parameters,
                labels,
                appendSlots,
                structLiteralSlots,
                defaultExpressionSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                receiverSpillSlots,
                indexAssignmentValueSlots,
                goEnclosingScopes,
                constValues: constValues,
                structThisParameter: structThis,
                asyncIteratorEmitCtx: aiEmitCtx);
            emitter.EmitBlock(body);

            // Always cap with a trailing ret. Lowering does not guarantee one for void.
            if (function.Type == TypeSymbol.Void)
            {
                il.OpCode(ILOpCode.Ret);
            }

            bodyOffset = this.methodBodyStream.AddMethodBody(il, localVariablesSignature: localsSignature);
            capturedSequencePoints = emitter.SequencePoints;
            capturedLocals = CollectLocalInfo(locals);
            capturedConstants = CollectLocalConstantInfo(constValues);
            capturedCodeSize = il.Offset;
            capturedLocalsSignature = localsSignature;
            } // end else (non-async path)
        }

        var sigBlob = new BlobBuilder();
        var signatureParameterCount = function.Parameters.Length - (function.ExplicitReceiverParameter == null ? 0 : 1);
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: function.IsInstanceMethod)
            .Parameters(
                signatureParameterCount,
                r =>
                {
                    if (asyncPlan != null)
                    {
                        this.EncodeAsyncReturnType(r, asyncPlan);
                    }
                    else
                    {
                        EncodeReturnSymbol(r, function.Type);
                    }
                },
                ps =>
                {
                    foreach (var p in function.Parameters)
                    {
                        if (ReferenceEquals(p, function.ThisParameter))
                        {
                            continue;
                        }

                        EncodeTypeSymbol(ps.AddParameter().Type(), p.Type);
                    }
                });

        // Synthesized entry point uses the C#-style mangled name; explicit Main / user funcs keep their source name.
        var methodName = isEntryPoint && function.Declaration is null ? "<Main>$" : function.Name;

        // The synthesized entry point must remain Public so the runtime can find it.
        var visibility = isEntryPoint && function.Declaration is null
            ? MethodAttributes.Public
            : ToMethodVisibility(function.Accessibility);

        // Instance methods omit MethodAttributes.Static. Phase 3.B.3 sub-step 3
        // models open/override per ADR-0017 for classes:
        //   plain (neither):    Virtual | NewSlot | Final  (callvirt-safe, non-overridable)
        //   open:               Virtual | NewSlot          (overridable in derived)
        //   override (sealed):  Virtual | Final            (reuses base slot, no further override)
        //   open override:      Virtual                    (reuses base slot, still overridable)
        //
        // Issue #409 follow-up: plain instance methods on value-type StructSymbol
        // receivers use the C#-conventional HideBySig-only shape. Value-type
        // overrides and interface implementations still need virtual slots for
        // CLR dispatch through the base/interface vtable.
        var methodAttrs = visibility | MethodAttributes.HideBySig;

        // Stream D: extension functions whose name follows the CLR `op_*`
        // convention came from `func (a T) operator +(...)` and should round-
        // trip as SpecialName so consumers (e.g. C#) see them as operators.
        if (function.IsExtension && function.Name != null && function.Name.StartsWith("op_"))
        {
            methodAttrs |= MethodAttributes.SpecialName;
        }

        // Issue #257: event accessor methods (add_X, remove_X, raise_X) are marked SpecialName.
        if (function.IsSpecialName)
        {
            methodAttrs |= MethodAttributes.SpecialName;
        }

        if (function.IsInstanceMethod)
        {
            var receiverStruct = function.ReceiverType as StructSymbol;
            var receiverIsValueType = receiverStruct != null && !receiverStruct.IsClass;
            if (!receiverIsValueType || RequiresVirtualOnValueType(function, receiverStruct))
            {
                methodAttrs |= MethodAttributes.Virtual;
                if (!function.IsOverride)
                {
                    methodAttrs |= MethodAttributes.NewSlot;
                }

                if (!function.IsOpen)
                {
                    methodAttrs |= MethodAttributes.Final;
                }
            }
        }
        else
        {
            methodAttrs |= MethodAttributes.Static;
        }

        // Issue #170 / ADR-0047 §3: emit a Parameter row per source parameter
        // so we can attach a CustomAttribute to each one. The first emitted
        // ParameterHandle becomes the MethodDef.parameterList anchor; if the
        // function has no parameters we leave it pointing at the next ordinal.
        //
        // Issue #172: when the function carries any `@return:` annotations,
        // emit a Parameter row with sequence number 0 (ECMA-335 II.22.33) in
        // front of the source-parameter rows so we can attach return-target
        // CustomAttribute rows to it.
        var firstParamHandle = this.NextParameterHandle();
        var hasReturnAttributes = !function.Attributes.IsDefaultOrEmpty
            && function.Attributes.Any(a => a.Target == AttributeTargetKind.Return);
        ParameterHandle? returnParamHandle = null;
        if (hasReturnAttributes)
        {
            returnParamHandle = this.metadata.AddParameter(
                attributes: ParameterAttributes.None,
                name: default(StringHandle),
                sequenceNumber: 0);
        }

        var paramHandles = new List<(ParameterSymbol Symbol, ParameterHandle Handle)>();
        var sequenceNumber = 1;
        foreach (var p in function.Parameters)
        {
            if (ReferenceEquals(p, function.ThisParameter))
            {
                continue;
            }

            var paramHandle = this.metadata.AddParameter(
                attributes: ParameterAttributes.None,
                name: this.metadata.GetOrAddString(p.Name ?? string.Empty),
                sequenceNumber: sequenceNumber++);
            paramHandles.Add((p, paramHandle));
        }

        var handle = this.metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString(methodName),
            signature: this.metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle);

        // Phase 4/5 (ADR-0027 §7.7a): hand the body's sequence points and
        // locals to the PDB emitter, keyed by the freshly minted MethodDef row
        // number. Skipped when PDB emit is off (pdb == null) or for the
        // async-kickoff path (the kickoff stub is fully synthesised — visible
        // PDB rows for the user's async body land via EmitStateMachineMoveNext
        // below).
        this.pdb?.RecordMethod(handle, capturedSequencePoints, capturedLocals, capturedConstants, capturedCodeSize, capturedLocalsSignature, function.Declaration?.SyntaxTree);

        // Phase 3 of #141: attach user annotations (method target) to the
        // MethodDef. Issue #170: per-parameter annotations attach to each
        // emitted Parameter row. Issue #172: return-target annotations attach
        // to the synthesised sequence-0 Parameter row.
        this.EmitUserAttributes(handle, function, AttributeTargetKind.Method);
        if (returnParamHandle is { } retHandle)
        {
            this.EmitUserAttributes(retHandle, function, AttributeTargetKind.Return);
        }

        foreach (var (paramSym, paramHandle) in paramHandles)
        {
            this.EmitUserAttributes(paramHandle, paramSym, AttributeTargetKind.Param);
        }

        return handle;
    }

    private static MethodAttributes ToMethodVisibility(Accessibility accessibility)
    {
        switch (accessibility)
        {
            case Accessibility.Public:
                return MethodAttributes.Public;
            case Accessibility.Internal:
                return MethodAttributes.Assembly;
            case Accessibility.Private:
                return MethodAttributes.Private;
            default:
                return MethodAttributes.Public;
        }
    }

    private void CollectLocalsAndLabels(
        BoundBlockStatement body,
        FunctionSymbol function,
        Dictionary<VariableSymbol, int> locals,
        List<TypeSymbol> localTypes,
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
        InstructionEncoder il)
    {
        this.CollectStatements(body.Statements, function, locals, localTypes, labels, appendSlots, il, pass: 1);
        CollectBlockExpressionLocals(body, locals, localTypes);
        this.CollectStatements(body.Statements, function, locals, localTypes, labels, appendSlots, il, pass: 2);

        // Phase B: pattern switch statements bring three classes of locals
        // into the host method:
        //   * one discriminant temp per switch (typed as the discriminant
        //     expression's type),
        //   * one object-typed scratch per type pattern (holds the isinst
        //     result before the brfalse to the next-arm label),
        //   * any locals declared by arm bodies and by the type-pattern
        //     arm-local bindings — these need pre-allocation because the
        //     pre-scan above does not descend into pattern-switch arms.
        CollectPatternSwitchSlots(
            body.Statements,
            locals,
            localTypes,
            patternSwitchSlots,
            typePatternScratchSlots,
            switchExpressionSlots,
            channelOpSlots,
            scopeFrameSlots,
            selectStatementSlots,
            goEnclosingScopes);

        // Phase 3.C.3b: each `?.` access introduces a synthetic capture
        // local in the bound tree; pre-allocate a slot for it.
        foreach (var nc in CollectNullConditionalCaptures(body))
        {
            if (!locals.ContainsKey(nc.Capture))
            {
                locals[nc.Capture] = localTypes.Count;
                localTypes.Add(nc.Capture.Type);
            }

            // P2-7 / Issue #421: value-type access results need a
            // Nullable<T> result slot so the nil branch can emit
            // `ldloca; initobj Nullable<T>; ldloc` and so the not-null
            // branch can wrap the raw T via `newobj Nullable<T>::.ctor(!0)`.
            if (nc.ResultSlot != null && !locals.ContainsKey(nc.ResultSlot))
            {
                locals[nc.ResultSlot] = localTypes.Count;
                localTypes.Add(nc.ResultSlot.Type);
            }
        }

        foreach (var append in CollectAppends(body))
        {
            var srcSlot = localTypes.Count;
            localTypes.Add(append.SliceType);
            var dstSlot = localTypes.Count;
            localTypes.Add(append.SliceType);
            appendSlots[append] = (srcSlot, dstSlot);
        }

        foreach (var literal in CollectStructLiterals(body))
        {
            // Class literals do not need a pre-allocated local slot — they
            // use newobj rather than initobj-into-a-slot.
            if (literal.StructType.IsClass)
            {
                continue;
            }

            var slot = localTypes.Count;
            localTypes.Add(literal.StructType);
            Debug.Assert(!structLiteralSlots.ContainsKey(literal), "Bound struct literal node aliased across emit positions; rekey structLiteralSlots by (node, parentContext) if lowering ever shares nodes.");
            structLiteralSlots[literal] = slot;
        }

        // Phase 3.A.4 emit: each map index READ lowers to a Dictionary.TryGetValue
        // pattern that needs a V-typed scratch local for the out parameter so that
        // missing keys yield the Go zero value (matching the interpreter).
        foreach (var idx in CollectMapIndexReads(body))
        {
            var slot = localTypes.Count;
            localTypes.Add(idx.Type);
            Debug.Assert(!mapIndexSlots.ContainsKey(idx), "Bound map index expression aliased across emit positions; rekey mapIndexSlots by (node, parentContext) if lowering ever shares nodes.");
            mapIndexSlots[idx] = slot;
        }

        // BoundDefaultExpression for non-primitive value types needs a temp local
        // for the ldloca/initobj/ldloc pattern (push-as-value path).
        foreach (var def in CollectDefaultExpressions(body))
        {
            if (!IsValueTypeSymbol(def.Type))
            {
                continue;
            }

            // Primitive value types (int, bool) are handled with ldc.i4.0 — no slot needed.
            if (def.Type == TypeSymbol.Int32 || def.Type == TypeSymbol.Bool)
            {
                continue;
            }

            var slot = localTypes.Count;
            localTypes.Add(def.Type);
            Debug.Assert(!defaultExpressionSlots.ContainsKey(def), "Bound default expression aliased across emit positions; rekey defaultExpressionSlots by (node, parentContext) if lowering ever shares nodes.");
            defaultExpressionSlots[def] = slot;
        }

        foreach (var receiver in this.CollectReceiverSpills(body, function, locals))
        {
            if (receiverSpillSlots.ContainsKey(receiver))
            {
                continue;
            }

            var slot = localTypes.Count;
            localTypes.Add(receiver.Type);
            receiverSpillSlots[receiver] = slot;
        }

        // Issue #418 (P1-1): each index-assignment expression needs a scratch
        // local typed as the value's type. The emit sites use dup + stloc tmp
        // + store + ldloc tmp so the index/argument expressions are evaluated
        // exactly once even though the assignment expression's result is the
        // assigned value.
        foreach (var ixa in CollectIndexAssignmentValueSpills(body))
        {
            if (indexAssignmentValueSlots.ContainsKey(ixa))
            {
                continue;
            }

            var slot = localTypes.Count;
            localTypes.Add(ixa.Type);
            indexAssignmentValueSlots[ixa] = slot;
        }

        // Issue #418 (P1-2): property and CLR-property assignments yield the
        // assigned value as their expression result. Previously the emitter
        // re-evaluated the receiver and called the getter to produce that
        // result, evaluating any side-effecting receiver expression twice
        // (e.g. `Make().P = v` invoked `Make()` for the setter, then again
        // for the getter). Pre-allocate a value-typed local for each such
        // assignment so the emitter can `dup; stloc tmp; call set_X; ldloc
        // tmp` instead. The slot is keyed by the assignment expression so it
        // does not collide with receiver-spill entries (which are keyed by
        // the receiver subexpression).
        foreach (var assn in CollectAssignmentValueSpills(body))
        {
            if (receiverSpillSlots.ContainsKey(assn))
            {
                continue;
            }

            var slot = localTypes.Count;
            localTypes.Add(assn.Type);
            receiverSpillSlots[assn] = slot;
        }
    }

    // Phase B: walks the bound body to find every BoundPatternSwitchStatement
    // (including those nested inside arm bodies, if/for branches, try/catch
    // blocks, and BoundBlockExpression statement lists). For each switch,
    // pre-allocates:
    //   * one local slot for the discriminant temp,
    //   * one object-typed scratch slot per TypePattern under any arm,
    //   * arm-local TypePattern.Variable slots, and
    //   * any locals declared inside arm body BoundBlockStatements.
    private void CollectPatternSwitchSlots(
        ImmutableArray<BoundStatement> statements,
        Dictionary<VariableSymbol, int> locals,
        List<TypeSymbol> localTypes,
        Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots,
        Dictionary<BoundTypePattern, int> typePatternScratchSlots,
        Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots,
        Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots,
        Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots,
        Dictionary<BoundSelectStatement, SelectSlots> selectStatementSlots,
        Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes)
    {
        foreach (var s in statements)
        {
            WalkForPatternSwitches(
                s,
                locals,
                localTypes,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                goEnclosingScopes,
                currentScope: null);
        }
    }

    private void WalkForPatternSwitches(
        BoundStatement statement,
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
        // Issue #418 (P1-3): the legacy bespoke switch missed many expression
        // kinds (tuple/map literals, ?., CLR calls/indexers/properties,
        // indirect calls, nested switch expressions, etc.). Use a default-
        // recurse walker so every BoundExpression kind is visited and any
        // nested pattern switch / switch expression / channel op / scope /
        // select gets its slot pre-allocated.
        var allocator = new PatternSwitchSlotAllocator(
            this,
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
        allocator.Visit(statement);
    }

    private void WalkExpressionForSwitches(
        BoundExpression expression,
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
        if (expression == null)
        {
            return;
        }

        // Issue #418 (P1-3): see WalkForPatternSwitches for the rationale —
        // delegate to the comprehensive walker.
        var allocator = new PatternSwitchSlotAllocator(
            this,
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
        allocator.Visit(expression);
    }

    private void WalkPatternForSwitchExpressions(
        BoundPattern pattern,
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
        if (pattern == null)
        {
            return;
        }

        // Issue #418 (P1-3): see WalkForPatternSwitches for the rationale.
        var allocator = new PatternSwitchSlotAllocator(
            this,
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
        allocator.Visit(pattern);
    }

    private sealed class PatternSwitchSlotAllocator : BoundTreeWalker
    {
        private readonly ReflectionMetadataEmitter outer;
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
            ReflectionMetadataEmitter outer,
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
            this.outer = outer;
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
                && !(node.Variable is GlobalVariableSymbol gv && this.outer.globalFieldDefs.ContainsKey(gv)))
            {
                this.locals[node.Variable] = this.localTypes.Count;
                this.localTypes.Add(node.Variable.Type);
            }

            base.VisitVariableDeclaration(node);
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

    private static void CollectBlockExpressionLocals(BoundBlockStatement body, Dictionary<VariableSymbol, int> locals, List<TypeSymbol> localTypes)
    {
        var collector = new BlockExpressionLocalCollector();
        collector.RewriteStatement(body);
        foreach (var variable in collector.Variables)
        {
            if (!locals.ContainsKey(variable))
            {
                locals[variable] = localTypes.Count;
                localTypes.Add(variable.Type);
            }
        }
    }

    private static IEnumerable<BoundStructLiteralExpression> CollectStructLiterals(BoundBlockStatement body)
    {
        var list = new List<BoundStructLiteralExpression>();
        foreach (var s in body.Statements)
        {
            WalkForStructLiterals(s, list);
        }

        return list;
    }

    // Phase 4 emit parity (E1): walk every user function body to collect all
    // BoundFunctionLiteralExpression nodes. Class instance method bodies are
    // included too. The collector uses BoundTreeRewriter so it reaches every
    // expression position; the base rewriter does not descend into the lambda's
    // body (separate lexical scope), so we recurse on Body explicitly to find
    // nested lambdas.
    private List<BoundFunctionLiteralExpression> CollectFunctionLiterals()
    {
        var sink = new List<BoundFunctionLiteralExpression>();
        var collector = new LambdaCollector(sink);
        foreach (var kvp in this.program.Functions)
        {
            collector.RewriteStatement(kvp.Value);
        }

        return sink;
    }

    private List<BoundGoStatement> CollectGoStatements()
    {
        var sink = new List<BoundGoStatement>();
        var collector = new GoStatementCollector(sink);
        foreach (var kvp in this.program.Functions)
        {
            collector.RewriteStatement(kvp.Value);
        }

        return sink;
    }

    // Phase 4 emit parity (F2, type-erased generic user types): discover
    // every constructed StructSymbol referenced in the bound program
    // (function bodies, class methods, and lambda bodies) and alias it to
    // its definition's TypeDef, ctor, primary-ctor, and per-field FieldDef
    // rows. Emission sites can then do plain dictionary lookups regardless
    // of whether the type is open, constructed, or already a non-generic
    // symbol.
    private void RegisterConstructedTypeAliases()
    {
        var collector = new ConstructedTypeCollector();
        foreach (var kvp in this.program.Functions)
        {
            collector.RewriteStatement(kvp.Value);
        }

        foreach (var body in this.lambdaBodies.Values)
        {
            collector.RewriteStatement(body);
        }

        foreach (var constructed in collector.Constructed)
        {
            var def = constructed.Definition;
            if (def == null || def == constructed)
            {
                continue;
            }

            if (this.structTypeDefs.TryGetValue(def, out var td))
            {
                this.structTypeDefs[constructed] = td;
            }

            if (this.classCtorHandles.TryGetValue(def, out var cc))
            {
                this.classCtorHandles[constructed] = cc;
            }

            if (this.classPrimaryCtorHandles.TryGetValue(def, out var pc))
            {
                this.classPrimaryCtorHandles[constructed] = pc;
            }

            foreach (var cf in constructed.Fields)
            {
                FieldSymbol df = null;
                foreach (var candidate in def.Fields)
                {
                    if (candidate.Name == cf.Name)
                    {
                        df = candidate;
                        break;
                    }
                }

                if (df != null && this.structFieldDefs.TryGetValue(df, out var fd))
                {
                    this.structFieldDefs[cf] = fd;
                }
            }
        }
    }

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
    private void SynthesizeClosures(List<BoundFunctionLiteralExpression> literals, PackageSymbol hostPackage)
    {
        foreach (var literal in literals)
        {
            if (literal.CapturedVariables.Length == 0)
            {
                continue;
            }

            var closureName = "<closure_" + literal.Function.Name + "_" + System.Threading.Interlocked.Increment(ref this.closureCounter).ToString(System.Globalization.CultureInfo.InvariantCulture) + ">";
            var info = this.SynthesizeDisplayClass(
                closureName,
                literal.CapturedVariables,
                literal.Function.Parameters,
                literal.Function.Type,
                literal.Body,
                hostPackage,
                invokeName: "Invoke");

            this.closureInfos[literal] = info;
        }
    }

    private void SynthesizeGoClosures(List<BoundGoStatement> goStatements, PackageSymbol hostPackage)
    {
        foreach (var go in goStatements)
        {
            var captured = CollectCapturedVariables(go.Expression);

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

            var closureName = "<go_" + System.Threading.Interlocked.Increment(ref this.closureCounter).ToString(System.Globalization.CultureInfo.InvariantCulture) + ">";
            var info = this.SynthesizeDisplayClass(
                closureName,
                captured,
                ImmutableArray<ParameterSymbol>.Empty,
                returnType,
                body,
                hostPackage,
                invokeName: "InvokeAction");

            this.goClosureInfos[go] = info;
        }
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
    private static bool IsTaskClrType(Type clrType)
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

    private void SynthesizeIteratorStateMachines(PackageSymbol hostPackage)
    {
        if (this.iteratorPlans.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var plan in this.iteratorPlans)
        {
            var packageName = hostPackage?.Name ?? plan.Function.Package?.Name ?? string.Empty;
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
                name: "<" + plan.Function.Name + ">d__" + System.Threading.Interlocked.Increment(ref this.closureCounter).ToString(System.Globalization.CultureInfo.InvariantCulture),
                fields: fields.ToImmutable(),
                accessibility: Accessibility.Internal,
                declaration: null,
                packageName: packageName,
                isData: false,
                isInline: false,
                isClass: true);

            var moveNext = new FunctionSymbol("MoveNext", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Bool, null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);
            var getCurrent = new FunctionSymbol("get_Current", ImmutableArray<ParameterSymbol>.Empty, plan.ElementType, null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);
            var getCurrentObject = new FunctionSymbol("get_Current", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.FromClrType(typeof(object)), null, hostPackage, Accessibility.Public, (TypeSymbol)smClass);
            var getEnumeratorType = TypeSymbol.FromClrType(typeof(System.Collections.Generic.IEnumerator<>).MakeGenericType(plan.ElementType.ClrType ?? typeof(object)));
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
            this.lambdaBodies[getEnumerator] = Lowerer.Lower(new BoundBlockStatement(null,
                ImmutableArray.Create<BoundStatement>(
                new BoundReturnStatement(null, this.CreateIteratorStateMachineLiteral(smClass, stateField, parameterFields, plan.Function.Parameters, p => new BoundFieldAccessExpression(null, new BoundVariableExpression(null, getEnumerator.ThisParameter), smClass, parameterFields[p]))))));
            this.lambdaBodies[getEnumeratorObject] = Lowerer.Lower(new BoundBlockStatement(null,
                ImmutableArray.Create<BoundStatement>(
                new BoundReturnStatement(null, this.CreateIteratorStateMachineLiteral(smClass, stateField, parameterFields, plan.Function.Parameters, p => new BoundFieldAccessExpression(null, new BoundVariableExpression(null, getEnumeratorObject.ThisParameter), smClass, parameterFields[p]))))));

            this.iteratorKickoffBodies[plan.Function] = Lowerer.Lower(new BoundBlockStatement(null,
                ImmutableArray.Create<BoundStatement>(
                new BoundReturnStatement(null, this.CreateIteratorStateMachineLiteral(smClass, stateField, parameterFields, plan.Function.Parameters, p => new BoundVariableExpression(null, p))))));
            this.iteratorStateMachineInfos[smClass] = new IteratorStateMachineInfo(plan, smClass);
            this.synthesizedClosureClasses.Add(smClass);
        }
    }

    private BoundStructLiteralExpression CreateIteratorStateMachineLiteral(
        StructSymbol smClass,
        FieldSymbol stateField,
        Dictionary<ParameterSymbol, FieldSymbol> parameterFields,
        ImmutableArray<ParameterSymbol> parameters,
        Func<ParameterSymbol, BoundExpression> parameterValueFactory)
    {
        var initializers = ImmutableArray.CreateBuilder<BoundFieldInitializer>();
        initializers.Add(new BoundFieldInitializer(stateField, new BoundLiteralExpression(null, 0)));
        foreach (var parameter in parameters)
        {
            initializers.Add(new BoundFieldInitializer(parameterFields[parameter], parameterValueFactory(parameter)));
        }

        return new BoundStructLiteralExpression(null, smClass, initializers.ToImmutable());
    }

    private void AddIteratorInterfaceImplementations(StructSymbol smClass, IteratorStateMachineInfo info)
    {
        var elementClr = info.Plan.ElementType.ClrType ?? typeof(object);
        this.metadata.AddInterfaceImplementation(this.structTypeDefs[smClass], this.GetTypeHandleForMember(typeof(System.Collections.Generic.IEnumerable<>).MakeGenericType(elementClr)));
        this.metadata.AddInterfaceImplementation(this.structTypeDefs[smClass], this.GetTypeHandleForMember(typeof(System.Collections.Generic.IEnumerator<>).MakeGenericType(elementClr)));
        this.metadata.AddInterfaceImplementation(this.structTypeDefs[smClass], this.GetTypeReference(typeof(System.IDisposable)));
        this.metadata.AddInterfaceImplementation(this.structTypeDefs[smClass], this.GetTypeReference(typeof(System.Collections.IEnumerable)));
        this.metadata.AddInterfaceImplementation(this.structTypeDefs[smClass], this.GetTypeReference(typeof(System.Collections.IEnumerator)));
    }

    private void SynthesizeAsyncIteratorStateMachines(PackageSymbol hostPackage)
    {
        if (this.asyncIteratorPlans.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var plan in this.asyncIteratorPlans)
        {
            var packageName = hostPackage?.Name ?? plan.Function.Package?.Name ?? string.Empty;
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
                name: "<" + plan.Function.Name + ">d__" + System.Threading.Interlocked.Increment(ref this.closureCounter).ToString(System.Globalization.CultureInfo.InvariantCulture),
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
            var moveNextBody = Lowering.Iterators.AsyncIteratorMoveNextBodyBuilder.Build(
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

            // Kickoff body: new SM { state = -3, params... }
            this.iteratorKickoffBodies[plan.Function] = Lowerer.Lower(new BoundBlockStatement(null,
                ImmutableArray.Create<BoundStatement>(
                new BoundReturnStatement(null, this.CreateAsyncIteratorKickoffLiteral(smClass, stateField, builderField, parameterFields, plan.Function.Parameters)))));

            this.asyncIteratorInfos[smClass] = plan;
            this.synthesizedClosureClasses.Add(smClass);

            // Resolve builder info for async iterator emit context.
            var returnClrType = plan.Function.Type?.ClrType;
            var aiBuilderInfo = Lowering.Async.AsyncMethodBuilderInfo.Resolve(returnClrType, this.references);
            this.asyncIteratorEmitContexts[smClass] = new AsyncIteratorEmitContext(smClass, builderField, aiBuilderInfo);
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
        ImmutableArray<ParameterSymbol> parameters)
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

        return new BoundStructLiteralExpression(null, smClass, initializers.ToImmutable());
    }

    private void AddAsyncIteratorInterfaceImplementations(StructSymbol smClass, Lowering.Iterators.AsyncIteratorPlan plan)
    {
        var elementClr = plan.ElementType.ClrType ?? typeof(object);
        var typeDef = this.structTypeDefs[smClass];

        // IAsyncEnumerator<T>
        this.metadata.AddInterfaceImplementation(typeDef,
            this.GetTypeHandleForMember(typeof(System.Collections.Generic.IAsyncEnumerator<>).MakeGenericType(elementClr)));

        // IAsyncDisposable
        this.metadata.AddInterfaceImplementation(typeDef,
            this.GetTypeHandleForMember(typeof(System.IAsyncDisposable)));

        if (plan.IsEnumerable)
        {
            // IAsyncEnumerable<T>
            this.metadata.AddInterfaceImplementation(typeDef,
                this.GetTypeHandleForMember(typeof(System.Collections.Generic.IAsyncEnumerable<>).MakeGenericType(elementClr)));
        }

        // IValueTaskSource<bool>
        this.metadata.AddInterfaceImplementation(typeDef,
            this.GetTypeHandleForMember(typeof(System.Threading.Tasks.Sources.IValueTaskSource<bool>)));

        // IAsyncStateMachine (required by AsyncIteratorMethodBuilder.MoveNext<TSM> constraint)
        this.metadata.AddInterfaceImplementation(typeDef,
            this.GetTypeHandleForMember(typeof(System.Runtime.CompilerServices.IAsyncStateMachine)));
    }

    /// <summary>
    /// For each async lambda, runs the async state-machine pipeline on its body
    /// and produces an <see cref="AsyncStateMachinePlan"/>. For no-capture lambdas
    /// the kickoff method is the lambda's own FunctionSymbol; for capture-bearing
    /// lambdas the kickoff is the closure class's Invoke method.
    /// </summary>
    private void SynthesizeAsyncLambdaStateMachines(List<BoundFunctionLiteralExpression> literals, PackageSymbol hostPackage)
    {
        var packageName = hostPackage?.Name ?? this.program.PackageName ?? string.Empty;
        var plans = this.asyncStateMachinePlans.ToBuilder();

        foreach (var literal in literals)
        {
            if (!literal.Function.IsAsync)
            {
                continue;
            }

            FunctionSymbol kickoffFunction;
            BoundBlockStatement body;

            if (this.closureInfos.TryGetValue(literal, out var closure))
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

            var plan = Lowering.Async.AsyncStateMachineRewriter.RewriteSingle(
                kickoffFunction, body, this.references, packageName);
            if (plan == null)
            {
                continue;
            }

            // Record nesting: capture-bearing async lambda SMs nest inside
            // their closure class (Subset A of the Roslyn nesting convention).
            if (this.closureInfos.TryGetValue(literal, out var closureForNesting))
            {
                var smStruct = plan.StateMachine.MaterializeAsStructSymbol();
                this.asyncSmEnclosingClosures[smStruct] = closureForNesting.ClassSym;
            }

            plans.Add(plan);
        }

        this.asyncStateMachinePlans = plans.ToImmutable();
    }

    private ClosureInfo SynthesizeDisplayClass(
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

        var rewriter = new CaptureRewriter(closureClass, captureFields, invokeMethod.ThisParameter);
        var rewrittenBody = (BoundBlockStatement)rewriter.RewriteStatement(body);
        if (rewriter.UnsupportedCapture != null)
        {
            throw new NotSupportedException(
                $"Synthesized closure '{closureName}' captures '{rewriter.UnsupportedCapture.Name}' from a kind ('{rewriter.UnsupportedCaptureKind}') the emitter cannot currently rewrite. Run under the interpreter for now.");
        }

        this.lambdaBodies[invokeMethod] = rewrittenBody;
        this.synthesizedClosureClasses.Add(closureClass);
        return new ClosureInfo(closureClass, invokeMethod, captureFields);
    }

    private static ImmutableArray<VariableSymbol> CollectCapturedVariables(BoundExpression expression)
    {
        var seen = new HashSet<VariableSymbol>();
        var captured = ImmutableArray.CreateBuilder<VariableSymbol>();
        var declared = new HashSet<VariableSymbol>();
        var collector = new GoCapturedVariableCollector(seen, declared, captured);
        collector.Collect(expression);
        return captured.ToImmutable();
    }

    private static void WalkForStructLiterals(BoundNode node, List<BoundStructLiteralExpression> sink)
    {
        new StructLiteralCollector(sink).Visit(node);
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

    private void CollectStatements(
        ImmutableArray<BoundStatement> statements,
        FunctionSymbol function,
        Dictionary<VariableSymbol, int> locals,
        List<TypeSymbol> localTypes,
        Dictionary<BoundLabel, LabelHandle> labels,
        Dictionary<BoundAppendExpression, (int Src, int Dst)> appendSlots,
        InstructionEncoder il,
        int pass)
    {
        foreach (var s in statements)
        {
            if (pass == 1)
            {
                switch (s)
                {
                    case BoundVariableDeclaration decl:
                        // Issue #191: a GlobalVariableSymbol with a registered
                        // FieldDef stores into <Program>'s static field via
                        // stsfld; do not also allocate a local slot for it.
                        if (decl.Variable is GlobalVariableSymbol gv && this.globalFieldDefs.ContainsKey(gv))
                        {
                            break;
                        }

                        // Issue #216: compile-time const bindings are inlined at
                        // every read site — no IL slot is needed.
                        if (decl.ConstantValue != null)
                        {
                            break;
                        }

                        if (!locals.ContainsKey(decl.Variable))
                        {
                            locals[decl.Variable] = localTypes.Count;
                            localTypes.Add(decl.Variable.Type);
                        }

                        break;
                    case BoundLabelStatement lbl:
                        if (!labels.ContainsKey(lbl.Label))
                        {
                            labels[lbl.Label] = il.DefineLabel();
                        }

                        break;
                    case BoundScopeStatement sc when sc.Body is BoundBlockStatement scBlock:
                        this.CollectStatements(scBlock.Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        break;
                    case BoundSelectStatement sel:
                        foreach (var arm in sel.Cases)
                        {
                            if (arm.Variable != null && !locals.ContainsKey(arm.Variable))
                            {
                                locals[arm.Variable] = localTypes.Count;
                                localTypes.Add(arm.Variable.Type);
                            }

                            if (arm.Body is BoundBlockStatement armBlock)
                            {
                                this.CollectStatements(armBlock.Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                            }
                        }

                        break;
                    case BoundTryStatement t:
                        this.CollectStatements(((BoundBlockStatement)t.TryBlock).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        foreach (var clause in t.CatchClauses)
                        {
                            // Issue #420 (P3-6): tolerate an elided catch variable
                            // in the local-slot pre-pass (the corresponding emit-
                            // time path in EmitCatchClauses emits a defensive
                            // `pop` to maintain stack balance).
                            if (clause.Variable != null && !locals.ContainsKey(clause.Variable))
                            {
                                locals[clause.Variable] = localTypes.Count;
                                localTypes.Add(clause.Variable.Type);
                            }

                            this.CollectStatements(((BoundBlockStatement)clause.Body).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        }

                        if (t.FinallyBlock != null)
                        {
                            this.CollectStatements(((BoundBlockStatement)t.FinallyBlock).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        }

                        break;
                    case BoundBlockStatement nestedBlock:
                        this.CollectStatements(nestedBlock.Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        break;
                }
            }
            else
            {
                switch (s)
                {
                    case BoundGotoStatement g:
                        if (!labels.ContainsKey(g.Label))
                        {
                            labels[g.Label] = il.DefineLabel();
                        }

                        break;
                    case BoundConditionalGotoStatement cg:
                        if (!labels.ContainsKey(cg.Label))
                        {
                            labels[cg.Label] = il.DefineLabel();
                        }

                        break;
                    case BoundScopeStatement sc when sc.Body is BoundBlockStatement scBlock:
                        this.CollectStatements(scBlock.Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        break;
                    case BoundSelectStatement sel:
                        foreach (var arm in sel.Cases)
                        {
                            if (arm.Body is BoundBlockStatement armBlock)
                            {
                                this.CollectStatements(armBlock.Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                            }
                        }

                        break;
                    case BoundTryStatement t:
                        this.CollectStatements(((BoundBlockStatement)t.TryBlock).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        foreach (var clause in t.CatchClauses)
                        {
                            this.CollectStatements(((BoundBlockStatement)clause.Body).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        }

                        if (t.FinallyBlock != null)
                        {
                            this.CollectStatements(((BoundBlockStatement)t.FinallyBlock).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        }

                        break;
                    case BoundBlockStatement nestedBlock:
                        this.CollectStatements(nestedBlock.Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        break;
                }
            }
        }
    }

    private static IEnumerable<BoundAppendExpression> CollectAppends(BoundNode node)
    {
        var list = new List<BoundAppendExpression>();
        WalkForAppends(node, list);
        return list;
    }

    private static IEnumerable<BoundIndexExpression> CollectMapIndexReads(BoundNode root)
    {
        var sink = new List<BoundIndexExpression>();
        new MapIndexReadCollector(sink).RewriteStatement((BoundStatement)root);
        return sink;
    }

    private static IEnumerable<BoundExpression> CollectIndexAssignmentValueSpills(BoundNode root)
    {
        var sink = new List<BoundExpression>();
        new IndexAssignmentValueSpillCollector(sink).RewriteStatement((BoundStatement)root);
        return sink;
    }

    private static IEnumerable<BoundDefaultExpression> CollectDefaultExpressions(BoundNode root)
    {
        var sink = new List<BoundDefaultExpression>();
        new DefaultExpressionCollector(sink).RewriteStatement((BoundStatement)root);
        return sink;
    }

    private IEnumerable<BoundExpression> CollectReceiverSpills(
        BoundNode root,
        FunctionSymbol function,
        IReadOnlyDictionary<VariableSymbol, int> locals)
    {
        var sink = new List<BoundExpression>();
        new ReceiverSpillCollector(this, function, locals, sink).RewriteStatement((BoundStatement)root);
        return sink;
    }

    // Issue #418 (P1-2): collect every property and CLR-property assignment
    // expression in the body. The slot allocator pairs each with a temp local
    // so the emitter can spill the assigned value (`dup; stloc tmp; setter;
    // ldloc tmp`) instead of re-evaluating the receiver and calling the
    // getter to recover the expression result.
    private static IEnumerable<BoundExpression> CollectAssignmentValueSpills(BoundNode root)
    {
        var sink = new List<BoundExpression>();
        new AssignmentValueSpillCollector(sink).RewriteStatement((BoundStatement)root);
        return sink;
    }

    private bool NeedsRvalueReceiverSpill(
        BoundExpression receiver,
        FunctionSymbol function,
        IReadOnlyDictionary<VariableSymbol, int> locals)
    {
        if (!IsValueTypeSymbol(receiver.Type))
        {
            return false;
        }

        if (receiver is BoundVariableExpression bve
            && this.CanLoadVariableAddressForReceiverSpill(bve.Variable, function, locals))
        {
            return false;
        }

        if (receiver is BoundFieldAccessExpression fa
            && this.structFieldDefs.ContainsKey(fa.Field)
            && this.IsAddressableFieldAccessForReceiverSpill(fa, function, locals))
        {
            return false;
        }

        return true;
    }

    private bool CanLoadVariableAddressForReceiverSpill(
        VariableSymbol variable,
        FunctionSymbol function,
        IReadOnlyDictionary<VariableSymbol, int> locals)
    {
        if (variable is ParameterSymbol ps
            && function != null
            && function.Parameters.Any(p => ReferenceEquals(p, ps)))
        {
            return true;
        }

        if (locals.ContainsKey(variable))
        {
            return true;
        }

        if (variable is GlobalVariableSymbol gv && this.globalFieldDefs.ContainsKey(gv))
        {
            return true;
        }

        return false;
    }

    private bool IsAddressableFieldAccessForReceiverSpill(
        BoundFieldAccessExpression fa,
        FunctionSymbol function,
        IReadOnlyDictionary<VariableSymbol, int> locals)
    {
        if (fa.Receiver == null)
        {
            return true;
        }

        if (fa.Receiver.Type is StructSymbol rs && rs.IsClass)
        {
            return true;
        }

        if (fa.Receiver.Type?.ClrType != null && !fa.Receiver.Type.ClrType.IsValueType)
        {
            return true;
        }

        if (fa.Receiver is BoundVariableExpression bv
            && this.CanLoadVariableAddressForReceiverSpill(bv.Variable, function, locals))
        {
            return true;
        }

        if (fa.Receiver is BoundFieldAccessExpression nested
            && this.structFieldDefs.ContainsKey(nested.Field))
        {
            return this.IsAddressableFieldAccessForReceiverSpill(nested, function, locals);
        }

        return false;
    }

    private static void WalkForAppends(BoundNode node, List<BoundAppendExpression> sink)
    {
        new AppendCollector(sink).Visit(node);
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

    private static IEnumerable<BoundNullConditionalAccessExpression> CollectNullConditionalCaptures(BoundNode node)
    {
        var list = new List<BoundNullConditionalAccessExpression>();
        WalkForNullConditional(node, list);
        return list;
    }

    private static void WalkForNullConditional(BoundNode node, List<BoundNullConditionalAccessExpression> sink)
    {
        new NullConditionalCollector(sink).Visit(node);
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

    private EntityHandle GetElementTypeToken(TypeSymbol element)
    {
        // P2-7 / Issue #421: nullable over a value type tokenises as
        // System.Nullable<T>. NullableTypeSymbol over a reference type
        // continues to share the underlying CLR type (handled below by
        // the `element.ClrType != null` branch via the NullableTypeSymbol
        // ctor that copies `underlying.ClrType`).
        if (element is NullableTypeSymbol nullableElement
            && nullableElement.UnderlyingType?.ClrType is { IsValueType: true } nullableInnerClr)
        {
            var nullableClr = typeof(System.Nullable<>).MakeGenericType(nullableInnerClr);
            return this.GetTypeHandleForMember(nullableClr);
        }

        if (element == TypeSymbol.Int32)
        {
            return this.GetTypeReference(this.coreInt32Type);
        }

        if (element == TypeSymbol.Bool)
        {
            return this.GetTypeReference(this.coreBooleanType);
        }

        if (element == TypeSymbol.String)
        {
            return this.GetTypeReference(this.coreStringType);
        }

        if (element is ArrayTypeSymbol nestedArr)
        {
            var sigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
            this.EncodeTypeSymbol(encoder, nestedArr);
            return this.metadata.AddTypeSpecification(this.metadata.GetOrAddBlob(sigBlob));
        }

        if (element is SliceTypeSymbol nestedSlice)
        {
            var sigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
            this.EncodeTypeSymbol(encoder, nestedSlice);
            return this.metadata.AddTypeSpecification(this.metadata.GetOrAddBlob(sigBlob));
        }

        if (element.ClrType != null)
        {
            if (element.ClrType.IsConstructedGenericType)
            {
                return this.GetTypeHandleForMember(element.ClrType);
            }

            return this.GetTypeReference(element.ClrType);
        }

        if (element is StructSymbol structSym && this.structTypeDefs.TryGetValue(structSym, out var td))
        {
            return td;
        }

        if (element is EnumSymbol enumSym && this.enumTypeDefs.TryGetValue(enumSym, out var etd))
        {
            return etd;
        }

        throw new NotSupportedException($"Cannot resolve element type token for '{element.Name}'.");
    }

    private Type ResolveCoreType(string fullName, Type fallback)
    {
        if (this.references.TryResolveType(fullName, out var t))
        {
            return t;
        }

        return fallback;
    }

    private MemberReferenceHandle GetNullReferenceExceptionCtorRef()
    {
        // System.NullReferenceException::.ctor() — used to back the `!!`
        // operator's runtime check when its operand is null.
        if (!this.nullRefExceptionCtorRef.IsNil)
        {
            return this.nullRefExceptionCtorRef;
        }

        var nreType = this.ResolveCoreType("System.NullReferenceException", typeof(NullReferenceException));
        var nreTypeRef = this.GetTypeReference(nreType);
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });
        this.nullRefExceptionCtorRef = this.metadata.AddMemberReference(
            parent: nreTypeRef,
            name: this.metadata.GetOrAddString(".ctor"),
            signature: this.metadata.GetOrAddBlob(sigBlob));
        return this.nullRefExceptionCtorRef;
    }

    private MemberReferenceHandle GetStringLengthReference()
    {
        // System.String::get_Length() — used to implement len(string).
        var method = this.coreStringType.GetMethod("get_Length", Type.EmptyTypes)
            ?? throw new InvalidOperationException("String.get_Length is not resolvable from the supplied references.");
        return this.GetMethodReference(method);
    }

    private MemberReferenceHandle GetTypeFromHandleReference()
    {
        // System.Type::GetTypeFromHandle(RuntimeTypeHandle) — backs `typeof(T)`.
        var method = this.coreSystemType.GetMethod(
            "GetTypeFromHandle",
            new[] { this.coreRuntimeTypeHandleType })
            ?? throw new InvalidOperationException("Type.GetTypeFromHandle(RuntimeTypeHandle) is not resolvable from the supplied references.");
        return this.GetMethodReference(method);
    }

    private EntityHandle GetTypeOfToken(TypeSymbol type)
    {
        // Issue #143: `typeof(T)` token resolution. `NullableTypeSymbol` over a
        // value type must surface as `System.Nullable<T>` to match C# semantics
        // (binder/evaluator collapse the wrapper to its underlying type for
        // every other purpose — ADR-0001).
        if (type is NullableTypeSymbol nullable
            && nullable.UnderlyingType.ClrType is { IsValueType: true } valueClr)
        {
            var nullableType = typeof(System.Nullable<>).MakeGenericType(valueClr);
            return this.GetTypeHandleForMember(nullableType);
        }

        return this.GetElementTypeToken(type);
    }

    private MemberReferenceHandle GetArrayCopyReference()
    {
        // System.Array::Copy(Array, Array, Int32) — used to implement append(slice, element).
        var method = this.coreArrayType.GetMethod(
            "Copy",
            new[] { this.coreArrayType, this.coreArrayType, this.coreInt32Type })
            ?? throw new InvalidOperationException("Array.Copy(Array, Array, int) is not resolvable from the supplied references.");
        return this.GetMethodReference(method);
    }

    private AssemblyReferenceHandle GetAssemblyReference(Assembly assembly)
    {
        if (this.assemblyRefs.TryGetValue(assembly, out var existing))
        {
            return existing;
        }

        var name = assembly.GetName();
        var publicKeyToken = name.GetPublicKeyToken();
        var publicKeyOrTokenBlob = publicKeyToken is { Length: > 0 }
            ? this.metadata.GetOrAddBlob(publicKeyToken)
            : default(BlobHandle);
        var handle = this.metadata.AddAssemblyReference(
            name: this.metadata.GetOrAddString(name.Name ?? string.Empty),
            version: name.Version ?? new Version(0, 0, 0, 0),
            culture: default(StringHandle),
            publicKeyOrToken: publicKeyOrTokenBlob,
            flags: default(AssemblyFlags),
            hashValue: default(BlobHandle));
        this.assemblyRefs[assembly] = handle;
        return handle;
    }

    /// <summary>
    /// Issue #242: Returns an AssemblyReferenceHandle for <c>System.Runtime</c>,
    /// the public facade assembly that external consumers (C#/F# projects)
    /// reference. Used as the resolution scope for base-type TypeRefs
    /// (System.Object, System.ValueType, System.Enum) so that compiled
    /// libraries are consumable without requiring a direct reference to
    /// <c>System.Private.CoreLib</c>.
    /// </summary>
    private AssemblyReferenceHandle GetSystemRuntimeAssemblyReference()
    {
        if (!this.systemRuntimeAssemblyRef.IsNil)
        {
            return this.systemRuntimeAssemblyRef;
        }

        AssemblyName sysRuntimeName;
        try
        {
            sysRuntimeName = Assembly.Load("System.Runtime").GetName();
        }
        catch
        {
            // Fallback: construct the identity using the well-known .NET
            // public key token (b03f5f7f11d50a3a) and the host CoreLib version.
            sysRuntimeName = new AssemblyName("System.Runtime")
            {
                Version = typeof(object).Assembly.GetName().Version ?? new Version(0, 0, 0, 0),
            };
            sysRuntimeName.SetPublicKeyToken(new byte[] { 0xb0, 0x3f, 0x5f, 0x7f, 0x11, 0xd5, 0x0a, 0x3a });
        }

        var publicKeyToken = sysRuntimeName.GetPublicKeyToken();
        var publicKeyOrTokenBlob = publicKeyToken is { Length: > 0 }
            ? this.metadata.GetOrAddBlob(publicKeyToken)
            : default(BlobHandle);
        this.systemRuntimeAssemblyRef = this.metadata.AddAssemblyReference(
            name: this.metadata.GetOrAddString(sysRuntimeName.Name ?? "System.Runtime"),
            version: sysRuntimeName.Version ?? new Version(0, 0, 0, 0),
            culture: default(StringHandle),
            publicKeyOrToken: publicKeyOrTokenBlob,
            flags: default(AssemblyFlags),
            hashValue: default(BlobHandle));
        return this.systemRuntimeAssemblyRef;
    }

    /// <summary>
    /// Returns <c>true</c> if <paramref name="type"/> is a core base type from
    /// <c>System.Private.CoreLib</c> that is publicly exposed through
    /// <c>System.Runtime</c>. These types are used as base types in TypeDef
    /// rows and must reference the public facade so external consumers can
    /// resolve them.
    /// </summary>
    private static bool IsCoreLibBaseType(Type type)
    {
        if (!string.Equals(type.Assembly.GetName().Name, "System.Private.CoreLib", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var fullName = type.FullName;
        return fullName == "System.Object"
            || fullName == "System.ValueType"
            || fullName == "System.Enum"
            || fullName == "System.Attribute"
            || fullName == "System.MulticastDelegate"
            || fullName == "System.Delegate";
    }

    private TypeReferenceHandle GetTypeReference(Type type)
    {
        if (this.typeRefs.TryGetValue(type, out var existing))
        {
            return existing;
        }

        // Nested types: resolution scope is the TypeRef of the declaring type,
        // namespace is empty, name is the short name only. Works for the
        // open generic definition of a nested generic type as well (Reflection
        // treats Dictionary`2+Enumerator as nested under Dictionary`2).
        EntityHandle resolutionScope;
        StringHandle @namespace;
        if (type.IsNested && type.DeclaringType is Type declaring)
        {
            resolutionScope = this.GetTypeReference(declaring);
            @namespace = default;
        }
        else if (IsCoreLibBaseType(type))
        {
            // Issue #242: base types (Object, ValueType, Enum, Attribute)
            // must reference System.Runtime — the public facade — so that
            // consuming C#/F# projects can resolve them. Other types in
            // System.Private.CoreLib (e.g. Dictionary<,>) keep pointing at
            // CoreLib because the runtime resolves them directly and they
            // may not have type-forwarders in System.Runtime.
            resolutionScope = this.GetSystemRuntimeAssemblyReference();
            @namespace = this.metadata.GetOrAddString(type.Namespace ?? string.Empty);
        }
        else
        {
            resolutionScope = this.GetAssemblyReference(type.Assembly);
            @namespace = this.metadata.GetOrAddString(type.Namespace ?? string.Empty);
        }

        var handle = this.metadata.AddTypeReference(
            resolutionScope: resolutionScope,
            @namespace: @namespace,
            name: this.metadata.GetOrAddString(type.Name));
        this.typeRefs[type] = handle;
        return handle;
    }

    /// <summary>
    /// Returns a metadata handle suitable for use as the parent of a MemberRef.
    /// Returns a TypeRef for non-generic types and a TypeSpec encoding a
    /// <c>GenericInstantiation</c> for constructed generic types
    /// (e.g. <c>List&lt;int&gt;</c>, <c>Dictionary&lt;string, int&gt;</c>).
    /// </summary>
    private EntityHandle GetTypeHandleForMember(Type type)
    {
        if (type.IsConstructedGenericType)
        {
            if (this.typeSpecs.TryGetValue(type, out var existingSpec))
            {
                return existingSpec;
            }

            var sigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
            this.EncodeClrType(encoder, type);
            var spec = this.metadata.AddTypeSpecification(this.metadata.GetOrAddBlob(sigBlob));
            this.typeSpecs[type] = spec;
            return spec;
        }

        return this.GetTypeReference(type);
    }

    /// <summary>
    /// For a method on a constructed generic type, return the corresponding
    /// method on the open generic definition; for non-generic declaring types,
    /// returns the input. The open method's parameter / return types reference
    /// the declaring type's generic parameters as <c>GenericTypeParameter</c>,
    /// which <see cref="EncodeClrType"/> emits as <c>!N</c>.
    /// </summary>
    private static MethodInfo GetOpenMethod(MethodInfo method)
    {
        var declaring = method.DeclaringType;
        if (declaring is null || !declaring.IsConstructedGenericType)
        {
            return method;
        }

        var open = declaring.GetGenericTypeDefinition();
        foreach (var candidate in open.GetMethods(
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (candidate.MetadataToken == method.MetadataToken && candidate.Module == method.Module)
            {
                return candidate;
            }
        }

        return method;
    }

    private static ConstructorInfo GetOpenCtor(ConstructorInfo ctor)
    {
        var declaring = ctor.DeclaringType;
        if (declaring is null || !declaring.IsConstructedGenericType)
        {
            return ctor;
        }

        var open = declaring.GetGenericTypeDefinition();
        foreach (var candidate in open.GetConstructors(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (candidate.MetadataToken == ctor.MetadataToken && candidate.Module == ctor.Module)
            {
                return candidate;
            }
        }

        return ctor;
    }

    private MemberReferenceHandle GetMethodReference(MethodInfo method)
    {
        if (this.methodRefs.TryGetValue(method, out var existing))
        {
            return existing;
        }

        var declaring = method.DeclaringType
            ?? throw new InvalidOperationException("Imported method has no declaring type.");
        var parent = this.GetTypeHandleForMember(declaring);

        // For instance methods on constructed generic types, encode the signature
        // from the OPEN definition so parameters/returns reference declaring-type
        // generic params by position (!0, !1, ...). For non-generic declarings,
        // open == closed and parameter types are concrete.
        var openMethod = GetOpenMethod(method);

        // When the method itself is generic (e.g. Channel.CreateUnbounded<T>),
        // encode the MemberRef against its generic definition so `!!N` placeholders
        // referenced in the signature resolve correctly. The caller wraps the
        // resulting handle in a MethodSpecification.
        var openForMethodGenerics = openMethod.IsGenericMethod
            ? openMethod.GetGenericMethodDefinition()
            : openMethod;

        var sigBlob = new BlobBuilder();
        var sigEncoder = new BlobEncoder(sigBlob).MethodSignature(
            isInstanceMethod: !method.IsStatic,
            genericParameterCount: openForMethodGenerics.IsGenericMethodDefinition ? openForMethodGenerics.GetGenericArguments().Length : 0);
        sigEncoder.Parameters(
                openForMethodGenerics.GetParameters().Length,
                returnType: r => this.EncodeReturnClr(r, openForMethodGenerics.ReturnParameter, openForMethodGenerics.ReturnType),
                parameters: ps =>
                {
                    foreach (var p in openForMethodGenerics.GetParameters())
                    {
                        var paramType = p.ParameterType;
                        if (paramType.IsByRef)
                        {
                            // out / ref parameters: encode as managed pointer to the element type.
                            this.EncodeClrType(ps.AddParameter().Type(isByRef: true), paramType.GetElementType()!);
                        }
                        else
                        {
                            this.EncodeClrType(ps.AddParameter().Type(), paramType);
                        }
                    }
                });

        var handle = this.metadata.AddMemberReference(
            parent: parent,
            name: this.metadata.GetOrAddString(method.Name),
            signature: this.metadata.GetOrAddBlob(sigBlob));
        this.methodRefs[method] = handle;
        return handle;
    }

    // Phase E: returns a callable EntityHandle for any MethodInfo, wrapping
    // constructed generic methods in a MethodSpecification per ECMA-335 II.23.2.15.
    private EntityHandle GetMethodEntityHandle(MethodInfo method)
    {
        return this.GetMethodEntityHandle(method, default);
    }

    // Issue #320: callable EntityHandle for a constructed generic method whose
    // explicit type arguments may include user-defined types. User-defined type
    // arguments have no reference-context CLR type, so the method was closed with
    // a System.Object placeholder; the real type-argument symbols are encoded into
    // the method specification here (as their own TypeDef tokens) instead of the
    // placeholder. When typeArgSymbols is default the placeholder CLR arguments are
    // encoded, preserving the BCL-only behavior.
    private EntityHandle GetMethodEntityHandle(MethodInfo method, ImmutableArray<TypeSymbol> typeArgSymbols)
    {
        if (!method.IsGenericMethod || method.IsGenericMethodDefinition)
        {
            return this.GetMethodReference(method);
        }

        // The placeholder-closed MethodInfo is identical across distinct
        // user-type arguments (all close to <object>), so the cache must be keyed
        // by the symbol arguments too. Issue #420 (P3-7): previously this case
        // bypassed the cache entirely, producing duplicate MethodSpec rows when
        // the same generic method was referenced multiple times with the same
        // user-type generic args.
        var hasSymbolArgs = !typeArgSymbols.IsDefaultOrEmpty
            && typeArgSymbols.Any(s => s is StructSymbol or InterfaceSymbol or EnumSymbol);
        if (!hasSymbolArgs)
        {
            if (this.methodSpecs.TryGetValue(method, out var existing))
            {
                return existing;
            }
        }
        else
        {
            var symbolKey = new MethodSpecSymbolKey(method, typeArgSymbols);
            if (this.methodSpecsWithSymbolArgs.TryGetValue(symbolKey, out var existingSym))
            {
                return existingSym;
            }
        }

        var openDef = method.GetGenericMethodDefinition();
        var openRef = this.GetMethodReference(openDef);

        var closedArgs = method.GetGenericArguments();
        var sigBlob = new BlobBuilder();
        var argsEncoder = new BlobEncoder(sigBlob).MethodSpecificationSignature(closedArgs.Length);
        for (var i = 0; i < closedArgs.Length; i++)
        {
            // Issue #320: encode a user-defined type argument via its symbol so it
            // resolves to the emitted TypeDef; BCL arguments use the closed CLR type.
            if (!typeArgSymbols.IsDefaultOrEmpty
                && i < typeArgSymbols.Length
                && typeArgSymbols[i] is StructSymbol or InterfaceSymbol or EnumSymbol)
            {
                this.EncodeTypeSymbol(argsEncoder.AddArgument(), typeArgSymbols[i]);
            }
            else
            {
                this.EncodeClrType(argsEncoder.AddArgument(), closedArgs[i]);
            }
        }

        var spec = this.metadata.AddMethodSpecification(openRef, this.metadata.GetOrAddBlob(sigBlob));
        if (!hasSymbolArgs)
        {
            this.methodSpecs[method] = spec;
        }
        else
        {
            this.methodSpecsWithSymbolArgs[new MethodSpecSymbolKey(method, typeArgSymbols)] = spec;
        }

        return spec;
    }

    /// <summary>
    /// Phase 4 emit parity: get a MemberRef for a CLR instance constructor.
    /// Handles both non-generic types (<c>StringBuilder()</c>) and constructed
    /// generic types (<c>List&lt;int&gt;()</c>, <c>Dictionary&lt;string, int&gt;()</c>).
    /// </summary>
    private MemberReferenceHandle GetCtorReference(ConstructorInfo ctor)
    {
        if (this.ctorRefs.TryGetValue(ctor, out var existing))
        {
            return existing;
        }

        var declaring = ctor.DeclaringType
            ?? throw new InvalidOperationException("Imported constructor has no declaring type.");
        var parent = this.GetTypeHandleForMember(declaring);
        var openCtor = GetOpenCtor(ctor);

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                openCtor.GetParameters().Length,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    foreach (var p in openCtor.GetParameters())
                    {
                        var paramType = p.ParameterType;
                        if (paramType.IsByRef)
                        {
                            // out/ref parameter (e.g. an interpolated-string
                            // handler ctor's `out bool shouldAppend`): emit the
                            // BYREF prefix, then encode the element type.
                            this.EncodeClrType(ps.AddParameter().Type(isByRef: true), paramType.GetElementType()!);
                        }
                        else
                        {
                            this.EncodeClrType(ps.AddParameter().Type(), paramType);
                        }
                    }
                });

        var handle = this.metadata.AddMemberReference(
            parent: parent,
            name: this.metadata.GetOrAddString(".ctor"),
            signature: this.metadata.GetOrAddBlob(sigBlob));
        this.ctorRefs[ctor] = handle;
        return handle;
    }

    /// <summary>
    /// Phase 4 emit parity: get a MemberRef for a CLR field on a possibly
    /// generic declaring type (e.g. <c>KeyValuePair&lt;K, V&gt;.Key</c>).
    /// </summary>
    private MemberReferenceHandle GetFieldReference(FieldInfo field)
    {
        if (this.fieldRefs.TryGetValue(field, out var existing))
        {
            return existing;
        }

        var declaring = field.DeclaringType
            ?? throw new InvalidOperationException("Imported field has no declaring type.");
        var parent = this.GetTypeHandleForMember(declaring);

        // Use the open field's FieldType so it encodes as !N when applicable.
        var openField = declaring.IsConstructedGenericType
            ? declaring.GetGenericTypeDefinition().GetField(
                field.Name,
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                ?? field
            : field;

        var sigBlob = new BlobBuilder();
        this.EncodeClrType(new BlobEncoder(sigBlob).FieldSignature(), openField.FieldType);

        var handle = this.metadata.AddMemberReference(
            parent: parent,
            name: this.metadata.GetOrAddString(field.Name),
            signature: this.metadata.GetOrAddBlob(sigBlob));
        this.fieldRefs[field] = handle;
        return handle;
    }

    private MemberReferenceHandle GetObjectDefaultCtorReference()
    {
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });
        return this.metadata.AddMemberReference(
            parent: this.objectTypeRef,
            name: this.metadata.GetOrAddString(".ctor"),
            signature: this.metadata.GetOrAddBlob(sigBlob));
    }

    private MemberReferenceHandle GetStringConcatReference()
    {
        if (!this.stringConcatRef.IsNil)
        {
            return this.stringConcatRef;
        }

        var stringTypeRef = this.GetTypeReference(this.coreStringType);
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(
                2,
                r => r.Type().String(),
                ps =>
                {
                    ps.AddParameter().Type().String();
                    ps.AddParameter().Type().String();
                });
        this.stringConcatRef = this.metadata.AddMemberReference(
            parent: stringTypeRef,
            name: this.metadata.GetOrAddString("Concat"),
            signature: this.metadata.GetOrAddBlob(sigBlob));
        return this.stringConcatRef;
    }

    private MemberReferenceHandle GetStringEqualsReference()
    {
        if (!this.stringEqualsRef.IsNil)
        {
            return this.stringEqualsRef;
        }

        var stringTypeRef = this.GetTypeReference(this.coreStringType);
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(
                2,
                r => r.Type().Boolean(),
                ps =>
                {
                    ps.AddParameter().Type().String();
                    ps.AddParameter().Type().String();
                });
        this.stringEqualsRef = this.metadata.AddMemberReference(
            parent: stringTypeRef,
            name: this.metadata.GetOrAddString("Equals"),
            signature: this.metadata.GetOrAddBlob(sigBlob));
        return this.stringEqualsRef;
    }

    private MemberReferenceHandle GetObjectInstanceToStringReference()
    {
        if (!this.objectInstanceToStringRef.IsNil)
        {
            return this.objectInstanceToStringRef;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Type().String(), _ => { });
        this.objectInstanceToStringRef = this.metadata.AddMemberReference(
            parent: this.objectTypeRef,
            name: this.metadata.GetOrAddString("ToString"),
            signature: this.metadata.GetOrAddBlob(sigBlob));
        return this.objectInstanceToStringRef;
    }

    private MemberReferenceHandle GetObjectInstanceGetHashCodeReference()
    {
        if (!this.objectInstanceGetHashCodeRef.IsNil)
        {
            return this.objectInstanceGetHashCodeRef;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Type().Int32(), _ => { });
        this.objectInstanceGetHashCodeRef = this.metadata.AddMemberReference(
            parent: this.objectTypeRef,
            name: this.metadata.GetOrAddString("GetHashCode"),
            signature: this.metadata.GetOrAddBlob(sigBlob));
        return this.objectInstanceGetHashCodeRef;
    }

    /// <summary>
    /// Returns a MemberRef for static <c>bool System.Object.Equals(object, object)</c>.
    /// Used by Phase 3.B.2 data-struct <c>==</c> / <c>!=</c> lowering: we box
    /// the operand values and call this static helper, which routes through
    /// the virtual <c>ValueType.Equals(object)</c> override (reflection-based
    /// field-by-field comparison) for user value types. Same observable
    /// semantics as the interpreter's structural equality (ADR-0029); a
    /// future iteration may replace this with a direct synthesized
    /// <c>Equals(T)</c> method for performance.
    /// </summary>
    private MemberReferenceHandle GetObjectStaticEqualsReference()
    {
        if (!this.objectStaticEqualsRef.IsNil)
        {
            return this.objectStaticEqualsRef;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(
                2,
                r => r.Type().Boolean(),
                ps =>
                {
                    ps.AddParameter().Type().Object();
                    ps.AddParameter().Type().Object();
                });
        this.objectStaticEqualsRef = this.metadata.AddMemberReference(
            parent: this.objectTypeRef,
            name: this.metadata.GetOrAddString("Equals"),
            signature: this.metadata.GetOrAddBlob(sigBlob));
        return this.objectStaticEqualsRef;
    }

    private void EncodeTypeSymbol(SignatureTypeEncoder encoder, TypeSymbol type)
    {
        // Phase 3 exit: `T?` for reference types is metadata-only (same CLR
        // signature as `T`). For value types it lowers to `Nullable<T>`.
        if (type is NullableTypeSymbol nullable)
        {
            var inner = nullable.UnderlyingType;

            // P2-7 / Issue #421: nullable over a value type encodes as
            // System.Nullable<T> (generic instantiation). We support inner
            // types backed by a CLR value type (primitives, BCL value types).
            if (inner?.ClrType is { IsValueType: true } innerClrVt)
            {
                var nullableClr = typeof(System.Nullable<>).MakeGenericType(innerClrVt);
                this.EncodeClrType(encoder, nullableClr);
                return;
            }

            if (inner is StructSymbol nestedStruct && !nestedStruct.IsClass)
            {
                throw new NotSupportedException(
                    $"Nullable user-defined struct '{inner.Name}?' is not yet supported by the emitter.");
            }

            if (inner is EnumSymbol nestedEnum)
            {
                throw new NotSupportedException(
                    $"Nullable user-defined enum '{nestedEnum.Name}?' is not yet supported by the emitter.");
            }

            EncodeTypeSymbol(encoder, inner);
            return;
        }

        if (type == TypeSymbol.Bool)
        {
            encoder.Boolean();
        }
        else if (type == TypeSymbol.Int32)
        {
            encoder.Int32();
        }
        else if (type == TypeSymbol.String)
        {
            encoder.String();
        }
        else if (type == TypeSymbol.Void)
        {
            throw new InvalidOperationException("Use ReturnTypeEncoder.Void() for void returns.");
        }
        else if (type is TypeParameterSymbol)
        {
            // Phase 4 emit parity (F1, type-erased): generic function emit
            // currently follows the interpreter's type-erased model — each
            // open type parameter is encoded as System.Object. Call sites
            // insert box / unbox.any around the boundary so value-type
            // arguments and value-typed returns round-trip correctly.
            // ADR-0004 mandates CLR reified generics as the long-term goal;
            // a follow-up will add GenericParam rows and MVAR/VAR encoding.
            encoder.Object();
        }
        else if (type is ImportedTypeSymbol erasedGeneric && erasedGeneric.HasTypeParameterArgument)
        {
            // #313: a generic type constructed over an in-scope type parameter
            // (e.g. `List[T]`) is type-erased to System.Object at emit, exactly
            // like a bare type parameter. The actual runtime object is a closed
            // generic (e.g. `List<int32>`); call sites insert castclass around
            // the boundary when the substituted type is recovered.
            encoder.Object();
        }
        else if (type is ArrayTypeSymbol arr)
        {
            EncodeTypeSymbol(encoder.SZArray(), arr.ElementType);
        }
        else if (type is SliceTypeSymbol slice)
        {
            EncodeTypeSymbol(encoder.SZArray(), slice.ElementType);
        }
        else if (type is StructSymbol structSym)
        {
            if (!this.structTypeDefs.TryGetValue(structSym, out var typeDef))
            {
                throw new InvalidOperationException($"Struct '{structSym.Name}' has no emitted TypeDef.");
            }

            encoder.Type(typeDef, isValueType: !structSym.IsClass);
        }
        else if (type is EnumSymbol enumSym)
        {
            // Issue #193: a user-defined enum's signature surface is its
            // own TypeDef (a sealed value type derived from System.Enum).
            if (!this.enumTypeDefs.TryGetValue(enumSym, out var enumTypeDef))
            {
                throw new InvalidOperationException($"Enum '{enumSym.Name}' has no emitted TypeDef.");
            }

            encoder.Type(enumTypeDef, isValueType: true);
        }
        else if (type is InterfaceSymbol ifaceSym)
        {
            // Phase D: user-defined interface as a signature type. The
            // CLR encodes interfaces with the same CLASS bit as a reference
            // type (isValueType: false).
            if (!this.interfaceTypeDefs.TryGetValue(ifaceSym, out var ifaceDef))
            {
                throw new InvalidOperationException($"Interface '{ifaceSym.Name}' has no emitted TypeDef.");
            }

            encoder.Type(ifaceDef, isValueType: false);
        }
        else if (type is ChannelTypeSymbol chType)
        {
            // Phase E: chan T -> System.Threading.Channels.Channel<T>.
            // For element types that lack a ClrType we erase to object,
            // matching the interpreter's `ElementType.ClrType ?? typeof(object)`
            // fallback (ADR-0022 §interpreter).
            var elementClr = chType.ElementType.ClrType ?? typeof(object);
            var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
            this.EncodeClrType(encoder, channelClr);
        }
        else if (type?.ClrType != null)
        {
            this.EncodeClrType(encoder, type.ClrType);
        }
        else if (type is FunctionTypeSymbol openFn)
        {
            // Phase 4 emit parity (F1, type-erased): a delegate type whose
            // parameter or return types reference open type parameters (e.g.
            // func(T) U) has no precomputed ClrType. Erase the type-parameter
            // arguments to System.Object and encode the constructed
            // System.Func / System.Action shape so signatures resolve.
            this.EncodeClrType(encoder, this.ResolveDelegateClrType(openFn));
        }
        else
        {
            throw new NotSupportedException($"Cannot encode signature for type '{type?.Name}' yet.");
        }
    }

    private void EncodeReturnSymbol(ReturnTypeEncoder encoder, TypeSymbol type)
    {
        if (type == TypeSymbol.Void)
        {
            encoder.Void();
        }
        else
        {
            this.EncodeTypeSymbol(encoder.Type(), type);
        }
    }

    // Phase 4 emit parity (F1): used by call sites to decide whether a value
    // crossing the open-generic boundary needs box / unbox.any. Mirrors the
    // CLR's value-type predicate over GSharp type symbols.
    private static bool IsValueTypeSymbol(TypeSymbol type)
    {
        if (type == TypeSymbol.Int32 || type == TypeSymbol.Bool)
        {
            return true;
        }

        if (type is StructSymbol s && !s.IsClass)
        {
            return true;
        }

        // Issue #193: a user-defined enum is a CLR value type (sealed,
        // derives from System.Enum). Boundary boxing logic (e.g. generic
        // argument passing) must treat it as such even though it has no
        // ClrType on the symbol.
        if (type is EnumSymbol)
        {
            return true;
        }

        if (type?.ClrType != null && type.ClrType.IsValueType)
        {
            return true;
        }

        return false;
    }

    private void EncodeClrType(SignatureTypeEncoder encoder, Type type)
    {
        // Compare by FullName so types from a MetadataLoadContext (carrying the target
        // framework's identity) still encode to the same well-known primitive opcodes.
        var fullName = type?.FullName;
        switch (fullName)
        {
            case "System.Boolean":
                encoder.Boolean();
                break;
            case "System.Byte":
                encoder.Byte();
                break;
            case "System.SByte":
                encoder.SByte();
                break;
            case "System.Int16":
                encoder.Int16();
                break;
            case "System.UInt16":
                encoder.UInt16();
                break;
            case "System.Int32":
                encoder.Int32();
                break;
            case "System.UInt32":
                encoder.UInt32();
                break;
            case "System.Int64":
                encoder.Int64();
                break;
            case "System.UInt64":
                encoder.UInt64();
                break;
            case "System.Single":
                encoder.Single();
                break;
            case "System.Double":
                encoder.Double();
                break;
            case "System.Char":
                encoder.Char();
                break;
            case "System.String":
                encoder.String();
                break;
            case "System.Object":
                encoder.Object();
                break;
            case "System.IntPtr":
                encoder.IntPtr();
                break;
            case "System.UIntPtr":
                encoder.UIntPtr();
                break;
            default:
                if (type == null)
                {
                    throw new NotSupportedException("Cannot encode signature for a null CLR type.");
                }

                if (type.IsGenericParameter)
                {
                    // Method signatures reference declaring-type generic params as `!N`
                    // and declaring-method generic params as `!!N` (Phase E adds method
                    // generic support for calls like `Channel.CreateUnbounded<T>()`).
                    if (type.DeclaringMethod != null)
                    {
                        encoder.GenericMethodTypeParameter(type.GenericParameterPosition);
                    }
                    else
                    {
                        encoder.GenericTypeParameter(type.GenericParameterPosition);
                    }

                    break;
                }

                if (type.IsArray && type.GetArrayRank() == 1)
                {
                    EncodeClrType(encoder.SZArray(), type.GetElementType()!);
                    break;
                }

                if (type.IsConstructedGenericType)
                {
                    var openDef = type.GetGenericTypeDefinition();
                    var typeArgs = type.GetGenericArguments();
                    var genericInst = encoder.GenericInstantiation(
                        this.GetTypeReference(openDef),
                        typeArgs.Length,
                        isValueType: openDef.IsValueType);
                    foreach (var arg in typeArgs)
                    {
                        EncodeClrType(genericInst.AddArgument(), arg);
                    }

                    break;
                }

                // A generic type definition used as a return/parameter type in an
                // open method signature (e.g. AsyncTaskMethodBuilder<TResult>.Create()
                // returning AsyncTaskMethodBuilder<TResult>). The reflection type is
                // the generic type definition itself, but it must encode as a
                // GenericInstantiation with its own type parameters as arguments.
                if (type.IsGenericTypeDefinition)
                {
                    var typeParams = type.GetGenericArguments();
                    var genericInst = encoder.GenericInstantiation(
                        this.GetTypeReference(type),
                        typeParams.Length,
                        isValueType: type.IsValueType);
                    foreach (var tp in typeParams)
                    {
                        EncodeClrType(genericInst.AddArgument(), tp);
                    }

                    break;
                }

                encoder.Type(this.GetTypeReference(type), isValueType: type.IsValueType);
                break;
        }
    }

    private void EncodeReturnClr(ReturnTypeEncoder encoder, ParameterInfo returnParameter, Type type)
    {
        if (type?.FullName == "System.Void")
        {
            encoder.Void();
        }
        else if (type != null && type.IsByRef)
        {
            // ADR-0056 §1/§2: a `ref`/`ref readonly T` return (e.g. the span
            // indexer's `get_Item`) must encode as a managed pointer to the
            // pointee. A `ref readonly T` return additionally carries a required
            // custom modifier (`modreq(InAttribute)` on `ReadOnlySpan[T]`); it
            // must be encoded or the methodref signature fails to resolve at
            // runtime (MissingMethodException). Without `isByRef: true` the
            // return was malformed for every ref-returning member.
            var requiredModifiers = returnParameter?.GetRequiredCustomModifiers() ?? Type.EmptyTypes;
            if (requiredModifiers.Length > 0)
            {
                var modifiers = encoder.CustomModifiers();
                foreach (var modifier in requiredModifiers)
                {
                    modifiers.AddModifier(this.GetTypeReference(modifier), isOptional: false);
                }
            }

            this.EncodeClrType(encoder.Type(isByRef: true), type.GetElementType()!);
        }
        else
        {
            this.EncodeClrType(encoder.Type(), type);
        }
    }

    /// <summary>
    /// Issue #295: map an arbitrary CLR delegate type (named or generic, e.g.
    /// <c>System.Predicate&lt;int&gt;</c>, <c>RequestDelegate</c>,
    /// <c>System.EventHandler</c>) from the host runtime onto the emitter's
    /// reference (MetadataLoadContext) types, reconstructing constructed
    /// generics from a reference open definition so the produced TypeSpec /
    /// MemberRef binds to the target framework assemblies. Falls back to the
    /// host type when no reference mapping is available.
    /// </summary>
    private Type ResolveTargetDelegateClrType(Type hostDelegate)
    {
        if (hostDelegate == null)
        {
            return null;
        }

        if (hostDelegate.IsConstructedGenericType)
        {
            var openName = hostDelegate.GetGenericTypeDefinition().FullName;
            if (openName != null && this.references.TryResolveType(openName, out var openRef))
            {
                var hostArgs = hostDelegate.GetGenericArguments();
                var refArgs = new Type[hostArgs.Length];
                for (var i = 0; i < hostArgs.Length; i++)
                {
                    refArgs[i] = this.MapToReferenceClrType(hostArgs[i]) ?? hostArgs[i];
                }

                return openRef.MakeGenericType(refArgs);
            }

            return hostDelegate;
        }

        return this.MapToReferenceClrType(hostDelegate) ?? hostDelegate;
    }

    // Phase 4 emit parity (E1): resolve the BCL delegate type backing a
    // GSharp function type. The default ClrType on FunctionTypeSymbol uses
    // host-runtime `typeof(Func<,>)` (which lives in System.Private.CoreLib);
    // the emitter must instead reference the *target* framework's
    // System.Func / System.Action so the produced TypeRef binds to the right
    // assembly. Type arguments are resolved through references too so
    // signature encoding stays consistent end-to-end.
    private Type ResolveDelegateClrType(FunctionTypeSymbol fnType)
    {
        bool isVoid = fnType.ReturnType == null || fnType.ReturnType == TypeSymbol.Void;
        int arity = fnType.ParameterTypes.Length;

        if (isVoid && arity == 0)
        {
            return this.references.GetCoreType("System.Action");
        }

        var typeName = isVoid
            ? "System.Action`" + arity.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : "System.Func`" + (arity + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var openDef = this.references.GetCoreType(typeName);

        var args = new Type[arity + (isVoid ? 0 : 1)];
        for (int i = 0; i < arity; i++)
        {
            args[i] = this.ResolveDelegateArgClrType(fnType.ParameterTypes[i]);
        }

        if (!isVoid)
        {
            args[arity] = this.ResolveDelegateArgClrType(fnType.ReturnType);
        }

        return openDef.MakeGenericType(args);
    }

    // Resolve the CLR type used as a System.Func/System.Action type argument
    // for one delegate parameter or return TypeSymbol. Under the type-erased
    // generic model (Phase 4 emit parity, F1) an open type parameter has no
    // ClrType; it erases to System.Object so the constructed open delegate
    // (e.g. func(T) U -> System.Func<object, object>) resolves cleanly. Call
    // sites already box / unbox.any value-type arguments and returns around
    // the erased boundary.
    private Type ResolveDelegateArgClrType(TypeSymbol type)
    {
        if (type is TypeParameterSymbol)
        {
            return this.coreObjectType;
        }

        return this.MapToReferenceClrType(type.ClrType) ?? this.coreObjectType;
    }

    /// <summary>
    /// For an async lambda, resolves the delegate CLR type with the return type
    /// wrapped in Task/Task&lt;T&gt; (matching the actual kickoff method signature).
    /// </summary>
    private Type ResolveAsyncDelegateClrType(FunctionTypeSymbol fnType, FunctionSymbol function)
    {
        // Find the async plan for this function.
        AsyncStateMachinePlan plan = null;
        foreach (var p in this.asyncStateMachinePlans)
        {
            if (p.KickoffMethod == function)
            {
                plan = p;
                break;
            }
        }

        if (plan == null)
        {
            return this.ResolveDelegateClrType(fnType);
        }

        var builderInfo = plan.StateMachine.BuilderInfo;
        Type taskClrType;
        if (builderInfo.Kind == AsyncMethodBuilderKind.Void)
        {
            taskClrType = typeof(System.Threading.Tasks.Task);
        }
        else if (builderInfo.TaskProperty != null)
        {
            taskClrType = builderInfo.TaskProperty.PropertyType;
        }
        else
        {
            taskClrType = typeof(System.Threading.Tasks.Task);
        }

        int arity = fnType.ParameterTypes.Length;
        var typeName = "System.Func`" + (arity + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var openDef = this.references.GetCoreType(typeName);

        var args = new Type[arity + 1];
        for (int i = 0; i < arity; i++)
        {
            args[i] = this.MapToReferenceClrType(fnType.ParameterTypes[i].ClrType);
        }

        args[arity] = this.MapToReferenceClrType(taskClrType);
        return openDef.MakeGenericType(args);
    }

    // Map a host-runtime Type onto the MetadataLoadContext type from the
    // emitter's references when an equivalent exists. Returns the input
    // unchanged when no mapping is found — non-primitive host types whose
    // FullName isn't resolvable will keep their original identity (and may
    // still encode fine via EncodeClrType's primitive matching).
    private Type MapToReferenceClrType(Type hostType)
    {
        if (hostType == null)
        {
            return null;
        }

        if (this.references.TryResolveType(hostType.FullName ?? hostType.Name, out var mapped))
        {
            return mapped;
        }

        return hostType;
    }

    private sealed class IteratorStateMachineInfo
    {
        public IteratorStateMachineInfo(IteratorStateMachinePlan plan, StructSymbol classSym)
        {
            this.Plan = plan;
            this.ClassSym = classSym;
        }

        public IteratorStateMachinePlan Plan { get; }

        public StructSymbol ClassSym { get; }
    }

    /// <summary>
    /// Lightweight emit-time context for async iterator MoveNext methods.
    /// Carries the builder field, SM class, and builder info needed by EmitAwaitOnCompletedCall.
    /// </summary>
    private sealed class AsyncIteratorEmitContext
    {
        public AsyncIteratorEmitContext(StructSymbol smClass, FieldSymbol builderField, Lowering.Async.AsyncMethodBuilderInfo builderInfo)
        {
            this.SmClass = smClass;
            this.BuilderField = builderField;
            this.BuilderInfo = builderInfo;
        }

        public StructSymbol SmClass { get; }

        public FieldSymbol BuilderField { get; }

        public Lowering.Async.AsyncMethodBuilderInfo BuilderInfo { get; }
    }

    private sealed class ClosureInfo
    {
        public ClosureInfo(StructSymbol classSym, FunctionSymbol invokeMethod, Dictionary<VariableSymbol, FieldSymbol> captureFields)
        {
            this.ClassSym = classSym;
            this.InvokeMethod = invokeMethod;
            this.CaptureFields = captureFields;
        }

        public StructSymbol ClassSym { get; }

        public FunctionSymbol InvokeMethod { get; }

        public Dictionary<VariableSymbol, FieldSymbol> CaptureFields { get; }
    }

    private sealed class CaptureRewriter : BoundTreeRewriter
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

    private sealed class ConstructedTypeCollector : BoundTreeRewriter
    {
        public HashSet<StructSymbol> Constructed { get; } = new HashSet<StructSymbol>();

        protected override BoundExpression RewriteExpression(BoundExpression node)
        {
            this.TryAdd(node.Type);
            switch (node)
            {
                case BoundStructLiteralExpression sl:
                    this.TryAdd(sl.StructType);
                    foreach (var init in sl.Initializers)
                    {
                        this.TryAdd(init.Field.Type);
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

    private sealed class BlockExpressionLocalCollector : BoundTreeRewriter
    {
        public List<VariableSymbol> Variables { get; } = new List<VariableSymbol>();

        protected override BoundExpression RewriteBlockExpression(BoundBlockExpression node)
        {
            foreach (var statement in node.Statements)
            {
                if (statement is BoundVariableDeclaration declaration)
                {
                    this.Variables.Add(declaration.Variable);
                }
            }

            return base.RewriteBlockExpression(node);
        }
    }

    // Walks an arbitrary bound sub-tree and records every BoundLabelStatement
    // label it discovers. Implemented as a BoundTreeRewriter subclass so it
    // automatically descends through every statement and expression kind
    // (including BoundBlockExpression, BoundSpillSequenceExpression, etc.)
    // without having to enumerate them by hand. The rewriter is used purely
    // as a visitor — its returned nodes are discarded.
    private sealed class ExpressionBlockLabelCollector : BoundTreeRewriter
    {
        private readonly HashSet<BoundLabel> sink;

        public ExpressionBlockLabelCollector(HashSet<BoundLabel> sink)
        {
            this.sink = sink;
        }

        public void Visit(BoundExpression expression)
        {
            this.RewriteExpression(expression);
        }

        protected override BoundStatement RewriteLabelStatement(BoundLabelStatement node)
        {
            this.sink.Add(node.Label);
            return node;
        }
    }

    private sealed class LambdaCollector : BoundTreeRewriter
    {
        private readonly List<BoundFunctionLiteralExpression> sink;

        public LambdaCollector(List<BoundFunctionLiteralExpression> sink)
        {
            this.sink = sink;
        }

        protected override BoundExpression RewriteFunctionLiteralExpression(BoundFunctionLiteralExpression node)
        {
            this.sink.Add(node);
            this.RewriteStatement(node.Body);
            return node;
        }
    }

    private sealed class GoStatementCollector : BoundTreeRewriter
    {
        private readonly List<BoundGoStatement> sink;

        public GoStatementCollector(List<BoundGoStatement> sink)
        {
            this.sink = sink;
        }

        protected override BoundStatement RewriteGoStatement(BoundGoStatement node)
        {
            this.sink.Add(node);
            return base.RewriteGoStatement(node);
        }

        protected override BoundExpression RewriteFunctionLiteralExpression(BoundFunctionLiteralExpression node)
        {
            this.RewriteStatement(node.Body);
            return node;
        }
    }

    private sealed class GoCapturedVariableCollector : BoundTreeRewriter
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
            this.RewriteExpression(expression);
        }

        protected override BoundExpression RewriteVariableExpression(BoundVariableExpression node)
        {
            this.CaptureIfFree(node.Variable);
            return node;
        }

        protected override BoundExpression RewriteAssignmentExpression(BoundAssignmentExpression node)
        {
            this.CaptureIfFree(node.Variable);
            return base.RewriteAssignmentExpression(node);
        }

        protected override BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
        {
            var initializer = this.RewriteExpression(node.Initializer);
            this.declared.Add(node.Variable);
            return initializer == node.Initializer
                ? node
                : new BoundVariableDeclaration(null, node.Variable, initializer, node.ConstantValue);
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

    private sealed class DefaultExpressionCollector : BoundTreeRewriter
    {
        private readonly List<BoundDefaultExpression> sink;

        public DefaultExpressionCollector(List<BoundDefaultExpression> sink)
        {
            this.sink = sink;
        }

        protected override BoundExpression RewriteDefaultExpression(BoundDefaultExpression node)
        {
            this.sink.Add(node);
            return node;
        }
    }

    private sealed class ReceiverSpillCollector : BoundTreeRewriter
    {
        private readonly ReflectionMetadataEmitter outer;
        private readonly FunctionSymbol function;
        private readonly IReadOnlyDictionary<VariableSymbol, int> locals;
        private readonly List<BoundExpression> sink;

        public ReceiverSpillCollector(
            ReflectionMetadataEmitter outer,
            FunctionSymbol function,
            IReadOnlyDictionary<VariableSymbol, int> locals,
            List<BoundExpression> sink)
        {
            this.outer = outer;
            this.function = function;
            this.locals = locals;
            this.sink = sink;
        }

        protected override BoundExpression RewriteImportedInstanceCallExpression(BoundImportedInstanceCallExpression node)
        {
            this.AddIfNeeded(node.Receiver);
            return base.RewriteImportedInstanceCallExpression(node);
        }

        protected override BoundExpression RewriteUserInstanceCallExpression(BoundUserInstanceCallExpression node)
        {
            this.AddIfNeeded(node.Receiver);
            return base.RewriteUserInstanceCallExpression(node);
        }

        protected override BoundExpression RewriteClrPropertyAccessExpression(BoundClrPropertyAccessExpression node)
        {
            if (node.Receiver != null)
            {
                this.AddIfNeeded(node.Receiver);
            }

            return base.RewriteClrPropertyAccessExpression(node);
        }

        protected override BoundExpression RewriteClrPropertyAssignmentExpression(BoundClrPropertyAssignmentExpression node)
        {
            if (node.Receiver != null)
            {
                this.AddIfNeeded(node.Receiver);
            }

            return base.RewriteClrPropertyAssignmentExpression(node);
        }

        // Issue #418 (P1-5): G# computed/auto properties also need the spill
        // infrastructure when the receiver is a non-addressable struct rvalue
        // (e.g. `makePoint(5, 6).Sum`, `getOuter().Inner.Length`).
        protected override BoundExpression RewritePropertyAccessExpression(BoundPropertyAccessExpression node)
        {
            if (node.Receiver != null)
            {
                this.AddIfNeeded(node.Receiver);
            }

            return base.RewritePropertyAccessExpression(node);
        }

        protected override BoundExpression RewritePropertyAssignmentExpression(BoundPropertyAssignmentExpression node)
        {
            if (node.Receiver != null)
            {
                this.AddIfNeeded(node.Receiver);
            }

            return base.RewritePropertyAssignmentExpression(node);
        }

        protected override BoundExpression RewriteClrEventSubscriptionExpression(BoundClrEventSubscriptionExpression node)
        {
            if (node.Receiver != null)
            {
                this.AddIfNeeded(node.Receiver);
            }

            return base.RewriteClrEventSubscriptionExpression(node);
        }

        protected override BoundExpression RewriteEventSubscriptionExpression(BoundEventSubscriptionExpression node)
        {
            if (node.Receiver != null)
            {
                this.AddIfNeeded(node.Receiver);
            }

            return base.RewriteEventSubscriptionExpression(node);
        }

        protected override BoundExpression RewriteClrIndexExpression(BoundClrIndexExpression node)
        {
            this.AddIfNeeded(node.Target);
            return base.RewriteClrIndexExpression(node);
        }

        protected override BoundExpression RewriteTupleElementAccessExpression(BoundTupleElementAccessExpression node)
        {
            this.AddIfNeeded(node.Receiver);
            return base.RewriteTupleElementAccessExpression(node);
        }

        protected override BoundExpression RewriteClrMethodGroupExpression(BoundClrMethodGroupExpression node)
        {
            if (node.Receiver != null)
            {
                this.AddIfNeeded(node.Receiver);
            }

            return base.RewriteClrMethodGroupExpression(node);
        }

        private void AddIfNeeded(BoundExpression receiver)
        {
            if (this.outer.NeedsRvalueReceiverSpill(receiver, this.function, this.locals))
            {
                this.sink.Add(receiver);
            }
        }
    }

    private sealed class MapIndexReadCollector : BoundTreeRewriter
    {
        private readonly List<BoundIndexExpression> sink;

        public MapIndexReadCollector(List<BoundIndexExpression> sink)
        {
            this.sink = sink;
        }

        protected override BoundExpression RewriteIndexExpression(BoundIndexExpression node)
        {
            if (node.Target.Type is MapTypeSymbol)
            {
                this.sink.Add(node);
            }

            return base.RewriteIndexExpression(node);
        }
    }

    // Issue #418 (P1-1): collects every index-assignment expression so the body
    // emitter can pre-allocate a scratch slot of the value's type. The emit sites
    // use a dup + stloc tmp + store + ldloc tmp pattern to avoid re-evaluating
    // the index/argument expressions when producing the assignment's result.
    private sealed class IndexAssignmentValueSpillCollector : BoundTreeRewriter
    {
        private readonly List<BoundExpression> sink;

        public IndexAssignmentValueSpillCollector(List<BoundExpression> sink)
        {
            this.sink = sink;
        }

        protected override BoundExpression RewriteIndexAssignmentExpression(BoundIndexAssignmentExpression node)
        {
            this.sink.Add(node);
            return base.RewriteIndexAssignmentExpression(node);
        }

        protected override BoundExpression RewriteClrIndexAssignmentExpression(BoundClrIndexAssignmentExpression node)
        {
            this.sink.Add(node);
            return base.RewriteClrIndexAssignmentExpression(node);
        }
    }

    // Issue #418 (P1-2): walker that collects every BoundPropertyAssignment /
    // BoundClrPropertyAssignment expression so the slot allocator can give
    // each one a value-temp local for the dup/stloc spill described in
    // CollectAssignmentValueSpills.
    private sealed class AssignmentValueSpillCollector : BoundTreeRewriter
    {
        private readonly List<BoundExpression> sink;

        public AssignmentValueSpillCollector(List<BoundExpression> sink)
        {
            this.sink = sink;
        }

        protected override BoundExpression RewritePropertyAssignmentExpression(BoundPropertyAssignmentExpression node)
        {
            this.sink.Add(node);
            return base.RewritePropertyAssignmentExpression(node);
        }

        protected override BoundExpression RewriteClrPropertyAssignmentExpression(BoundClrPropertyAssignmentExpression node)
        {
            this.sink.Add(node);
            return base.RewriteClrPropertyAssignmentExpression(node);
        }
    }

    private sealed class SelectSlots
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
            ChannelSlots = channelSlots;
            ValueSlots = valueSlots;
            OutSlots = outSlots;
            TasksSlot = tasksSlot;
            WaitValueTaskSlot = waitValueTaskSlot;
            WhenAnyTaskSlot = whenAnyTaskSlot;
            WhenAnyAwaiterSlot = whenAnyAwaiterSlot;
            CompletedTaskSlot = completedTaskSlot;
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

    /// <summary>
    /// Walks bound statements and emits IL into a single instruction encoder.
    /// </summary>
    private sealed class BodyEmitter
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
        private readonly ParameterSymbol structThisParameter;
        private readonly Lowering.Async.AsyncStateMachineFieldMap asyncFieldMap;
        private readonly Lowering.Async.AsyncStateMachinePlan asyncPlan;
        private readonly AsyncIteratorEmitContext asyncIteratorEmitCtx;
        private readonly Dictionary<VariableSymbol, object> constValues;

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

        public BodyEmitter(
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
            ParameterSymbol structThisParameter = null,
            Lowering.Async.AsyncStateMachineFieldMap asyncFieldMap = null,
            Lowering.Async.AsyncStateMachinePlan asyncPlan = null,
            AsyncIteratorEmitContext asyncIteratorEmitCtx = null,
            Dictionary<VariableSymbol, object> constValues = null)
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
            this.structThisParameter = structThisParameter;
            this.asyncFieldMap = asyncFieldMap;
            this.asyncPlan = asyncPlan;
            this.asyncIteratorEmitCtx = asyncIteratorEmitCtx;
            this.constValues = constValues;
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
                CollectLabels(statement, nested);
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
                        this.EmitExpression(ret.Expression);
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
                    throw new NotSupportedException("Internal error: yield reached the emitter before iterator lowering.");
                case BoundAwaitSequencePoint:
                    this.il.OpCode(ILOpCode.Nop);
                    break;
                default:
                    throw new NotSupportedException(
                        $"Bound statement kind '{statement.Kind}' is not yet supported by the emitter.");
            }
        }

        // Phase 4 (ADR-0027 §7.7a): record a sequence point for the current
        // statement before its first opcode lands in the IL stream. Skipped for
        // block / label statements (children record their own anchors and a
        // label statement emits no IL of its own). BoundAwaitSequencePoint and
        // synthesised statements with no Syntax map to hidden (0xfeefee).
        private void RecordSequencePointFor(BoundStatement statement)
        {
            if (this.outer.pdb == null)
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

            var documentHandle = this.outer.pdb.GetOrAddDocument(syntax.SyntaxTree);
            this.sequencePoints.Add(new SequencePoint(
                ilOffset: ilOffset,
                document: documentHandle,
                startLine: location.StartLine + 1,
                startColumn: location.StartCharacter + 1,
                endLine: location.EndLine + 1,
                endColumn: location.EndCharacter + 1));
            this.lastSequencePointIlOffset = ilOffset;
        }

        private void EmitExpression(BoundExpression expression)
        {
            switch (expression)
            {
                case BoundLiteralExpression literal:
                    this.EmitLiteral(literal);
                    break;
                case BoundVariableExpression v:
                    this.EmitLoadVariable(v.Variable);
                    break;
                case BoundAssignmentExpression a:
                    this.EmitExpression(a.Expression);
                    this.il.OpCode(ILOpCode.Dup);
                    this.EmitStoreVariable(a.Variable);
                    break;
                case BoundUnaryExpression u:
                    this.EmitUnary(u);
                    break;
                case BoundBinaryExpression b:
                    this.EmitBinary(b);
                    break;
                case BoundCallExpression call:
                    // ADR-0047 §6 / issue #176: a [Conditional("SYMBOL")] call
                    // whose symbol is undefined is elided at the call site —
                    // emit no IL for arguments or the call itself. The call
                    // is a no-op of type void; the enclosing
                    // BoundExpressionStatement already skips the Pop because
                    // call.Type == Void.
                    if (call.IsConditionalElided)
                    {
                        break;
                    }

                    for (int i = 0; i < call.Arguments.Length; i++)
                    {
                        var arg = call.Arguments[i];
                        this.EmitExpression(arg);

                        // Phase 4 emit parity (F1, type-erased generics):
                        // a parameter typed as an open T receives System.Object
                        // in the emitted signature. Value-type arguments must
                        // be boxed at the call boundary so the call's stack
                        // shape matches the signature.
                        if (i < call.Function.Parameters.Length
                            && call.Function.Parameters[i].Type is TypeParameterSymbol
                            && arg.Type is not TypeParameterSymbol
                            && IsValueTypeSymbol(arg.Type))
                        {
                            this.il.OpCode(ILOpCode.Box);
                            this.il.Token(this.outer.GetElementTypeToken(arg.Type));
                        }
                    }

                    if (!this.outer.functionHandles.TryGetValue(call.Function, out var fnHandle)
                        && !this.outer.methodHandles.TryGetValue(call.Function, out fnHandle))
                    {
                        throw new InvalidOperationException(
                            $"Call to function '{call.Function.Name}' has no emitted MethodDef.");
                    }

                    this.il.Call(fnHandle);

                    // Phase 4 emit parity (F1, type-erased generics): a return
                    // typed as an open T is encoded as System.Object. If the
                    // call's substituted return type is a value type, unbox
                    // the result so the rest of the IL sees the expected
                    // primitive on stack.
                    if (call.Function.Type is TypeParameterSymbol
                        && call.Type is not TypeParameterSymbol
                        && IsValueTypeSymbol(call.Type))
                    {
                        this.il.OpCode(ILOpCode.Unbox_any);
                        this.il.Token(this.outer.GetElementTypeToken(call.Type));
                    }
                    else if (TypeSymbol.ContainsTypeParameter(call.Function.Type)
                        && !TypeSymbol.ContainsTypeParameter(call.Type)
                        && call.Type?.ClrType != null
                        && !IsValueTypeSymbol(call.Type))
                    {
                        // #313: a return typed as an erased generic over a type
                        // parameter (e.g. `func GetAll[T]() List[T]`) is encoded
                        // as System.Object. When the substituted return type is
                        // a concrete reference type (e.g. `List<int32>`), cast
                        // the boxed-free reference back so the rest of the IL —
                        // and any subsequent indexing/member access — sees it.
                        this.il.OpCode(ILOpCode.Castclass);
                        this.il.Token(this.outer.GetElementTypeToken(call.Type));
                    }

                    break;
                case BoundImportedCallExpression impCall:
                    this.EmitImportedCallArguments(impCall.Arguments, impCall.ArgumentRefKinds);
                    this.il.Call(this.outer.GetMethodEntityHandle(impCall.Function.Method, impCall.TypeArgumentSymbols));
                    break;
                case BoundClrStaticCallExpression staticCall:
                    this.EmitImportedCallArguments(staticCall.Arguments, staticCall.ArgumentRefKinds);
                    this.il.Call(this.outer.GetMethodEntityHandle(staticCall.Method));
                    break;
                case BoundImportedInstanceCallExpression instCall:
                {
                    var receiverIsValueType = IsValueTypeSymbol(instCall.Receiver.Type);

                    // A value-type receiver invoking a method it inherits from a
                    // reference base type (System.Object/ValueType/Enum) — e.g.
                    // GetType(), or ToString()/Equals()/GetHashCode() when the
                    // value type does not override them — must be boxed. The
                    // callee's `this` is an object reference, not a managed
                    // pointer to the value; without the box the raw value bits
                    // are reinterpreted as a reference, producing an
                    // AccessViolationException (or silent corruption) at runtime.
                    var declaringType = instCall.Method.DeclaringType;
                    var receiverNeedsBox = receiverIsValueType
                        && declaringType != null
                        && !declaringType.IsValueType;

                    // A value type calling a method it declares itself receives a
                    // managed pointer (`this` is `ref TStruct`) and uses `call`;
                    // a boxed value or a reference receiver uses `callvirt`.
                    var useCall = receiverIsValueType && !receiverNeedsBox;

                    if (receiverNeedsBox)
                    {
                        // Load the receiver value (not its address) and box it so
                        // the inherited reference-type method receives a proper
                        // object reference.
                        this.EmitExpression(instCall.Receiver);
                        this.il.OpCode(ILOpCode.Box);
                        this.il.Token(this.outer.GetElementTypeToken(instCall.Receiver.Type));
                    }
                    else
                    {
                        this.EmitInstanceReceiver(instCall.Receiver);
                    }

                    this.EmitImportedCallArguments(instCall.Arguments, instCall.ArgumentRefKinds);
                    var instCallHandle = this.outer.GetMethodEntityHandle(instCall.Method, instCall.TypeArgumentSymbols);

                    this.il.OpCode(useCall ? ILOpCode.Call : ILOpCode.Callvirt);
                    this.il.Token(instCallHandle);
                    break;
                }

                case BoundAddressOfExpression addressOf:
                    this.EmitAddressOf(addressOf);
                    break;
                case BoundDereferenceExpression deref:
                    this.EmitDereference(deref);
                    break;
                case BoundStateMachineAwaitOnCompleted awaitOnCompleted:
                    this.EmitStateMachineAwaitOnCompleted(awaitOnCompleted);
                    break;
                case BoundStateMachineBuilderMoveNext builderMoveNext:
                    this.EmitAsyncIteratorBuilderMoveNext(builderMoveNext);
                    break;
                case BoundConversionExpression conv:
                    this.EmitConversion(conv);
                    break;
                case BoundArrayCreationExpression arr:
                    this.EmitArrayCreation(arr);
                    break;
                case BoundIndexExpression idx:
                    if (idx.Target.Type is MapTypeSymbol)
                    {
                        this.EmitMapIndexRead(idx);
                    }
                    else
                    {
                        this.EmitExpression(idx.Target);
                        this.EmitExpression(idx.Index);
                        this.EmitLoadElement(idx.Type);
                    }

                    break;
                case BoundIndexAssignmentExpression ixa:
                    if (ixa.Target.Type is MapTypeSymbol)
                    {
                        this.EmitMapIndexAssignment(ixa);
                    }
                    else
                    {
                        // Issue #418 (P1-1): evaluate target/index/value exactly once.
                        // dup + stloc tmp + stelem + ldloc tmp leaves the assigned
                        // value on the stack as the expression's result without
                        // re-evaluating the index expression (which may have side
                        // effects, e.g. a function call).
                        var tmp = this.indexAssignmentValueSlots[ixa];
                        this.EmitLoadVariable(ixa.Target);
                        this.EmitExpression(ixa.Index);
                        this.EmitExpression(ixa.Value);
                        this.il.OpCode(ILOpCode.Dup);
                        this.il.StoreLocal(tmp);
                        this.EmitStoreElement(ixa.Type);
                        this.il.LoadLocal(tmp);
                    }

                    break;
                case BoundLenExpression len:
                    this.EmitLen(len);
                    break;
                case BoundTypeOfExpression typeOf:
                    this.EmitTypeOf(typeOf);
                    break;
                case BoundCapExpression cap:
                    this.EmitExpression(cap.Operand);
                    this.il.OpCode(ILOpCode.Ldlen);
                    this.il.OpCode(ILOpCode.Conv_i4);
                    break;
                case BoundAppendExpression app:
                    this.EmitAppend(app);
                    break;
                case BoundStructLiteralExpression structLit:
                    this.EmitStructLiteral(structLit);
                    break;
                case BoundBlockExpression blockExpr:
                    this.EmitBlockExpression(blockExpr);
                    break;
                case BoundSwitchExpression switchExpr:
                    this.EmitSwitchExpression(switchExpr);
                    break;
                case BoundMakeChannelExpression mkCh:
                    this.EmitMakeChannelExpression(mkCh);
                    break;
                case BoundChannelReceiveExpression chRecv:
                    this.EmitChannelReceiveExpression(chRecv);
                    break;
                case BoundChannelCloseExpression chClose:
                    this.EmitChannelCloseExpression(chClose);
                    break;
                case BoundConstructorCallExpression ctorCall:
                    this.EmitConstructorCall(ctorCall);
                    break;
                case BoundUserInstanceCallExpression uic:
                    this.EmitUserInstanceCall(uic);
                    break;
                case BoundFieldAccessExpression fa:
                    this.EmitFieldAccess(fa);
                    break;
                case BoundFieldAssignmentExpression fas:
                    this.EmitFieldAssignment(fas);
                    break;
                case BoundPropertyAccessExpression propAcc:
                    this.EmitPropertyAccess(propAcc);
                    break;
                case BoundPropertyAssignmentExpression propAsn:
                    this.EmitPropertyAssignment(propAsn);
                    break;
                case BoundNullConditionalAccessExpression nc:
                    this.EmitNullConditionalAccess(nc);
                    break;
                case BoundClrConstructorCallExpression clrCtor:
                    this.EmitClrConstructorCall(clrCtor);
                    break;
                case BoundClrPropertyAccessExpression clrProp:
                    this.EmitClrPropertyAccess(clrProp);
                    break;
                case BoundClrPropertyAssignmentExpression clrPropAsn:
                    this.EmitClrPropertyAssignment(clrPropAsn);
                    break;
                case BoundClrEventSubscriptionExpression clrEventSub:
                    this.EmitClrEventSubscription(clrEventSub);
                    break;
                case BoundEventSubscriptionExpression userEventSub:
                    this.EmitUserEventSubscription(userEventSub);
                    break;
                case BoundClrBinaryOperatorExpression clrBinOp:
                    this.EmitClrBinaryOperator(clrBinOp);
                    break;
                case BoundClrUnaryOperatorExpression clrUnOp:
                    this.EmitClrUnaryOperator(clrUnOp);
                    break;
                case BoundClrConversionCallExpression clrConv:
                    this.EmitClrConversionCall(clrConv);
                    break;
                case BoundClrIndexExpression clrIdx:
                    this.EmitClrIndex(clrIdx);
                    break;
                case BoundClrIndexAssignmentExpression clrIdxAsn:
                    this.EmitClrIndexAssignment(clrIdxAsn);
                    break;
                case BoundTupleLiteralExpression tupleLit:
                    this.EmitTupleLiteral(tupleLit);
                    break;
                case BoundTupleElementAccessExpression tupleAcc:
                    this.EmitTupleElementAccess(tupleAcc);
                    break;
                case BoundFunctionLiteralExpression literal:
                    this.EmitFunctionLiteral(literal);
                    break;
                case BoundMethodGroupExpression methodGroup:
                    this.EmitMethodGroup(methodGroup, overrideDelegateType: null);
                    break;
                case BoundClrMethodGroupExpression clrMethodGroup:
                    this.EmitClrMethodGroup(clrMethodGroup);
                    break;
                case BoundIndirectCallExpression indirect:
                    this.EmitIndirectCall(indirect);
                    break;
                case BoundMapLiteralExpression mapLit:
                    this.EmitMapLiteral(mapLit);
                    break;
                case BoundMapDeleteExpression mapDel:
                    this.EmitMapDelete(mapDel);
                    break;
                case BoundDefaultExpression defaultExpr:
                    this.EmitDefault(defaultExpr);
                    break;
                default:
                    throw new NotSupportedException(
                        $"Bound expression kind '{expression.Kind}' is not yet supported by the emitter.");
            }
        }

        private void EmitConversion(BoundConversionExpression conv)
        {
            // Issue #295: GSharp function value → CLR delegate. This is the
            // general materialization that previously only happened in
            // argument position; routing it through EmitConversion makes
            // assignment, return, and cast positions emit the same delegate
            // instantiation IL.
            if (conv.Expression.Type is FunctionTypeSymbol sourceFn
                && conv.Type?.ClrType != null
                && ClrTypeUtilities.IsDelegateType(conv.Type.ClrType))
            {
                this.EmitFunctionToDelegateConversion(conv.Expression, sourceFn, conv.Type.ClrType);
                return;
            }

            this.EmitExpression(conv.Expression);
            var from = conv.Expression.Type;
            var to = conv.Type;
            if (from == to)
            {
                return;
            }

            // Phase 3.C.2 / ADR-0001: `nil` flows into any nullable or
            // reference-typed slot; the IL value is already ldnull.
            if (from == TypeSymbol.Null && (to is NullableTypeSymbol || (to is StructSymbol ts && ts.IsClass)))
            {
                return;
            }

            // Phase 3 exit: widening to a nullable reference type (`T` -> `T?`)
            // is metadata-only because reference nullability shares the CLR
            // representation. The same applies to narrowing back via `!!`.
            if (to is NullableTypeSymbol toNullable && IsReferenceCompatible(from, toNullable.UnderlyingType))
            {
                return;
            }

            if (from is NullableTypeSymbol fromNullable && IsReferenceCompatible(fromNullable.UnderlyingType, to))
            {
                return;
            }

            // Minimal numeric / to-string conversions sufficient for current language coverage.
            if (to == TypeSymbol.Int32 && from == TypeSymbol.Bool)
            {
                // bool already lives as i4 on the stack; no-op.
                return;
            }

            if (to == TypeSymbol.Bool && from == TypeSymbol.Int32)
            {
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
                return;
            }

            // ADR-0044 numeric conversion lattice. Any pair of numeric CLR
            // primitives (sbyte/byte/short/ushort/int/uint/long/ulong/nint/
            // nuint/float/double/decimal/char) gets a typed IL conversion.
            // Issue #421 P2-5: route a checked conversion through the
            // overflow-trapping `conv.ovf.*` variants when requested.
            if (TryEmitNumericConversion(from, to, conv.IsChecked))
            {
                return;
            }

            // Issue #421 P2-5: enum ⇄ numeric (and enum ⇄ enum) conversions.
            // CLR enums share storage with their underlying primitive, so we
            // simply re-route through the numeric lattice substituting the
            // underlying type on whichever side carries the enum.
            if (TryEmitEnumConversion(from, to, conv.IsChecked))
            {
                return;
            }

            if ((to?.ClrType == typeof(object) || IsInterfaceTargetType(to)) && IsValueTypeSymbol(from))
            {
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.GetElementTypeToken(from));
                return;
            }

            // ADR-0045 explicit unbox: `(T)objectValue` for a value type T.
            // Issue #421 P2-5: also fire when the source is an interface
            // reference (user-declared `InterfaceSymbol` or any CLR
            // interface), since a boxed value type held in an interface
            // slot needs `unbox.any` to surface as its native value type.
            if ((from?.ClrType == typeof(object) || IsInterfaceSourceType(from))
                && to?.ClrType != null && to.ClrType.IsValueType)
            {
                this.il.OpCode(ILOpCode.Unbox_any);
                this.il.Token(this.outer.GetElementTypeToken(to));
                return;
            }

            // Phase D: class → interface upcast is a CLR reference-level
            // no-op. The receiver already implements the interface; loading
            // the reference into an interface-typed slot needs no IL.
            if (IsReferenceCompatible(from, to))
            {
                return;
            }

            throw new NotSupportedException(
                $"Conversion from '{from.Name}' to '{to.Name}' is not yet supported by the emitter.");
        }

        // Issue #295: emit a GSharp function value materialized as a CLR
        // delegate of the (possibly named / generic) target delegate type.
        //
        //  * For a `func` literal we reuse EmitFunctionLiteral with the target
        //    delegate as the override type, so it emits the exact same
        //    `ldnull / ldftn / newobj <Delegate>::.ctor` sequence the
        //    argument-position path uses, but bound to the requested delegate.
        //  * For any other function-typed value (a func-typed variable, call
        //    result, etc.) the runtime value is already a delegate; adapt it
        //    to the target delegate type via `dup / ldvirtftn Invoke / newobj`.
        private void EmitFunctionToDelegateConversion(BoundExpression source, FunctionTypeSymbol sourceFn, Type targetDelegateHostType)
        {
            // Issue #323: when the target is the abstract System.Delegate /
            // System.MulticastDelegate base type, there is no concrete delegate
            // to instantiate. Materialize the function value as its natural
            // delegate type (Func/Action) instead; the resulting reference is
            // already a System.Delegate, so the widening is a no-op upcast.
            var targetDelegateType = IsSystemDelegateHostType(targetDelegateHostType)
                ? this.outer.ResolveDelegateClrType(sourceFn)
                : this.outer.ResolveTargetDelegateClrType(targetDelegateHostType);

            if (source is BoundFunctionLiteralExpression literal)
            {
                this.EmitFunctionLiteral(literal, overrideDelegateType: targetDelegateType);
                return;
            }

            // Issue #324: a method group materializes the same `ldnull / ldftn /
            // newobj <Delegate>` sequence as a no-capture lambda, but over the
            // existing named function's MethodDef and bound to the requested
            // target delegate type.
            if (source is BoundMethodGroupExpression methodGroup)
            {
                this.EmitMethodGroup(methodGroup, overrideDelegateType: targetDelegateType);
                return;
            }

            // Delegate-to-delegate adaptation: wrap the existing delegate's
            // Invoke method in a new delegate of the target type.
            var sourceDelegateType = this.outer.ResolveDelegateClrType(sourceFn);
            var sourceInvoke = sourceDelegateType.GetMethod("Invoke")
                ?? throw new InvalidOperationException(
                    $"Delegate type '{sourceDelegateType.FullName}' has no Invoke method.");
            var targetCtor = targetDelegateType.GetConstructors()[0];

            this.EmitExpression(source);
            this.il.OpCode(ILOpCode.Dup);
            this.il.OpCode(ILOpCode.Ldvirtftn);
            this.il.Token(this.outer.GetMethodReference(sourceInvoke));
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(targetCtor));
        }

        // ADR-0044 numeric conversions. Maps the from/to CLR pair to the
        // appropriate `conv.*` opcode or, for `decimal`, to the matching
        // implicit/explicit operator method. Returns true when an emission
        // was made. Issue #421 P2-5: when <paramref name="isChecked"/> is
        // true the narrowing is emitted with the overflow-trapping
        // `conv.ovf.*` opcodes so values that don't fit the target throw
        // <see cref="System.OverflowException"/> instead of truncating.
        private bool TryEmitNumericConversion(TypeSymbol fromSym, TypeSymbol toSym, bool isChecked = false)
        {
            var from = fromSym?.ClrType;
            var to = toSym?.ClrType;
            if (from is null || to is null)
            {
                return false;
            }

            if (!IsNumericClrType(from) || !IsNumericClrType(to))
            {
                return false;
            }

            // decimal is a value type with no `conv.*` opcode; route through
            // the BCL's operator methods. `op_Implicit` for widening sources
            // (every integral type → decimal) and `op_Explicit` otherwise.
            if (to == typeof(decimal) || from == typeof(decimal))
            {
                return TryEmitDecimalConversion(from, to);
            }

            if (isChecked)
            {
                return TryEmitCheckedNumericConversion(from, to);
            }

            // Stack-type bookkeeping: anything narrower than i4 is widened to
            // i4 on the evaluation stack, so the source's stack shape is
            // determined by `from`'s size only when it's i8, native int, r4,
            // or r8. We pick the conv opcode that matches the *target*
            // representation.
            ILOpCode? op = null;
            if (to == typeof(sbyte))
            {
                op = ILOpCode.Conv_i1;
            }
            else if (to == typeof(byte))
            {
                op = ILOpCode.Conv_u1;
            }
            else if (to == typeof(short))
            {
                op = ILOpCode.Conv_i2;
            }
            else if (to == typeof(ushort) || to == typeof(char))
            {
                op = ILOpCode.Conv_u2;
            }
            else if (to == typeof(int))
            {
                // From an i4-sized source the value is already i4. From i8,
                // r4, r8, nint, nuint we must narrow to i4.
                if (Is32BitOrSmaller(from))
                {
                    return true;
                }

                op = ILOpCode.Conv_i4;
            }
            else if (to == typeof(uint))
            {
                if (Is32BitOrSmaller(from))
                {
                    return true;
                }

                op = ILOpCode.Conv_u4;
            }
            else if (to == typeof(long))
            {
                op = ILOpCode.Conv_i8;
            }
            else if (to == typeof(ulong))
            {
                op = ILOpCode.Conv_u8;
            }
            else if (to == typeof(nint))
            {
                op = ILOpCode.Conv_i;
            }
            else if (to == typeof(nuint))
            {
                op = ILOpCode.Conv_u;
            }
            else if (to == typeof(float))
            {
                op = ILOpCode.Conv_r4;
            }
            else if (to == typeof(double))
            {
                op = ILOpCode.Conv_r8;
            }

            if (op == null)
            {
                return false;
            }

            this.il.OpCode(op.Value);
            return true;
        }

        private bool TryEmitDecimalConversion(Type from, Type to)
        {
            // To decimal: every numeric source has either an `op_Implicit`
            // (integrals, char) or an `op_Explicit` (float, double).
            if (to == typeof(decimal))
            {
                var op = typeof(decimal).GetMethod("op_Implicit", new[] { from })
                    ?? typeof(decimal).GetMethod("op_Explicit", new[] { from });
                if (op == null)
                {
                    return false;
                }

                this.il.Call(this.outer.GetMethodEntityHandle(op));
                return true;
            }

            // From decimal: every numeric target has an `op_Explicit`.
            if (from == typeof(decimal))
            {
                var op = typeof(decimal).GetMethod("op_Explicit", new[] { typeof(decimal) });
                // GetMethod by name+params resolves the conversion that
                // returns the requested type when overloads disambiguate by
                // return type; iterate to find the right one.
                foreach (var m in typeof(decimal).GetMethods())
                {
                    if (m.Name == "op_Explicit"
                        && m.ReturnType == to
                        && m.GetParameters().Length == 1
                        && m.GetParameters()[0].ParameterType == typeof(decimal))
                    {
                        op = m;
                        break;
                    }
                }

                if (op == null || op.ReturnType != to)
                {
                    return false;
                }

                this.il.Call(this.outer.GetMethodEntityHandle(op));
                return true;
            }

            return false;
        }

        // Issue #421 P2-5: emit a checked numeric narrowing using the
        // overflow-trapping `conv.ovf.*` opcodes. The `_un` variants are
        // selected when the *source* representation is unsigned (the
        // overflow check then treats the input as unsigned and the output
        // as the target's signedness).
        //
        // Floats have no `conv.ovf.r4 / r8`; checked float widening / float
        // → float narrowing is identical to the unchecked form, so we fall
        // back to `conv.r4 / conv.r8` for those targets. Source-is-float
        // narrowings to an integral still get `conv.ovf.*` so a NaN or
        // out-of-range float traps as overflow per ECMA-335.
        private bool TryEmitCheckedNumericConversion(Type from, Type to)
        {
            var sourceUnsigned = IsUnsignedClrType(from);
            ILOpCode? op = null;

            if (to == typeof(sbyte))
            {
                op = sourceUnsigned ? ILOpCode.Conv_ovf_i1_un : ILOpCode.Conv_ovf_i1;
            }
            else if (to == typeof(byte))
            {
                op = sourceUnsigned ? ILOpCode.Conv_ovf_u1_un : ILOpCode.Conv_ovf_u1;
            }
            else if (to == typeof(short))
            {
                op = sourceUnsigned ? ILOpCode.Conv_ovf_i2_un : ILOpCode.Conv_ovf_i2;
            }
            else if (to == typeof(ushort) || to == typeof(char))
            {
                op = sourceUnsigned ? ILOpCode.Conv_ovf_u2_un : ILOpCode.Conv_ovf_u2;
            }
            else if (to == typeof(int))
            {
                // From a same-size signed source the value already fits, but
                // from a same-size unsigned source we still need the check
                // (`uint` → `int` traps for values > Int32.MaxValue).
                if (from == typeof(int))
                {
                    return true;
                }

                op = sourceUnsigned ? ILOpCode.Conv_ovf_i4_un : ILOpCode.Conv_ovf_i4;
            }
            else if (to == typeof(uint))
            {
                if (from == typeof(uint))
                {
                    return true;
                }

                op = sourceUnsigned ? ILOpCode.Conv_ovf_u4_un : ILOpCode.Conv_ovf_u4;
            }
            else if (to == typeof(long))
            {
                // A signed widening (i1/i2/i4 → i8) needs `conv.i8` (not
                // `conv.ovf.i8`) because it can't overflow; the same holds
                // for the identity i8 → i8. An unsigned source widening to
                // long uses `conv.ovf.i8.un` to trap on the >Int64.MaxValue
                // boundary; an unsigned same-size widening (uint → long) is
                // safe but the `_un` variant still trivially succeeds.
                if (from == typeof(long))
                {
                    return true;
                }

                if (sourceUnsigned)
                {
                    op = ILOpCode.Conv_ovf_i8_un;
                }
                else if (from == typeof(float) || from == typeof(double))
                {
                    op = ILOpCode.Conv_ovf_i8;
                }
                else
                {
                    // Signed integral widening cannot overflow; emit the
                    // plain widening opcode.
                    op = ILOpCode.Conv_i8;
                }
            }
            else if (to == typeof(ulong))
            {
                if (from == typeof(ulong))
                {
                    return true;
                }

                op = sourceUnsigned ? ILOpCode.Conv_ovf_u8_un : ILOpCode.Conv_ovf_u8;
            }
            else if (to == typeof(nint))
            {
                op = sourceUnsigned ? ILOpCode.Conv_ovf_i_un : ILOpCode.Conv_ovf_i;
            }
            else if (to == typeof(nuint))
            {
                op = sourceUnsigned ? ILOpCode.Conv_ovf_u_un : ILOpCode.Conv_ovf_u;
            }
            else if (to == typeof(float))
            {
                op = ILOpCode.Conv_r4;
            }
            else if (to == typeof(double))
            {
                op = ILOpCode.Conv_r8;
            }

            if (op == null)
            {
                return false;
            }

            this.il.OpCode(op.Value);
            return true;
        }

        // Issue #421 P2-5: enum ⇄ numeric (and enum ⇄ enum). CLR enum
        // storage is identical to the underlying integral, so we route the
        // conversion through the numeric lattice using the underlying type
        // on whichever side carries the enum.
        private bool TryEmitEnumConversion(TypeSymbol from, TypeSymbol to, bool isChecked)
        {
            var fromUnderlying = GetEnumUnderlyingTypeSymbol(from);
            var toUnderlying = GetEnumUnderlyingTypeSymbol(to);

            if (fromUnderlying == null && toUnderlying == null)
            {
                return false;
            }

            var effectiveFrom = fromUnderlying ?? from;
            var effectiveTo = toUnderlying ?? to;

            // If the underlying primitives are identical (e.g. `Color` enum
            // ↔ int32, or one int-backed enum ↔ another int-backed enum)
            // the IL representation is the same and we emit nothing — the
            // i4 already on the stack is the result.
            if (effectiveFrom?.ClrType != null && effectiveTo?.ClrType != null
                && effectiveFrom.ClrType == effectiveTo.ClrType)
            {
                return true;
            }

            return TryEmitNumericConversion(effectiveFrom, effectiveTo, isChecked);
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

            // Issue #323: any delegate-typed value (named/generic CLR delegate
            // such as Func[string]) widens to System.Delegate /
            // System.MulticastDelegate as a no-op reference upcast.
            if (b?.ClrType != null && IsSystemDelegateHostType(b.ClrType)
                && a?.ClrType != null && ClrTypeUtilities.IsDelegateType(a.ClrType))
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

        private void EmitUnary(BoundUnaryExpression u)
        {
            // Phase 3.C.3: `!!` is a runtime null-assertion. Emit a check
            // ahead of the operand load so we don't accidentally take a
            // dependency on stack tracking inside the operand.
            if (u.Op.Kind == BoundUnaryOperatorKind.NullAssertion)
            {
                this.EmitExpression(u.Operand);
                this.il.OpCode(ILOpCode.Dup);
                var nonNull = this.il.DefineLabel();
                this.il.Branch(ILOpCode.Brtrue, nonNull);
                this.il.OpCode(ILOpCode.Pop);
                var nreCtor = this.outer.GetNullReferenceExceptionCtorRef();
                this.il.OpCode(ILOpCode.Newobj);
                this.il.Token(nreCtor);
                this.il.OpCode(ILOpCode.Throw);
                this.il.MarkLabel(nonNull);
                return;
            }

            this.EmitExpression(u.Operand);
            switch (u.Op.Kind)
            {
                case BoundUnaryOperatorKind.Identity:
                    break;
                case BoundUnaryOperatorKind.Negation:
                    if (u.Op.OperandType == TypeSymbol.Decimal)
                    {
                        var neg = typeof(decimal).GetMethod("op_UnaryNegation", new[] { typeof(decimal) });
                        this.il.Call(this.outer.GetMethodEntityHandle(neg));
                    }
                    else
                    {
                        this.il.OpCode(ILOpCode.Neg);
                    }

                    break;
                case BoundUnaryOperatorKind.LogicalNegation:
                    this.il.LoadConstantI4(0);
                    this.il.OpCode(ILOpCode.Ceq);
                    break;
                case BoundUnaryOperatorKind.OnesComplement:
                    this.il.OpCode(ILOpCode.Not);
                    break;
                default:
                    throw new NotSupportedException(
                        $"Unary operator '{u.Op.Kind}' is not yet supported by the emitter.");
            }

            if (u.Op.Kind == BoundUnaryOperatorKind.OnesComplement
                || u.Op.Kind == BoundUnaryOperatorKind.Negation)
            {
                var t = u.Op.Type;
                if (t == TypeSymbol.Int8)
                {
                    this.il.OpCode(ILOpCode.Conv_i1);
                }
                else if (t == TypeSymbol.UInt8)
                {
                    this.il.OpCode(ILOpCode.Conv_u1);
                }
                else if (t == TypeSymbol.Int16)
                {
                    this.il.OpCode(ILOpCode.Conv_i2);
                }
                else if (t == TypeSymbol.UInt16 || t == TypeSymbol.Char)
                {
                    this.il.OpCode(ILOpCode.Conv_u2);
                }
            }
        }

        private void EmitBinary(BoundBinaryExpression b)
        {
            // Phase 3.C.3: `?:` (NullCoalesce). Short-circuit on the left.
            if (b.Op.Kind == BoundBinaryOperatorKind.NullCoalesce)
            {
                // P3-5 / Issue #420: `dup; brtrue` is only legal for object
                // references and primitive integers — it is invalid IL for
                // struct stack values. If the left operand's stack type is a
                // value type (raw struct/enum, or `Nullable<T>` over a value
                // type), this short-circuit pattern emits invalid IL the
                // moment the binder/encoder lets such expressions through.
                //
                // Today the encoder rejects nullable user-defined structs/
                // enums (see EncodeTypeSymbol), so the only reachable risky
                // case is `Nullable<primitive>` (e.g. `int? ?? 5`). When
                // nullable value types are wired up end-to-end the correct
                // strategy is to spill the left to a local and emit a
                // `call Nullable<T>::get_HasValue` / `call get_ValueOrDefault`
                // pair, or to box before the brtrue. Until that is in place,
                // fail fast with a clear diagnostic instead of producing
                // PEVerify-rejected IL.
                var leftType = b.Left.Type;
                if (IsValueTypeSymbol(leftType))
                {
                    var assertMsg = "Null-coalesce `??` emit uses `dup; brtrue` which is illegal IL for value-type stack values "
                        + "(struct, enum, or Nullable<valueType>). This path needs a HasValue/ValueOrDefault "
                        + "(or box-before-brtrue) strategy when nullable value types are wired up end-to-end. "
                        + $"Left operand type was '{leftType?.Name}'.";
                    System.Diagnostics.Debug.Assert(false, assertMsg);
                    throw new NotSupportedException(
                        $"Null-coalesce '??' over value-type operand '{leftType?.Name}' is not yet supported by the emitter. "
                        + "The current `dup; brtrue` short-circuit is invalid IL for struct stack values; a HasValue/ValueOrDefault "
                        + "(or box-before-brtrue) emit path is required when nullable value types are supported.");
                }

                this.EmitExpression(b.Left);
                this.il.OpCode(ILOpCode.Dup);
                var done = this.il.DefineLabel();
                this.il.Branch(ILOpCode.Brtrue, done);
                this.il.OpCode(ILOpCode.Pop);
                this.EmitExpression(b.Right);
                this.il.MarkLabel(done);
                return;
            }

            // String concatenation / equality go through BCL helpers.
            if (b.Left.Type == TypeSymbol.String && b.Right.Type == TypeSymbol.String)
            {
                switch (b.Op.Kind)
                {
                    case BoundBinaryOperatorKind.Sum:
                        this.EmitExpression(b.Left);
                        this.EmitExpression(b.Right);
                        this.il.Call(this.outer.GetStringConcatReference());
                        return;
                    case BoundBinaryOperatorKind.Equals:
                        this.EmitExpression(b.Left);
                        this.EmitExpression(b.Right);
                        this.il.Call(this.outer.GetStringEqualsReference());
                        return;
                    case BoundBinaryOperatorKind.NotEquals:
                        this.EmitExpression(b.Left);
                        this.EmitExpression(b.Right);
                        this.il.Call(this.outer.GetStringEqualsReference());
                        this.il.LoadConstantI4(0);
                        this.il.OpCode(ILOpCode.Ceq);
                        return;
                }
            }

            // Phase 7.4 / ADR-0033: inline structs compare their single field directly.
            if (b.Left.Type is StructSymbol inlineStruct && inlineStruct.IsInline && b.Right.Type == inlineStruct &&
                (b.Op.Kind == BoundBinaryOperatorKind.Equals || b.Op.Kind == BoundBinaryOperatorKind.NotEquals))
            {
                var field = inlineStruct.Fields[0];
                var fieldHandle = this.outer.structFieldDefs[field];
                this.EmitExpression(b.Left);
                this.il.OpCode(ILOpCode.Ldfld);
                this.il.Token(fieldHandle);
                if (IsValueTypeSymbol(field.Type))
                {
                    this.il.OpCode(ILOpCode.Box);
                    this.il.Token(this.outer.GetElementTypeToken(field.Type));
                }

                this.EmitExpression(b.Right);
                this.il.OpCode(ILOpCode.Ldfld);
                this.il.Token(fieldHandle);
                if (IsValueTypeSymbol(field.Type))
                {
                    this.il.OpCode(ILOpCode.Box);
                    this.il.Token(this.outer.GetElementTypeToken(field.Type));
                }

                this.il.Call(field.Type == TypeSymbol.String ? this.outer.GetStringEqualsReference() : this.outer.GetObjectStaticEqualsReference());
                if (b.Op.Kind == BoundBinaryOperatorKind.NotEquals)
                {
                    this.il.LoadConstantI4(0);
                    this.il.OpCode(ILOpCode.Ceq);
                }

                return;
            }

            // Phase 3.B.2 / ADR-0029: structural == / != on data-struct
            // values. Box both operands and dispatch through static
            // Object.Equals(object, object) which routes through the
            // virtual ValueType.Equals override.
            if (b.Left.Type is StructSymbol ds && ds.IsData && b.Right.Type == ds &&
                (b.Op.Kind == BoundBinaryOperatorKind.Equals || b.Op.Kind == BoundBinaryOperatorKind.NotEquals))
            {
                var structTypeDef = this.outer.structTypeDefs[ds];
                this.EmitExpression(b.Left);
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(structTypeDef);
                this.EmitExpression(b.Right);
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(structTypeDef);
                this.il.Call(this.outer.GetObjectStaticEqualsReference());
                if (b.Op.Kind == BoundBinaryOperatorKind.NotEquals)
                {
                    this.il.LoadConstantI4(0);
                    this.il.OpCode(ILOpCode.Ceq);
                }

                return;
            }

            // Phase 4 emit parity (F1, type-erased generics): `==` / `!=` over
            // open type parameters (e.g. `a == b` in `Eq[T comparable]`). Both
            // operands are erased to System.Object, so a raw `Ceq` would test
            // reference equality and return false for equal boxed value types.
            // Dispatch through static Object.Equals(object, object) — which
            // routes to the boxed value's Equals override — for correct value
            // semantics. Operands already sit on the stack as boxed objects.
            if (b.Left.Type is TypeParameterSymbol && b.Right.Type is TypeParameterSymbol &&
                (b.Op.Kind == BoundBinaryOperatorKind.Equals || b.Op.Kind == BoundBinaryOperatorKind.NotEquals))
            {
                this.EmitExpression(b.Left);
                this.EmitExpression(b.Right);
                this.il.Call(this.outer.GetObjectStaticEqualsReference());
                if (b.Op.Kind == BoundBinaryOperatorKind.NotEquals)
                {
                    this.il.LoadConstantI4(0);
                    this.il.OpCode(ILOpCode.Ceq);
                }

                return;
            }

            // Short-circuit evaluation for logical `&&` and `||`: the right
            // operand must not be evaluated when the left operand already
            // determines the result. Emit a dup + conditional branch so the
            // LHS value is reused as the result without evaluating the RHS.
            if (b.Op.Kind == BoundBinaryOperatorKind.LogicalAnd ||
                b.Op.Kind == BoundBinaryOperatorKind.LogicalOr)
            {
                var endLabel = this.il.DefineLabel();
                this.EmitExpression(b.Left);
                this.il.OpCode(ILOpCode.Dup);
                this.il.Branch(
                    b.Op.Kind == BoundBinaryOperatorKind.LogicalAnd ? ILOpCode.Brfalse : ILOpCode.Brtrue,
                    endLabel);
                this.il.OpCode(ILOpCode.Pop);
                this.EmitExpression(b.Right);
                this.il.MarkLabel(endLabel);
                return;
            }

            this.EmitExpression(b.Left);
            this.EmitExpression(b.Right);
            if (b.Left.Type == TypeSymbol.Decimal && b.Right.Type == TypeSymbol.Decimal)
            {
                if (this.TryEmitDecimalBinary(b.Op.Kind))
                {
                    return;
                }
            }

            bool isUnsigned = IsUnsignedOrChar(b.Left.Type);
            switch (b.Op.Kind)
            {
                case BoundBinaryOperatorKind.Sum:
                    this.il.OpCode(ILOpCode.Add);
                    break;
                case BoundBinaryOperatorKind.Difference:
                    this.il.OpCode(ILOpCode.Sub);
                    break;
                case BoundBinaryOperatorKind.Product:
                    this.il.OpCode(ILOpCode.Mul);
                    break;
                case BoundBinaryOperatorKind.Quotient:
                    this.il.OpCode(isUnsigned ? ILOpCode.Div_un : ILOpCode.Div);
                    break;
                case BoundBinaryOperatorKind.Remainder:
                    this.il.OpCode(isUnsigned ? ILOpCode.Rem_un : ILOpCode.Rem);
                    break;
                case BoundBinaryOperatorKind.ShiftLeft:
                    this.EmitShiftWithGoSemanticsGuard(ILOpCode.Shl, b.Left.Type);
                    break;
                case BoundBinaryOperatorKind.ShiftRight:
                    this.EmitShiftWithGoSemanticsGuard(
                        isUnsigned ? ILOpCode.Shr_un : ILOpCode.Shr,
                        b.Left.Type);
                    break;
                case BoundBinaryOperatorKind.BitwiseAnd:
                    this.il.OpCode(ILOpCode.And);
                    break;
                case BoundBinaryOperatorKind.BitwiseOr:
                    this.il.OpCode(ILOpCode.Or);
                    break;
                case BoundBinaryOperatorKind.BitwiseXor:
                    this.il.OpCode(ILOpCode.Xor);
                    break;
                case BoundBinaryOperatorKind.BitClear:
                    // Go's a &^ b == a & ~b. Right operand is already on top: not, then and.
                    this.il.OpCode(ILOpCode.Not);
                    this.il.OpCode(ILOpCode.And);
                    break;
                case BoundBinaryOperatorKind.Equals:
                    this.il.OpCode(ILOpCode.Ceq);
                    break;
                case BoundBinaryOperatorKind.NotEquals:
                    this.il.OpCode(ILOpCode.Ceq);
                    this.il.LoadConstantI4(0);
                    this.il.OpCode(ILOpCode.Ceq);
                    break;
                case BoundBinaryOperatorKind.Less:
                    this.il.OpCode(isUnsigned ? ILOpCode.Clt_un : ILOpCode.Clt);
                    break;
                case BoundBinaryOperatorKind.LessOrEquals:
                    this.il.OpCode(isUnsigned ? ILOpCode.Cgt_un : ILOpCode.Cgt);
                    this.il.LoadConstantI4(0);
                    this.il.OpCode(ILOpCode.Ceq);
                    break;
                case BoundBinaryOperatorKind.Greater:
                    this.il.OpCode(isUnsigned ? ILOpCode.Cgt_un : ILOpCode.Cgt);
                    break;
                case BoundBinaryOperatorKind.GreaterOrEquals:
                    this.il.OpCode(isUnsigned ? ILOpCode.Clt_un : ILOpCode.Clt);
                    this.il.LoadConstantI4(0);
                    this.il.OpCode(ILOpCode.Ceq);
                    break;
                default:
                    throw new NotSupportedException(
                        $"Binary operator '{b.Op.Kind}' is not yet supported by the emitter.");
            }

            EmitNarrowingTruncationIfNeeded(b.Op.Kind, b.Type);
        }

        private void EmitNarrowingTruncationIfNeeded(BoundBinaryOperatorKind kind, TypeSymbol resultType)
        {
            // IL evaluation-stack quirk: arithmetic, bitwise, and shift
            // opcodes on sub-i4 operands produce an i4 result that is not
            // truncated to the operand's natural width. For correctness of
            // sbyte/byte/short/ushort/char result types, narrow back.
            switch (kind)
            {
                case BoundBinaryOperatorKind.Sum:
                case BoundBinaryOperatorKind.Difference:
                case BoundBinaryOperatorKind.Product:
                case BoundBinaryOperatorKind.Quotient:
                case BoundBinaryOperatorKind.Remainder:
                case BoundBinaryOperatorKind.ShiftLeft:
                case BoundBinaryOperatorKind.ShiftRight:
                case BoundBinaryOperatorKind.BitwiseAnd:
                case BoundBinaryOperatorKind.BitwiseOr:
                case BoundBinaryOperatorKind.BitwiseXor:
                case BoundBinaryOperatorKind.BitClear:
                    if (resultType == TypeSymbol.Int8)
                    {
                        this.il.OpCode(ILOpCode.Conv_i1);
                    }
                    else if (resultType == TypeSymbol.UInt8)
                    {
                        this.il.OpCode(ILOpCode.Conv_u1);
                    }
                    else if (resultType == TypeSymbol.Int16)
                    {
                        this.il.OpCode(ILOpCode.Conv_i2);
                    }
                    else if (resultType == TypeSymbol.UInt16 || resultType == TypeSymbol.Char)
                    {
                        this.il.OpCode(ILOpCode.Conv_u2);
                    }

                    break;
            }
        }

        private static bool IsUnsignedOrChar(TypeSymbol t)
        {
            return t == TypeSymbol.UInt8
                || t == TypeSymbol.UInt16
                || t == TypeSymbol.UInt32
                || t == TypeSymbol.UInt64
                || t == TypeSymbol.NUInt
                || t == TypeSymbol.Char;
        }

        // Issue #421 (P2-2): IL `shl`/`shr`/`shr_un` mask the shift count to
        // the low log2(stack-width) bits (5 for i4, 6 for i8). G# follows Go
        // semantics, where a shift count >= the operand's natural width
        // yields zero. Without this guard, `int32(1) << 33` would produce 2
        // under the CLR mask but should produce 0 in Go. Emit a runtime
        // check `count >= width` and substitute zero when the count is
        // out-of-range; otherwise emit the normal shift opcode.
        //
        // Stack on entry: [value, count(i4)]; stack on exit: [result].
        // For signed right shift this simplification (zero instead of
        // sign-extension to all-ones for negative values) matches the
        // documented G# behavior — interpreter and emitter agree on it.
        private void EmitShiftWithGoSemanticsGuard(ILOpCode shiftOp, TypeSymbol leftType)
        {
            var zeroLabel = this.il.DefineLabel();
            var endLabel = this.il.DefineLabel();

            this.il.OpCode(ILOpCode.Dup);
            this.EmitTypeBitWidth(leftType);
            this.il.Branch(ILOpCode.Bge_un, zeroLabel);
            this.il.OpCode(shiftOp);
            this.il.Branch(ILOpCode.Br, endLabel);

            this.il.MarkLabel(zeroLabel);
            this.il.OpCode(ILOpCode.Pop);
            this.il.OpCode(ILOpCode.Pop);
            this.EmitZeroForShiftResult(leftType);

            this.il.MarkLabel(endLabel);
        }

        private void EmitTypeBitWidth(TypeSymbol t)
        {
            if (t == TypeSymbol.Int8 || t == TypeSymbol.UInt8)
            {
                this.il.LoadConstantI4(8);
            }
            else if (t == TypeSymbol.Int16 || t == TypeSymbol.UInt16 || t == TypeSymbol.Char)
            {
                this.il.LoadConstantI4(16);
            }
            else if (t == TypeSymbol.Int32 || t == TypeSymbol.UInt32)
            {
                this.il.LoadConstantI4(32);
            }
            else if (t == TypeSymbol.Int64 || t == TypeSymbol.UInt64)
            {
                this.il.LoadConstantI4(64);
            }
            else if (t == TypeSymbol.NInt || t == TypeSymbol.NUInt)
            {
                // Width is sizeof(IntPtr) * 8, determined at IL runtime so
                // 32-bit and 64-bit hosts both produce Go-correct results.
                this.il.OpCode(ILOpCode.Sizeof);
                this.il.Token(this.outer.GetTypeReference(typeof(IntPtr)));
                this.il.LoadConstantI4(8);
                this.il.OpCode(ILOpCode.Mul);
            }
            else
            {
                // Fallback (shouldn't reach here for non-integer types since
                // shifts are only bound on integer operands).
                this.il.LoadConstantI4(32);
            }
        }

        private void EmitZeroForShiftResult(TypeSymbol t)
        {
            if (t == TypeSymbol.Int64 || t == TypeSymbol.UInt64)
            {
                this.il.LoadConstantI8(0);
            }
            else if (t == TypeSymbol.NInt || t == TypeSymbol.NUInt)
            {
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Conv_i);
            }
            else
            {
                this.il.LoadConstantI4(0);
            }
        }

        private bool TryEmitDecimalBinary(BoundBinaryOperatorKind kind)
        {
            string opName = kind switch
            {
                BoundBinaryOperatorKind.Sum => "op_Addition",
                BoundBinaryOperatorKind.Difference => "op_Subtraction",
                BoundBinaryOperatorKind.Product => "op_Multiply",
                BoundBinaryOperatorKind.Quotient => "op_Division",
                BoundBinaryOperatorKind.Remainder => "op_Modulus",
                BoundBinaryOperatorKind.Equals => "op_Equality",
                BoundBinaryOperatorKind.NotEquals => "op_Inequality",
                BoundBinaryOperatorKind.Less => "op_LessThan",
                BoundBinaryOperatorKind.LessOrEquals => "op_LessThanOrEqual",
                BoundBinaryOperatorKind.Greater => "op_GreaterThan",
                BoundBinaryOperatorKind.GreaterOrEquals => "op_GreaterThanOrEqual",
                _ => null,
            };
            if (opName == null)
            {
                return false;
            }

            var op = typeof(decimal).GetMethod(opName, new[] { typeof(decimal), typeof(decimal) });
            if (op == null)
            {
                return false;
            }

            this.il.Call(this.outer.GetMethodEntityHandle(op));
            return true;
        }

        private void EmitLoadVariable(VariableSymbol variable)
        {
            // Issue #216: const bindings have no IL slot — inline the literal value.
            if (this.constValues != null && this.constValues.TryGetValue(variable, out var cv))
            {
                this.EmitLiteral(new BoundLiteralExpression(null, cv, variable.Type));
                return;
            }

            if (variable is ParameterSymbol ps && this.parameters.TryGetValue(ps, out var argIndex))
            {
                this.il.LoadArgument(argIndex);
                return;
            }

            if (this.locals.TryGetValue(variable, out var slot))
            {
                this.il.LoadLocal(slot);
                return;
            }

            // Issue #191: top-level globals were emitted as static fields on
            // <Program>; load via ldsfld so cross-method access (and reads
            // from other assemblies) share storage.
            if (variable is GlobalVariableSymbol gv
                && this.outer.globalFieldDefs.TryGetValue(gv, out var fieldHandle))
            {
                this.il.OpCode(ILOpCode.Ldsfld);
                this.il.Token(fieldHandle);
                return;
            }

            throw new InvalidOperationException(
                $"Variable '{variable.Name}' has no local slot or parameter index in the current method.");
        }

        private bool HasStorageSlot(VariableSymbol variable)
        {
            if (variable is ParameterSymbol ps && this.parameters.ContainsKey(ps))
            {
                return true;
            }

            if (this.locals.ContainsKey(variable))
            {
                return true;
            }

            if (variable is GlobalVariableSymbol gv
                && this.outer.globalFieldDefs.ContainsKey(gv))
            {
                return true;
            }

            return false;
        }

        private void EmitStoreVariable(VariableSymbol variable)
        {
            if (variable is ParameterSymbol ps && this.parameters.TryGetValue(ps, out var argIndex))
            {
                this.il.StoreArgument(argIndex);
                return;
            }

            if (this.locals.TryGetValue(variable, out var slot))
            {
                this.il.StoreLocal(slot);
                return;
            }

            // Issue #191: top-level globals store via stsfld into their backing
            // <Program> static field (initialized in declaration order from
            // the entry-point method body).
            if (variable is GlobalVariableSymbol gv
                && this.outer.globalFieldDefs.TryGetValue(gv, out var fieldHandle))
            {
                this.il.OpCode(ILOpCode.Stsfld);
                this.il.Token(fieldHandle);
                return;
            }

            throw new InvalidOperationException(
                $"Variable '{variable.Name}' has no local slot or parameter index in the current method.");
        }

        private void EmitLiteral(BoundLiteralExpression literal)
        {
            // Phase 3.C.2 / ADR-0001: the nil literal is modeled as a null
            // BoundLiteralExpression.Value; on reference-type or nullable
            // targets it emits as ldnull.
            if (literal.Value is null)
            {
                this.il.OpCode(ILOpCode.Ldnull);
                return;
            }

            switch (literal.Value)
            {
                case string s:
                    this.il.LoadString(this.outer.metadata.GetOrAddUserString(s));
                    break;
                case bool b:
                    this.il.LoadConstantI4(b ? 1 : 0);
                    break;
                case sbyte sb:
                    this.il.LoadConstantI4(sb);
                    break;
                case byte by:
                    this.il.LoadConstantI4(by);
                    break;
                case short sh:
                    this.il.LoadConstantI4(sh);
                    break;
                case ushort us:
                    this.il.LoadConstantI4(us);
                    break;
                case char ch:
                    this.il.LoadConstantI4(ch);
                    break;
                case int i:
                    this.il.LoadConstantI4(i);
                    break;
                case uint ui:
                    this.il.LoadConstantI4(unchecked((int)ui));
                    break;
                case long lng:
                    this.il.LoadConstantI8(lng);
                    break;
                case ulong ul:
                    this.il.LoadConstantI8(unchecked((long)ul));
                    break;
                case nint ni:
                    this.il.LoadConstantI8(ni);
                    this.il.OpCode(ILOpCode.Conv_i);
                    break;
                case nuint nu:
                    this.il.LoadConstantI8(unchecked((long)(ulong)nu));
                    this.il.OpCode(ILOpCode.Conv_u);
                    break;
                case float f:
                    this.il.LoadConstantR4(f);
                    break;
                case double d:
                    this.il.LoadConstantR8(d);
                    break;
                case decimal m:
                    this.EmitDecimalLiteral(m);
                    break;
                default:
                    throw new NotSupportedException(
                        $"Literal of CLR type '{literal.Value?.GetType()}' is not yet supported.");
            }
        }

        // ADR-0044 decimal literal lowering. IL has no `ldc.decimal`, so each
        // literal is materialised by calling the
        // `Decimal(int, int, int, bool, byte)` ctor with the bit pattern
        // returned by `decimal.GetBits`. Common small values (0, 1, -1) and
        // any value that fits in `int` use the cheaper one-int ctors.
        private void EmitDecimalLiteral(decimal value)
        {
            if (value == decimal.Zero)
            {
                this.EmitDecimalStaticField(nameof(decimal.Zero));
                return;
            }

            if (value == decimal.One)
            {
                this.EmitDecimalStaticField(nameof(decimal.One));
                return;
            }

            if (value == decimal.MinusOne)
            {
                this.EmitDecimalStaticField(nameof(decimal.MinusOne));
                return;
            }

            // Try int ctor for small whole values.
            if (decimal.Truncate(value) == value && value >= int.MinValue && value <= int.MaxValue)
            {
                var asInt = (int)value;
                this.il.LoadConstantI4(asInt);
                var ctor = typeof(decimal).GetConstructor(new[] { typeof(int) });
                this.il.OpCode(ILOpCode.Newobj);
                this.il.Token(this.outer.GetCtorReference(ctor));
                return;
            }

            // Try long ctor.
            if (decimal.Truncate(value) == value && value >= long.MinValue && value <= long.MaxValue)
            {
                var asLong = (long)value;
                this.il.LoadConstantI8(asLong);
                var ctor = typeof(decimal).GetConstructor(new[] { typeof(long) });
                this.il.OpCode(ILOpCode.Newobj);
                this.il.Token(this.outer.GetCtorReference(ctor));
                return;
            }

            // General case: Decimal(int lo, int mid, int hi, bool isNegative, byte scale).
            var bits = decimal.GetBits(value);
            var lo = bits[0];
            var mid = bits[1];
            var hi = bits[2];
            var flags = bits[3];
            var isNegative = (flags & unchecked((int)0x80000000)) != 0;
            var scale = (byte)((flags >> 16) & 0x7F);

            this.il.LoadConstantI4(lo);
            this.il.LoadConstantI4(mid);
            this.il.LoadConstantI4(hi);
            this.il.LoadConstantI4(isNegative ? 1 : 0);
            this.il.LoadConstantI4(scale);

            var bigCtor = typeof(decimal).GetConstructor(new[]
            {
                typeof(int), typeof(int), typeof(int), typeof(bool), typeof(byte),
            });
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(bigCtor));
        }

        private void EmitDecimalStaticField(string name)
        {
            var field = typeof(decimal).GetField(name);
            this.il.OpCode(ILOpCode.Ldsfld);
            this.il.Token(this.outer.GetFieldReference(field));
        }

        private void EmitDefault(BoundDefaultExpression node)
        {
            var type = node.Type;

            // Reference types: ldnull
            if (!IsValueTypeSymbol(type))
            {
                this.il.OpCode(ILOpCode.Ldnull);
                return;
            }

            // Primitive value types: push zero constant
            if (type == TypeSymbol.Int32 || type == TypeSymbol.Bool)
            {
                this.il.LoadConstantI4(0);
                return;
            }

            // Arbitrary value type: ldloca temp; initobj T; ldloc temp
            if (!this.defaultExpressionSlots.TryGetValue(node, out var slot))
            {
                throw new InvalidOperationException(
                    $"BoundDefaultExpression of value type '{type.Name}' has no preallocated temp slot.");
            }

            this.il.LoadLocalAddress(slot);
            this.il.OpCode(ILOpCode.Initobj);
            this.il.Token(this.outer.GetElementTypeToken(type));
            this.il.LoadLocal(slot);
        }

        private void EmitArrayCreation(BoundArrayCreationExpression arr)
        {
            this.il.LoadConstantI4(arr.Elements.Length);
            this.il.OpCode(ILOpCode.Newarr);
            this.il.Token(this.outer.GetElementTypeToken(arr.ElementType));

            for (var i = 0; i < arr.Elements.Length; i++)
            {
                this.il.OpCode(ILOpCode.Dup);
                this.il.LoadConstantI4(i);
                this.EmitExpression(arr.Elements[i]);
                this.EmitStoreElement(arr.ElementType);
            }
        }

        private void EmitLoadElement(TypeSymbol elementType)
        {
            if (elementType == TypeSymbol.Int32)
            {
                this.il.OpCode(ILOpCode.Ldelem_i4);
            }
            else if (elementType == TypeSymbol.Bool)
            {
                this.il.OpCode(ILOpCode.Ldelem_u1);
            }
            else if (elementType == TypeSymbol.String)
            {
                this.il.OpCode(ILOpCode.Ldelem_ref);
            }
            else
            {
                this.il.OpCode(ILOpCode.Ldelem);
                this.il.Token(this.outer.GetElementTypeToken(elementType));
            }
        }

        private void EmitStoreElement(TypeSymbol elementType)
        {
            if (elementType == TypeSymbol.Int32)
            {
                this.il.OpCode(ILOpCode.Stelem_i4);
            }
            else if (elementType == TypeSymbol.Bool)
            {
                this.il.OpCode(ILOpCode.Stelem_i1);
            }
            else if (elementType == TypeSymbol.String)
            {
                this.il.OpCode(ILOpCode.Stelem_ref);
            }
            else
            {
                this.il.OpCode(ILOpCode.Stelem);
                this.il.Token(this.outer.GetElementTypeToken(elementType));
            }
        }

        private void EmitTryStatement(BoundTryStatement node)
        {
            var endLabel = this.il.DefineLabel();
            var hasCatches = node.CatchClauses.Length > 0;
            var hasFinally = node.FinallyBlock != null;

            if (hasCatches && hasFinally)
            {
                // Nested: outer try-finally wrapping inner try-catch.
                var outerTryStart = this.il.DefineLabel();
                var innerTryStart = this.il.DefineLabel();
                var finallyStart = this.il.DefineLabel();
                var finallyEnd = this.il.DefineLabel();

                this.il.MarkLabel(outerTryStart);
                this.il.MarkLabel(innerTryStart);
                this.EmitProtectedRegion((BoundBlockStatement)node.TryBlock);
                var innerTryEnd = this.il.DefineLabel();
                this.il.Branch(ILOpCode.Leave, endLabel);
                this.il.MarkLabel(innerTryEnd);

                this.EmitCatchClauses(node.CatchClauses, innerTryStart, innerTryEnd, leaveTarget: endLabel);

                this.il.MarkLabel(finallyStart);
                this.EmitProtectedRegion((BoundBlockStatement)node.FinallyBlock);
                this.il.OpCode(ILOpCode.Endfinally);
                this.il.MarkLabel(finallyEnd);

                this.il.ControlFlowBuilder.AddFinallyRegion(outerTryStart, finallyStart, finallyStart, finallyEnd);
            }
            else if (hasCatches)
            {
                var tryStart = this.il.DefineLabel();
                this.il.MarkLabel(tryStart);
                this.EmitProtectedRegion((BoundBlockStatement)node.TryBlock);
                var tryEnd = this.il.DefineLabel();
                this.il.Branch(ILOpCode.Leave, endLabel);
                this.il.MarkLabel(tryEnd);

                this.EmitCatchClauses(node.CatchClauses, tryStart, tryEnd, leaveTarget: endLabel);
            }
            else
            {
                // finally only
                var tryStart = this.il.DefineLabel();
                var finallyStart = this.il.DefineLabel();
                var finallyEnd = this.il.DefineLabel();

                this.il.MarkLabel(tryStart);
                this.EmitProtectedRegion((BoundBlockStatement)node.TryBlock);
                this.il.Branch(ILOpCode.Leave, finallyEnd);

                this.il.MarkLabel(finallyStart);
                this.EmitProtectedRegion((BoundBlockStatement)node.FinallyBlock);
                this.il.OpCode(ILOpCode.Endfinally);
                this.il.MarkLabel(finallyEnd);

                this.il.ControlFlowBuilder.AddFinallyRegion(tryStart, finallyStart, finallyStart, finallyEnd);
            }

            this.il.MarkLabel(endLabel);
        }

        private void EmitCatchClauses(
            ImmutableArray<BoundCatchClause> clauses,
            LabelHandle tryStart,
            LabelHandle tryEnd,
            LabelHandle leaveTarget)
        {
            foreach (var clause in clauses)
            {
                var handlerStart = this.il.DefineLabel();
                var handlerEnd = this.il.DefineLabel();

                this.il.MarkLabel(handlerStart);

                // Stack contains the caught exception; store into the catch variable.
                // Issue #420 (P3-6): the binder is currently expected to always
                // provide a catch variable with an allocated slot, but if a future
                // binder pass elides an unused catch variable (or leaves it without
                // a slot) we still need to consume the exception object the CLR
                // pushed onto the evaluation stack on entry to the handler --
                // otherwise the handler starts with an unbalanced stack and the
                // generated IL becomes unverifiable. Defensively emit `pop` in
                // that case instead of dereferencing a null variable.
                if (clause.Variable is null || !this.HasStorageSlot(clause.Variable))
                {
                    this.il.OpCode(ILOpCode.Pop);
                }
                else
                {
                    this.EmitStoreVariable(clause.Variable);
                }

                this.EmitProtectedRegion((BoundBlockStatement)clause.Body);
                this.il.Branch(ILOpCode.Leave, leaveTarget);
                this.il.MarkLabel(handlerEnd);

                // Issue #421 (P2-6): user-defined exception classes have ClrType == null
                // at emit time, so fall back to the emitter's user-defined type registry
                // via GetElementTypeToken (which handles both CLR-backed and source-defined
                // types) instead of dereferencing ClrType directly.
                var catchTypeHandle = this.outer.GetElementTypeToken(clause.ExceptionType);
                this.il.ControlFlowBuilder.AddCatchRegion(tryStart, tryEnd, handlerStart, handlerEnd, catchTypeHandle);
            }
        }

        // Emits a block as a protected region: pushes the lexical label set so
        // gotos targeting labels outside the region are translated to `leave`.
        private void EmitProtectedRegion(BoundBlockStatement block)
        {
            var labelSet = new HashSet<BoundLabel>();
            CollectLabels(block, labelSet);
            this.protectedRegionStack.Push(labelSet);
            try
            {
                this.EmitBlock(block);
            }
            finally
            {
                this.protectedRegionStack.Pop();
            }
        }

        private static void CollectLabels(BoundStatement statement, HashSet<BoundLabel> sink)
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
                        CollectLabels(s, sink);
                    }

                    return;
                case BoundTryStatement t:
                    CollectLabels(t.TryBlock, sink);
                    foreach (var c in t.CatchClauses)
                    {
                        CollectLabels(c.Body, sink);
                    }

                    if (t.FinallyBlock != null)
                    {
                        CollectLabels(t.FinallyBlock, sink);
                    }

                    return;
                case BoundScopeStatement sc:
                    CollectLabels(sc.Body, sink);
                    return;
                case BoundExpressionStatement es:
                    CollectLabelsInExpression(es.Expression, sink);
                    return;
                case BoundConditionalGotoStatement cg:
                    CollectLabelsInExpression(cg.Condition, sink);
                    return;
                case BoundReturnStatement rs:
                    CollectLabelsInExpression(rs.Expression, sink);
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
                    var stmtWalker = new ExpressionBlockLabelCollector(sink);
                    stmtWalker.RewriteStatement(statement);
                    return;
            }
        }

        // Recursively collects BoundLabelStatement labels that live inside a
        // BoundExpression sub-tree. This is the inverse-side of CollectLabels
        // for expression-position blocks (BoundBlockExpression et al.).
        private static void CollectLabelsInExpression(BoundExpression expression, HashSet<BoundLabel> sink)
        {
            if (expression == null)
            {
                return;
            }

            var walker = new ExpressionBlockLabelCollector(sink);
            walker.Visit(expression);
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

        private void EmitLen(BoundLenExpression len)
        {
            this.EmitExpression(len.Operand);
            if (len.Operand.Type == TypeSymbol.String)
            {
                this.il.Call(this.outer.GetStringLengthReference());
            }
            else if (len.Operand.Type is MapTypeSymbol mapType)
            {
                // Phase 3.A.4 emit: `len(m)` -> `callvirt Dictionary<K,V>.get_Count`.
                var dictType = mapType.ClrType;
                var getCount = dictType.GetMethod("get_Count")
                    ?? throw new InvalidOperationException(
                        $"Dictionary type '{dictType.FullName}' has no get_Count method.");
                this.il.OpCode(ILOpCode.Callvirt);
                this.il.Token(this.outer.GetMethodReference(getCount));
            }
            else
            {
                this.il.OpCode(ILOpCode.Ldlen);
                this.il.OpCode(ILOpCode.Conv_i4);
            }
        }

        private void EmitTypeOf(BoundTypeOfExpression typeOf)
        {
            // Issue #143: `typeof(T)` -> ldtoken <T> ; call Type::GetTypeFromHandle.
            this.il.OpCode(ILOpCode.Ldtoken);
            this.il.Token(this.outer.GetTypeOfToken(typeOf.OperandType));
            this.il.Call(this.outer.GetTypeFromHandleReference());
        }

        private void EmitAppend(BoundAppendExpression app)
        {
            // Issue #418 (P1-3): name the bound-node context in the message
            // when a slot is missing so a regression in a pre-pass walker
            // surfaces an actionable error instead of a generic KeyNotFound.
            if (!this.appendSlots.TryGetValue(app, out var slots))
            {
                throw new InvalidOperationException(
                    $"Append expression for slice type '{app.SliceType?.Name}' has no preallocated slot. "
                    + "A walker pre-pass failed to descend into the parent bound-node kind.");
            }

            var element = app.SliceType.ElementType;
            var elementToken = this.outer.GetElementTypeToken(element);

            // src = slice
            this.EmitExpression(app.Slice);
            this.il.StoreLocal(slots.Src);

            // dst = new T[src.Length + 1]
            this.il.LoadLocal(slots.Src);
            this.il.OpCode(ILOpCode.Ldlen);
            this.il.OpCode(ILOpCode.Conv_i4);
            this.il.LoadConstantI4(1);
            this.il.OpCode(ILOpCode.Add);
            this.il.OpCode(ILOpCode.Newarr);
            this.il.Token(elementToken);
            this.il.StoreLocal(slots.Dst);

            // Array.Copy(src, dst, src.Length)
            this.il.LoadLocal(slots.Src);
            this.il.LoadLocal(slots.Dst);
            this.il.LoadLocal(slots.Src);
            this.il.OpCode(ILOpCode.Ldlen);
            this.il.OpCode(ILOpCode.Conv_i4);
            this.il.Call(this.outer.GetArrayCopyReference());

            // dst[src.Length] = element
            this.il.LoadLocal(slots.Dst);
            this.il.LoadLocal(slots.Src);
            this.il.OpCode(ILOpCode.Ldlen);
            this.il.OpCode(ILOpCode.Conv_i4);
            this.EmitExpression(app.Element);
            this.EmitStoreElement(element);

            // Leave dst on stack
            this.il.LoadLocal(slots.Dst);
        }

        private void EmitConstructorCall(BoundConstructorCallExpression call)
        {
            if (!this.outer.classPrimaryCtorHandles.TryGetValue(call.StructType, out var ctorHandle))
            {
                throw new InvalidOperationException(
                    $"Class '{call.StructType.Name}' has no emitted primary ctor.");
            }

            // Phase 4 emit parity (F2, type-erased generic user types): the
            // primary ctor is emitted on the definition with each T-typed
            // parameter encoded as System.Object. When the call site uses
            // a constructed instance, value-type arguments crossing into
            // those parameters must be boxed at the boundary.
            var def = call.StructType.Definition ?? call.StructType;
            var defParams = def.PrimaryConstructorParameters;
            for (int i = 0; i < call.Arguments.Length; i++)
            {
                var arg = call.Arguments[i];
                this.EmitExpression(arg);

                if (i < defParams.Length
                    && defParams[i].Type is TypeParameterSymbol
                    && arg.Type is not TypeParameterSymbol
                    && IsValueTypeSymbol(arg.Type))
                {
                    this.il.OpCode(ILOpCode.Box);
                    this.il.Token(this.outer.GetElementTypeToken(arg.Type));
                }
            }

            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(ctorHandle);
        }

        private void EmitUserInstanceCall(BoundUserInstanceCallExpression call)
        {
            if (!this.outer.methodHandles.TryGetValue(call.Method, out var methodHandle))
            {
                throw new InvalidOperationException(
                    $"Instance method '{call.Method.Name}' on '{call.Method.ReceiverType?.Name}' has no emitted handle.");
            }

            this.EmitInstanceReceiver(call.Receiver);
            var calleeParameterOffset = call.Method.ExplicitReceiverParameter == null ? 0 : 1;
            for (var i = 0; i < call.Arguments.Length; i++)
            {
                var arg = call.Arguments[i];
                this.EmitExpression(arg);

                // Issue #312 (emit parity, type-erased generics): a parameter
                // typed as an open type parameter is encoded as System.Object,
                // so value-type arguments must be boxed at the call boundary to
                // match the emitted signature.
                var paramType = call.Method.Parameters[i + calleeParameterOffset].Type;
                if (paramType is TypeParameterSymbol
                    && arg.Type is not TypeParameterSymbol
                    && IsValueTypeSymbol(arg.Type))
                {
                    this.il.OpCode(ILOpCode.Box);
                    this.il.Token(this.outer.GetElementTypeToken(arg.Type));
                }
            }

            var receiverIsValueType = call.Method.ReceiverType is StructSymbol receiverStruct && !receiverStruct.IsClass;
            this.il.OpCode(receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
            this.il.Token(methodHandle);

            // Issue #312 (emit parity, type-erased generics): a return typed as
            // an open type parameter is encoded as System.Object. When the
            // call's substituted return type is a value type, unbox the result
            // so the rest of the IL sees the expected primitive on the stack.
            if (call.Method.Type is TypeParameterSymbol
                && call.Type is not TypeParameterSymbol
                && IsValueTypeSymbol(call.Type))
            {
                this.il.OpCode(ILOpCode.Unbox_any);
                this.il.Token(this.outer.GetElementTypeToken(call.Type));
            }
        }

        private void EmitMapLiteral(BoundMapLiteralExpression literal)
        {
            // Phase 3.A.4 emit: `map[K]V{k1: v1, ...}` lowers to
            // `newobj Dictionary<K,V>::.ctor()` then a (dup; key; value; callvirt set_Item)
            // sequence per entry. Using set_Item rather than Add so duplicate keys
            // overwrite (matching Go semantics; ParseMapEntries does not dedup).
            var dictType = literal.MapType.ClrType;
            var ctor = dictType.GetConstructor(Type.EmptyTypes)
                ?? throw new InvalidOperationException(
                    $"Dictionary type '{dictType.FullName}' has no parameterless constructor.");
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(ctor));

            if (literal.Entries.Length == 0)
            {
                return;
            }

            var setItem = dictType.GetMethod("set_Item")
                ?? throw new InvalidOperationException(
                    $"Dictionary type '{dictType.FullName}' has no set_Item method.");
            var setItemRef = this.outer.GetMethodReference(setItem);

            foreach (var entry in literal.Entries)
            {
                this.il.OpCode(ILOpCode.Dup);
                this.EmitExpression(entry.Key);
                this.EmitExpression(entry.Value);
                this.il.OpCode(ILOpCode.Callvirt);
                this.il.Token(setItemRef);
            }
        }

        private void EmitMapDelete(BoundMapDeleteExpression del)
        {
            // Phase 3.A.4 emit: `delete(m, k)` lowers to `callvirt Dictionary<K,V>::Remove(K)`
            // and pops the returned bool — `delete` is typed as void.
            var mapType = (MapTypeSymbol)del.Map.Type;
            var dictType = mapType.ClrType;
            var remove = dictType.GetMethod("Remove", new[] { mapType.KeyType.ClrType })
                ?? throw new InvalidOperationException(
                    $"Dictionary type '{dictType.FullName}' has no Remove(K) method.");

            this.EmitExpression(del.Map);
            this.EmitExpression(del.Key);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(remove));
            this.il.OpCode(ILOpCode.Pop);
        }

        private void EmitMapIndexRead(BoundIndexExpression idx)
        {
            // Phase 3.A.4 emit: `m[k]` lowers to `Dictionary<K,V>::TryGetValue(K, out V)`
            // — we then pop the returned bool and load the out value. TryGetValue
            // zero-initialises the out parameter when the key is missing, matching
            // the interpreter's Go zero-value semantics rather than throwing as
            // `get_Item` would.
            var mapType = (MapTypeSymbol)idx.Target.Type;
            var dictType = mapType.ClrType;
            var tryGet = dictType.GetMethod(
                "TryGetValue",
                new[] { mapType.KeyType.ClrType, mapType.ValueType.ClrType.MakeByRefType() })
                ?? throw new InvalidOperationException(
                    $"Dictionary type '{dictType.FullName}' has no TryGetValue(K, out V) method.");

            var slot = this.mapIndexSlots[idx];
            this.EmitExpression(idx.Target);
            this.EmitExpression(idx.Index);
            this.il.LoadLocalAddress(slot);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(tryGet));
            this.il.OpCode(ILOpCode.Pop);
            this.il.LoadLocal(slot);
        }

        private void EmitMapIndexAssignment(BoundIndexAssignmentExpression ixa)
        {
            // Phase 3.A.4 emit: `m[k] = v` lowers to `Dictionary<K,V>::set_Item(K, V)`.
            // Issue #418 (P1-1): spill v to a temp before the callvirt so the
            // expression's result (the assigned value) does not require a
            // re-evaluation of k or a get_Item re-read. set_Item is void, so we
            // dup the value just before the call, save the dup to a scratch
            // local, then push it back as the expression result.
            var mapType = (MapTypeSymbol)ixa.Target.Type;
            var dictType = mapType.ClrType;
            var setItem = dictType.GetMethod("set_Item")
                ?? throw new InvalidOperationException(
                    $"Dictionary type '{dictType.FullName}' has no set_Item method.");

            var tmp = this.indexAssignmentValueSlots[ixa];
            this.EmitLoadVariable(ixa.Target);
            this.EmitExpression(ixa.Index);
            this.EmitExpression(ixa.Value);
            this.il.OpCode(ILOpCode.Dup);
            this.il.StoreLocal(tmp);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(setItem));
            this.il.LoadLocal(tmp);
        }

        private void EmitStructLiteral(BoundStructLiteralExpression literal)
        {
            if (!this.outer.structTypeDefs.TryGetValue(literal.StructType, out var typeDef))
            {
                throw new InvalidOperationException(
                    $"Struct '{literal.StructType.Name}' has no emitted TypeDef.");
            }

            // Class literal: newobj <ctor>; (dup; <value>; stfld) per init.
            if (literal.StructType.IsClass)
            {
                if (!this.outer.classCtorHandles.TryGetValue(literal.StructType, out var ctorHandle))
                {
                    throw new InvalidOperationException(
                        $"Class '{literal.StructType.Name}' has no emitted default ctor.");
                }

                this.il.OpCode(ILOpCode.Newobj);
                this.il.Token(ctorHandle);

                var classDef = literal.StructType.Definition ?? literal.StructType;
                foreach (var init in literal.Initializers)
                {
                    if (!this.outer.structFieldDefs.TryGetValue(init.Field, out var fieldHandle))
                    {
                        throw new InvalidOperationException(
                            $"Class field '{init.Field.Name}' has no emitted FieldDef.");
                    }

                    this.il.OpCode(ILOpCode.Dup);
                    this.EmitExpression(init.Value);

                    // Phase 4 emit parity (F2, type-erased): box when the
                    // definition's field is open (T) and the assigned value
                    // is a value type. Same boundary semantics as the
                    // primary-ctor and call-site box passes.
                    if (classDef != literal.StructType)
                    {
                        FieldSymbol df = null;
                        foreach (var f in classDef.Fields)
                        {
                            if (f.Name == init.Field.Name)
                            {
                                df = f;
                                break;
                            }
                        }

                        if (df != null
                            && df.Type is TypeParameterSymbol
                            && init.Value.Type is not TypeParameterSymbol
                            && IsValueTypeSymbol(init.Value.Type))
                        {
                            this.il.OpCode(ILOpCode.Box);
                            this.il.Token(this.outer.GetElementTypeToken(init.Value.Type));
                        }
                    }

                    this.il.OpCode(ILOpCode.Stfld);
                    this.il.Token(fieldHandle);
                }

                return;
            }

            if (!this.structLiteralSlots.TryGetValue(literal, out var slot))
            {
                throw new InvalidOperationException(
                    $"Struct literal of type '{literal.StructType.Name}' has no preallocated slot.");
            }

            // ldloca slot; initobj typedef — zero-initializes the value type.
            this.il.LoadLocalAddress(slot);
            this.il.OpCode(ILOpCode.Initobj);
            this.il.Token(typeDef);

            // For each initializer: ldloca slot; <emit value>; stfld fieldHandle.
            var structDef = literal.StructType.Definition ?? literal.StructType;
            foreach (var init in literal.Initializers)
            {
                if (!this.outer.structFieldDefs.TryGetValue(init.Field, out var fieldHandle))
                {
                    throw new InvalidOperationException(
                        $"Struct field '{init.Field.Name}' has no emitted FieldDef.");
                }

                this.il.LoadLocalAddress(slot);
                this.EmitExpression(init.Value);

                if (structDef != literal.StructType)
                {
                    FieldSymbol df = null;
                    foreach (var f in structDef.Fields)
                    {
                        if (f.Name == init.Field.Name)
                        {
                            df = f;
                            break;
                        }
                    }

                    if (df != null
                        && df.Type is TypeParameterSymbol
                        && init.Value.Type is not TypeParameterSymbol
                        && IsValueTypeSymbol(init.Value.Type))
                    {
                        this.il.OpCode(ILOpCode.Box);
                        this.il.Token(this.outer.GetElementTypeToken(init.Value.Type));
                    }
                }

                this.il.OpCode(ILOpCode.Stfld);
                this.il.Token(fieldHandle);
            }

            // Leave the constructed struct value on the stack.
            this.il.LoadLocal(slot);
        }

        private void EmitFieldAccess(BoundFieldAccessExpression fa)
        {
            if (!this.outer.structFieldDefs.TryGetValue(fa.Field, out var fieldHandle))
            {
                throw new InvalidOperationException(
                    $"Struct field '{fa.Field.Name}' has no emitted FieldDef.");
            }

            // ADR-0053: static field access — no receiver, use ldsfld.
            if (fa.Receiver == null)
            {
                this.il.OpCode(ILOpCode.Ldsfld);
                this.il.Token(fieldHandle);
                return;
            }

            // Class receivers are references: load the value (the ref) and ldfld.
            // For struct receivers, load by address when the receiver is a
            // simple variable (avoids a copy and is verifier-friendly); fall
            // back to value form otherwise (CLI permits ldfld on a value-type
            // value on stack).
            var receiverIsClass = fa.Receiver.Type is StructSymbol rs && rs.IsClass;
            if (!receiverIsClass && fa.Receiver is BoundVariableExpression bv && this.TryLoadVariableAddress(bv.Variable))
            {
                // address is on the stack
            }
            else
            {
                this.EmitExpression(fa.Receiver);
            }

            this.il.OpCode(ILOpCode.Ldfld);
            this.il.Token(fieldHandle);

            // Phase 4 emit parity (F2, type-erased generic user types): if
            // the definition's field is open (T) but the constructed
            // instance substitutes it to a value type, the ldfld pushes an
            // object reference (the boxed value). Unbox.any so the rest of
            // the IL sees the expected primitive.
            if (fa.StructType?.Definition is StructSymbol def && def != fa.StructType)
            {
                FieldSymbol defField = null;
                foreach (var f in def.Fields)
                {
                    if (f.Name == fa.Field.Name)
                    {
                        defField = f;
                        break;
                    }
                }

                if (defField != null
                    && defField.Type is TypeParameterSymbol
                    && fa.Field.Type is not TypeParameterSymbol
                    && IsValueTypeSymbol(fa.Field.Type))
                {
                    this.il.OpCode(ILOpCode.Unbox_any);
                    this.il.Token(this.outer.GetElementTypeToken(fa.Field.Type));
                }
            }
        }

        private void EmitNullConditionalAccess(BoundNullConditionalAccessExpression nc)
        {
            // Phase 3.C.3b / ADR-0001: evaluate the receiver once into a
            // synthetic capture local. If the captured value is null, leave
            // null on the stack and skip the access; otherwise evaluate the
            // access sub-tree, which references the capture local in place
            // of the original receiver.
            this.EmitExpression(nc.Receiver);
            this.EmitStoreVariable(nc.Capture);
            this.EmitLoadVariable(nc.Capture);
            var end = this.il.DefineLabel();
            var nonNull = this.il.DefineLabel();
            this.il.Branch(ILOpCode.Brtrue, nonNull);

            if (nc.ResultSlot != null)
            {
                // P2-7 / Issue #421: value-type access result. The bound type
                // is Nullable<T> but the access sub-tree pushes a raw T. The
                // nil branch must materialize `default(Nullable<T>)` and the
                // not-null branch must wrap T via `Nullable<T>::.ctor(!0)`
                // so both branches leave the same Nullable<T> stack shape.
                var slot = this.locals[nc.ResultSlot];
                var nullableType = (NullableTypeSymbol)nc.Type;
                var innerClr = nullableType.UnderlyingType.ClrType
                    ?? throw new InvalidOperationException(
                        $"Null-conditional value-type result '{nullableType.UnderlyingType.Name}' has no CLR type.");
                var nullableClr = typeof(System.Nullable<>).MakeGenericType(innerClr);

                // nil branch: ldloca slot; initobj Nullable<T>; ldloc slot
                this.il.LoadLocalAddress(slot);
                this.il.OpCode(ILOpCode.Initobj);
                this.il.Token(this.outer.GetTypeHandleForMember(nullableClr));
                this.il.LoadLocal(slot);
                this.il.Branch(ILOpCode.Br, end);

                // not-null branch: produce T, then newobj Nullable<T>::.ctor(!0)
                this.il.MarkLabel(nonNull);
                this.EmitExpression(nc.WhenNotNull);
                var ctor = nullableClr.GetConstructor(new[] { innerClr })
                    ?? throw new InvalidOperationException(
                        $"Nullable<{innerClr.FullName}> has no single-arg constructor.");
                this.il.OpCode(ILOpCode.Newobj);
                this.il.Token(this.outer.GetCtorReference(ctor));

                this.il.MarkLabel(end);
                return;
            }

            // Reference-typed access result: nullable<ref> shares the CLR
            // representation of T, so ldnull is a valid Nullable<T> value.
            this.il.OpCode(ILOpCode.Ldnull);
            this.il.Branch(ILOpCode.Br, end);
            this.il.MarkLabel(nonNull);
            this.EmitExpression(nc.WhenNotNull);
            this.il.MarkLabel(end);
        }

        // Phase B: emit IL for a BoundPatternSwitchStatement.
        //
        // Lowering shape (mirrors the interpreter's EvaluatePatternSwitchStatement):
        //   * evaluate the discriminant once into the pre-allocated temp slot;
        //   * for each non-default arm: emit pattern match — failure branches
        //     to the next-arm label, success falls through into arm body and
        //     ends with a branch to the end label;
        //   * if a default arm is present, emit its body last;
        //   * mark the end label.
        //
        // Pattern matching is delegated to EmitPattern which threads a
        // "loadValue" delegate so nested patterns (property fields, list
        // elements) compose without intermediate locals.
        private void EmitPatternSwitchStatement(BoundPatternSwitchStatement node)
        {
            var discriminantSlot = this.patternSwitchSlots[node];
            this.EmitExpression(node.Discriminant);
            this.il.StoreLocal(discriminantSlot);

            var endLabel = this.il.DefineLabel();
            BoundPatternSwitchArm defaultArm = null;

            foreach (var arm in node.Arms)
            {
                if (arm.IsDefault)
                {
                    defaultArm = arm;
                    continue;
                }

                var nextArm = this.il.DefineLabel();
                this.EmitPattern(
                    arm.Pattern,
                    loadValue: () => this.il.LoadLocal(discriminantSlot),
                    valueType: node.Discriminant.Type,
                    failLabel: nextArm);
                this.EmitStatement(arm.Body);
                this.il.Branch(ILOpCode.Br, endLabel);
                this.il.MarkLabel(nextArm);
            }

            if (defaultArm != null)
            {
                this.EmitStatement(defaultArm.Body);
            }

            this.il.MarkLabel(endLabel);
        }

        // Phase C: switch-expression emit. Mirrors the pattern-switch
        // statement shape, but each arm body is a single result expression
        // that is stored into a pre-allocated result temp before branching
        // to the end label. The result temp is loaded once at the end to
        // produce the expression's value.
        private void EmitSwitchExpression(BoundSwitchExpression node)
        {
            var (resultSlot, discrSlot) = this.switchExpressionSlots[node];
            this.EmitExpression(node.Discriminant);
            this.il.StoreLocal(discrSlot);

            var endLabel = this.il.DefineLabel();
            BoundSwitchExpressionArm defaultArm = null;

            foreach (var arm in node.Arms)
            {
                if (arm.IsDefault)
                {
                    defaultArm = arm;
                    continue;
                }

                var nextArm = this.il.DefineLabel();
                this.EmitPattern(
                    arm.Pattern,
                    loadValue: () => this.il.LoadLocal(discrSlot),
                    valueType: node.Discriminant.Type,
                    failLabel: nextArm);
                this.EmitExpression(arm.Result);
                this.il.StoreLocal(resultSlot);
                this.il.Branch(ILOpCode.Br, endLabel);
                this.il.MarkLabel(nextArm);
            }

            if (defaultArm != null)
            {
                this.EmitExpression(defaultArm.Result);
                this.il.StoreLocal(resultSlot);
            }

            this.il.MarkLabel(endLabel);
            this.il.LoadLocal(resultSlot);
        }

        // Emit IL that branches to failLabel when the pattern does not match
        // the value produced by loadValue, and falls through (with any
        // bindings stored) when it does. valueType is the static type of the
        // value loadValue pushes.
        private void EmitPattern(BoundPattern pattern, Action loadValue, TypeSymbol valueType, LabelHandle failLabel)
        {
            switch (pattern)
            {
                case BoundDiscardPattern:
                    // Always matches; emit nothing.
                    break;
                case BoundConstantPattern cp:
                    this.EmitConstantPattern(cp, loadValue, valueType, failLabel);
                    break;
                case BoundTypePattern tp:
                    this.EmitTypePattern(tp, loadValue, valueType, failLabel);
                    break;
                case BoundPropertyPattern pp:
                    this.EmitPropertyPattern(pp, loadValue, valueType, failLabel);
                    break;
                case BoundRelationalPattern rp:
                    this.EmitRelationalPattern(rp, loadValue, failLabel);
                    break;
                case BoundListPattern lp:
                    this.EmitListPattern(lp, loadValue, failLabel);
                    break;
                default:
                    throw new NotSupportedException(
                        $"Pattern kind '{pattern.Kind}' is not yet supported by the emitter.");
            }
        }

        private void EmitConstantPattern(BoundConstantPattern cp, Action loadValue, TypeSymbol valueType, LabelHandle failLabel)
        {
            // Special-case `nil`: compare against null reference.
            if (cp.Value is BoundLiteralExpression lit && lit.Value is null)
            {
                loadValue();
                this.il.Branch(ILOpCode.Brtrue, failLabel);
                return;
            }

            if (valueType == TypeSymbol.String)
            {
                loadValue();
                this.EmitExpression(cp.Value);
                this.il.Call(this.outer.GetStringEqualsReference());
                this.il.Branch(ILOpCode.Brfalse, failLabel);
                return;
            }

            // Issue #421 (P2-3): `decimal` is a struct; per ECMA-335 §III.4
            // `ceq` is undefined on struct operands. Route through
            // `decimal.op_Equality` to produce verifiable IL.
            if (valueType == TypeSymbol.Decimal)
            {
                loadValue();
                this.EmitExpression(cp.Value);
                this.TryEmitDecimalBinary(BoundBinaryOperatorKind.Equals);
                this.il.Branch(ILOpCode.Brfalse, failLabel);
                return;
            }

            // int / bool / other primitives lowered to ceq + brfalse.
            loadValue();
            this.EmitExpression(cp.Value);
            this.il.OpCode(ILOpCode.Ceq);
            this.il.Branch(ILOpCode.Brfalse, failLabel);
        }

        private void EmitTypePattern(BoundTypePattern tp, Action loadValue, TypeSymbol sourceType, LabelHandle failLabel)
        {
            // Strategy (uniform for ref + value targets):
            //   loadValue();
            //   if value-typed source: box;
            //   isinst targetType;     // [boxed-or-null]
            //   stloc scratch;
            //   ldloc scratch;
            //   brfalse failLabel;     // empty stack on failure path
            //   ldloc scratch;
            //   (value type) unbox.any | (ref type) leave as-is;
            //   stloc Variable
            //
            // Issue #420 (P3-2): the strategy above is INVALID when the
            // pattern target is `Nullable<T>` over a value type (i.e.
            // `NullableTypeSymbol` wrapping a CLR value type, which
            // `GetElementTypeToken` tokenises as `System.Nullable<T>`).
            // ECMA-335 §I.8.2.4 / §III.4.32 gives `Nullable<T>` special
            // boxing semantics: a non-null nullable boxes as a boxed `T`
            // (not as a boxed `Nullable<T>`), and a null nullable boxes
            // as the null reference. Consequently `isinst Nullable<T>`
            // is effectively never true at run time — a boxed value
            // either presents as `T` (matching `case T`) or as null.
            // Nullable-over-reference-type, by contrast, tokenises as
            // the bare underlying reference type and is handled
            // correctly by the strategy above.
            //
            // The binder today does not narrow a type pattern onto a
            // `Nullable<value-type>` target (type patterns narrow on the
            // underlying type), so this branch is unreachable from
            // surface syntax; this guard exists so that any future binder
            // change that lifts that restriction is forced to revisit the
            // emit strategy before this branch is entered with malformed
            // assumptions.
            if (tp.TargetType is NullableTypeSymbol nullableTarget
                && nullableTarget.UnderlyingType?.ClrType is { IsValueType: true })
            {
                throw new InvalidOperationException(
                    $"Type-pattern emit does not support a Nullable<T> target type ('{tp.TargetType.Name}') over a value type. " +
                    "Per ECMA-335 the CLR boxes Nullable<T> as a boxed T (or null), so 'isinst Nullable<T>' " +
                    "would never match the boxed value; revisit EmitTypePattern before allowing this shape (issue #420 / P3-2).");
            }

            var scratch = this.typePatternScratchSlots[tp];
            loadValue();

            if (IsValueTypeSymbol(sourceType))
            {
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.GetElementTypeToken(sourceType));
            }

            this.il.OpCode(ILOpCode.Isinst);
            this.il.Token(this.outer.GetElementTypeToken(tp.TargetType));
            this.il.StoreLocal(scratch);
            this.il.LoadLocal(scratch);
            this.il.Branch(ILOpCode.Brfalse, failLabel);

            // Bind the narrowed value into Variable.
            this.il.LoadLocal(scratch);
            if (IsValueTypeSymbol(tp.TargetType))
            {
                this.il.OpCode(ILOpCode.Unbox_any);
                this.il.Token(this.outer.GetElementTypeToken(tp.TargetType));
            }

            this.EmitStoreVariable(tp.Variable);
        }

        private void EmitPropertyPattern(BoundPropertyPattern pp, Action loadValue, TypeSymbol valueType, LabelHandle failLabel)
        {
            // Property patterns apply to GSharp struct/class discriminants.
            // If the discriminant is a nullable class reference, the binder
            // does not narrow on its own; we do not emit a null check here
            // because a non-nullable static type carries the contract that
            // the value is non-null. Fields are accessed via ldfld on the
            // value (struct: ldfld on value, class: ldfld through ref).
            if (valueType is not StructSymbol)
            {
                // Defensive: every property-pattern operand should be a
                // struct/class; the binder rejects others. Branch to fail
                // rather than emit a verifier-illegal sequence.
                this.il.Branch(ILOpCode.Br, failLabel);
                return;
            }

            foreach (var field in pp.Fields)
            {
                if (!this.outer.structFieldDefs.TryGetValue(field.Field, out var fieldHandle))
                {
                    throw new InvalidOperationException(
                        $"Property pattern field '{field.Field.Name}' has no emitted FieldDef.");
                }

                // Compose: child loader is "load receiver, ldfld FieldHandle".
                Action loadChild = () =>
                {
                    loadValue();
                    this.il.OpCode(ILOpCode.Ldfld);
                    this.il.Token(fieldHandle);
                };

                this.EmitPattern(field.Pattern, loadChild, field.Field.Type, failLabel);
            }
        }

        private void EmitRelationalPattern(BoundRelationalPattern rp, Action loadValue, LabelHandle failLabel)
        {
            loadValue();
            this.EmitExpression(rp.Value);

            // For unsigned/char discriminants the signed opcodes mis-order
            // values whose high bit is set (e.g. uint.MaxValue would compare
            // as -1 under Clt). Always use the *_un variants.
            //
            // For float/double, match the IEEE-aware lowering Roslyn uses
            // for C# relational operators: NaN must compare unordered with
            // every value, so strict `<`/`>` keep the signed Clt/Cgt (which
            // return 0 when an operand is NaN), but `<=`/`>=` — which we
            // synthesize as `!(a > b)` / `!(a < b)` — must use the _un
            // forms so the negation produces false for NaN instead of true.
            bool isUnsigned = IsUnsignedOrChar(rp.Type);
            bool isFloat = rp.Type == TypeSymbol.Float32 || rp.Type == TypeSymbol.Float64;
            switch (rp.Op.Kind)
            {
                case BoundBinaryOperatorKind.Equals:
                    this.il.OpCode(ILOpCode.Ceq);
                    break;
                case BoundBinaryOperatorKind.NotEquals:
                    this.il.OpCode(ILOpCode.Ceq);
                    this.il.LoadConstantI4(0);
                    this.il.OpCode(ILOpCode.Ceq);
                    break;
                case BoundBinaryOperatorKind.Less:
                    this.il.OpCode(isUnsigned ? ILOpCode.Clt_un : ILOpCode.Clt);
                    break;
                case BoundBinaryOperatorKind.LessOrEquals:
                    this.il.OpCode(isUnsigned || isFloat ? ILOpCode.Cgt_un : ILOpCode.Cgt);
                    this.il.LoadConstantI4(0);
                    this.il.OpCode(ILOpCode.Ceq);
                    break;
                case BoundBinaryOperatorKind.Greater:
                    this.il.OpCode(isUnsigned ? ILOpCode.Cgt_un : ILOpCode.Cgt);
                    break;
                case BoundBinaryOperatorKind.GreaterOrEquals:
                    this.il.OpCode(isUnsigned || isFloat ? ILOpCode.Clt_un : ILOpCode.Clt);
                    this.il.LoadConstantI4(0);
                    this.il.OpCode(ILOpCode.Ceq);
                    break;
                default:
                    throw new NotSupportedException(
                        $"Relational pattern operator '{rp.Op.Kind}' is not supported by the emitter.");
            }

            this.il.Branch(ILOpCode.Brfalse, failLabel);
        }

        private void EmitListPattern(BoundListPattern lp, Action loadValue, LabelHandle failLabel)
        {
            // Match an array (or slice) of exactly N elements. Slice patterns
            // (`..`) are not yet supported by the binder, so length is
            // strict-equal to the pattern's element count.
            loadValue();
            this.il.OpCode(ILOpCode.Ldlen);
            this.il.OpCode(ILOpCode.Conv_i4);
            this.il.LoadConstantI4(lp.Elements.Length);
            this.il.OpCode(ILOpCode.Ceq);
            this.il.Branch(ILOpCode.Brfalse, failLabel);

            for (var i = 0; i < lp.Elements.Length; i++)
            {
                var index = i;
                Action loadElement = () =>
                {
                    loadValue();
                    this.il.LoadConstantI4(index);
                    this.EmitLoadElement(lp.ElementType);
                };

                this.EmitPattern(lp.Elements[index], loadElement, lp.ElementType, failLabel);
            }
        }

        private void EmitFieldAssignment(BoundFieldAssignmentExpression fas)
        {
            if (!this.outer.structFieldDefs.TryGetValue(fas.Field, out var fieldHandle))
            {
                throw new InvalidOperationException(
                    $"Struct field '{fas.Field.Name}' has no emitted FieldDef.");
            }

            // ADR-0053: static field assignment — no receiver, use stsfld/ldsfld.
            if (fas.Receiver == null)
            {
                this.EmitExpression(fas.Value);
                this.il.OpCode(ILOpCode.Stsfld);
                this.il.Token(fieldHandle);

                // Leave the assigned value on the stack as the expression result.
                this.il.OpCode(ILOpCode.Ldsfld);
                this.il.Token(fieldHandle);
                return;
            }

            // Issue #420 (P3-4): the non-static paths below emit the receiver
            // twice — once for the `stfld`, and once again after the store to
            // reload the field for the expression result. This is only safe
            // when evaluating `fas.Value` cannot mutate `fas.Receiver`. For
            // class receivers a re-assignment of the receiver variable in the
            // value expression would make the post-store reload observe the
            // mutated reference and read the field off the wrong object; for
            // struct receivers the address would still be stable, but a
            // self-write inside `fas.Value` would race with `stfld`. Today the
            // binder (Binder.BindFieldAssignmentExpression) does not produce
            // such shapes: nested `BoundAssignmentExpression` writing back to
            // the same receiver variable is not a pattern the front end emits
            // for field-assignment values. The assertion below makes that
            // invariant explicit so any future binder change that introduces
            // self-mutating value expressions trips loudly in Debug instead of
            // silently miscompiling.
            Debug.Assert(
                !ValueExpressionMutatesReceiver(fas.Value, fas.Receiver),
                $"EmitFieldAssignment: value expression for field '{fas.Field.Name}' must not reassign the receiver variable '{fas.Receiver.Name}'.");

            // Class field assignment: load the reference, evaluate the value,
            // stfld through the reference. Re-load the receiver + ldfld to
            // leave the new value on the stack as the expression result.
            if (fas.StructType.IsClass)
            {
                this.EmitLoadVariable(fas.Receiver);
                this.EmitExpression(fas.Value);
                this.il.OpCode(ILOpCode.Stfld);
                this.il.Token(fieldHandle);

                this.EmitLoadVariable(fas.Receiver);
                this.il.OpCode(ILOpCode.Ldfld);
                this.il.Token(fieldHandle);
                return;
            }

            // Optimized path: storing default(T) into a value-type field uses
            // ldflda + initobj instead of pushing a value + stfld. This avoids
            // the invalid ldnull;stfld<ValueType> pattern and removes the need
            // for a temp local.
            if (fas.Value is BoundDefaultExpression defaultExpr && IsValueTypeSymbol(defaultExpr.Type))
            {
                // Emit: receiver-address; ldflda field; initobj T
                if (!this.TryLoadVariableAddress(fas.Receiver))
                {
                    throw new InvalidOperationException(
                        $"Cannot take the address of variable '{fas.Receiver.Name}' for field assignment.");
                }

                this.il.OpCode(ILOpCode.Ldflda);
                this.il.Token(fieldHandle);
                this.il.OpCode(ILOpCode.Initobj);
                this.il.Token(this.outer.GetElementTypeToken(defaultExpr.Type));

                // Leave the assigned value on the stack as the expression result.
                if (!this.TryLoadVariableAddress(fas.Receiver))
                {
                    throw new InvalidOperationException(
                        $"Cannot take the address of variable '{fas.Receiver.Name}' for field assignment.");
                }

                this.il.OpCode(ILOpCode.Ldfld);
                this.il.Token(fieldHandle);
                return;
            }

            // Binder guarantees the receiver is a simple variable for Phase 3.B.1.
            if (!this.TryLoadVariableAddress(fas.Receiver))
            {
                throw new InvalidOperationException(
                    $"Cannot take the address of variable '{fas.Receiver.Name}' for field assignment.");
            }

            this.EmitExpression(fas.Value);
            this.il.OpCode(ILOpCode.Stfld);
            this.il.Token(fieldHandle);

            // Leave the assigned value on the stack as the expression result.
            if (!this.TryLoadVariableAddress(fas.Receiver))
            {
                throw new InvalidOperationException(
                    $"Cannot take the address of variable '{fas.Receiver.Name}' for field assignment.");
            }

            this.il.OpCode(ILOpCode.Ldfld);
            this.il.Token(fieldHandle);
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

        // ADR-0051 Phase 6: emit IL for BoundPropertyAccessExpression (computed properties).
        // Auto-properties are lowered to BoundFieldAccessExpression by the Lowerer,
        // so this only fires for computed properties that still reference the accessor.
        private void EmitPropertyAccess(BoundPropertyAccessExpression access)
        {
            if (!this.outer.propertyAccessorHandles.TryGetValue(access.Property, out var handles) || !handles.Getter.HasValue)
            {
                throw new InvalidOperationException(
                    $"Property '{access.Property.Name}' has no emitted getter MethodDef.");
            }

            // Issue #263: static property access — no receiver to load.
            if (access.Receiver == null)
            {
                this.il.OpCode(ILOpCode.Call);
                this.il.Token(handles.Getter.Value);
                return;
            }

            // Load receiver. Issue #418 (P1-5): route through
            // EmitInstanceReceiver so non-variable struct receivers
            // (method-call results, indexer reads, tuple elements, etc.) are
            // spilled to a temp and addressed via `ldloca` rather than left as
            // a value on the stack (unverifiable / SIGSEGV).
            var receiverIsClass = access.Receiver.Type is StructSymbol rs && rs.IsClass;
            this.EmitInstanceReceiver(access.Receiver);

            this.il.OpCode(receiverIsClass ? ILOpCode.Callvirt : ILOpCode.Call);
            this.il.Token(handles.Getter.Value);
        }

        // ADR-0051 Phase 6: emit IL for BoundPropertyAssignmentExpression (computed properties).
        private void EmitPropertyAssignment(BoundPropertyAssignmentExpression assn)
        {
            if (!this.outer.propertyAccessorHandles.TryGetValue(assn.Property, out var handles) || !handles.Setter.HasValue)
            {
                throw new InvalidOperationException(
                    $"Property '{assn.Property.Name}' has no emitted setter MethodDef.");
            }

            // Issue #418 (P1-2): spill the assigned value to a temp so the
            // expression result (`dup; stloc tmp; ... ; ldloc tmp`) does not
            // require a second getter call — which would also re-evaluate any
            // side-effecting receiver. Static and instance paths share the
            // same dup/stloc/ldloc pattern.
            if (!this.receiverSpillSlots.TryGetValue(assn, out var valueSlot))
            {
                throw new InvalidOperationException(
                    $"No value-spill slot was allocated for property assignment to '{assn.Property.Name}'.");
            }

            // Issue #263: static property assignment — no receiver.
            if (assn.Receiver == null)
            {
                this.EmitExpression(assn.Value);
                this.il.OpCode(ILOpCode.Dup);
                this.il.StoreLocal(valueSlot);
                this.il.OpCode(ILOpCode.Call);
                this.il.Token(handles.Setter.Value);
                this.il.LoadLocal(valueSlot);
                return;
            }

            // Load receiver, emit value, call setter. Issue #418 (P1-5):
            // route through EmitInstanceReceiver so non-variable struct
            // receivers spill to a temp and pass `ldloca` as `this` instead
            // of leaving a value on the stack.
            var receiverIsClass = assn.Receiver.Type is StructSymbol rs && rs.IsClass;
            this.EmitInstanceReceiver(assn.Receiver);

            this.EmitExpression(assn.Value);
            this.il.OpCode(ILOpCode.Dup);
            this.il.StoreLocal(valueSlot);
            this.il.OpCode(receiverIsClass ? ILOpCode.Callvirt : ILOpCode.Call);
            this.il.Token(handles.Setter.Value);

            // Expression result: the value we just stored — no second receiver
            // evaluation, no getter call.
            this.il.LoadLocal(valueSlot);
        }

        private void EmitClrConstructorCall(BoundClrConstructorCallExpression ctorCall)
        {
            // Phase 4 emit parity: `newobj` against a CLR ctor. Handles both
            // non-generic types and constructed generic types — the parent of
            // the MemberRef becomes a TypeSpec for the latter, encoded in
            // `GetCtorReference` / `GetTypeHandleForMember`.
            // Issue #368: honour by-ref/out argument ref-kinds (e.g. an
            // interpolated-string handler whose constructor takes `out bool
            // shouldAppend`) by emitting the argument address.
            if (!ctorCall.ArgumentRefKinds.IsDefaultOrEmpty)
            {
                this.EmitImportedCallArguments(ctorCall.Arguments, ctorCall.ArgumentRefKinds);
            }
            else
            {
                foreach (var arg in ctorCall.Arguments)
                {
                    this.EmitExpression(arg);
                }
            }

            var ctorRef = this.outer.GetCtorReference(ctorCall.Constructor);
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(ctorRef);
        }

        private void EmitClrPropertyAccess(BoundClrPropertyAccessExpression access)
        {
            // Phase 4 / Stream B: property or field read on a CLR receiver.
            // Properties dispatch to their `get_X` accessor (callvirt for
            // reference types, call for value types); fields use `ldfld`.
            // When `Receiver` is null the access is static: emit `ldsfld` /
            // `call get_X` with no receiver instead.
            var isStatic = access.Receiver == null;
            if (!isStatic)
            {
                this.EmitInstanceReceiver(access.Receiver);
            }

            var receiverIsValueType = !isStatic && access.Receiver.Type?.ClrType?.IsValueType == true;
            switch (access.Member)
            {
                case PropertyInfo property:
                    var getter = property.GetGetMethod(nonPublic: false)
                        ?? throw new InvalidOperationException(
                            $"Property '{property.DeclaringType?.FullName}.{property.Name}' has no public getter.");
                    var getterRef = this.outer.GetMethodReference(getter);
                    this.il.OpCode(isStatic || receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
                    this.il.Token(getterRef);
                    break;
                case FieldInfo field:
                    var fieldRef = this.outer.GetFieldReference(field);
                    this.il.OpCode(isStatic ? ILOpCode.Ldsfld : ILOpCode.Ldfld);
                    this.il.Token(fieldRef);
                    break;
                default:
                    throw new NotSupportedException(
                        $"CLR member '{access.Member.GetType().Name}' is not yet supported by the emitter.");
            }
        }

        private void EmitClrPropertyAssignment(BoundClrPropertyAssignmentExpression assn)
        {
            // Stream B emit parity: property/field write on a CLR receiver.
            // Issue #418 (P1-2): the expression result is the assigned value.
            // Spill the value to a pre-allocated temp via `dup; stloc` so we
            // can produce the result with `ldloc` instead of re-evaluating the
            // receiver and calling the getter — the previous shape called any
            // side-effecting receiver expression (e.g. `Make().P = v`) twice.
            var isStatic = assn.Receiver == null;
            if (!this.receiverSpillSlots.TryGetValue(assn, out var valueSlot))
            {
                throw new InvalidOperationException(
                    $"No value-spill slot was allocated for CLR property assignment to '{assn.Member.Name}'.");
            }

            if (!isStatic)
            {
                this.EmitInstanceReceiver(assn.Receiver);
            }

            this.EmitExpression(assn.Value);
            this.il.OpCode(ILOpCode.Dup);
            this.il.StoreLocal(valueSlot);

            var receiverIsValueType = !isStatic && assn.Receiver.Type?.ClrType?.IsValueType == true;
            switch (assn.Member)
            {
                case PropertyInfo property:
                    var setter = property.GetSetMethod(nonPublic: false)
                        ?? throw new InvalidOperationException(
                            $"Property '{property.DeclaringType?.FullName}.{property.Name}' has no public setter.");
                    this.il.OpCode(isStatic || receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
                    this.il.Token(this.outer.GetMethodReference(setter));
                    break;
                case FieldInfo field:
                    this.il.OpCode(isStatic ? ILOpCode.Stsfld : ILOpCode.Stfld);
                    this.il.Token(this.outer.GetFieldReference(field));
                    break;
                default:
                    throw new NotSupportedException(
                        $"CLR member '{assn.Member.GetType().Name}' is not yet supported by the emitter.");
            }

            // Expression result: the value we just stored. No second receiver
            // evaluation, no getter call.
            this.il.LoadLocal(valueSlot);
        }

        private void EmitClrEventSubscription(BoundClrEventSubscriptionExpression subscription)
        {
            // Stream B′ emit parity: `+=` / `-=` calls the event's add_X /
            // remove_X accessor. Both accessors are void-returning.
            var isStatic = subscription.Receiver == null;
            var receiverIsValueType = !isStatic && subscription.Receiver.Type?.ClrType?.IsValueType == true;

            if (!isStatic)
            {
                this.EmitInstanceReceiver(subscription.Receiver);
            }

            // Function-literal handlers default to Action/Func; redirect them
            // to the event's actual delegate type so the AddEventHandler call
            // is type-correct.
            if (subscription.Handler is BoundFunctionLiteralExpression literalHandler
                && subscription.Event.EventHandlerType != null)
            {
                var mappedDelegateType = this.outer.MapToReferenceClrType(subscription.Event.EventHandlerType);
                this.EmitFunctionLiteral(literalHandler, mappedDelegateType);
            }
            else
            {
                this.EmitExpression(subscription.Handler);
            }

            var accessor = subscription.IsAdd
                ? subscription.Event.GetAddMethod(nonPublic: false)
                : subscription.Event.GetRemoveMethod(nonPublic: false);
            if (accessor == null)
            {
                throw new InvalidOperationException(
                    $"Event '{subscription.Event.DeclaringType?.FullName}.{subscription.Event.Name}' has no public {(subscription.IsAdd ? "add" : "remove")} accessor.");
            }

            this.il.OpCode(isStatic || receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(accessor));
        }

        private void EmitUserEventSubscription(BoundEventSubscriptionExpression node)
        {
            // ADR-0052: user-defined event subscription — call add_X or remove_X accessor.
            if (node.Receiver != null)
            {
                this.EmitInstanceReceiver(node.Receiver);
            }

            this.EmitExpression(node.Handler);

            if (this.outer.eventAccessorHandles.TryGetValue(node.Event, out var accessorHandles))
            {
                var accessorHandle = node.IsAdd ? accessorHandles.Add : accessorHandles.Remove;
                bool isStatic = node.Receiver == null;
                bool isVirtual = !isStatic && (node.Event.IsVirtual || node.Event.IsOverride);
                this.il.OpCode(isVirtual ? ILOpCode.Callvirt : ILOpCode.Call);
                this.il.Token(accessorHandle);
            }
        }

        private void EmitClrBinaryOperator(BoundClrBinaryOperatorExpression op)
        {
            // Stream C emit parity: user-defined binary operator on a CLR type.
            // C# operators are public-static methods, so we emit `call` against
            // the resolved MethodInfo with both arguments pushed in source
            // order.
            this.EmitExpression(op.Left);
            this.EmitExpression(op.Right);
            this.il.OpCode(ILOpCode.Call);
            this.il.Token(this.outer.GetMethodReference(op.Method));
        }

        private void EmitClrUnaryOperator(BoundClrUnaryOperatorExpression op)
        {
            // Stream C emit parity: user-defined unary operator on a CLR type.
            this.EmitExpression(op.Operand);
            this.il.OpCode(ILOpCode.Call);
            this.il.Token(this.outer.GetMethodReference(op.Method));
        }

        private void EmitClrConversionCall(BoundClrConversionCallExpression conv)
        {
            // Stream E emit parity: user-defined op_Implicit / op_Explicit is a
            // public-static method taking one arg, returning the target type.
            this.EmitExpression(conv.Source);
            this.il.OpCode(ILOpCode.Call);
            this.il.Token(this.outer.GetMethodReference(conv.Method));
        }

        private void EmitClrIndex(BoundClrIndexExpression idx)
        {
            // #313: indexing an erased generic over a type parameter (e.g.
            // `items[0]` where `items: List[T]`, or `map["k"]` where
            // `map: Dictionary[string, T]`). At runtime the receiver is a closed
            // generic (e.g. `List<int32>`) but is typed as the erased
            // `List<object>`; a `callvirt List<object>::get_Item` would fail.
            // Route the read through the non-generic System.Collections.IList /
            // IDictionary interfaces, which return the element as System.Object —
            // exactly the erased shape of the type parameter.
            if (idx.Target.Type is ImportedTypeSymbol erasedGen
                && erasedGen.HasTypeParameterArgument
                && idx.Target.Type.ClrType is System.Type erasedClr
                && idx.Arguments.Length == 1)
            {
                if (typeof(System.Collections.IList).IsAssignableFrom(erasedClr)
                    && idx.Arguments[0].Type == TypeSymbol.Int32)
                {
                    this.EmitInstanceReceiver(idx.Target);
                    this.il.OpCode(ILOpCode.Castclass);
                    this.il.Token((EntityHandle)this.outer.GetTypeReference(typeof(System.Collections.IList)));
                    this.EmitExpression(idx.Arguments[0]);
                    var iListGetter = typeof(System.Collections.IList)
                        .GetProperty("Item")
                        .GetGetMethod();
                    this.il.OpCode(ILOpCode.Callvirt);
                    this.il.Token(this.outer.GetMethodReference(iListGetter));
                    return;
                }

                if (typeof(System.Collections.IDictionary).IsAssignableFrom(erasedClr))
                {
                    this.EmitInstanceReceiver(idx.Target);
                    this.il.OpCode(ILOpCode.Castclass);
                    this.il.Token((EntityHandle)this.outer.GetTypeReference(typeof(System.Collections.IDictionary)));
                    this.EmitExpression(idx.Arguments[0]);
                    if (IsValueTypeSymbol(idx.Arguments[0].Type))
                    {
                        this.il.OpCode(ILOpCode.Box);
                        this.il.Token(this.outer.GetElementTypeToken(idx.Arguments[0].Type));
                    }

                    var iDictGetter = typeof(System.Collections.IDictionary)
                        .GetProperty("Item")
                        .GetGetMethod();
                    this.il.OpCode(ILOpCode.Callvirt);
                    this.il.Token(this.outer.GetMethodReference(iDictGetter));
                    return;
                }
            }

            // Phase 4 emit parity: indexer read. `d[k]` -> `callvirt get_Item(k)`.
            this.EmitInstanceReceiver(idx.Target);
            foreach (var arg in idx.Arguments)
            {
                this.EmitExpression(arg);
            }

            var getter = idx.Indexer.GetGetMethod(nonPublic: false)
                ?? throw new InvalidOperationException(
                    $"Indexer on '{idx.Indexer.DeclaringType?.FullName}' has no public getter.");
            var receiverIsValueType = idx.Target.Type?.ClrType?.IsValueType == true;
            this.il.OpCode(receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(getter));
        }

        private void EmitClrIndexAssignment(BoundClrIndexAssignmentExpression ixa)
        {
            var setter = ixa.Indexer.GetSetMethod(nonPublic: false);

            // ADR-0056 §2: span element write. `Span[T]` has no setter; its
            // indexer getter returns `ref T`. Obtain the managed pointer via
            // `get_Item`, then store the value through it (`stobj`/`stind.*`).
            // Issue #418 (P1-1): spill v to a temp before the stobj so the
            // expression's result (the assigned value) does not need a second
            // get_Item that would re-evaluate the index arguments.
            if (setter == null)
            {
                var refGetter = ixa.Indexer.GetGetMethod(nonPublic: false)
                    ?? throw new InvalidOperationException(
                        $"Indexer on '{ixa.Indexer.DeclaringType?.FullName}' has no public setter or getter.");
                var receiver = new BoundVariableExpression(null, ixa.Target);
                var tmp = this.indexAssignmentValueSlots[ixa];

                // store: <receiver-addr> <index...> get_Item(ref T) <value> dup stloc tmp stobj/stind
                this.EmitInstanceReceiver(receiver);
                foreach (var arg in ixa.Arguments)
                {
                    this.EmitExpression(arg);
                }

                this.il.OpCode(ILOpCode.Call);
                this.il.Token(this.outer.GetMethodReference(refGetter));
                this.EmitExpression(ixa.Value);
                this.il.OpCode(ILOpCode.Dup);
                this.il.StoreLocal(tmp);
                this.EmitStoreIndirect(ixa.Type);

                // expression result: the spilled value.
                this.il.LoadLocal(tmp);
                return;
            }

            // Phase 4 emit parity: indexer write. `d[k] = v` -> `callvirt set_Item(k, v)`.
            // Issue #418 (P1-5): route through EmitInstanceReceiver so a
            // value-type target (`ldloca`) and reference-type target (`ldloc`)
            // are both addressed correctly. For value-type indexers we also
            // need `call` instead of `callvirt`.
            // Issue #418 (P1-1): spill v to a temp before the call so the result
            // is the assigned value without a re-read via get_Item (which would
            // re-evaluate every index argument).
            var writeReceiver = new BoundVariableExpression(null, ixa.Target);
            var targetIsValueType = IsValueTypeSymbol(ixa.Target.Type);
            var slot = this.indexAssignmentValueSlots[ixa];

            this.EmitInstanceReceiver(writeReceiver);
            foreach (var arg in ixa.Arguments)
            {
                this.EmitExpression(arg);
            }

            this.EmitExpression(ixa.Value);
            this.il.OpCode(ILOpCode.Dup);
            this.il.StoreLocal(slot);
            this.il.OpCode(targetIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(setter));
            this.il.LoadLocal(slot);
        }

        private void EmitTupleLiteral(BoundTupleLiteralExpression tuple)
        {
            // Phase 4.5 emit parity: `(e1, e2, ...)` lowers to
            // `newobj ValueTuple<T1, T2, ...>::.ctor(T1, T2, ...)`. The CLR
            // backing type is set by TupleTypeSymbol.BuildClrType for arities
            // 2–7; higher arities have a null ClrType and are interpreter-only.
            var clrType = tuple.TupleType.ClrType
                ?? throw new NotSupportedException(
                    $"Tuple of arity {tuple.TupleType.Arity} has no CLR backing type; emit not supported.");

            ConstructorInfo ctor = null;
            foreach (var c in clrType.GetConstructors())
            {
                if (c.GetParameters().Length == tuple.Elements.Length)
                {
                    ctor = c;
                    break;
                }
            }

            if (ctor == null)
            {
                throw new InvalidOperationException(
                    $"ValueTuple type '{clrType.FullName}' has no constructor of arity {tuple.Elements.Length}.");
            }

            foreach (var elem in tuple.Elements)
            {
                this.EmitExpression(elem);
            }

            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(ctor));
        }

        private void EmitTupleElementAccess(BoundTupleElementAccessExpression access)
        {
            // Phase 4.5 emit parity: `t.ItemN`. ValueTuple<...> exposes the
            // elements as public *fields* (Item1..Item7), not properties, so
            // the access is a plain `ldfld`. Both struct-on-stack and
            // managed-pointer receivers are valid operands for ldfld; the
            // common cases (locals/params/temps) go through
            // EmitInstanceReceiver to prefer the address form.
            var clrType = access.TupleType.ClrType
                ?? throw new NotSupportedException(
                    $"Tuple of arity {access.TupleType.Arity} has no CLR backing type; emit not supported.");

            var fieldName = "Item" + (access.Index + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
            var field = clrType.GetField(fieldName)
                ?? throw new InvalidOperationException(
                    $"ValueTuple type '{clrType.FullName}' has no public field '{fieldName}'.");

            this.EmitInstanceReceiver(access.Receiver);
            this.il.OpCode(ILOpCode.Ldfld);
            this.il.Token(this.outer.GetFieldReference(field));
        }

        // Phase 4 emit parity (E1): function literal `func(x int) int { return x+1 }`
        // with no captured variables lowers to:
        //
        //   ldnull                            ; the `this` argument of the delegate
        //   ldftn  <synthesizedStaticMethod>  ; pushes the IntPtr for the body
        //   newobj Func<int,int>::.ctor(object, IntPtr)
        //
        // The synthesized method was registered earlier by CollectFunctionLiterals
        // and assigned a MethodDef row via functionHandles. The delegate's
        // constructor is looked up off literal.FunctionType.ClrType — every
        // Func<>/Action<> shipped by the BCL exposes the single canonical
        // `(object, IntPtr)` ctor.
        private void EmitFunctionLiteral(BoundFunctionLiteralExpression literal)
        {
            // For async lambdas, resolve the delegate type with the Task-wrapped return.
            Type asyncDelegateOverride = null;
            if (literal.Function.IsAsync)
            {
                // For no-capture lambdas, the plan's kickoff is literal.Function.
                // For capture-bearing lambdas, the plan's kickoff is closure.InvokeMethod.
                FunctionSymbol planKey = literal.Function;
                if (this.outer.closureInfos.TryGetValue(literal, out var closureForAsync))
                {
                    planKey = closureForAsync.InvokeMethod;
                }

                if (planKey.StateMachineType != null)
                {
                    asyncDelegateOverride = this.outer.ResolveAsyncDelegateClrType(literal.FunctionType, planKey);
                }
            }

            EmitFunctionLiteral(literal, overrideDelegateType: asyncDelegateOverride);
        }

        private void EmitFunctionLiteral(BoundFunctionLiteralExpression literal, Type overrideDelegateType)
        {
            if (this.outer.closureInfos.TryGetValue(literal, out var closure))
            {
                // Capture-bearing literal: instantiate the closure class,
                // snapshot each captured variable into its field, then bind
                // the delegate to the instance method.
                //
                //   newobj <closureClass>::.ctor()
                //   foreach capture:
                //       dup
                //       <load captured value>
                //       stfld <closureClass>::<field>
                //   dup
                //   ldftn  <closureClass>::Invoke
                //   newobj Func/Action::.ctor(object, IntPtr)
                if (!this.outer.classCtorHandles.TryGetValue(closure.ClassSym, out var ctorHandle))
                {
                    throw new InvalidOperationException(
                        $"Closure class '{closure.ClassSym.Name}' has no emitted constructor.");
                }

                if (!this.outer.methodHandles.TryGetValue(closure.InvokeMethod, out var invokeHandle))
                {
                    throw new InvalidOperationException(
                        $"Closure invoke method '{closure.InvokeMethod.Name}' has no emitted MethodDef.");
                }

                this.il.OpCode(ILOpCode.Newobj);
                this.il.Token(ctorHandle);

                foreach (var captured in literal.CapturedVariables)
                {
                    if (!closure.CaptureFields.TryGetValue(captured, out var field))
                    {
                        throw new InvalidOperationException(
                            $"Closure for '{literal.Function.Name}' has no field for captured '{captured.Name}'.");
                    }

                    if (!this.outer.structFieldDefs.TryGetValue(field, out var fieldHandle))
                    {
                        throw new InvalidOperationException(
                            $"Closure field '{field.Name}' has no emitted FieldDef.");
                    }

                    this.il.OpCode(ILOpCode.Dup);
                    this.EmitCapturedVariableLoad(captured);
                    this.il.OpCode(ILOpCode.Stfld);
                    this.il.Token(fieldHandle);
                }

                var delegateTypeC = overrideDelegateType ?? this.outer.ResolveDelegateClrType(literal.FunctionType);
                var delegateCtorC = delegateTypeC.GetConstructors()[0];
                this.il.OpCode(ILOpCode.Ldftn);
                this.il.Token(invokeHandle);
                this.il.OpCode(ILOpCode.Newobj);
                this.il.Token(this.outer.GetCtorReference(delegateCtorC));
                return;
            }

            if (literal.CapturedVariables.Length > 0)
            {
                throw new NotSupportedException(
                    $"Function literal '{literal.Function.Name}' captures outer variables; closure emit fell through synthesis.");
            }

            if (!this.outer.functionHandles.TryGetValue(literal.Function, out var methodHandle))
            {
                throw new InvalidOperationException(
                    $"Function literal '{literal.Function.Name}' has no emitted MethodDef.");
            }

            var delegateType = overrideDelegateType ?? this.outer.ResolveDelegateClrType(literal.FunctionType);
            var delegateCtor = delegateType.GetConstructors()[0];

            this.il.OpCode(ILOpCode.Ldnull);
            this.il.OpCode(ILOpCode.Ldftn);
            this.il.Token(methodHandle);
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(delegateCtor));
        }

        // Issue #324: emit a named-function method group as a delegate. The
        // function already has a static MethodDef row in functionHandles, so we
        // reuse the no-capture lambda sequence: `ldnull; ldftn <method>; newobj
        // <Delegate>::.ctor(object, IntPtr)`. The delegate type is the target
        // when one is supplied (a `Func[...]`/`Action[...]` conversion target),
        // otherwise the native delegate for the function's own signature.
        private void EmitMethodGroup(BoundMethodGroupExpression methodGroup, Type overrideDelegateType)
        {
            if (!this.outer.functionHandles.TryGetValue(methodGroup.Function, out var methodHandle))
            {
                throw new InvalidOperationException(
                    $"Method group '{methodGroup.Function.Name}' has no emitted MethodDef.");
            }

            var delegateType = overrideDelegateType ?? this.outer.ResolveDelegateClrType(methodGroup.FunctionType);
            var delegateCtor = delegateType.GetConstructors()[0];

            this.il.OpCode(ILOpCode.Ldnull);
            this.il.OpCode(ILOpCode.Ldftn);
            this.il.Token(methodHandle);
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(delegateCtor));
        }

        // Issue #337: emit a resolved CLR member method group as a delegate over
        // the selected overload. Static groups load a null target and the method
        // address (`ldnull; ldftn`); instance groups evaluate the receiver and
        // load its (virtual) address (`<recv>; [dup; ldvirtftn] / ldftn`),
        // capturing the receiver as the delegate target. The constructed
        // delegate is the resolved target type (`Func[...]`/`Action[...]` or a
        // named delegate), resolved onto the emitter's reference context.
        private void EmitClrMethodGroup(BoundClrMethodGroupExpression methodGroup)
        {
            var method = methodGroup.ResolvedMethod
                ?? throw new InvalidOperationException(
                    $"CLR method group '{methodGroup.MethodName}' reached emit without overload resolution.");

            var hostDelegate = methodGroup.DelegateType?.ClrType
                ?? throw new InvalidOperationException(
                    $"CLR method group '{methodGroup.MethodName}' has no resolved target delegate type.");

            var delegateType = this.outer.ResolveTargetDelegateClrType(hostDelegate);
            var delegateCtor = delegateType.GetConstructors()[0];
            var methodRef = this.outer.GetMethodReference(method);

            if (method.IsStatic)
            {
                this.il.OpCode(ILOpCode.Ldnull);
                this.il.OpCode(ILOpCode.Ldftn);
                this.il.Token(methodRef);
            }
            else
            {
                this.EmitExpression(methodGroup.Receiver);

                // Issue #420 (P3-1): the delegate ctor signature is
                // `(object target, IntPtr ptr)` and `ldvirtftn` requires an
                // object reference on the stack. The binder currently rejects
                // method-group conversions whose receiver is a value type, but
                // if that gate ever loosens (or a future codepath constructs
                // a `BoundClrMethodGroupExpression` with a struct receiver),
                // emitting the raw value would produce unverifiable IL that
                // silently corrupts the stack. Defensively box value-type
                // receivers so the emitted sequence stays verifiable.
                if (IsValueTypeSymbol(methodGroup.Receiver.Type))
                {
                    this.il.OpCode(ILOpCode.Box);
                    this.il.Token(this.outer.GetElementTypeToken(methodGroup.Receiver.Type));
                }

                if (method.IsVirtual && !method.IsFinal)
                {
                    this.il.OpCode(ILOpCode.Dup);
                    this.il.OpCode(ILOpCode.Ldvirtftn);
                    this.il.Token(methodRef);
                }
                else
                {
                    this.il.OpCode(ILOpCode.Ldftn);
                    this.il.Token(methodRef);
                }
            }

            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(delegateCtor));
        }

        // Phase 4 emit parity: load a captured variable. In a MoveNext body,
        // the variable may be hoisted to a state-machine field; emit the field
        // load instead of a local/parameter load in that case.
        private void EmitCapturedVariableLoad(VariableSymbol captured)
        {
            if (this.asyncFieldMap != null && this.asyncFieldMap.TryGetHoistedField(captured, out var hoistedField))
            {
                // Load from the state machine: ldarg.0; ldfld <smStruct>::<hoistedField>
                if (!this.outer.structFieldDefs.TryGetValue(hoistedField, out var hoistedHandle))
                {
                    throw new InvalidOperationException(
                        $"Hoisted field '{hoistedField.Name}' has no emitted FieldDef.");
                }

                this.il.OpCode(ILOpCode.Ldarg_0);
                this.il.OpCode(ILOpCode.Ldfld);
                this.il.Token(hoistedHandle);
                return;
            }

            this.EmitExpression(new BoundVariableExpression(null, captured));
        }

        // Phase 4 emit parity (E1): indirect call through a func-typed value.
        // Evaluates the target (pushes the delegate on the stack), evaluates
        // each argument, then calls the delegate's `Invoke` method via
        // `callvirt`.
        private void EmitIndirectCall(BoundIndirectCallExpression call)
        {
            // Phase 4 emit parity (F1, type-erased generics): a delegate whose
            // parameter or return types reference open type parameters (e.g.
            // `func(T) U`) is encoded as `System.Func<object, object>`, but the
            // runtime instance is a concrete delegate (e.g. `Func<int, int>`).
            // Invoking it through `Func<object, object>.Invoke` would feed the
            // concrete target boxed objects it cannot unbox, corrupting memory.
            // Route the call through `System.Delegate.DynamicInvoke`, which
            // marshals boxing / unboxing of value-type arguments and the return
            // value correctly across the erased boundary.
            if (call.FunctionType.ClrType == null)
            {
                this.EmitOpenDelegateDynamicInvoke(call);
                return;
            }

            this.EmitExpression(call.Target);
            foreach (var arg in call.Arguments)
            {
                this.EmitExpression(arg);
            }

            var delegateType = this.outer.ResolveDelegateClrType(call.FunctionType);

            var invoke = delegateType.GetMethod("Invoke")
                ?? throw new InvalidOperationException(
                    $"Delegate type '{delegateType.FullName}' has no Invoke method.");

            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(invoke));
        }

        // Invoke a type-erased open delegate (func(T) U over open type
        // parameters) via System.Delegate.DynamicInvoke(object[]). Builds a
        // boxed-argument array, calls DynamicInvoke, and leaves the boxed
        // result (System.Object) on the stack; the caller's existing erased
        // return handling unboxes when the substituted return is a value type.
        private void EmitOpenDelegateDynamicInvoke(BoundIndirectCallExpression call)
        {
            this.EmitExpression(call.Target);

            this.il.LoadConstantI4(call.Arguments.Length);
            this.il.OpCode(ILOpCode.Newarr);
            this.il.Token(this.outer.objectTypeRef);

            for (int i = 0; i < call.Arguments.Length; i++)
            {
                var arg = call.Arguments[i];
                this.il.OpCode(ILOpCode.Dup);
                this.il.LoadConstantI4(i);
                this.EmitExpression(arg);

                // Value-type arguments must be boxed into the object[] slot.
                // Open type-parameter arguments already flow as System.Object.
                if (arg.Type is not TypeParameterSymbol && IsValueTypeSymbol(arg.Type))
                {
                    this.il.OpCode(ILOpCode.Box);
                    this.il.Token(this.outer.GetElementTypeToken(arg.Type));
                }

                this.il.OpCode(ILOpCode.Stelem_ref);
            }

            var delegateClrType = this.outer.references.GetCoreType("System.Delegate");
            var dynamicInvoke = delegateClrType.GetMethod("DynamicInvoke")
                ?? throw new InvalidOperationException(
                    "System.Delegate has no DynamicInvoke method.");

            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(dynamicInvoke));

            // Issue #418 (P1-6): Delegate.DynamicInvoke always returns object.
            // For an erased void-returning delegate (`func(T)` with no return),
            // the BoundIndirectCallExpression.Type is Void, so the surrounding
            // BoundExpressionStatement skips its usual Pop and the boxed result
            // would linger on the stack, producing invalid IL at the next
            // ret/leave. Absorb the unused object here.
            if (call.FunctionType.ReturnType == TypeSymbol.Void)
            {
                this.il.OpCode(ILOpCode.Pop);
            }
        }

        private void EmitInstanceReceiver(BoundExpression receiver)
        {
            // Value-type receivers need a managed pointer (the implicit `this`
            // of an instance method on a value type is a `ref` parameter). For
            // the common case where the receiver is a local/parameter, we can
            // emit `ldloca`/`ldarga`. Other shapes are not yet exercised by the
            // emit pipeline.
            //
            // Issue #409: user-defined struct symbols have ClrType == null
            // until after emission, so a same-package receiver method like
            // `func (p Point) Distance() int32` would fall through to a value
            // load (`ldsfld`/`ldloc`) and pass garbage as `this` to the
            // instance call (SIGSEGV at runtime). IsValueTypeSymbol recognises
            // these symbol-only value types alongside enums and built-ins.
            if (IsValueTypeSymbol(receiver.Type))
            {
                if (receiver is BoundVariableExpression bve
                    && this.TryLoadVariableAddress(bve.Variable))
                {
                    return;
                }

                // ADR-0056 §4 (#375): a value-type *field* used as an instance
                // receiver (e.g. `w.data.Length` where `data` is a closed
                // constructed generic value type like `ReadOnlySpan[int32]`)
                // must be loaded by address (`ldflda`), not by value (`ldfld`).
                // Calling an instance method on a value type requires a managed
                // pointer as `this`; pushing the value instead reinterprets the
                // struct's bits as the `this` pointer and corrupts the stack
                // (AccessViolationException). The field signature already
                // carries the real constructed-generic layout, so the address
                // form is both correct and safe — *as long as the containing
                // field chain is itself addressable*. Otherwise `ldflda` on a
                // value on the evaluation stack produces invalid IL
                // (InvalidProgramException at JIT time).
                if (receiver is BoundFieldAccessExpression fa
                    && this.outer.structFieldDefs.ContainsKey(fa.Field)
                    && this.IsAddressableFieldAccess(fa))
                {
                    this.EmitFieldAddress(fa);
                    return;
                }

                // Issue #409 follow-up: a value-type receiver computed as an
                // rvalue (e.g. `makePoint(5, 6).Sum()` or
                // `makeOuter().Inner.Sum()` or `(a + b).Method()`) has no
                // addressable storage. Spill it to a pre-declared local and
                // pass `ldloca` as `this`; this is valid for ordinary structs
                // and by-ref-like `ref struct` values, which cannot be boxed.
                this.EmitExpression(receiver);
                if (!this.receiverSpillSlots.TryGetValue(receiver, out var slot))
                {
                    throw new InvalidOperationException(
                        $"No receiver spill slot was allocated for rvalue receiver of type '{receiver.Type}'.");
                }

                this.il.StoreLocal(slot);
                this.il.LoadLocalAddress(slot);
                return;
            }

            this.EmitExpression(receiver);
        }

        /// <summary>
        /// Returns <c>true</c> when <paramref name="fa"/> is addressable —
        /// i.e. <c>ldflda</c> against its receiver yields a valid managed
        /// pointer. Static fields are always addressable; instance fields on
        /// class receivers are addressable (the receiver is an object
        /// reference); instance fields on value-type receivers are addressable
        /// only if the receiver itself is addressable (a variable, or another
        /// addressable field access).
        /// </summary>
        private bool IsAddressableFieldAccess(BoundFieldAccessExpression fa)
        {
            if (fa.Receiver == null)
            {
                return true;
            }

            if (fa.Receiver.Type is StructSymbol rs && rs.IsClass)
            {
                return true;
            }

            if (fa.Receiver.Type?.ClrType != null && !fa.Receiver.Type.ClrType.IsValueType)
            {
                return true;
            }

            if (fa.Receiver is BoundVariableExpression bv && this.CanLoadVariableAddress(bv.Variable))
            {
                return true;
            }

            if (fa.Receiver is BoundFieldAccessExpression nested
                && this.outer.structFieldDefs.ContainsKey(nested.Field))
            {
                return this.IsAddressableFieldAccess(nested);
            }

            return false;
        }

        private bool CanLoadVariableAddress(VariableSymbol variable)
        {
            if (variable is ParameterSymbol ps && this.parameters.ContainsKey(ps))
            {
                return true;
            }

            if (this.locals.ContainsKey(variable))
            {
                return true;
            }

            if (variable is GlobalVariableSymbol gv && this.outer.globalFieldDefs.ContainsKey(gv))
            {
                return true;
            }

            return false;
        }

        private bool TryLoadVariableAddress(VariableSymbol variable)
        {
            if (variable is ParameterSymbol ps && this.parameters.TryGetValue(ps, out var argIndex))
            {
                // In a struct instance method, arg0 is already a managed pointer
                // (ref TStruct). Loading the arg value gives the address directly;
                // ldarga would give a pointer-to-pointer which is wrong for
                // ldfld/stfld/ldflda on the struct.
                if (argIndex == 0 && this.structThisParameter != null
                    && ReferenceEquals(ps, this.structThisParameter))
                {
                    this.il.LoadArgument(0);
                }
                else
                {
                    this.il.LoadArgumentAddress(argIndex);
                }

                return true;
            }

            if (this.locals.TryGetValue(variable, out var slot))
            {
                this.il.LoadLocalAddress(slot);
                return true;
            }

            // Issue #408 / #191: top-level globals are emitted as static fields
            // on <Program>; their address is taken with ldsflda.
            if (variable is GlobalVariableSymbol gv
                && this.outer.globalFieldDefs.TryGetValue(gv, out var fieldHandle))
            {
                this.il.OpCode(ILOpCode.Ldsflda);
                this.il.Token(fieldHandle);
                return true;
            }

            return false;
        }

        /// <summary>ADR-0039: Emits arguments for an imported call, respecting <see cref="RefKind"/>.</summary>
        private void EmitImportedCallArguments(ImmutableArray<BoundExpression> arguments, ImmutableArray<RefKind> refKinds)
        {
            for (int i = 0; i < arguments.Length; i++)
            {
                var rk = refKinds.IsDefault || i >= refKinds.Length ? RefKind.None : refKinds[i];
                var arg = arguments[i];

                if (rk == RefKind.Ref || rk == RefKind.Out || rk == RefKind.In)
                {
                    // Argument must be BoundAddressOfExpression; emit the address.
                    if (arg is BoundAddressOfExpression addrOf)
                    {
                        this.EmitAddressOf(addrOf);
                    }
                    else
                    {
                        // Fallback for in: emit value, but this shouldn't happen
                        // since binder requires & for all ref-kind arguments in V1.
                        this.EmitExpression(arg);
                    }
                }
                else
                {
                    this.EmitExpression(arg);
                }
            }
        }

        /// <summary>ADR-0039: Emits address-of by dispatching on the operand shape.</summary>
        private void EmitAddressOf(BoundAddressOfExpression node)
        {
            switch (node.Operand)
            {
                case BoundVariableExpression bve:
                    if (!this.TryLoadVariableAddress(bve.Variable))
                    {
                        throw new InvalidOperationException($"Cannot take address of variable '{bve.Variable.Name}'.");
                    }

                    break;

                case BoundFieldAccessExpression fa:
                    this.EmitFieldAddress(fa);
                    break;

                case BoundIndexExpression idx:
                    this.EmitExpression(idx.Target);
                    this.EmitExpression(idx.Index);
                    this.EmitLoadElementAddress(idx.Type);
                    break;

                case BoundDereferenceExpression deref:
                    // &(*p) = p — just emit the pointer value.
                    this.EmitExpression(deref.Operand);
                    break;

                default:
                    throw new InvalidOperationException($"Cannot take address of expression kind '{node.Operand.GetType().Name}'.");
            }
        }

        /// <summary>ADR-0039: Emits a dereference (load indirect) from a managed pointer.</summary>
        private void EmitDereference(BoundDereferenceExpression node)
        {
            this.EmitExpression(node.Operand);
            var pointeeType = ((ByRefTypeSymbol)node.Operand.Type).PointeeType;
            this.EmitLoadIndirect(pointeeType);
        }

        /// <summary>
        /// Emits the <c>builder.AwaitUnsafeOnCompleted&lt;TAwaiter, TSM&gt;(ref awaiter, ref this)</c>
        /// call that requires a MethodSpec with the synthesized SM TypeDef.
        /// </summary>
        private void EmitStateMachineAwaitOnCompleted(BoundStateMachineAwaitOnCompleted node)
        {
            this.outer.EmitAwaitOnCompletedCall(this.il, this.locals, this.parameters, node, this.asyncPlan, this.asyncIteratorEmitCtx);
        }

        /// <summary>
        /// Emits <c>builder.MoveNext&lt;TSM&gt;(ref this)</c> for async iterator SM classes.
        /// Constructs a MethodSpec for the generic MoveNext method.
        /// </summary>
        private void EmitAsyncIteratorBuilderMoveNext(BoundStateMachineBuilderMoveNext node)
        {
            // ldarg.0 (this)
            // ldflda builder
            var builderFieldHandle = this.outer.structFieldDefs[node.BuilderField];
            this.il.OpCode(ILOpCode.Ldarg_0);
            this.il.OpCode(ILOpCode.Ldflda);
            this.il.Token(builderFieldHandle);

            // ldarga.0 (ref this — managed pointer to the 'this' parameter slot)
            this.il.OpCode(ILOpCode.Ldarga_s);
            this.il.CodeBuilder.WriteByte(0);

            // call instance void AsyncIteratorMethodBuilder::MoveNext<SM>(ref SM)
            var builderClrType = typeof(System.Runtime.CompilerServices.AsyncIteratorMethodBuilder);
            var openMoveNext = builderClrType.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance)
                .First(m => m.Name == "MoveNext" && m.IsGenericMethodDefinition && m.GetParameters().Length == 1);
            var openRef = this.outer.GetMethodReference(openMoveNext.GetGenericMethodDefinition());

            var smTypeDef = this.outer.structTypeDefs[node.SmClass];

            var sigBlob = new BlobBuilder();
            var argsEncoder = new BlobEncoder(sigBlob).MethodSpecificationSignature(1);
            argsEncoder.AddArgument().Type(smTypeDef, isValueType: false); // class, not struct

            var methodSpec = this.outer.metadata.AddMethodSpecification(openRef, this.outer.metadata.GetOrAddBlob(sigBlob));
            this.il.OpCode(ILOpCode.Call);
            this.il.Token(methodSpec);
        }

        /// <summary>ADR-0039: Emits the field address (ldflda) for a user struct field.</summary>
        private void EmitFieldAddress(BoundFieldAccessExpression fa)
        {
            if (!this.outer.structFieldDefs.TryGetValue(fa.Field, out var fieldHandle))
            {
                throw new InvalidOperationException(
                    $"Cannot take address of field '{fa.Field.Name}': no emitted FieldDef.");
            }

            // ADR-0053: static field address — use ldsflda.
            if (fa.Receiver == null)
            {
                this.il.OpCode(ILOpCode.Ldsflda);
                this.il.Token(fieldHandle);
                return;
            }

            // Load receiver address, then ldflda.
            var receiverIsClass = fa.Receiver.Type is StructSymbol rs && rs.IsClass;
            if (!receiverIsClass && fa.Receiver is BoundVariableExpression bv && this.TryLoadVariableAddress(bv.Variable))
            {
                // address already on stack
            }
            else if (!receiverIsClass
                && fa.Receiver is BoundFieldAccessExpression nested
                && this.outer.structFieldDefs.ContainsKey(nested.Field)
                && this.IsAddressableFieldAccess(nested))
            {
                this.EmitFieldAddress(nested);
            }
            else
            {
                this.EmitExpression(fa.Receiver);
            }

            this.il.OpCode(ILOpCode.Ldflda);
            this.il.Token(fieldHandle);
        }

        /// <summary>ADR-0039: Emits ldelema for array element address.</summary>
        private void EmitLoadElementAddress(TypeSymbol elementType)
        {
            var clrType = elementType?.ClrType ?? typeof(object);
            var token = this.outer.GetElementTypeToken(elementType ?? TypeSymbol.FromClrType(typeof(object)));
            this.il.OpCode(ILOpCode.Ldelema);
            this.il.Token(token);
        }

        /// <summary>ADR-0039: Emits ldind.* or ldobj for loading a value through a managed pointer.</summary>
        private void EmitLoadIndirect(TypeSymbol pointeeType)
        {
            var clrType = pointeeType?.ClrType;
            if (clrType == typeof(int) || clrType == typeof(uint))
            {
                this.il.OpCode(ILOpCode.Ldind_i4);
            }
            else if (clrType == typeof(long) || clrType == typeof(ulong))
            {
                this.il.OpCode(ILOpCode.Ldind_i8);
            }
            else if (clrType == typeof(float))
            {
                this.il.OpCode(ILOpCode.Ldind_r4);
            }
            else if (clrType == typeof(double))
            {
                this.il.OpCode(ILOpCode.Ldind_r8);
            }
            else if (clrType == typeof(short) || clrType == typeof(ushort) || clrType == typeof(char))
            {
                this.il.OpCode(ILOpCode.Ldind_i2);
            }
            else if (clrType == typeof(byte) || clrType == typeof(sbyte) || clrType == typeof(bool))
            {
                this.il.OpCode(ILOpCode.Ldind_i1);
            }
            else if (clrType != null && clrType.IsValueType)
            {
                this.il.OpCode(ILOpCode.Ldobj);
                this.il.Token(this.outer.GetElementTypeToken(pointeeType));
            }
            else
            {
                this.il.OpCode(ILOpCode.Ldind_ref);
            }
        }

        /// <summary>ADR-0056 §2: Emits stind.* or stobj to store a value through a managed pointer.</summary>
        private void EmitStoreIndirect(TypeSymbol pointeeType)
        {
            var clrType = pointeeType?.ClrType;
            if (clrType == typeof(int) || clrType == typeof(uint))
            {
                this.il.OpCode(ILOpCode.Stind_i4);
            }
            else if (clrType == typeof(long) || clrType == typeof(ulong))
            {
                this.il.OpCode(ILOpCode.Stind_i8);
            }
            else if (clrType == typeof(float))
            {
                this.il.OpCode(ILOpCode.Stind_r4);
            }
            else if (clrType == typeof(double))
            {
                this.il.OpCode(ILOpCode.Stind_r8);
            }
            else if (clrType == typeof(short) || clrType == typeof(ushort) || clrType == typeof(char))
            {
                this.il.OpCode(ILOpCode.Stind_i2);
            }
            else if (clrType == typeof(byte) || clrType == typeof(sbyte) || clrType == typeof(bool))
            {
                this.il.OpCode(ILOpCode.Stind_i1);
            }
            else if (clrType != null && clrType.IsValueType)
            {
                this.il.OpCode(ILOpCode.Stobj);
                this.il.Token(this.outer.GetElementTypeToken(pointeeType));
            }
            else
            {
                this.il.OpCode(ILOpCode.Stind_ref);
            }
        }

        private void EmitGoStatement(BoundGoStatement node)
        {
            var hasScope = this.goEnclosingScopes.TryGetValue(node, out var scope);
            if (hasScope)
            {
                this.il.LoadLocal(this.scopeFrameSlots[scope].Tasks);
            }

            this.EmitGoAction(node);

            var closure = this.outer.goClosureInfos[node];
            var isAsync = ReflectionMetadataEmitter.IsTaskClrType(closure.InvokeMethod.Type?.ClrType);

            MethodInfo run;
            if (isAsync)
            {
                run = typeof(System.Threading.Tasks.Task).GetMethod(
                    nameof(System.Threading.Tasks.Task.Run),
                    new[] { typeof(Func<System.Threading.Tasks.Task>) });
            }
            else
            {
                run = typeof(System.Threading.Tasks.Task).GetMethod(
                    nameof(System.Threading.Tasks.Task.Run),
                    new[] { typeof(Action) });
            }

            this.il.Call(this.outer.GetMethodEntityHandle(run));

            if (hasScope)
            {
                var listType = typeof(List<System.Threading.Tasks.Task>);
                var add = listType.GetMethod(nameof(List<System.Threading.Tasks.Task>.Add), new[] { typeof(System.Threading.Tasks.Task) });
                this.il.OpCode(ILOpCode.Callvirt);
                this.il.Token(this.outer.GetMethodReference(add));
            }
            else
            {
                this.il.OpCode(ILOpCode.Pop);
            }
        }

        private void EmitGoAction(BoundGoStatement node)
        {
            if (!this.outer.goClosureInfos.TryGetValue(node, out var closure))
            {
                throw new InvalidOperationException("Go statement has no synthesized display class.");
            }

            if (!this.outer.classCtorHandles.TryGetValue(closure.ClassSym, out var ctorHandle))
            {
                throw new InvalidOperationException(
                    $"Go display class '{closure.ClassSym.Name}' has no emitted constructor.");
            }

            if (!this.outer.methodHandles.TryGetValue(closure.InvokeMethod, out var invokeHandle))
            {
                throw new InvalidOperationException(
                    $"Go display invoke method '{closure.InvokeMethod.Name}' has no emitted MethodDef.");
            }

            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(ctorHandle);

            foreach (var captured in closure.CaptureFields.Keys)
            {
                var field = closure.CaptureFields[captured];
                if (!this.outer.structFieldDefs.TryGetValue(field, out var fieldHandle))
                {
                    throw new InvalidOperationException(
                        $"Go display field '{field.Name}' has no emitted FieldDef.");
                }

                this.il.OpCode(ILOpCode.Dup);
                this.EmitExpression(new BoundVariableExpression(null, captured));
                this.il.OpCode(ILOpCode.Stfld);
                this.il.Token(fieldHandle);
            }

            var isAsync = ReflectionMetadataEmitter.IsTaskClrType(closure.InvokeMethod.Type?.ClrType);

            if (isAsync)
            {
                var funcTaskCtor = typeof(Func<System.Threading.Tasks.Task>).GetConstructor(new[] { typeof(object), typeof(IntPtr) });
                this.il.OpCode(ILOpCode.Ldftn);
                this.il.Token(invokeHandle);
                this.il.OpCode(ILOpCode.Newobj);
                this.il.Token(this.outer.GetCtorReference(funcTaskCtor));
            }
            else
            {
                var actionCtor = typeof(Action).GetConstructor(new[] { typeof(object), typeof(IntPtr) });
                this.il.OpCode(ILOpCode.Ldftn);
                this.il.Token(invokeHandle);
                this.il.OpCode(ILOpCode.Newobj);
                this.il.Token(this.outer.GetCtorReference(actionCtor));
            }
        }

        private void EmitScopeStatement(BoundScopeStatement node)
        {
            var slots = this.scopeFrameSlots[node];
            var listType = typeof(List<System.Threading.Tasks.Task>);
            var listCtor = listType.GetConstructor(Type.EmptyTypes);
            var ctsCtor = typeof(System.Threading.CancellationTokenSource).GetConstructor(Type.EmptyTypes);

            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(listCtor));
            this.il.StoreLocal(slots.Tasks);

            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(ctsCtor));
            this.il.StoreLocal(slots.Cts);

            var tryStart = this.il.DefineLabel();
            var finallyStart = this.il.DefineLabel();
            var finallyEnd = this.il.DefineLabel();
            var endLabel = this.il.DefineLabel();

            this.il.MarkLabel(tryStart);
            this.EmitStatement(node.Body);
            this.il.Branch(ILOpCode.Leave, endLabel);

            this.il.MarkLabel(finallyStart);
            this.EmitScopeWaitAndDispose(slots);
            this.il.OpCode(ILOpCode.Endfinally);
            this.il.MarkLabel(finallyEnd);
            this.il.MarkLabel(endLabel);

            this.il.ControlFlowBuilder.AddFinallyRegion(tryStart, finallyStart, finallyStart, finallyEnd);
        }

        private void EmitScopeWaitAndDispose((int Tasks, int Cts, int Awaiter) slots)
        {
            var outerTryStart = this.il.DefineLabel();
            var innerTryStart = this.il.DefineLabel();
            var innerTryEnd = this.il.DefineLabel();
            var catchStart = this.il.DefineLabel();
            var catchEnd = this.il.DefineLabel();
            var disposeStart = this.il.DefineLabel();
            var disposeEnd = this.il.DefineLabel();
            var afterNested = this.il.DefineLabel();

            this.il.MarkLabel(outerTryStart);
            this.il.MarkLabel(innerTryStart);
            this.EmitScopeWait(slots);
            this.il.Branch(ILOpCode.Leave, afterNested);
            this.il.MarkLabel(innerTryEnd);

            this.il.MarkLabel(catchStart);
            this.il.OpCode(ILOpCode.Pop);
            var cancel = typeof(System.Threading.CancellationTokenSource).GetMethod(
                nameof(System.Threading.CancellationTokenSource.Cancel),
                Type.EmptyTypes);
            this.il.LoadLocal(slots.Cts);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(cancel));
            this.il.OpCode(ILOpCode.Rethrow);
            this.il.MarkLabel(catchEnd);

            this.il.MarkLabel(disposeStart);
            var dispose = typeof(System.Threading.CancellationTokenSource).GetMethod(
                nameof(System.Threading.CancellationTokenSource.Dispose),
                Type.EmptyTypes);
            this.il.LoadLocal(slots.Cts);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(dispose));
            this.il.OpCode(ILOpCode.Endfinally);
            this.il.MarkLabel(disposeEnd);
            this.il.MarkLabel(afterNested);

            this.il.ControlFlowBuilder.AddCatchRegion(
                innerTryStart,
                innerTryEnd,
                catchStart,
                catchEnd,
                (EntityHandle)this.outer.GetTypeReference(typeof(Exception)));
            this.il.ControlFlowBuilder.AddFinallyRegion(outerTryStart, disposeStart, disposeStart, disposeEnd);
        }

        private void EmitScopeWait((int Tasks, int Cts, int Awaiter) slots)
        {
            var listType = typeof(List<System.Threading.Tasks.Task>);
            var toArray = listType.GetMethod(nameof(List<System.Threading.Tasks.Task>.ToArray), Type.EmptyTypes);
            var whenAll = typeof(System.Threading.Tasks.Task).GetMethod(
                nameof(System.Threading.Tasks.Task.WhenAll),
                new[] { typeof(System.Threading.Tasks.Task[]) });
            var getAwaiter = typeof(System.Threading.Tasks.Task).GetMethod(
                nameof(System.Threading.Tasks.Task.GetAwaiter),
                Type.EmptyTypes);
            var getResult = typeof(System.Runtime.CompilerServices.TaskAwaiter).GetMethod(
                nameof(System.Runtime.CompilerServices.TaskAwaiter.GetResult),
                Type.EmptyTypes);

            this.il.LoadLocal(slots.Tasks);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(toArray));
            this.il.Call(this.outer.GetMethodEntityHandle(whenAll));
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(getAwaiter));
            this.il.StoreLocal(slots.Awaiter);
            this.il.LoadLocalAddress(slots.Awaiter);
            this.il.OpCode(ILOpCode.Call);
            this.il.Token(this.outer.GetMethodReference(getResult));
        }

        private void EmitSelectStatement(BoundSelectStatement node)
        {
            var slots = this.selectStatementSlots[node];
            for (var i = 0; i < node.Cases.Length; i++)
            {
                var arm = node.Cases[i];
                if (arm.IsDefault)
                {
                    continue;
                }

                this.EmitExpression(arm.Channel);
                this.il.StoreLocal(slots.ChannelSlots[i]);
                if (arm.CaseKind == SelectCaseKind.Send)
                {
                    this.EmitExpression(arm.Value);
                    this.il.StoreLocal(slots.ValueSlots[i]);
                }
            }

            var loopLabel = this.il.DefineLabel();
            var endLabel = this.il.DefineLabel();
            this.il.MarkLabel(loopLabel);

            for (var i = 0; i < node.Cases.Length; i++)
            {
                if (node.Cases[i].CaseKind == SelectCaseKind.ReceiveDiscard
                    || node.Cases[i].CaseKind == SelectCaseKind.ReceiveBind)
                {
                    this.EmitSelectReceiveProbe(node.Cases[i], slots, i, endLabel);
                }
            }

            for (var i = 0; i < node.Cases.Length; i++)
            {
                if (node.Cases[i].CaseKind == SelectCaseKind.Send)
                {
                    this.EmitSelectSendProbe(node.Cases[i], slots, i, endLabel);
                }
            }

            foreach (var arm in node.Cases)
            {
                if (arm.IsDefault)
                {
                    this.EmitStatement(arm.Body);
                    this.il.Branch(ILOpCode.Br, endLabel);
                    this.il.MarkLabel(endLabel);
                    return;
                }
            }

            this.EmitSelectWait(node, slots);
            this.il.Branch(ILOpCode.Br, loopLabel);
            this.il.MarkLabel(endLabel);
        }

        private void EmitSelectReceiveProbe(
            BoundSelectCase arm,
            SelectSlots slots,
            int index,
            LabelHandle endLabel)
        {
            var nextLabel = this.il.DefineLabel();
            var closedLabel = this.il.DefineLabel();
            var chType = (ChannelTypeSymbol)arm.Channel.Type;
            var elementClr = ResolveChannelElementClrType(chType.ElementType);
            var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
            var readerClr = typeof(System.Threading.Channels.ChannelReader<>).MakeGenericType(elementClr);
            var getReader = channelClr.GetProperty("Reader").GetGetMethod();
            var tryRead = readerClr.GetMethod("TryRead", new[] { elementClr.MakeByRefType() });
            var completion = readerClr.GetProperty("Completion").GetGetMethod();
            var isCompleted = typeof(System.Threading.Tasks.Task).GetProperty("IsCompleted").GetGetMethod();

            this.il.LoadLocal(slots.ChannelSlots[index]);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(getReader));
            this.il.LoadLocalAddress(slots.OutSlots[index]);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(tryRead));
            this.il.Branch(ILOpCode.Brfalse, closedLabel);
            this.EmitStatement(arm.Body);
            this.il.Branch(ILOpCode.Br, endLabel);

            this.il.MarkLabel(closedLabel);
            this.il.LoadLocal(slots.ChannelSlots[index]);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(getReader));
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(completion));
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(isCompleted));
            this.il.Branch(ILOpCode.Brfalse, nextLabel);
            this.EmitZeroInit(slots.OutSlots[index], chType.ElementType, elementClr);
            this.EmitStatement(arm.Body);
            this.il.Branch(ILOpCode.Br, endLabel);
            this.il.MarkLabel(nextLabel);
        }

        private void EmitSelectSendProbe(
            BoundSelectCase arm,
            SelectSlots slots,
            int index,
            LabelHandle endLabel)
        {
            var nextLabel = this.il.DefineLabel();
            var chType = (ChannelTypeSymbol)arm.Channel.Type;
            var elementClr = ResolveChannelElementClrType(chType.ElementType);
            var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
            var writerClr = typeof(System.Threading.Channels.ChannelWriter<>).MakeGenericType(elementClr);
            var getWriter = channelClr.GetProperty("Writer").GetGetMethod();
            var tryWrite = writerClr.GetMethod("TryWrite", new[] { elementClr });

            this.il.LoadLocal(slots.ChannelSlots[index]);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(getWriter));
            this.il.LoadLocal(slots.ValueSlots[index]);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(tryWrite));
            this.il.Branch(ILOpCode.Brfalse, nextLabel);
            this.EmitStatement(arm.Body);
            this.il.Branch(ILOpCode.Br, endLabel);
            this.il.MarkLabel(nextLabel);
        }

        private void EmitSelectWait(BoundSelectStatement node, SelectSlots slots)
        {
            var taskType = TypeSymbol.FromClrType(typeof(System.Threading.Tasks.Task));
            var whenAny = typeof(System.Threading.Tasks.Task).GetMethod(
                nameof(System.Threading.Tasks.Task.WhenAny),
                new[] { typeof(System.Threading.Tasks.Task[]) });
            var taskOfTask = typeof(System.Threading.Tasks.Task<System.Threading.Tasks.Task>);
            var getAwaiter = taskOfTask.GetMethod("GetAwaiter", Type.EmptyTypes);
            var awaiter = typeof(System.Runtime.CompilerServices.TaskAwaiter<System.Threading.Tasks.Task>);
            var getResult = awaiter.GetMethod("GetResult", Type.EmptyTypes);

            var waitCount = 0;
            foreach (var arm in node.Cases)
            {
                if (!arm.IsDefault)
                {
                    waitCount++;
                }
            }

            this.il.LoadConstantI4(waitCount);
            this.il.OpCode(ILOpCode.Newarr);
            this.il.Token(this.outer.GetElementTypeToken(taskType));
            this.il.StoreLocal(slots.TasksSlot);

            var taskIndex = 0;
            for (var i = 0; i < node.Cases.Length; i++)
            {
                var arm = node.Cases[i];
                if (arm.IsDefault)
                {
                    continue;
                }

                this.il.LoadLocal(slots.TasksSlot);
                this.il.LoadConstantI4(taskIndex);
                this.EmitSelectWaitTask(arm, slots, i);
                this.il.OpCode(ILOpCode.Stelem_ref);
                taskIndex++;
            }

            this.il.LoadLocal(slots.TasksSlot);
            this.il.Call(this.outer.GetMethodEntityHandle(whenAny));
            this.il.StoreLocal(slots.WhenAnyTaskSlot);
            this.il.LoadLocal(slots.WhenAnyTaskSlot);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(getAwaiter));
            this.il.StoreLocal(slots.WhenAnyAwaiterSlot);
            this.il.LoadLocalAddress(slots.WhenAnyAwaiterSlot);
            this.il.OpCode(ILOpCode.Call);
            this.il.Token(this.outer.GetMethodReference(getResult));
            this.il.StoreLocal(slots.CompletedTaskSlot);
        }

        private void EmitSelectWaitTask(BoundSelectCase arm, SelectSlots slots, int index)
        {
            var chType = (ChannelTypeSymbol)arm.Channel.Type;
            var elementClr = ResolveChannelElementClrType(chType.ElementType);
            var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
            var valueTaskBool = typeof(System.Threading.Tasks.ValueTask<bool>);
            var asTask = valueTaskBool.GetMethod("AsTask", Type.EmptyTypes);

            if (arm.CaseKind == SelectCaseKind.Send)
            {
                var writerClr = typeof(System.Threading.Channels.ChannelWriter<>).MakeGenericType(elementClr);
                var getWriter = channelClr.GetProperty("Writer").GetGetMethod();
                var waitToWrite = writerClr.GetMethod(
                    "WaitToWriteAsync",
                    new[] { typeof(System.Threading.CancellationToken) });
                this.il.LoadLocal(slots.ChannelSlots[index]);
                this.il.OpCode(ILOpCode.Callvirt);
                this.il.Token(this.outer.GetMethodReference(getWriter));
                this.EmitCancellationTokenNone();
                this.il.OpCode(ILOpCode.Callvirt);
                this.il.Token(this.outer.GetMethodReference(waitToWrite));
            }
            else
            {
                var readerClr = typeof(System.Threading.Channels.ChannelReader<>).MakeGenericType(elementClr);
                var getReader = channelClr.GetProperty("Reader").GetGetMethod();
                var waitToRead = readerClr.GetMethod(
                    "WaitToReadAsync",
                    new[] { typeof(System.Threading.CancellationToken) });
                this.il.LoadLocal(slots.ChannelSlots[index]);
                this.il.OpCode(ILOpCode.Callvirt);
                this.il.Token(this.outer.GetMethodReference(getReader));
                this.EmitCancellationTokenNone();
                this.il.OpCode(ILOpCode.Callvirt);
                this.il.Token(this.outer.GetMethodReference(waitToRead));
            }

            this.il.StoreLocal(slots.WaitValueTaskSlot);
            this.il.LoadLocalAddress(slots.WaitValueTaskSlot);
            this.il.OpCode(ILOpCode.Call);
            this.il.Token(this.outer.GetMethodReference(asTask));
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

        private void EmitMakeChannelExpression(BoundMakeChannelExpression node)
        {
            var elementClr = ResolveChannelElementClrType(node.ChannelType.ElementType);
            if (node.Capacity == null)
            {
                var openCreate = typeof(System.Threading.Channels.Channel)
                    .GetMethods(BindingFlags.Public | BindingFlags.Static)
                    .First(m => m.Name == nameof(System.Threading.Channels.Channel.CreateUnbounded)
                        && m.IsGenericMethodDefinition
                        && m.GetParameters().Length == 0);
                var create = openCreate.MakeGenericMethod(elementClr);
                this.il.Call(this.outer.GetMethodEntityHandle(create));
                return;
            }

            var optionsCtor = typeof(System.Threading.Channels.BoundedChannelOptions)
                .GetConstructor(new[] { typeof(int) });
            this.EmitExpression(node.Capacity);
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(optionsCtor));

            var openBounded = typeof(System.Threading.Channels.Channel)
                .GetMethods(BindingFlags.Public | BindingFlags.Static)
                .First(m => m.Name == nameof(System.Threading.Channels.Channel.CreateBounded)
                    && m.IsGenericMethodDefinition
                    && m.GetParameters().Length == 1
                    && m.GetParameters()[0].ParameterType == typeof(System.Threading.Channels.BoundedChannelOptions));
            var bounded = openBounded.MakeGenericMethod(elementClr);
            this.il.Call(this.outer.GetMethodEntityHandle(bounded));
        }

        private void EmitChannelSendStatement(BoundChannelSendStatement node)
        {
            var chType = (ChannelTypeSymbol)node.Channel.Type;
            var elementClr = ResolveChannelElementClrType(chType.ElementType);
            var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
            var writerClr = typeof(System.Threading.Channels.ChannelWriter<>).MakeGenericType(elementClr);
            var getWriter = channelClr.GetProperty("Writer").GetGetMethod();
            var writeAsync = writerClr.GetMethod(
                "WriteAsync",
                new[] { elementClr, typeof(System.Threading.CancellationToken) });
            var asTaskNonGeneric = typeof(System.Threading.Tasks.ValueTask).GetMethod("AsTask", Type.EmptyTypes);
            var getAwaiter = typeof(System.Threading.Tasks.Task).GetMethod("GetAwaiter", Type.EmptyTypes);
            var getResult = typeof(System.Runtime.CompilerServices.TaskAwaiter).GetMethod("GetResult", Type.EmptyTypes);

            var (vtSlot, taSlot, _, _) = this.channelOpSlots[node];

            this.EmitExpression(node.Channel);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(getWriter));

            this.EmitExpression(node.Value);
            this.EmitCancellationTokenNone();

            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(writeAsync));

            this.il.StoreLocal(vtSlot);
            this.il.LoadLocalAddress(vtSlot);
            this.il.OpCode(ILOpCode.Call);
            this.il.Token(this.outer.GetMethodReference(asTaskNonGeneric));

            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(getAwaiter));
            this.il.StoreLocal(taSlot);
            this.il.LoadLocalAddress(taSlot);
            this.il.OpCode(ILOpCode.Call);
            this.il.Token(this.outer.GetMethodReference(getResult));
        }

        private void EmitChannelReceiveExpression(BoundChannelReceiveExpression node)
        {
            // try { result = ch.Reader.ReadAsync(default).AsTask().GetAwaiter().GetResult(); }
            // catch (ChannelClosedException) { result = default(T); }
            // ldloc result
            var chType = (ChannelTypeSymbol)node.Channel.Type;
            var elementClr = ResolveChannelElementClrType(chType.ElementType);
            var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
            var readerClr = typeof(System.Threading.Channels.ChannelReader<>).MakeGenericType(elementClr);
            var getReader = channelClr.GetProperty("Reader").GetGetMethod();
            var readAsync = readerClr.GetMethod(
                "ReadAsync",
                new[] { typeof(System.Threading.CancellationToken) });

            var valueTaskGeneric = typeof(System.Threading.Tasks.ValueTask<>).MakeGenericType(elementClr);
            var asTaskGeneric = valueTaskGeneric.GetMethod("AsTask", Type.EmptyTypes);
            var taskGeneric = typeof(System.Threading.Tasks.Task<>).MakeGenericType(elementClr);
            var taskGetAwaiter = taskGeneric.GetMethod("GetAwaiter", Type.EmptyTypes);
            var taskAwaiterGeneric = typeof(System.Runtime.CompilerServices.TaskAwaiter<>).MakeGenericType(elementClr);
            var taskGetResult = taskAwaiterGeneric.GetMethod("GetResult", Type.EmptyTypes);
            var ccExceptionClr = typeof(System.Threading.Channels.ChannelClosedException);

            var (vtSlot, taSlot, resultSlot, _) = this.channelOpSlots[node];
            var tryStart = this.il.DefineLabel();
            var tryEnd = this.il.DefineLabel();
            var handlerStart = this.il.DefineLabel();
            var handlerEnd = this.il.DefineLabel();
            var endLabel = this.il.DefineLabel();

            this.il.MarkLabel(tryStart);

            this.EmitExpression(node.Channel);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(getReader));

            this.EmitCancellationTokenNone();
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(readAsync));

            this.il.StoreLocal(vtSlot);
            this.il.LoadLocalAddress(vtSlot);
            this.il.OpCode(ILOpCode.Call);
            this.il.Token(this.outer.GetMethodReference(asTaskGeneric));

            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(taskGetAwaiter));
            this.il.StoreLocal(taSlot);
            this.il.LoadLocalAddress(taSlot);
            this.il.OpCode(ILOpCode.Call);
            this.il.Token(this.outer.GetMethodReference(taskGetResult));
            this.il.StoreLocal(resultSlot);
            this.il.Branch(ILOpCode.Leave, endLabel);
            this.il.MarkLabel(tryEnd);

            this.il.MarkLabel(handlerStart);
            this.il.OpCode(ILOpCode.Pop);
            this.EmitZeroInit(resultSlot, chType.ElementType, elementClr);
            this.il.Branch(ILOpCode.Leave, endLabel);
            this.il.MarkLabel(handlerEnd);

            this.il.MarkLabel(endLabel);

            var catchTypeHandle = (EntityHandle)this.outer.GetTypeReference(ccExceptionClr);
            this.il.ControlFlowBuilder.AddCatchRegion(tryStart, tryEnd, handlerStart, handlerEnd, catchTypeHandle);

            this.il.LoadLocal(resultSlot);
        }

        private void EmitChannelCloseExpression(BoundChannelCloseExpression node)
        {
            var chType = (ChannelTypeSymbol)node.Channel.Type;
            var elementClr = ResolveChannelElementClrType(chType.ElementType);
            var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
            var writerClr = typeof(System.Threading.Channels.ChannelWriter<>).MakeGenericType(elementClr);
            var getWriter = channelClr.GetProperty("Writer").GetGetMethod();
            var complete = writerClr.GetMethod("Complete", new[] { typeof(Exception) });

            this.EmitExpression(node.Channel);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(getWriter));
            this.il.OpCode(ILOpCode.Ldnull);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(complete));
        }

        private void EmitCancellationTokenNone()
        {
            // ldc.i4.0; newobj CancellationToken(bool) — the canonical
            // "default" CancellationToken IL pattern. Avoids needing a
            // dedicated local for `default(CancellationToken)`.
            var ctCtor = typeof(System.Threading.CancellationToken).GetConstructor(new[] { typeof(bool) });
            this.il.LoadConstantI4(0);
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(ctCtor));
        }

        private void EmitZeroInit(int slot, TypeSymbol gsharpType, Type clrType)
        {
            if (clrType.IsValueType)
            {
                this.il.LoadLocalAddress(slot);
                this.il.OpCode(ILOpCode.Initobj);
                var initType = gsharpType.ClrType == null
                    ? TypeSymbol.FromClrType(clrType)
                    : gsharpType;
                this.il.Token(this.outer.GetElementTypeToken(initType));
            }
            else
            {
                this.il.OpCode(ILOpCode.Ldnull);
                this.il.StoreLocal(slot);
            }
        }
    }

    // Issue #420 (P3-7): structural cache key for MethodSpec rows whose generic
    // arguments include user-defined type symbols. Uses reference equality on the
    // contained TypeSymbol entries (declared user types are interned per
    // compilation), combined with structural equality on the array.
    private readonly struct MethodSpecSymbolKey : IEquatable<MethodSpecSymbolKey>
    {
        private readonly MethodInfo method;
        private readonly ImmutableArray<TypeSymbol> typeArgs;

        public MethodSpecSymbolKey(MethodInfo method, ImmutableArray<TypeSymbol> typeArgs)
        {
            this.method = method;
            this.typeArgs = typeArgs.IsDefault ? ImmutableArray<TypeSymbol>.Empty : typeArgs;
        }

        public bool Equals(MethodSpecSymbolKey other)
        {
            if (!ReferenceEquals(this.method, other.method))
            {
                return false;
            }

            if (this.typeArgs.Length != other.typeArgs.Length)
            {
                return false;
            }

            for (var i = 0; i < this.typeArgs.Length; i++)
            {
                if (!ReferenceEquals(this.typeArgs[i], other.typeArgs[i]))
                {
                    return false;
                }
            }

            return true;
        }

        public override bool Equals(object obj) => obj is MethodSpecSymbolKey other && this.Equals(other);

        public override int GetHashCode()
        {
            var hash = RuntimeHelpers.GetHashCode(this.method);
            for (var i = 0; i < this.typeArgs.Length; i++)
            {
                hash = unchecked((hash * 31) + RuntimeHelpers.GetHashCode(this.typeArgs[i]));
            }

            return hash;
        }
    }
}
