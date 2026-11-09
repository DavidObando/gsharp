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

/// Issue #5541: the nested positions that G# gives a value read from an imported
/// oblivious container. A position is the dotted list of element (`0`) and
/// type-argument indexes from the top level. The empty position is the value itself.
/// A type argument index counts the arguments of the containing types first, as the
/// CLR does, so `Dictionary[K, V].KeyCollection` has the positions of `K` and `V`.
internal class ObliviousPositionSet {
    init() {
        this.Nullable = HashSet[string](System.StringComparer.Ordinal)
        this.Platform = HashSet[string](System.StringComparer.Ordinal)
    }

    // Positions that G# types `T?`.
    prop Nullable HashSet[string] {
        get;
    }

    // Positions that G# types `T!` (ADR-0186 §2).
    prop Platform HashSet[string] {
        get;
    }

    prop IsEmpty bool -> this.Nullable.Count == 0 && this.Platform.Count == 0

    func UnionWith(other ObliviousPositionSet?) {
        if other != nil {
            this.Nullable.UnionWith(other.Nullable)
            this.Platform.UnionWith(other.Platform)
        }
    }
}

/// Issue #5541: overriding and implementing members, and the members that they
/// override or implement, share one signature. A group of such members states one
/// set of positions, and only when this compilation declares every member with the
/// same type.
internal class ObliviousSignatureGroups {
    private let parents Dictionary[ISymbol, ISymbol] = Dictionary[ISymbol, ISymbol](SymbolEqualityComparer.Default)
    private let members Dictionary[ISymbol, List[ISymbol]] = Dictionary[ISymbol, List[ISymbol]](
        SymbolEqualityComparer.Default
    )

    init(compilation Compilation) {
        let visited = HashSet[ISymbol](SymbolEqualityComparer.Default)
        for tree in compilation.SyntaxTrees {
            let model = compilation.GetSemanticModel(tree)
            for declaration in tree.GetRoot().DescendantNodes().OfType[BaseTypeDeclarationSyntax]() {
                if model.GetDeclaredSymbol(declaration) is not INamedTypeSymbol type || !visited.Add(type) {
                    continue
                }
                for member in type.GetMembers() {
                    if member is IMethodSymbol method {
                        if method.OverriddenMethod != nil {
                            this.Union(method, method.OverriddenMethod!!)
                        }
                        for implemented in method.ExplicitInterfaceImplementations {
                            this.Union(method, implemented)
                        }
                    } else if member is IPropertySymbol property {
                        if property.OverriddenProperty != nil {
                            this.Union(property, property.OverriddenProperty!!)
                        }
                        for implemented in property.ExplicitInterfaceImplementations {
                            this.Union(property, implemented)
                        }
                    }
                }
                for interfaceType in type.AllInterfaces {
                    for interfaceMember in interfaceType.GetMembers() {
                        if !(interfaceMember is IMethodSymbol || interfaceMember is IPropertySymbol) {
                            continue
                        }
                        let implementation ISymbol? = type.FindImplementationForInterfaceMember(interfaceMember)
                        if implementation != nil {
                            this.Union(implementation, interfaceMember)
                        }
                    }
                }
            }
        }
        for symbol in this.parents.Keys.ToList() {
            let root = this.Find(symbol)
            if !this.members.TryGetValue(root, out var group) {
                group = List[ISymbol]()
                this.members.Add(root, group)
            }
            group.Add(symbol)
        }
    }

    // The member that stands for the group of [`symbol`](paramref).
    func Find(symbol ISymbol) ISymbol {
        var current = symbol.OriginalDefinition
        while this.parents.TryGetValue(current, out var parent) && !SymbolEqualityComparer.Default.Equals(
            parent,
            current
        ) {
            current = parent
        }
        return current
    }

    // The members of the group that [`root`](paramref) stands for.
    func Members(root ISymbol) IReadOnlyList[ISymbol] -> if this.members.TryGetValue(root, out var group) {
        group
    } else {
        List[ISymbol]{root}
    }

    private func Union(left ISymbol, right ISymbol) {
        let leftRoot = this.Find(left)
        let rightRoot = this.Find(right)
        this.parents.TryAdd(leftRoot, leftRoot)
        this.parents.TryAdd(rightRoot, rightRoot)
        this.parents.TryAdd(left.OriginalDefinition, leftRoot)
        this.parents.TryAdd(right.OriginalDefinition, rightRoot)
        if !SymbolEqualityComparer.Default.Equals(leftRoot, rightRoot) {
            this.parents[rightRoot] = leftRoot
        }
    }
}

/// Issue #5541: the result of the nested-position flow analysis for one compilation.
internal class ObliviousContainerFlow {
    private var hasNullable bool = false

    init() {
        this.Destinations = Dictionary[ISymbol, HashSet[string]](SymbolEqualityComparer.Default)
        this.Inferred = Dictionary[ISymbol, ObliviousPositionSet](SymbolEqualityComparer.Default)
        this.LambdaParameters = Dictionary[SyntaxNode, HashSet[string]]()
    }

    // Storage whose declaration spells its recorded positions nullable.
    prop Destinations Dictionary[ISymbol, HashSet[string]] {
        get;
    }

    // Lambda parameters, which G# declares with a stated type, keyed by their
    // declaration: each semantic model makes its own lambda symbols.
    prop LambdaParameters Dictionary[SyntaxNode, HashSet[string]] {
        get;
    }

    // Locals that take their G# type from their value: a `foreach` variable and a
    // local whose declaration has no type clause.
    prop Inferred Dictionary[ISymbol, ObliviousPositionSet] {
        get;
    }

    // The positions of values during one pass of the fixed point, which reads one
    // state of the flow. Nil outside the analysis.
    prop Memo Dictionary[ExpressionSyntax, ObliviousPositionSet?]? {
        get;
        set;
    }

    // The signature groups, built when a member that can share its signature
    // receives positions.
    prop Groups ObliviousSignatureGroups? {
        get;
        set;
    }

    // Whether any storage holds a nullable position, so a read can need `!!`.
    prop HasNullable bool -> this.hasNullable

