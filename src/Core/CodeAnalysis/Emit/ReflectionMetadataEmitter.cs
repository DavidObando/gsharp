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
    private readonly Dictionary<MethodInfo, MemberReferenceHandle> methodRefs = new Dictionary<MethodInfo, MemberReferenceHandle>();
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
        var allAggregates = this.program.Structs;
        var classes = allAggregates.Where(s => s.IsClass).ToList();
        var structs = allAggregates.Where(s => !s.IsClass).ToList();
        var interfaces = this.program.Interfaces;

        // TypeDef row order: <Module>, interfaces (each owns abstract method
        // rows), classes (each owns a ctor row + methods), structs (no methods
        // of their own — yet), <Program>s. Field-row planning is independent
        // of methods so we walk allAggregates in their original order; the
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
        var classMethodHandles = new Dictionary<FunctionSymbol, MethodDefinitionHandle>();
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
                    classMethodHandles[m] = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }
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
        // preassigned ctor row; struct TypeDefs point past the last class
        // ctor (they own zero methods today).
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
            this.EmitStructTypeDef(s, structFirstFieldRow[s], firstPackageCtorRow);
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
                    var body = this.program.Functions[m];
                    var emittedHandle = this.EmitFunction(m, body, isEntryPoint: false);
                    this.methodHandles[m] = emittedHandle;
                }
            }
        }

        foreach (var pkg in packages)
        {
            var pkgCtor = this.EmitDefaultConstructor();

            foreach (var fn in functionsByPackage[pkg])
            {
                var body = this.program.Functions[fn];
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
        // Emit field definitions in source order. Each field's signature is a
        // FieldSig encoding the GSharp type symbol.
        FieldDefinitionHandle firstField = default;
        foreach (var field in structSym.Fields)
        {
            var sigBlob = new BlobBuilder();
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), field.Type);
            var attrs = MapFieldAccessibility(field.Accessibility);
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
            CollectLocalsAndLabels(body, function, locals, localTypes, labels, appendSlots, structLiteralSlots, il);

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

            for (var i = 0; i < function.Parameters.Length; i++)
            {
                parameters[function.Parameters[i]] = i + paramSlotShift;
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

            var emitter = new BodyEmitter(this, il, locals, parameters, labels, appendSlots, structLiteralSlots);
            emitter.EmitBlock(body);

            // Always cap with a trailing ret. Lowering does not guarantee one for void.
            if (function.Type == TypeSymbol.Void)
            {
                il.OpCode(ILOpCode.Ret);
            }

            bodyOffset = this.methodBodyStream.AddMethodBody(il, localVariablesSignature: localsSignature);
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: function.IsInstanceMethod)
            .Parameters(
                function.Parameters.Length,
                r => EncodeReturnSymbol(r, function.Type),
                ps =>
                {
                    foreach (var p in function.Parameters)
                    {
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
        InstructionEncoder il)
    {
        CollectStatements(body.Statements, function, locals, localTypes, labels, appendSlots, il, pass: 1);
        CollectStatements(body.Statements, function, locals, localTypes, labels, appendSlots, il, pass: 2);

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

    private static void WalkForAppends(BoundNode node, List<BoundAppendExpression> sink)
    {
        switch (node)
        {
            case BoundAppendExpression app:
                sink.Add(app);
                WalkForAppends(app.Slice, sink);
                WalkForAppends(app.Element, sink);
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

        var asmRef = this.GetAssemblyReference(type.Assembly);
        var handle = this.metadata.AddTypeReference(
            resolutionScope: asmRef,
            @namespace: this.metadata.GetOrAddString(type.Namespace ?? string.Empty),
            name: this.metadata.GetOrAddString(type.Name));
        this.typeRefs[type] = handle;
        return handle;
    }

    private MemberReferenceHandle GetMethodReference(MethodInfo method)
    {
        if (this.methodRefs.TryGetValue(method, out var existing))
        {
            return existing;
        }

        var typeRef = this.GetTypeReference(method.DeclaringType
            ?? throw new InvalidOperationException("Imported method has no declaring type."));

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: !method.IsStatic)
            .Parameters(
                method.GetParameters().Length,
                returnType: r => this.EncodeReturnClr(r, method.ReturnType),
                parameters: ps =>
                {
                    foreach (var p in method.GetParameters())
                    {
                        this.EncodeClrType(ps.AddParameter().Type(), p.ParameterType);
                    }
                });

        var handle = this.metadata.AddMemberReference(
            parent: typeRef,
            name: this.metadata.GetOrAddString(method.Name),
            signature: this.metadata.GetOrAddBlob(sigBlob));
        this.methodRefs[method] = handle;
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
            default:
                if (type == null)
                {
                    throw new NotSupportedException("Cannot encode signature for a null CLR type.");
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

        public BodyEmitter(
            ReflectionMetadataEmitter outer,
            InstructionEncoder il,
            Dictionary<VariableSymbol, int> locals,
            Dictionary<ParameterSymbol, int> parameters,
            Dictionary<BoundLabel, LabelHandle> labels,
            Dictionary<BoundAppendExpression, (int Src, int Dst)> appendSlots,
            Dictionary<BoundStructLiteralExpression, int> structLiteralSlots)
        {
            this.outer = outer;
            this.il = il;
            this.locals = locals;
            this.parameters = parameters;
            this.labels = labels;
            this.appendSlots = appendSlots;
            this.structLiteralSlots = structLiteralSlots;
        }

        public void EmitBlock(BoundBlockStatement block)
        {
            foreach (var statement in block.Statements)
            {
                this.EmitStatement(statement);
            }
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
                    foreach (var arg in call.Arguments)
                    {
                        this.EmitExpression(arg);
                    }

                    if (!this.outer.functionHandles.TryGetValue(call.Function, out var fnHandle))
                    {
                        throw new InvalidOperationException(
                            $"Call to function '{call.Function.Name}' has no emitted MethodDef.");
                    }

                    this.il.Call(fnHandle);
                    break;
                case BoundImportedCallExpression impCall:
                    foreach (var arg in impCall.Arguments)
                    {
                        this.EmitExpression(arg);
                    }

                    this.il.Call(this.outer.GetMethodReference(impCall.Function.Method));
                    break;
                case BoundImportedInstanceCallExpression instCall:
                    this.EmitExpression(instCall.Receiver);
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
                    this.EmitExpression(idx.Target);
                    this.EmitExpression(idx.Index);
                    this.EmitLoadElement(idx.Type);
                    break;
                case BoundIndexAssignmentExpression ixa:
                    this.EmitLoadVariable(ixa.Target);
                    this.EmitExpression(ixa.Index);
                    this.EmitExpression(ixa.Value);
                    this.EmitStoreElement(ixa.Type);

                    // Result of an assignment expression is the assigned value.
                    this.EmitLoadVariable(ixa.Target);
                    this.EmitExpression(ixa.Index);
                    this.EmitLoadElement(ixa.Type);
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

            foreach (var arg in call.Arguments)
            {
                this.EmitExpression(arg);
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

            this.EmitExpression(call.Receiver);
            foreach (var arg in call.Arguments)
            {
                this.EmitExpression(arg);
            }

            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(methodHandle);
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

                foreach (var init in literal.Initializers)
                {
                    if (!this.outer.structFieldDefs.TryGetValue(init.Field, out var fieldHandle))
                    {
                        throw new InvalidOperationException(
                            $"Class field '{init.Field.Name}' has no emitted FieldDef.");
                    }

                    this.il.OpCode(ILOpCode.Dup);
                    this.EmitExpression(init.Value);
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
            foreach (var init in literal.Initializers)
            {
                if (!this.outer.structFieldDefs.TryGetValue(init.Field, out var fieldHandle))
                {
                    throw new InvalidOperationException(
                        $"Struct field '{init.Field.Name}' has no emitted FieldDef.");
                }

                this.il.LoadLocalAddress(slot);
                this.EmitExpression(init.Value);
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
    }
}
