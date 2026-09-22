// <copyright file="ManagedReferenceLowerer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>
/// Forms typed location helpers after whole-root capture boxing, before any
/// borrowed address is emitted or suspension state is planned.
/// </summary>
internal sealed class ManagedReferenceLowerer : BoundTreeRewriter
{
    private readonly ReferenceResolver references;
    private readonly List<StructSymbol> helpers = new();
    private readonly Dictionary<FunctionSymbol, BoundBlockStatement> methods = new();
    private FunctionSymbol? function;
    private int counter;

    private ManagedReferenceLowerer(ReferenceResolver references)
    {
        this.references = references;
    }

    internal static BoundProgram Lower(BoundProgram program, ReferenceResolver references)
    {
        var rewriter = new ManagedReferenceLowerer(references);
        var functions = program.Functions.ToBuilder();
        foreach (var pair in program.Functions)
        {
            rewriter.function = pair.Key;
            functions[pair.Key] = (BoundBlockStatement)rewriter.RewriteStatement(pair.Value);
        }

        var initializers = program.Initializers.ToBuilder();
        foreach (var pair in program.Initializers)
        {
            rewriter.function = pair.Value.Function;
            initializers[pair.Key] = pair.Value.Rewrite(rewriter.RewriteExpression, rewriter.RewriteStatement);
        }

        foreach (var pair in rewriter.methods)
        {
            functions[pair.Key] = pair.Value;
        }

        var statement = program.EntryPoint is { } entry && program.Functions.TryGetValue(entry, out var body)
            && ReferenceEquals(body, program.Statement) ? functions[entry] : program.Statement;
        return new BoundProgram(
            program.EntryPointPackage,
            program.Packages,
            program.Diagnostics,
            functions.ToImmutable(),
            program.EntryPoint,
            statement,
            program.Structs.AddRange(rewriter.helpers),
            program.Interfaces,
            program.Enums,
            program.Globals,
            program.Delegates)
        {
            Initializers = initializers.ToImmutable(),
            Imports = program.Imports,
            FriendAssemblies = program.FriendAssemblies,
            AssemblyAttributes = program.AssemblyAttributes,
            ModuleAttributes = program.ModuleAttributes,
        };
    }

    protected override BoundExpression RewriteFunctionLiteralExpression(BoundFunctionLiteralExpression node)
    {
        var body = (BoundBlockStatement)this.RewriteStatement(node.Body);
        return body == node.Body ? node
            : new BoundFunctionLiteralExpression(node.Syntax, node.Function, node.FunctionType, body, node.CapturedVariables);
    }

    protected override BoundStatement RewriteLocalFunctionDeclaration(BoundLocalFunctionDeclaration node)
    {
        var literal = (BoundFunctionLiteralExpression)this.RewriteFunctionLiteralExpression(node.Literal);
        return literal == node.Literal ? node : new BoundLocalFunctionDeclaration(node.Syntax, literal);
    }

    protected override BoundExpression RewriteManagedReferenceExpression(BoundManagedReferenceExpression node)
        => this.Capture(this.RewriteExpression(node.Location), node.Type, node.IsReadOnly);

    private BoundExpression Capture(BoundExpression location, TypeSymbol type, bool readOnly)
    {
        switch (location)
        {
            case BoundBlockExpression block:
                return new BoundBlockExpression(block.Syntax, block.Statements, this.Capture(block.Expression, type, readOnly));
            case BoundDereferenceExpression dereference:
                return this.CapturePointer(dereference.Operand, type, readOnly);
            case BoundIndexExpression index:
                var factoryName = index.Index.Type == TypeSymbol.NInt ? "FromArrayNative" : "FromArray";
                var arrayFactory = RequiredClr(type).GetMethods().Single(m => m.Name == factoryName);
                return new BoundClrStaticCallExpression(location.Syntax, arrayFactory, type, ImmutableArray.Create(index.Target, index.Index));
            case BoundFieldAccessExpression { Receiver: { } receiver }:
                return this.CaptureField(location, receiver, type, readOnly);
            case BoundClrPropertyAccessExpression { Receiver: { } receiver, Member: FieldInfo }:
                return this.CaptureField(location, receiver, type, readOnly);
            default:
                throw new InvalidOperationException($"Unplanned persistent location: {location.Kind}.");
        }
    }

