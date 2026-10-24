// <copyright file="ExpressionBinder.NativeSlices.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import System.Reflection

internal partial class ExpressionBinder {
    private func BindBufferAwareCallExpression(syntax CallExpressionSyntax) BoundExpression {
        if syntax.Identifier.Text == "managed" && binderCtx.CanUseIntrinsicAlias(
            $scope,
            syntax.Identifier,
            getCurrentFunction(),
            expression: true
        ) {
            return BindManagedReference(syntax)
        }
        if syntax.ReadOnlyManagedModifier != nil {
            let ordinary = overloads.BindCallExpression(syntax)
            if !(ordinary is BoundErrorExpression) {
                Diagnostics.ReportManagedReference(
                    syntax.ReadOnlyManagedModifier!!.Location,
                    "readonly managed(location) requires the address intrinsic, not an ordinary same-named callable"
                )
            }
            return BoundErrorExpression(syntax)
        }
        if syntax.ConversionTypeClause is {
            IsArray: false,
            HasQualifier: false,
            HasTypeArguments: true,
            Identifier: {} spanIdentifier
        } spanType &&
            spanIdentifier.Text == "span" {
            let ordinary = CallExpressionSyntax(
                syntax.SyntaxTree,
                spanIdentifier,
                spanType.QuestionToken,
                BufferTypeArguments(spanType),
                syntax.OpenParenthesisToken,
                syntax.Arguments,
                syntax.CloseParenthesisToken
            )
            let useAlias = binderCtx.CanUseSpanAlias($scope, spanIdentifier, getCurrentFunction(), expression: true) &&
                !overloads.HasNonConstructorCallableCandidate(ordinary)
            if !useAlias && spanType.ReadOnlySpanModifier == nil {
                return overloads.BindCallExpression(ordinary)
            }
            if !useAlias {
                Diagnostics.ReportNativeSpanType(
                    spanType.Location,
                    "readonly span requires the native alias, not an ordinary same-named callable or type"
                )
                return BoundErrorExpression(syntax)
            }
            let boundTarget = bindTypeClause(spanType)
            if boundTarget == nil || boundTarget == TypeSymbol.Error {
                return BoundErrorExpression(syntax)
            }
            if boundTarget is not ImportedTypeSymbol target || target.ClrType is not{} clrType {
                Diagnostics.ReportNativeSpanType(
                    spanType.Location,
                    "span constructor heads require a non-nullable CLR span type"
                )
                return BoundErrorExpression(syntax)
            }
            if TryBindClrConstructorFromType(
                clrType,
                ordinary,
                out var result,
                out var noApplicableOverload,
                out var arguments,
                clrType.GetGenericTypeDefinition(),
                target.ConstructedTypeArguments,
                resultTypeOverride: target
            ) {
                return Invariant.Required(
                    result,
                    "a successful native span constructor binding produces a result",
                    expression: "result"
                )
            }
            FinishClrConstructorBindingFailure(ordinary, target.Name, noApplicableOverload, arguments, &result, target)
            return result ?? BoundErrorExpression(syntax)
        }
        if syntax.ConversionTypeClause is {
            IsArray: false,
            HasQualifier: false,
            HasTypeArguments: true,
            ReadOnlySliceModifier: nil,
            ReadOnlySpanModifier: nil,
            Identifier: {} identifier
        } type &&
            (
            (identifier.Text is "slice" or "array") && !binderCtx.CanUseNativeBufferAlias(
                $scope,
                identifier,
                getCurrentFunction(),
                expression: true
            )
        ) {
            let ordinary = CallExpressionSyntax(
                syntax.SyntaxTree,
                identifier,
                type.QuestionToken,
                BufferTypeArguments(type),
                syntax.OpenParenthesisToken,
                syntax.Arguments,
                syntax.CloseParenthesisToken
            )
            return overloads.BindCallExpression(ordinary)
        }
        return overloads.BindCallExpression(syntax)
    }

