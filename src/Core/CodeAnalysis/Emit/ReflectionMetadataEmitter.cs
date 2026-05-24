// <copyright file="ReflectionMetadataEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Emits a managed PE for a <see cref="BoundProgram"/> using
/// <see cref="System.Reflection.Metadata"/> directly.
/// </summary>
/// <remarks>
/// Phase 2 (p2-langcov) coverage: locals, parameters, unary/binary operators,
/// assignments, label/goto/conditional-goto, user-defined function calls
/// (emitted as static methods on <c>&lt;Program&gt;</c>), and the imported-call
/// surface inherited from Phase 1. The pure-Roslyn-subclass backend in
/// <c>Gsharp.CodeAnalysis</c> remains the long-term home for cross-assembly
/// semantic-model needs.
/// </remarks>
internal sealed class ReflectionMetadataEmitter
{
    private readonly BoundProgram program;
    private readonly ReferenceResolver references;
    private readonly string assemblyNameOverride;
    private readonly MetadataBuilder metadata = new MetadataBuilder();
    private readonly Dictionary<Assembly, AssemblyReferenceHandle> assemblyRefs = new Dictionary<Assembly, AssemblyReferenceHandle>();
    private readonly Dictionary<Type, TypeReferenceHandle> typeRefs = new Dictionary<Type, TypeReferenceHandle>();
    private readonly Dictionary<Type, TypeSpecificationHandle> typeSpecs = new Dictionary<Type, TypeSpecificationHandle>();
    private readonly Dictionary<MethodInfo, MemberReferenceHandle> methodRefs = new Dictionary<MethodInfo, MemberReferenceHandle>();
    private readonly Dictionary<MethodInfo, MethodSpecificationHandle> methodSpecs = new Dictionary<MethodInfo, MethodSpecificationHandle>();
    private readonly Dictionary<ConstructorInfo, MemberReferenceHandle> ctorRefs = new Dictionary<ConstructorInfo, MemberReferenceHandle>();
    private readonly Dictionary<FieldInfo, MemberReferenceHandle> fieldRefs = new Dictionary<FieldInfo, MemberReferenceHandle>();
    private readonly Dictionary<FunctionSymbol, MethodDefinitionHandle> functionHandles = new Dictionary<FunctionSymbol, MethodDefinitionHandle>();
    private readonly MethodBodyStreamEncoder methodBodyStream;
    private readonly BlobBuilder ilStream = new BlobBuilder();

    private readonly bool metadataOnly;

    private readonly Dictionary<StructSymbol, TypeDefinitionHandle> structTypeDefs = new Dictionary<StructSymbol, TypeDefinitionHandle>();
    private readonly Dictionary<FieldSymbol, FieldDefinitionHandle> structFieldDefs = new Dictionary<FieldSymbol, FieldDefinitionHandle>();
    private readonly Dictionary<StructSymbol, MethodDefinitionHandle> classCtorHandles = new Dictionary<StructSymbol, MethodDefinitionHandle>();
    private readonly Dictionary<StructSymbol, MethodDefinitionHandle> classPrimaryCtorHandles = new Dictionary<StructSymbol, MethodDefinitionHandle>();

    // Phase 3.B.4: user-defined interface TypeDefs.
    private readonly Dictionary<InterfaceSymbol, TypeDefinitionHandle> interfaceTypeDefs = new Dictionary<InterfaceSymbol, TypeDefinitionHandle>();

    // Phase 3.B.3 sub-step 2b: instance methods on user-defined classes.
    private readonly Dictionary<FunctionSymbol, MethodDefinitionHandle> methodHandles = new Dictionary<FunctionSymbol, MethodDefinitionHandle>();

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
    private int closureCounter;

    private Type coreObjectType;
    private Type coreStringType;
    private Type coreInt32Type;
    private Type coreBooleanType;
    private Type coreArrayType;
    private Type coreValueType;
    private TypeReferenceHandle objectTypeRef;
    private TypeReferenceHandle valueTypeRef;
    private MemberReferenceHandle objectCtorRef;
    private MemberReferenceHandle stringConcatRef;
    private MemberReferenceHandle stringEqualsRef;
    private MemberReferenceHandle objectStaticEqualsRef;
    private MemberReferenceHandle objectInstanceToStringRef;
    private MemberReferenceHandle objectInstanceGetHashCodeRef;
    private MemberReferenceHandle nullRefExceptionCtorRef;

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
    public static void Emit(
        BoundProgram program,
        Stream peStream,
        ReferenceResolver references = null,
        string assemblyName = null,
        bool metadataOnly = false)
    {
        var emitter = new ReflectionMetadataEmitter(program, references, assemblyName, metadataOnly);
        emitter.EmitCore(peStream);
    }

    private void EmitCore(Stream peStream)
    {
        // 1. Seed Object reference. Resolve from the supplied references so the type-ref
        //    assembly identity (mscorlib / System.Runtime / netstandard) matches the
        //    target framework rather than the gsc host's System.Private.CoreLib.
        this.coreObjectType = this.ResolveCoreType("System.Object", typeof(object));
        this.coreStringType = this.ResolveCoreType("System.String", typeof(string));
        this.coreInt32Type = this.ResolveCoreType("System.Int32", typeof(int));
        this.coreBooleanType = this.ResolveCoreType("System.Boolean", typeof(bool));
        this.coreArrayType = this.ResolveCoreType("System.Array", typeof(System.Array));
        this.coreValueType = this.ResolveCoreType("System.ValueType", typeof(System.ValueType));
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

        // Phase 3.B.4: user-defined interface TypeDefs (planned below).
        // Synthesized closure classes are appended after user aggregates so
        // their TypeDefs come last among the class block; field-row planning
        // walks the combined list so closure fields get well-defined rows.
        var allAggregates = this.program.Structs;
        if (this.synthesizedClosureClasses.Count > 0)
        {
            allAggregates = allAggregates.AddRange(this.synthesizedClosureClasses);
        }

        var classes = allAggregates.Where(s => s.IsClass).ToList();
        var structs = allAggregates.Where(s => !s.IsClass).ToList();
        var interfaces = this.program.Interfaces;

        // TypeDef row order: <Module>, interfaces (each owns abstract method
        // rows), classes (each owns ctor rows + methods), structs (receiver
        // methods only), <Program>s. Field-row planning is independent of
        // methods so we walk allAggregates in their original order; the
        // methodList re-planning is what requires interfaces before classes
        // before structs (non-decreasing methodList rule per ECMA-335).
        int nextFieldRow = 1;
        var structFirstFieldRow = new Dictionary<StructSymbol, int>();
        foreach (var s in allAggregates)
        {
            structFirstFieldRow[s] = nextFieldRow;
            nextFieldRow += s.Fields.Length;
        }

        int totalStructFields = nextFieldRow - 1;
        var moduleFirstFieldRow = allAggregates.IsDefaultOrEmpty ? 1 : 1;
        var programFirstFieldRow = totalStructFields + 1;

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
        }

        // Plan method rows for class ctors next. Each class always owns a
        // parameterless default ctor (so `Foo{}` composite literal continues
        // to work) and, when a primary constructor was declared, a second
        // parameterized ctor immediately after it. Rows are non-decreasing
        // per ECMA-335: class TypeDef.methodList points at the class's
        // default ctor row, and the methods are emitted in this row order.
        var classCtorRows = new Dictionary<StructSymbol, int>();
        var classPrimaryCtorRows = new Dictionary<StructSymbol, int>();
        var aggregateMethodHandles = new Dictionary<FunctionSymbol, MethodDefinitionHandle>();
        foreach (var c in classes)
        {
            classCtorRows[c] = methodRow++;
            if (c.HasPrimaryConstructor)
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
        }

