// <copyright file="CSharpToGSharpTranslator.ObliviousContainerStorage.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations
import System.Collections.Generic
import System.Linq
import System.Runtime.CompilerServices

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        /// Issue #5537: whether [`symbol`](paramref) is source storage that receives an
        /// imported oblivious container from frozen metadata.
        ///
        /// gsc reads such a container as `C[T!]` (ADR-0186 §2). ADR-0186 §3 rule 3 gives
        /// `C[T!]` no conversion to an enabled `C[T]`, so a top-level `!!` cannot
        /// bridge the value. The storage keeps nullable element and argument positions
        /// (`[]T?`, `C[T?]`), which rule 2 accepts. Each non-null use of an element
        /// then gets `!!`, which throws where C# throws. This applies the #5413 decision A
        /// principle to translated code.
        ///
        /// The declaration ((cref:PromoteObliviousContainerStorage)) and every element
        /// read ((cref:ReadsObliviousContainerStorageElement)) ask this one question.
        /// @param symbol A local, field, property, parameter, or method return.
        /// @returns True when the storage keeps nullable nested reference positions.
        private func StoresObliviousContainerElements(symbol ISymbol?) bool {
            // The collector admits only candidates (cref:IsObliviousContainerStorageCandidate),
            // so membership is the whole answer.
            let destination ISymbol? = symbol?.OriginalDefinition
            return destination != nil && this.ObliviousContainerDestinations().Contains(destination)
        }

        private func ObliviousContainerDestinations() HashSet[ISymbol] -> ObliviousContainerDestinationsCache.GetValue(
            this.context.Compilation,
            (compilation Compilation) -> this.CollectObliviousContainerDestinations(compilation)
        )

        /// Issue #5537: makes the non-null nested reference positions of a storage
        /// declaration nullable when (cref:StoresObliviousContainerElements) holds.
        /// @param type The mapped declaration type.
        /// @param symbol The declared storage.
        /// @returns The declaration type to emit.
        private func PromoteObliviousContainerStorage(type GTypeReference?, symbol ISymbol?) GTypeReference? {
            if type == nil || !this.StoresObliviousContainerElements(symbol) {
                return type
            }
            return PromoteNestedReferencePositions(type, StorageType(symbol!!.OriginalDefinition))
        }

        /// Issue #5537: whether [`value`](paramref) reads an element of storage for
        /// which (cref:StoresObliviousContainerElements) holds: an element access or a
        /// `foreach` variable. G# types that element `T?`.
        /// @param value The C# expression.
        /// @returns True when the translated element read is nullable.
        private func ReadsObliviousContainerStorageElement(value ExpressionSyntax?) bool {
            if this.ObliviousContainerDestinations().Count == 0 {
                return false
            }
            let expression ExpressionSyntax? = Unparenthesize(value)
            if expression is ElementAccessExpressionSyntax elementAccess {
                return this.StoresObliviousContainerElements(
                    this.context.GetSymbolInfo(elementAccess.Expression).Symbol
                )
            }
            if expression == nil || this.context.GetSymbolInfo(expression).Symbol is not ILocalSymbol local {
                return false
            }
            for reference in local.DeclaringSyntaxReferences {
                if reference.GetSyntax() is ForEachStatementSyntax forEach && this.StoresObliviousContainerElements(
                    this.context.GetSymbolInfo(forEach.Expression).Symbol
                ) {
                    return true
                }
            }
            return false
        }

        private func CollectObliviousContainerDestinations(compilation Compilation) HashSet[ISymbol] {
            let destinations = HashSet[ISymbol](SymbolEqualityComparer.Default)
            for tree in compilation.SyntaxTrees {
                let model = compilation.GetSemanticModel(tree)
                for node in tree.GetRoot().DescendantNodes() {
                    var value ExpressionSyntax? = nil
                    var destination ISymbol? = nil
                    if node is AssignmentExpressionSyntax assignment {
                        if assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) {
                            value = assignment.Right
                            destination = model.GetSymbolInfo(assignment.Left).Symbol
                        }
                    } else if node is VariableDeclaratorSyntax declarator {
                        value = declarator.Initializer?.Value
                        if value != nil {
                            destination = model.GetDeclaredSymbol(declarator)
                        }
                    } else if node is PropertyDeclarationSyntax property {
                        value = property.Initializer?.Value
                        if value != nil {
                            destination = model.GetDeclaredSymbol(property)
                        }
                    } else if node is ArgumentSyntax argument {
                        if argument.RefKindKeyword.IsKind(SyntaxKind.None) {
                            value = argument.Expression
                        }
                    } else if node is ReturnStatementSyntax returnStatement {
                        value = returnStatement.Expression
                    } else if node is ArrowExpressionClauseSyntax arrow {
                        value = arrow.Expression
                    }
                    if value == nil || !this.ReadsFrozenObliviousContainer(value, model) {
                        continue
                    }
                    if node is ArgumentSyntax valueArgument {
                        destination = (model.GetOperation(valueArgument) as IArgumentOperation)?.Parameter
                    } else if node is ReturnStatementSyntax || node is ArrowExpressionClauseSyntax {
                        destination = ReturnDestination(model.GetEnclosingSymbol(value.SpanStart))
                    }
                    // A local whose declaration emits no type clause infers the platform
                    // container from its initializer, which needs no change.
                    if node is VariableDeclaratorSyntax &&
                        destination is ILocalSymbol local &&
                        !LocalInitializerStatesType(local, model.GetTypeInfo(value).Type) {
                        continue
                    }
                    let original ISymbol? = destination?.OriginalDefinition
                    if original != nil &&
                        IsObliviousContainerStorageCandidate(original, compilation) &&
                        SameContainerShape(model.GetTypeInfo(Unparenthesize(value)).Type, StorageType(original)) {
                        destinations.Add(original)
                    }
                }
            }
            return destinations
        }

        private func ReadsFrozenObliviousContainer(value ExpressionSyntax?, model SemanticModel) bool {
            var expression ExpressionSyntax? = Unparenthesize(value)
            while expression is PostfixUnaryExpressionSyntax suppression && suppression.IsKind(
                SyntaxKind.SuppressNullableWarningExpression
            ) {
                expression = Unparenthesize(suppression.Operand)
            }
            if !(
                expression is InvocationExpressionSyntax ||
                    expression is MemberAccessExpressionSyntax ||
                    expression is IdentifierNameSyntax
            ) {
                return false
            }
            let member ISymbol? = model.GetSymbolInfo(expression!!).Symbol
            return this.IsFrozenObliviousImportMember(member) &&
                ExposesPlatformNestedPosition(StorageType(member!!.OriginalDefinition))
        }

        shared {
            private let ObliviousContainerDestinationsCache ConditionalWeakTable[
                Compilation,
                HashSet[ISymbol]
            ] = ConditionalWeakTable[Compilation, HashSet[ISymbol]]()

            // A return or expression body stores its value in the enclosing method
            // or property. A lambda has no declaration that cs2gs can widen.
            private func ReturnDestination(enclosing ISymbol?) ISymbol? {
                if enclosing is not IMethodSymbol method || method.ReturnsByRef || method.IsAsync {
                    return nil
                }
                if method.MethodKind == MethodKind.PropertyGet {
                    return method.AssociatedSymbol
                }
                return if method.MethodKind == MethodKind.Ordinary || method.MethodKind == MethodKind.LocalFunction {
                    method
                } else {
                    nil
                }
            }

            // The translator emits a local type clause for an initializer only when the
            // C# type differs from the initializer type or states an outer `?`
            // (TranslateLocalDeclaration).
            private func LocalInitializerStatesType(
                local ILocalSymbol,
                initializerType ITypeSymbol?
            ) bool -> !IsImplicitlyTypedLocal(local) &&
                (
                !SymbolEqualityComparer.Default.Equals(local.Type, initializerType) ||
                    local
                    .Type
                    .NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated
            )

            private func IsObliviousContainerStorageCandidate(symbol ISymbol, compilation Compilation) bool {
                if symbol.DeclaringSyntaxReferences.IsDefaultOrEmpty || !SymbolEqualityComparer.Default.Equals(
                    symbol.ContainingAssembly,
                    compilation.Assembly
                ) {
                    return false
                }
                if symbol is IPropertySymbol{IsIndexer: true} ||
                    !(
                    symbol is ILocalSymbol ||
                        symbol is IFieldSymbol ||
                        symbol is IPropertySymbol ||
                        symbol is IParameterSymbol ||
                        symbol is IMethodSymbol
                ) {
                    return false
                }
                var signatureOwner ISymbol? = symbol
                if symbol is IParameterSymbol parameter {
                    if parameter.RefKind != RefKind.None {
                        return false
                    }
                    signatureOwner = parameter.ContainingSymbol
                }
                if (signatureOwner is IMethodSymbol || signatureOwner is IPropertySymbol) &&
                    (signatureOwner!!.IsOverride || ImplementsInterfaceMember(signatureOwner!!)) {
                    return false
                }
                return HasNonNullNestedReferencePosition(StorageType(symbol))
            }

            // An override or interface implementation keeps the signature of the
            // member it implements.
            private func ImplementsInterfaceMember(member ISymbol) bool {
                let explicitImplementations = if member is IMethodSymbol method {
                    method.ExplicitInterfaceImplementations.Length
                } else if member is IPropertySymbol property {
                    property.ExplicitInterfaceImplementations.Length
                } else {
                    0
                }
                if explicitImplementations > 0 {
                    return true
                }
                let containingType INamedTypeSymbol? = member.ContainingType
                if containingType == nil {
                    return false
                }
                for interfaceType in containingType.AllInterfaces {
                    for interfaceMember in interfaceType.GetMembers(member.Name) {
                        if SymbolEqualityComparer.Default.Equals(
                            containingType.FindImplementationForInterfaceMember(interfaceMember),
                            member
                        ) {
                            return true
                        }
                    }
                }
                return false
            }

            private func StorageType(symbol ISymbol?) ITypeSymbol? -> switch symbol {
                case local is ILocalSymbol: local.Type
                case field is IFieldSymbol: field.Type
                case property is IPropertySymbol: property.Type
                case parameter is IParameterSymbol: parameter.Type
                case method is IMethodSymbol: method.ReturnType
                default: default(ITypeSymbol?)
            }

            // The value and the storage have the same container: arrays of one rank, or
            // constructions of one generic definition. Other conversions, such as an
            // array to an interface, are not this rule.
            private func SameContainerShape(source ITypeSymbol?, storage ITypeSymbol?) bool {
                if source is IArrayTypeSymbol sourceArray {
                    return storage is IArrayTypeSymbol storageArray && sourceArray.Rank == storageArray.Rank
                }
                return source is INamedTypeSymbol sourceNamed &&
                    storage is INamedTypeSymbol storageNamed &&
                    sourceNamed.IsGenericType &&
                    SymbolEqualityComparer
                    .Default
                    .Equals(sourceNamed.OriginalDefinition, storageNamed.OriginalDefinition)
            }

            // Whether gsc reads a nested position of an oblivious member type as `T!`
            // (ADR-0186 §2). A concrete reference element or argument is platform. So is
            // a type-parameter argument of a constructed type. An array element that is
            // a type parameter takes the type argument of the call, so it is not
            // platform: `Array.Empty[T]()` reads as `[]T`.
            private func ExposesPlatformNestedPosition(type ITypeSymbol?) bool {
                if type is IArrayTypeSymbol array {
                    return (array.ElementType.IsReferenceType && array.ElementType is not ITypeParameterSymbol) ||
                        ExposesPlatformNestedPosition(array.ElementType)
                }
                if type is not INamedTypeSymbol named {
                    return false
                }
                for argument in named.TypeArguments {
                    if argument.IsReferenceType ||
                        argument is ITypeParameterSymbol ||
                        ExposesPlatformNestedPosition(argument) {
                        return true
                    }
                }
                return false
            }

            private func HasNonNullNestedReferencePosition(type ITypeSymbol?) bool {
                if type is IArrayTypeSymbol array {
                    return IsNonNullReferencePosition(array.ElementType) ||
                        HasNonNullNestedReferencePosition(array.ElementType)
                }
                if type is not INamedTypeSymbol named {
                    return false
                }
                for argument in named.TypeArguments {
                    if IsNonNullReferencePosition(argument) || HasNonNullNestedReferencePosition(argument) {
                        return true
                    }
                }
                return false
            }

            private func IsNonNullReferencePosition(type ITypeSymbol) bool -> type.IsReferenceType &&
                type is not ITypeParameterSymbol &&
                type.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .NotAnnotated

            // Makes each non-null reference position below the top level nullable,
            // at every depth. The top level keeps its nullability.
            private func PromoteNestedReferencePositions(type GTypeReference?, declared ITypeSymbol?) GTypeReference? {
                if type is ArrayTypeReference array && declared is IArrayTypeSymbol arraySymbol {
                    let element = PromoteNestedPosition(array.ElementType, arraySymbol.ElementType)
                    return if object.ReferenceEquals(element, array.ElementType) {
                        type
                    } else {
                        cast[GTypeReference](ArrayTypeReference(element, array.Rank){IsNullable = array.IsNullable})
                    }
                }
                if type is NamedTypeReference named &&
                    declared is INamedTypeSymbol namedSymbol &&
                    named
                    .TypeArguments
                    .Count > 0 &&
                    named
                    .TypeArguments
                    .Count == namedSymbol
                    .TypeArguments
                    .Length {
                    let arguments = List[GTypeReference](named.TypeArguments.Count)
                    var changed = false
                    for var i = 0; i < named.TypeArguments.Count; i++ {
                        let argument = PromoteNestedPosition(named.TypeArguments[i], namedSymbol.TypeArguments[i])
                        changed |= !object.ReferenceEquals(argument, named.TypeArguments[i])
                        arguments.Add(argument)
                    }
                    return if changed {
                        cast[GTypeReference](
                            NamedTypeReference(named.Name, arguments, named.ContainingType){
                                IsNullable = named.IsNullable
                            }
                        )
                    } else {
                        type
                    }
                }
                return type
            }

            private func PromoteNestedPosition(type GTypeReference, declared ITypeSymbol) GTypeReference {
                let inner = PromoteNestedReferencePositions(type, declared)!!
                return if IsNonNullReferencePosition(declared) && !inner.IsNullable {
                    MakeNullable(inner)!!
                } else {
                    inner
                }
            }
        }
    }
}