    private BoundExpression CapturePointer(BoundExpression pointer, TypeSymbol type, bool readOnly)
    {
        switch (pointer)
        {
            case BoundBlockExpression block:
                return new BoundBlockExpression(block.Syntax, block.Statements, this.CapturePointer(block.Expression, type, readOnly));
            case BoundAddressOfExpression address:
                return this.Capture(address.Operand, type, readOnly);
            case BoundClrIndexExpression index:
                var name = readOnly ? "GetReadOnlyManagedReference" : "GetManagedReference";
                var runtimeType = Invariant.Required(
                    index.Indexer.DeclaringType,
                    "a CLR indexer has a runtime declaring type");
                var method = runtimeType.GetMethods().Single(m => m.Name == name
                    && ParametersMatch(m.GetParameters(), index.Indexer.GetIndexParameters()));
                return new BoundImportedInstanceCallExpression(pointer.Syntax, index.Target, method, type, index.Arguments);
            case BoundImportedInstanceCallExpression call when ManagedReferenceOrigins.IsHandleBorrow(call):
                ManagedReferenceTypes.TryGetElement(call.Receiver.Type, out _, out var sourceReadOnly);
                return readOnly && !sourceReadOnly
                    ? Call(call.Receiver, "AsReadOnly", type)
                    : call.Receiver;
            default:
                throw new InvalidOperationException($"Unplanned persistent pointer origin: {pointer.Kind}.");
        }
    }

    private BoundExpression CaptureField(BoundExpression field, BoundExpression receiver, TypeSymbol type, bool readOnly)
    {
        var objectRoot = Binding.Binder.IsReferenceTypeForConstraint(receiver.Type);
        var selected = objectRoot ? receiver : this.Capture(receiver, this.HandleType(receiver.Type, readOnly), readOnly);
        var selectedLocal = new LocalVariableSymbol("<>locationOwner" + this.counter++, false, selected.Type);
        var selectedRead = new BoundVariableExpression(null, selectedLocal);
        var keyType = TypeSymbol.FromClrType(this.RequiredRuntimeType("Gsharp.Values.ManagedLocationKey"));
        BoundExpression parentKey = objectRoot
            ? new BoundClrStaticCallExpression(
                null,
                Invariant.Required(RequiredClr(keyType).GetMethod("Object"), "the location runtime supplies Object"),
                keyType,
                ImmutableArray.Create<BoundExpression>(new BoundConversionExpression(null, TypeSymbol.Object, selectedRead)))
            : Call(selectedRead, "GetLocation", keyType);
        var key = new BoundManagedFieldKeyExpression(parentKey, field);

        var ownerField = new FieldSymbol("Owner", selected.Type, Accessibility.Public);
        var keyField = new FieldSymbol("Location", keyType, Accessibility.Public);
        var helper = new StructSymbol(
            "<>__ManagedLocation" + this.counter++,
            ImmutableArray.Create(ownerField, keyField),
            Accessibility.Internal,
            declaration: null,
            packageName: this.function?.Package?.Name ?? string.Empty,
            isData: false,
            isInline: false,
            isClass: true);
        helper.SetImportedBaseType(type);
        var enclosing = this.function?.ReceiverType ?? this.function?.StaticOwnerType ?? this.function?.LexicalEnclosingType;
        if (enclosing is StructSymbol aggregate)
        {
            helper.SetContainingType(aggregate.Definition);
        }
        else if (enclosing is InterfaceSymbol interfaceType)
        {
            helper.SetContainingType(interfaceType);
        }

        var borrow = new FunctionSymbol(
            "Borrow",
            ImmutableArray<ParameterSymbol>.Empty,
            field.Type,
            declaration: null,
            this.function?.Package,
            Accessibility.Public,
            helper,
            isOpen: false,
            isOverride: true)
        {
            ReturnRefKind = readOnly ? RefKind.RefReadOnly : RefKind.Ref,
            ExternalOverriddenMethod = OverrideBase(type).GetMethods().Single(m => m.Name == "Borrow"),
            ExternalOverrideContainingType = type,
        };
        var helperThis = new BoundVariableExpression(null, Invariant.Required(borrow.ThisParameter, "the generated Borrow is an instance method"));
        var retainedOwner = new BoundFieldAccessExpression(null, helperThis, helper, ownerField);
        var fieldReceiver = objectRoot ? (BoundExpression)retainedOwner
            : new BoundDereferenceExpression(null, ManagedReferenceTypes.Borrow(retainedOwner));
        BoundExpression borrowedField = field switch
        {
            BoundFieldAccessExpression source => new BoundFieldAccessExpression(null, fieldReceiver, source.StructType, source.Field),
            BoundClrPropertyAccessExpression source => new BoundClrPropertyAccessExpression(null, fieldReceiver, source.Member, source.Type, source.StaticContainerType),
            _ => throw new InvalidOperationException("Expected a resolved field."),
        };
        this.methods[borrow] = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(
            new BoundReturnStatement(null, new BoundAddressOfExpression(null, borrowedField, unmanaged: false, isReadOnly: readOnly), isRef: true)));

