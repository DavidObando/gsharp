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
        /// bridge the value. The storage makes each nested position that the producer
        /// leaves platform nullable (`[]T?`, `C[T?]`), which rule 2 accepts. Each non-null
        /// use of an element then gets `!!`, which throws where C# throws. This applies the
        /// #5413 decision A principle to translated code.
        ///
        /// The declaration ((cref:PromoteObliviousContainerStorage)), a construction
        /// stored there ((cref:PromoteObliviousContainerCreation)), and every element read
        /// ((cref:ReadsObliviousContainerStorageElement)) ask this one question.
        /// @param symbol A local, field, property, parameter, or method return.
        /// @returns True when the storage keeps nullable nested reference positions.
        private func StoresObliviousContainerElements(symbol ISymbol?) bool {
            let destination ISymbol? = symbol?.OriginalDefinition
            return destination != nil && this.ObliviousContainerDestinations().ContainsKey(destination)
        }

        private func ObliviousContainerDestinations() Dictionary[ISymbol, HashSet[string]] ->
        ObliviousContainerDestinationsCache.GetValue(
            this.context.Compilation,
            (compilation Compilation) -> this.CollectObliviousContainerDestinations(compilation)
        )

        // The nested positions of the storage that become nullable. A position is the
        // dotted list of element (`0`) and type-argument indexes from the top level.
        private func ObliviousContainerPositions(symbol ISymbol?) HashSet[string]? {
            let destination ISymbol? = symbol?.OriginalDefinition
            if destination == nil {
                return nil
            }
            return if this.ObliviousContainerDestinations().TryGetValue(destination, out var positions) {
                positions
            } else {
                nil
            }
        }

        /// Issue #5537: makes the recorded nested positions of a storage declaration
        /// nullable when (cref:StoresObliviousContainerElements) holds.
        /// @param type The mapped declaration type.
        /// @param symbol The declared storage.
        /// @returns The declaration type to emit.
        private func PromoteObliviousContainerStorage(type GTypeReference?, symbol ISymbol?) GTypeReference? {
            let positions = this.ObliviousContainerPositions(symbol)
            if type == nil || positions == nil {
                return type
            }
            return PromoteNestedPositions(type, StorageType(symbol!!.OriginalDefinition), positions, "")
        }

        /// Issue #5537: a `params` parameter states the same nullable positions as
        /// other oblivious container storage. A carrier that keeps its type after the
        /// ellipsis (`...[]List[T]`, `...IEnumerable[T]`) is promoted as whole storage;
        /// an array spelled as its element (`...T`) is promoted below position `0`.
        /// @param type The mapped type that follows the ellipsis.
        /// @param mappedType The C# type that `type` spells.
        /// @param parameter The `params` parameter.
        /// @returns The variadic type to emit.
        private func PromoteObliviousParamsElement(
            type GTypeReference?,
            mappedType ITypeSymbol,
            parameter IParameterSymbol
        ) GTypeReference? {
            if SymbolEqualityComparer.Default.Equals(mappedType, parameter.Type) {
                return this.PromoteObliviousContainerStorage(type, parameter)
            }
            let positions = this.ObliviousContainerPositions(parameter)
            if type == nil || positions == nil || parameter.OriginalDefinition.Type is not IArrayTypeSymbol arrayType {
                return type
            }
            let element = PromoteNestedPositions(type, arrayType.ElementType, positions, "0.")!!
            return if positions.Contains("0") && !element.IsNullable {
                MakeNullable(element)
            } else {
                element
            }
        }

        /// Issue #5537: whether (cref:PromoteObliviousParamsElement) makes the expanded
        /// element of a `params` parameter nullable. Position `0` is the array element
        /// or the single type argument of a collection carrier.
        /// @param parameter The `params` parameter.
        /// @returns True when an expanded argument may be nil.
        private func ObliviousParamsElementIsPromoted(parameter IParameterSymbol) bool -> GetParamsElementType(
            parameter
        ) != nil &&
            this
            .ObliviousContainerPositions(parameter)?.Contains("0") == true

        /// Issue #5537: a construction stored in oblivious container storage spells the
        /// same nullable positions as the storage, so no conversion changes them.
        /// @param type The mapped constructed type.
        /// @param createdType The constructed C# type.
        /// @param creation The construction.
        /// @returns The constructed type to emit.
        private func PromoteObliviousContainerCreation(
            type GTypeReference?,
            createdType ITypeSymbol?,
            creation ExpressionSyntax
        ) GTypeReference? {
            let sink ISymbol? = this.ResolveValueSink(creation)
            let positions = this.ObliviousContainerPositions(sink)
            if type == nil ||
                positions == nil ||
                !SameContainerShape(createdType, StorageType(sink!!.OriginalDefinition)) {
                return type
            }
            return PromoteNestedPositions(type, createdType, positions, "")
        }

        /// Issue #5537: whether an array construction stored in oblivious container
        /// storage has a nullable element.
        /// @param creation The array construction.
        /// @returns True when the element type is nullable.
        private func ObliviousContainerSinkPromotesArrayElement(creation ExpressionSyntax?) bool {
            let sink ISymbol? = this.ResolveValueSink(creation)
            return StorageType(sink?.OriginalDefinition) is IArrayTypeSymbol && this.ObliviousContainerPositions(sink)
                ?.Contains("0") == true
        }

        /// Issue #5537: whether [`value`](paramref) reads an element that oblivious
        /// container storage keeps nullable: an indexer element or a `foreach`
        /// variable. G# types that element `T?`.
        /// @param value The C# expression.
        /// @returns True when the translated element read is nullable.
        private func ReadsObliviousContainerStorageElement(value ExpressionSyntax?) bool {
            if this.ObliviousContainerDestinations().Count == 0 {
                return false
            }
            let expression ExpressionSyntax? = Unparenthesize(value)
            if expression is ElementAccessExpressionSyntax elementAccess {
                return this.ElementPositionIsPromoted(
                    this.context.GetSymbolInfo(elementAccess.Expression).Symbol,
                    this.context.GetSymbolInfo(elementAccess).Symbol
                )
            }
            // A field, property, or method of the container whose type is one of the
            // container's type parameters reads that position (`box.Value`, `box.Get()`).
            if expression is MemberAccessExpressionSyntax memberAccess &&
                this
                .context
                .GetSymbolInfo(memberAccess)
                .Symbol is {} memberSymbol &&
                (memberSymbol is IFieldSymbol || memberSymbol is IPropertySymbol) {
                return this.ElementPositionIsPromoted(
                    this.context.GetSymbolInfo(memberAccess.Expression).Symbol,
                    memberSymbol
                )
            }
            if expression is InvocationExpressionSyntax{Expression: MemberAccessExpressionSyntax target} invocation &&
                this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is IMethodSymbol{ReducedFrom: nil} method {
                return this.ElementPositionIsPromoted(this.context.GetSymbolInfo(target.Expression).Symbol, method)
            }
            if expression == nil || this.context.GetSymbolInfo(expression).Symbol is not ILocalSymbol local {
                return false
            }
            for reference in local.DeclaringSyntaxReferences {
                if reference.GetSyntax() is ForEachStatementSyntax forEach {
                    let container ISymbol? = this.context.GetSymbolInfo(forEach.Expression).Symbol
                    let containerType ITypeSymbol? = StorageType(container?.OriginalDefinition)
                    return this.ElementPositionIsPromoted(container, nil) &&
                        (
                        containerType is IArrayTypeSymbol ||
                            containerType is INamedTypeSymbol{TypeArguments: {Length: 1}}
                    )
                }
            }
            return false
        }

        /// Issue #5537: whether [`value`](paramref) is written into a position that
        /// oblivious container storage keeps nullable, so the write accepts nil. The
        /// container is the receiver of a call or element write, or a construction
        /// stored in such storage whose collection initializer holds the value. The
        /// written parameter or indexer is typed by the container's type parameter, or
        /// the value is an array element.
        /// @param value The written C# value.
        /// @returns True when the destination position of the value is `T?` in G#.
        private func WritesObliviousContainerStorageElement(value ExpressionSyntax?) bool {
            if value == nil || this.ObliviousContainerDestinations().Count == 0 {
                return false
            }
            var written ExpressionSyntax = value
            while written.Parent is ParenthesizedExpressionSyntax parenthesized {
                written = parenthesized
            }
            let parent SyntaxNode? = written.Parent
            // `items.Add(value)`, `items.Insert(0, value)`, `map.Add(key, value)`.
            if parent is ArgumentSyntax{
                Parent: ArgumentListSyntax{Parent: InvocationExpressionSyntax invocation}
            } argument &&
                invocation.Expression is MemberAccessExpressionSyntax target &&
                this
                .context
                .SemanticModel
                .GetOperation(argument) is IArgumentOperation{Parameter: {} parameter} &&
                parameter.ContainingSymbol is IMethodSymbol{ReducedFrom: nil} {
                return this.ElementPositionIsPromoted(this.context.GetSymbolInfo(target.Expression).Symbol, parameter)
            }
            // `items[0] = value`, `lines[0] = value`, `map[key] = value`.
            if parent is AssignmentExpressionSyntax{Left: ElementAccessExpressionSyntax access} assignment &&
                assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) && assignment.Right == written {
                return this.ElementPositionIsPromoted(
                    this.context.GetSymbolInfo(access.Expression).Symbol,
                    this.context.GetSymbolInfo(access).Symbol
                )
            }
            // `new List<T> { value }`, `new Dictionary<K, V> { { key, value } }` and
            // `new Dictionary<K, V> { [key] = value }`.
            var element SyntaxNode = written
            var index = 0
            var member ISymbol? = nil
            if parent is AssignmentExpressionSyntax{
                Left: ImplicitElementAccessSyntax implicitAccess
            } initializerAssignment &&
                initializerAssignment.Right == written {
                member = this.context.GetSymbolInfo(implicitAccess).Symbol
                element = initializerAssignment
            } else if parent is InitializerExpressionSyntax complex && complex.IsKind(
                SyntaxKind.ComplexElementInitializerExpression
            ) {
                index = complex.Expressions.IndexOf(written)
                element = complex
            }
            if element.Parent is not InitializerExpressionSyntax initializer ||
                initializer.Parent is not BaseObjectCreationExpressionSyntax creation {
                return false
            }
            if member == nil {
                if !initializer.IsKind(SyntaxKind.CollectionInitializerExpression) ||
                    this
                    .context
                    .SemanticModel
                    .GetCollectionInitializerSymbolInfo(cast[ExpressionSyntax](element))
                    .Symbol is not IMethodSymbol add ||
                    index < 0 ||
                    index >= add
                    .Parameters
                    .Length {
                    return false
                }
                member = add.Parameters[index]
            }
            let sink ISymbol? = this.ResolveValueSink(creation)
            return SameContainerShape(this.context.GetTypeInfo(creation).Type, StorageType(sink?.OriginalDefinition)) &&
                this.ElementPositionIsPromoted(sink, member)
        }

        // The element of an array, or a member result that is a type parameter of the
        // container type, is a recorded position of the storage. A nil member is the
        // single element position of a `foreach`. A parameter typed by a type parameter
        // of the container is a written position.
        private func ElementPositionIsPromoted(container ISymbol?, member ISymbol?) bool {
            let positions = this.ObliviousContainerPositions(container)
            if positions == nil {
                return false
            }
            // An array has no member typed by its element. Only an element access or a
            // `foreach` (no member) reads the element.
            if StorageType(container!!.OriginalDefinition) is IArrayTypeSymbol {
                return member == nil && positions.Contains("0")
            }
            // A separate kind comparison, not an enum property pattern (#4153).
            let memberType ITypeSymbol? = StorageType(member?.OriginalDefinition)
            let containerDefinition ISymbol? = StorageType(container!!.OriginalDefinition)?.OriginalDefinition
            let ordinal = if memberType is ITypeParameterSymbol parameter &&
                parameter.TypeParameterKind == TypeParameterKind.Type &&
                SymbolEqualityComparer
                .Default
                .Equals(parameter.DeclaringType, containerDefinition) {
                parameter.Ordinal
            } else if member == nil {
                0
            } else {
                -1
            }
            return ordinal >= 0 && positions.Contains(
                ordinal.ToString(System.Globalization.CultureInfo.InvariantCulture)
            )
        }

        private func CollectObliviousContainerDestinations(compilation Compilation) Dictionary[
            ISymbol,
            HashSet[string]
        ] {
            let destinations = Dictionary[ISymbol, HashSet[string]](SymbolEqualityComparer.Default)
            let assignedLocals = HashSet[ISymbol](SymbolEqualityComparer.Default)
            let initializedLocals = List[(Local ILocalSymbol, Positions HashSet[string], StatesType bool)]()
            let flows = List[(Source ISymbol, Destination ISymbol)]()
            for tree in compilation.SyntaxTrees {
                let model = compilation.GetSemanticModel(tree)
                for node in tree.GetRoot().DescendantNodes() {
                    var value ExpressionSyntax? = nil
                    var destination ISymbol? = nil
                    if node is AssignmentExpressionSyntax assignment {
                        if assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) {
                            value = assignment.Right
                            destination = model.GetSymbolInfo(assignment.Left).Symbol
                            if destination is ILocalSymbol {
                                assignedLocals.Add(destination)
                            }
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
                    let read ExpressionSyntax? = StorageRead(value)
                    if read == nil {
                        continue
                    }
                    let readSymbol ISymbol? = model.GetSymbolInfo(read).Symbol
                    let producer ITypeSymbol? = this.FrozenObliviousContainerType(read, readSymbol, model)
                    let source ISymbol? = if producer == nil && IsSourceStorage(readSymbol, compilation) {
                        readSymbol!!.OriginalDefinition
                    } else {
                        nil
                    }
                    if producer == nil && source == nil {
                        continue
                    }
                    if node is ArgumentSyntax valueArgument {
                        destination = (model.GetOperation(valueArgument) as IArgumentOperation)?.Parameter
                    } else if node is ReturnStatementSyntax || node is ArrowExpressionClauseSyntax {
                        destination = ReturnDestination(model.GetEnclosingSymbol(value!!.SpanStart))
                    }
                    let original ISymbol? = destination?.OriginalDefinition
                    if original == nil || !IsObliviousContainerStorageCandidate(original, compilation) {
                        continue
                    }
                    if source != nil {
                        if SameContainerShape(StorageType(source), StorageType(original)) ||
                            ImplementedContainerArguments(StorageType(source), StorageType(original)) != nil {
                            flows.Add((source, original))
                        }
                        continue
                    }
                    let positions = HashSet[string](System.StringComparer.Ordinal)
                    CollectPlatformPositions(producer, StorageType(original), "", positions)
                    if positions.Count == 0 {
                        continue
                    }
                    if node is VariableDeclaratorSyntax && original is ILocalSymbol local {
                        initializedLocals.Add(
                            (local, positions, LocalInitializerStatesType(local, model.GetTypeInfo(value!!).Type))
                        )
                        continue
                    }
                    AddPositions(destinations, original, positions)
                }
            }
            // A local without a type clause infers the platform container from its
            // initializer. It needs storage of its own only when it is also assigned.
            for (local, positions, statesType) in initializedLocals {
                if statesType || assignedLocals.Contains(local) {
                    AddPositions(destinations, local, positions)
                }
            }
            // Storage that receives oblivious container storage as a whole value (an
            // alias, an argument, a return) stores the same nullable positions.
            var changed = true
            while changed {
                changed = false
                for (source, destination) in flows {
                    if destinations.TryGetValue(source, out var positions) {
                        let carried = HashSet[string](System.StringComparer.Ordinal)
                        let sourceType ITypeSymbol? = StorageType(source)
                        let destinationType ITypeSymbol? = StorageType(destination)
                        for sourcePosition in positions {
                            let position string? = MapContainerPosition(sourceType, destinationType, sourcePosition)
                            if position != nil &&
                                PositionType(destinationType, position) is {} positionType &&
                                IsNonNullReferencePosition(positionType) {
                                carried.Add(position)
                            }
                        }
                        changed |= carried.Count > 0 && AddPositions(destinations, destination, carried)
                    }
                }
            }
            return destinations
        }

        // The declared type of a frozen oblivious member that [`read`](paramref) reads
        // directly, when that type is a container.
        private func FrozenObliviousContainerType(
            read ExpressionSyntax?,
            member ISymbol?,
            model SemanticModel
        ) ITypeSymbol? {
            let expression ExpressionSyntax? = read
            if !this.IsFrozenObliviousImportMember(member) {
                return nil
            }
            let declared ITypeSymbol? = StorageType(member!!.OriginalDefinition)
            return if SameContainerShape(declared, model.GetTypeInfo(expression!!).Type) {
                declared
            } else {
                nil
            }
        }

        shared {
            // The direct read inside a value: parentheses and `!` suppressions are
            // removed. Only a name, a member access, or a call reads storage.
            private func StorageRead(value ExpressionSyntax?) ExpressionSyntax? {
                var expression ExpressionSyntax? = Unparenthesize(value)
                while expression is PostfixUnaryExpressionSyntax suppression && suppression.IsKind(
                    SyntaxKind.SuppressNullableWarningExpression
                ) {
                    expression = Unparenthesize(suppression.Operand)
                }
                return if expression is InvocationExpressionSyntax ||
                    expression is MemberAccessExpressionSyntax ||
                    expression is IdentifierNameSyntax {
                    expression
                } else {
                    nil
                }
            }

            // Source storage that can carry oblivious container positions to another
            // destination.
            private func IsSourceStorage(symbol ISymbol?, compilation Compilation) bool -> symbol != nil &&
                (
                symbol is ILocalSymbol ||
                    symbol is IFieldSymbol ||
                    symbol is IPropertySymbol{IsIndexer: false} ||
                    symbol is IParameterSymbol ||
                    symbol is IMethodSymbol
            ) &&
                !symbol
                .OriginalDefinition
                .DeclaringSyntaxReferences
                .IsDefaultOrEmpty &&
                SymbolEqualityComparer
                .Default
                .Equals(symbol.ContainingAssembly, compilation.Assembly) &&
                HasNonNullNestedReferencePosition(StorageType(symbol.OriginalDefinition))

            // The destination position of a source position. The destination is the same
            // container, or a generic interface that the source container implements,
            // such as `IEnumerable[T]` for `[]T` or `List[T]`. Then a top-level source
            // position maps to the interface argument that the source position fills.
            private func MapContainerPosition(
                sourceType ITypeSymbol?,
                destinationType ITypeSymbol?,
                position string
            ) string? {
                if SameContainerShape(sourceType, destinationType) {
                    return position
                }
                let arguments = ImplementedContainerArguments(sourceType, destinationType)
                if arguments == nil {
                    return nil
                }
                let separator = position.IndexOf('.')
                let head = if separator < 0 {
                    position
                } else {
                    position.Substring(0, separator)
                }
                let tail = if separator < 0 {
                    ""
                } else {
                    position.Substring(separator)
                }
                for var i = 0; i < arguments.Count; i++ {
                    if arguments[i] == head {
                        return i.ToString(System.Globalization.CultureInfo.InvariantCulture) + tail
                    }
                }
                return nil
            }

            // For a destination that is a generic interface the source container
            // implements, the source position (`0` for an array element, the type
            // parameter ordinal for a generic type) that fills each interface argument.
            // An argument that is not one source position maps to nil. Returns nil when
            // the destination is not such an interface.
            private func ImplementedContainerArguments(sourceType ITypeSymbol?, destinationType ITypeSymbol?) List[
                string?
            ]? {
                // A separate kind comparison, not an enum property pattern (#4153).
                if destinationType is not INamedTypeSymbol destination ||
                    destination.TypeKind != TypeKind.Interface ||
                    !destination.IsGenericType {
                    return nil
                }
                if sourceType is IArrayTypeSymbol array && array.Rank == 1 {
                    for implemented in array.AllInterfaces {
                        if SymbolEqualityComparer.Default.Equals(
                            implemented.OriginalDefinition,
                            destination.OriginalDefinition
                        ) {
                            return implemented
                                .TypeArguments
                                .Select(
                                (argument ITypeSymbol) -> if SymbolEqualityComparer.Default.Equals(
                                    argument,
                                    array.ElementType
                                ) {
                                    "0"
                                } else {
                                    default(string?)
                                }
                            )
                                .ToList()
                        }
                    }
                    return nil
                }
                if sourceType is not INamedTypeSymbol{IsGenericType: true} named {
                    return nil
                }
                for implemented in named.OriginalDefinition.AllInterfaces {
                    if SymbolEqualityComparer.Default.Equals(
                        implemented.OriginalDefinition,
                        destination.OriginalDefinition
                    ) {
                        return implemented
                            .TypeArguments
                            .Select(
                            (argument ITypeSymbol) -> if argument is ITypeParameterSymbol parameter &&
                                SymbolEqualityComparer
                                .Default
                                .Equals(parameter.DeclaringType, named.OriginalDefinition) {
                                parameter.Ordinal.ToString(System.Globalization.CultureInfo.InvariantCulture)
                            } else {
                                default(string?)
                            }
                        )
                            .ToList()
                    }
                }
                return nil
            }

            // The type at a dotted position below the top level of [`type`](paramref).
            private func PositionType(type ITypeSymbol?, position string) ITypeSymbol? {
                var current ITypeSymbol? = type
                for part in position.Split('.') {
                    let index = int32.Parse(part, System.Globalization.CultureInfo.InvariantCulture)
                    current = if current is IArrayTypeSymbol array && index == 0 {
                        array.ElementType
                    } else if current is INamedTypeSymbol named && index < named.TypeArguments.Length {
                        named.TypeArguments[index]
                    } else {
                        nil
                    }
                    if current == nil {
                        return nil
                    }
                }
                return current
            }

            private let ObliviousContainerDestinationsCache ConditionalWeakTable[
                Compilation,
                Dictionary[ISymbol, HashSet[string]]
            ] = ConditionalWeakTable[Compilation, Dictionary[ISymbol, HashSet[string]]]()

            // Returns true when the destination gains a position.
            private func AddPositions(
                destinations Dictionary[ISymbol, HashSet[string]],
                destination ISymbol,
                positions HashSet[string]
            ) bool {
                if destinations.TryGetValue(destination, out var existing) {
                    let count = existing.Count
                    existing.UnionWith(positions)
                    return existing.Count > count
                }
                destinations.Add(destination, HashSet[string](positions, System.StringComparer.Ordinal))
                return true
            }

            // Records each nested position that gsc reads as `T!` in the producer type
            // (ADR-0186 §2) and that the storage type states as a non-null reference. An
            // oblivious reference position is platform. So is a type-parameter argument
            // of a constructed type. An array element that is a type parameter takes the
            // type argument of the call, so `Array.Empty[T]()` reads as `[]T`. A stated
            // producer position keeps its own contract.
            private func CollectPlatformPositions(
                producer ITypeSymbol?,
                storage ITypeSymbol?,
                prefix string,
                positions HashSet[string]
            ) {
                if producer is IArrayTypeSymbol producerArray &&
                    storage is IArrayTypeSymbol storageArray &&
                    producerArray.Rank == storageArray
                    .Rank {
                    let position = prefix + "0"
                    if IsPlatformPosition(producerArray.ElementType, inArrayElement: true) &&
                        IsNonNullReferencePosition(storageArray.ElementType) {
                        positions.Add(position)
                    }
                    CollectPlatformPositions(
                        producerArray.ElementType,
                        storageArray.ElementType,
                        position + ".",
                        positions
                    )
                    return
                }
                if producer is INamedTypeSymbol producerNamed &&
                    storage is INamedTypeSymbol storageNamed &&
                    producerNamed
                    .TypeArguments
                    .Length == storageNamed
                    .TypeArguments
                    .Length &&
                    SymbolEqualityComparer
                    .Default
                    .Equals(producerNamed.OriginalDefinition, storageNamed.OriginalDefinition) {
                    for var i = 0; i < producerNamed.TypeArguments.Length; i++ {
                        let position = prefix + i.ToString(System.Globalization.CultureInfo.InvariantCulture)
                        if IsPlatformPosition(producerNamed.TypeArguments[i], inArrayElement: false) &&
                            IsNonNullReferencePosition(storageNamed.TypeArguments[i]) {
                            positions.Add(position)
                        }
                        CollectPlatformPositions(
                            producerNamed.TypeArguments[i],
                            storageNamed.TypeArguments[i],
                            position + ".",
                            positions
                        )
                    }
                }
            }

            private func IsPlatformPosition(type ITypeSymbol, inArrayElement bool) bool {
                if type is ITypeParameterSymbol {
                    return !inArrayElement
                }
                return type.IsReferenceType && type.NullableAnnotation == Microsoft.CodeAnalysis.NullableAnnotation.None
            }

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
            private func LocalInitializerStatesType(local ILocalSymbol, initializerType ITypeSymbol?) bool ->
            !IsImplicitlyTypedLocal(local) &&
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

            // Makes each recorded nested position nullable. The top level keeps its
            // nullability.
            private func PromoteNestedPositions(
                type GTypeReference?,
                declared ITypeSymbol?,
                positions HashSet[string],
                prefix string
            ) GTypeReference? {
                if type is ArrayTypeReference array && declared is IArrayTypeSymbol arraySymbol {
                    let element = PromoteNestedPosition(
                        array.ElementType,
                        arraySymbol.ElementType,
                        positions,
                        prefix + "0"
                    )
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
                        let argument = PromoteNestedPosition(
                            named.TypeArguments[i],
                            namedSymbol.TypeArguments[i],
                            positions,
                            prefix + i.ToString(System.Globalization.CultureInfo.InvariantCulture)
                        )
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

            private func PromoteNestedPosition(
                type GTypeReference,
                declared ITypeSymbol,
                positions HashSet[string],
                position string
            ) GTypeReference {
                let inner = PromoteNestedPositions(type, declared, positions, position + ".")!!
                return if positions.Contains(position) && !inner.IsNullable {
                    MakeNullable(inner)!!
                } else {
                    inner
                }
            }
        }
    }
}