    // Whether the translation states a nullable position, so a read can need `!!`.
    // A construction or an explicit type argument can state one without storage
    // (#5541).
    func Seal(spellsNullablePosition bool) {
        this.hasNullable = spellsNullablePosition ||
            this
            .Destinations
            .Count > 0 ||
            this
            .LambdaParameters
            .Count > 0 ||
            this
            .Inferred
            .Values
            .Any((positions ObliviousPositionSet) -> positions.Nullable.Count > 0)
    }
}

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
        /// Issue #5541: one flow analysis
        /// ((cref:CollectObliviousContainerFlow)) finds this storage. It follows each
        /// value through assignments, initializers, arguments, returns, `foreach`,
        /// conditional, switch and coalescing arms, element and member reads, generic
        /// calls, constructions and lambdas, back to its root storage and full
        /// position path.
        ///
        /// The declaration ((cref:PromoteObliviousContainerStorage)), a construction
        /// stored there ((cref:PromoteObliviousContainerCreation)), and every element read
        /// ((cref:ReadsObliviousContainerStorageElement)) ask this one analysis.
        /// @param symbol A local, field, property, parameter, or method return.
        /// @returns True when the storage keeps nullable nested reference positions.
        private func StoresObliviousContainerElements(symbol ISymbol?) bool -> this.ObliviousContainerPositions(
            symbol
        ) != nil

        private func ObliviousContainerFlowState() ObliviousContainerFlow -> ObliviousContainerFlowCache.GetValue(
            this.context.Compilation,
            (compilation Compilation) -> this.CollectObliviousContainerFlow(compilation)
        )

        // The nested positions of the storage that become nullable.
        private func ObliviousContainerPositions(symbol ISymbol?) HashSet[string]? -> DeclaredPositions(
            this.ObliviousContainerFlowState(),
            symbol
        )

        // Whether a `foreach` variable has nested oblivious container positions and an
        // emitted non-null top level, so the loop variable is emitted as a non-null
        // container whose elements are nullable.
        private func ForEachBindingHasObliviousContainerElements(symbol ISymbol?) bool {
            let flow = this.ObliviousContainerFlowState()
            if symbol is not ILocalSymbol local ||
                !flow.HasNullable ||
                !local
                .Type
                .IsReferenceType ||
                this.ShouldPromoteToNullableReference(local) || this.IsTranslatorWidenedDeclaration(local) {
                return false
            }
            var forEachSyntax ForEachStatementSyntax? = nil
            for reference in local.DeclaringSyntaxReferences {
                if reference.GetSyntax() is ForEachStatementSyntax forEach && SymbolEqualityComparer.Default.Equals(
                    this.context.GetDeclaredSymbol(forEach),
                    local
                ) {
                    forEachSyntax = forEach
                    break
                }
            }
            if forEachSyntax == nil {
                return false
            }
            if !forEachSyntax
                .Type
                .IsVar &&
                local
                .Type
                .NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                return false
            }
            let forEachInfo = this.context.SemanticModel.GetForEachStatementInfo(forEachSyntax)
            if this.ArrayExpressionHasNullableReferenceLikeElement(forEachSyntax.Expression) ||
                this.ForEachIteratesPromotedSourceIteratorElement(forEachSyntax, forEachInfo) {
                return false
            }
            let collectionExpression ExpressionSyntax = if this
                .context
                .GetSymbolInfo(forEachSyntax.Expression)
                .Symbol is ILocalSymbol collectionLocal &&
                IsImplicitlyTypedLocal(collectionLocal) &&
                collectionLocal
                .DeclaringSyntaxReferences
                .FirstOrDefault()
                ?.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} collectionInitializer}} {
                collectionInitializer
            } else {
                forEachSyntax.Expression
            }
            let collectionType ITypeSymbol? = this.context.GetTypeInfo(collectionExpression).Type
            let elementAnnotation = if collectionType is IArrayTypeSymbol arrayCollection {
                arrayCollection.ElementNullableAnnotation
            } else {
                forEachInfo.ElementType?.NullableAnnotation ?? Microsoft.CodeAnalysis.NullableAnnotation.None
            }
            if elementAnnotation == Microsoft.CodeAnalysis.NullableAnnotation.Annotated {
                return false
            }
            let declared = DeclaredPositions(flow, local)
            let hasInferred = flow.Inferred.TryGetValue(local.OriginalDefinition, out var inferred)
            if declared?.Contains("") == true || (hasInferred && inferred.Nullable.Contains("")) {
                return false
            }
            return (declared != nil && declared.Count > 0) || (hasInferred && inferred.Nullable.Count > 0)
        }

        // Whether an implicitly typed deconstruction variable has nested oblivious
        // container positions and an emitted non-null top level, so the variable is
        // emitted as a non-null container whose elements are nullable (#5584).
        private func DeconstructedBindingHasObliviousContainerElements(symbol ISymbol?) bool {
            let flow = this.ObliviousContainerFlowState()
            if symbol is not ILocalSymbol local ||
                !flow.HasNullable ||
                !local
                .Type
                .IsReferenceType ||
                this.ShouldPromoteToNullableReference(local) || this.IsTranslatorWidenedDeclaration(local) ||
                (
                IsAnnotatedNullableReference(local.Type) && this.IsUsedAsNullable(
                    local,
                    this.GetNullabilityScope(local)
                )
            ) {
                return false
            }
            let designation = local
                .DeclaringSyntaxReferences
                .FirstOrDefault()
                ?.GetSyntax() as SingleVariableDesignationSyntax
            if designation == nil {
                return false
            }
            let indices = List[int32]()
            var current SyntaxNode = designation
            while true {
                if current.Parent is ParenthesizedVariableDesignationSyntax parenthesized {
                    indices.Insert(0, parenthesized.Variables.IndexOf(cast[VariableDesignationSyntax](current)))
                    current = parenthesized
                } else if current.Parent is DeclarationExpressionSyntax declaration && declaration.Type.IsVar {
                    current = declaration
                } else if current.Parent is ArgumentSyntax{Parent: TupleExpressionSyntax tuple} argument {
                    indices.Insert(0, tuple.Arguments.IndexOf(argument))
                    current = tuple
                } else {
                    break
                }
            }
            if indices.Count == 0 ||
                current.Parent is not AssignmentExpressionSyntax assignment ||
                assignment.Left != current {
                return false
            }
            let elementType ITypeSymbol? = NestedTupleElementType(
                this.context.GetTypeInfo(assignment.Right).Type,
                indices
            )
            if elementType == nil ||
                elementType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                return false
            }
            let declared = DeclaredPositions(flow, local)
            let hasInferred = flow.Inferred.TryGetValue(local.OriginalDefinition, out var inferred)
            if declared?.Contains("") == true ||
                (hasInferred && (inferred.Nullable.Contains("") || inferred.Platform.Contains(""))) {
                return false
            }
            return (declared != nil && declared.Count > 0) || (hasInferred && inferred.Nullable.Count > 0)
        }

        /// Issue #5537: makes the recorded nested positions of a storage declaration
        /// nullable when (cref:StoresObliviousContainerElements) holds. A lambda
        /// parameter can also record its own top level (#5541).
        /// @param type The mapped declaration type.
        /// @param symbol The declared storage.
        /// @returns The declaration type to emit.
        private func PromoteObliviousContainerStorage(type GTypeReference?, symbol ISymbol?) GTypeReference? {
            let positions = this.ObliviousContainerPositions(symbol)
            if type == nil || positions == nil {
                return type
            }
            var promoted = PromoteNestedPositions(type, StorageType(symbol!!.OriginalDefinition), positions, "")
            if promoted is ArrayTypeReference arrayType &&
                !arrayType
                .ElementType
                .IsNullable &&
                this
                .IsWidenedArrayElementStorage(symbol) {
                promoted = ArrayTypeReference(MakeNullable(arrayType.ElementType)!!, arrayType.Rank){
                    IsNullable = arrayType.IsNullable
                }
            }
            return if positions.Contains("") && !promoted!!.IsNullable {
                MakeNullable(promoted)
            } else {
                promoted
            }
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
        /// Issue #5541: a construction also spells the positions that its arguments give
        /// its type arguments (`List[string?](lines)`), because the construction states
        /// those type arguments where G# would otherwise infer them.
        /// @param type The mapped constructed type.
        /// @param createdType The constructed C# type.
        /// @param creation The construction.
        /// @returns The constructed type to emit.
        private func PromoteObliviousContainerCreation(
            type GTypeReference?,
            createdType ITypeSymbol?,
            creation ExpressionSyntax
        ) GTypeReference? {
            if type == nil {
                return type
            }
            let positions = this.EffectiveCreationPositions(creation, createdType).Nullable
            return if positions.Count == 0 {
                type
            } else {
                PromoteNestedPositions(type, createdType, positions, "")
            }
        }

        // The positions that a construction states: those of the sink that receives it
        // (an `async` method's task result included) and those that its arguments and
        // initializer give its type arguments. The spelling, the constructor arguments
        // and the initializer writes all read these.
        private func CreationSlotHasNullablePositions(
            creation BaseObjectCreationExpressionSyntax,
            createdType ITypeSymbol?,
            slotType ITypeSymbol?
        ) bool {
            if createdType is not INamedTypeSymbol created {
                return false
            }
            let stated = this.EffectiveCreationPositions(creation, createdType)
            if stated.Nullable.Count == 0 {
                return false
            }
            if slotType == nil {
                return true
            }
            let bindings = TypeParameterMap()
            let parameters = FlatTypeArguments(created.OriginalDefinition)
            for var i = 0; i < parameters.Count; i++ {
                if parameters[i] is ITypeParameterSymbol parameter {
                    bindings[parameter] = Subtree(stated, IndexPosition(i))
                }
            }
            var current INamedTypeSymbol? = created.BaseType
            while current != nil {
                Unify(current.OriginalDefinition, created, stated, bindings)
                current = current.BaseType
            }
            for iface in created.AllInterfaces {
                Unify(iface.OriginalDefinition, created, stated, bindings)
            }
            let projected = ObliviousPositionSet()
            Substitute(slotType, bindings, "", projected)
            return projected.Nullable.Count > 0
        }

        private func EffectiveCreationPositions(
            creation ExpressionSyntax,
            createdType ITypeSymbol?,
            model SemanticModel? = nil,
            flow ObliviousContainerFlow? = nil
        ) ObliviousPositionSet {
            let activeModel = model ?? this.context.SemanticModel
            let activeFlow = flow ?? this.ObliviousContainerFlowState()
            let positions = ObliviousPositionSet()
            positions.Nullable.UnionWith(this.SinkNullablePositions(creation, createdType, activeModel, activeFlow))
            if creation is BaseObjectCreationExpressionSyntax objectCreation {
                positions.UnionWith(this.ObliviousCreationPositions(objectCreation, activeModel, activeFlow))
            }
            return positions
        }

        // The nullable positions that the sink of [`value`](paramref) states for it:
        // the storage, enclosing element literal, tuple literal, initializer or
        // `foreach` statement that receives it.
        private func SinkNullablePositions(
            value ExpressionSyntax?,
            valueType ITypeSymbol?,
            model SemanticModel? = nil,
            flow ObliviousContainerFlow? = nil
        ) HashSet[string] {
            let positions = HashSet[string](System.StringComparer.Ordinal)
            if value == nil || (flow == nil && !this.ObliviousContainerFlowState().HasNullable) {
                return positions
            }
            let activeModel = model ?? this.context.SemanticModel
            let activeFlow = flow ?? this.ObliviousContainerFlowState()
            var whole ExpressionSyntax = value
            while true {
                let parent SyntaxNode? = whole.Parent
                let next ExpressionSyntax? = switch parent {
                    case parenthesized is ParenthesizedExpressionSyntax: parenthesized
                    case castExpression is CastExpressionSyntax: castExpression
                    case checkedExpression is CheckedExpressionSyntax: checkedExpression
                    case conditional is ConditionalExpressionSyntax when conditional.Condition != whole: conditional
                    case coalesce is BinaryExpressionSyntax when coalesce.IsKind(
                        SyntaxKind.CoalesceExpression
                    ): coalesce
                    case arm is SwitchExpressionArmSyntax when arm.Expression == whole: arm.Parent as SwitchExpressionSyntax
                    default: default(ExpressionSyntax?)
                }
                if next == nil {
                    break
                }
                whole = next
            }
            let parent SyntaxNode? = whole.Parent
            if parent is InitializerExpressionSyntax arrayInitializer && arrayInitializer.IsKind(
                SyntaxKind.ArrayInitializerExpression
            ) {
                let enclosing ExpressionSyntax = EnclosingArrayLiteral(arrayInitializer, 1, activeModel)
                SubtreeInto(this.ObliviousArrayLiteralPositions(enclosing, activeModel, activeFlow), "0", positions)
                positions.Remove("")
                return positions
            }
            if parent is ExpressionElementSyntax{Parent: CollectionExpressionSyntax collection} {
                SubtreeInto(this.ObliviousArrayLiteralPositions(collection, activeModel, activeFlow), "0", positions)
                positions.Remove("")
                return positions
            }
            if parent is SpreadElementSyntax{Parent: CollectionExpressionSyntax spreadCollection} {
                if ElementIsPositionZero(valueType) {
                    let element = HashSet[string](System.StringComparer.Ordinal)
                    SubtreeInto(
                        this.ObliviousArrayLiteralPositions(spreadCollection, activeModel, activeFlow),
                        "0",
                        element
                    )
                    for position in element {
                        positions.Add(JoinPosition("0", position))
                    }
                }
                return positions
            }
            if parent is ArgumentSyntax{Parent: TupleExpressionSyntax tuple} tupleArgument {
                let tupleType ITypeSymbol? = activeModel.GetTypeInfo(tuple).Type
                SubtreeInto(
                    this.SinkNullablePositions(tuple, tupleType, activeModel, activeFlow),
                    TupleElementPosition(tuple.Arguments.IndexOf(tupleArgument)),
                    positions
                )
                positions.Remove("")
                return positions
            }
            if parent is ForEachStatementSyntax forEach && forEach.Expression == whole {
                let loopSymbol ISymbol? = activeModel.GetDeclaredSymbol(forEach)
                let loopPositions = DeclaredPositions(activeFlow, loopSymbol)
                if loopPositions != nil {
                    let mapped = CollectionPositionsForElement(
                        valueType,
                        StorageType(loopSymbol?.OriginalDefinition),
                        loopPositions,
                        activeModel.Compilation
                    )
                    if mapped != nil {
                        positions.UnionWith(mapped)
                    }
                }
                return positions
            }
            let (creation, member) = this.InitializerWriteTarget(whole, activeModel)
            if creation != nil && member != nil {
                let createdType ITypeSymbol? = activeModel.GetTypeInfo(creation).Type
                let slot = MemberPositions(
                    this.EffectiveCreationPositions(creation, createdType, activeModel, activeFlow),
                    createdType,
                    member
                )
                if slot != nil {
                    positions.UnionWith(slot.Nullable)
                    positions.Remove("")
                }
                return positions
            }
            if parent is ArgumentSyntax callArgument && callArgument.Parent?.Parent is ExpressionSyntax argumentCall {
                let (parameter, argumentPrefix) = ArgumentDestination(callArgument, activeModel)
                if parameter != nil && argumentPrefix == "" {
                    let slot = this.CallSlotPositions(
                        argumentCall,
                        parameter.OriginalDefinition.Type,
                        activeModel,
                        activeFlow
                    )
                    if slot != nil &&
                        (
                        SameContainerShape(valueType, parameter.Type) ||
                            (ElementIsPositionZero(valueType) && ElementIsPositionZero(parameter.Type))
                    ) {
                        positions.UnionWith(slot.Nullable)
                        positions.Remove("")
                    }
                }
            }
            let (sink, prefix) = this.DirectValueSink(whole, activeModel)
            let (sinkPositions, sinkType) = this.SinkStorage(sink, activeFlow)
            if sinkPositions == nil {
                return positions
            }
            if prefix == "0" {
                if SameContainerShape(valueType, (sinkType as IArrayTypeSymbol)?.ElementType) {
                    SubtreeInto(sinkPositions, "0", positions)
                    positions.Remove("")
                }
            } else if SameContainerShape(valueType, sinkType) {
                positions.UnionWith(sinkPositions)
            }
            return positions
        }

        private func DirectValueSink(whole ExpressionSyntax, model SemanticModel? = nil)(Sink ISymbol?, Prefix string) {
            let activeModel = model ?? this.context.SemanticModel
            return switch whole.Parent {
                case EqualsValueClauseSyntax{Parent: VariableDeclaratorSyntax declarator}: (
                    activeModel.GetDeclaredSymbol(declarator),
                    ""
                )
                case EqualsValueClauseSyntax{Parent: PropertyDeclarationSyntax property}: (
                    activeModel.GetDeclaredSymbol(property),
                    ""
                )
                case assignment is AssignmentExpressionSyntax when assignment.IsKind(
                    SyntaxKind.SimpleAssignmentExpression
                ) &&
                    assignment.Right == whole: (activeModel.GetSymbolInfo(assignment.Left).Symbol, "")
                case argument is ArgumentSyntax: ArgumentDestination(argument, activeModel)
                case returnStatement is ReturnStatementSyntax: (
                    activeModel.GetEnclosingSymbol(returnStatement.SpanStart) as IMethodSymbol,
                    ""
                )
                case yieldStatement is YieldStatementSyntax: (
                    activeModel.GetEnclosingSymbol(yieldStatement.SpanStart) as IMethodSymbol,
                    ""
                )
                case arrow is ArrowExpressionClauseSyntax: (
                    activeModel.GetEnclosingSymbol(arrow.Expression.SpanStart),
                    ""
                )
                default: (default(ISymbol?), "")
            }
        }

        // The declared positions and type of the storage that receives a value. An
        // `async` method receives its task's result, and a property or indexer
        // accessor stands for its property.
        private func SinkStorage(resolved ISymbol?, flow ObliviousContainerFlow? = nil)(
            Positions HashSet[string]?,
            Type ITypeSymbol?
        ) {
            let activeFlow = flow ?? this.ObliviousContainerFlowState()
            let sink ISymbol? = AccessorStorage(resolved)
            let positions = DeclaredPositions(activeFlow, sink)
            let type ITypeSymbol? = StorageType(sink?.OriginalDefinition)
            if sink is IMethodSymbol method && method.IsAsync && IsGenericTaskLike(type) {
                let result = HashSet[string](System.StringComparer.Ordinal)
                if positions != nil {
                    SubtreeInto(positions, "0", result)
                    result.Remove("")
                }
                return (result, (type as INamedTypeSymbol)!!.TypeArguments[0])
            }
            return (positions, type)
        }

        /// Issue #5541: an explicit type argument of a generic call spells the positions
        /// that the arguments give its type parameter (`Id[[]string?](lines)`), so the
        /// argument converts without an unchecked nested conversion.
        /// @param type The mapped type argument.
        /// @param typeArgument The C# type argument.
        /// @param invocation The call.
        /// @param index The index of the type argument.
        /// @returns The type argument to emit.
        private func PromoteObliviousTypeArgument(
            type GTypeReference?,
            typeArgument ITypeSymbol?,
            invocation InvocationExpressionSyntax,
            index int32
        ) GTypeReference? {
            if type == nil ||
                typeArgument == nil ||
                this
                .context
                .SemanticModel
                .GetOperation(invocation) is not IInvocationOperation operation {
                return type
            }
            let definition = operation.TargetMethod.OriginalDefinition
            if index >= definition.TypeParameters.Length {
                return type
            }
            let bindings = TypeParameterMap()
            this.InferObliviousTypeArguments(
                invocation,
                definition.TypeParameters,
                operation.Arguments,
                true,
                this.context.SemanticModel,
                this.ObliviousContainerFlowState(),
                bindings
            )
            if !bindings.TryGetValue(definition.TypeParameters[index], out var bound) {
                return type
            }
            let nested = HashSet[string](System.StringComparer.Ordinal)
            for position in bound.Nullable {
                if position != "" && IsPromotablePosition(typeArgument, position, includeOblivious: true) {
                    nested.Add(position)
                }
            }
            let promoted = PromoteNestedPositions(type, typeArgument, nested, "")
            return if bound.Nullable.Contains("") &&
                IsNonNullReferencePosition(typeArgument, includeOblivious: true) &&
                !promoted!!.IsNullable {
                MakeNullable(promoted)
            } else {
                promoted
            }
        }

        // Tuple storage uses flat Roslyn indexes. Generic inference uses CLR Rest positions.
        private func CollectTupleStoragePositions(
            storage ISymbol,
            declared ITypeSymbol?,
            model SemanticModel,
            path List[int32],
            prefix string,
            positions HashSet[string]
        ) {
            if path.Count > 0 &&
                declared?.IsReferenceType == true &&
                ObliviousNullabilityAnalyzer
                .IsTupleElementTainted(
                model.Compilation as CSharpCompilation,
                storage,
                path,
                this.context.SiblingCompilations
            ) {
                positions.Add(prefix)
            }
            let arguments IReadOnlyList[ITypeSymbol]? = switch declared {
                case array is IArrayTypeSymbol: []ITypeSymbol{array.ElementType}
                case tuple is INamedTypeSymbol{IsTupleType: true}: tuple
                    .TupleElements
                    .Select((element IFieldSymbol) -> element.Type)
                    .ToList()
                case named is INamedTypeSymbol: named.TypeArguments
                default: default(IReadOnlyList[ITypeSymbol]?)
            }
            if arguments == nil {
                return
            }
            for var i = 0; i < arguments.Count; i++ {
                path.Add(i)
                let position = if declared is INamedTypeSymbol{IsTupleType: true} {
                    TupleElementPosition(i)
                } else {
                    IndexPosition(i)
                }
                this.CollectTupleStoragePositions(
                    storage,
                    arguments[i],
                    model,
                    path,
                    JoinPosition(prefix, position),
                    positions
                )
                path.RemoveAt(path.Count - 1)
            }
        }

        /// Issue #5541: an `async` method or a task-returning declaration spells the
        /// positions of its task's result.
        /// @param type The mapped awaited type.
        /// @param awaitedType The C# awaited type.
        /// @param symbol The method.
        /// @returns The awaited type to emit.
        private func PromoteObliviousAwaitedResult(
            type GTypeReference?,
            awaitedType ITypeSymbol,
            symbol IMethodSymbol?
        ) GTypeReference? {
            let positions = this.ObliviousContainerPositions(symbol)
            if type == nil || positions == nil {
                return type
            }
            let awaited = HashSet[string](System.StringComparer.Ordinal)
            SubtreeInto(positions, "0", awaited)
            awaited.Remove("")
            return if awaited.Count == 0 {
                type
            } else {
                PromoteNestedPositions(type, awaitedType, awaited, "")
            }
        }

        /// Issue #5537: whether an array construction stored in oblivious container
        /// storage has a nullable element.
        /// @param creation The array construction.
        /// @returns True when the element type is nullable.
        private func ObliviousContainerSinkPromotesArrayElement(creation ExpressionSyntax?) bool -> this
            .ObliviousArrayLiteralPositions(creation).Contains("0")

        /// Issue #5541: the element type that an array construction, a bare array
        /// initializer or a collection expression states: the whole position subtree
        /// below its element position `0`, as a construction states its type
        /// arguments (`new[] { lines }` is `[][]string?{lines}`). Every array literal
        /// emitter asks this.
        /// @param elementType The mapped element type.
        /// @param elementTypeSymbol The C# element type.
        /// @param literal The construction, initializer or collection expression.
        /// @returns The element type to emit.
        private func PromoteObliviousArrayElement(
            elementType GTypeReference?,
            elementTypeSymbol ITypeSymbol?,
            literal ExpressionSyntax?
        ) GTypeReference? {
            if elementType == nil || elementTypeSymbol == nil {
                return elementType
            }
            let positions = this.ObliviousArrayLiteralPositions(literal)
            let (sink, elementPosition) = this.ResolveArrayStorageSink(literal)
            var current = elementTypeSymbol
            var position = elementPosition
            var relativePosition = "0"
            while true {
                if this.IsWidenedArrayElementStorage(sink, position) {
                    positions.Add(relativePosition)
                }
                if current is not IArrayTypeSymbol array {
                    break
                }
                current = array.ElementType
                position = JoinPosition(position, "0")
                relativePosition = JoinPosition(relativePosition, "0")
            }
            return if positions.Count == 0 {
                elementType
            } else {
                PromoteNestedPosition(elementType, elementTypeSymbol, positions, "0")
            }
        }

        /// Issue #5541: a collection expression that builds a class (`List<T> l = [x]`)
        /// states the same positions as an array literal, below its type argument.
        /// @param type The mapped target type.
        /// @param targetType The C# target type.
        /// @param collection The collection expression.
        /// @returns The target type to emit.
        private func PromoteObliviousCollectionTarget(
            type GTypeReference?,
            targetType ITypeSymbol?,
            collection CollectionExpressionSyntax
        ) GTypeReference? {
            let positions = this.ObliviousArrayLiteralPositions(collection)
            positions.Remove("")
            return if positions.Count == 0 {
                type
            } else {
                PromoteNestedPositions(type, targetType, positions, "")
            }
        }

        // The nullable positions of an array literal's type: those of the sink that
        // receives it (an `async` method's task result included) and those that its
        // elements give it.
        private func ObliviousArrayLiteralPositions(
            literal ExpressionSyntax?,
            model SemanticModel? = nil,
            flow ObliviousContainerFlow? = nil
        ) HashSet[string] {
            if literal == nil || (flow == nil && !this.ObliviousContainerFlowState().HasNullable) {
                return HashSet[string](System.StringComparer.Ordinal)
            }
            let activeModel = model ?? this.context.SemanticModel
            let activeFlow = flow ?? this.ObliviousContainerFlowState()
            let literalType ITypeSymbol? = ElementLiteralType(literal, activeModel)
            let positions = if literalType is IArrayTypeSymbol || literal is CollectionExpressionSyntax {
                this.SinkNullablePositions(literal, literalType, activeModel, activeFlow)
            } else {
                HashSet[string](System.StringComparer.Ordinal)
            }
            if IsElementLiteral(literal) {
                let own = this.ObliviousPositionsOf(literal, activeModel, activeFlow)
                if own != nil {
                    positions.UnionWith(own.Nullable)
                }
            }
            return positions
        }

        /// Issue #5537: whether [`value`](paramref) reads an element that oblivious
        /// container storage keeps nullable. Issue #5541: this is any read whose value
        /// the flow analysis gives a nullable top level: an indexer, field, property or
        /// call result, through any chain of element and member reads, a generic call
        /// result, a `foreach` variable, a lambda parameter, or a local that takes its
        /// type from one of these. A local that a G# nil test narrows is not.
        /// @param value The C# expression.
        /// @returns True when the translated read is nullable.
        private func ReadsObliviousContainerStorageElement(value ExpressionSyntax?) bool {
            let expression ExpressionSyntax? = Unparenthesize(value)
            if !(
                expression is IdentifierNameSyntax ||
                    expression is MemberAccessExpressionSyntax ||
                    expression is ElementAccessExpressionSyntax ||
                    expression is InvocationExpressionSyntax ||
                    expression is AwaitExpressionSyntax
            ) {
                return false
            }
            let positions = this.ObliviousValuePositions(expression)
            return positions != nil && positions.Nullable.Contains("") && !this.IsGSharpFlowNarrowedLocal(expression)
        }

        /// Issue #5537: whether [`value`](paramref) is written into a position that
        /// oblivious container storage keeps nullable, so the write accepts nil. The
        /// container is the receiver of a call or element write, or a construction
        /// stored in such storage whose collection initializer holds the value. The
        /// written parameter or indexer is typed by the container's type parameter, or
        /// the value is an array element.
        /// @param value The written C# value.
        /// @returns True when the destination position of the value is `T?` in G#.
        ///
        /// Issue #5541: a value that the analysis gives a nullable top level gets no
        /// `!!` unless its slot is proven non-null (see `SlotProvesNonNull`). A slot
        /// that the analysis cannot resolve fails closed: the translation keeps the
        /// value as it is, so it either binds or reports a compile error, and never
        /// throws where C# stores nil.
        private func WritesObliviousContainerStorageElement(value ExpressionSyntax?) bool {
            if value == nil || !this.ObliviousContainerFlowState().HasNullable {
                return false
            }
            let written = this.WrittenWholeValue(value)
            if this.GetUserDefinedConversionInputOperator(written, nil, out _) is {} directOperator {
                return this.ObliviousContainerPositions(directOperator.Parameters[0])?.Contains("") == true
            }
            if this.UserDefinedConversionOperator(written, this.context.SemanticModel) is {} conversionOperator {
                return this.ObliviousContainerPositions(conversionOperator.Parameters[0])?.Contains("") == true
            }
            if this.WritesNullableSlot(value) {
                return true
            }
            return this.ReadsObliviousContainerStorageElement(value) && !this.SlotProvesNonNull(written)
        }

        // Whether the slot that [`written`](paramref) is written into is proven
        // non-null: a declared parameter, local, field, property, return, iterator
        // element or delegate result (the caller asks whether the run widens it), a
        // type parameter whose constraint rejects `T?`, or a type parameter of a
        // receiver whose storage the analysis knows. Any other slot, such as a type
        // parameter that a construction, a call or a lambda binds, or an array
        // element, is not proven.
        private func SlotProvesNonNull(written ExpressionSyntax) bool {
            let parent SyntaxNode? = written.Parent
            let model = this.context.SemanticModel
            if parent is ArgumentSyntax{Parent: TupleExpressionSyntax tuple} element {
                return this.TupleElementSlotProvesNonNull(tuple, tuple.Arguments.IndexOf(element))
            }
            if parent is ArgumentSyntax argument {
                let (parameter, prefix) = ArgumentDestination(argument, model)
                if parameter == nil {
                    return false
                }
                var slotType ITypeSymbol? = parameter.OriginalDefinition.Type
                if prefix == "0" {
                    slotType = (slotType as IArrayTypeSymbol)?.ElementType
                }
                return slotType != nil && this.SlotTypeProvesNonNull(
                    argument.Parent?.Parent as ExpressionSyntax,
                    slotType
                )
            }
            if parent is EqualsValueClauseSyntax {
                return true
            }
            if parent is AssignmentExpressionSyntax assignment && assignment.Right == written {
                let member ISymbol? = this.context.GetSymbolInfo(assignment.Left).Symbol
                // An object initializer member of a construction.
                if assignment.Parent is InitializerExpressionSyntax memberInitializer &&
                    memberInitializer.Parent is BaseObjectCreationExpressionSyntax memberCreation {
                    let memberType ITypeSymbol? = StorageType(member?.OriginalDefinition)
                    return memberType != nil && this.SlotTypeProvesNonNull(memberCreation, memberType)
                }
                return this.StoreTargetProvesNonNull(assignment.Left)
            }
            if parent is ReturnStatementSyntax ||
                parent is YieldStatementSyntax ||
                parent is ArrowExpressionClauseSyntax ||
                parent is AnonymousFunctionExpressionSyntax {
                return this.ResultSlotProvesNonNull(written)
            }
            if parent is InitializerExpressionSyntax initializer {
                // A collection initializer element (`new List<T> { value }`, also inside a
                // complex element). An array element is not proven.
                let element ExpressionSyntax = if initializer.IsKind(SyntaxKind.ComplexElementInitializerExpression) {
                    initializer
                } else {
                    written
                }
                let collection SyntaxNode? = element.Parent
                if collection is not InitializerExpressionSyntax collectionInitializer || !collectionInitializer.IsKind(
                    SyntaxKind.CollectionInitializerExpression
                ) ||
                    collectionInitializer.Parent is not BaseObjectCreationExpressionSyntax collectionCreation ||
                    model
                    .GetCollectionInitializerSymbolInfo(element).Symbol is not IMethodSymbol add {
                    return false
                }
                let index = if object.ReferenceEquals(element, written) {
                    0
                } else {
                    initializer.Expressions.IndexOf(written)
                }
                return index >= 0 && index < add.OriginalDefinition.Parameters.Length && this.SlotTypeProvesNonNull(
                    collectionCreation,
                    add.OriginalDefinition.Parameters[index].Type
                )
            }
            if parent is ExpressionElementSyntax{Parent: CollectionExpressionSyntax collectionExpression} {
                let targetType ITypeSymbol? = model.GetTypeInfo(collectionExpression)
                    .ConvertedType ??
                    model
                    .GetTypeInfo(collectionExpression).Type
                if targetType is INamedTypeSymbol namedTarget &&
                    namedTarget.TypeKind == TypeKind.Class &&
                    this
                    .GetCollectionAddParameter(
                    collectionExpression,
                    namedTarget,
                    model.GetTypeInfo(written).Type ?? GetCollectionTargetElementType(namedTarget),
                    written
                ) is {} addParameter &&
                    this
                    .CollectionAddParameterRejectsNull(addParameter, written) {
                    return this.SlotTypeProvesNonNull(collectionExpression, addParameter.OriginalDefinition.Type)
                }
                return false
            }
            return false
        }

        private func CollectionAddParameterRejectsNull(
            addParameter IParameterSymbol,
            writtenValue ExpressionSyntax
        ) bool {
            let parameterType = addParameter.Type
            if !parameterType.IsReferenceType ||
                parameterType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated ||
                (this.InAnalyzerApiMode && RoslynAnalyzerApiMap.IsNamespaceSymbolType(parameterType)) ||
                ObliviousNullabilityAnalyzer
                .HasRunAllowNullWriteContract(
                addParameter,
                this.context.RepositoryCompilations ?? this.context.SiblingCompilations
            ) ||
                this.IsImportedObliviousNullableTarget(addParameter, parameterType, writtenValue) ||
                this
                .ObliviousContainerPositions(addParameter)?.Contains("") == true {
                return false
            }
            let targetDeclaredInThisCompilation = addParameter.DeclaringSyntaxReferences.Any(
                (reference SyntaxReference) -> this.context.Compilation.ContainsSyntaxTree(reference.SyntaxTree)
            )
            if !targetDeclaredInThisCompilation && ObliviousNullabilityAnalyzer.IsNullArgumentTarget(
                this.context.Compilation,
                addParameter,
                this.context.RepositoryCompilations ?? this.context.SiblingCompilations
            ) {
                return false
            }
            return !(targetDeclaredInThisCompilation && this.IsTranslatorWidenedDeclaration(addParameter))
        }

        // Whether a store into [`target`](paramref), the left of `target = value` or a
        // target of a deconstruction, is proven non-null. The plain store and the
        // deconstruction ask this one question. An element access asks the element-store
        // query that both forms share (#2259, #5595): a slot that accepts nil and
        // oblivious container storage (#5537) are not proven. As in
        // `BridgeDeconstructedElementStore`, a deconstructed array element whose storage
        // is not a declaration is not proven either (#5598); the plain store keeps its
        // #2259 decision there. A type parameter of the receiver is bound by the
        // receiver's storage. A discard and storage that the analysis widens are not
        // proven; any other declared target is.
        private func StoreTargetProvesNonNull(target ExpressionSyntax, deconstructed bool = false) bool {
            if this.StoreTargetIsObliviousContainerElement(target) {
                return false
            }
            let member ISymbol? = this.context.GetSymbolInfo(target).Symbol
            if member is IDiscardSymbol || this.ObliviousContainerPositions(member)?.Contains("") == true {
                return false
            }
            if (target is ElementAccessExpressionSyntax || target is MemberAccessExpressionSyntax) &&
                StorageType(member?.OriginalDefinition) is ITypeParameterSymbol receiverParameter {
                return this.SlotTypeProvesNonNull(target, receiverParameter)
            }
            if target is ElementAccessExpressionSyntax access {
                return !(deconstructed && member == nil && this.ArrayElementStorage(access).Root == nil) &&
                    this.ElementAccessStoreRequiresNonNullReference(target)
            }
            return true
        }

        // Whether element [`index`](paramref) of a tuple literal goes into a slot
        // that is proven non-null: an element of a declared tuple local, field,
        // parameter or return, or a deconstruction target that is declared with a
        // type or is existing storage. An implicitly typed (`var`) target, a discard
        // and a slot that the run widens are not proven.
        private func TupleElementSlotProvesNonNull(tuple TupleExpressionSyntax, index int32) bool {
            let model = this.context.SemanticModel
            let indices = List[int32]{index}
            let rootTuple TupleExpressionSyntax = CollectTupleAncestors(tuple, indices)
            let rootExpression ExpressionSyntax = UnwrapParenthesizedAncestors(rootTuple)
            var storage ISymbol? = nil
            var slotType ITypeSymbol? = nil
            var position = ""
            for step in indices {
                position = JoinPosition(position, TupleElementPosition(step))
            }
            switch rootExpression.Parent {
                case EqualsValueClauseSyntax{Parent: VariableDeclaratorSyntax declarator} {
                    storage = model.GetDeclaredSymbol(declarator)
                    if storage is ILocalSymbol local && IsImplicitlyTypedLocal(local) {
                        return false
                    }
                    slotType = NestedTupleElementType(StorageType(storage?.OriginalDefinition), indices)
                }
                case assignment is AssignmentExpressionSyntax when assignment.Right == rootExpression {
                    let leftTarget = Unparenthesize(assignment.Left)
                    if leftTarget is TupleExpressionSyntax targets {
                        // A deconstruction writes each element into its own target.
                        if ResolveDeconstructedTupleTarget(targets, indices, 0) is not{} target {
                            return false
                        }
                        if target is not DeclarationExpressionSyntax declaration {
                            // Existing storage, an element or a member is the target of a
                            // plain store (`target = value`) and is decided as one.
                            return !(target is TupleExpressionSyntax) && this.StoreTargetProvesNonNull(
                                target,
                                deconstructed: true
                            )
                        }
                        if declaration
                            .Type
                            .IsVar ||
                            declaration.Designation is not SingleVariableDesignationSyntax designation {
                            return false
                        }
                        storage = model.GetDeclaredSymbol(designation)
                        slotType = StorageType(storage?.OriginalDefinition)
                        position = ""
                    } else if leftTarget is DeclarationExpressionSyntax {
                        return false
                    } else {
                        storage = model.GetSymbolInfo(assignment.Left).Symbol
                        slotType = NestedTupleElementType(StorageType(storage?.OriginalDefinition), indices)
                    }
                }
                case result is SyntaxNode when result is ReturnStatementSyntax ||
                    result is ArrowExpressionClauseSyntax {
                    if !this.ResultSlotProvesNonNull(rootExpression) || model.GetEnclosingSymbol(
                        rootExpression.SpanStart
                    ) is not IMethodSymbol method ||
                        method.IsAsync ||
                        method.MethodKind == MethodKind.AnonymousFunction {
                        return false
                    }
                    storage = AccessorStorage(method)
                    slotType = NestedTupleElementType(StorageType(storage?.OriginalDefinition), indices)
                }
                case argument is ArgumentSyntax {
                    let (parameter, prefix) = ArgumentDestination(argument, model)
                    if parameter == nil || prefix != "" {
                        return false
                    }
                    storage = parameter
                    slotType = NestedTupleElementType(parameter.OriginalDefinition.Type, indices)
                }
                default {
                    return false
                }
            }
            if slotType == nil || this.ObliviousContainerPositions(storage)?.Contains(position) == true {
                return false
            }
            return slotType is not ITypeParameterSymbol parameterType ||
                NullableTypeArgumentViolatesTranslatedConstraints(parameterType)
        }

        // Whether the result slot of the function that returns [`result`](paramref) is
        // proven non-null: a method, property, local function or a lambda with a fixed
        // delegate is declared; a lambda whose delegate result a call binds is not.
        private func ResultSlotProvesNonNull(result ExpressionSyntax) bool {
            var node SyntaxNode? = result.Parent
            while node != nil && !(node is AnonymousFunctionExpressionSyntax) {
                if node is LocalFunctionStatementSyntax ||
                    node is BaseMethodDeclarationSyntax ||
                    node is AccessorDeclarationSyntax ||
                    node is BasePropertyDeclarationSyntax {
                    return true
                }
                node = node.Parent
            }
            if node is not AnonymousFunctionExpressionSyntax lambda {
                return false
            }
            var argumentNode SyntaxNode? = lambda.Parent
            while argumentNode is ParenthesizedExpressionSyntax {
                argumentNode = argumentNode.Parent
            }
            if argumentNode is not ArgumentSyntax argument {
                // A lambda stored in declared delegate storage has a fixed result.
                return true
            }
            if this
                .context
                .SemanticModel
                .GetOperation(argument) is not IArgumentOperation operation ||
                operation.Parameter == nil {
                return false
            }
            let invoke IMethodSymbol? = (
                operation.Parameter!!.OriginalDefinition.Type as INamedTypeSymbol
            )?.DelegateInvokeMethod
            if invoke == nil {
                return false
            }
            var slotType ITypeSymbol? = invoke.ReturnType
            if lambda.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword) {
                // The result of an `async` lambda is its task's result.
                slotType = if slotType is INamedTypeSymbol task && IsGenericTaskLike(task) {
                    task.TypeArguments[0]
                } else {
                    nil
                }
            }
            return slotType != nil && this.SlotTypeProvesNonNull(argument.Parent?.Parent as ExpressionSyntax, slotType)
        }

        // Whether a slot of declared type [`slotType`](paramref) (in the declaring
        // definition's terms) is proven non-null at the top level.
        private func SlotTypeProvesNonNull(call ExpressionSyntax?, slotType ITypeSymbol) bool {
            if slotType is not ITypeParameterSymbol parameter {
                return true
            }
            if NullableTypeArgumentViolatesTranslatedConstraints(parameter) {
                return true
            }
            // A type parameter of the receiver's type, which the receiver's storage
            // binds: `list.Add(value)` on `List[string]` storage, the key of
            // `table[key]` and the value of `table[key] = value` or `box.Value = value`.
            if parameter.TypeParameterKind == TypeParameterKind.Type && this.ReceiverBoundMember(call) != nil {
                return !this.CallSlotIsNullable(call!!, slotType)
            }
            return false
        }

        // The instance member that [`access`](paramref) reaches through a receiver
        // whose storage binds the member's type parameters: a method call, an indexer
        // read or write, or a field or property read or write. An extension call, a
        // static member and a `this` or `base` receiver bind nothing.
        private func ReceiverBoundMember(access ExpressionSyntax?, model SemanticModel? = nil) ISymbol? {
            let receiver ExpressionSyntax? = MemberReceiver(access)
            if receiver == nil || receiver is ThisExpressionSyntax || receiver is BaseExpressionSyntax {
                return nil
            }
            let activeModel = model ?? this.context.SemanticModel
            let member ISymbol? = activeModel.GetSymbolInfo(access!!).Symbol
            return if member == nil ||
                member.IsStatic ||
                (member is IMethodSymbol method && method.ReducedFrom != nil) ||
                !(member is IMethodSymbol || member is IPropertySymbol || member is IFieldSymbol) {
                nil
            } else {
                member
            }
        }

        // Whether [`value`](paramref) is written into a slot that the analysis makes
        // nullable.
        private func WritesNullableSlot(value ExpressionSyntax?) bool {
            if value == nil || !this.ObliviousContainerFlowState().HasNullable {
                return false
            }
            let written ExpressionSyntax = this.WrittenWholeValue(value)
            let parent SyntaxNode? = written.Parent
            // `items.Add(value)`, `items.Insert(0, value)`, `map.Add(key, value)` and an
            // index argument such as `lookup[value]`.
            // An expanded `params` argument is an element of the parameter's array.
            if parent is ArgumentSyntax expandedArgument {
                let (paramsParameter, paramsPrefix) = ArgumentDestination(expandedArgument, this.context.SemanticModel)
                if paramsParameter != nil &&
                    paramsPrefix == "0" &&
                    paramsParameter
                    .OriginalDefinition
                    .Type is IArrayTypeSymbol paramsArray &&
                    expandedArgument
                    .Parent
                    ?.Parent is ExpressionSyntax paramsCall &&
                    this.CallSlotIsNullable(paramsCall, paramsArray.ElementType) {
                    return true
                }
            }
            if parent is ArgumentSyntax argument &&
                this
                .context
                .SemanticModel
                .GetOperation(argument) is IArgumentOperation{Parameter: {} parameter} {
                let receiver ExpressionSyntax? = switch argument.Parent?.Parent {
                    case invocation is InvocationExpressionSyntax: (
                        if invocation.Expression is MemberAccessExpressionSyntax target &&
                            parameter.ContainingSymbol is IMethodSymbol{ReducedFrom: nil} {
                            target.Expression
                        } else {
                            default(ExpressionSyntax?)
                        }
                    )
                    case access is ElementAccessExpressionSyntax: access.Expression
                    default: default(ExpressionSyntax?)
                }
                if receiver != nil && this.ElementPositionIsPromoted(receiver, parameter) {
                    return true
                }
                // Issue #5541: a parameter typed by a type parameter that the call binds to
                // a nullable position (`Id[string?](x)`, `Box[string?](x)`, or an
                // inferred `T?`) takes the value as it is.
                return argument.Parent?.Parent is ExpressionSyntax call && this.CallSlotIsNullable(
                    call,
                    parameter.OriginalDefinition.Type
                )
            }
            // A lambda result whose delegate result type the call binds to a nullable
            // position: `lines.Select(l => { return l; })`.
            if parent is ReturnStatementSyntax ||
                (parent is AnonymousFunctionExpressionSyntax resultLambda && resultLambda.ExpressionBody == written) {
                return this.LambdaResultSlotIsNullable(written)
            }
            if parent is AssignmentExpressionSyntax assignment && assignment.IsKind(
                SyntaxKind.SimpleAssignmentExpression
            ) &&
                assignment.Right == written {
                if assignment.Left is ElementAccessExpressionSyntax || assignment.Left is MemberAccessExpressionSyntax {
                    return this.StoreTargetIsObliviousContainerElement(assignment.Left)
                }
            }
            let (creation, member) = this.InitializerWriteTarget(written)
            if creation != nil && member != nil {
                let createdType ITypeSymbol? = this.context.GetTypeInfo(creation).Type
                return MemberPositionIsNullable(
                    this.EffectiveCreationPositions(creation, createdType),
                    createdType,
                    member
                )
            }
            return false
        }

        // The construction and the member or `Add` parameter that an object or
        // collection initializer write fills: `new List<T> { value }`,
        // `new Dictionary<K, V> { { key, value } }`, `new Dictionary<K, V> { [key] = value }`
        // and `new Box<T> { Value = value }`.
        private func InitializerWriteTarget(written ExpressionSyntax, model SemanticModel? = nil)(
            Creation BaseObjectCreationExpressionSyntax?,
            Member ISymbol?
        ) {
            let activeModel = model ?? this.context.SemanticModel
            let parent SyntaxNode? = written.Parent
            var element SyntaxNode = written
            var index = 0
            var member ISymbol? = nil
            if parent is AssignmentExpressionSyntax initializerAssignment &&
                initializerAssignment.Right == written &&
                (
                initializerAssignment.Left is ImplicitElementAccessSyntax ||
                    initializerAssignment.Left is IdentifierNameSyntax
            ) {
                member = activeModel.GetSymbolInfo(initializerAssignment.Left).Symbol
                element = initializerAssignment
            } else if parent is InitializerExpressionSyntax complex && complex.IsKind(
                SyntaxKind.ComplexElementInitializerExpression
            ) {
                index = complex.Expressions.IndexOf(written)
                element = complex
            }
            if element.Parent is not InitializerExpressionSyntax initializer ||
                initializer.Parent is not BaseObjectCreationExpressionSyntax creation {
                return (nil, nil)
            }
            if member == nil {
                if !initializer.IsKind(SyntaxKind.CollectionInitializerExpression) ||
                    activeModel
                    .GetCollectionInitializerSymbolInfo(cast[ExpressionSyntax](element))
                    .Symbol is not IMethodSymbol add ||
                    index < 0 ||
                    index >= add
                    .Parameters
                    .Length {
                    return (nil, nil)
                }
                member = add.Parameters[index]
            }
            return (creation, member)
        }

        /// Issue #5595: whether the store target [`target`](paramref) is a position that
        /// oblivious container storage keeps nullable. A plain assignment and a
        /// deconstruction into the same target ask this one question.
        /// @param target The C# store target.
        /// @returns True when the target is `T?` in G#.
        private func StoreTargetIsObliviousContainerElement(target ExpressionSyntax?) bool {
            return switch target {
                // `items[0] = value`, `lines[0] = value`, `map[key] = value`.
                case access is ElementAccessExpressionSyntax: this.ElementPositionIsPromoted(
                    access.Expression,
                    this.context.GetSymbolInfo(access).Symbol
                )
                // `box.Value = value`.
                case memberAccess is MemberAccessExpressionSyntax: this.ElementPositionIsPromoted(
                    memberAccess.Expression,
                    this.context.GetSymbolInfo(memberAccess).Symbol
                )
                default: false
            }
        }

        // Whether the type [`slotType`](paramref) of a parameter or delegate result of
        // the call [`call`](paramref), with the call's type arguments bound as the
        // analysis binds them, is nullable at the top level.
        private func CallSlotIsNullable(call ExpressionSyntax, slotType ITypeSymbol, position string = "") bool -> this
            .CallSlotPositions(call, slotType)
            ?.Nullable
            .Contains(position) == true

        // The positions of the type [`slotType`](paramref) of a parameter or delegate
        // result of the call [`call`](paramref), with the call's type arguments bound
        // as the analysis binds them.
        private func CallSlotPositions(
            call ExpressionSyntax,
            slotType ITypeSymbol,
            model SemanticModel? = nil,
            flow ObliviousContainerFlow? = nil
        ) ObliviousPositionSet? {
            if !MentionsTypeParameter(slotType) {
                return nil
            }
            let activeFlow = flow ?? this.ObliviousContainerFlowState()
            let activeModel = model ?? this.context.SemanticModel
            var bindings Dictionary[ITypeParameterSymbol, ObliviousPositionSet]? = nil
            if call is InvocationExpressionSyntax invocation && activeModel.GetSymbolInfo(invocation)
                .Symbol is IMethodSymbol method {
                bindings = this.ObliviousMemberTypeArguments(invocation, method, activeModel, activeFlow)
            } else if call is ImplicitElementAccessSyntax &&
                MemberReceiver(call) is BaseObjectCreationExpressionSyntax initialized &&
                this.ReceiverBoundMember(call, activeModel) is {} initializedMember && activeModel.GetTypeInfo(
                initialized
            )
                .Type is INamedTypeSymbol initializedType {
                // An indexer write in an object initializer (`new D { [key] = value }`)
                // binds the indexer's type parameters to the positions that the
                // construction states.
                bindings = TypeParameterMap()
                Unify(
                    initializedMember.ContainingType.OriginalDefinition,
                    initializedType,
                    this.EffectiveCreationPositions(initialized, initializedType, activeModel, activeFlow),
                    bindings
                )
            } else if !(call is InvocationExpressionSyntax) && this.ReceiverBoundMember(
                call,
                activeModel
            ) is {} member {
                // An indexer, field or property binds its type's parameters to the
                // receiver's positions, as a method call does; `table?[key]` binds them
                // to the conditional receiver's.
                bindings = this.ObliviousMemberTypeArguments(call, member, activeModel, activeFlow)
            } else if call is BaseObjectCreationExpressionSyntax creation && activeModel.GetTypeInfo(creation)
                .Type is INamedTypeSymbol created {
                // A construction binds its type parameters to the positions it states.
                let stated = this.EffectiveCreationPositions(creation, created, activeModel, activeFlow)
                bindings = TypeParameterMap()
                let parameters = FlatTypeArguments(created.OriginalDefinition)
                for var i = 0; i < parameters.Count; i++ {
                    if parameters[i] is ITypeParameterSymbol parameter {
                        bindings[parameter] = Subtree(stated, IndexPosition(i))
                    }
                }
            }
            if bindings == nil {
                return nil
            }
            let slot = ObliviousPositionSet()
            Substitute(slotType, bindings, "", slot)
            return slot
        }

        // Whether a value that a lambda returns has a nullable delegate result, because
        // the call that receives the lambda binds that result's type to a nullable
        // position.
        private func LambdaResultSlotIsNullable(result ExpressionSyntax) bool {
            var node SyntaxNode? = result.Parent
            while node != nil && !(node is AnonymousFunctionExpressionSyntax) {
                if node is LocalFunctionStatementSyntax || node is BaseMethodDeclarationSyntax {
                    return false
                }
                node = node.Parent
            }
            if node is not AnonymousFunctionExpressionSyntax lambda {
                return false
            }
            let isAsync = lambda.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword)
            var argumentNode SyntaxNode? = lambda.Parent
            while argumentNode is ParenthesizedExpressionSyntax {
                argumentNode = argumentNode.Parent
            }
            if argumentNode is not ArgumentSyntax argument ||
                argument
                .Parent
                ?.Parent is not ExpressionSyntax call ||
                this
                .context
                .SemanticModel
                .GetOperation(argument) is not IArgumentOperation operation ||
                operation.Parameter == nil {
                return false
            }
            let invoke IMethodSymbol? = (
                operation.Parameter!!.OriginalDefinition.Type as INamedTypeSymbol
            )?.DelegateInvokeMethod
            // An `async` lambda returns its task's result, position `0` of the result.
            return invoke != nil && !invoke.ReturnsVoid && this.CallSlotIsNullable(
                call,
                invoke.ReturnType,
                if isAsync {
                    "0"
                } else {
                    ""
                }
            )
        }

        // The whole value that a write stores: an arm of a conditional or switch
        // expression, the right operand of `??`, or a parenthesized value flows into the
        // enclosing expression, unless a user-defined conversion converts it first.
        private func WrittenWholeValue(value ExpressionSyntax) ExpressionSyntax {
            var written ExpressionSyntax = value
            while true {
                let parent SyntaxNode? = written.Parent
                let whole ExpressionSyntax? = switch parent {
                    case parenthesized is ParenthesizedExpressionSyntax: parenthesized
                    case conditional is ConditionalExpressionSyntax when conditional.Condition != written: conditional
                    case coalesce is BinaryExpressionSyntax when coalesce.IsKind(SyntaxKind.CoalesceExpression) &&
                        coalesce.Right == written: coalesce
                    case arm is SwitchExpressionArmSyntax when arm.Expression == written: arm.Parent as SwitchExpressionSyntax
                    default: default(ExpressionSyntax?)
                }
                if whole == nil || this.context.SemanticModel.GetConversion(written).IsUserDefined {
                    return written
                }
                written = whole
            }
        }

        // Whether the element of the container that [`container`](paramref) reads, or
        // the member result, parameter or indexer typed by one of its type parameters,
        // is a nullable position. A nil member is the element of an array.
        private func ElementPositionIsPromoted(container ExpressionSyntax?, member ISymbol?) bool {
            let positions = this.ObliviousValuePositions(container)
            return positions != nil &&
                MemberPositionIsNullable(positions, this.context.GetTypeInfo(container!!).Type, member)
        }

        // The positions of a value in the document being translated. Only a nullable
        // position changes the translation, so a compilation without one has none.
        private func ObliviousValuePositions(value ExpressionSyntax?) ObliviousPositionSet? {
            let flow = this.ObliviousContainerFlowState()
            return if value == nil || !flow.HasNullable {
                nil
            } else {
                this.ObliviousPositionsOf(value, this.context.SemanticModel, flow)
            }
        }

        // The user-defined conversion operator that converts [`value`](paramref) to its
        // target slot, or nil when no user-defined conversion applies.
        private func UserDefinedConversionOperator(value ExpressionSyntax?, model SemanticModel) IMethodSymbol? {
            if value == nil {
                return nil
            }
            for var conversion IConversionOperation? = ObliviousNullabilityAnalyzer.GetResultConversion(value, model);
                conversion != nil &&
                conversion.IsImplicit == true;
                conversion = conversion!!.Operand as IConversionOperation {
                if conversion.OperatorMethod is {Parameters: {Length: 1}} method {
                    return method
                }
            }
            let directConversion = model.GetConversion(value)
            if directConversion.IsUserDefined &&
                directConversion.MethodSymbol is {Parameters: {Length: 1}} directMethod {
                return directMethod
            }
            let convertedType ITypeSymbol? = model.GetTypeInfo(value).ConvertedType
            if convertedType != nil && ObliviousNullabilityAnalyzer.GetContextualOperator(
                value,
                model,
                convertedType
            ) is {Parameters: {Length: 1}} contextual {
                return contextual
            }
            let (creation, member) = this.InitializerWriteTarget(value, model)
            if creation != nil && member != nil {
                let slotType ITypeSymbol? = switch member {
                    case parameter is IParameterSymbol: parameter.Type
                    case field is IFieldSymbol: field.Type
                    case property is IPropertySymbol: property.Type
                    default: default(ITypeSymbol?)
                }
                if slotType != nil && ObliviousNullabilityAnalyzer.GetContextualOperator(value, model, slotType) is {
                    Parameters: {Length: 1}
                } initializerOperator {
                    return initializerOperator
                }
            }
            return nil
        }

        // The positions that [`value`](paramref) gives the slot that receives it: the
        // return positions of its user-defined conversion operator when one converts
        // it, and its own positions otherwise.
        private func ConvertedObliviousPositionsOf(
            value ExpressionSyntax?,
            model SemanticModel,
            flow ObliviousContainerFlow
        ) ObliviousPositionSet? {
            if value == nil {
                return nil
            }
            if this.UserDefinedConversionOperator(value, model) is {} conversionOperator {
                let result = ObliviousPositionSet()
                let declared = DeclaredPositions(flow, conversionOperator)
                if declared != nil {
                    result.Nullable.UnionWith(declared)
                }
                if this.IsFrozenObliviousImportMember(conversionOperator) {
                    CollectPlatformPositions(StorageType(UnreducedDefinition(conversionOperator)), "", result.Platform)
                }
                return Filtered(conversionOperator.ReturnType, result)
            }
            return this.ObliviousPositionsOf(value, model, flow)
        }

        /// Issue #5541: the positions that G# gives the value of
        /// [`value`](paramref): the positions recorded for the storage that it reads,
        /// the platform positions of a frozen oblivious member, and the positions that
        /// the element, member, generic call or construction takes from its receiver and
        /// arguments. Conditional, switch and coalescing arms merge.
        /// @param value The C# expression.
        /// @param model The semantic model of its tree.
        /// @param flow The recorded storage.
        /// @returns The positions, or nil when there are none.
        private func ObliviousPositionsOf(
            value ExpressionSyntax?,
            model SemanticModel,
            flow ObliviousContainerFlow
        ) ObliviousPositionSet? {
            let memo = flow.Memo
            if memo == nil || value == nil {
                return this.ComputeObliviousPositionsOf(value, model, flow)
            }
            if memo.TryGetValue(value, out var cached) {
                return cached
            }
            let computed = this.ComputeObliviousPositionsOf(value, model, flow)
            memo[value] = computed
            return computed
        }

        private func ComputeObliviousPositionsOf(
            value ExpressionSyntax?,
            model SemanticModel,
            flow ObliviousContainerFlow
        ) ObliviousPositionSet? {
            if value is ParenthesizedExpressionSyntax parenthesized {
                return this.ObliviousPositionsOf(parenthesized.Expression, model, flow)
            }
            if value is PostfixUnaryExpressionSyntax suppression && suppression.IsKind(
                SyntaxKind.SuppressNullableWarningExpression
            ) {
                return WithoutTopLevel(this.ObliviousPositionsOf(suppression.Operand, model, flow))
            }
            if value is ConditionalExpressionSyntax conditional {
                return Merge(
                    this.ObliviousPositionsOf(conditional.WhenTrue, model, flow),
                    this.ObliviousPositionsOf(conditional.WhenFalse, model, flow)
                )
            }
            // The top level of `a ?? b` is the top level of `b`.
            if value is BinaryExpressionSyntax coalesce && coalesce.IsKind(SyntaxKind.CoalesceExpression) {
                return Merge(
                    WithoutTopLevel(this.ObliviousPositionsOf(coalesce.Left, model, flow)),
                    this.ObliviousPositionsOf(coalesce.Right, model, flow)
                )
            }
            if value is SwitchExpressionSyntax switchExpression {
                var arms ObliviousPositionSet? = nil
                for arm in switchExpression.Arms {
                    arms = Merge(arms, this.ObliviousPositionsOf(arm.Expression, model, flow))
                }
                return arms
            }
            if value is AwaitExpressionSyntax awaitExpression {
                return this.ObliviousAwaitedPositions(awaitExpression, model, flow)
            }
            if IsElementLiteral(value!!) {
                return this.ObliviousLiteralPositions(value!!, model, flow)
            }
            // A tuple literal holds each element's positions below the element's index.
            if value is TupleExpressionSyntax tuple {
                let tupleInfo = model.GetTypeInfo(tuple)
                let elements = ObliviousPositionSet()
                for var i = 0; i < tuple.Arguments.Count; i++ {
                    let elementPositions = this.ObliviousPositionsOf(tuple.Arguments[i].Expression, model, flow)
                    if elementPositions != nil {
                        elements.UnionWith(Prefixed(elementPositions, TupleElementPosition(i)))
                    }
                }
                return Filtered(tupleInfo.Type ?? tupleInfo.ConvertedType, elements)
            }
            // `a?.b` has the positions of its bound part, read from `a`; G# keeps the
            // result's outer `?`.
            if value is ConditionalAccessExpressionSyntax conditionalAccess {
                return this.ObliviousPositionsOf(conditionalAccess.WhenNotNull, model, flow)
            }
            if !(
                value is IdentifierNameSyntax ||
                    value is DeclarationExpressionSyntax ||
                    value is MemberAccessExpressionSyntax ||
                    value is MemberBindingExpressionSyntax ||
                    value is ElementAccessExpressionSyntax ||
                    value is ElementBindingExpressionSyntax ||
                    value is InvocationExpressionSyntax ||
                    value is BaseObjectCreationExpressionSyntax
            ) {
                return nil
            }
            let symbol ISymbol? = ArgumentStorageSymbol(value!!, model)
            // A method group is a callable, not the value of a call.
            if symbol is IMethodSymbol &&
                !(value is InvocationExpressionSyntax || value is BaseObjectCreationExpressionSyntax) {
                return nil
            }
            let positions = ObliviousPositionSet()
            if symbol != nil && !(value is BaseObjectCreationExpressionSyntax) {
                let declared = DeclaredPositions(flow, symbol)
                if declared != nil {
                    positions.Nullable.UnionWith(declared)
                }
                if flow.Inferred.TryGetValue(symbol.OriginalDefinition, out var inferred) {
                    positions.UnionWith(inferred)
                }
                if this.IsFrozenObliviousImportMember(symbol) {
                    CollectPlatformPositions(StorageType(UnreducedDefinition(symbol)), "", positions.Platform)
                }
                // A local that a G# nil test narrows reads as non-null at its top level,
                // so a generic call or local that takes its type from it does too.
                if positions.Nullable.Contains("") && value is IdentifierNameSyntax && this.IsNarrowedLocalRead(value) {
                    positions.Nullable.Remove("")
                }
            }
            let arrayReceiver ExpressionSyntax? = if value is ElementAccessExpressionSyntax ||
                value is ElementBindingExpressionSyntax {
                MemberReceiver(value)
            } else {
                nil
            }
            if arrayReceiver != nil && model.GetTypeInfo(arrayReceiver).Type is IArrayTypeSymbol {
                let receiverPositions = this.ObliviousPositionsOf(arrayReceiver, model, flow)
                // A `System.Range` slice is an array of the same element; an index reads
                // the element at position `0`.
                if IsRangeElementArguments(value!!, model) {
                    positions.UnionWith(WithoutTopLevel(receiverPositions) ?? ObliviousPositionSet())
                } else {
                    positions.UnionWith(Subtree(receiverPositions, "0"))
                }
            } else if value is BaseObjectCreationExpressionSyntax creation {
                positions.UnionWith(this.ObliviousCreationPositions(creation, model, flow))
            } else if symbol is IFieldSymbol tupleField && tupleField.ContainingType?.IsTupleType == true {
                let tupleIndex = TupleFieldIndex(tupleField)
                let tupleReceiver ExpressionSyntax? = if value is MemberBindingExpressionSyntax {
                    ConditionalReceiver(value)
                } else {
                    MemberReceiver(value)
                }
                if tupleIndex >= 0 && tupleReceiver != nil {
                    positions.UnionWith(
                        Subtree(this.ObliviousPositionsOf(tupleReceiver, model, flow), TupleElementPosition(tupleIndex))
                    )
                }
            } else if (symbol is IFieldSymbol || symbol is IPropertySymbol || symbol is IMethodSymbol) &&
                StorageType(UnreducedDefinition(symbol!!)) is {} memberType &&
                MentionsTypeParameter(memberType) {
                let bindings = this.ObliviousMemberTypeArguments(value!!, symbol!!, model, flow)
                Substitute(memberType, bindings, "", positions)
            }
            return Filtered(model.GetTypeInfo(value!!).Type ?? StorageType(symbol), positions)
        }

        // Whether G# narrows the local or parameter that [`read`](paramref) reads to
        // non-null. The answer depends only on the read's own tree and enclosing body,
        // so the analysis and the translation of every document agree on it.
        private func IsNarrowedLocalRead(read ExpressionSyntax) bool {
            let modelScope = this.context.UseSemanticModelFor(read.SyntaxTree)
            let bodyScope SyntaxNode? = this.state.CurrentBodyScope
            this.state.CurrentBodyScope = nil
            let narrowed = this.IsGSharpFlowNarrowedLocal(read)
            this.state.CurrentBodyScope = bodyScope
            modelScope.Dispose()
            return narrowed
        }

        // The positions of an awaited result: the awaitable's positions carried
        // through its `GetAwaiter()` and the awaiter's `GetResult()`, so a task, a
        // value task and a configured awaitable (`ConfigureAwait(false)`) read alike.
        private func ObliviousAwaitedPositions(
            awaitExpression AwaitExpressionSyntax,
            model SemanticModel,
            flow ObliviousContainerFlow
        ) ObliviousPositionSet? {
            let info = model.GetAwaitExpressionInfo(awaitExpression)
            let getAwaiter IMethodSymbol? = info.GetAwaiterMethod
            let getResult IMethodSymbol? = info.GetResultMethod
            if getAwaiter == nil ||
                getResult == nil ||
                getAwaiter.IsExtensionMethod ||
                getAwaiter.ContainingType == nil ||
                getResult.ContainingType == nil {
                return nil
            }
            let operand = this.ObliviousPositionsOf(awaitExpression.Expression, model, flow)
            if operand == nil {
                return nil
            }
            let awaitableBindings = TypeParameterMap()
            Unify(
                getAwaiter.ContainingType.OriginalDefinition,
                model.GetTypeInfo(awaitExpression.Expression).Type,
                operand,
                awaitableBindings
            )
            let awaiter = ObliviousPositionSet()
            Substitute(getAwaiter.OriginalDefinition.ReturnType, awaitableBindings, "", awaiter)
            let awaiterBindings = TypeParameterMap()
            Unify(getResult.ContainingType.OriginalDefinition, getAwaiter.ReturnType, awaiter, awaiterBindings)
            let result = ObliviousPositionSet()
            Substitute(getResult.OriginalDefinition.ReturnType, awaiterBindings, "", result)
            return Filtered(model.GetTypeInfo(awaitExpression).Type, result)
        }

        // The positions that the receiver of a member read and the arguments of a
        // generic call give the type parameters of the member's type.
        private func ObliviousMemberTypeArguments(
            value ExpressionSyntax,
            symbol ISymbol,
            model SemanticModel,
            flow ObliviousContainerFlow
        ) Dictionary[ITypeParameterSymbol, ObliviousPositionSet] {
            let bindings = TypeParameterMap()
            let receiver ExpressionSyntax? = MemberReceiver(value)
            // An extension call reads its receiver as its first argument.
            let reduced = symbol is IMethodSymbol method && method.ReducedFrom != nil
            if receiver != nil &&
                !symbol.IsStatic &&
                !reduced &&
                symbol.ContainingType != nil &&
                !(receiver is BaseExpressionSyntax || receiver is ThisExpressionSyntax) {
                let receiverPositions = this.ObliviousPositionsOf(receiver, model, flow)
                if receiverPositions != nil {
                    Unify(
                        symbol.ContainingType.OriginalDefinition,
                        model.GetTypeInfo(receiver).Type,
                        receiverPositions,
                        bindings
                    )
                }
            }
            if value is InvocationExpressionSyntax call && model.GetOperation(call) is IInvocationOperation operation &&
                operation
                .TargetMethod
                .IsGenericMethod {
                this.InferObliviousTypeArguments(
                    call,
                    operation.TargetMethod.OriginalDefinition.TypeParameters,
                    operation.Arguments,
                    HasExplicitTypeArguments(call.Expression),
                    model,
                    flow,
                    bindings
                )
            }
            return bindings
        }

        // The positions that a construction spells: its arguments give positions to
        // the type parameters of the constructed type, which the construction states.
        private func ObliviousCreationPositions(
            creation BaseObjectCreationExpressionSyntax,
            model SemanticModel,
            flow ObliviousContainerFlow
        ) ObliviousPositionSet? {
            if model.GetOperation(creation) is not IObjectCreationOperation operation ||
                operation.Constructor == nil ||
                operation.Type is not INamedTypeSymbol created ||
                (operation.Arguments.Length == 0 && creation.Initializer == nil) {
                return nil
            }
            let definition = created.OriginalDefinition
            let parameters = FlatTypeArguments(definition)
            if parameters.Count == 0 {
                return nil
            }
            let bindings = TypeParameterMap()
            this.InferObliviousTypeArguments(
                creation,
                parameters.OfType[ITypeParameterSymbol]().ToList(),
                operation.Arguments,
                true,
                model,
                flow,
                bindings,
                creation.Initializer
            )
            if bindings.Count == 0 {
                return nil
            }
            let substituted = ObliviousPositionSet()
            Substitute(definition, bindings, "", substituted)
            let result = ObliviousPositionSet()
            for position in substituted.Nullable {
                if IsPromotablePosition(created, position) {
                    result.Nullable.Add(position)
                }
            }
            return if result.IsEmpty {
                nil
            } else {
                result
            }
        }

        // Adds to [`bindings`](paramref) the positions that the arguments of a call give the
        // [`inferred`](paramref) type parameters. A lambda argument gives its results to
        // the result type of its delegate. A type argument that the call states
        // (`spelled`) is nullable at each position, because the translation spells it.
        private func InferObliviousTypeArguments(
            call SyntaxNode,
            inferred IEnumerable[ITypeParameterSymbol],
            arguments System.Collections.Immutable.ImmutableArray[IArgumentOperation],
            spelled bool,
            model SemanticModel,
            flow ObliviousContainerFlow,
            bindings Dictionary[ITypeParameterSymbol, ObliviousPositionSet],
            initializer InitializerExpressionSyntax? = nil
        ) {
            let found = TypeParameterMap()
            // A construction's initializer writes give its type arguments positions as
            // its arguments do: `new List<string> { value }`, `new Box<T> { Value = value }`.
            if initializer != nil {
                for written in InitializerWrites(initializer, model) {
                    let writtenPositions = if MentionsTypeParameter(written.Pattern) {
                        this.ConvertedObliviousPositionsOf(written.Value, model, flow)
                    } else {
                        nil
                    }
                    if writtenPositions != nil {
                        Unify(written.Pattern, StoredValueType(written.Value, model), writtenPositions, found)
                    }
                }
            }
            let lambdas = List[(Parameter IParameterSymbol, Lambda AnonymousFunctionExpressionSyntax)]()
            for argument in arguments {
                let argumentParameter IParameterSymbol? = argument.Parameter
                if argumentParameter == nil || argument.ArgumentKind == ArgumentKind.DefaultValue {
                    continue
                }
                let parameterType = argumentParameter.OriginalDefinition.Type
                if !MentionsTypeParameter(parameterType) {
                    continue
                }
                if argument.ArgumentKind == ArgumentKind.ParamArray {
                    if parameterType is IArrayTypeSymbol arrayParameter &&
                        argument.Value is IArrayCreationOperation{Initializer: {} initializer} {
                        for element in initializer.ElementValues {
                            let elementValue ExpressionSyntax? = ArgumentValueSyntax(element)
                            let elementPositions = if IsWrittenIn(call, elementValue) {
                                this.ConvertedObliviousPositionsOf(elementValue, model, flow)
                            } else {
                                nil
                            }
                            if elementPositions != nil {
                                Unify(
                                    arrayParameter.ElementType,
                                    StoredValueType(elementValue!!, model),
                                    elementPositions,
                                    found
                                )
                            }
                        }
                    }
                    continue
                }
                let argumentValue ExpressionSyntax? = ArgumentValueSyntax(argument.Value)
                // An implicit argument, such as a `params` collection, can stand
                // for the call itself.
                if !IsWrittenIn(call, argumentValue) {
                    continue
                }
                if argumentValue is AnonymousFunctionExpressionSyntax lambda {
                    lambdas.Add((argumentParameter, lambda))
                    continue
                }
                var argumentPositions = this.ConvertedObliviousPositionsOf(argumentValue, model, flow)
                if argumentParameter.RefKind != RefKind.None {
                    let (storage, depth) = ObliviousNullabilityAnalyzer.RefArrayStorage(
                        argumentValue!!,
                        model,
                        preserveSubstitution: true
                    )
                    var declared = StorageType(storage)
                    let path = List[int32]()
                    for var i = 0; i < depth && declared is IArrayTypeSymbol array; i++ {
                        path.Add(0)
                        declared = array.ElementType
                    }
                    let tuplePositions = ObliviousPositionSet()
                    if storage != nil && path.Count == depth {
                        this.CollectTupleStoragePositions(storage, declared, model, path, "", tuplePositions.Nullable)
                    }
                    if !tuplePositions.IsEmpty {
                        if argumentPositions != nil {
                            tuplePositions.UnionWith(argumentPositions)
                        }
                        argumentPositions = tuplePositions
                    }
                }
                if argumentPositions != nil {
                    Unify(parameterType, StoredValueType(argumentValue!!, model), argumentPositions, found)
                }
            }
            for (parameter, lambda) in lambdas {
                let invoke IMethodSymbol? = (
                    parameter.OriginalDefinition.Type as INamedTypeSymbol
                )?.DelegateInvokeMethod
                if invoke == nil || invoke.ReturnsVoid {
                    continue
                }
                // An `async` lambda's results are its task's result, position `0` of the
                // task that the lambda returns.
                let isAsync = lambda.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword)
                let lambdaTask ITypeSymbol? = (model.GetSymbolInfo(lambda).Symbol as IMethodSymbol)?.ReturnType
                if isAsync && !IsGenericTaskLike(lambdaTask) {
                    continue
                }
                for result in LambdaResults(lambda) {
                    let resultPositions = this.ConvertedObliviousPositionsOf(result, model, flow)
                    if resultPositions == nil {
                        continue
                    }
                    if isAsync {
                        Unify(invoke.ReturnType, lambdaTask, Prefixed(resultPositions, "0"), found)
                    } else {
                        Unify(invoke.ReturnType, StoredValueType(result, model), resultPositions, found)
                    }
                }
            }
            for parameter in inferred {
                if found.TryGetValue(parameter, out var positions) {
                    // A constrained type parameter takes no `T?` argument in G#, so
                    // the argument keeps its non-null bridge instead.
                    if NullableTypeArgumentViolatesTranslatedConstraints(parameter) {
                        positions.Nullable.Remove("")
                        positions.Platform.Remove("")
                    }
                    if spelled {
                        positions.Nullable.UnionWith(positions.Platform)
                        positions.Platform.Clear()
                    }
                    AddTypeParameterPositions(bindings, parameter, positions)
                }
            }
        }

        private func CollectObliviousContainerFlow(compilation Compilation) ObliviousContainerFlow {
            let flow = ObliviousContainerFlow()
            let assignedLocals = HashSet[ISymbol](SymbolEqualityComparer.Default)
            let initializedLocals = List[(Local ILocalSymbol, Value ExpressionSyntax, Model SemanticModel)]()
            // Kind 0 stores a value in declared storage, 1 in an inferred local, 2
            // enumerates a value into a `foreach` variable, 3 types the lambda
            // parameters of a call, and 4 deconstructs element `Prefix` of a value
            // into an inferred local.
            let edges = List[
                (Destination ISymbol?, Value ExpressionSyntax, Model SemanticModel, Prefix string, Kind int32)
            ]()
            // Constructions and calls with stated type arguments, which can spell a
            // nullable position that no storage records.
            let spelledSites = List[(Site ExpressionSyntax, Model SemanticModel)]()
            let anonymousGroups = Dictionary[
                string,
                List[
                    (Creation AnonymousObjectCreationExpressionSyntax, Properties[]IPropertySymbol, Model SemanticModel)
                ]
            ](System.StringComparer.Ordinal)
            for tree in compilation.SyntaxTrees {
                let model = compilation.GetSemanticModel(tree)
                for node in tree.GetRoot().DescendantNodes() {
                    if node is AnonymousObjectCreationExpressionSyntax anonymousCreation && model.GetTypeInfo(
                        anonymousCreation
                    )
                        .Type is INamedTypeSymbol anonymousType {
                        let properties = anonymousType.GetMembers().OfType[IPropertySymbol]().ToArray()
                        let shapeKey = string.Join(
                            "|",
                            properties.Select(
                                (property IPropertySymbol) -> property.Name + ":" + property.Type.ToDisplayString(
                                    SymbolDisplayFormat.FullyQualifiedFormat
                                )
                            )
                        )
                        if !anonymousGroups.TryGetValue(shapeKey, out var group) {
                            group = List[
                                (
                                    Creation AnonymousObjectCreationExpressionSyntax,
                                    Properties[]IPropertySymbol,
                                    Model SemanticModel
                                )
                            ]()
                            anonymousGroups.Add(shapeKey, group)
                        }
                        group.Add((anonymousCreation, properties, model))
                    }
                    if node is AssignmentExpressionSyntax assignment {
                        if assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) {
                            let destination ISymbol? = model.GetSymbolInfo(assignment.Left).Symbol
                            if destination is ILocalSymbol {
                                assignedLocals.Add(destination)
                            }
                            edges.Add((destination, assignment.Right, model, "", 0))
                            // An implicitly typed deconstruction local takes the positions of
                            // its element of the value.
                            for (local, prefix) in InferredDeconstructionLocals(assignment, model) {
                                edges.Add((local, assignment.Right, model, prefix, 4))
                            }
                        }
                    } else if node is VariableDeclaratorSyntax{Initializer: {} declaratorInitializer} declarator {
                        let declared ISymbol? = model.GetDeclaredSymbol(declarator)
                        if declared is ILocalSymbol initializedLocal {
                            initializedLocals.Add((initializedLocal, declaratorInitializer.Value, model))
                        } else {
                            edges.Add((declared, declaratorInitializer.Value, model, "", 0))
                        }
                    } else if node is PropertyDeclarationSyntax{Initializer: {} propertyInitializer} property {
                        edges.Add((model.GetDeclaredSymbol(property), propertyInitializer.Value, model, "", 0))
                    } else if node is ArgumentSyntax argument {
                        let (parameter, prefix) = ArgumentDestination(argument, model)
                        if parameter != nil {
                            if !argument.RefKindKeyword.IsKind(SyntaxKind.None) &&
                                ArgumentStorageSymbol(argument.Expression, model) is ILocalSymbol refLocal {
                                assignedLocals.Add(refLocal)
                            }
                            edges.Add((parameter, argument.Expression, model, prefix, 0))
                        }
                        if (
                            argument.RefKindKeyword.IsKind(SyntaxKind.OutKeyword) || argument.RefKindKeyword.IsKind(
                                SyntaxKind.RefKeyword
                            )
                        ) &&
                            Unparenthesize(argument.Expression) is ElementAccessExpressionSyntax elementAccess &&
                            model.GetOperation(argument) is IArgumentOperation{Parameter: {} byRefParameter} &&
                            byRefParameter
                            .Type
                            .IsReferenceType &&
                            (
                            IsAnnotatedNullableReference(byRefParameter.Type) || this.ShouldPromoteToNullableReference(
                                byRefParameter
                            )
                        ) {
                            var target ExpressionSyntax = elementAccess
                            var accessPosition = ""
                            while target is ElementAccessExpressionSyntax currentAccess && model.GetTypeInfo(
                                currentAccess.Expression
                            )
                                .Type is IArrayTypeSymbol {
                                accessPosition = JoinPosition("0", accessPosition)
                                target = Unparenthesize(currentAccess.Expression)!!
                            }
                            if accessPosition != "" {
                                this.AddAliasedSourcePositions(
                                    flow,
                                    target,
                                    model,
                                    model.GetTypeInfo(target).Type,
                                    HashSet[string](System.StringComparer.Ordinal){accessPosition},
                                    compilation
                                )
                            }
                        }
                    } else if node is ReturnStatementSyntax{Expression: {} returned} {
                        let enclosing ISymbol? = model.GetEnclosingSymbol(returned.SpanStart)
                        edges.Add((ReturnDestination(enclosing), returned, model, ReturnPrefix(enclosing), 0))
                    } else if node is ArrowExpressionClauseSyntax arrow {
                        let enclosing ISymbol? = model.GetEnclosingSymbol(arrow.Expression.SpanStart)
                        edges.Add((ReturnDestination(enclosing), arrow.Expression, model, ReturnPrefix(enclosing), 0))
                    } else if node is ForEachStatementSyntax forEach {
                        edges.Add((model.GetDeclaredSymbol(forEach), forEach.Expression, model, "", 2))
                    }
                    if node is BaseObjectCreationExpressionSyntax spelledCreation &&
                        (
                        (spelledCreation.ArgumentList?.Arguments.Count ?? 0) > 0 || spelledCreation.Initializer != nil
                    ) {
                        spelledSites.Add((spelledCreation, model))
                    } else if node is InvocationExpressionSyntax spelledCall &&
                        HasExplicitTypeArguments(spelledCall.Expression) {
                        spelledSites.Add((spelledCall, model))
                    }
                    if (node is InvocationExpressionSyntax || node is BaseObjectCreationExpressionSyntax) &&
                        HasLambdaArgument(node) {
                        edges.Add((nil, cast[ExpressionSyntax](node), model, "", 3))
                    }
                }
            }
            // A local without a type clause takes the type of its initializer. It needs
            // declared storage only when it is also assigned.
            for (local, value, model) in initializedLocals {
                let statesType = LocalInitializerStatesType(local, model.GetTypeInfo(value).Type)
                edges.Add(
                    (
                        local,
                        value,
                        model,
                        "",
                        if statesType || assignedLocals.Contains(local) {
                            0
                        } else {
                            1
                        }
                    )
                )
            }
            let live = List[
                (Destination ISymbol?, Value ExpressionSyntax, Model SemanticModel, Prefix string, Kind int32)
            ]()
            for edge in edges {
                let keep = if edge.Kind == 0 {
                    edge.Destination != nil &&
                        IsObliviousContainerStorageCandidate(UnreducedDefinition(edge.Destination!!), compilation)
                } else if edge.Kind == 3 {
                    true
                } else {
                    edge.Destination is ILocalSymbol
                }
                if keep && CanCarryPositions(edge.Value) {
                    live.Add(edge)
                }
            }
            for group in anonymousGroups.Values {
                if group.Count < 2 {
                    continue
                }
                let propertyCount = group[0].Properties.Length
                for var index = 0; index < propertyCount; index++ {
                    let annotated = HashSet[string](System.StringComparer.Ordinal)
                    for item in group {
                        if index < item.Properties.Length {
                            CollectAnnotatedPositions(item.Properties[index].Type, "", annotated)
                        }
                    }
                    if annotated.Count == 0 {
                        continue
                    }
                    for item in group {
                        if index < item.Properties.Length && index < item.Creation.Initializers.Count {
                            this.AddAliasedSourcePositions(
                                flow,
                                item.Creation.Initializers[index].Expression,
                                item.Model,
                                item.Properties[index].Type,
                                annotated,
                                compilation
                            )
                        }
                    }
                }
            }
            // The positions only grow, and each storage has finitely many, so this
            // reaches a fixed point. The result does not depend on the edge order.
            var changed = true
            while changed {
                changed = false
                // A pass that changes the flow is followed by another pass, so a value
                // read before the change is read again with a fresh memo.
                flow.Memo = Dictionary[ExpressionSyntax, ObliviousPositionSet?]()
                for (destination, value, model, prefix, kind) in live {
                    if kind == 3 {
                        changed |= this.TypeObliviousLambdaParameters(value, model, flow)
                        continue
                    }
                    let positions = this.ConvertedObliviousPositionsOf(value, model, flow)
                    if positions == nil && flow.Destinations.Count == 0 {
                        continue
                    }
                    var original = UnreducedDefinition(destination!!)
                    let destinationType ITypeSymbol? = StorageType(original)
                    if kind == 0 {
                        let key ISymbol? = SignatureKey(flow, original, compilation)
                        if key == nil {
                            continue
                        }
                        original = key
                        // An expanded `params` argument is the element at position `0`,
                        // nil included, so a nil element passes through. An `async`
                        // result keeps its declared top level, as a return does.
                        if positions != nil {
                            let mapped = if prefix == "" {
                                MapToStorageType(StoredValueType(value, model), destinationType, positions)
                            } else if destination is IParameterSymbol {
                                Prefixed(positions, prefix)
                            } else {
                                Prefixed(WithoutTopLevel(positions) ?? ObliviousPositionSet(), prefix)
                            }
                            changed |= AddDeclaredPositions(flow, original, destinationType, mapped)
                        }
                        // A container is invariant in its element: storage whose value
                        // is stored as a whole in the same container shape states the
                        // same positions, so no conversion widens it (#4321).
                        if prefix == "" && flow.Destinations.TryGetValue(original, out var stored) {
                            changed |= this.AddAliasedSourcePositions(
                                flow,
                                value,
                                model,
                                destinationType,
                                stored,
                                compilation
                            )
                        } else if destination is IMethodSymbol && flow.Destinations.TryGetValue(
                            original,
                            out var storedResult
                        ) {
                            // An `async` method stores the returned value as its task's
                            // result, below position `0`.
                            let result = HashSet[string](System.StringComparer.Ordinal)
                            SubtreeInto(storedResult, prefix, result)
                            result.Remove("")
                            if result.Count > 0 {
                                changed |= this.AddAliasedSourcePositions(
                                    flow,
                                    value,
                                    model,
                                    PositionType(destinationType, prefix),
                                    result,
                                    compilation
                                )
                            }
                        }
                    } else {
                        // An inferred local, a `foreach` variable or a deconstruction
                        // local that is stored into declared storage gives its own
                        // source those positions.
                        if flow.Destinations.TryGetValue(original, out var storedLocal) {
                            if kind == 1 {
                                changed |= this.AddAliasedSourcePositions(
                                    flow,
                                    value,
                                    model,
                                    destinationType,
                                    storedLocal,
                                    compilation
                                )
                            } else if kind == 2 {
                                let collectionType ITypeSymbol? = StoredValueType(value, model)
                                let collectionPositions = CollectionPositionsForElement(
                                    collectionType,
                                    destinationType,
                                    storedLocal,
                                    compilation
                                )
                                if collectionPositions != nil {
                                    changed |= this.AddAliasedSourcePositions(
                                        flow,
                                        value,
                                        model,
                                        collectionType,
                                        collectionPositions,
                                        compilation
                                    )
                                }
                            } else if kind == 4 {
                                let tuplePositions = HashSet[string](System.StringComparer.Ordinal)
                                for position in storedLocal {
                                    tuplePositions.Add(JoinPosition(prefix, position))
                                }
                                changed |= this.AddAliasedSourcePositions(
                                    flow,
                                    value,
                                    model,
                                    StoredValueType(value, model),
                                    tuplePositions,
                                    compilation
                                )
                            }
                        }
                        if positions == nil {
                            continue
                        }
                        // A local whose C# type is not annotated gets a `!!` on its
                        // initializer (TranslateValueWithNullForgiveness), so only its
                        // nested positions follow the value. A deconstruction binding
                        // has no element initializer assertion, so it keeps the
                        // element's top level.
                        let source ObliviousPositionSet? = if kind == 4 {
                            Subtree(positions, prefix)
                        } else {
                            positions
                        }
                        let stored = if kind == 2 {
                            EnumeratedPositions(StoredValueType(value, model), positions, compilation)
                        } else if kind == 4 ||
                            (
                            kind == 1 &&
                                destinationType?.NullableAnnotation == Microsoft
                                .CodeAnalysis
                                .NullableAnnotation
                                .Annotated
                        ) {
                            source
                        } else {
                            WithoutTopLevel(source)
                        }
                        changed |= AddInferredPositions(flow, original, Filtered(destinationType, stored))
                        if kind == 2 &&
                            destination is ILocalSymbol loopLocal &&
                            ForEachStatesRangeType(loopLocal, model) {
                            changed |= AddDeclaredPositions(flow, original, destinationType, stored)
                        }
                        // Arms that give different positions have no common G# type,
                        // so the local states the merged type and each arm converts to it.
                        if kind == 1 && this.MergedArmsDiffer(value, model, flow) {
                            changed |= AddDeclaredPositions(
                                flow,
                                original,
                                destinationType,
                                MapToStorageType(StoredValueType(value, model), destinationType, positions)
                            )
                        }
                    }
                }
            }
            var spellsNullablePosition = false
            for (site, siteModel) in spelledSites {
                if this.SpellsNullablePosition(site, siteModel, flow) {
                    spellsNullablePosition = true
                    break
                }
            }
            flow.Memo = nil
            flow.Seal(spellsNullablePosition)
            return flow
        }

        // Whether a construction or a call with stated type arguments spells a nullable
        // position (PromoteObliviousContainerCreation, PromoteObliviousTypeArgument).
        private func SpellsNullablePosition(
            site ExpressionSyntax,
            model SemanticModel,
            flow ObliviousContainerFlow
        ) bool {
            if site is BaseObjectCreationExpressionSyntax creation {
                return this.ObliviousCreationPositions(creation, model, flow) != nil
            }
            if model.GetOperation(site) is not IInvocationOperation operation ||
                !operation
                .TargetMethod
                .IsGenericMethod {
                return false
            }
            let bindings = TypeParameterMap()
            this.InferObliviousTypeArguments(
                site,
                operation.TargetMethod.OriginalDefinition.TypeParameters,
                operation.Arguments,
                true,
                model,
                flow,
                bindings
            )
            return bindings.Values.Any((positions ObliviousPositionSet) -> positions.Nullable.Count > 0)
        }

        // Gives source storage that a value reads as a whole the positions of the
        // storage of the same container shape that receives it. Each arm of a
        // conditional, switch or coalescing value is such a read.
        private func AddAliasedSourcePositions(
            flow ObliviousContainerFlow,
            value ExpressionSyntax,
            model SemanticModel,
            destinationType ITypeSymbol?,
            positions HashSet[string],
            compilation Compilation
        ) bool {
            var read ExpressionSyntax? = Unparenthesize(value)
            while read is PostfixUnaryExpressionSyntax suppression && suppression.IsKind(
                SyntaxKind.SuppressNullableWarningExpression
            ) {
                read = Unparenthesize(suppression.Operand)
            }
            if read is ConditionalExpressionSyntax conditional {
                return this.AddAliasedSourcePositions(
                    flow,
                    conditional.WhenTrue,
                    model,
                    destinationType,
                    positions,
                    compilation
                ) |
                this.AddAliasedSourcePositions(
                    flow,
                    conditional.WhenFalse,
                    model,
                    destinationType,
                    positions,
                    compilation
                )
            }
            if read is BinaryExpressionSyntax coalesce && coalesce.IsKind(SyntaxKind.CoalesceExpression) {
                return this.AddAliasedSourcePositions(
                    flow,
                    coalesce.Left,
                    model,
                    destinationType,
                    positions,
                    compilation
                ) |
                this.AddAliasedSourcePositions(flow, coalesce.Right, model, destinationType, positions, compilation)
            }
            if read is SwitchExpressionSyntax switchExpression {
                var changed = false
                for arm in switchExpression.Arms {
                    changed |= this.AddAliasedSourcePositions(
                        flow,
                        arm.Expression,
                        model,
                        destinationType,
                        positions,
                        compilation
                    )
                }
                return changed
            }
            if read is TupleExpressionSyntax tuple {
                var tupleChanged = false
                for var i = 0; i < tuple.Arguments.Count; i++ {
                    let element = HashSet[string](System.StringComparer.Ordinal)
                    SubtreeInto(positions, TupleElementPosition(i), element)
                    element.Remove("")
                    if element.Count > 0 {
                        tupleChanged |= this.AddAliasedSourcePositions(
                            flow,
                            tuple.Arguments[i].Expression,
                            model,
                            TupleElementType(destinationType, i),
                            element,
                            compilation
                        )
                    }
                }
                return tupleChanged
            }
            if read != nil && IsElementLiteral(read) && ElementIsPositionZero(destinationType) {
                let element = HashSet[string](System.StringComparer.Ordinal)
                SubtreeInto(positions, "0", element)
                element.Remove("")
                if element.Count == 0 {
                    return false
                }
                let elementType ITypeSymbol? = PositionType(destinationType, "0")
                var literalChanged = false
                let initializer InitializerExpressionSyntax? = switch read {
                    case explicitArray is ArrayCreationExpressionSyntax: explicitArray.Initializer
                    case implicitArray is ImplicitArrayCreationExpressionSyntax: implicitArray.Initializer
                    case bare is InitializerExpressionSyntax: bare
                    default: default(InitializerExpressionSyntax?)
                }
                if initializer != nil {
                    for item in ArrayInitializerLeaves(initializer, destinationType) {
                        literalChanged |= this.AddAliasedSourcePositions(
                            flow,
                            item,
                            model,
                            elementType,
                            element,
                            compilation
                        )
                    }
                }
                if read is CollectionExpressionSyntax collection {
                    for item in collection.Elements {
                        if item is ExpressionElementSyntax expressionElement {
                            literalChanged |= this.AddAliasedSourcePositions(
                                flow,
                                expressionElement.Expression,
                                model,
                                elementType,
                                element,
                                compilation
                            )
                        } else if item is SpreadElementSyntax spread {
                            let spreadType ITypeSymbol? = StoredValueType(spread.Expression, model)
                            let spreadPositions = CollectionPositionsForElement(
                                spreadType,
                                elementType,
                                element,
                                compilation
                            )
                            if spreadPositions != nil {
                                literalChanged |= this.AddAliasedSourcePositions(
                                    flow,
                                    spread.Expression,
                                    model,
                                    spreadType,
                                    spreadPositions,
                                    compilation
                                )
                            }
                        }
                    }
                }
                return literalChanged
            }
            if !(
                read is IdentifierNameSyntax ||
                    read is DeclarationExpressionSyntax ||
                    read is MemberAccessExpressionSyntax ||
                    read is InvocationExpressionSyntax
            ) {
                return false
            }
            if read is InvocationExpressionSyntax call && model.GetOperation(call) is IInvocationOperation operation &&
                operation
                .TargetMethod
                .IsGenericMethod &&
                MentionsTypeParameter(operation.TargetMethod.OriginalDefinition.ReturnType) {
                let definition = operation.TargetMethod.OriginalDefinition
                let carried = ObliviousPositionSet()
                carried.Nullable.UnionWith(positions)
                let bindings = TypeParameterMap()
                Unify(definition.ReturnType, operation.TargetMethod.ReturnType, carried, bindings)
                for parameter in definition.TypeParameters {
                    if bindings.TryGetValue(parameter, out var bound) &&
                        NullableTypeArgumentViolatesTranslatedConstraints(parameter) {
                        bound.Nullable.Remove("")
                        bound.Platform.Remove("")
                    }
                }
                if bindings.Count > 0 {
                    var callChanged = false
                    for argument in operation.Arguments {
                        let argumentParameter IParameterSymbol? = argument.Parameter
                        if argumentParameter == nil ||
                            argument.ArgumentKind == ArgumentKind.DefaultValue ||
                            !MentionsTypeParameter(argumentParameter.OriginalDefinition.Type) {
                            continue
                        }
                        let argPositions = ObliviousPositionSet()
                        Substitute(argumentParameter.OriginalDefinition.Type, bindings, "", argPositions)
                        argPositions.Nullable.Remove("")
                        if argPositions.Nullable.Count == 0 {
                            continue
                        }
                        if argument.ArgumentKind == ArgumentKind.ParamArray {
                            if argumentParameter.Type is IArrayTypeSymbol arrayParameter &&
                                argument.Value is IArrayCreationOperation{Initializer: {} paramInitializer} {
                                let element = HashSet[string](System.StringComparer.Ordinal)
                                SubtreeInto(argPositions.Nullable, "0", element)
                                element.Remove("")
                                if element.Count > 0 {
                                    for item in paramInitializer.ElementValues {
                                        if ArgumentValueSyntax(item) is {} elementValue &&
                                            IsWrittenIn(call, elementValue) {
                                            callChanged |= this.AddAliasedSourcePositions(
                                                flow,
                                                elementValue,
                                                model,
                                                arrayParameter.ElementType,
                                                element,
                                                compilation
                                            )
                                        }
                                    }
                                }
                            }
                            continue
                        }
                        if ArgumentValueSyntax(argument.Value) is {} argumentValue && IsWrittenIn(call, argumentValue) {
                            callChanged |= this.AddAliasedSourcePositions(
                                flow,
                                argumentValue,
                                model,
                                argumentParameter.Type,
                                argPositions.Nullable,
                                compilation
                            )
                        }
                    }
                    if callChanged {
                        return true
                    }
                }
            }
            let symbol ISymbol? = ArgumentStorageSymbol(read!!, model)
            if symbol == nil || (symbol is IMethodSymbol && !(read is InvocationExpressionSyntax)) {
                return false
            }
            let source = UnreducedDefinition(symbol)
            if !IsObliviousContainerStorageCandidate(source, compilation) ||
                !SameContainerShape(StorageType(source), destinationType) {
                return false
            }
            let key ISymbol? = SignatureKey(flow, source, compilation)
            if key == nil {
                return false
            }
            let carried = ObliviousPositionSet()
            carried.Nullable.UnionWith(positions)
            return AddDeclaredPositions(flow, key, StorageType(key), carried)
        }

        // Whether the arms of a conditional, switch or coalescing value give different
        // nested positions.
        private func MergedArmsDiffer(value ExpressionSyntax, model SemanticModel, flow ObliviousContainerFlow) bool {
            let merged ExpressionSyntax? = Unparenthesize(value)
            let arms = List[ExpressionSyntax]()
            if merged is ConditionalExpressionSyntax conditional {
                arms.Add(conditional.WhenTrue)
                arms.Add(conditional.WhenFalse)
            } else if merged is BinaryExpressionSyntax coalesce && coalesce.IsKind(SyntaxKind.CoalesceExpression) {
                arms.Add(coalesce.Left)
                arms.Add(coalesce.Right)
            } else if merged is SwitchExpressionSyntax switchExpression {
                for arm in switchExpression.Arms {
                    arms.Add(arm.Expression)
                }
            }
            var first ObliviousPositionSet? = nil
            for var i = 0; i < arms.Count; i++ {
                let positions = WithoutTopLevel(this.ObliviousPositionsOf(arms[i], model, flow)) ??
                    ObliviousPositionSet()
                if i == 0 {
                    first = positions
                } else if !first!!.Nullable.SetEquals(positions.Nullable) || !first!!.Platform.SetEquals(
                    positions.Platform
                ) {
                    return true
                }
            }
            return false
        }

        // Gives each lambda parameter of a generic call the positions that the
        // receiver and the other arguments give its delegate parameter type. G# states
        // a lambda parameter type, so the parameter is declared storage.
        private func TypeObliviousLambdaParameters(
            call ExpressionSyntax,
            model SemanticModel,
            flow ObliviousContainerFlow
        ) bool {
            let operation IOperation? = model.GetOperation(call)
            var arguments = System.Collections.Immutable.ImmutableArray[IArgumentOperation].Empty
            let bindings = TypeParameterMap()
            if operation is IInvocationOperation invocation {
                arguments = invocation.Arguments
                let method = invocation.TargetMethod
                let instance IOperation? = invocation.Instance
                let containingType INamedTypeSymbol? = method.ContainingType
                if instance != nil && !instance.IsImplicit && containingType != nil {
                    let receiver ExpressionSyntax? = instance.Syntax as ExpressionSyntax
                    let receiverPositions = this.ObliviousPositionsOf(receiver, model, flow)
                    if receiverPositions != nil {
                        Unify(containingType.OriginalDefinition, instance.Type, receiverPositions, bindings)
                    }
                }
                if method.IsGenericMethod {
                    this.InferObliviousTypeArguments(
                        call,
                        method.OriginalDefinition.TypeParameters,
                        arguments,
                        call is InvocationExpressionSyntax syntax && HasExplicitTypeArguments(syntax.Expression),
                        model,
                        flow,
                        bindings
                    )
                }
            } else if operation is IObjectCreationOperation creation && creation.Type is INamedTypeSymbol created {
                arguments = creation.Arguments
                let stated = this.EffectiveCreationPositions(call, created, model, flow)
                let parameters = FlatTypeArguments(created.OriginalDefinition)
                for var i = 0; i < parameters.Count; i++ {
                    if parameters[i] is ITypeParameterSymbol parameter {
                        let bound = Subtree(stated, IndexPosition(i))
                        if NullableTypeArgumentViolatesTranslatedConstraints(parameter) {
                            bound.Nullable.Remove("")
                            bound.Platform.Remove("")
                        }
                        if !bound.IsEmpty {
                            AddTypeParameterPositions(bindings, parameter, bound)
                        }
                    }
                }
            }
            if bindings.Count == 0 {
                return false
            }
            var changed = false
            for argument in arguments {
                let argumentParameter IParameterSymbol? = argument.Parameter
                if argumentParameter == nil ||
                    ArgumentValueSyntax(argument.Value) is not AnonymousFunctionExpressionSyntax lambda ||
                    model
                    .GetSymbolInfo(lambda).Symbol is not IMethodSymbol lambdaMethod {
                    continue
                }
                let invoke IMethodSymbol? = (
                    argumentParameter.OriginalDefinition.Type as INamedTypeSymbol
                )?.DelegateInvokeMethod
                if invoke == nil {
                    continue
                }
                for var i = 0; i < lambdaMethod.Parameters.Length && i < invoke.Parameters.Length; i++ {
                    let substituted = ObliviousPositionSet()
                    Substitute(invoke.Parameters[i].Type, bindings, "", substituted)
                    let lambdaParameter = lambdaMethod.Parameters[i]
                    let positions = HashSet[string](System.StringComparer.Ordinal)
                    for position in substituted.Nullable {
                        if position == "" &&
                            IsNonNullReferencePosition(lambdaParameter.Type) ||
                            position != "" &&
                            IsPromotablePosition(lambdaParameter.Type, position) {
                            positions.Add(position)
                        }
                    }
                    let declaration SyntaxNode? = lambdaParameter
                        .DeclaringSyntaxReferences
                        .FirstOrDefault()
                        ?.GetSyntax()
                    if positions.Count > 0 && declaration != nil {
                        changed |= AddLambdaParameterPositions(flow, declaration, positions)
                    }
                }
            }
            return changed
        }

        // The positions of an element literal: each element's positions below position
        // `0`, and each spread element's positions below its own position `0`.
        private func ObliviousLiteralPositions(
            literal ExpressionSyntax,
            model SemanticModel,
            flow ObliviousContainerFlow
        ) ObliviousPositionSet? {
            let literalType ITypeSymbol? = ElementLiteralType(literal, model)
            if !ElementIsPositionZero(literalType) {
                return nil
            }
            let initializer InitializerExpressionSyntax? = switch literal {
                case explicitArray is ArrayCreationExpressionSyntax: explicitArray.Initializer
                case implicitArray is ImplicitArrayCreationExpressionSyntax: implicitArray.Initializer
                case bare is InitializerExpressionSyntax: bare
                default: default(InitializerExpressionSyntax?)
            }
            let positions = ObliviousPositionSet()
            if initializer != nil {
                for element in ArrayInitializerLeaves(initializer, literalType) {
                    this.AddLiteralElementPositions(element, false, model, flow, positions)
                }
            }
            if literal is CollectionExpressionSyntax collection {
                for element in collection.Elements {
                    if element is ExpressionElementSyntax expressionElement {
                        this.AddLiteralElementPositions(expressionElement.Expression, false, model, flow, positions)
                    } else if element is SpreadElementSyntax spread {
                        this.AddLiteralElementPositions(spread.Expression, true, model, flow, positions)
                    }
                }
            }
            return Filtered(literalType, positions)
        }

        private func AddLiteralElementPositions(
            element ExpressionSyntax,
            spread bool,
            model SemanticModel,
            flow ObliviousContainerFlow,
            positions ObliviousPositionSet
        ) {
            let elementPositions = this.ConvertedObliviousPositionsOf(element, model, flow)
            if elementPositions == nil {
                return
            }
            if !spread {
                positions.UnionWith(Prefixed(elementPositions, "0"))
            } else if ElementIsPositionZero(model.GetTypeInfo(element).Type) {
                positions.UnionWith(Prefixed(Subtree(elementPositions, "0"), "0"))
            }
        }

        shared {
            private let ObliviousContainerFlowCache ConditionalWeakTable[
                Compilation,
                ObliviousContainerFlow
            ] = ConditionalWeakTable[Compilation, ObliviousContainerFlow]()

            // The declared positions of storage. A lambda parameter is found by its
            // declaration.
            private func DeclaredPositions(flow ObliviousContainerFlow, symbol ISymbol?) HashSet[string]? {
                if symbol == nil {
                    return nil
                }
                if symbol is IParameterSymbol parameter &&
                    parameter.ContainingSymbol is IMethodSymbol owner &&
                    owner.MethodKind == MethodKind
                    .AnonymousFunction {
                    let declaration SyntaxNode? = parameter.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                    return if declaration != nil && flow.LambdaParameters.TryGetValue(
                        declaration,
                        out var lambdaPositions
                    ) {
                        lambdaPositions
                    } else {
                        nil
                    }
                }
                let unreduced = UnreducedDefinition(symbol)
                let key ISymbol? = SignatureKey(flow, unreduced, nil)
                return if key != nil && flow.Destinations.TryGetValue(key, out var positions) {
                    positions
                } else {
                    nil
                }
            }

            // The storage that records the positions of [`symbol`](paramref): the
            // group member that stands for an overriding or implementing member, or nil
            // when the group cannot change its signature. A nil
            // [`compilation`](paramref) asks without building the groups.
            private func SignatureKey(flow ObliviousContainerFlow, symbol ISymbol, compilation Compilation?) ISymbol? {
                if symbol.DeclaringSyntaxReferences.IsDefaultOrEmpty {
                    return nil
                }
                let owner ISymbol? = if symbol is IParameterSymbol parameter {
                    parameter.ContainingSymbol
                } else {
                    symbol
                }
                // The analysis builds the groups before any method, property or
                // parameter receives positions, so without groups none holds any.
                if !(owner is IMethodSymbol || owner is IPropertySymbol) || (flow.Groups == nil && compilation == nil) {
                    return symbol
                }
                if flow.Groups == nil {
                    flow.Groups = ObliviousSignatureGroups(compilation!!)
                }
                let groups = flow.Groups!!
                let root = groups.Find(owner!!)
                let ordinal = if symbol is IParameterSymbol ordered {
                    ordered.Ordinal
                } else {
                    -1
                }
                let type ITypeSymbol? = StorageType(symbol)
                var key ISymbol? = nil
                for member in groups.Members(root) {
                    let memberStorage ISymbol? = GroupStorage(member, ordinal)
                    if memberStorage == nil || !SymbolEqualityComparer.Default.Equals(
                        StorageType(memberStorage),
                        type
                    ) {
                        return nil
                    }
                    if !memberStorage.DeclaringSyntaxReferences.IsDefaultOrEmpty {
                        if compilation != nil && !SymbolEqualityComparer.Default.Equals(
                            memberStorage.ContainingAssembly,
                            compilation.Assembly
                        ) {
                            return nil
                        }
                        key ??= memberStorage
                    }
                }
                return key
            }

            // The return, property or parameter of a group member.
            private func GroupStorage(member ISymbol, ordinal int32) ISymbol? {
                if ordinal < 0 {
                    return member
                }
                let parameters = switch member {
                    case method is IMethodSymbol: method.Parameters
                    case property is IPropertySymbol: property.Parameters
                    default: System.Collections.Immutable.ImmutableArray[IParameterSymbol].Empty
                }
                return if ordinal < parameters.Length {
                    parameters[ordinal]
                } else {
                    nil
                }
            }

            private func AddLambdaParameterPositions(
                flow ObliviousContainerFlow,
                declaration SyntaxNode,
                positions HashSet[string]
            ) bool {
                if flow.LambdaParameters.TryGetValue(declaration, out var existing) {
                    let count = existing.Count
                    existing.UnionWith(positions)
                    return existing.Count > count
                }
                flow.LambdaParameters.Add(declaration, HashSet[string](positions, System.StringComparer.Ordinal))
                return true
            }

            // The generic definition of a member: an extension method's unreduced form,
            // an indexer accessor's implicit key parameter mapped to the property's
            // parameter, a setter or init accessor's implicit `value` parameter mapped
            // to its property, and a named tuple element's `ItemN` field.
            private func UnreducedDefinition(symbol ISymbol) ISymbol {
                if symbol is IMethodSymbol method {
                    return method.ReducedFrom?.OriginalDefinition ?? method.OriginalDefinition
                }
                if symbol is IParameterSymbol parameter &&
                    parameter.IsImplicitlyDeclared &&
                    parameter.ContainingSymbol is IMethodSymbol accessor &&
                    accessor.AssociatedSymbol is IPropertySymbol property {
                    let parameters = property.OriginalDefinition.Parameters
                    if parameter.Ordinal < parameters.Length {
                        return parameters[parameter.Ordinal]
                    }
                    if accessor.MethodKind == MethodKind.PropertySet {
                        return property.OriginalDefinition
                    }
                }
                if symbol is IFieldSymbol{CorrespondingTupleField: {} tupleField} {
                    return tupleField.OriginalDefinition
                }
                return symbol.OriginalDefinition
            }

            private func TypeParameterMap() Dictionary[ITypeParameterSymbol, ObliviousPositionSet] -> Dictionary[
                ITypeParameterSymbol,
                ObliviousPositionSet
            ](SymbolEqualityComparer.Default)

            private func AddTypeParameterPositions(
                bindings Dictionary[ITypeParameterSymbol, ObliviousPositionSet],
                parameter ITypeParameterSymbol,
                positions ObliviousPositionSet
            ) {
                if !bindings.TryGetValue(parameter, out var existing) {
                    existing = ObliviousPositionSet()
                    bindings.Add(parameter, existing)
                }
                existing.UnionWith(positions)
            }

            // The value that an argument or array element passes, without the implicit
            // conversion to the parameter type.
            private func ArgumentValueSyntax(operation IOperation?) ExpressionSyntax? {
                var current IOperation? = operation
                while current is IConversionOperation conversion && conversion.IsImplicit {
                    current = conversion.Operand
                }
                if current is IDelegateCreationOperation delegateCreation && delegateCreation.IsImplicit {
                    current = delegateCreation.Target
                }
                return current?.Syntax as ExpressionSyntax
            }

            // The parameter that an argument writes, and the position of the argument in
            // it: an expanded `params` argument is position `0` of the parameter.
            private func ArgumentDestination(argument ArgumentSyntax, model SemanticModel)(
                Parameter IParameterSymbol?,
                Prefix string
            ) {
                if model.GetOperation(argument) is IArgumentOperation{Parameter: {} parameter} operation {
                    return (
                        parameter,
                        if operation.ArgumentKind == ArgumentKind.ParamArray {
                            "0"
                        } else {
                            ""
                        }
                    )
                }
                var current IOperation? = model.GetOperation(argument.Expression)
                while current?.Parent is IConversionOperation conversion && conversion.IsImplicit {
                    current = conversion
                }
                if current?.Parent is IArrayInitializerOperation initializer &&
                    initializer.Parent is IArrayCreationOperation creation &&
                    creation.IsImplicit &&
                    creation.Parent is IArgumentOperation{Parameter: {} expanded} expandedArgument &&
                    expandedArgument.ArgumentKind == ArgumentKind.ParamArray {
                    return (expanded, "0")
                }
                return (nil, "")
            }

            // The values that an object or collection initializer writes, with the type
            // of the slot each one fills in the declaring definition's terms.
            private func InitializerWrites(initializer InitializerExpressionSyntax, model SemanticModel) List[
                (Pattern ITypeSymbol, Value ExpressionSyntax)
            ] {
                let writes = List[(Pattern ITypeSymbol, Value ExpressionSyntax)]()
                for expression in initializer.Expressions {
                    if expression is AssignmentExpressionSyntax memberWrite {
                        let memberType ITypeSymbol? = StorageType(
                            model.GetSymbolInfo(memberWrite.Left).Symbol?.OriginalDefinition
                        )
                        if memberType != nil {
                            writes.Add((memberType, memberWrite.Right))
                        }
                        continue
                    }
                    if !initializer.IsKind(SyntaxKind.CollectionInitializerExpression) ||
                        model
                        .GetCollectionInitializerSymbolInfo(expression)
                        .Symbol is not IMethodSymbol add ||
                        add.IsExtensionMethod {
                        continue
                    }
                    let values = if expression is InitializerExpressionSyntax complex {
                        complex.Expressions.ToList()
                    } else {
                        List[ExpressionSyntax]{expression}
                    }
                    let parameters = add.OriginalDefinition.Parameters
                    for var i = 0; i < values.Count && i < parameters.Length; i++ {
                        writes.Add((parameters[i].Type, values[i]))
                    }
                }
                return writes
            }

            // The receiver of a member access, an element access or a call through one:
            // the expression before `.` or `[`, the receiver of a conditional access for
            // `?.member` and `?[index]`, and the construction for an object initializer's
            // `[index] = value`.
            private func MemberReceiver(access ExpressionSyntax?) ExpressionSyntax? {
                switch access {
                    case invocation is InvocationExpressionSyntax {
                        return switch invocation.Expression {
                            case target is MemberAccessExpressionSyntax: target.Expression
                            case binding is MemberBindingExpressionSyntax: ConditionalReceiver(binding)
                            default: default(ExpressionSyntax?)
                        }
                    }
                    case elementAccess is ElementAccessExpressionSyntax {
                        return elementAccess.Expression
                    }
                    case memberAccess is MemberAccessExpressionSyntax {
                        return memberAccess.Expression
                    }
                    case elementBinding is ElementBindingExpressionSyntax {
                        return ConditionalReceiver(elementBinding)
                    }
                    case memberBinding is MemberBindingExpressionSyntax {
                        return ConditionalReceiver(memberBinding)
                    }
                    case implicitAccess is ImplicitElementAccessSyntax {
                        return if implicitAccess.Parent is AssignmentExpressionSyntax{
                            Parent: InitializerExpressionSyntax{Parent: BaseObjectCreationExpressionSyntax creation}
                        } {
                            creation
                        } else {
                            default(ExpressionSyntax?)
                        }
                    }
                    default {
                        return nil
                    }
                }
            }

            // The receiver that a `?.` or `?[` binding reads: the expression of the
            // nearest conditional access whose bound part holds the binding.
            private func ConditionalReceiver(binding ExpressionSyntax) ExpressionSyntax? {
                var node SyntaxNode? = binding.Parent
                while node != nil {
                    if node is ConditionalAccessExpressionSyntax conditional &&
                        conditional
                        .WhenNotNull
                        .Span
                        .Contains(binding.Span) {
                        return conditional.Expression
                    }
                    node = node.Parent
                }
                return nil
            }

            // The type of element [`index`](paramref) of a tuple type, or nil.
            private func TupleElementType(
                type ITypeSymbol?,
                index int32
            ) ITypeSymbol? -> if type is INamedTypeSymbol tupleType &&
                tupleType.IsTupleType &&
                index >= 0 &&
                index < tupleType
                .TupleElements
                .Length {
                tupleType.TupleElements[index].Type
            } else {
                nil
            }

            // The type at the nested tuple element path [`indices`](paramref), or nil.
            private func NestedTupleElementType(type ITypeSymbol?, indices List[int32]) ITypeSymbol? {
                var current ITypeSymbol? = type
                for step in indices {
                    current = TupleElementType(current, step)
                    if current == nil {
                        return nil
                    }
                }
                return current
            }

            // The target expression at the nested tuple element path [`indices`](paramref),
            // or nil.
            private func ResolveDeconstructedTupleTarget(
                target ExpressionSyntax,
                indices List[int32],
                depth int32
            ) ExpressionSyntax? {
                let unwrapped = Unparenthesize(target)!!
                if depth >= indices.Count {
                    return unwrapped
                }
                if unwrapped is not TupleExpressionSyntax tupleTargets {
                    return nil
                }
                let arguments = tupleTargets.Arguments
                let step = indices[depth]
                if step < 0 || step >= arguments.Count {
                    return nil
                }
                return ResolveDeconstructedTupleTarget(arguments[step].Expression, indices, depth + 1)
            }

            private func CollectTupleAncestors(tuple TupleExpressionSyntax, indices List[int32]) TupleExpressionSyntax {
                let unwrapped = UnwrapParenthesizedAncestors(tuple)
                if unwrapped.Parent is ArgumentSyntax{Parent: TupleExpressionSyntax outerTuple} outerArgument {
                    indices.Insert(0, outerTuple.Arguments.IndexOf(outerArgument))
                    return CollectTupleAncestors(outerTuple, indices)
                }
                return tuple
            }

            private func UnwrapParenthesizedAncestors(expression ExpressionSyntax) ExpressionSyntax {
                if expression.Parent is ParenthesizedExpressionSyntax parenthesized {
                    return UnwrapParenthesizedAncestors(parenthesized)
                }
                return expression
            }

            private func EnclosingArrayLiteral(
                initializer InitializerExpressionSyntax,
                depth int32,
                model SemanticModel
            ) ExpressionSyntax {
                if initializer.Parent is InitializerExpressionSyntax outerInitializer && outerInitializer.IsKind(
                    SyntaxKind.ArrayInitializerExpression
                ) {
                    var outerEnclosing ExpressionSyntax = outerInitializer
                    if outerInitializer.Parent is ArrayCreationExpressionSyntax ||
                        outerInitializer.Parent is ImplicitArrayCreationExpressionSyntax {
                        outerEnclosing = cast[ExpressionSyntax](outerInitializer.Parent)
                    }
                    if ElementLiteralType(outerEnclosing, model) is IArrayTypeSymbol outerArray &&
                        outerArray.Rank > depth {
                        return EnclosingArrayLiteral(outerInitializer, depth + 1, model)
                    }
                }
                if initializer.Parent is ArrayCreationExpressionSyntax ||
                    initializer.Parent is ImplicitArrayCreationExpressionSyntax {
                    return cast[ExpressionSyntax](initializer.Parent)
                }
                return initializer
            }

            // The scalar leaf expressions of an array initializer, flattened across all
            // dimensions of a rectangular array.
            private func ArrayInitializerLeaves(
                initializer InitializerExpressionSyntax,
                arrayOrCollectionType ITypeSymbol?
            ) List[ExpressionSyntax] {
                let rank = if arrayOrCollectionType is IArrayTypeSymbol arrayType && arrayType.Rank > 1 {
                    arrayType.Rank
                } else {
                    1
                }
                let leaves = List[ExpressionSyntax]()
                CollectArrayInitializerLeaves(initializer, 0, rank, leaves)
                return leaves
            }

            private func CollectArrayInitializerLeaves(
                initializer InitializerExpressionSyntax,
                level int32,
                rank int32,
                leaves List[ExpressionSyntax]
            ) {
                if level + 1 >= rank {
                    for expression in initializer.Expressions {
                        leaves.Add(expression)
                    }
                    return
                }
                for child in initializer.Expressions {
                    if child is InitializerExpressionSyntax childInitializer {
                        CollectArrayInitializerLeaves(childInitializer, level + 1, rank, leaves)
                    }
                }
            }

            // Whether a `foreach` statement emits an explicit range type for its loop
            // variable (`!forEach.Type.IsVar && !forEachInfo.ElementConversion.IsIdentity`).
            private func ForEachStatesRangeType(local ILocalSymbol, model SemanticModel) bool {
                for reference in local.DeclaringSyntaxReferences {
                    if reference.GetSyntax() is ForEachStatementSyntax forEach {
                        let forEachInfo = model.GetForEachStatementInfo(forEach)
                        return !forEach.Type.IsVar && !forEachInfo.ElementConversion.IsIdentity
                    }
                }
                return false
            }

            // Issue #5541: an array literal (explicit, implicit or a bare array
            // initializer) or a collection expression. Its element type is position `0`
            // of its type, and its elements and spread elements give that position's
            // subtree.
            private func IsElementLiteral(value ExpressionSyntax) bool -> value is ArrayCreationExpressionSyntax{
                Initializer: {}
            } ||
                value is ImplicitArrayCreationExpressionSyntax ||
                value is CollectionExpressionSyntax ||
                value.IsKind(SyntaxKind.ArrayInitializerExpression)

            // The type of an element literal: an array construction states its own, and a
            // bare initializer or a collection expression takes its target's.
            private func ElementLiteralType(literal ExpressionSyntax, model SemanticModel) ITypeSymbol? {
                let info = model.GetTypeInfo(literal)
                return if literal is ArrayCreationExpressionSyntax || literal is ImplicitArrayCreationExpressionSyntax {
                    info.Type
                } else {
                    info.ConvertedType ?? info.Type
                }
            }

            // The type of a value that is stored: an element literal's own type (a bare
            // initializer or a collection expression has only its target's).
            private func StoredValueType(
                value ExpressionSyntax,
                model SemanticModel
            ) ITypeSymbol? -> if IsElementLiteral(value) {
                ElementLiteralType(value, model)
            } else if Unparenthesize(value) is DeclarationExpressionSyntax declaration {
                StorageType(ArgumentStorageSymbol(declaration, model)) ?? model.GetTypeInfo(declaration.Type).Type
            } else {
                model.GetTypeInfo(value).Type
            }

            private func ArgumentStorageSymbol(expression ExpressionSyntax?, model SemanticModel) ISymbol? {
                let unwrapped = Unparenthesize(expression)
                if unwrapped is DeclarationExpressionSyntax{Designation: SingleVariableDesignationSyntax designation} {
                    return model.GetDeclaredSymbol(designation)
                }
                return if unwrapped != nil {
                    model.GetSymbolInfo(unwrapped).Symbol
                } else {
                    nil
                }
            }

            // Whether position `0` of [`type`](paramref) is the element of a literal or a
            // spread of that type: an array, or a generic type whose one type argument is
            // its collection element (`List[T]`, `Span[T]`, `IEnumerable[T]`).
            private func ElementIsPositionZero(type ITypeSymbol?) bool {
                if type is IArrayTypeSymbol {
                    return true
                }
                return type is INamedTypeSymbol named && named.TypeArguments.Length == 1 && FlatTypeArguments(
                    named
                ).Count == 1 &&
                    SymbolEqualityComparer
                    .Default
                    .Equals(GetCollectionElementTypeSymbol(named), named.TypeArguments[0])
            }

            // Whether [`value`](paramref) is written inside the call, not the call.
            private func IsWrittenIn(call SyntaxNode, value ExpressionSyntax?) bool -> value != nil &&
                value.SyntaxTree == call.SyntaxTree &&
                call
                .Span
                .Contains(value.Span) && value.Span.Length < call.Span.Length

            private func HasLambdaArgument(node SyntaxNode) bool {
                let list ArgumentListSyntax? = switch node {
                    case invocation is InvocationExpressionSyntax: invocation.ArgumentList
                    case creation is BaseObjectCreationExpressionSyntax: creation.ArgumentList
                    default: default(ArgumentListSyntax?)
                }
                if list == nil {
                    return false
                }
                for argument in list.Arguments {
                    if Unparenthesize(argument.Expression) is AnonymousFunctionExpressionSyntax {
                        return true
                    }
                }
                return false
            }

            // The values that a lambda returns.
            private func LambdaResults(lambda AnonymousFunctionExpressionSyntax) List[ExpressionSyntax] {
                let results = List[ExpressionSyntax]()
                if lambda.ExpressionBody != nil {
                    results.Add(lambda.ExpressionBody)
                    return results
                }
                let block BlockSyntax? = lambda.Block
                if block == nil {
                    return results
                }
                for returned in block.DescendantNodes(
                    (node SyntaxNode) -> !(
                        node is AnonymousFunctionExpressionSyntax || node is LocalFunctionStatementSyntax
                    )
                )
                    .OfType[ReturnStatementSyntax]() {
                    if returned.Expression != nil {
                        results.Add(returned.Expression)
                    }
                }
                return results
            }

            // The implicitly typed locals that the deconstruction [`assignment`](paramref)
            // declares, with the dotted element position each one takes: `var (a, b) = v`,
            // `(var a, var b) = v` and nested designations or tuple targets. A typed
            // target is not listed.
            private func InferredDeconstructionLocals(assignment AssignmentExpressionSyntax, model SemanticModel) List[
                (Local ILocalSymbol, Prefix string)
            ] {
                let locals = List[(Local ILocalSymbol, Prefix string)]()
                CollectInferredDeconstructionLocals(assignment.Left, "", model, locals)
                return locals
            }

            private func CollectInferredDeconstructionLocals(
                target ExpressionSyntax,
                prefix string,
                model SemanticModel,
                locals List[(Local ILocalSymbol, Prefix string)]
            ) {
                if target is DeclarationExpressionSyntax declaration && declaration.Type.IsVar {
                    CollectInferredDesignationLocals(declaration.Designation, prefix, model, locals)
                } else if target is TupleExpressionSyntax targets {
                    for var i = 0; i < targets.Arguments.Count; i++ {
                        CollectInferredDeconstructionLocals(
                            targets.Arguments[i].Expression,
                            JoinPosition(prefix, TupleElementPosition(i)),
                            model,
                            locals
                        )
                    }
                }
            }

            private func CollectInferredDesignationLocals(
                designation VariableDesignationSyntax,
                prefix string,
                model SemanticModel,
                locals List[(Local ILocalSymbol, Prefix string)]
            ) {
                if designation is SingleVariableDesignationSyntax single && prefix != "" && model.GetDeclaredSymbol(
                    single
                ) is ILocalSymbol local {
                    locals.Add((local, prefix))
                } else if designation is ParenthesizedVariableDesignationSyntax designations {
                    for var i = 0; i < designations.Variables.Count; i++ {
                        CollectInferredDesignationLocals(
                            designations.Variables[i],
                            JoinPosition(prefix, TupleElementPosition(i)),
                            model,
                            locals
                        )
                    }
                }
            }

            // Whether the element access or binding [`access`](paramref) takes one
            // `System.Range` argument: a slice, not an element.
            private func IsRangeElementArguments(access ExpressionSyntax, model SemanticModel) bool {
                let arguments BracketedArgumentListSyntax? = switch access {
                    case elementAccess is ElementAccessExpressionSyntax: elementAccess.ArgumentList
                    case elementBinding is ElementBindingExpressionSyntax: elementBinding.ArgumentList
                    default: default(BracketedArgumentListSyntax?)
                }
                let rangeType ITypeSymbol? = model.Compilation.GetTypeByMetadataName("System.Range")
                return arguments != nil &&
                    rangeType != nil &&
                    arguments
                    .Arguments
                    .Count == 1 &&
                    SymbolEqualityComparer
                    .Default
                    .Equals(model.GetTypeInfo(arguments.Arguments[0].Expression).Type, rangeType)
            }

            // Only these values can carry positions (see ObliviousPositionsOf).
            private func CanCarryPositions(value ExpressionSyntax) bool -> IsElementLiteral(value) ||
                value is TupleExpressionSyntax ||
                value is ConditionalAccessExpressionSyntax ||
                value is IdentifierNameSyntax ||
                value is DeclarationExpressionSyntax ||
                value is MemberAccessExpressionSyntax ||
                value is ElementAccessExpressionSyntax ||
                value is InvocationExpressionSyntax ||
                value is BaseObjectCreationExpressionSyntax ||
                value is ParenthesizedExpressionSyntax ||
                value is PostfixUnaryExpressionSyntax ||
                value is ConditionalExpressionSyntax ||
                value is BinaryExpressionSyntax ||
                value is SwitchExpressionSyntax ||
                value is AwaitExpressionSyntax

            private func IsGenericTaskLike(type ITypeSymbol?) bool -> type is INamedTypeSymbol task &&
                task.IsGenericType &&
                task
                .TypeArguments
                .Length == 1 &&
                task
                .ContainingNamespace
                ?.ToDisplayString() == "System.Threading.Tasks" && (task.Name is "Task" or "ValueTask")

            // The type arguments of a named type, after those of its containing types.
            private func FlatTypeArguments(type INamedTypeSymbol) List[ITypeSymbol] {
                let arguments = if type.ContainingType != nil {
                    FlatTypeArguments(type.ContainingType)
                } else {
                    List[ITypeSymbol]()
                }
                arguments.AddRange(type.TypeArguments)
                return arguments
            }

            // The types at the positions directly below [`type`](paramref).
            private func PositionArguments(type ITypeSymbol?) List[ITypeSymbol]? -> switch type {
                case array is IArrayTypeSymbol: List[ITypeSymbol]{array.ElementType}
                case named is INamedTypeSymbol: FlatTypeArguments(named)
                default: default(List[ITypeSymbol]?)
            }

            private func MentionsTypeParameter(type ITypeSymbol?) bool {
                if type is ITypeParameterSymbol {
                    return true
                }
                let arguments = PositionArguments(type)
                return arguments != nil && arguments.Any((argument ITypeSymbol) -> MentionsTypeParameter(argument))
            }

            private func JoinPosition(prefix string, position string) string {
                if prefix == "" {
                    return position
                }
                return if position == "" {
                    prefix
                } else {
                    prefix + "." + position
                }
            }

            private func IndexPosition(index int32) string -> index.ToString(
                System.Globalization.CultureInfo.InvariantCulture
            )

            // The dotted position of element [`index`](paramref) in a CLR tuple type,
            // following `Rest` (`7`) for tuples with eight or more elements.
            private func TupleElementPosition(index int32) string {
                if index < 7 {
                    return IndexPosition(index)
                }
                var prefix = ""
                var current = index
                while current >= 7 {
                    prefix = JoinPosition(prefix, "7")
                    current -= 7
                }
                return JoinPosition(prefix, IndexPosition(current))
            }

            // The zero-based element index of a tuple field in its containing tuple type,
            // or -1.
            private func TupleFieldIndex(field IFieldSymbol) int32 {
                let tupleType = field.ContainingType
                if tupleType == nil || !tupleType.IsTupleType {
                    return -1
                }
                let target = field.CorrespondingTupleField ?? field
                let elements = tupleType.TupleElements
                for var i = 0; i < elements.Length; i++ {
                    let element = elements[i].CorrespondingTupleField ?? elements[i]
                    if SymbolEqualityComparer.Default.Equals(element, target) || SymbolEqualityComparer.Default.Equals(
                        element.OriginalDefinition,
                        target.OriginalDefinition
                    ) ||
                        elements[i].Name == field.Name {
                        return i
                    }
                }
                return -1
            }

            // The positions below [`head`](paramref), relative to it.
            private func Subtree(positions ObliviousPositionSet?, head string) ObliviousPositionSet {
                let result = ObliviousPositionSet()
                if positions != nil {
                    SubtreeInto(positions.Nullable, head, result.Nullable)
                    SubtreeInto(positions.Platform, head, result.Platform)
                }
                return result
            }

            private func SubtreeInto(positions HashSet[string], head string, result HashSet[string]) {
                for position in positions {
                    if position == head {
                        result.Add("")
                    } else if position.StartsWith(head + ".", System.StringComparison.Ordinal) {
                        result.Add(position.Substring(head.Length + 1))
                    }
                }
            }

            private func Prefixed(positions ObliviousPositionSet, prefix string) ObliviousPositionSet {
                let result = ObliviousPositionSet()
                for position in positions.Nullable {
                    result.Nullable.Add(JoinPosition(prefix, position))
                }
                for position in positions.Platform {
                    result.Platform.Add(JoinPosition(prefix, position))
                }
                return result
            }

            private func WithoutTopLevel(positions ObliviousPositionSet?) ObliviousPositionSet? {
                if positions == nil {
                    return nil
                }
                let result = ObliviousPositionSet()
                result.UnionWith(positions)
                result.Nullable.Remove("")
                result.Platform.Remove("")
                return if result.IsEmpty {
                    nil
                } else {
                    result
                }
            }

            private func Merge(left ObliviousPositionSet?, right ObliviousPositionSet?) ObliviousPositionSet? {
                if left == nil {
                    return right
                }
                if right == nil {
                    return left
                }
                let result = ObliviousPositionSet()
                result.UnionWith(left)
                result.UnionWith(right)
                return result
            }

            // Keeps the positions that are reference types in [`type`](paramref).
            private func Filtered(type ITypeSymbol?, positions ObliviousPositionSet?) ObliviousPositionSet? {
                if type == nil || positions == nil {
                    return nil
                }
                let result = ObliviousPositionSet()
                for position in positions.Nullable {
                    if IsReferencePosition(type, position) {
                        result.Nullable.Add(position)
                    }
                }
                for position in positions.Platform {
                    if IsReferencePosition(type, position) {
                        result.Platform.Add(position)
                    }
                }
                return if result.IsEmpty {
                    nil
                } else {
                    result
                }
            }

            private func IsReferencePosition(type ITypeSymbol, position string) bool {
                let positionType ITypeSymbol? = if position == "" {
                    type
                } else {
                    PositionType(type, position)
                }
                return positionType != nil && positionType.IsReferenceType
            }

            // Adds to [`bindings`](paramref) the positions that a value of type
            // [`actual`](paramref) gives each type parameter that [`pattern`](paramref)
            // mentions. The value can be a container that implements or derives from
            // the pattern's generic type, such as an array for `IEnumerable[T]`.
            private func Unify(
                pattern ITypeSymbol,
                actual ITypeSymbol?,
                positions ObliviousPositionSet,
                bindings Dictionary[ITypeParameterSymbol, ObliviousPositionSet]
            ) {
                if positions.IsEmpty || actual == nil {
                    return
                }
                if pattern is ITypeParameterSymbol parameter {
                    AddTypeParameterPositions(bindings, parameter, positions)
                    return
                }
                if pattern is IArrayTypeSymbol patternArray {
                    if actual is IArrayTypeSymbol actualArray && patternArray.Rank == actualArray.Rank {
                        Unify(patternArray.ElementType, actualArray.ElementType, Subtree(positions, "0"), bindings)
                    }
                    return
                }
                if pattern is not INamedTypeSymbol patternNamed {
                    return
                }
                let patternArguments = FlatTypeArguments(patternNamed)
                if patternArguments.Count == 0 {
                    return
                }
                let view = ViewPositions(actual, patternNamed.OriginalDefinition, positions)
                if view == nil {
                    return
                }
                for var i = 0; i < patternArguments.Count && i < view.Count; i++ {
                    Unify(patternArguments[i], view[i].Argument, view[i].Positions, bindings)
                }
            }

            // The type arguments of [`actual`](paramref) seen as the generic type
            // [`target`](paramref), which it is, implements or derives from, with the
            // positions of each argument.
            private func ViewPositions(
                actual ITypeSymbol,
                target INamedTypeSymbol,
                positions ObliviousPositionSet
            ) List[(Argument ITypeSymbol, Positions ObliviousPositionSet)]? {
                let result = List[(Argument ITypeSymbol, Positions ObliviousPositionSet)]()
                if actual is IArrayTypeSymbol array {
                    for implemented in array.AllInterfaces {
                        if SymbolEqualityComparer.Default.Equals(implemented.OriginalDefinition, target) {
                            for argument in implemented.TypeArguments {
                                result.Add(
                                    (
                                        argument,
                                        if SymbolEqualityComparer.Default.Equals(argument, array.ElementType) {
                                            Subtree(positions, "0")
                                        } else {
                                            ObliviousPositionSet()
                                        }
                                    )
                                )
                            }
                            return result
                        }
                    }
                    return nil
                }
                if actual is not INamedTypeSymbol named {
                    return nil
                }
                let definition = named.OriginalDefinition
                let parameters = FlatTypeArguments(definition)
                let bindings = TypeParameterMap()
                for var i = 0; i < parameters.Count; i++ {
                    if parameters[i] is ITypeParameterSymbol parameter {
                        bindings[parameter] = Subtree(positions, IndexPosition(i))
                    }
                }
                let definitionViews = ContainerViews(definition)
                let actualViews = ContainerViews(named)
                for var k = 0; k < definitionViews.Count && k < actualViews.Count; k++ {
                    if SymbolEqualityComparer.Default.Equals(definitionViews[k].OriginalDefinition, target) {
                        let definitionArguments = FlatTypeArguments(definitionViews[k])
                        let actualArguments = FlatTypeArguments(actualViews[k])
                        for var j = 0; j < definitionArguments.Count && j < actualArguments.Count; j++ {
                            let argumentPositions = ObliviousPositionSet()
                            Substitute(definitionArguments[j], bindings, "", argumentPositions)
                            result.Add((actualArguments[j], argumentPositions))
                        }
                        return result
                    }
                }
                return nil
            }

            // The type, its base types and its interfaces, in a fixed order.
            private func ContainerViews(type INamedTypeSymbol) List[INamedTypeSymbol] {
                let views = List[INamedTypeSymbol]()
                var current INamedTypeSymbol? = type
                while current != nil {
                    views.Add(current)
                    current = current.BaseType
                }
                views.AddRange(type.AllInterfaces)
                return views
            }

            // Adds the positions of [`type`](paramref) after each type parameter is
            // replaced by its positions in [`bindings`](paramref).
            private func Substitute(
                type ITypeSymbol,
                bindings Dictionary[ITypeParameterSymbol, ObliviousPositionSet],
                prefix string,
                result ObliviousPositionSet
            ) {
                if type is ITypeParameterSymbol parameter {
                    if bindings.TryGetValue(parameter, out var bound) {
                        for position in bound.Nullable {
                            result.Nullable.Add(JoinPosition(prefix, position))
                        }
                        for position in bound.Platform {
                            result.Platform.Add(JoinPosition(prefix, position))
                        }
                    }
                    return
                }
                let arguments = PositionArguments(type)
                if arguments == nil {
                    return
                }
                for var i = 0; i < arguments.Count; i++ {
                    Substitute(arguments[i], bindings, JoinPosition(prefix, IndexPosition(i)), result)
                }
            }

            // The positions of the element that `foreach` reads from a value.
            private func EnumeratedPositions(
                collectionType ITypeSymbol?,
                positions ObliviousPositionSet,
                compilation Compilation
            ) ObliviousPositionSet? {
                if collectionType is IArrayTypeSymbol {
                    return Subtree(positions, "0")
                }
                if collectionType == nil {
                    return nil
                }
                let view = ViewPositions(
                    collectionType,
                    compilation.GetSpecialType(SpecialType.System_Collections_Generic_IEnumerable_T),
                    positions
                )
                return if view != nil && view.Count == 1 {
                    view[0].Positions
                } else {
                    nil
                }
            }

            // The positions on a collection of type [`collectionType`](paramref) that
            // give its enumerated element of type [`elementType`](paramref) the
            // [`elementPositions`](paramref).
            private func CollectionPositionsForElement(
                collectionType ITypeSymbol?,
                elementType ITypeSymbol?,
                elementPositions HashSet[string],
                compilation Compilation
            ) HashSet[string]? {
                if collectionType == nil || elementType == nil || elementPositions.Count == 0 {
                    return nil
                }
                if collectionType is IArrayTypeSymbol {
                    let result = HashSet[string](System.StringComparer.Ordinal)
                    for position in elementPositions {
                        result.Add(JoinPosition("0", position))
                    }
                    return result
                }
                if collectionType is not INamedTypeSymbol named {
                    return nil
                }
                let enumerableType = compilation.GetSpecialType(SpecialType.System_Collections_Generic_IEnumerable_T)
                let definition = named.OriginalDefinition
                for view in ContainerViews(definition) {
                    if SymbolEqualityComparer.Default.Equals(view.OriginalDefinition, enumerableType) &&
                        view
                        .TypeArguments
                        .Length == 1 {
                        let carried = ObliviousPositionSet()
                        carried.Nullable.UnionWith(elementPositions)
                        let bindings = TypeParameterMap()
                        Unify(view.TypeArguments[0], elementType, carried, bindings)
                        let result = ObliviousPositionSet()
                        Substitute(definition, bindings, "", result)
                        return if result.Nullable.Count == 0 {
                            nil
                        } else {
                            result.Nullable
                        }
                    }
                }
                return nil
            }

            // The positions of a value of type [`valueType`](paramref) in storage of
            // type [`storageType`](paramref): the same container, or a generic type that
            // the container implements or derives from, such as `IEnumerable[T]` for
            // `[]T` or `List[T]`.
            private func MapToStorageType(
                valueType ITypeSymbol?,
                storageType ITypeSymbol?,
                positions ObliviousPositionSet
            ) ObliviousPositionSet? {
                if valueType == nil || storageType == nil {
                    return nil
                }
                if SameContainerShape(valueType, storageType) {
                    return positions
                }
                if storageType is not INamedTypeSymbol named || FlatTypeArguments(named).Count == 0 {
                    return nil
                }
                let view = ViewPositions(valueType, named.OriginalDefinition, positions)
                if view == nil {
                    return nil
                }
                let result = ObliviousPositionSet()
                for var i = 0; i < view.Count; i++ {
                    result.UnionWith(Prefixed(view[i].Positions, IndexPosition(i)))
                }
                return result
            }

            // Declared storage spells each nested position that the value leaves
            // nullable or platform and that the storage states as a non-null reference.
            private func AddDeclaredPositions(
                flow ObliviousContainerFlow,
                destination ISymbol,
                destinationType ITypeSymbol?,
                positions ObliviousPositionSet?
            ) bool {
                if positions == nil || destinationType == nil {
                    return false
                }
                let declared = HashSet[string](System.StringComparer.Ordinal)
                for position in positions.Nullable.Concat(positions.Platform) {
                    if position != "" &&
                        IsPromotablePosition(destinationType, position) &&
                        MetadataGroupMembersAdmitPosition(flow, destination, position) {
                        declared.Add(position)
                    }
                }
                return declared.Count > 0 && AddPositions(flow.Destinations, destination, declared)
            }

            // A metadata declaration in an override or interface-implementation group
            // admits promoting a nested position only when that metadata declaration does
            // not explicitly annotate the position as non-null (`NotAnnotated`).
            private func MetadataGroupMembersAdmitPosition(
                flow ObliviousContainerFlow,
                destination ISymbol,
                position string
            ) bool {
                let owner ISymbol? = if destination is IParameterSymbol parameter {
                    parameter.ContainingSymbol
                } else {
                    destination
                }
                if !(owner is IMethodSymbol || owner is IPropertySymbol) || flow.Groups == nil {
                    return true
                }
                let root = flow.Groups!!.Find(owner!!)
                let ordinal = if destination is IParameterSymbol ordered {
                    ordered.Ordinal
                } else {
                    -1
                }
                for member in flow.Groups!!.Members(root) {
                    if !member.DeclaringSyntaxReferences.IsDefaultOrEmpty {
                        continue
                    }
                    let memberStorage ISymbol? = GroupStorage(member, ordinal)
                    if memberStorage == nil {
                        return false
                    }
                    let memberPositionType = PositionType(StorageType(memberStorage), position)
                    if memberPositionType == nil ||
                        memberPositionType.NullableAnnotation == Microsoft
                        .CodeAnalysis
                        .NullableAnnotation
                        .NotAnnotated {
                        return false
                    }
                }
                return true
            }

            private func AddInferredPositions(
                flow ObliviousContainerFlow,
                destination ISymbol,
                positions ObliviousPositionSet?
            ) bool {
                if positions == nil {
                    return false
                }
                if !flow.Inferred.TryGetValue(destination, out var existing) {
                    existing = ObliviousPositionSet()
                    flow.Inferred.Add(destination, existing)
                }
                let count = existing.Nullable.Count + existing.Platform.Count
                existing.UnionWith(positions)
                return existing.Nullable.Count + existing.Platform.Count > count
            }

            // The positions of the member result, parameter or indexer of a container with
            // these positions, typed by one of the container's type parameters. A nil
            // member is the element of an array.
            private func MemberPositions(
                positions ObliviousPositionSet,
                containerType ITypeSymbol?,
                member ISymbol?
            ) ObliviousPositionSet? {
                if containerType is IArrayTypeSymbol {
                    return if member == nil {
                        Subtree(positions, "0")
                    } else {
                        default(ObliviousPositionSet?)
                    }
                }
                let memberType ITypeSymbol? = if member != nil {
                    StorageType(UnreducedDefinition(member))
                } else {
                    nil
                }
                let owner INamedTypeSymbol? = if member is IParameterSymbol parameter {
                    parameter.ContainingSymbol.ContainingType
                } else {
                    member?.ContainingType
                }
                if memberType == nil || owner == nil || containerType == nil {
                    return nil
                }
                let bindings = TypeParameterMap()
                Unify(owner.OriginalDefinition, containerType, positions, bindings)
                let result = ObliviousPositionSet()
                Substitute(memberType, bindings, "", result)
                return result
            }

            // Whether the member result, parameter or indexer of a container with these
            // positions, typed by one of the container's type parameters, is nullable. A
            // nil member is the element of an array.
            private func MemberPositionIsNullable(
                positions ObliviousPositionSet,
                containerType ITypeSymbol?,
                member ISymbol?
            ) bool -> MemberPositions(positions, containerType, member)?.Nullable.Contains("") == true

            // Source storage that can carry oblivious container positions to another
            // destination.
            private func IsObliviousContainerStorageCandidate(symbol ISymbol, compilation Compilation) bool {
                if symbol.DeclaringSyntaxReferences.IsDefaultOrEmpty || !SymbolEqualityComparer.Default.Equals(
                    symbol.ContainingAssembly,
                    compilation.Assembly
                ) {
                    return false
                }
                if !(
                    symbol is ILocalSymbol ||
                        symbol is IFieldSymbol ||
                        symbol is IPropertySymbol ||
                        symbol is IParameterSymbol ||
                        symbol is IMethodSymbol
                ) {
                    return false
                }
                var signatureOwner ISymbol = symbol
                if symbol is IParameterSymbol parameter {
                    if parameter.ContainingSymbol == nil {
                        return false
                    }
                    signatureOwner = parameter.ContainingSymbol!!
                    // A lambda parameter takes its type from its delegate.
                    if signatureOwner is IMethodSymbol owner && owner.MethodKind == MethodKind.AnonymousFunction {
                        return false
                    }
                }
                return HasNonNullNestedReferencePosition(StorageType(symbol))
            }

            // Whether the translation can spell the nested [`position`](paramref) of
            // [`type`](paramref) nullable: a non-null reference whose slot is not a type
            // argument of a type parameter that a `T?` argument violates.
            private func IsPromotablePosition(type ITypeSymbol, position string, includeOblivious bool = false) bool {
                if PositionType(type, position) is not{} positionType ||
                    !IsNonNullReferencePosition(positionType, includeOblivious) {
                    return false
                }
                let separator = position.LastIndexOf('.')
                let owner ITypeSymbol? = if separator < 0 {
                    type
                } else {
                    PositionType(type, position.Substring(0, separator))
                }
                if owner is not INamedTypeSymbol named {
                    return true
                }
                let index = int32.Parse(
                    position.Substring(separator + 1),
                    System.Globalization.CultureInfo.InvariantCulture
                )
                let parameters = FlatTypeArguments(named.OriginalDefinition)
                return !(
                    index < parameters.Count &&
                        parameters[index] is ITypeParameterSymbol parameter &&
                        NullableTypeArgumentViolatesTranslatedConstraints(parameter)
                )
            }

            // The type at a dotted position below the top level of [`type`](paramref).
            private func PositionType(type ITypeSymbol?, position string) ITypeSymbol? {
                var current ITypeSymbol? = type
                for part in position.Split('.') {
                    let index = int32.Parse(part, System.Globalization.CultureInfo.InvariantCulture)
                    let arguments = PositionArguments(current)
                    current = if arguments != nil && index < arguments.Count {
                        arguments[index]
                    } else {
                        nil
                    }
                    if current == nil {
                        return nil
                    }
                }
                return current
            }

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

            // Records each nested position that gsc reads as `T!` in the declared type of
            // a frozen oblivious member (ADR-0186 §2). An oblivious reference position is
            // platform. So is a type-parameter argument of a constructed type. An array
            // element that is a type parameter takes the type argument of the call, so
            // `Array.Empty[T]()` reads as `[]T`. A stated position keeps its own contract.
            // A type parameter's own positions come from the call (ObliviousPositionsOf).
            private func CollectPlatformPositions(declared ITypeSymbol?, prefix string, positions HashSet[string]) {
                let arguments = PositionArguments(declared)
                if arguments == nil {
                    return
                }
                for var i = 0; i < arguments.Count; i++ {
                    let position = JoinPosition(prefix, IndexPosition(i))
                    if IsPlatformPosition(arguments[i], inArrayElement: declared is IArrayTypeSymbol) {
                        positions.Add(position)
                    }
                    CollectPlatformPositions(arguments[i], position, positions)
                }
            }

            private func IsPlatformPosition(type ITypeSymbol, inArrayElement bool) bool {
                if type is ITypeParameterSymbol {
                    return !inArrayElement
                }
                return type.IsReferenceType && type.NullableAnnotation == Microsoft.CodeAnalysis.NullableAnnotation.None
            }

            private func CollectAnnotatedPositions(declared ITypeSymbol?, prefix string, positions HashSet[string]) {
                let arguments = PositionArguments(declared)
                if arguments == nil {
                    return
                }
                for var i = 0; i < arguments.Count; i++ {
                    let position = JoinPosition(prefix, IndexPosition(i))
                    if arguments[i].IsReferenceType &&
                        arguments[i].NullableAnnotation == Microsoft
                        .CodeAnalysis
                        .NullableAnnotation
                        .Annotated {
                        positions.Add(position)
                    }
                    CollectAnnotatedPositions(arguments[i], position, positions)
                }
            }

            // A return or expression body stores its value in the enclosing method
            // or property. A lambda has no declaration that cs2gs can widen. An `async`
            // method stores it in its task's result.
            private func ReturnDestination(enclosing ISymbol?) ISymbol? {
                if enclosing is not IMethodSymbol method ||
                    method.ReturnsByRef ||
                    (method.IsAsync && !IsGenericTaskLike(method.ReturnType)) {
                    return nil
                }
                if method.MethodKind == MethodKind.PropertyGet {
                    return AccessorStorage(method)
                }
                return if method.MethodKind == MethodKind.Ordinary || method.MethodKind == MethodKind.LocalFunction {
                    method
                } else {
                    nil
                }
            }

            // The storage that a property or indexer accessor reads and writes: its
            // property. The analysis records positions there, so every lookup of a
            // sink that is an accessor goes through this.
            private func AccessorStorage(symbol ISymbol?) ISymbol? -> if symbol is IMethodSymbol accessor &&
                (accessor.MethodKind == MethodKind.PropertyGet || accessor.MethodKind == MethodKind.PropertySet) &&
                accessor.AssociatedSymbol is IPropertySymbol property {
                property
            } else {
                symbol
            }

            private func ReturnPrefix(enclosing ISymbol?) string -> if enclosing is IMethodSymbol method &&
                method.IsAsync {
                "0"
            } else {
                ""
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

            private func StorageType(symbol ISymbol?) ITypeSymbol? -> switch symbol {
                case local is ILocalSymbol: local.Type
                case field is IFieldSymbol: field.Type
                case property is IPropertySymbol: property.Type
                case parameter is IParameterSymbol: parameter.Type
                case method is IMethodSymbol: method.ReturnType
                default: default(ITypeSymbol?)
            }

            // The value and the storage have the same container: arrays of one rank, or
            // constructions of one generic definition.
            private func SameContainerShape(source ITypeSymbol?, storage ITypeSymbol?) bool {
                if source is IArrayTypeSymbol sourceArray {
                    return storage is IArrayTypeSymbol storageArray &&
                        sourceArray.Rank == storageArray.Rank &&
                        (
                        !(
                            sourceArray.ElementType is IArrayTypeSymbol || storageArray.ElementType is IArrayTypeSymbol
                        ) ||
                            SameContainerShape(sourceArray.ElementType, storageArray.ElementType)
                    )
                }
                return source is INamedTypeSymbol sourceNamed &&
                    storage is INamedTypeSymbol storageNamed &&
                    FlatTypeArguments(sourceNamed).Count > 0 && SymbolEqualityComparer.Default.Equals(
                    (sourceNamed.TupleUnderlyingType ?? sourceNamed).OriginalDefinition,
                    (storageNamed.TupleUnderlyingType ?? storageNamed).OriginalDefinition
                )
            }

            private func HasNonNullNestedReferencePosition(type ITypeSymbol?) bool {
                let arguments = PositionArguments(type)
                return arguments != nil && arguments.Any(
                    (argument ITypeSymbol) -> IsNonNullReferencePosition(argument) ||
                        HasNonNullNestedReferencePosition(argument)
                )
            }

            private func IsNonNullReferencePosition(
                type ITypeSymbol,
                includeOblivious bool = false
            ) bool -> type.IsReferenceType &&
                type is not ITypeParameterSymbol &&
                (
                type.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .NotAnnotated ||
                    (includeOblivious && type.NullableAnnotation == Microsoft.CodeAnalysis.NullableAnnotation.None)
            )

            // Makes each recorded nested position nullable. The top level keeps its
            // nullability.
            private func PromoteNestedPositions(
                type GTypeReference?,
                declared ITypeSymbol?,
                positions HashSet[string],
                prefix string
            ) GTypeReference? {
                // A tuple states each element's positions below the element's index.
                if type is TupleTypeReference tupleReference &&
                    declared is INamedTypeSymbol{IsTupleType: true} tupleSymbol &&
                    tupleReference
                    .ElementTypes
                    .Count == tupleSymbol
                    .TupleElements
                    .Length {
                    let elementTypes = List[GTypeReference](tupleReference.ElementTypes.Count)
                    var tupleChanged = false
                    for var i = 0; i < tupleReference.ElementTypes.Count; i++ {
                        let elementType = PromoteNestedPosition(
                            tupleReference.ElementTypes[i],
                            tupleSymbol.TupleElements[i].Type,
                            positions,
                            prefix + TupleElementPosition(i)
                        )
                        tupleChanged |= !object.ReferenceEquals(elementType, tupleReference.ElementTypes[i])
                        elementTypes.Add(elementType)
                    }
                    return if tupleChanged {
                        cast[GTypeReference](
                            TupleTypeReference(elementTypes, tupleReference.ElementNames){
                                IsNullable = tupleReference.IsNullable
                            }
                        )
                    } else {
                        type
                    }
                }
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
                    .Count == namedSymbol
                    .TypeArguments
                    .Length &&
                    (named.TypeArguments.Count > 0 || named.ContainingType != nil) {
                    let containingType = if named.ContainingType != nil && namedSymbol.ContainingType != nil {
                        PromoteNestedPositions(named.ContainingType, namedSymbol.ContainingType, positions, prefix)
                    } else {
                        named.ContainingType
                    }
                    let offset = FlatTypeArguments(namedSymbol).Count - namedSymbol.TypeArguments.Length
                    let arguments = List[GTypeReference](named.TypeArguments.Count)
                    var changed = !object.ReferenceEquals(containingType, named.ContainingType)
                    for var i = 0; i < named.TypeArguments.Count; i++ {
                        let argument = PromoteNestedPosition(
                            named.TypeArguments[i],
                            namedSymbol.TypeArguments[i],
                            positions,
                            prefix + IndexPosition(offset + i)
                        )
                        changed |= !object.ReferenceEquals(argument, named.TypeArguments[i])
                        arguments.Add(argument)
                    }
                    return if changed {
                        cast[GTypeReference](
                            NamedTypeReference(named.Name, arguments, containingType){IsNullable = named.IsNullable}
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