        var structFirstMethodRows = new Dictionary<StructSymbol, int>();
        foreach (var s in structs)
        {
            if (s.Methods.IsDefaultOrEmpty && !s.IsInline)
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
            foreach (var m in i.Methods)
            {
                this.EmitAbstractMethod(m);
            }
        }

        // 2b. Emit class TypeDefs (so methodLists stay non-decreasing), then
        // struct TypeDefs. Class TypeDefs' methodList points at the class's
        // preassigned ctor row; struct TypeDefs point at their first receiver
        // method row when present, otherwise at the package method block.
        foreach (var c in classes)
        {
            this.EmitStructTypeDef(c, structFirstFieldRow[c], classCtorRows[c]);

            // Phase 3.B.4: emit InterfaceImpl rows for each user-defined
            // interface implemented by this class. The metadata API requires
            // interfaces to be added in numerical order per class, which we
            // get for free by walking structSym.Interfaces in source order.
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

        foreach (var s in structs)
        {
            var methodListRow = structFirstMethodRows.TryGetValue(s, out var firstStructMethodRow)
                ? firstStructMethodRow
                : firstPackageCtorRow;
            this.EmitStructTypeDef(s, structFirstFieldRow[s], methodListRow);
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

        // Plan method rows AND remember each package's ctor row (the methodList
        // pointer on its <Program> TypeDef). Pre-assign function handles so
        // call sites can be encoded before bodies are written. Class default
        // ctors already occupy rows 1..K, so package ctors start at K+1.
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

        MethodDefinitionHandle entryHandle = default;
        if (this.program.EntryPoint is not null)
        {
            entryHandle = this.functionHandles[this.program.EntryPoint];
        }

        // 4. Emit method definitions in row order. Class default ctors come
        // first (rows 1..K), then per-package ctor + functions + entry point.
        foreach (var c in classes)
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

        foreach (var s in structs)
        {
            if (s.IsInline)
            {
                this.EmitInlineStructSynthesizedMembers(s);
            }

            if (s.Methods.IsDefaultOrEmpty)
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
        }

        // Phase 4 emit parity (F2, type-erased): now that every generic
        // definition has its TypeDef + FieldDefs + ctor handles in the
        // lookup dictionaries, walk the bound program for constructed
        // StructSymbols (Box[int], Pair[string, int], ...) and alias them
        // to their definitions' rows.
        this.RegisterConstructedTypeAliases();

        foreach (var pkg in packages)
        {
            var pkgCtor = this.EmitDefaultConstructor();

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

            // 5. <Program> type definition for this package — namespace = package name.
            this.metadata.AddTypeDefinition(
                attributes: TypeAttributes.Class | TypeAttributes.Public | TypeAttributes.AutoLayout
                    | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit,
                @namespace: this.metadata.GetOrAddString(pkg.Name),
                name: this.metadata.GetOrAddString("<Program>"),
                baseType: this.objectTypeRef,
                fieldList: MetadataTokens.FieldDefinitionHandle(programFirstFieldRow),
                methodList: pkgCtor);
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
            version: new Version(1, 0, 0, 0),
            culture: default(StringHandle),
            publicKey: default(BlobHandle),
            flags: 0,
            hashAlgorithm: AssemblyHashAlgorithm.Sha1);

        if (this.metadataOnly)
        {
            this.EmitReferenceAssemblyAttribute(assemblyHandle);
        }

        // 7. Serialize PE deterministically: a SHA-256 of the serialized PE
        // content produces the BlobContentId, which patches both the PE
        // TimeDateStamp and the reserved MVID guid in the metadata heap.
        var peHeaderBuilder = new PEHeaderBuilder(
            imageCharacteristics: entryHandle.IsNil
                ? Characteristics.Dll | Characteristics.ExecutableImage
                : Characteristics.ExecutableImage);
        var peBuilder = new ManagedPEBuilder(
            header: peHeaderBuilder,
            metadataRootBuilder: new MetadataRootBuilder(this.metadata),
            ilStream: this.ilStream,
            entryPoint: this.metadataOnly ? default : entryHandle,
            deterministicIdProvider: ComputeDeterministicContentId);
        var peBlob = new BlobBuilder();
        var contentId = peBuilder.Serialize(peBlob);
        mvidFixup.CreateWriter().WriteGuid(contentId.Guid);
        peBlob.WriteContentTo(peStream);
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
            if (structSym.BaseClass != null && this.structTypeDefs.TryGetValue(structSym.BaseClass, out var baseHandle))
            {
                baseType = baseHandle;
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
    }

    /// <summary>Emits <c>System.Runtime.CompilerServices.IsReadOnlyAttribute</c> on an inline struct TypeDef.</summary>
    /// <param name="typeHandle">The inline struct TypeDef handle.</param>
    private void EmitIsReadOnlyAttribute(TypeDefinitionHandle typeHandle)
    {
        var attrType = this.references.TryResolveType("System.Runtime.CompilerServices.IsReadOnlyAttribute", out var resolved)
            ? resolved
            : typeof(System.Runtime.CompilerServices.IsReadOnlyAttribute);
        var attrTypeRef = this.GetTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });

        var ctorRef = this.metadata.AddMemberReference(
            attrTypeRef,
            this.metadata.GetOrAddString(".ctor"),
            this.metadata.GetOrAddBlob(ctorSig));

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        valueBlob.WriteUInt16(0);

        this.metadata.AddCustomAttribute(
            parent: typeHandle,
            constructor: ctorRef,
            value: this.metadata.GetOrAddBlob(valueBlob));
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
            parameterList: MetadataTokens.ParameterHandle(1));
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
            parameterList: MetadataTokens.ParameterHandle(1));
    }

    /// <summary>Resolves the <c>.ctor()</c> token a derived class's ctor should chain to: either the base class's default ctor (already emitted) or <see cref="objectCtorRef"/>.</summary>
    private EntityHandle GetBaseCtorToken(StructSymbol classSym)
    {
        if (classSym.BaseClass != null && this.classCtorHandles.TryGetValue(classSym.BaseClass, out var baseCtor))
        {
            return baseCtor;
        }

        return this.objectCtorRef;
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
            parameterList: MetadataTokens.ParameterHandle(1));
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
        this.metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.metadata.GetOrAddString("Equals"), this.metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), MetadataTokens.ParameterHandle(1));
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
        this.metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.metadata.GetOrAddString("Equals"), this.metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), MetadataTokens.ParameterHandle(1));
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
        this.metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.metadata.GetOrAddString("GetHashCode"), this.metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), MetadataTokens.ParameterHandle(1));
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
        this.metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.metadata.GetOrAddString("ToString"), this.metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), MetadataTokens.ParameterHandle(1));
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
        this.metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.SpecialName | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.metadata.GetOrAddString(isInequality ? "op_Inequality" : "op_Equality"), this.metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), MetadataTokens.ParameterHandle(1));
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
        this.metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.metadata.GetOrAddString("Deconstruct"), this.metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), MetadataTokens.ParameterHandle(1));
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
            parameterList: MetadataTokens.ParameterHandle(1));
    }

    private MethodDefinitionHandle EmitFunction(FunctionSymbol function, BoundBlockStatement body, bool isEntryPoint)
    {
        // Phase 4 emit parity (F1): generic functions are emitted with a
        // type-erased signature — each open type parameter is encoded as
        // System.Object via EncodeTypeSymbol. Call sites insert the box /
        // unbox.any around the boundary. This matches the interpreter's
        // type-erased semantics. ADR-0004 still calls for CLR reified
        // generics as the long-term goal; F2 will widen to GenericParam +
        // MVAR/VAR encoding and add a MethodSpec at call sites.
        int bodyOffset = -1;
        if (!this.metadataOnly)
        {
            var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());

            // Pre-scan body for locals (top-level only — Lowerer flattens blocks) and labels.
            var locals = new Dictionary<VariableSymbol, int>();
            var labels = new Dictionary<BoundLabel, LabelHandle>();
            var localTypes = new List<TypeSymbol>();
            var appendSlots = new Dictionary<BoundAppendExpression, (int Src, int Dst)>();
            var structLiteralSlots = new Dictionary<BoundStructLiteralExpression, int>();
            var mapIndexSlots = new Dictionary<BoundIndexExpression, int>();
            var patternSwitchSlots = new Dictionary<BoundPatternSwitchStatement, int>();
            var typePatternScratchSlots = new Dictionary<BoundTypePattern, int>();
            var switchExpressionSlots = new Dictionary<BoundSwitchExpression, (int Result, int Discriminant)>();
            var channelOpSlots = new Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)>();
            var scopeFrameSlots = new Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)>();
            var goEnclosingScopes = new Dictionary<BoundGoStatement, BoundScopeStatement>();
            CollectLocalsAndLabels(
                body,
                function,
                locals,
                localTypes,
                labels,
                appendSlots,
                structLiteralSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                goEnclosingScopes,
                il);

            // Parameters → arg indices.
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

            var emitter = new BodyEmitter(
                this,
                il,
                locals,
                parameters,
                labels,
                appendSlots,
                structLiteralSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                goEnclosingScopes);
            emitter.EmitBlock(body);

            // Always cap with a trailing ret. Lowering does not guarantee one for void.
            if (function.Type == TypeSymbol.Void)
            {
                il.OpCode(ILOpCode.Ret);
            }

            bodyOffset = this.methodBodyStream.AddMethodBody(il, localVariablesSignature: localsSignature);
        }

        var sigBlob = new BlobBuilder();
        var signatureParameterCount = function.Parameters.Length - (function.ExplicitReceiverParameter == null ? 0 : 1);
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: function.IsInstanceMethod)
            .Parameters(
                signatureParameterCount,
                r => EncodeReturnSymbol(r, function.Type),
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
        // models open/override per ADR-0017:
        //   plain (neither):    Virtual | NewSlot | Final  (callvirt-safe, non-overridable)
        //   open:               Virtual | NewSlot          (overridable in derived)
        //   override (sealed):  Virtual | Final            (reuses base slot, no further override)
        //   open override:      Virtual                    (reuses base slot, still overridable)
        var methodAttrs = visibility | MethodAttributes.HideBySig;
        if (function.IsInstanceMethod)
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
        else
        {
            methodAttrs |= MethodAttributes.Static;
        }

        var handle = this.metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString(methodName),
            signature: this.metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: MetadataTokens.ParameterHandle(1));

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

    private static void CollectLocalsAndLabels(
        BoundBlockStatement body,
        FunctionSymbol function,
        Dictionary<VariableSymbol, int> locals,
        List<TypeSymbol> localTypes,
        Dictionary<BoundLabel, LabelHandle> labels,
        Dictionary<BoundAppendExpression, (int Src, int Dst)> appendSlots,
        Dictionary<BoundStructLiteralExpression, int> structLiteralSlots,
        Dictionary<BoundIndexExpression, int> mapIndexSlots,
        Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots,
        Dictionary<BoundTypePattern, int> typePatternScratchSlots,
        Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots,
        Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots,
        Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots,
        Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes,
        InstructionEncoder il)
    {
        CollectStatements(body.Statements, function, locals, localTypes, labels, appendSlots, il, pass: 1);
        CollectBlockExpressionLocals(body, locals, localTypes);
        CollectStatements(body.Statements, function, locals, localTypes, labels, appendSlots, il, pass: 2);

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
            structLiteralSlots[literal] = slot;
        }

        // Phase 3.A.4 emit: each map index READ lowers to a Dictionary.TryGetValue
        // pattern that needs a V-typed scratch local for the out parameter so that
        // missing keys yield the Go zero value (matching the interpreter).
        foreach (var idx in CollectMapIndexReads(body))
        {
            var slot = localTypes.Count;
            localTypes.Add(idx.Type);
            mapIndexSlots[idx] = slot;
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
    private static void CollectPatternSwitchSlots(
        ImmutableArray<BoundStatement> statements,
        Dictionary<VariableSymbol, int> locals,
        List<TypeSymbol> localTypes,
        Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots,
        Dictionary<BoundTypePattern, int> typePatternScratchSlots,
        Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots,
        Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots,
        Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots,
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
                goEnclosingScopes,
                currentScope: null);
        }
    }

    private static void WalkForPatternSwitches(
        BoundStatement statement,
        Dictionary<VariableSymbol, int> locals,
        List<TypeSymbol> localTypes,
        Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots,
        Dictionary<BoundTypePattern, int> typePatternScratchSlots,
        Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots,
        Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots,
        Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots,
        Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes,
        BoundScopeStatement currentScope)
    {
        switch (statement)
        {
            case BoundPatternSwitchStatement ps:
                {
                    var discriminantSlot = localTypes.Count;
                    localTypes.Add(ps.Discriminant.Type);
                    patternSwitchSlots[ps] = discriminantSlot;
                    WalkExpressionForSwitches(ps.Discriminant, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                    foreach (var arm in ps.Arms)
                    {
                        if (arm.Pattern != null)
                        {
                            AllocatePatternBindings(arm.Pattern, locals, localTypes, typePatternScratchSlots);
                            WalkPatternForSwitchExpressions(arm.Pattern, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                        }

                        if (arm.Body is BoundBlockStatement armBlock)
                        {
                            foreach (var inner in armBlock.Statements)
                            {
                                if (inner is BoundVariableDeclaration decl && !locals.ContainsKey(decl.Variable))
                                {
                                    locals[decl.Variable] = localTypes.Count;
                                    localTypes.Add(decl.Variable.Type);
                                }

                                WalkForPatternSwitches(inner, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                            }
                        }
                        else
                        {
                            WalkForPatternSwitches(arm.Body, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                        }
                    }

                    break;
                }

            case BoundBlockStatement block:
                foreach (var inner in block.Statements)
                {
                    WalkForPatternSwitches(inner, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                }

                break;
            case BoundIfStatement ifs:
                WalkExpressionForSwitches(ifs.Condition, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                WalkForPatternSwitches(ifs.ThenStatement, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                if (ifs.ElseStatement != null)
                {
                    WalkForPatternSwitches(ifs.ElseStatement, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                }

                break;
            case BoundTryStatement tryStmt:
                WalkForPatternSwitches(tryStmt.TryBlock, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                foreach (var clause in tryStmt.CatchClauses)
                {
                    WalkForPatternSwitches(clause.Body, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                }

                if (tryStmt.FinallyBlock != null)
                {
                    WalkForPatternSwitches(tryStmt.FinallyBlock, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                }

                break;
            case BoundExpressionStatement es:
                WalkExpressionForSwitches(es.Expression, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                break;
            case BoundVariableDeclaration vd:
                WalkExpressionForSwitches(vd.Initializer, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                break;
            case BoundReturnStatement rs:
                if (rs.Expression != null)
                {
                    WalkExpressionForSwitches(rs.Expression, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                }

                break;
            case BoundConditionalGotoStatement cg:
                WalkExpressionForSwitches(cg.Condition, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                break;
            case BoundGoStatement go:
                if (currentScope != null)
                {
                    goEnclosingScopes[go] = currentScope;
                }

                WalkExpressionForSwitches(go.Expression, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                break;
            case BoundScopeStatement scope:
                AllocateScopeFrameSlots(scope, localTypes, scopeFrameSlots);
                WalkForPatternSwitches(scope.Body, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, scope);
                break;
            case BoundChannelSendStatement chs:
                AllocateChannelSendSlots(chs, localTypes, channelOpSlots);
                WalkExpressionForSwitches(chs.Channel, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                WalkExpressionForSwitches(chs.Value, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                break;
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

    // Walks any BoundExpression to discover nested BoundSwitchExpression nodes
    // (which can appear in let initializers, return values, call arguments,
    // arm result expressions of an enclosing switch expression, etc.). Each
    // discovered switch expression gets a result temp + discriminant temp
    // pre-allocated and its arms recurse so type-pattern scratches and
    // arm-locals are also reserved.
    private static void WalkExpressionForSwitches(
        BoundExpression expression,
        Dictionary<VariableSymbol, int> locals,
        List<TypeSymbol> localTypes,
        Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots,
        Dictionary<BoundTypePattern, int> typePatternScratchSlots,
        Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots,
        Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots,
        Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots,
        Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes,
        BoundScopeStatement currentScope)
    {
        if (expression == null)
        {
            return;
        }

        switch (expression)
        {
            case BoundSwitchExpression sx:
                if (!switchExpressionSlots.ContainsKey(sx))
                {
                    var resultSlot = localTypes.Count;
                    localTypes.Add(sx.Type);
                    var discrSlot = localTypes.Count;
                    localTypes.Add(sx.Discriminant.Type);
                    switchExpressionSlots[sx] = (resultSlot, discrSlot);
                }

                WalkExpressionForSwitches(sx.Discriminant, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                foreach (var arm in sx.Arms)
                {
                    if (arm.Pattern != null)
                    {
                        AllocatePatternBindings(arm.Pattern, locals, localTypes, typePatternScratchSlots);
                        WalkPatternForSwitchExpressions(arm.Pattern, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                    }

                    WalkExpressionForSwitches(arm.Result, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                }

                break;
            case BoundBinaryExpression be:
                WalkExpressionForSwitches(be.Left, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                WalkExpressionForSwitches(be.Right, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                break;
            case BoundUnaryExpression ue:
                WalkExpressionForSwitches(ue.Operand, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                break;
            case BoundAssignmentExpression ae:
                WalkExpressionForSwitches(ae.Expression, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                break;
            case BoundCallExpression ce:
                foreach (var a in ce.Arguments)
                {
                    WalkExpressionForSwitches(a, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                }

                break;
            case BoundConversionExpression cv:
                WalkExpressionForSwitches(cv.Expression, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                break;
            case BoundBlockExpression bex:
                foreach (var s in bex.Statements)
                {
                    WalkForPatternSwitches(s, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                }

                WalkExpressionForSwitches(bex.Expression, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                break;
            case BoundChannelReceiveExpression chr:
                AllocateChannelReceiveSlots(chr, localTypes, channelOpSlots);
                WalkExpressionForSwitches(chr.Channel, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                break;
            case BoundChannelCloseExpression chc:
                WalkExpressionForSwitches(chc.Channel, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                break;
            case BoundMakeChannelExpression mkCh:
                if (mkCh.Capacity != null)
                {
                    WalkExpressionForSwitches(mkCh.Capacity, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                }

                break;
        }
    }

    private static void WalkPatternForSwitchExpressions(
        BoundPattern pattern,
        Dictionary<VariableSymbol, int> locals,
        List<TypeSymbol> localTypes,
        Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots,
        Dictionary<BoundTypePattern, int> typePatternScratchSlots,
        Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots,
        Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots,
        Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots,
        Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes,
        BoundScopeStatement currentScope)
    {
        switch (pattern)
        {
            case BoundConstantPattern cp:
                WalkExpressionForSwitches(cp.Value, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                break;
            case BoundRelationalPattern rp:
                WalkExpressionForSwitches(rp.Value, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                break;
            case BoundPropertyPattern pp:
                foreach (var f in pp.Fields)
                {
                    WalkPatternForSwitchExpressions(f.Pattern, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                }

                break;
            case BoundListPattern lp:
                foreach (var e in lp.Elements)
                {
                    WalkPatternForSwitchExpressions(e, locals, localTypes, patternSwitchSlots, typePatternScratchSlots, switchExpressionSlots, channelOpSlots, scopeFrameSlots, goEnclosingScopes, currentScope);
                }

                break;
        }
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
            var body = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(go.Expression)));
            var closureName = "<go_" + System.Threading.Interlocked.Increment(ref this.closureCounter).ToString(System.Globalization.CultureInfo.InvariantCulture) + ">";
            var info = this.SynthesizeDisplayClass(
                closureName,
                captured,
                ImmutableArray<ParameterSymbol>.Empty,
                TypeSymbol.Void,
                body,
                hostPackage,
                invokeName: "InvokeAction");

            this.goClosureInfos[go] = info;
        }
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
        switch (node)
        {
            case BoundStructLiteralExpression literal:
                sink.Add(literal);
                foreach (var init in literal.Initializers)
                {
                    WalkForStructLiterals(init.Value, sink);
                }

                break;
            case BoundBlockExpression blockExpr:
                foreach (var statement in blockExpr.Statements)
                {
                    WalkForStructLiterals(statement, sink);
                }

                WalkForStructLiterals(blockExpr.Expression, sink);
                break;
            case BoundFieldAccessExpression fa:
                WalkForStructLiterals(fa.Receiver, sink);
                break;
            case BoundFieldAssignmentExpression fas:
                WalkForStructLiterals(fas.Value, sink);
                break;
            case BoundExpressionStatement es:
                WalkForStructLiterals(es.Expression, sink);
                break;
            case BoundVariableDeclaration decl:
                WalkForStructLiterals(decl.Initializer, sink);
                break;
            case BoundReturnStatement ret:
                if (ret.Expression != null)
                {
                    WalkForStructLiterals(ret.Expression, sink);
                }

                break;
            case BoundConditionalGotoStatement cg:
                WalkForStructLiterals(cg.Condition, sink);
                break;
            case BoundAssignmentExpression a:
                WalkForStructLiterals(a.Expression, sink);
                break;
            case BoundUnaryExpression u:
                WalkForStructLiterals(u.Operand, sink);
                break;
            case BoundBinaryExpression b:
                WalkForStructLiterals(b.Left, sink);
                WalkForStructLiterals(b.Right, sink);
                break;
            case BoundCallExpression c:
                foreach (var arg in c.Arguments)
                {
                    WalkForStructLiterals(arg, sink);
                }

                break;
            case BoundImportedCallExpression ic:
                foreach (var arg in ic.Arguments)
                {
                    WalkForStructLiterals(arg, sink);
                }

                break;
            case BoundImportedInstanceCallExpression iic:
                WalkForStructLiterals(iic.Receiver, sink);
                foreach (var arg in iic.Arguments)
                {
                    WalkForStructLiterals(arg, sink);
                }

                break;
            case BoundUserInstanceCallExpression uic:
                WalkForStructLiterals(uic.Receiver, sink);
                foreach (var arg in uic.Arguments)
                {
                    WalkForStructLiterals(arg, sink);
                }

                break;
            case BoundConstructorCallExpression cce:
                foreach (var arg in cce.Arguments)
                {
                    WalkForStructLiterals(arg, sink);
                }

                break;
            case BoundConversionExpression conv:
                WalkForStructLiterals(conv.Expression, sink);
                break;
            case BoundArrayCreationExpression arr:
                foreach (var e in arr.Elements)
                {
                    WalkForStructLiterals(e, sink);
                }

                break;
            case BoundIndexExpression ix:
                WalkForStructLiterals(ix.Target, sink);
                WalkForStructLiterals(ix.Index, sink);
                break;
            case BoundIndexAssignmentExpression ixa:
                WalkForStructLiterals(ixa.Index, sink);
                WalkForStructLiterals(ixa.Value, sink);
                break;
            case BoundTryStatement t:
                foreach (var st in ((BoundBlockStatement)t.TryBlock).Statements)
                {
                    WalkForStructLiterals(st, sink);
                }

                foreach (var clause in t.CatchClauses)
                {
                    foreach (var st in ((BoundBlockStatement)clause.Body).Statements)
                    {
                        WalkForStructLiterals(st, sink);
                    }
                }

                if (t.FinallyBlock != null)
                {
                    foreach (var st in ((BoundBlockStatement)t.FinallyBlock).Statements)
                    {
                        WalkForStructLiterals(st, sink);
                    }
                }

                break;
            case BoundThrowStatement th:
                WalkForStructLiterals(th.Expression, sink);
                break;
        }
    }

    private static void CollectStatements(
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
                        CollectStatements(scBlock.Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        break;
                    case BoundTryStatement t:
                        CollectStatements(((BoundBlockStatement)t.TryBlock).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        foreach (var clause in t.CatchClauses)
                        {
                            if (!locals.ContainsKey(clause.Variable))
                            {
                                locals[clause.Variable] = localTypes.Count;
                                localTypes.Add(clause.Variable.Type);
                            }

                            CollectStatements(((BoundBlockStatement)clause.Body).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        }

                        if (t.FinallyBlock != null)
                        {
                            CollectStatements(((BoundBlockStatement)t.FinallyBlock).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        }

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
                        CollectStatements(scBlock.Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        break;
                    case BoundTryStatement t:
                        CollectStatements(((BoundBlockStatement)t.TryBlock).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        foreach (var clause in t.CatchClauses)
                        {
                            CollectStatements(((BoundBlockStatement)clause.Body).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        }

                        if (t.FinallyBlock != null)
                        {
                            CollectStatements(((BoundBlockStatement)t.FinallyBlock).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        }

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

    private static void WalkForAppends(BoundNode node, List<BoundAppendExpression> sink)
    {
        switch (node)
        {
            case BoundAppendExpression app:
                sink.Add(app);
                WalkForAppends(app.Slice, sink);
                WalkForAppends(app.Element, sink);
                break;
            case BoundBlockExpression blockExpr:
                foreach (var statement in blockExpr.Statements)
                {
                    WalkForAppends(statement, sink);
                }

                WalkForAppends(blockExpr.Expression, sink);
                break;
            case BoundLenExpression len:
                WalkForAppends(len.Operand, sink);
                break;
            case BoundCapExpression cap:
                WalkForAppends(cap.Operand, sink);
                break;
            case BoundBlockStatement blk:
                foreach (var s in blk.Statements)
                {
                    WalkForAppends(s, sink);
                }

                break;
            case BoundExpressionStatement es:
                WalkForAppends(es.Expression, sink);
                break;
            case BoundVariableDeclaration vd:
                WalkForAppends(vd.Initializer, sink);
                break;
            case BoundIfStatement ifs:
                WalkForAppends(ifs.Condition, sink);
                WalkForAppends(ifs.ThenStatement, sink);
                if (ifs.ElseStatement != null)
                {
                    WalkForAppends(ifs.ElseStatement, sink);
                }

                break;
            case BoundReturnStatement rs:
                if (rs.Expression != null)
                {
                    WalkForAppends(rs.Expression, sink);
                }

                break;
            case BoundTryStatement t:
                WalkForAppends(t.TryBlock, sink);
                foreach (var clause in t.CatchClauses)
                {
                    WalkForAppends(clause.Body, sink);
                }

                if (t.FinallyBlock != null)
                {
                    WalkForAppends(t.FinallyBlock, sink);
                }

                break;
            case BoundThrowStatement th:
                WalkForAppends(th.Expression, sink);
                break;
            case BoundConditionalGotoStatement cg:
                WalkForAppends(cg.Condition, sink);
                break;
            case BoundAssignmentExpression a:
                WalkForAppends(a.Expression, sink);
                break;
            case BoundUnaryExpression u:
                WalkForAppends(u.Operand, sink);
                break;
            case BoundBinaryExpression b:
                WalkForAppends(b.Left, sink);
                WalkForAppends(b.Right, sink);
                break;
            case BoundCallExpression c:
                foreach (var arg in c.Arguments)
                {
                    WalkForAppends(arg, sink);
                }

                break;
            case BoundImportedCallExpression ic:
                foreach (var arg in ic.Arguments)
                {
                    WalkForAppends(arg, sink);
                }

                break;
            case BoundImportedInstanceCallExpression iic:
                WalkForAppends(iic.Receiver, sink);
                foreach (var arg in iic.Arguments)
                {
                    WalkForAppends(arg, sink);
                }

                break;
            case BoundConversionExpression conv:
                WalkForAppends(conv.Expression, sink);
                break;
            case BoundArrayCreationExpression arr:
                foreach (var e in arr.Elements)
                {
                    WalkForAppends(e, sink);
                }

                break;
            case BoundIndexExpression ix:
                WalkForAppends(ix.Target, sink);
                WalkForAppends(ix.Index, sink);
                break;
            case BoundIndexAssignmentExpression ixa:
                WalkForAppends(ixa.Index, sink);
                WalkForAppends(ixa.Value, sink);
                break;
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
        switch (node)
        {
            case BoundNullConditionalAccessExpression nc:
                sink.Add(nc);
                WalkForNullConditional(nc.Receiver, sink);
                WalkForNullConditional(nc.WhenNotNull, sink);
                break;
            case BoundBlockExpression blockExpr:
                foreach (var statement in blockExpr.Statements)
                {
                    WalkForNullConditional(statement, sink);
                }

                WalkForNullConditional(blockExpr.Expression, sink);
                break;
            case BoundBlockStatement blk:
                foreach (var s in blk.Statements)
                {
                    WalkForNullConditional(s, sink);
                }

                break;
            case BoundExpressionStatement es:
                WalkForNullConditional(es.Expression, sink);
                break;
            case BoundVariableDeclaration vd:
                WalkForNullConditional(vd.Initializer, sink);
                break;
            case BoundIfStatement ifs:
                WalkForNullConditional(ifs.Condition, sink);
                WalkForNullConditional(ifs.ThenStatement, sink);
                if (ifs.ElseStatement != null)
                {
                    WalkForNullConditional(ifs.ElseStatement, sink);
                }

                break;
            case BoundReturnStatement rs:
                if (rs.Expression != null)
                {
                    WalkForNullConditional(rs.Expression, sink);
                }

                break;
            case BoundConditionalGotoStatement cg:
                WalkForNullConditional(cg.Condition, sink);
                break;
            case BoundThrowStatement th:
                WalkForNullConditional(th.Expression, sink);
                break;
            case BoundTryStatement t:
                WalkForNullConditional(t.TryBlock, sink);
                foreach (var clause in t.CatchClauses)
                {
                    WalkForNullConditional(clause.Body, sink);
                }

                if (t.FinallyBlock != null)
                {
                    WalkForNullConditional(t.FinallyBlock, sink);
                }

                break;
            case BoundAssignmentExpression a:
                WalkForNullConditional(a.Expression, sink);
                break;
            case BoundUnaryExpression u:
                WalkForNullConditional(u.Operand, sink);
                break;
            case BoundBinaryExpression b:
                WalkForNullConditional(b.Left, sink);
                WalkForNullConditional(b.Right, sink);
                break;
            case BoundCallExpression c:
                foreach (var arg in c.Arguments)
                {
                    WalkForNullConditional(arg, sink);
                }

                break;
            case BoundImportedCallExpression ic:
                foreach (var arg in ic.Arguments)
                {
                    WalkForNullConditional(arg, sink);
                }

                break;
            case BoundImportedInstanceCallExpression iic:
                WalkForNullConditional(iic.Receiver, sink);
                foreach (var arg in iic.Arguments)
                {
                    WalkForNullConditional(arg, sink);
                }

                break;
            case BoundUserInstanceCallExpression uic:
                WalkForNullConditional(uic.Receiver, sink);
                foreach (var arg in uic.Arguments)
                {
                    WalkForNullConditional(arg, sink);
                }

                break;
            case BoundConversionExpression conv:
                WalkForNullConditional(conv.Expression, sink);
                break;
            case BoundFieldAccessExpression fa:
                WalkForNullConditional(fa.Receiver, sink);
                break;
            case BoundFieldAssignmentExpression fas:
                WalkForNullConditional(fas.Value, sink);
                break;
        }
    }

    private EntityHandle GetElementTypeToken(TypeSymbol element)
    {
        if (element == TypeSymbol.Int)
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
            return this.GetTypeReference(element.ClrType);
        }

        if (element is StructSymbol structSym && this.structTypeDefs.TryGetValue(structSym, out var td))
        {
            return td;
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
                returnType: r => this.EncodeReturnClr(r, openForMethodGenerics.ReturnType),
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
        if (!method.IsGenericMethod || method.IsGenericMethodDefinition)
        {
            return this.GetMethodReference(method);
        }

        if (this.methodSpecs.TryGetValue(method, out var existing))
        {
            return existing;
        }

        var openDef = method.GetGenericMethodDefinition();
        var openRef = this.GetMethodReference(openDef);

        var sigBlob = new BlobBuilder();
        var argsEncoder = new BlobEncoder(sigBlob).MethodSpecificationSignature(method.GetGenericArguments().Length);
        foreach (var typeArg in method.GetGenericArguments())
        {
            this.EncodeClrType(argsEncoder.AddArgument(), typeArg);
        }

        var spec = this.metadata.AddMethodSpecification(openRef, this.metadata.GetOrAddBlob(sigBlob));
        this.methodSpecs[method] = spec;
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
                        this.EncodeClrType(ps.AddParameter().Type(), p.ParameterType);
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
            if (inner is StructSymbol nestedStruct && !nestedStruct.IsClass)
            {
                throw new NotSupportedException(
                    $"Nullable value-type signatures for '{inner.Name}?' are not yet supported by the emitter.");
            }

            if (inner == TypeSymbol.Int || inner == TypeSymbol.Bool || (inner?.ClrType != null && inner.ClrType.IsValueType))
            {
                throw new NotSupportedException(
                    $"Nullable value-type signatures for '{inner?.Name}?' are not yet supported by the emitter.");
            }

            EncodeTypeSymbol(encoder, inner);
            return;
        }

        if (type == TypeSymbol.Bool)
        {
            encoder.Boolean();
        }
        else if (type == TypeSymbol.Int)
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
        if (type == TypeSymbol.Int || type == TypeSymbol.Bool)
        {
            return true;
        }

        if (type is StructSymbol s && !s.IsClass)
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
            case "System.Int32":
                encoder.Int32();
                break;
            case "System.Int64":
                encoder.Int64();
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

                encoder.Type(this.GetTypeReference(type), isValueType: type.IsValueType);
                break;
        }
    }

    private void EncodeReturnClr(ReturnTypeEncoder encoder, Type type)
    {
        if (type?.FullName == "System.Void")
        {
            encoder.Void();
        }
        else
        {
            this.EncodeClrType(encoder.Type(), type);
        }
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
            args[i] = this.MapToReferenceClrType(fnType.ParameterTypes[i].ClrType);
        }

        if (!isVoid)
        {
            args[arity] = this.MapToReferenceClrType(fnType.ReturnType.ClrType);
        }

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
                    new BoundVariableExpression(this.thisParam),
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
                return new BoundFieldAssignmentExpression(this.thisParam, this.closureClass, field, value);
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
                : new BoundVariableDeclaration(node.Variable, initializer);
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
        private readonly Dictionary<BoundIndexExpression, int> mapIndexSlots;
        private readonly Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots;
        private readonly Dictionary<BoundTypePattern, int> typePatternScratchSlots;
        private readonly Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots;
        private readonly Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots;
        private readonly Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots;
        private readonly Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes;

        public BodyEmitter(
            ReflectionMetadataEmitter outer,
            InstructionEncoder il,
            Dictionary<VariableSymbol, int> locals,
            Dictionary<ParameterSymbol, int> parameters,
            Dictionary<BoundLabel, LabelHandle> labels,
            Dictionary<BoundAppendExpression, (int Src, int Dst)> appendSlots,
            Dictionary<BoundStructLiteralExpression, int> structLiteralSlots,
            Dictionary<BoundIndexExpression, int> mapIndexSlots,
            Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots,
            Dictionary<BoundTypePattern, int> typePatternScratchSlots,
            Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots,
            Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots,
            Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots,
            Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes)
        {
            this.outer = outer;
            this.il = il;
            this.locals = locals;
            this.parameters = parameters;
            this.labels = labels;
            this.appendSlots = appendSlots;
            this.structLiteralSlots = structLiteralSlots;
            this.mapIndexSlots = mapIndexSlots;
            this.patternSwitchSlots = patternSwitchSlots;
            this.typePatternScratchSlots = typePatternScratchSlots;
            this.switchExpressionSlots = switchExpressionSlots;
            this.channelOpSlots = channelOpSlots;
            this.scopeFrameSlots = scopeFrameSlots;
            this.goEnclosingScopes = goEnclosingScopes;
        }

        public void EmitBlock(BoundBlockStatement block)
        {
            foreach (var statement in block.Statements)
            {
                this.EmitStatement(statement);
            }
        }

        private void EmitBlockExpression(BoundBlockExpression blockExpression)
        {
            foreach (var statement in blockExpression.Statements)
            {
                this.EmitStatement(statement);
            }

            this.EmitExpression(blockExpression.Expression);
        }

        private void EmitStatement(BoundStatement statement)
        {
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
                    this.EmitExpression(decl.Initializer);
                    this.EmitStoreVariable(decl.Variable);
                    break;
                case BoundLabelStatement lbl:
                    this.il.MarkLabel(this.labels[lbl.Label]);
                    break;
                case BoundGotoStatement g:
                    this.il.Branch(ILOpCode.Br, this.labels[g.Label]);
                    break;
                case BoundConditionalGotoStatement cg:
                    this.EmitExpression(cg.Condition);
                    this.il.Branch(cg.JumpIfTrue ? ILOpCode.Brtrue : ILOpCode.Brfalse, this.labels[cg.Label]);
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
                default:
                    throw new NotSupportedException(
                        $"Bound statement kind '{statement.Kind}' is not yet supported by the emitter.");
            }
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

                    if (!this.outer.functionHandles.TryGetValue(call.Function, out var fnHandle))
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

                    break;
                case BoundImportedCallExpression impCall:
                    foreach (var arg in impCall.Arguments)
                    {
                        this.EmitExpression(arg);
                    }

                    this.il.Call(this.outer.GetMethodReference(impCall.Function.Method));
                    break;
                case BoundImportedInstanceCallExpression instCall:
                    this.EmitInstanceReceiver(instCall.Receiver);
                    foreach (var arg in instCall.Arguments)
                    {
                        this.EmitExpression(arg);
                    }

                    this.il.Call(this.outer.GetMethodReference(instCall.Method));
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
                        this.EmitLoadVariable(ixa.Target);
                        this.EmitExpression(ixa.Index);
                        this.EmitExpression(ixa.Value);
                        this.EmitStoreElement(ixa.Type);

                        // Result of an assignment expression is the assigned value.
                        this.EmitLoadVariable(ixa.Target);
                        this.EmitExpression(ixa.Index);
                        this.EmitLoadElement(ixa.Type);
                    }

                    break;
                case BoundLenExpression len:
                    this.EmitLen(len);
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
                case BoundNullConditionalAccessExpression nc:
                    this.EmitNullConditionalAccess(nc);
                    break;
                case BoundClrConstructorCallExpression clrCtor:
                    this.EmitClrConstructorCall(clrCtor);
                    break;
                case BoundClrPropertyAccessExpression clrProp:
                    this.EmitClrPropertyAccess(clrProp);
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
                case BoundIndirectCallExpression indirect:
                    this.EmitIndirectCall(indirect);
                    break;
                case BoundMapLiteralExpression mapLit:
                    this.EmitMapLiteral(mapLit);
                    break;
                case BoundMapDeleteExpression mapDel:
                    this.EmitMapDelete(mapDel);
                    break;
                default:
                    throw new NotSupportedException(
                        $"Bound expression kind '{expression.Kind}' is not yet supported by the emitter.");
            }
        }

        private void EmitConversion(BoundConversionExpression conv)
        {
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
            if (to == TypeSymbol.Int && from == TypeSymbol.Bool)
            {
                // bool already lives as i4 on the stack; no-op.
                return;
            }

            if (to == TypeSymbol.Bool && from == TypeSymbol.Int)
            {
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
                return;
            }

            if (from is StructSymbol fromStruct && !fromStruct.IsClass && to?.ClrType == typeof(object))
            {
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.GetElementTypeToken(fromStruct));
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

        private static bool IsReferenceCompatible(TypeSymbol a, TypeSymbol b)
        {
            if (a == b)
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

            return false;
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
                    this.il.OpCode(ILOpCode.Neg);
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
        }

        private void EmitBinary(BoundBinaryExpression b)
        {
            // Phase 3.C.3: `?:` (NullCoalesce). Short-circuit on the left.
            if (b.Op.Kind == BoundBinaryOperatorKind.NullCoalesce)
            {
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

            this.EmitExpression(b.Left);
            this.EmitExpression(b.Right);
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
                    this.il.OpCode(ILOpCode.Div);
                    break;
                case BoundBinaryOperatorKind.Remainder:
                    this.il.OpCode(ILOpCode.Rem);
                    break;
                case BoundBinaryOperatorKind.ShiftLeft:
                    this.il.OpCode(ILOpCode.Shl);
                    break;
                case BoundBinaryOperatorKind.ShiftRight:
                    this.il.OpCode(ILOpCode.Shr);
                    break;
                case BoundBinaryOperatorKind.BitwiseAnd:
                case BoundBinaryOperatorKind.LogicalAnd:
                    this.il.OpCode(ILOpCode.And);
                    break;
                case BoundBinaryOperatorKind.BitwiseOr:
                case BoundBinaryOperatorKind.LogicalOr:
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
                    this.il.OpCode(ILOpCode.Clt);
                    break;
                case BoundBinaryOperatorKind.LessOrEquals:
                    this.il.OpCode(ILOpCode.Cgt);
                    this.il.LoadConstantI4(0);
                    this.il.OpCode(ILOpCode.Ceq);
                    break;
                case BoundBinaryOperatorKind.Greater:
                    this.il.OpCode(ILOpCode.Cgt);
                    break;
                case BoundBinaryOperatorKind.GreaterOrEquals:
                    this.il.OpCode(ILOpCode.Clt);
                    this.il.LoadConstantI4(0);
                    this.il.OpCode(ILOpCode.Ceq);
                    break;
                default:
                    throw new NotSupportedException(
                        $"Binary operator '{b.Op.Kind}' is not yet supported by the emitter.");
            }
        }

        private void EmitLoadVariable(VariableSymbol variable)
        {
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

            throw new InvalidOperationException(
                $"Variable '{variable.Name}' has no local slot or parameter index in the current method.");
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
                case int i:
                    this.il.LoadConstantI4(i);
                    break;
                case bool b:
                    this.il.LoadConstantI4(b ? 1 : 0);
                    break;
                default:
                    throw new NotSupportedException(
                        $"Literal of CLR type '{literal.Value?.GetType()}' is not yet supported.");
            }
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
            if (elementType == TypeSymbol.Int)
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
            if (elementType == TypeSymbol.Int)
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
                this.EmitBlock((BoundBlockStatement)node.TryBlock);
                var innerTryEnd = this.il.DefineLabel();
                this.il.Branch(ILOpCode.Leave, endLabel);
                this.il.MarkLabel(innerTryEnd);

                this.EmitCatchClauses(node.CatchClauses, innerTryStart, innerTryEnd, leaveTarget: endLabel);

                this.il.MarkLabel(finallyStart);
                this.EmitBlock((BoundBlockStatement)node.FinallyBlock);
                this.il.OpCode(ILOpCode.Endfinally);
                this.il.MarkLabel(finallyEnd);

                this.il.ControlFlowBuilder.AddFinallyRegion(outerTryStart, finallyStart, finallyStart, finallyEnd);
            }
            else if (hasCatches)
            {
                var tryStart = this.il.DefineLabel();
                this.il.MarkLabel(tryStart);
                this.EmitBlock((BoundBlockStatement)node.TryBlock);
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
                this.EmitBlock((BoundBlockStatement)node.TryBlock);
                this.il.Branch(ILOpCode.Leave, finallyEnd);

                this.il.MarkLabel(finallyStart);
                this.EmitBlock((BoundBlockStatement)node.FinallyBlock);
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
                this.EmitStoreVariable(clause.Variable);

                this.EmitBlock((BoundBlockStatement)clause.Body);
                this.il.Branch(ILOpCode.Leave, leaveTarget);
                this.il.MarkLabel(handlerEnd);

                var catchTypeHandle = (EntityHandle)this.outer.GetTypeReference(clause.ExceptionType.ClrType);
                this.il.ControlFlowBuilder.AddCatchRegion(tryStart, tryEnd, handlerStart, handlerEnd, catchTypeHandle);
            }
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

        private void EmitAppend(BoundAppendExpression app)
        {
            var slots = this.appendSlots[app];
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
            foreach (var arg in call.Arguments)
            {
                this.EmitExpression(arg);
            }

            var receiverIsValueType = call.Method.ReceiverType is StructSymbol receiverStruct && !receiverStruct.IsClass;
            this.il.OpCode(receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
            this.il.Token(methodHandle);
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
            // The expression result is the assigned value, so re-read via get_Item
            // after the store — set_Item is void and we don't have a scratch slot
            // for v here. The re-read uses get_Item (not TryGetValue) because the
            // key is guaranteed to be present after the set.
            var mapType = (MapTypeSymbol)ixa.Target.Type;
            var dictType = mapType.ClrType;
            var setItem = dictType.GetMethod("set_Item")
                ?? throw new InvalidOperationException(
                    $"Dictionary type '{dictType.FullName}' has no set_Item method.");
            var getItem = dictType.GetMethod("get_Item")
                ?? throw new InvalidOperationException(
                    $"Dictionary type '{dictType.FullName}' has no get_Item method.");

            this.EmitLoadVariable(ixa.Target);
            this.EmitExpression(ixa.Index);
            this.EmitExpression(ixa.Value);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(setItem));

            this.EmitLoadVariable(ixa.Target);
            this.EmitExpression(ixa.Index);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(getItem));
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
                    this.il.OpCode(ILOpCode.Clt);
                    break;
                case BoundBinaryOperatorKind.LessOrEquals:
                    this.il.OpCode(ILOpCode.Cgt);
                    this.il.LoadConstantI4(0);
                    this.il.OpCode(ILOpCode.Ceq);
                    break;
                case BoundBinaryOperatorKind.Greater:
                    this.il.OpCode(ILOpCode.Cgt);
                    break;
                case BoundBinaryOperatorKind.GreaterOrEquals:
                    this.il.OpCode(ILOpCode.Clt);
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

        private void EmitClrConstructorCall(BoundClrConstructorCallExpression ctorCall)
        {
            // Phase 4 emit parity: `newobj` against a CLR ctor. Handles both
            // non-generic types and constructed generic types — the parent of
            // the MemberRef becomes a TypeSpec for the latter, encoded in
            // `GetCtorReference` / `GetTypeHandleForMember`.
            foreach (var arg in ctorCall.Arguments)
            {
                this.EmitExpression(arg);
            }

            var ctorRef = this.outer.GetCtorReference(ctorCall.Constructor);
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(ctorRef);
        }

        private void EmitClrPropertyAccess(BoundClrPropertyAccessExpression access)
        {
            // Phase 4 emit parity: instance property/field read on a CLR
            // receiver. Properties dispatch to their `get_X` accessor;
            // fields use `ldfld`. Generic-instantiated declaring types are
            // handled by `GetMethodReference` / `GetFieldReference`.
            this.EmitInstanceReceiver(access.Receiver);
            var receiverIsValueType = access.Receiver.Type?.ClrType?.IsValueType == true;
            switch (access.Member)
            {
                case PropertyInfo property:
                    var getter = property.GetGetMethod(nonPublic: false)
                        ?? throw new InvalidOperationException(
                            $"Property '{property.DeclaringType?.FullName}.{property.Name}' has no public getter.");
                    var getterRef = this.outer.GetMethodReference(getter);
                    this.il.OpCode(receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
                    this.il.Token(getterRef);
                    break;
                case FieldInfo field:
                    var fieldRef = this.outer.GetFieldReference(field);
                    this.il.OpCode(ILOpCode.Ldfld);
                    this.il.Token(fieldRef);
                    break;
                default:
                    throw new NotSupportedException(
                        $"CLR member '{access.Member.GetType().Name}' is not yet supported by the emitter.");
            }
        }

        private void EmitClrIndex(BoundClrIndexExpression idx)
        {
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
            // Phase 4 emit parity: indexer write. `d[k] = v` -> `callvirt set_Item(k, v)`.
            // Like the array-index assignment path, the expression result is the
            // assigned value, so re-read via `get_Item` after the store.
            this.EmitLoadVariable(ixa.Target);
            foreach (var arg in ixa.Arguments)
            {
                this.EmitExpression(arg);
            }

            this.EmitExpression(ixa.Value);
            var setter = ixa.Indexer.GetSetMethod(nonPublic: false)
                ?? throw new InvalidOperationException(
                    $"Indexer on '{ixa.Indexer.DeclaringType?.FullName}' has no public setter.");
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(setter));

            this.EmitLoadVariable(ixa.Target);
            foreach (var arg in ixa.Arguments)
            {
                this.EmitExpression(arg);
            }

            var getter = ixa.Indexer.GetGetMethod(nonPublic: false)
                ?? throw new InvalidOperationException(
                    $"Indexer on '{ixa.Indexer.DeclaringType?.FullName}' has no public getter.");
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(getter));
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
                    this.EmitExpression(new BoundVariableExpression(captured));
                    this.il.OpCode(ILOpCode.Stfld);
                    this.il.Token(fieldHandle);
                }

                var delegateTypeC = this.outer.ResolveDelegateClrType(literal.FunctionType);
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

            var delegateType = this.outer.ResolveDelegateClrType(literal.FunctionType);
            var delegateCtor = delegateType.GetConstructors()[0];

            this.il.OpCode(ILOpCode.Ldnull);
            this.il.OpCode(ILOpCode.Ldftn);
            this.il.Token(methodHandle);
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(delegateCtor));
        }

        // Phase 4 emit parity (E1): indirect call through a func-typed value.
        // Evaluates the target (pushes the delegate on the stack), evaluates
        // each argument, then calls the delegate's `Invoke` method via
        // `callvirt`.
        private void EmitIndirectCall(BoundIndirectCallExpression call)
        {
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

        private void EmitInstanceReceiver(BoundExpression receiver)
        {
            // Value-type receivers need a managed pointer (the implicit `this`
            // of an instance method on a value type is a `ref` parameter). For
            // the common case where the receiver is a local/parameter, we can
            // emit `ldloca`/`ldarga`. Other shapes are not yet exercised by the
            // emit pipeline.
            var clrType = receiver.Type?.ClrType;
            if (clrType != null && clrType.IsValueType
                && receiver is BoundVariableExpression bve
                && this.TryLoadVariableAddress(bve.Variable))
            {
                return;
            }

            this.EmitExpression(receiver);
        }

        private bool TryLoadVariableAddress(VariableSymbol variable)
        {
            if (variable is ParameterSymbol ps && this.parameters.TryGetValue(ps, out var argIndex))
            {
                this.il.LoadArgumentAddress(argIndex);
                return true;
            }

            if (this.locals.TryGetValue(variable, out var slot))
            {
                this.il.LoadLocalAddress(slot);
                return true;
            }

            return false;
        }

        private void EmitGoStatement(BoundGoStatement node)
        {
            var hasScope = this.goEnclosingScopes.TryGetValue(node, out var scope);
            if (hasScope)
            {
                this.il.LoadLocal(this.scopeFrameSlots[scope].Tasks);
            }

            this.EmitGoAction(node);

            var run = typeof(System.Threading.Tasks.Task).GetMethod(
                nameof(System.Threading.Tasks.Task.Run),
                new[] { typeof(Action) });
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
                this.EmitExpression(new BoundVariableExpression(captured));
                this.il.OpCode(ILOpCode.Stfld);
                this.il.Token(fieldHandle);
            }

            var actionCtor = typeof(Action).GetConstructor(new[] { typeof(object), typeof(IntPtr) });
            this.il.OpCode(ILOpCode.Ldftn);
            this.il.Token(invokeHandle);
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(actionCtor));
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
}