        var identity = new FunctionSymbol(
            "GetLocation",
            ImmutableArray<ParameterSymbol>.Empty,
            keyType,
            declaration: null,
            this.function?.Package,
            Accessibility.Public,
            helper,
            isOpen: false,
            isOverride: true)
        {
            ExternalOverriddenMethod = OverrideBase(type).GetMethods().Single(m => m.Name == "GetLocation"),
            ExternalOverrideContainingType = type,
        };
        var identityThis = new BoundVariableExpression(null, Invariant.Required(identity.ThisParameter, "GetLocation is an instance method"));
        this.methods[identity] = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(
            new BoundReturnStatement(null, new BoundFieldAccessExpression(null, identityThis, helper, keyField))));
        helper.SetMethods(ImmutableArray.Create(borrow, identity));
        this.helpers.Add(helper);
        var parameters = SynthesizedClosureReifier.CollectOrdered(new[] { selected.Type, type });
        var construction = parameters.IsDefaultOrEmpty ? helper
            : SynthesizedClosureReifier.Reify(helper, parameters, this.references.MapClrTypeToReferences);
        var instance = new BoundStructLiteralExpression(null, construction, ImmutableArray.Create(
            new BoundFieldInitializer(construction.Fields[0], selectedRead),
            new BoundFieldInitializer(construction.Fields[1], key)));
        return new BoundBlockExpression(
            field.Syntax,
            ImmutableArray.Create<BoundStatement>(new BoundVariableDeclaration(null, selectedLocal, selected)),
            new BoundConversionExpression(null, type, instance));
    }

    private TypeSymbol HandleType(TypeSymbol element, bool readOnly)
    {
        ManagedReferenceTypes.TryResolveDefinition(this.references, readOnly, out var definition);
        return ManagedReferenceTypes.Construct(
            Invariant.Required(definition, "binding established the compatible handle runtime"),
            element,
            this.references);
    }

    private Type RequiredRuntimeType(string name)
    {
        this.references.TryResolveType(name, out var type);
        return Invariant.Required(type, "binding established the compatible managed-reference runtime");
    }

    private static Type RequiredClr(TypeSymbol type) => Invariant.Required(type.ClrType, "the compiler-facing runtime has a CLR type");

    private static Type OverrideBase(TypeSymbol type)
        => type is ImportedTypeSymbol { OpenDefinition: not null, HasSubstitutableTypeArgument: true } imported
            ? imported.OpenDefinition : RequiredClr(type);

    private static BoundExpression Call(BoundExpression receiver, string name, TypeSymbol type)
        => new BoundImportedInstanceCallExpression(
            null,
            receiver,
            RequiredClr(receiver.Type).GetMethods().Single(m => m.Name == name && m.GetParameters().Length == 0),
            type,
            ImmutableArray<BoundExpression>.Empty);

    private static bool ParametersMatch(ParameterInfo[] left, ParameterInfo[] right)
        => left.Length == right.Length
            && left.Zip(right).All(pair => ClrTypeUtilities.AreSame(pair.First.ParameterType, pair.Second.ParameterType));
}
