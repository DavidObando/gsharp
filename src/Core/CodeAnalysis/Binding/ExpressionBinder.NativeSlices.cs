// <copyright file="ExpressionBinder.NativeSlices.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class ExpressionBinder
{
    private BoundExpression BindBufferAwareCallExpression(CallExpressionSyntax syntax)
    {
        if (syntax.ConversionTypeClause is { ReadOnlySliceModifier: null, Identifier: { } identifier } type
            && identifier.Text is "slice" or "array"
            && !binderCtx.CanUseNativeBufferAlias(scope, identifier, getCurrentFunction(), expression: true))
        {
            var ordinary = new CallExpressionSyntax(
                syntax.SyntaxTree,
                identifier,
                type.QuestionToken,
                BufferTypeArguments(type),
                syntax.OpenParenthesisToken,
                syntax.Arguments,
                syntax.CloseParenthesisToken);
            return overloads.BindCallExpression(ordinary);
        }

        return overloads.BindCallExpression(syntax);
    }

    private static TypeArgumentListSyntax BufferTypeArguments(TypeClauseSyntax type)
        => new(type.SyntaxTree, type.TypeArgumentOpenBracketToken!, type.TypeArguments!, type.TypeArgumentCloseBracketToken!);

    private BoundExpression BindOrdinaryBufferCollectionLiteral(CollectionInitializerExpressionSyntax syntax)
    {
        var type = syntax.BufferType!;
        var position = type.TypeArgumentCloseBracketToken!.Span.End;
        var constructor = new CallExpressionSyntax(
            syntax.SyntaxTree,
            type.Identifier!,
            BufferTypeArguments(type),
            new SyntaxToken(syntax.SyntaxTree, SyntaxKind.OpenParenthesisToken, position, "(", null),
            new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty),
            new SyntaxToken(syntax.SyntaxTree, SyntaxKind.CloseParenthesisToken, position, ")", null));
        return BindCollectionInitializerSuffix(syntax, overloads.BindCallExpression(constructor));
    }

    private BoundExpression BindEmptyNativeBufferLiteral(StructLiteralExpressionSyntax syntax)
    {
        if (syntax.Elements.Count != 0 || syntax.SpreadExpression != null)
        {
            Diagnostics.ReportNativeSliceType(syntax.Location, "native buffer literals require positional elements");
            return new BoundErrorExpression(syntax);
        }

        var arguments = syntax.TypeArgumentList!;
        var type = new TypeClauseSyntax(syntax.SyntaxTree, null, null, null, syntax.TypeIdentifier, arguments.OpenBracketToken, arguments.Arguments, arguments.CloseBracketToken, null);
        return BindNativeBufferLiteral(new CollectionInitializerExpressionSyntax(
            syntax.SyntaxTree,
            null,
            syntax.OpenBraceToken,
            new SeparatedSyntaxList<CollectionElementSyntax>(ImmutableArray<SyntaxNode>.Empty),
            syntax.CloseBraceToken) { BufferType = type });
    }

    private bool ValidateNativeSharingArguments(ImportedClassSymbol? container, string name, ImmutableArray<BoundExpression> arguments, SyntaxNode syntax)
    {
        if (container == null || name is not ("FromArray" or "TryFromMemory")
            || !NativeSliceTypes.TryGetElement(container.SymbolicReceiver ?? TypeSymbol.FromClrType(container.ClassType), out var targetElement, out _))
        {
            return true;
        }

        foreach (var argument in arguments)
        {
            var sourceElement = GetArraySliceElementType(argument.Type);
            if (name == "TryFromMemory" && argument.Type.ClrType is { IsGenericType: true } clr
                && clr.GetGenericTypeDefinition().FullName is "System.Memory`1" or "System.ReadOnlyMemory`1")
            {
                sourceElement = argument.Type is NullabilityAnnotatedTypeSymbol annotated
                    ? annotated.GetTypeArgumentSymbol(0)
                    : argument.Type.ConstructedTypeArguments[0];
            }

            if (sourceElement != null
                && !NullableFlagsBuilder.Build(sourceElement).SequenceEqual(NullableFlagsBuilder.Build(targetElement)))
            {
                Diagnostics.ReportNativeSliceType(argument.Syntax?.Location ?? syntax.Location, "sharing storage cannot change element nullability");
                return false;
            }
        }

        return true;
    }

    private static bool HasNativeSliceElementRoot(BoundExpression expression)
        => expression switch
        {
            BoundClrIndexExpression index => NativeSliceTypes.TryGetElement(index.Target.Type, out _, out _),
            BoundBlockExpression block => HasNativeSliceElementRoot(block.Expression),
            BoundDereferenceExpression dereference => HasNativeSliceElementRoot(dereference.Operand),
            BoundFieldAccessExpression { Receiver: { } receiver } => HasNativeSliceElementRoot(receiver),
            BoundClrPropertyAccessExpression { Receiver: { } receiver } => HasNativeSliceElementRoot(receiver),
            _ => false,
        };

    private bool TrySaveNativeElementReceiver(
        BoundExpression receiver,
        out BoundExpression savedReceiver,
        out ImmutableArray<BoundStatement> prefix)
    {
        savedReceiver = receiver;
        prefix = ImmutableArray<BoundStatement>.Empty;
        if (!HasNativeSliceElementRoot(receiver))
        {
            return false;
        }

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        if (Binder.IsReferenceTypeForConstraint(receiver.Type))
        {
            var value = DeclareRangeTemp("receiver", receiver.Type, receiver, statements);
            savedReceiver = new BoundVariableExpression(receiver.Syntax, value);
            prefix = statements.ToImmutable();
            return true;
        }

        if (RefCapabilities.IsReadOnlyReference(receiver))
        {
            return false;
        }

        var pointer = new BoundAddressOfExpression(receiver.Syntax, receiver);
        var location = DeclareRangeTemp("receiverAddress", pointer.Type, pointer, statements);
        savedReceiver = new BoundDereferenceExpression(receiver.Syntax, new BoundVariableExpression(null, location));
        prefix = statements.ToImmutable();
        return true;
    }

    private BoundExpression BindNativeSliceIndex(BoundExpression target, ExpressionSyntax syntax, BoundExpression? boundIndex = null)
    {
        NativeSliceTypes.TryGetElement(target.Type, out var element, out _);
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var saved = DeclareRangeTemp("src", target.Type, target, statements);
        var receiver = new BoundVariableExpression(null, saved);
        ImmutableArray<BoundExpression> arguments;
        PropertyInfo indexer;
        if (boundIndex == null && syntax is FromEndIndexExpressionSyntax fromEnd)
        {
            arguments = ImmutableArray.Create<BoundExpression>(
                conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32), new BoundLiteralExpression(null, true));
            indexer = target.Type.ClrType!.GetProperties().Single(p => p.GetIndexParameters().Length == 2);
        }
        else
        {
            var index = boundIndex ?? BindExpression(syntax);
            if (ClrTypeUtilities.AreSame(index.Type.ClrType, typeof(Range)))
            {
                var method = target.Type.ClrType!.GetMethods().Single(m => m.Name == "Subslice" && m.GetParameters().Length == 1);
                return new BoundBlockExpression(
                    syntax,
                    statements.ToImmutable(),
                    new BoundImportedInstanceCallExpression(syntax, receiver, method, target.Type, ImmutableArray.Create(index)));
            }

            var isIndex = ClrTypeUtilities.AreSame(index.Type.ClrType, typeof(Index));
            if (!isIndex)
            {
                index = conversions.BindConversion(syntax.Location, index, TypeSymbol.Int32);
            }

            arguments = ImmutableArray.Create(index);
            indexer = target.Type.ClrType!.GetProperties().Single(
                p => p.GetIndexParameters() is { Length: 1 } parameters
                    && ClrTypeUtilities.AreSame(parameters[0].ParameterType, isIndex ? typeof(Index) : typeof(int)));
        }

        var pointer = new BoundClrIndexExpression(syntax, receiver, indexer, arguments, ByRefTypeSymbol.Get(element!));
        return new BoundDereferenceExpression(syntax, new BoundBlockExpression(syntax, statements.ToImmutable(), pointer));
    }

    private BoundExpression BindNativeSliceAssignment(
        BoundExpression target,
        ExpressionSyntax indexSyntax,
        BoundExpression value,
        TextLocation location,
        BoundExpression? boundIndex = null)
    {
        if (NativeSliceTypes.TryGetElement(target.Type, out _, out var readOnly) && readOnly)
        {
            Diagnostics.ReportNativeSliceReadOnlyElement(location);
            return new BoundErrorExpression(indexSyntax);
        }

        if (AsyncBoundTreeQueries.HasAwait(value))
        {
            Diagnostics.ReportNativeSliceSuspendingWrite(location);
            return new BoundErrorExpression(indexSyntax);
        }

        if (BindNativeSliceIndex(target, indexSyntax, boundIndex) is not BoundDereferenceExpression access)
        {
            Diagnostics.ReportNativeSliceType(location, "a range is a view, not an assignable element");
            return new BoundErrorExpression(indexSyntax);
        }

        return new BoundIndirectAssignmentExpression(indexSyntax, access.Operand, value);
    }

    private BoundExpression BindNativeSliceCompoundAssignment(
        BoundExpression target,
        ExpressionSyntax indexSyntax,
        SyntaxToken operation,
        ExpressionSyntax valueSyntax)
    {
        NativeSliceTypes.TryGetElement(target.Type, out _, out var readOnly);
        if (readOnly)
        {
            Diagnostics.ReportNativeSliceReadOnlyElement(operation.Location);
            return new BoundErrorExpression(indexSyntax);
        }

        var value = BindExpression(valueSyntax);
        if (AsyncBoundTreeQueries.HasAwait(value))
        {
            Diagnostics.ReportNativeSliceSuspendingWrite(valueSyntax.Location);
            return new BoundErrorExpression(indexSyntax);
        }

        if (BindNativeSliceIndex(target, indexSyntax) is not BoundDereferenceExpression access)
        {
            Diagnostics.ReportNativeSliceType(operation.Location, "a range is not an assignable element");
            return new BoundErrorExpression(indexSyntax);
        }

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var address = DeclareRangeTemp("address", access.Operand.Type, access.Operand, statements);
        var addressRef = new BoundVariableExpression(null, address);
        SyntaxFacts.TryGetCompoundAssignmentBaseOperator(operation.Kind, out var binaryKind);
        var result = TryBindCompoundBinaryOperation(binaryKind, new BoundDereferenceExpression(null, addressRef), value, valueSyntax.Location);
        if (result == null)
        {
            Diagnostics.ReportUndefinedBinaryOperator(operation.Location, operation.Text, access.Type, value.Type);
            return new BoundErrorExpression(indexSyntax);
        }

        result = conversions.BindConversion(valueSyntax.Location, result, access.Type);
        return new BoundBlockExpression(indexSyntax, statements.ToImmutable(), new BoundIndirectAssignmentExpression(indexSyntax, addressRef, result));
    }

    private BoundExpression BindNativeBufferLiteral(CollectionInitializerExpressionSyntax syntax)
    {
        if (syntax.BufferType is { ReadOnlySliceModifier: null, Identifier: { } name }
            && !binderCtx.CanUseNativeBufferAlias(scope, name, getCurrentFunction(), expression: true))
        {
            return BindOrdinaryBufferCollectionLiteral(syntax);
        }

        var type = bindTypeClause(Invariant.Required(syntax.BufferType, "native literals carry their buffer type"));
        if (type == null || type == TypeSymbol.Error)
        {
            return new BoundErrorExpression(syntax);
        }

        var element = type is SliceTypeSymbol array
            ? array.ElementType
            : NativeSliceTypes.TryGetElement(type, out var nativeElement, out _) ? nativeElement : null;
        if (element == null)
        {
            Diagnostics.ReportNativeSliceType(syntax.Location, "a buffer literal requires a non-null buffer type");
            return new BoundErrorExpression(syntax);
        }

        var elements = ImmutableArray.CreateBuilder<BoundExpression>();
        foreach (var initializer in syntax.Elements)
        {
            if (initializer is not ExpressionCollectionElementSyntax item
                || item.Expression is SpreadElementExpressionSyntax)
            {
                Diagnostics.ReportNativeSliceType(initializer.Location, "a native buffer literal requires individual positional elements");
                continue;
            }

            elements.Add(BindExpression(item.Expression, element));
        }

        var storage = new BoundArrayCreationExpression(syntax, SliceTypeSymbol.Get(element), elements.ToImmutable());
        if (type is SliceTypeSymbol)
        {
            return storage;
        }

        // A symbolic declaring-type receiver keeps T in FromArray's MemberRef,
        // including source-defined value types whose CLR type does not exist yet.
        var method = type.ClrType!.GetMethod("FromArray", BindingFlags.Public | BindingFlags.Static)!;
        var container = new ImportedClassSymbol(type.ClrType, null, (ImportedTypeSymbol)type, scope.References);
        var function = new ImportedFunctionSymbol("FromArray", container, method, null, type);
        return new BoundImportedCallExpression(
            syntax, function, ImmutableArray.Create<BoundExpression>(storage), staticContainerType: type);
    }

    private BoundExpression BindNativeSliceRange(BoundExpression target, RangeExpressionSyntax range)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var saved = DeclareRangeTemp("src", target.Type, target, statements);
        var receiver = new BoundVariableExpression(null, saved);
        var length = new BoundClrPropertyAccessExpression(
            null, receiver, target.Type.ClrType!.GetProperty("Length")!, TypeSymbol.Int32);

        BoundExpression Bound(ExpressionSyntax? syntax, BoundExpression omitted)
            => syntax == null ? omitted
                : conversions.BindConversion(syntax is FromEndIndexExpressionSyntax fromEnd ? fromEnd.Operand : syntax, TypeSymbol.Int32);

        var lower = Bound(range.LowerBound, new BoundLiteralExpression(null, 0));
        var upper = Bound(range.UpperBound, length);
        var method = target.Type.ClrType.GetMethods().Single(m => m.Name == "Subslice" && m.GetParameters().Length == 4);
        var call = new BoundImportedInstanceCallExpression(
            range,
            receiver,
            method,
            target.Type,
            ImmutableArray.Create(
                lower,
                upper,
                new BoundLiteralExpression(null, range.LowerBound is FromEndIndexExpressionSyntax),
                new BoundLiteralExpression(null, range.UpperBound is FromEndIndexExpressionSyntax)));
        return new BoundBlockExpression(range, statements.ToImmutable(), call);
    }
}