    private func BindOrdinaryBufferCollectionLiteral(
        syntax CollectionInitializerExpressionSyntax,
        type TypeClauseSyntax,
        identifier SyntaxToken
    ) BoundExpression {
        let typeArguments = BufferTypeArguments(type)
        let position = typeArguments.CloseBracketToken.Span.End
        let constructor = CallExpressionSyntax(
            syntax.SyntaxTree,
            identifier,
            typeArguments,
            SyntaxToken(syntax.SyntaxTree, SyntaxKind.OpenParenthesisToken, position, "(", nil),
            GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax](ImmutableArray[SyntaxNode].Empty),
            SyntaxToken(syntax.SyntaxTree, SyntaxKind.CloseParenthesisToken, position, ")", nil)
        )
        return BindCollectionInitializerSuffix(syntax, overloads.BindCallExpression(constructor))
    }

    private func BindEmptyNativeBufferLiteral(
        syntax StructLiteralExpressionSyntax,
        arguments TypeArgumentListSyntax
    ) BoundExpression {
        if syntax.Elements.Count != 0 || syntax.SpreadExpression != nil {
            Diagnostics.ReportNativeSliceType(syntax.Location, "native buffer literals require positional elements")
            return BoundErrorExpression(syntax)
        }
        let type = TypeClauseSyntax(
            syntax.SyntaxTree,
            nil,
            nil,
            nil,
            syntax.TypeIdentifier,
            arguments.OpenBracketToken,
            arguments.Arguments,
            arguments.CloseBracketToken,
            nil
        )
        return BindNativeBufferLiteral(
            CollectionInitializerExpressionSyntax(
                syntax.SyntaxTree,
                nil,
                syntax.OpenBraceToken,
                GSharp
                    .Core
                    .CodeAnalysis
                    .Syntax
                    .SeparatedSyntaxList[CollectionElementSyntax](ImmutableArray[SyntaxNode].Empty),
                syntax.CloseBraceToken
            ){BufferType = type}
        )
    }

    private func ValidateNativeSharingArguments(
        container ImportedClassSymbol?,
        name string,
        arguments ImmutableArray[BoundExpression],
        syntax SyntaxNode
    ) bool {
        if container == nil || !((name == "FromArray" || name == "TryFromMemory")) || !NativeSliceTypes.TryGetElement(
            container.SymbolicReceiver ?? TypeSymbol.FromClrTypeWithoutNullability(
                container.ClassType,
                NullabilityFreeReason.TypeStructure
            ),
            out var targetElement,
            out _
        ) {
            return true
        }
        for argument in arguments {
            var sourceElement TypeSymbol? = GetArraySliceElementType(argument.Type)
            if name == "TryFromMemory" &&
                argument
                .Type
                .ClrType is {IsGenericType: true} clr &&
                (clr.GetGenericTypeDefinition().FullName is "System.Memory`1" or "System.ReadOnlyMemory`1") {
                sourceElement = if argument.Type is NullabilityAnnotatedTypeSymbol annotated {
                    annotated.GetTypeArgumentSymbol(0)
                } else {
                    argument.Type.ConstructedTypeArguments[0]
                }
            }
            if sourceElement != nil && !NullableFlagsBuilder.Build(sourceElement).SequenceEqual(
                NullableFlagsBuilder.Build(targetElement!!)
            ) {
                Diagnostics.ReportNativeSliceType(
                    argument.Syntax?.Location ?? syntax.Location,
                    "sharing storage cannot change element nullability"
                )
                return false
            }
        }
        return true
    }

    private func TrySaveNativeElementReceiver(
        receiver BoundExpression,
        out savedReceiver BoundExpression,
        out prefix ImmutableArray[BoundStatement]
    ) bool {
        savedReceiver = receiver
        prefix = ImmutableArray[BoundStatement].Empty
        if !HasNativeSliceElementRoot(receiver) {
            return false
        }
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        if Binder.IsReferenceTypeForConstraint(receiver.Type) {
            let value = DeclareRangeTemp("receiver", receiver.Type, receiver, statements)
            savedReceiver = BoundVariableExpression(receiver.Syntax, value)
            prefix = statements.ToImmutable()
            return true
        }
        if RefCapabilities.IsReadOnlyReference(receiver) {
            return false
        }
        let pointer = BoundAddressOfExpression(receiver.Syntax, receiver)
        let location = DeclareRangeTemp("receiverAddress", pointer.Type, pointer, statements)
        savedReceiver = BoundDereferenceExpression(receiver.Syntax, BoundVariableExpression(nil, location))
        prefix = statements.ToImmutable()
        return true
    }

    private func BindNativeSliceIndex(
        target BoundExpression,
        syntax ExpressionSyntax,
        boundIndex BoundExpression? = nil
    ) BoundExpression {
        NativeSliceTypes.TryGetElement(target.Type, out var element, out _)
        let elementType = Invariant.Required(
            element,
            "native index read/write dispatch calls this helper only after TryGetElement succeeds",
            expression: "element"
        )
        let clrType = Invariant.Required(
            target.Type.ClrType,
            "native index read/write dispatch verifies the runtime type with TryGetElement",
            expression: "target.Type.ClrType"
        )
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let saved = DeclareRangeTemp("src", target.Type, target, statements)
        let receiver = BoundVariableExpression(nil, saved)
        var arguments ImmutableArray[BoundExpression]
        var indexer PropertyInfo
        if boundIndex == nil && syntax is FromEndIndexExpressionSyntax fromEnd {
            arguments = ImmutableArray.Create[BoundExpression](
                conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32),
                BoundLiteralExpression(nil, true)
            )
            indexer = clrType.GetProperties().Single((p PropertyInfo) -> p.GetIndexParameters().Length == 2)
        } else {
            var index = boundIndex ?? BindExpression(syntax)
            if ClrTypeUtilities.AreSame(index.Type.ClrType, typeof(Range)) {
                let method = clrType.GetMethods().Single(
                    (m MethodInfo) -> m.Name == "Subslice" && m.GetParameters().Length == 1
                )
                return BoundBlockExpression(
                    syntax,
                    statements.ToImmutable(),
                    BoundImportedInstanceCallExpression(
                        syntax,
                        receiver,
                        method,
                        target.Type,
                        ImmutableArray.Create(index)
                    )
                )
            }
            let isIndex = ClrTypeUtilities.AreSame(index.Type.ClrType, typeof(Index))
            if !isIndex {
                index = conversions.BindConversion(syntax.Location, index, TypeSymbol.Int32)
            }
            arguments = ImmutableArray.Create(index)
            indexer = clrType.GetProperties().Single(
                (p PropertyInfo) -> p.GetIndexParameters() is {Length: 1} parameters && ClrTypeUtilities.AreSame(
                    parameters[0].ParameterType,
                    if isIndex {
                        typeof(Index)
                    } else {
                        typeof(int32)
                    }
                )
            )
        }
        let pointer = BoundClrIndexExpression(syntax, receiver, indexer, arguments, ByRefTypeSymbol.Get(elementType))
        return BoundDereferenceExpression(syntax, BoundBlockExpression(syntax, statements.ToImmutable(), pointer))
    }

    private func BindNativeSliceAssignment(
        target BoundExpression,
        indexSyntax ExpressionSyntax,
        value BoundExpression,
        location TextLocation,
        boundIndex BoundExpression? = nil
    ) BoundExpression {
        if NativeSliceTypes.TryGetElement(target.Type, out _, out var readOnly) && readOnly {
            Diagnostics.ReportNativeSliceReadOnlyElement(location)
            return BoundErrorExpression(indexSyntax)
        }
        if AsyncBoundTreeQueries.HasAwait(value) {
            Diagnostics.ReportNativeSliceSuspendingWrite(location)
            return BoundErrorExpression(indexSyntax)
        }
        if BindNativeSliceIndex(target, indexSyntax, boundIndex) is not BoundDereferenceExpression access {
            Diagnostics.ReportNativeSliceType(location, "a range is a view, not an assignable element")
            return BoundErrorExpression(indexSyntax)
        }
        return BoundIndirectAssignmentExpression(indexSyntax, access.Operand, value)
    }

    private func BindNativeSliceCompoundAssignment(
        target BoundExpression,
        indexSyntax ExpressionSyntax,
        operation SyntaxToken,
        valueSyntax ExpressionSyntax,
        returnsPreviousValue bool,
        isIncrementDecrement bool
    ) BoundExpression {
        NativeSliceTypes.TryGetElement(target.Type, out _, out var readOnly)
        if readOnly {
            Diagnostics.ReportNativeSliceReadOnlyElement(operation.Location)
            return BoundErrorExpression(indexSyntax)
        }
        let value = BindExpression(valueSyntax)
        if AsyncBoundTreeQueries.HasAwait(value) {
            Diagnostics.ReportNativeSliceSuspendingWrite(valueSyntax.Location)
            return BoundErrorExpression(indexSyntax)
        }
        if BindNativeSliceIndex(target, indexSyntax) is not BoundDereferenceExpression access {
            Diagnostics.ReportNativeSliceType(operation.Location, "a range is not an assignable element")
            return BoundErrorExpression(indexSyntax)
        }
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let address = DeclareRangeTemp("address", access.Operand.Type, access.Operand, statements)
        let addressRef = BoundVariableExpression(nil, address)
        SyntaxFacts.TryGetCompoundAssignmentBaseOperator(operation.Kind, out var binaryKind)
        var read BoundExpression = BoundDereferenceExpression(nil, addressRef)
        let compoundTarget = read
        let previousValue = CapturePostfixCompoundValue(
            returnsPreviousValue,
            indexSyntax,
            &read,
            out var previousDeclaration
        )
        let userCompound BoundExpression? = TryBindUserCompoundAssignmentOperator(
            operation.Kind,
            compoundTarget,
            value,
            valueSyntax.Location
        )
        if userCompound != nil {
            return FinishUserCompoundIncrement(
                indexSyntax,
                returnsPreviousValue,
                isIncrementDecrement,
                compoundTarget,
                userCompound,
                previousDeclaration,
                previousValue,
                statements
            )
        }
        var result BoundExpression? = TryBindCompoundBinaryOperation(binaryKind, read, value, valueSyntax.Location)
        if result == nil {
            Diagnostics.ReportUndefinedBinaryOperator(operation.Location, operation.Text, access.Type, value.Type)
            return BoundErrorExpression(indexSyntax)
        }
        result = conversions.BindConversion(valueSyntax.Location, result, access.Type)
        let assignment = BoundIndirectAssignmentExpression(indexSyntax, addressRef, result)
        return FinishPostfixCompoundAssignment(indexSyntax, statements, previousDeclaration, previousValue, assignment)
    }

    private func RejectNativeSpanAllocation(syntax ExpressionSyntax) BoundExpression {
        Diagnostics.ReportNativeSpanType(
            syntax.Location,
            "span aliases add no collection-literal allocation; use an existing CLR span constructor explicitly"
        )
        return BoundErrorExpression(syntax)
    }

    private func BindNativeBufferLiteral(syntax CollectionInitializerExpressionSyntax) BoundExpression {
        if syntax.BufferType is {Identifier: {} spanName} spanType &&
            (
            spanType.ReadOnlySpanModifier != nil || binderCtx.CanUseSpanAlias(
                $scope,
                spanName,
                getCurrentFunction(),
                expression: true
            )
        ) {
            return RejectNativeSpanAllocation(syntax)
        }

        if syntax.BufferType is {ReadOnlySliceModifier: nil, Identifier: {} name} ordinaryType &&
            !binderCtx
            .CanUseNativeBufferAlias($scope, name, getCurrentFunction(), expression: true) {
            return BindOrdinaryBufferCollectionLiteral(syntax, ordinaryType, name)
        }
        let type TypeSymbol? = bindTypeClause(
            Invariant.Required(
                syntax.BufferType,
                "native literals carry their buffer type",
                expression: "syntax.BufferType"
            )
        )
        if type == nil || type == TypeSymbol.Error {
            return BoundErrorExpression(syntax)
        }
        let element TypeSymbol? = if type is SliceTypeSymbol array {
            array.ElementType
        } else {
            (
                if NativeSliceTypes.TryGetElement(type, out var nativeElement, out _) {
                    nativeElement
                } else {
                    default(TypeSymbol?)
                }
            )
        }
        if element == nil {
            Diagnostics.ReportNativeSliceType(syntax.Location, "a buffer literal requires a non-null buffer type")
            return BoundErrorExpression(syntax)
        }
        let elements = ImmutableArray.CreateBuilder[BoundExpression]()
        for initializer in syntax.Elements {
            if initializer is not ExpressionCollectionElementSyntax item ||
                item.Expression is SpreadElementExpressionSyntax {
                Diagnostics.ReportNativeSliceType(
                    initializer.Location,
                    "a native buffer literal requires individual positional elements"
                )
                continue
            }
            elements.Add(BindExpression(item.Expression, element))
        }
        let storage = BoundArrayCreationExpression(syntax, SliceTypeSymbol.Get(element), elements.ToImmutable())
        if type is SliceTypeSymbol {
            return storage
        }
        // A symbolic declaring-type receiver keeps T in FromArray's MemberRef,
        // including source-defined value types whose CLR type does not exist yet.
        let clrType = Invariant.Required(
            type.ClrType,
            "TryGetElement selected the native runtime type after the array-literal branch returned",
            expression: "type.ClrType"
        )
        let method = Invariant.Required(
            clrType.GetMethod("FromArray", BindingFlags.Public | BindingFlags.Static),
            "native type binding selects the SDK Slice/ReadOnlySlice definition, whose ABI declares public static FromArray",
            expression: "clrType.GetMethod(\"FromArray\", BindingFlags.Public | BindingFlags.Static)"
        )
        let container = ImportedClassSymbol(clrType, nil, cast[ImportedTypeSymbol](type), $scope.References)
        let function = ImportedFunctionSymbol("FromArray", container, method, nil, type)
        return BoundImportedCallExpression(
            syntax,
            function,
            ImmutableArray.Create[BoundExpression](storage),
            staticContainerType: type
        )
    }

    private func BindNativeSliceRange(target BoundExpression, $range RangeExpressionSyntax) BoundExpression {
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let saved = DeclareRangeTemp("src", target.Type, target, statements)
        let receiver = BoundVariableExpression(nil, saved)
        let clrType = Invariant.Required(
            target.Type.ClrType,
            "BindRangeSlice dispatches here only after TryGetElement verifies the runtime type",
            expression: "target.Type.ClrType"
        )
        let lengthProperty = Invariant.Required(
            clrType.GetProperty("Length"),
            "BindRangeSlice selects the SDK native descriptor, whose ABI declares Length",
            expression: "clrType.GetProperty(\"Length\")"
        )
        let length = BoundClrPropertyAccessExpression(nil, receiver, lengthProperty, TypeSymbol.Int32)
        let lowerBound = BindRangeBound($range.LowerBound)
        let upperBound = BindRangeBound($range.UpperBound)
        var call BoundImportedInstanceCallExpression
        if lowerBound != nil &&
            lowerBound!!.IsIndexValue == true ||
            upperBound != nil &&
            upperBound!!.IsIndexValue == true {
            // ADR-0187: a saved `System.Index` bound (`s[i..j]`, `s[(^2)..]`)
            // resolves through the runtime's Range overload, exactly like a
            // saved `System.Range` index.
            let rangeMethod = clrType.GetMethods().Single(
                (m MethodInfo) -> m.Name == "Subslice" && m.GetParameters().Length == 1
            )
            call = BoundImportedInstanceCallExpression(
                $range,
                receiver,
                rangeMethod,
                target.Type,
                ImmutableArray.Create(BuildSystemRangeValue(lowerBound, upperBound))
            )
            return BoundBlockExpression($range, statements.ToImmutable(), call)
        }
        let lower = lowerBound?.Value ?? BoundLiteralExpression(nil, 0)
        let upper = upperBound?.Value ?? length
        let method = clrType.GetMethods().Single(
            (m MethodInfo) -> m.Name == "Subslice" && m.GetParameters().Length == 4
        )
        call = BoundImportedInstanceCallExpression(
            $range,
            receiver,
            method,
            target.Type,
            ImmutableArray.Create(
                lower,
                upper,
                BoundLiteralExpression(nil, lowerBound?.FromEnd == true),
                BoundLiteralExpression(nil, upperBound?.FromEnd == true)
            )
        )
        return BoundBlockExpression($range, statements.ToImmutable(), call)
    }

    shared {
        private func BufferTypeArguments(type TypeClauseSyntax) TypeArgumentListSyntax -> TypeArgumentListSyntax(
            type.SyntaxTree,
            Invariant.Required(
                type.TypeArgumentOpenBracketToken,
                "buffer call/literal parsing supplies the generic opening bracket",
                expression: "type.TypeArgumentOpenBracketToken"
            ),
            Invariant.Required(
                type.TypeArguments,
                "buffer call/literal parsing supplies the generic argument list",
                expression: "type.TypeArguments"
            ),
            Invariant.Required(
                type.TypeArgumentCloseBracketToken,
                "buffer call/literal parsing supplies the generic closing bracket",
                expression: "type.TypeArgumentCloseBracketToken"
            )
        )

        private func HasNativeSliceElementRoot(expression BoundExpression) bool -> switch expression {
            case index is BoundClrIndexExpression: NativeSliceTypes.TryGetElement(index.Target.Type, out _, out _)
            case block is BoundBlockExpression: HasNativeSliceElementRoot(block.Expression)
            case dereference is BoundDereferenceExpression: HasNativeSliceElementRoot(dereference.Operand)
            case BoundFieldAccessExpression{Receiver: {} receiver}: HasNativeSliceElementRoot(receiver)
            case BoundClrPropertyAccessExpression{Receiver: {} receiver}: HasNativeSliceElementRoot(receiver)
            default: false
        }
    }
}
