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

    shared {
        // Whether a member can override, be overridden by, or implement another.
        func MayShareSignature(member ISymbol) bool -> member.IsVirtual ||
            member.IsAbstract ||
            member.IsOverride ||
            member
            .ContainingType
            ?.TypeKind == TypeKind.Interface ||
            ImplementsInterfaceMember(member)

        // Whether a member implements an interface member.
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
    }
}

/// Issue #5541: the result of the nested-position flow analysis for one compilation.
internal class ObliviousContainerFlow {
    private var hasNullable bool = false
    private let sharesSignature Dictionary[ISymbol, bool] = Dictionary[ISymbol, bool](SymbolEqualityComparer.Default)

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

    // Whether a member can share its signature with another, computed once.
    func SharesSignature(member ISymbol) bool {
        let definition = member.OriginalDefinition
        if !this.sharesSignature.TryGetValue(definition, out var shares) {
            shares = ObliviousSignatureGroups.MayShareSignature(definition)
            this.sharesSignature.Add(definition, shares)
        }
        return shares
    }

    func Seal() {
        this.hasNullable = this
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
            let promoted = PromoteNestedPositions(type, StorageType(symbol!!.OriginalDefinition), positions, "")
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
            let positions = HashSet[string](System.StringComparer.Ordinal)
            let sink ISymbol? = this.ResolveValueSink(creation)
            let sinkPositions = this.ObliviousContainerPositions(sink)
            if sinkPositions != nil && SameContainerShape(createdType, StorageType(sink!!.OriginalDefinition)) {
                positions.UnionWith(sinkPositions)
            }
            if creation is BaseObjectCreationExpressionSyntax objectCreation {
                let inferred = this.ObliviousCreationPositions(
                    objectCreation,
                    this.context.SemanticModel,
                    this.ObliviousContainerFlowState()
                )
                if inferred != nil {
                    positions.UnionWith(inferred.Nullable)
                }
            }
            return if positions.Count == 0 {
                type
            } else {
                PromoteNestedPositions(type, createdType, positions, "")
            }
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
                if position != "" &&
                    PositionType(typeArgument, position) is {} positionType &&
                    IsNonNullReferencePosition(positionType) {
                    nested.Add(position)
                }
            }
            let promoted = PromoteNestedPositions(type, typeArgument, nested, "")
            return if bound.Nullable.Contains("") &&
                IsNonNullReferencePosition(typeArgument) &&
                !promoted!!.IsNullable {
                MakeNullable(promoted)
            } else {
                promoted
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
        private func ObliviousContainerSinkPromotesArrayElement(creation ExpressionSyntax?) bool {
            let sink ISymbol? = this.ResolveValueSink(creation)
            return StorageType(sink?.OriginalDefinition) is IArrayTypeSymbol && this.ObliviousContainerPositions(sink)
                ?.Contains("0") == true
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
                    expression is InvocationExpressionSyntax
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
        private func WritesObliviousContainerStorageElement(value ExpressionSyntax?) bool {
            if value == nil || !this.ObliviousContainerFlowState().HasNullable {
                return false
            }
            let written ExpressionSyntax = this.WrittenWholeValue(value)
            let parent SyntaxNode? = written.Parent
            // `items.Add(value)`, `items.Insert(0, value)`, `map.Add(key, value)` and an
            // index argument such as `lookup[value]`.
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
                return receiver != nil && this.ElementPositionIsPromoted(receiver, parameter)
            }
            if parent is AssignmentExpressionSyntax assignment && assignment.IsKind(
                SyntaxKind.SimpleAssignmentExpression
            ) &&
                assignment.Right == written {
                // `items[0] = value`, `lines[0] = value`, `map[key] = value`.
                if assignment.Left is ElementAccessExpressionSyntax access {
                    return this.ElementPositionIsPromoted(access.Expression, this.context.GetSymbolInfo(access).Symbol)
                }
                // `box.Value = value`.
                if assignment.Left is MemberAccessExpressionSyntax memberAccess {
                    return this.ElementPositionIsPromoted(
                        memberAccess.Expression,
                        this.context.GetSymbolInfo(memberAccess).Symbol
                    )
                }
            }
            // `new List<T> { value }`, `new Dictionary<K, V> { { key, value } }`,
            // `new Dictionary<K, V> { [key] = value }` and `new Box<T> { Value = value }`.
            var element SyntaxNode = written
            var index = 0
            var member ISymbol? = nil
            if parent is AssignmentExpressionSyntax initializerAssignment &&
                initializerAssignment.Right == written &&
                (
                initializerAssignment.Left is ImplicitElementAccessSyntax ||
                    initializerAssignment.Left is IdentifierNameSyntax
            ) {
                member = this.context.GetSymbolInfo(initializerAssignment.Left).Symbol
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
            let createdType ITypeSymbol? = this.context.GetTypeInfo(creation).Type
            let positions = ObliviousPositionSet()
            let sink ISymbol? = this.ResolveValueSink(creation)
            let sinkPositions = this.ObliviousContainerPositions(sink)
            if sinkPositions != nil && SameContainerShape(createdType, StorageType(sink?.OriginalDefinition)) {
                positions.Nullable.UnionWith(sinkPositions)
            }
            positions.UnionWith(
                this.ObliviousCreationPositions(
                    creation,
                    this.context.SemanticModel,
                    this.ObliviousContainerFlowState()
                )
            )
            return MemberPositionIsNullable(positions, createdType, member)
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
                return if IsGenericTaskLike(model.GetTypeInfo(awaitExpression.Expression).Type) {
                    Filtered(
                        model.GetTypeInfo(value).Type,
                        Subtree(this.ObliviousPositionsOf(awaitExpression.Expression, model, flow), "0")
                    )
                } else {
                    nil
                }
            }
            if !(
                value is IdentifierNameSyntax ||
                    value is MemberAccessExpressionSyntax ||
                    value is ElementAccessExpressionSyntax ||
                    value is InvocationExpressionSyntax ||
                    value is BaseObjectCreationExpressionSyntax
            ) {
                return nil
            }
            let symbol ISymbol? = model.GetSymbolInfo(value!!).Symbol
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
            }
            if value is ElementAccessExpressionSyntax elementAccess && model.GetTypeInfo(elementAccess.Expression)
                .Type is IArrayTypeSymbol {
                positions.UnionWith(Subtree(this.ObliviousPositionsOf(elementAccess.Expression, model, flow), "0"))
            } else if value is BaseObjectCreationExpressionSyntax creation {
                positions.UnionWith(this.ObliviousCreationPositions(creation, model, flow))
            } else if (symbol is IFieldSymbol || symbol is IPropertySymbol || symbol is IMethodSymbol) &&
                StorageType(UnreducedDefinition(symbol!!)) is {} memberType &&
                MentionsTypeParameter(memberType) {
                let bindings = this.ObliviousMemberTypeArguments(value!!, symbol!!, model, flow)
                Substitute(memberType, bindings, "", positions)
            }
            return Filtered(model.GetTypeInfo(value!!).Type, positions)
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
            let receiver ExpressionSyntax? = switch value {
                case elementAccess is ElementAccessExpressionSyntax: elementAccess.Expression
                case memberAccess is MemberAccessExpressionSyntax: memberAccess.Expression
                case invocation is InvocationExpressionSyntax: (
                    if invocation.Expression is MemberAccessExpressionSyntax target {
                        target.Expression
                    } else {
                        default(ExpressionSyntax?)
                    }
                )
                default: default(ExpressionSyntax?)
            }
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
                operation
                .Arguments
                .Length == 0 {
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
                bindings
            )
            if bindings.Count == 0 {
                return nil
            }
            let substituted = ObliviousPositionSet()
            Substitute(definition, bindings, "", substituted)
            let result = ObliviousPositionSet()
            for position in substituted.Nullable {
                if PositionType(created, position) is {} positionType && IsNonNullReferencePosition(positionType) {
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
            bindings Dictionary[ITypeParameterSymbol, ObliviousPositionSet]
        ) {
            let found = TypeParameterMap()
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
                                this.ObliviousPositionsOf(elementValue, model, flow)
                            } else {
                                nil
                            }
                            if elementPositions != nil {
                                Unify(
                                    arrayParameter.ElementType,
                                    model.GetTypeInfo(elementValue!!).Type,
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
                let argumentPositions = this.ObliviousPositionsOf(argumentValue, model, flow)
                if argumentPositions != nil {
                    Unify(parameterType, model.GetTypeInfo(argumentValue!!).Type, argumentPositions, found)
                }
            }
            for (parameter, lambda) in lambdas {
                let invoke IMethodSymbol? = (
                    parameter.OriginalDefinition.Type as INamedTypeSymbol
                )?.DelegateInvokeMethod
                if invoke == nil || invoke.ReturnsVoid || lambda.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword) {
                    continue
                }
                for result in LambdaResults(lambda) {
                    let resultPositions = this.ObliviousPositionsOf(result, model, flow)
                    if resultPositions != nil {
                        Unify(invoke.ReturnType, model.GetTypeInfo(result).Type, resultPositions, found)
                    }
                }
            }
            for parameter in inferred {
                if found.TryGetValue(parameter, out var positions) {
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
            // enumerates a value into a `foreach` variable, and 3 types the lambda
            // parameters of a call.
            let edges = List[
                (Destination ISymbol?, Value ExpressionSyntax, Model SemanticModel, Prefix string, Kind int32)
            ]()
            for tree in compilation.SyntaxTrees {
                let model = compilation.GetSemanticModel(tree)
                for node in tree.GetRoot().DescendantNodes() {
                    if node is AssignmentExpressionSyntax assignment {
                        if assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) {
                            let destination ISymbol? = model.GetSymbolInfo(assignment.Left).Symbol
                            if destination is ILocalSymbol {
                                assignedLocals.Add(destination)
                            }
                            edges.Add((destination, assignment.Right, model, "", 0))
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
                        if argument.RefKindKeyword.IsKind(SyntaxKind.None) {
                            let (parameter, prefix) = ArgumentDestination(argument, model)
                            if parameter != nil {
                                edges.Add((parameter, argument.Expression, model, prefix, 0))
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
                        IsObliviousContainerStorageCandidate(edge.Destination!!.OriginalDefinition, compilation)
                } else if edge.Kind == 3 {
                    true
                } else {
                    edge.Destination is ILocalSymbol
                }
                if keep && CanCarryPositions(edge.Value) {
                    live.Add(edge)
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
                    let positions = this.ObliviousPositionsOf(value, model, flow)
                    if positions == nil && (kind != 0 || flow.Destinations.Count == 0) {
                        continue
                    }
                    var original = destination!!.OriginalDefinition
                    let destinationType ITypeSymbol? = StorageType(original)
                    if kind == 0 {
                        let key ISymbol? = SignatureKey(flow, original, compilation)
                        if key == nil {
                            continue
                        }
                        original = key
                        // A value stored below the top level (an expanded `params`
                        // element, an `async` result) keeps its own nullability there.
                        if positions != nil {
                            let mapped = if prefix == "" {
                                MapToStorageType(model.GetTypeInfo(value).Type, destinationType, positions)
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
                        }
                    } else if positions == nil {
                        continue
                    } else {
                        // A local whose C# type is not annotated gets a `!!` on its
                        // initializer (TranslateValueWithNullForgiveness), so only its
                        // nested positions follow the value.
                        let stored = if kind == 2 {
                            EnumeratedPositions(model.GetTypeInfo(value).Type, positions, compilation)
                        } else if destinationType?.NullableAnnotation == Microsoft
                            .CodeAnalysis
                            .NullableAnnotation
                            .Annotated {
                            positions
                        } else {
                            WithoutTopLevel(positions)
                        }
                        changed |= AddInferredPositions(flow, original, Filtered(destinationType, stored))
                        // Arms that give different positions have no common G# type,
                        // so the local states the merged type and each arm converts to it.
                        if kind == 1 && this.MergedArmsDiffer(value, model, flow) {
                            changed |= AddDeclaredPositions(
                                flow,
                                original,
                                destinationType,
                                MapToStorageType(model.GetTypeInfo(value).Type, destinationType, positions)
                            )
                        }
                    }
                }
            }
            flow.Memo = nil
            flow.Seal()
            return flow
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
            if !(
                read is IdentifierNameSyntax ||
                    read is MemberAccessExpressionSyntax ||
                    read is InvocationExpressionSyntax
            ) {
                return false
            }
            let symbol ISymbol? = model.GetSymbolInfo(read!!).Symbol
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
                this.InferObliviousTypeArguments(
                    call,
                    FlatTypeArguments(created.OriginalDefinition).OfType[ITypeParameterSymbol]().ToList(),
                    arguments,
                    true,
                    model,
                    flow,
                    bindings
                )
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
                        let positionType ITypeSymbol? = if position == "" {
                            lambdaParameter.Type
                        } else {
                            PositionType(lambdaParameter.Type, position)
                        }
                        if positionType != nil && IsNonNullReferencePosition(positionType) {
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
                let key ISymbol? = SignatureKey(flow, UnreducedDefinition(symbol), nil)
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
                let owner ISymbol? = if symbol is IParameterSymbol parameter {
                    parameter.ContainingSymbol
                } else {
                    symbol
                }
                // Without groups no member that shares a signature holds positions.
                if !(owner is IMethodSymbol || owner is IPropertySymbol) ||
                    (flow.Groups == nil && compilation == nil) ||
                    !flow.SharesSignature(owner!!) {
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
                for member in groups.Members(root) {
                    let memberStorage ISymbol? = GroupStorage(member, ordinal)
                    if memberStorage == nil ||
                        memberStorage
                        .DeclaringSyntaxReferences
                        .IsDefaultOrEmpty ||
                        (
                        compilation != nil && !SymbolEqualityComparer.Default.Equals(
                            memberStorage.ContainingAssembly,
                            compilation.Assembly
                        )
                    ) ||
                        !SymbolEqualityComparer
                        .Default
                        .Equals(StorageType(memberStorage), type) {
                        return nil
                    }
                }
                return GroupStorage(root, ordinal)
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

            // The definition of a member. An extension method called on its receiver
            // is its unreduced definition.
            private func UnreducedDefinition(symbol ISymbol) ISymbol -> if symbol is IMethodSymbol method {
                method.ReducedFrom?.OriginalDefinition ?? method.OriginalDefinition
            } else {
                symbol.OriginalDefinition
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

            // Only these values can carry positions (see ObliviousPositionsOf).
            private func CanCarryPositions(value ExpressionSyntax) bool -> value is IdentifierNameSyntax ||
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
                        PositionType(destinationType, position) is {} positionType &&
                        IsNonNullReferencePosition(positionType) {
                        declared.Add(position)
                    }
                }
                return declared.Count > 0 && AddPositions(flow.Destinations, destination, declared)
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

            // Whether the member result, parameter or indexer of a container with these
            // positions, typed by one of the container's type parameters, is nullable. A
            // nil member is the element of an array.
            private func MemberPositionIsNullable(
                positions ObliviousPositionSet,
                containerType ITypeSymbol?,
                member ISymbol?
            ) bool {
                if containerType is IArrayTypeSymbol {
                    return member == nil && positions.Nullable.Contains("0")
                }
                let memberType ITypeSymbol? = StorageType(member?.OriginalDefinition)
                let owner INamedTypeSymbol? = if member is IParameterSymbol parameter {
                    parameter.ContainingSymbol.ContainingType
                } else {
                    member?.ContainingType
                }
                if memberType == nil || owner == nil || containerType == nil {
                    return false
                }
                let bindings = TypeParameterMap()
                Unify(owner.OriginalDefinition, containerType, positions, bindings)
                let result = ObliviousPositionSet()
                Substitute(memberType, bindings, "", result)
                return result.Nullable.Contains("")
            }

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
                    if parameter.RefKind != RefKind.None || parameter.ContainingSymbol == nil {
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
                    return method.AssociatedSymbol
                }
                return if method.MethodKind == MethodKind.Ordinary || method.MethodKind == MethodKind.LocalFunction {
                    method
                } else {
                    nil
                }
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
                let arguments = PositionArguments(type)
                return arguments != nil && arguments.Any(
                    (argument ITypeSymbol) -> IsNonNullReferencePosition(argument) ||
                        HasNonNullNestedReferencePosition(argument)
                )
            }

            private func IsNonNullReferencePosition(type ITypeSymbol) bool -> type.IsReferenceType &&
                type is not ITypeParameterSymbol &&
                type.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .NotAnnotated

            // Makes each recorded nested position nullable. The top level keeps its
            // nullability. The type arguments of a containing type are not spelled.
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
                    let offset = FlatTypeArguments(namedSymbol).Count - namedSymbol.TypeArguments.Length
                    let arguments = List[GTypeReference](named.TypeArguments.Count)
                    var changed = false
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
