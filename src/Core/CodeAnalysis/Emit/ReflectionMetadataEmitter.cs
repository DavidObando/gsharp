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
/// This is the short-path emitter that lives in <c>GSharp.Core</c> so the
/// existing <c>Compilation.Emit</c> flow can produce real CIL without taking
/// a dependency on the heavier Roslyn-derived backend in
/// <c>Gsharp.CodeAnalysis</c>. Phase 1 only covers the surface needed by
/// <c>samples/HelloWorld.gs</c>: a synthesized entry point whose body is a
/// single imported-static-method call (e.g. <c>Console.WriteLine</c>) with
/// literal string arguments. Other bound node kinds throw
/// <see cref="NotSupportedException"/>; Phase 2 broadens coverage to all
/// <c>BoundNodeKind</c>s and revisits consolidating with the Roslyn-derived
/// backend in <c>Gsharp.CodeAnalysis</c>.
/// </remarks>
internal sealed class ReflectionMetadataEmitter
{
    private readonly BoundProgram program;
    private readonly MetadataBuilder metadata = new MetadataBuilder();
    private readonly Dictionary<Assembly, AssemblyReferenceHandle> assemblyRefs = new Dictionary<Assembly, AssemblyReferenceHandle>();
    private readonly Dictionary<Type, TypeReferenceHandle> typeRefs = new Dictionary<Type, TypeReferenceHandle>();
    private readonly Dictionary<MethodInfo, MemberReferenceHandle> methodRefs = new Dictionary<MethodInfo, MemberReferenceHandle>();
    private readonly MethodBodyStreamEncoder methodBodyStream;
    private readonly BlobBuilder ilStream = new BlobBuilder();

    private TypeReferenceHandle objectTypeRef;
    private MemberReferenceHandle objectCtorRef;

    private ReflectionMetadataEmitter(BoundProgram program)
    {
        this.program = program;
        this.methodBodyStream = new MethodBodyStreamEncoder(this.ilStream);
    }

    /// <summary>
    /// Emits <paramref name="program"/> to <paramref name="peStream"/> as a
    /// managed PE.
    /// </summary>
    /// <param name="program">The bound program to emit.</param>
    /// <param name="peStream">Destination stream for the PE bytes.</param>
    public static void Emit(BoundProgram program, Stream peStream)
    {
        var emitter = new ReflectionMetadataEmitter(program);
        emitter.EmitCore(peStream);
    }

    private void EmitCore(Stream peStream)
    {
        // 1. Seed Object reference (every type derives from it; default ctor is needed for .ctor chains).
        this.objectTypeRef = this.GetTypeReference(typeof(object));
        this.objectCtorRef = this.GetObjectDefaultCtorReference();

        // 2. <Module> type (TypeDef row #1 must always be <Module> per ECMA-335).
        this.metadata.AddTypeDefinition(
            attributes: default(TypeAttributes),
            @namespace: default(StringHandle),
            name: this.metadata.GetOrAddString("<Module>"),
            baseType: default(EntityHandle),
            fieldList: MetadataTokens.FieldDefinitionHandle(1),
            methodList: MetadataTokens.MethodDefinitionHandle(1));

        // 3. Emit <Program> type: default .ctor + entry point (if any).
        MethodDefinitionHandle entryPointHandle = default;
        var programCtor = this.EmitDefaultConstructor();

        if (this.program.EntryPoint is not null
            && this.program.Functions.TryGetValue(this.program.EntryPoint, out var entryBody))
        {
            entryPointHandle = this.EmitEntryPoint(this.program.EntryPoint, entryBody);
        }

        this.metadata.AddTypeDefinition(
            attributes: TypeAttributes.Class | TypeAttributes.Public | TypeAttributes.AutoLayout
                | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit,
            @namespace: this.metadata.GetOrAddString(this.program.PackageName),
            name: this.metadata.GetOrAddString("<Program>"),
            baseType: this.objectTypeRef,
            fieldList: MetadataTokens.FieldDefinitionHandle(1),
            methodList: programCtor);

        // 4. Module + assembly rows.
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

        // 5. Serialize PE.
        var peHeaderBuilder = new PEHeaderBuilder(
            imageCharacteristics: entryPointHandle.IsNil
                ? Characteristics.Dll | Characteristics.ExecutableImage
                : Characteristics.ExecutableImage);
        var peBuilder = new ManagedPEBuilder(
            header: peHeaderBuilder,
            metadataRootBuilder: new MetadataRootBuilder(this.metadata),
            ilStream: this.ilStream,
            entryPoint: entryPointHandle);
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

    private MethodDefinitionHandle EmitEntryPoint(FunctionSymbol entryPoint, BoundBlockStatement body)
    {
        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
        var emitter = new BodyEmitter(this, il);
        emitter.EmitBlock(body);

        // Always cap with ret. (Lowering does not guarantee a trailing ret for void.)
        il.OpCode(ILOpCode.Ret);

        var bodyOffset = this.methodBodyStream.AddMethodBody(il);

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(
                0,
                r => EncodeReturnSymbol(r, entryPoint.Type),
                _ => { });

        // Synthesized entry point uses the C#-style mangled name; explicit Main keeps its source name.
        var methodName = entryPoint.Declaration is null ? "<Main>$" : entryPoint.Name;

        return this.metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.HideBySig,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.metadata.GetOrAddString(methodName),
            signature: this.metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: MetadataTokens.ParameterHandle(1));
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
        if (type == typeof(bool))
        {
            encoder.Boolean();
        }
        else if (type == typeof(int))
        {
            encoder.Int32();
        }
        else if (type == typeof(long))
        {
            encoder.Int64();
        }
        else if (type == typeof(string))
        {
            encoder.String();
        }
        else if (type == typeof(object))
        {
            encoder.Object();
        }
        else
        {
            throw new NotSupportedException($"Cannot encode signature for CLR type '{type}' yet.");
        }
    }

    private static void EncodeReturnClr(ReturnTypeEncoder encoder, Type type)
    {
        if (type == typeof(void))
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

        public BodyEmitter(ReflectionMetadataEmitter outer, InstructionEncoder il)
        {
            this.outer = outer;
            this.il = il;
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
                default:
                    throw new NotSupportedException(
                        $"Bound statement kind '{statement.Kind}' is not yet supported by the Phase 1 emitter. "
                        + "See plan.md Phase 2 (p2-langcov).");
            }
        }

        private void EmitExpression(BoundExpression expression)
        {
            switch (expression)
            {
                case BoundLiteralExpression literal:
                    this.EmitLiteral(literal);
                    break;
                case BoundImportedCallExpression call:
                    foreach (var arg in call.Arguments)
                    {
                        this.EmitExpression(arg);
                    }

                    var methodRef = this.outer.GetMethodReference(call.Function.Method);
                    this.il.Call(methodRef);
                    break;
                default:
                    throw new NotSupportedException(
                        $"Bound expression kind '{expression.Kind}' is not yet supported by the Phase 1 emitter. "
                        + "See plan.md Phase 2 (p2-langcov).");
            }
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
