// <copyright file="ReflectionMetadataEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
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
    private readonly MetadataBuilder metadata = new MetadataBuilder();
    private readonly Dictionary<Assembly, AssemblyReferenceHandle> assemblyRefs = new Dictionary<Assembly, AssemblyReferenceHandle>();
    private readonly Dictionary<Type, TypeReferenceHandle> typeRefs = new Dictionary<Type, TypeReferenceHandle>();
    private readonly Dictionary<MethodInfo, MemberReferenceHandle> methodRefs = new Dictionary<MethodInfo, MemberReferenceHandle>();
    private readonly Dictionary<FunctionSymbol, MethodDefinitionHandle> functionHandles = new Dictionary<FunctionSymbol, MethodDefinitionHandle>();
    private readonly MethodBodyStreamEncoder methodBodyStream;
    private readonly BlobBuilder ilStream = new BlobBuilder();

    private Type coreObjectType;
    private Type coreStringType;
    private TypeReferenceHandle objectTypeRef;
    private MemberReferenceHandle objectCtorRef;
    private MemberReferenceHandle stringConcatRef;
    private MemberReferenceHandle stringEqualsRef;

    private ReflectionMetadataEmitter(BoundProgram program, ReferenceResolver references)
    {
        this.program = program;
        this.references = references ?? ReferenceResolver.Default();
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
    public static void Emit(BoundProgram program, Stream peStream, ReferenceResolver references = null)
    {
        var emitter = new ReflectionMetadataEmitter(program, references);
        emitter.EmitCore(peStream);
    }

    private void EmitCore(Stream peStream)
    {
        // 1. Seed Object reference. Resolve from the supplied references so the type-ref
        //    assembly identity (mscorlib / System.Runtime / netstandard) matches the
        //    target framework rather than the gsc host's System.Private.CoreLib.
        this.coreObjectType = this.ResolveCoreType("System.Object", typeof(object));
        this.coreStringType = this.ResolveCoreType("System.String", typeof(string));
        this.objectTypeRef = this.GetTypeReference(this.coreObjectType);
        this.objectCtorRef = this.GetObjectDefaultCtorReference();

        // 2. <Module> type (TypeDef row #1 must always be <Module> per ECMA-335).
        this.metadata.AddTypeDefinition(
            attributes: default(TypeAttributes),
            @namespace: default(StringHandle),
            name: this.metadata.GetOrAddString("<Module>"),
            baseType: default(EntityHandle),
            fieldList: MetadataTokens.FieldDefinitionHandle(1),
            methodList: MetadataTokens.MethodDefinitionHandle(1));

        // 3. Plan the MethodDef order on <Program>:
        //    row 1: <Program>..ctor
        //    rows 2..N+1: user-defined functions (excluding entry point), in iteration order
        //    row N+2 (if present): entry point
        // Pre-assign MethodDefinitionHandles so user-function calls can be encoded before
        // their bodies are added to the method-body stream.
        var userFunctions = new List<FunctionSymbol>();
        foreach (var kvp in this.program.Functions)
        {
            if (kvp.Key != this.program.EntryPoint)
            {
                userFunctions.Add(kvp.Key);
            }
        }

        var nextRow = 2;
        foreach (var fn in userFunctions)
        {
            this.functionHandles[fn] = MetadataTokens.MethodDefinitionHandle(nextRow++);
        }

        MethodDefinitionHandle entryHandle = default;
        if (this.program.EntryPoint is not null)
        {
            entryHandle = MetadataTokens.MethodDefinitionHandle(nextRow++);
            this.functionHandles[this.program.EntryPoint] = entryHandle;
        }

        // 4. Emit method definitions in row order.
        var programCtor = this.EmitDefaultConstructor();

        foreach (var fn in userFunctions)
        {
            var body = this.program.Functions[fn];
            this.EmitFunction(fn, body, isEntryPoint: false);
        }

        if (this.program.EntryPoint is not null)
        {
            var entryBody = this.program.Functions[this.program.EntryPoint];
            this.EmitFunction(this.program.EntryPoint, entryBody, isEntryPoint: true);
        }

        // 5. <Program> type definition.
        this.metadata.AddTypeDefinition(
            attributes: TypeAttributes.Class | TypeAttributes.Public | TypeAttributes.AutoLayout
                | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit,
            @namespace: this.metadata.GetOrAddString(this.program.PackageName),
            name: this.metadata.GetOrAddString("<Program>"),
            baseType: this.objectTypeRef,
            fieldList: MetadataTokens.FieldDefinitionHandle(1),
            methodList: programCtor);

        // 6. Module + assembly rows.
        this.metadata.AddModule(
            generation: 0,
            moduleName: this.metadata.GetOrAddString(this.program.PackageName + ".dll"),
            mvid: this.metadata.GetOrAddGuid(Guid.NewGuid()),
            encId: default(GuidHandle),
            encBaseId: default(GuidHandle));

        this.metadata.AddAssembly(
            name: this.metadata.GetOrAddString(this.program.PackageName),
            version: new Version(1, 0, 0, 0),
            culture: default(StringHandle),
            publicKey: default(BlobHandle),
            flags: 0,
            hashAlgorithm: AssemblyHashAlgorithm.Sha1);

        // 7. Serialize PE.
        var peHeaderBuilder = new PEHeaderBuilder(
            imageCharacteristics: entryHandle.IsNil
                ? Characteristics.Dll | Characteristics.ExecutableImage
                : Characteristics.ExecutableImage);
        var peBuilder = new ManagedPEBuilder(
            header: peHeaderBuilder,
            metadataRootBuilder: new MetadataRootBuilder(this.metadata),
            ilStream: this.ilStream,
            entryPoint: entryHandle);
        var peBlob = new BlobBuilder();
        peBuilder.Serialize(peBlob);
        peBlob.WriteContentTo(peStream);
    }

    private MethodDefinitionHandle EmitDefaultConstructor()
    {
        var il = new InstructionEncoder(new BlobBuilder());
        il.LoadArgument(0);
        il.Call(this.objectCtorRef);
        il.OpCode(ILOpCode.Ret);
        var bodyOffset = this.methodBodyStream.AddMethodBody(il);

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
        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());

        // Pre-scan body for locals (top-level only — Lowerer flattens blocks) and labels.
        var locals = new Dictionary<VariableSymbol, int>();
        var labels = new Dictionary<BoundLabel, LabelHandle>();
        var localTypes = new List<TypeSymbol>();
        CollectLocalsAndLabels(body, function, locals, localTypes, labels, il);

        // Parameters → arg indices.
        var parameters = new Dictionary<ParameterSymbol, int>();
        for (var i = 0; i < function.Parameters.Length; i++)
        {
            parameters[function.Parameters[i]] = i;
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

        var emitter = new BodyEmitter(this, il, locals, parameters, labels);
        emitter.EmitBlock(body);

        // Always cap with a trailing ret. Lowering does not guarantee one for void.
        if (function.Type == TypeSymbol.Void)
        {
            il.OpCode(ILOpCode.Ret);
        }

        var bodyOffset = this.methodBodyStream.AddMethodBody(il, localVariablesSignature: localsSignature);

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
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

        var handle = this.metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.HideBySig,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString(methodName),
            signature: this.metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: MetadataTokens.ParameterHandle(1));

        return handle;
    }

    private static void CollectLocalsAndLabels(
        BoundBlockStatement body,
        FunctionSymbol function,
        Dictionary<VariableSymbol, int> locals,
        List<TypeSymbol> localTypes,
        Dictionary<BoundLabel, LabelHandle> labels,
        InstructionEncoder il)
    {
        foreach (var s in body.Statements)
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
            }
        }

        // Second pass to pre-define labels referenced by gotos before their LabelStatement
        // (forward branches are common after Lowerer flattens loops).
        foreach (var s in body.Statements)
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
            }
        }
    }

    private Type ResolveCoreType(string fullName, Type fallback)
    {
        if (this.references.TryResolveType(fullName, out var t))
        {
            return t;
        }

        return fallback;
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
                returnType: r => EncodeReturnClr(r, method.ReturnType),
                parameters: ps =>
                {
                    foreach (var p in method.GetParameters())
                    {
                        EncodeClrType(ps.AddParameter().Type(), p.ParameterType);
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

    private static void EncodeTypeSymbol(SignatureTypeEncoder encoder, TypeSymbol type)
    {
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
        else
        {
            throw new NotSupportedException($"Cannot encode signature for type '{type.Name}' yet.");
        }
    }

    private static void EncodeReturnSymbol(ReturnTypeEncoder encoder, TypeSymbol type)
    {
        if (type == TypeSymbol.Void)
        {
            encoder.Void();
        }
        else
        {
            EncodeTypeSymbol(encoder.Type(), type);
        }
    }

    private static void EncodeClrType(SignatureTypeEncoder encoder, Type type)
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
                throw new NotSupportedException($"Cannot encode signature for CLR type '{type}' yet.");
        }
    }

    private static void EncodeReturnClr(ReturnTypeEncoder encoder, Type type)
    {
        if (type?.FullName == "System.Void")
        {
            encoder.Void();
        }
        else
        {
            EncodeClrType(encoder.Type(), type);
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

        public BodyEmitter(
            ReflectionMetadataEmitter outer,
            InstructionEncoder il,
            Dictionary<VariableSymbol, int> locals,
            Dictionary<ParameterSymbol, int> parameters,
            Dictionary<BoundLabel, LabelHandle> labels)
        {
            this.outer = outer;
            this.il = il;
            this.locals = locals;
            this.parameters = parameters;
            this.labels = labels;
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

        private void EmitUnary(BoundUnaryExpression u)
        {
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
    }
}
