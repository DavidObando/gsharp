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
        if (syntax.Identifier.Text == "managed"
            && binderCtx.CanUseIntrinsicAlias(scope, syntax.Identifier, getCurrentFunction(), expression: true))
        {
            return BindManagedReference(syntax);
        }

        if (syntax.ReadOnlyManagedModifier != null)
        {
            var ordinary = overloads.BindCallExpression(syntax);
            if (ordinary is not BoundErrorExpression)
            {
                Diagnostics.ReportManagedReference(syntax.ReadOnlyManagedModifier.Location, "readonly managed(location) requires the address intrinsic, not an ordinary same-named callable");
            }

            return new BoundErrorExpression(syntax);
        }

        if (syntax.ConversionTypeClause is { IsArray: false, HasQualifier: false, HasTypeArguments: true, ReadOnlySliceModifier: null, Identifier: { } identifier } type
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
        => new(
            type.SyntaxTree,
            Invariant.Required(type.TypeArgumentOpenBracketToken, "buffer call/literal parsing supplies the generic opening bracket"),
            Invariant.Required(type.TypeArguments, "buffer call/literal parsing supplies the generic argument list"),
            Invariant.Required(type.TypeArgumentCloseBracketToken, "buffer call/literal parsing supplies the generic closing bracket"));

    private BoundExpression BindOrdinaryBufferCollectionLiteral(
        CollectionInitializerExpressionSyntax syntax,
        TypeClauseSyntax type,
        SyntaxToken identifier)
    {
        var typeArguments = BufferTypeArguments(type);
        var position = typeArguments.CloseBracketToken.Span.End;
        var constructor = new CallExpressionSyntax(
            syntax.SyntaxTree,
            identifier,
            typeArguments,
            new SyntaxToken(syntax.SyntaxTree, SyntaxKind.OpenParenthesisToken, position, "(", null),
            new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty),
            new SyntaxToken(syntax.SyntaxTree, SyntaxKind.CloseParenthesisToken, position, ")", null));
        return BindCollectionInitializerSuffix(syntax, overloads.BindCallExpression(constructor));
    }

    private BoundExpression BindEmptyNativeBufferLiteral(StructLiteralExpressionSyntax syntax, TypeArgumentListSyntax arguments)
    {
        if (syntax.Elements.Count != 0 || syntax.SpreadExpression != null)
        {
            Diagnostics.ReportNativeSliceType(syntax.Location, "native buffer literals require positional elements");
            return new BoundErrorExpression(syntax);
        }

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
            || !NativeSliceTypes.TryGetElement(container.SymbolicReceiver ?? TypeSymbol.FromClrTypeWithoutNullability(container.ClassType, NullabilityFreeReason.TypeStructure), out var targetElement, out _))
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
        var elementType = Invariant.Required(element, "native index read/write dispatch calls this helper only after TryGetElement succeeds");
        var clrType = Invariant.Required(target.Type.ClrType, "native index read/write dispatch verifies the runtime type with TryGetElement");
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var saved = DeclareRangeTemp("src", target.Type, target, statements);
        var receiver = new BoundVariableExpression(null, saved);
        ImmutableArray<BoundExpression> arguments;
        PropertyInfo indexer;
        if (boundIndex == null && syntax is FromEndIndexExpressionSyntax fromEnd)
        {
            arguments = ImmutableArray.Create<BoundExpression>(
                conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32), new BoundLiteralExpression(null, true));
            indexer = clrType.GetProperties().Single(p => p.GetIndexParameters().Length == 2);
        }
        else
        {
            var index = boundIndex ?? BindExpression(syntax);
            if (ClrTypeUtilities.AreSame(index.Type.ClrType, typeof(Range)))
            {
                var method = clrType.GetMethods().Single(m => m.Name == "Subslice" && m.GetParameters().Length == 1);
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
            indexer = clrType.GetProperties().Single(
                p => p.GetIndexParameters() is { Length: 1 } parameters
                    && ClrTypeUtilities.AreSame(parameters[0].ParameterType, isIndex ? typeof(Index) : typeof(int)));
        }

        var pointer = new BoundClrIndexExpression(syntax, receiver, indexer, arguments, ByRefTypeSymbol.Get(elementType));
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
        ExpressionSyntax valueSyntax,
        bool returnsPreviousValue,
        bool isIncrementDecrement)
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
        BoundExpression read = new BoundDereferenceExpression(null, addressRef);
        var compoundTarget = read;
        var previousValue = CapturePostfixCompoundValue(
            returnsPreviousValue,
            indexSyntax,
            ref read,
            out var previousDeclaration);
        var userCompound = TryBindUserCompoundAssignmentOperator(
            operation.Kind,
            compoundTarget,
            value,
            valueSyntax.Location);
        if (userCompound != null)
        {
            return FinishUserCompoundIncrement(
                indexSyntax,
                returnsPreviousValue,
                isIncrementDecrement,
                compoundTarget,
                userCompound,
                previousDeclaration,
                previousValue,
                statements);
        }

        var result = TryBindCompoundBinaryOperation(binaryKind, read, value, valueSyntax.Location);
        if (result == null)
        {
            Diagnostics.ReportUndefinedBinaryOperator(operation.Location, operation.Text, access.Type, value.Type);
            return new BoundErrorExpression(indexSyntax);
        }

        result = conversions.BindConversion(valueSyntax.Location, result, access.Type);
        var assignment = new BoundIndirectAssignmentExpression(indexSyntax, addressRef, result);
        return FinishPostfixCompoundAssignment(
            indexSyntax,
            statements,
            previousDeclaration,
            previousValue,
            assignment);
    }

    private BoundExpression BindNativeBufferLiteral(CollectionInitializerExpressionSyntax syntax)
    {
        if (syntax.BufferType is { ReadOnlySliceModifier: null, Identifier: { } name } ordinaryType
            && !binderCtx.CanUseNativeBufferAlias(scope, name, getCurrentFunction(), expression: true))
        {
            return BindOrdinaryBufferCollectionLiteral(syntax, ordinaryType, name);
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
        var clrType = Invariant.Required(type.ClrType, "TryGetElement selected the native runtime type after the array-literal branch returned");
        var method = Invariant.Required(
            clrType.GetMethod("FromArray", BindingFlags.Public | BindingFlags.Static),
            "native type binding selects the SDK Slice/ReadOnlySlice definition, whose ABI declares public static FromArray");
        var container = new ImportedClassSymbol(clrType, null, (ImportedTypeSymbol)type, scope.References);
        var function = new ImportedFunctionSymbol("FromArray", container, method, null, type);
        return new BoundImportedCallExpression(
            syntax, function, ImmutableArray.Create<BoundExpression>(storage), staticContainerType: type);
    }

    private BoundExpression BindNativeSliceRange(BoundExpression target, RangeExpressionSyntax range)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var saved = DeclareRangeTemp("src", target.Type, target, statements);
        var receiver = new BoundVariableExpression(null, saved);
        var clrType = Invariant.Required(target.Type.ClrType, "BindRangeSlice dispatches here only after TryGetElement verifies the runtime type");
        var lengthProperty = Invariant.Required(
            clrType.GetProperty("Length"),
            "BindRangeSlice selects the SDK native descriptor, whose ABI declares Length");
        var length = new BoundClrPropertyAccessExpression(
            null, receiver, lengthProperty, TypeSymbol.Int32);

        var lowerBound = BindRangeBound(range.LowerBound);
        var upperBound = BindRangeBound(range.UpperBound);
        BoundImportedInstanceCallExpression call;
        if (lowerBound is { IsIndexValue: true } || upperBound is { IsIndexValue: true })
        {
            // ADR-0187: a saved `System.Index` bound (`s[i..j]`, `s[(^2)..]`)
            // resolves through the runtime's Range overload, exactly like a
            // saved `System.Range` index.
            var rangeMethod = clrType.GetMethods().Single(m => m.Name == "Subslice" && m.GetParameters().Length == 1);
            call = new BoundImportedInstanceCallExpression(
                range,
                receiver,
                rangeMethod,
                target.Type,
                ImmutableArray.Create(BuildSystemRangeValue(lowerBound, upperBound)));
            return new BoundBlockExpression(range, statements.ToImmutable(), call);
        }

        var lower = lowerBound?.Value ?? new BoundLiteralExpression(null, 0);
        var upper = upperBound?.Value ?? length;
        var method = clrType.GetMethods().Single(m => m.Name == "Subslice" && m.GetParameters().Length == 4);
        call = new BoundImportedInstanceCallExpression(
            range,
            receiver,
            method,
            target.Type,
            ImmutableArray.Create(
                lower,
                upper,
                new BoundLiteralExpression(null, lowerBound?.FromEnd == true),
                new BoundLiteralExpression(null, upperBound?.FromEnd == true)));
        return new BoundBlockExpression(range, statements.ToImmutable(), call);
    }
}
